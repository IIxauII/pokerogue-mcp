// Enemy AI prediction (hud/20-enemy-ai.js) against mocked game objects: move distribution for each AI type,
// KO filter, Encore, move queue, Struggle, target weighting, Protect branches, doubles switch sequencing, and that
// nothing touches the RNG or runs outside the command phase.
import assert from "node:assert/strict";
import { bundle } from "../hud-bundle.mjs";

// The HUD bundle cut after 20-enemy-ai.js, exposing its functions instead of starting the panel.
const src = (() => {
  const full = bundle("hud");
  const from = full.indexOf("// ---- 20-enemy-ai.js");
  const at = from + 1 + full.slice(from + 1).search(/\n\/\/ ---- [\w-]+\.js\n/);
  return `${full.slice(0, at)}\nglobalThis.__ai = { enemyMoveDistribution, enemyAction, predictSwitches, aiChain, predictedTeras, withPredictedTera, teraTypeOf, sandboxBreaches: () => sandboxBreaches };\n})();\n`;
})();

const calls = { game: 0 };
const spy = (name, fn) => (...a) => { calls.game++; calls[name] = (calls[name] ?? 0) + 1; return fn(...a); };

// moves: { id, name, type, category, moveTarget, user, target (number or battlerIndex => number), attrs, cond, dmg, usable }
const mkMove = m => {
  const mv = {
    id: m.id, name: m.name, type: m.type ?? 0, category: m.category ?? 0, moveTarget: m.moveTarget ?? 3, power: m.power ?? 80,
    attrs: [], hasAttr: n => (m.attrs ?? []).includes(n), getAttrs: () => [], is: n => n === "AttackMove" && (m.category ?? 0) !== 2,
    getUserBenefitScore: spy("getUserBenefitScore", () => m.user ?? 0),
    getTargetBenefitScore: spy("getTargetBenefitScore", (u, t) => (typeof m.target === "function" ? m.target(t.getBattlerIndex()) : m.target ?? 0)),
    applyConditions: spy("applyConditions", (u, t) => (m.cond ? m.cond(scene) : true)),
  };
  return {
    moveId: m.id, getMove: () => mv, getName: () => m.name, getMovePp: () => 10, ppUsed: 0,
    isUsable: spy("isUsable", () => [m.usable ?? true, ""]),
  };
};

let scene;
const mkMon = ({ id, player, fieldIndex, hp = 100, types = [], moves = [], aiType = 2, queue = [], tags = {}, revealed = false, eff = {}, dmg = {} }) => {
  const p = {
    id, name: id, hp, level: 50, aiType, trainerSlot: 1, species: { legendary: false }, status: null,
    isPlayer: () => player, getBattlerIndex: () => (player ? fieldIndex : fieldIndex + 2), getFieldIndex: () => fieldIndex,
    isActive: () => true, isOnField: () => fieldIndex != null, isBoss: () => false,
    waveData: { abilityRevealed: revealed, abilitiesApplied: new Set() }, summonData: { abilitiesApplied: new Set(), moveQueue: queue, statStages: [0, 0, 0, 0, 0, 0, 0] },
    turnData: { hitCount: 0, hitsLeft: -1, moveEffectiveness: null },
    getMoveQueue: () => queue, getTag: t => tags[t], isOfType: t => types.includes(t), getTypes: () => types,
    getAbility: () => ({ id: 0, name: "x" }), hasPassive: () => false, getStat: () => 100, getMaxHp: () => 100,
    getIconAtlasKey: () => "k", getIconId: () => 1,
    getMoveType: mv => mv.type, isTrapped: () => false,
    getMoveEffectiveness: spy("getMoveEffectiveness", (src, mv) => eff[mv.id] ?? 1),
    getAttackDamage: spy("getAttackDamage", o => { p.lastDamageCall = o; return { damage: (dmg[o.source.id] ?? {})[o.move.id] ?? 0, cancelled: false, result: 1 }; }),
    getMatchupScore: spy("getMatchupScore", () => p.matchup ?? 1),
  };
  p.moveset = moves.map(mkMove);
  p.getMoveset = () => p.moveset;
  return p;
};

// Fresh HUD module state and a scene per case.
const setup = ({ player, enemy, double = false, phase = "CommandPhase", trainer = null, counter = 0, battle = {} }) => {
  const field = [player[0], double ? player[1] : undefined, enemy[0], double ? enemy[1] : undefined];
  const sideOf = p => (p.isPlayer() ? player : enemy);
  for (const p of [...player, ...enemy]) {
    p.getOpponents = () => (p.isPlayer() ? enemy : player).filter(x => field.includes(x));
    p.getAlly = () => sideOf(p).find(x => x !== p && field.includes(x));
  }
  const rnd = { _s: "!rnd,0", state(v) { if (v !== undefined) this._s = v; return this._s; }, integerInRange(a, b) { this._s += "+"; return a; } };
  scene = {
    phaseManager: { getCurrentPhase: () => (phase ? { phaseName: phase } : null), queueMessage() {} },
    getField: active => (active ? field.filter(Boolean) : field),
    getPlayerParty: () => player, getEnemyParty: () => enemy,
    arena: { isMoveWeatherCancelled: () => false, isMoveTerrainCancelled: () => false },
    currentBattle: {
      waveIndex: 10, turn: 3, double, enemySwitchCounter: counter, trainer, battleSeedState: "seed0",
      randSeedInt(range, min = 0) { this.battleSeedState += "+"; return min; }, ...battle,
    },
  };
  globalThis.window = globalThis;
  globalThis.Phaser = { Math: { RND: rnd } };
  globalThis.document = { documentElement: { dataset: {} } };
  eval(src);
  return globalThis.__ai;
};
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} ≠ ${b}`);
const pOf = (dist, name) => dist.find(r => r.name === name)?.p ?? 0;
const foe = (o = {}) => mkMon({ id: "me", player: true, fieldIndex: 0, ...o });

// SMART: A 10×2 eff×1.5 STAB = 30, B 20, C 10, D 5 (status: no multipliers). Advance 33%, 25%, 25%.
{
  const e = mkMon({ id: "e", player: false, fieldIndex: 0, types: [9], moves: [
    { id: 3, name: "C", target: -10 }, { id: 1, name: "A", type: 9, target: -10 }, { id: 4, name: "D", category: 2, user: 5 }, { id: 2, name: "B", target: -20 }] });
  const ai = setup({ player: [foe({ eff: { 1: 2 } })], enemy: [e] });
  const dist = ai.enemyMoveDistribution(scene, e);
  near(pOf(dist, "A"), 0.67, "SMART A");
  near(pOf(dist, "B"), 0.33 * 0.75, "SMART B");
  near(pOf(dist, "C"), 0.33 * 0.25 * 0.75, "SMART C");
  near(pOf(dist, "D"), 0.33 * 0.25 * 0.25, "SMART D");
  near(dist.reduce((t, r) => t + r.p, 0), 1, "sums to 1");
  assert.deepEqual(dist.map(r => r.name), ["A", "B", "C", "D"]);
  assert.equal(dist.find(r => r.name === "A").score, 30);
  assert.deepEqual(dist[0].targets, [0]);
  assert.equal(dist[0].slot, 1);
  assert.doesNotThrow(() => JSON.stringify(dist));
  // Cached for the turn: a second call makes no game calls.
  const before = calls.game;
  assert.equal(ai.enemyMoveDistribution(scene, e), dist);
  assert.equal(calls.game, before);
}

// Ties keep moveset order: 10/10/10 → 50%, 25%, 25% in moveset order.
{
  const e = mkMon({ id: "e", player: false, fieldIndex: 0, moves: [
    { id: 1, name: "X", target: -10 }, { id: 2, name: "Y", target: -10 }, { id: 3, name: "Z", target: -10 }] });
  const ai = setup({ player: [foe()], enemy: [e] });
  const dist = ai.enemyMoveDistribution(scene, e);
  near(pOf(dist, "X"), 0.5, "tie X"); near(pOf(dist, "Y"), 0.25, "tie Y"); near(pOf(dist, "Z"), 0.25, "tie Z");
}

// KO filter: B and C reach the foe's 100 HP (max roll, ability ignored while unrevealed) → pool {B 20, C 10}.
{
  const me = foe({ hp: 100, eff: { 1: 2 } });
  const e = mkMon({ id: "e", player: false, fieldIndex: 0, types: [9], moves: [
    { id: 1, name: "A", type: 9, target: -10 }, { id: 2, name: "B", target: -20 }, { id: 3, name: "C", target: -10 }, { id: 4, name: "S", category: 2, user: 50 }] });
  me.getAttackDamage = spy("getAttackDamage", o => { me.lastDamageCall = o; return { damage: { 2: 100, 3: 120, 1: 99 }[o.move.id] ?? 0 }; });
  const ai = setup({ player: [me], enemy: [e] });
  const dist = ai.enemyMoveDistribution(scene, e);
  near(pOf(dist, "B"), 0.75, "KO B");
  near(pOf(dist, "C"), 0.25, "KO C");
  assert.equal(pOf(dist, "A") + pOf(dist, "S"), 0);
  assert.equal(me.lastDamageCall.ignoreAbility, true);
  assert.equal(me.lastDamageCall.simulated, true);
  assert.equal(me.lastDamageCall.isCritical, false);
}

// SMART_RANDOM: advance 3/8 regardless of scores.
{
  const e = mkMon({ id: "e", player: false, fieldIndex: 0, aiType: 1, moves: [
    { id: 1, name: "A", target: -30 }, { id: 2, name: "B", target: -20 }, { id: 3, name: "C", target: -1 }] });
  const ai = setup({ player: [foe()], enemy: [e] });
  const dist = ai.enemyMoveDistribution(scene, e);
  near(pOf(dist, "A"), 5 / 8, "SR A"); near(pOf(dist, "B"), 3 / 8 * 5 / 8, "SR B"); near(pOf(dist, "C"), 9 / 64, "SR C");
}

// RANDOM: uniform.
{
  const e = mkMon({ id: "e", player: false, fieldIndex: 0, aiType: 0, moves: [{ id: 1, name: "A", target: -30 }, { id: 2, name: "B" }, { id: 3, name: "C" }, { id: 4, name: "D" }] });
  const ai = setup({ player: [foe()], enemy: [e] });
  for (const n of "ABCD") near(pOf(ai.enemyMoveDistribution(scene, e), n), 0.25, `RANDOM ${n}`);
}

// Encore forces the encored move; a usable queued move wins over everything; nothing usable → Struggle.
{
  const moves = [{ id: 1, name: "A", target: -30 }, { id: 2, name: "B", target: -1 }];
  let e = mkMon({ id: "e", player: false, fieldIndex: 0, moves, tags: { ENCORE: { moveId: 2 } } });
  let ai = setup({ player: [foe()], enemy: [e] });
  assert.deepEqual(ai.enemyMoveDistribution(scene, e).map(r => [r.name, r.p]), [["B", 1]]);

  e = mkMon({ id: "e", player: false, fieldIndex: 0, moves, queue: [{ move: 2, useMode: 1, targets: [0] }] });
  ai = setup({ player: [foe()], enemy: [e] });
  assert.deepEqual(ai.enemyMoveDistribution(scene, e).map(r => [r.name, r.p, r.targets]), [["B", 1, [0]]]);

  e = mkMon({ id: "e", player: false, fieldIndex: 0, moves: moves.map(m => ({ ...m, usable: false })) });
  ai = setup({ player: [foe()], enemy: [e] });
  assert.deepEqual(ai.enemyMoveDistribution(scene, e).map(r => [r.name, r.p, r.slot, r.targets]), [["Struggle", 1, -1, [0]]]);
}

// Consecutive Protect: the condition passes only when randBattleSeedInt(9) is 0 → branch 1/9 (score 10) vs −20.
{
  const e = mkMon({ id: "e", player: false, fieldIndex: 0, moves: [
    { id: 1, name: "A", target: -20 }, { id: 182, name: "Protect", category: 2, moveTarget: 0, user: 10, attrs: ["ProtectAttr"], cond: s => s.currentBattle.randSeedInt(9) === 0 }] });
  const ai = setup({ player: [foe()], enemy: [e] });
  const dist = ai.enemyMoveDistribution(scene, e);
  near(pOf(dist, "Protect"), 0.25 / 9, "Protect");
  near(pOf(dist, "A"), 1 - 0.25 / 9, "A vs Protect");
  assert.equal(scene.currentBattle.battleSeedState, "seed0", "battle seed untouched");
  assert.ok(!Object.prototype.hasOwnProperty.call(scene.currentBattle, "randSeedInt") || scene.currentBattle.randSeedInt.length === 1, "randSeedInt restored");
}

// Doubles target weighting: benefit 10 / 4 into our slots, −5 into the ally → weights 16, 10 (ally cut) → 16/26, 10/26;
// fractional 10.5 → weights 16.5, 10 → floor(U·26.5) < 17 picks slot 0: 17/26.5.
for (const [top, p0] of [[-10, 16 / 26], [-10.5, 17 / 26.5]]) {
  const player = [foe(), mkMon({ id: "me2", player: true, fieldIndex: 1 })];
  const ally = mkMon({ id: "ally", player: false, fieldIndex: 1, moves: [{ id: 9, name: "Z" }] });
  const e = mkMon({ id: "e", player: false, fieldIndex: 0, moves: [{ id: 1, name: "A", target: bi => ({ 0: top, 1: -4, 3: -5 })[bi] }] });
  const ai = setup({ player, enemy: [e, ally], double: true });
  const [row] = ai.enemyMoveDistribution(scene, e);
  assert.deepEqual(row.targets, [0, 1]);
  near(row.targetDist[0].p, p0, `target weight ${top}`);
  near(row.targetDist[1].p, 1 - p0, `target weight ${top} (other)`);
}

// The sandbox leaves the global RNG alone even when scoring draws from it (Present).
{
  const e = mkMon({ id: "e", player: false, fieldIndex: 0, moves: [{ id: 217, name: "Present", target: -10 }, { id: 2, name: "B", target: -5 }] });
  e.moveset[0].getMove().getTargetBenefitScore = () => { Phaser.Math.RND.integerInRange(0, 9); return -10; };
  const ai = setup({ player: [foe()], enemy: [e] });
  ai.enemyMoveDistribution(scene, e);
  assert.equal(Phaser.Math.RND.state(), "!rnd,0");
  assert.equal(ai.sandboxBreaches(), 0);
}

// Outside the command phase nothing calls game code: the rough fallback (or the turn's cached prediction) is used.
{
  const e = mkMon({ id: "e", player: false, fieldIndex: 0, moves: [{ id: 1, name: "A", target: -30 }, { id: 2, name: "B" }] });
  const ai = setup({ player: [foe()], enemy: [e], phase: "TurnStartPhase", trainer: { getPartyMemberMatchupScores: spy("scores", () => [[1, 9]]), config: {} } });
  const before = calls.game;
  const dist = ai.enemyMoveDistribution(scene, e);
  const action = ai.enemyAction(scene, e);
  assert.equal(calls.game, before, "no game calls outside CommandPhase");
  assert.ok(dist.every(r => r.approx));
  assert.equal(action.kind, "move");
}

// Doubles switch sequencing. Counter 1 → slot 0 (w 0.9: 10·0.9 ≥ 1·3) switches, counter becomes 2 → slot 1
// (w 0.684: 4·0.684 < 1.1·3) stays. If slot 0 stays instead (counter → 0, w 1), slot 1 (4 ≥ 3.3) switches.
for (const [slot0Best, expect] of [[10, ["e0"]], [1, ["e1"]]]) {
  const player = [foe(), mkMon({ id: "me2", player: true, fieldIndex: 1 })];
  const e0 = mkMon({ id: "e0", player: false, fieldIndex: 0 });
  const e1 = mkMon({ id: "e1", player: false, fieldIndex: 1 });
  e0.trainerSlot = 1; e1.trainerSlot = 2; e1.matchup = 1.1;
  const bench = [mkMon({ id: "b0", player: false }), mkMon({ id: "b1", player: false })];
  const trainer = {
    config: { isBoss: false }, shouldTera: () => true,
    getPartyMemberMatchupScores: slot => [[2 + slot - 1, slot === 1 ? slot0Best : 4]],
    getSortedPartyMemberMatchupScores: sc => sc.slice().sort((a, b) => b[1] - a[1]),
    getNextSummonIndex: (slot, sc) => sc[0][0],
  };
  const ai = setup({ player, enemy: [e1, e0, ...bench], double: true, counter: 1, trainer });
  scene.getField = active => [player[0], player[1], e0, e1].filter(x => !active || x);
  const out = ai.predictSwitches(scene, scene.currentBattle, [e1, e0]);
  assert.deepEqual([...out.keys()].map(p => p.id), expect, `slot 0 best ${slot0Best}`);
  assert.equal(scene.currentBattle.enemySwitchCounter, 1, "counter itself untouched");
  const a0 = ai.enemyAction(scene, e0);
  if (expect[0] === "e0") { assert.equal(a0.kind, "switch"); assert.equal(a0.to.id, "b0"); }
  else { assert.equal(a0.kind, "move"); assert.equal(a0.tera, true); }
}

// Commander: a Tatsugiri whose ally is Commanded takes no action (its switch would be skipped too).
{
  const player = [foe(), mkMon({ id: "me2", player: true, fieldIndex: 1 })];
  const tatsu = mkMon({ id: "tatsu", player: false, fieldIndex: 0, moves: [{ id: 1, name: "A", target: -10 }] });
  const dozo = mkMon({ id: "dozo", player: false, fieldIndex: 1, tags: { COMMANDED: {} } });
  tatsu.getAbility = () => ({ id: 279 });
  const trainer = { config: { isBoss: false }, getPartyMemberMatchupScores: () => [[2, 99]], getSortedPartyMemberMatchupScores: sc => sc, getNextSummonIndex: () => 2, shouldTera: () => false };
  const ai = setup({ player, enemy: [tatsu, dozo, mkMon({ id: "b", player: false })], double: true, trainer });
  const act = ai.enemyAction(scene, tatsu);
  assert.deepEqual([act.kind, act.skip, act.dist], ["move", true, []]);
}

// Predicted Tera: the flag is on for the caller's work and off again afterwards, and every prediction is still
// computed pre-Tera (the AI commands before TeraPhase runs).
{
  const e = mkMon({ id: "e", player: false, fieldIndex: 0, moves: [{ id: 1, name: "A", target: -10 }, { id: 2, name: "B" }] });
  e.getTeraType = () => 8; // Steel
  e.summonData.addedType = 11;
  const bench = mkMon({ id: "b", player: false });
  const trainer = {
    config: { isBoss: false }, shouldTera: m => m.id === "e",
    getPartyMemberMatchupScores: () => [[1, 1]], getSortedPartyMemberMatchupScores: sc => sc, getNextSummonIndex: () => 1,
  };
  const ai = setup({ player: [foe()], enemy: [e, bench], trainer });
  assert.deepEqual(ai.predictedTeras(scene, scene.currentBattle).map(m => m.id), ["e"]);

  const seenAi = [], seenSwitch = [];
  e.getMoveType = mv => (seenAi.push(!!e.isTerastallized), mv.type);
  e.getMatchupScore = () => (seenSwitch.push(!!e.isTerastallized), 1);
  const inside = ai.withPredictedTera([e], () => {
    assert.equal(e.isTerastallized, true, "flag on inside");
    assert.equal(e.summonData.addedType, null, "TeraPhase clears an added type");
    assert.equal(ai.teraTypeOf(e), "Steel");
    e.hp = 90; // a fresh turn key, so both predictions are really recomputed under the flag
    ai.enemyMoveDistribution(scene, e);
    ai.predictSwitches(scene, scene.currentBattle, [e]);
    return "ok";
  });
  assert.equal(inside, "ok");
  assert.ok(seenAi.length && seenAi.every(x => x === false), "AI move choice is made pre-Tera");
  assert.ok(seenSwitch.length && seenSwitch.every(x => x === false), "switch choice is made pre-Tera");
  assert.equal(e.isTerastallized, undefined, "flag restored");
  assert.equal(e.summonData.addedType, 11, "added type restored");
  assert.equal(ai.teraTypeOf(e), null, "no Tera predicted outside the wrapper");
}

console.log("enemy AI: all assertions passed");
