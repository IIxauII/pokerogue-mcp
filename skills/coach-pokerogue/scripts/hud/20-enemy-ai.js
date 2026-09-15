// Predictions of what the enemy AI does this turn: switch (EnemyCommandPhase) or move (EnemyPokemon.getNextMove).
// Both are re-implemented from the live build (spec §6, §7) so the HUD gets every outcome with its chance instead
// of one random draw. getNextMove/getNextTargets themselves are never called: they draw from the battle RNG and
// rewrite the move queue.
const muted = sandbox; // older name, kept for callers

// The enemy decides after the player's commands and nothing it reads changes while the game waits for a command,
// so each prediction is computed once per turn key. Outside the command phase the last prediction of the same
// turn is still what the enemy chose from.
const aiTurnKey = (s, b) => [b.waveIndex, b.turn, b.enemySwitchCounter, ...s.getField().map(p => p && `${p.id}:${p.hp}`)].join("|");
const sameTurn = (b, c) => c.wave === b.waveIndex && c.turn === b.turn;

// Game-code helpers (only inside sandbox)
const NO_CONDITION_CHECK = [389, 918, 909]; // Sucker Punch, Upper Hand, Thunderclap: the AI ignores their conditions
const STRUGGLE = 165;
const aiHas = (mv, name) => (mv.hasAttr ? mv.hasAttr(name) : hasAttr(mv, name));
const isAttackMove = mv => (mv.is ? mv.is("AttackMove") : mv.category !== 2);
const usableFor = (pm, e, ignorePp = false) => {
  const r = pm.isUsable(e, ignorePp, true);
  return Array.isArray(r) ? r[0] : !!r;
};
const movesetOf = e => (e.getMoveset?.() ?? e.moveset).filter(Boolean);

// Runs `fn` with the battle RNG answering `pick(range)` instead of drawing, and records the ranges asked for. The
// AI's own path draws for Outrage-type targeting and consecutive Protect; forcing the draw lets each branch be
// evaluated and weighed by its chance. The sandbox restores the seed either way.
let rngPick = range => (range - 1) >> 1;
const forcedRng = (s, fn) => {
  const battle = s.currentBattle;
  const own = Object.prototype.hasOwnProperty.call(battle, "randSeedInt"), prev = battle.randSeedInt;
  battle.randSeedInt = (range, min = 0) => (range <= 1 ? min : (rngRanges.push(range), min + rngPick(range)));
  try { return fn(); } finally { if (own) battle.randSeedInt = prev; else delete battle.randSeedInt; }
};
let rngRanges = [];
const withPick = (pick, fn) => {
  const prevPick = rngPick, prevRanges = rngRanges;
  rngPick = pick; rngRanges = [];
  try { return [fn(), rngRanges]; } finally { rngPick = prevPick; rngRanges = prevRanges; }
};

// getMoveTargets (move-utils) as outcomes [{ targets: battler indices, multiple, p }]: one per opponent for
// RANDOM_NEAR_ENEMY, which draws its target, else a single outcome.
const aiMoveTargets = (s, e, mv) => {
  const holder = { value: mv.moveTarget };
  const opponents = e.getOpponents(false);
  for (const o of opponents) for (const a of mv.getAttrs?.("VariableTargetAttr") ?? []) a.apply(e, o, mv, [holder]);
  const t = holder.value;
  const ally = e.getAlly?.();
  const own = ally == null ? [e] : [e, ally];
  const out = (set, multiple, p = 1) => ({ targets: set.filter(x => x?.isActive(true)).map(x => x.getBattlerIndex()).filter(x => x !== undefined), multiple, p });
  switch (t) {
    case 0: case 18: return [out([e], false)];
    case 19: if (!e.isOfType(7, { returnOriginalTypesIfStellar: true })) return [out([e], false)];
    // falls through: a Ghost's Curse targets like OTHER
    case 1: case 2: case 3: case 4: return [out(ally == null ? opponents : [...opponents, ally], t === 2 || t === 4)];
    case 5: case 6: case 8: case 16: return [out(opponents, t !== 5)];
    case 7: return opponents.length <= 1 ? [out([opponents[0]], false)] : opponents.map(o => out([o], false, 1 / opponents.length));
    case 9: return [{ targets: [-1], multiple: false, p: 1 }];
    case 10: case 11: return [out(ally == null ? [] : [ally], false)];
    case 12: case 13: case 15: return [out(own, t !== 12)];
    case 14: case 17: return [out([...own, ...opponents], true)];
  }
  return [out([], false)];
};

// getNextTargets as a distribution [{ targets, p }]. Single-target moves weigh candidates by target benefit score
// (sorted desc, shifted so the lowest is 1, cut below half the top) and draw randBattleSeedInt(total) =
// floor(U·total) against the cumulative weights: candidate i wins when that integer is in [c(i−1), c(i)).
const aiNextTargets = (s, e, mv) => {
  const dist = [];
  const active = s.getField(true);
  for (const mt of aiMoveTargets(s, e, mv)) {
    const cands = active.filter(p => mt.targets.includes(p.getBattlerIndex()));
    if (mt.multiple) { dist.push({ targets: cands.map(p => p.getBattlerIndex()), p: mt.p }); continue; }
    const scored = cands.map(p => [p.getBattlerIndex(), mv.getTargetBenefitScore(e, p, mv) * (p.isPlayer() === e.isPlayer() ? 1 : -1)]);
    scored.sort((a, b) => (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0));
    if (!scored.length) { dist.push({ targets: aiHas(mv, "CounterDamageAttr") ? [-1] : [], p: mt.p }); continue; }
    let w = scored.map(x => x[1]);
    const lowest = w.at(-1) ?? 0;
    if (lowest < 1) w = w.map(x => x + Math.abs(lowest - 1));
    const cut = w.findIndex(x => x < w[0] / 2);
    if (cut > -1) w = w.slice(0, cut);
    const cum = [];
    w.reduce((t, x) => (t += x, cum.push(t), t), 0);
    const total = cum.at(-1);
    cum.forEach((c, i) => {
      const p = total <= 1 ? (i === 0 ? 1 : 0) : (Math.min(Math.ceil(c), total) - Math.min(Math.ceil(cum[i - 1] ?? 0), total)) / total;
      if (p > 0) dist.push({ targets: [scored[i][0]], p: mt.p * p });
    });
  }
  return dist;
};

// Step 7 of getNextMove for one target, as branches [{ score, p }]. A condition that draws (consecutive Protect
// passes only on a 0) is evaluated with the draw forced both ways and weighted 1/range.
const aiTargetScore = (s, e, mv, bi) => {
  const p = s.getField()[bi];
  let n = mv.getUserBenefitScore(e, p, mv) + mv.getTargetBenefitScore(e, p, mv) * ((bi < 2) === e.isPlayer() ? 1 : -1);
  if (Number.isNaN(n)) n = 0;
  const rest = () => {
    if (s.arena.isMoveWeatherCancelled(e, mv) || s.arena.isMoveTerrainCancelled(e, [bi], mv)) return -20;
    if (!isAttackMove(mv)) return n;
    let x = n;
    const eff = p.getMoveEffectiveness(e, mv, !p.waveData.abilityRevealed, undefined, undefined, true);
    if (p.isPlayer() !== e.isPlayer()) { x *= eff; if (e.isOfType(mv.type)) x *= 1.5; }
    else if (eff) { x /= eff; if (e.isOfType(mv.type)) x /= 1.5; }
    return x || -20;
  };
  const unimplemented = mv.isUnimplemented || / \(N\)$/.test(mv.name ?? "");
  if (NO_CONDITION_CHECK.includes(mv.id)) return [{ score: rest(), p: 1 }];
  if (unimplemented) return [{ score: -20, p: 1 }];
  const [pass, ranges] = withPick(() => 0, () => mv.applyConditions(e, p, -1));
  if (!pass) return [{ score: -20, p: 1 }];
  const [passHigh] = ranges.length ? withPick(r => r - 1, () => mv.applyConditions(e, p, -1)) : [true];
  if (passHigh) return [{ score: rest(), p: 1 }];
  const q = ranges.reduce((t, r) => t / r, 1);
  return [{ score: rest(), p: q }, { score: -20, p: 1 - q }];
};

// A move's options [{ targets, score, p }]: target outcome × condition branches; score = max over its targets
// (the loop stops at the "attacker" index −1; no targets scores −Infinity like Math.max()).
const aiMoveOptions = (s, e, mv) => aiNextTargets(s, e, mv).flatMap(({ targets, p }) => {
  let combos = [{ score: -Infinity, p }];
  for (const bi of targets) {
    if (bi === -1) break;
    const branches = aiTargetScore(s, e, mv, bi);
    combos = combos.flatMap(c => branches.map(br => ({ score: Math.max(c.score, br.score), p: c.p * br.p })));
  }
  return combos.map(c => ({ targets, ...c }));
});

// Step 5: chance this move passes the KO filter — max-roll, non-crit (unless crit-only/Laser Focus) single-hit
// damage reaching a foe's HP, with the abilities the AI hasn't seen ignored.
const aiKoChance = (s, e, pm) => {
  const mv = pm.getMove();
  if (mv.moveTarget === 9 || mv.category === 2) return 0;
  const f = s.getField();
  const crit = aiHas(mv, "CritOnlyAttr") || !!e.getTag("ALWAYS_CRIT");
  let chance = 0;
  for (const mt of aiMoveTargets(s, e, mv)) {
    const ko = mt.targets.map(i => f[i]).filter(p => e.isPlayer() !== p.isPlayer()).some(p =>
      !s.arena.isMoveWeatherCancelled(e, mv) && !s.arena.isMoveTerrainCancelled(e, [p.getBattlerIndex()], mv)
      && (mv.applyConditions(e, p, -1) || NO_CONDITION_CHECK.includes(mv.id))
      && p.getAttackDamage({ source: e, move: mv, ignoreAbility: !p.waveData.abilityRevealed, ignoreSourceAbility: false,
        ignoreAllyAbility: !p.getAlly?.()?.waveData.abilityRevealed, ignoreSourceAllyAbility: false, isCritical: crit, simulated: true }).damage >= p.hp);
    if (ko) chance += mt.p;
  }
  return chance;
};

// Chance of ending on each index of the score-sorted pool: the AI starts at the top and keeps advancing while
// its draw says so — SMART_RANDOM with 3/8, SMART with round(next/current·50)% while that ratio is ≥ 0.
const aiChain = (aiType, scores) => {
  const out = [];
  let reach = 1;
  scores.forEach((x, i) => {
    let adv = 0;
    if (i < scores.length - 1) {
      if (aiType === 1) adv = 3 / 8;
      else { const r = scores[i + 1] / x; adv = r >= 0 ? Math.min(Math.max(Math.round(r * 50), 0), 100) / 100 : 0; }
    }
    out.push(reach * (1 - adv));
    reach *= adv;
  });
  return out;
};

// getNextMove, every outcome with its chance. Returns JSON-safe rows sorted by chance.
const aiDistribution = (s, e) => {
  const moveset = movesetOf(e);
  const rows = new Map();
  const typeOf = mv => { try { return TYPES[e.getMoveType(mv)] ?? TYPES[mv.type]; } catch { return TYPES[mv.type]; } };
  // `id` only for a queued move that isn't in the moveset (called by another move).
  const row = (pm, id = STRUGGLE) => {
    const slot = pm ? moveset.indexOf(pm) : id === STRUGGLE ? -1 : null;
    const k = pm ? slot : `id${id}`;
    if (!rows.has(k)) {
      const mv = pm?.getMove();
      rows.set(k, {
        name: pm ? pm.getName() : id === STRUGGLE ? "Struggle" : `#${id}`, id: mv?.id ?? id, slot,
        type: mv ? typeOf(mv) : "Normal", cat: mv ? ["physical", "special", "status"][mv.category] : "physical",
        spread: SPREAD_TARGETS.includes(mv?.moveTarget), p: 0, score: null, scoreW: 0, tp: new Map(),
      });
    }
    return rows.get(k);
  };
  // `score` is averaged over the outcomes where the move is in the pool (`inPool` = that outcome's chance).
  const add = (r, p, targetDist, score = null, inPool = 0) => {
    r.p += p;
    if (score != null) { r.score = (r.score ?? 0) + score * inPool; r.scoreW += inPool; }
    for (const t of targetDist) for (const bi of t.targets) r.tp.set(bi, (r.tp.get(bi) ?? 0) + p * t.p);
  };
  const whole = (pm, p = 1) => add(row(pm), p, aiNextTargets(s, e, pm.getMove()));

  // 1. A usable queued move (charging, Outrage lock, …) is used again.
  for (const q of e.getMoveQueue()) {
    const pm = moveset.find(m => m.moveId === q.move);
    if (q.useMode >= 3 || (pm && usableFor(pm, e, q.useMode >= 2))) {
      add(row(pm, q.move), 1, [{ targets: q.targets ?? [], p: 1 }]);
      return finish(rows);
    }
  }
  // 2–3. Usable pool; Struggle, a single move, Encore.
  const pool = moveset.filter(pm => usableFor(pm, e));
  if (!pool.length) {
    const opp = e.getOpponents().map(p => p.getBattlerIndex());
    add(row(null), 1, opp.map(bi => ({ targets: [bi], p: 1 / opp.length })));
    return finish(rows);
  }
  if (pool.length === 1) { whole(pool[0]); return finish(rows); }
  const encore = e.getTag("ENCORE");
  const encored = encore && pool.find(pm => pm.moveId === encore.moveId);
  if (encored) { whole(encored); return finish(rows); }
  // 4. RANDOM.
  if (e.aiType !== 1 && e.aiType !== 2) { pool.forEach(pm => whole(pm, 1 / pool.length)); return finish(rows); }

  // 5. KO filter: each move passes with some chance; enumerate which pass.
  let outcomes = [{ passing: [], p: 1 }];
  for (const pm of pool) {
    const c = aiKoChance(s, e, pm);
    outcomes = outcomes.flatMap(o => [
      ...(c > 0 ? [{ passing: [...o.passing, pm], p: o.p * c }] : []),
      ...(c < 1 ? [{ passing: o.passing, p: o.p * (1 - c) }] : []),
    ]);
  }
  // 6–8. Each pool's target/condition outcomes, stable sort by score, then the chain.
  const options = new Map();
  const optionsOf = pm => { if (!options.has(pm)) options.set(pm, aiMoveOptions(s, e, pm.getMove())); return options.get(pm); };
  for (const o of outcomes) {
    const movePool = o.passing.length ? o.passing : pool;
    let combos = [{ picks: [], p: o.p }];
    for (const pm of movePool) combos = combos.flatMap(c => optionsOf(pm).map(opt => ({ picks: [...c.picks, opt], p: c.p * opt.p })));
    for (const c of combos) {
      const order = movePool.map((_, i) => i);
      order.sort((a, b) => { const x = c.picks[a].score, y = c.picks[b].score; return x < y ? 1 : x > y ? -1 : 0; });
      const chain = aiChain(e.aiType, order.map(i => c.picks[i].score));
      order.forEach((i, k) => {
        const pick = c.picks[i];
        add(row(movePool[i]), c.p * chain[k], [{ targets: pick.targets, p: 1 }], pick.score, c.p);
      });
    }
  }
  return finish(rows);
};
// Rows out: chance-sorted; targets are battler indices (s.getField()[i]) by chance, targetDist the chance of each
// given this move; score is the AI's average score for the move.
const finish = rows => [...rows.values()].filter(r => r.p > 1e-12).map(({ tp, scoreW, score, ...r }) => {
  const targetDist = [...tp].map(([battlerIndex, p]) => ({ battlerIndex, p: p / r.p })).sort((a, b) => b.p - a.p);
  return { ...r, score: score == null ? null : Number.isFinite(score / (scoreW || 1)) ? score / (scoreW || 1) : null, targets: targetDist.map(t => t.battlerIndex), targetDist };
}).sort((a, b) => b.p - a.p);

// Without game calls (not the command phase, or the functions are missing): the foe's damaging moves ranked by
// rough damage into their best target, KO moves first, with the SMART chain on those numbers.
const approxDistribution = e => {
  try {
    const best = new Map();
    for (const o of e.getOpponents?.() ?? []) {
      for (const x of hits(e, o, true)) {
        const cur = best.get(x.name);
        const ko = x.dmg >= o.hp || !!cur?.ko;
        if (!cur || x.dmg > cur.dmg) best.set(x.name, { ...x, ko, target: o.getBattlerIndex?.() });
        else cur.ko = ko;
      }
    }
    let pool = [...best.values()];
    if (pool.some(x => x.ko)) pool = pool.filter(x => x.ko);
    pool.sort((a, b) => b.dmg - a.dmg);
    const chain = aiChain(e.aiType === 1 ? 1 : 2, pool.map(x => x.dmg));
    return pool.map((x, i) => ({
      name: x.name, type: x.type, cat: x.cat, spread: x.spread, p: chain[i], score: x.dmg, approx: true,
      targets: x.target == null ? [] : [x.target], targetDist: x.target == null ? [] : [{ battlerIndex: x.target, p: 1 }],
    })).filter(r => r.p > 0);
  } catch { return []; }
};

let moveCache = { key: null, wave: null, turn: null, value: new Map() };
// `[{ name, id, slot /* index in e's moveset, −1 Struggle */, type, cat, spread, p, score, targets, targetDist }]`
const enemyMoveDistribution = (s, e) => {
  const b = s.currentBattle;
  const key = aiTurnKey(s, b);
  if ((moveCache.key === key || (!awaitingCommand(s) && sameTurn(b, moveCache))) && moveCache.value.has(e.id)) return moveCache.value.get(e.id);
  if (!awaitingCommand(s)) return approxDistribution(e);
  if (moveCache.key !== key) moveCache = { key, wave: b.waveIndex, turn: b.turn, value: new Map() };
  let dist;
  try { dist = beforeTera(() => sandbox(s, () => forcedRng(s, () => aiDistribution(s, e)))); } catch { dist = approxDistribution(e); }
  moveCache.value.set(e.id, dist);
  return dist;
};

// ---- Predicted Terastallization (spec §7)
// TeraPhase runs at TurnStart, before any move, so a trainer mon that Terastallizes this turn already defends with
// [getTeraType()] and gets Tera STAB by the time damage is dealt. The game computes all of that itself once
// `isTerastallized` is set (TeraPhase also clears an added type), so the planner runs its whole refresh with the
// flag set on the foes that will Tera, inside its sandbox, and restores it afterwards.
// The AI's own choices came first (EnemyCommandPhase runs before TeraPhase), so every prediction here is computed
// with the flag taken back off — `beforeTera`.
const teraSaved = new Map(); // mon → its pre-Tera { isTerastallized, addedType }
const teraOn = (e, on) => {
  e.isTerastallized = on ? true : teraSaved.get(e).isTerastallized;
  if (e.summonData) e.summonData.addedType = on ? null : teraSaved.get(e).addedType;
};
const withPredictedTera = (mons, fn) => {
  const fresh = mons.filter(e => e && !teraSaved.has(e));
  for (const e of fresh) {
    teraSaved.set(e, { isTerastallized: e.isTerastallized, addedType: e.summonData?.addedType ?? null });
    teraOn(e, true);
  }
  try { return fn(); } finally { for (const e of fresh) { teraOn(e, false); teraSaved.delete(e); } }
};
const beforeTera = fn => {
  const on = [...teraSaved.keys()];
  for (const e of on) teraOn(e, false);
  try { return fn(); } finally { for (const e of on) teraOn(e, true); }
};
const isTeraPredicted = e => teraSaved.has(e);
const teraTypeOf = e => { try { return isTeraPredicted(e) ? TYPES[e.getTeraType?.()] ?? null : null; } catch { return null; } };
// The foes that Terastallize before they move this turn: on the field, acting, and the trainer says so.
const predictedTeras = (s, b) => {
  if (!b?.trainer?.shouldTera) return [];
  const active = (s.getEnemyParty?.() ?? []).filter(p => p.isOnField?.()).slice(0, b.double ? 2 : 1);
  return active.filter(e => { try { return enemyAction(s, e).tera; } catch { return false; } });
};

// Commander: a Tatsugiri inside its Dondozo (and mystery encounters that skip enemy turns) gets its command
// marked skip, which TurnStartPhase drops — no move and no switch.
const skipsTurn = (b, e) => !!b.mysteryEncounter?.skipEnemyBattleTurns
  || !!(b.double && e.getAlly?.()?.getTag?.("COMMANDED") && [e.getAbility?.(), e.hasPassive?.() && e.getPassiveAbility?.()].some(a => a?.id === 279));

// Trainer switch prediction (EnemyCommandPhase): an active mon that isn't trapped or locked into a move switches when
//   bestBenchScore × (1 − 0.1^(1/enemySwitchCounter)) ≥ avg own matchup score × (boss ? 2 : 3)
// and sends trainer.getNextSummonIndex(). Slots decide in field order and each decision moves the counter
// (+1 on a switch, −1 floored at 0 otherwise) before the next slot reads it. Switches resolve before moves, so our
// attack lands on the switch-in.
let switchCache = { key: null, wave: null, turn: null, value: new Map() };
const predictSwitches = (s, b, active) => {
  const tr = b.trainer;
  if (!tr?.getPartyMemberMatchupScores) return new Map();
  const key = aiTurnKey(s, b);
  if (switchCache.key === key) return switchCache.value;
  if (!awaitingCommand(s)) return sameTurn(b, switchCache) ? switchCache.value : new Map();
  const out = new Map();
  const enemies = s.getEnemyParty();
  const slots = [...active].sort((x, y) => (x.getFieldIndex?.() ?? 0) - (y.getFieldIndex?.() ?? 0));
  let counter = b.enemySwitchCounter ?? 0;
  beforeTera(() => sandbox(s, () => {
    for (const e of slots) {
      let switched = false;
      try {
        if (!e.getMoveQueue().length && !e.isTrapped()) {
          const scores = tr.getPartyMemberMatchupScores(e.trainerSlot, true);
          if (scores.length) {
            const own = e.getOpponents().map(o => e.getMatchupScore(o));
            const avg = own.reduce((t, x) => t + x, 0) / own.length;
            const best = tr.getSortedPartyMemberMatchupScores(scores)[0][1];
            const w = 1 - (counter ? 0.1 ** (1 / counter) : 0);
            if (best * w >= avg * (tr.config.isBoss ? 2 : 3)) {
              switched = true;
              const to = enemies[tr.getNextSummonIndex(e.trainerSlot, scores)];
              if (to && !skipsTurn(b, e) && ![...out.values()].some(v => v.to === to)) out.set(e, { to, ratio: 1 });
            }
          }
        }
      } catch {}
      counter = switched ? counter + 1 : Math.max(counter - 1, 0);
    }
  }));
  switchCache = { key, wave: b.waveIndex, turn: b.turn, value: out };
  return out;
};

// `{ kind: "switch", to }` or `{ kind: "move", dist, tera, skip? }`. A switching mon doesn't Terastallize.
const enemyAction = (s, e) => {
  const b = s.currentBattle;
  const active = s.getEnemyParty().filter(p => p.isOnField?.()).slice(0, b.double ? 2 : 1);
  const sw = predictSwitches(s, b, active).get(e);
  if (sw) return { kind: "switch", to: sw.to };
  if (skipsTurn(b, e)) return { kind: "move", dist: [], tera: false, skip: true };
  return { kind: "move", dist: enemyMoveDistribution(s, e), tera: !!b.trainer?.shouldTera?.(e) };
};
