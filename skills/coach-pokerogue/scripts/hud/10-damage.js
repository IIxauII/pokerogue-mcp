// Damage: what each move does to a target this turn, and 1-v-1 matchups.
// While the game waits for a command, the numbers come from the game's own damage code (Pokemon.getAttackDamage,
// simulated, inside `sandbox`), so held items, abilities, stat stages, weather, screens and form-dependent types
// are the game's. Everything the simulated call leaves out is modelled here from the coach spec (game-code.md):
// the damage roll, crits, accuracy, multi-hit counts, boss HP segments, Sturdy / Focus Band / endure survival and
// turn-end HP changes (weather and status chip, berries, Leftovers and other heals). Outside the command phase, or against mocks without game functions, the old
// approximation keeps the panel rendering.

// Per-turn damage discount for moves that often don't land when chosen: Focus Punch fails if the user is hit
// first, charging and recharging moves spend a second turn, negative priority moves go last.
const reliability = mv => {
  if (hasAttr(mv, "PreUseInterruptAttr")) return 0.4;
  if (mv.isChargingMove?.() || hasAttr(mv, "RechargeAttr")) return 0.5;
  return mv.priority < 0 ? 0.8 : 1;
};
// Only used by the approximation: enemy damage estimated without rolls, crits or items gets a safety margin.
const FOE_MARGIN = 1.15;

// Private helpers live in this closure so their names can't collide with other hud modules.
const { moveOutcome, moveOutcomes, applyHits, endOfTurnHp, hits } = (() => {
  // Class names survive minification; subclasses count (FixedDamageAttr covers Super Fang, Seismic Toss…).
  const isA = (x, name) => {
    for (let c = x?.constructor; c?.name; c = Object.getPrototypeOf(c)) if (c.name === name) return true;
    return false;
  };
  const attrs = (mv, name) => (mv.attrs || []).filter(a => isA(a, name));
  const hasFlag = (mv, f) => (typeof mv.hasFlag === "function" ? mv.hasFlag(f) : !!((mv.flags ?? 0) & f));
  const ability = (p, attr) => { try { return !!p.hasAbilityWithAttr?.(attr); } catch { return false; } };
  const items = p => { try { return p.getHeldItems?.() ?? []; } catch { return []; } };
  const stack = (p, name) => items(p).filter(m => m.constructor.name === name).reduce((t, m) => t + (m.getStackCount?.() ?? m.stackCount ?? 1), 0);
  const sceneNow = () => {
    try { return Phaser.Display.Canvas.CanvasPool.pool.map(p => p.parent).find(p => p?.game).game.scene.getScene("battle"); } catch { return null; }
  };
  const gameReady = (s, atk, def) => !!s && awaitingCommand(s) && typeof def.getAttackDamage === "function" && typeof atk.getMoveType === "function";
  const turnKey = s => {
    const b = s.currentBattle;
    return [b?.waveIndex, b?.turn, b?.enemySwitchCounter, ...(s.getField?.() ?? []).map(p => p && `${p.id}:${p.hp}`)].join("|");
  };
  let cache = { key: null, map: new Map() };
  const cached = (s, key, fn) => {
    const turn = turnKey(s);
    if (cache.key !== turn) cache = { key: turn, map: new Map() };
    if (!cache.map.has(key)) cache.map.set(key, fn());
    return cache.map.get(key);
  };
  // Sucker Punch and Thunderclap read the target's chosen command, which doesn't exist yet while we choose: their
  // condition is left to the planner (`needsAttack`). (Upper Hand needs a priority move from the target: dropped.)
  const COMMAND_CONDITION = [389, 909];
  // Damaging moves with PP left. With `def` and game calls allowed, also only what can be picked and would work this
  // turn: restrictions checked for selection (Disable, Taunt, Encore, Torment, Imprison…) and the move's own
  // conditions (Fake Out / First Impression after the first turn, Dream Eater on an awake target, Belch, Steel
  // Roller…). Conditions can draw from the battle RNG, so they run with it forced, like the enemy AI's.
  const usable = (p, def = null, s = null) => {
    const base = p.moveset.filter(Boolean).filter(pm => pm.getMove().category !== 2 && pm.getMovePp() - pm.ppUsed > 0);
    if (!def || !gameReady(s, p, def)) return base;
    return cached(s, `u|${p.id}|${def.id}|${base.map(pm => pm.getMove().id)}`, () => guarded(s, () => base.filter(pm => {
      if (typeof pm.isUsable === "function") {
        const r = pm.isUsable(p, false, true);
        if (!(Array.isArray(r) ? r[0] : r)) return false;
      }
      const mv = pm.getMove();
      if (typeof mv.applyConditions !== "function" || COMMAND_CONDITION.includes(mv.id)) return true;
      try { return !!forcedRng(s, () => mv.applyConditions(p, def, -1)); } catch { return true; }
    })));
  };
  // What a move costs over turns and what it depends on. `charge`: a charging turn before the hit (Solar Beam
  // outside sun, Sky Attack, Skull Bash; Dig / Fly / Dive / Bounce semi-invulnerable meanwhile, `semiCharge`) —
  // unless its instant-charge condition holds now; `recharge`: a lost turn after it (Hyper Beam, Giga Impact);
  // `interrupt`: fails if the user is hit first (Focus Punch); `needsAttack`: fails unless the target attacks
  // (Sucker Punch, Thunderclap); `once`: only on the user's first turn out (Fake Out, First Impression).
  const traits = (atk, mv, live) => {
    const charging = !!mv.isChargingMove?.();
    const chargeAttrs = mv.chargeAttrs ?? [];
    const instant = charging && live && chargeAttrs.some(a => isA(a, "InstantChargeAttr") && a.condition?.(atk, mv));
    return {
      charge: charging && !instant,
      semiCharge: charging && !instant && chargeAttrs.some(a => isA(a, "SemiInvulnerableAttr")),
      recharge: attrs(mv, "RechargeAttr").length > 0,
      interrupt: attrs(mv, "PreUseInterruptAttr").length > 0,
      needsAttack: mv.id === 389 || mv.id === 909,
      once: [mv.conditions, mv.conditionsSeq2, mv.conditionsSeq3].some(cs => (cs ?? []).some(c => isA(c, "FirstMoveCondition"))),
    };
  };

  // ---- Boss segments and survival (spec §3, §8). Pure math on read fields.
  // EnemyPokemon's module-private calculateBossSegmentDamage, verbatim.
  const bossSegmentDamage = (dmg, hp, segSize, minIdx = 0, idx) => {
    const a = idx ?? Math.ceil(hp / segSize) - 1;
    if (a <= 0) return [dmg, 1];
    const floorHp = segSize * a;
    const excess = dmg - (hp - Math.round(floorHp));
    if (excess < 0) return [dmg, a + 1];
    if (excess === 0) return [dmg, a];
    const c = Math.min(Math.max(Math.floor(Math.log2(excess / segSize)), 0), a - minIdx);
    return [Math.max(Math.floor(hp - floorHp + segSize * c), 1), a - c];
  };
  // What decides how a hit resolves on `t`. `ignoreAbility`: Mold Breaker, or the AI not knowing the ability.
  const targetFacts = (s, t, ignoreAbility = false) => {
    const maxHp = t.getMaxHp();
    const segs = t.bossSegments > 0 && (t.isBoss?.() ?? true) ? t.bossSegments : 0;
    const enemy = typeof t.isPlayer === "function" && !t.isPlayer();
    const endure = enemy && !t.waveData?.endured ? (s?.enemyModifiers ?? []).find(m => m.constructor.name === "EnemyEndureChanceModifier") : null;
    return {
      maxHp, hp: t.hp, boss: segs > 0, segs, segSize: segs ? maxHp / segs : 0, idx: t.bossSegmentIndex ?? 0,
      minIdx: s?.currentBattle?.isClassicFinalBoss && !t.formIndex ? 1 : 0,
      finalBoss: enemy && !!s?.currentBattle?.isClassicFinalBoss && !t.formIndex,
      sturdy: !ignoreAbility && maxHp > 1 && ability(t, "PreDefendFullHpEndureAbAttr"),
      pFocus: Math.min(1, 0.1 * stack(t, "SurviveDamageModifier")),
      pEndure: endure ? Math.min(1, (endure.chance ?? 2) * (endure.getStackCount?.() ?? 1) / 100) : 0,
      // Reviver Seed (FaintPhase): a faint brings it straight back at half HP, so no KO.
      revive: stack(t, "PokemonInstantReviveModifier") ? Math.max(1, Math.floor(maxHp / 2)) : 0,
    };
  };
  // One landed hit of `d` on state {hp, idx, tok} as EnemyPokemon.damage / Pokemon.damage resolve it:
  // [[state, probability], ...]. `tok`: the enemy endure token is up, so every later lethal hit this turn leaves 1 HP.
  // OHKO results skip segments.
  const landHit = (f, st, d, ohko) => {
    let idx = st.idx;
    if (f.boss && !ohko) {
      const [bd, seg] = bossSegmentDamage(d, st.hp, f.segSize, f.minIdx, st.idx);
      d = bd;
      idx = Math.max(0, Math.min(st.idx, seg - 1));
    }
    if (f.finalBoss && st.idx < 1) d = Math.min(d, st.hp - 1);
    if (st.hp - d > 0) return [[{ hp: st.hp - d, idx, tok: st.tok }, 1]];
    if (st.tok || (f.sturdy && st.hp >= f.maxHp)) return [[{ hp: 1, idx, tok: st.tok }, 1]];
    return [
      [{ hp: 1, idx, tok: true }, f.pEndure],
      [{ hp: 1, idx, tok: false }, (1 - f.pEndure) * f.pFocus],
      [{ hp: 0, idx, tok: false }, (1 - f.pEndure) * (1 - f.pFocus)],
    ].filter(([, p]) => p > 0);
  };
  // Distribution of the target's end state over the whole move. `perHit[k]`: Map damage → probability for hit k;
  // `dist`: [{n, p}] hit counts; `acc`: chance each rolled hit lands; `checkAll`: every hit rolls (else only the
  // first). A miss or a faint ends the move; earlier hits stay.
  const resolve = (f, perHit, dist, acc, checkAll, ohko = false) => {
    const add = (m, st, p) => {
      if (!(p > 0)) return;
      const k = `${st.hp}|${st.idx}|${st.tok}`;
      const e = m.get(k);
      if (e) e.p += p; else m.set(k, { hp: st.hp, idx: st.idx, tok: st.tok, p });
    };
    const atLeast = n => dist.filter(x => x.n >= n).reduce((t, x) => t + x.p, 0);
    const done = new Map();
    let live = new Map();
    add(live, { hp: f.hp, idx: f.idx, tok: false }, 1);
    const hitsMax = Math.max(...dist.map(x => x.n));
    for (let k = 0; k < hitsMax && live.size; k++) {
      const go = (k ? atLeast(k + 1) / atLeast(k) : atLeast(1)) * (k === 0 || checkAll ? acc : 1);
      const next = new Map();
      for (const st of live.values()) {
        if (st.hp <= 0) { add(done, st, st.p); continue; }
        add(done, st, st.p * (1 - go));
        for (const [d, p] of perHit[Math.min(k, perHit.length - 1)]) for (const [ns, q] of landHit(f, st, d, ohko)) add(next, ns, st.p * go * p * q);
      }
      live = next;
    }
    for (const st of live.values()) add(done, st, st.p);
    return [...done.values()];
  };

  // Resolve a fixed list of hit damages on `target` in order: boss clamp per hit, Sturdy, Disguise excluded.
  // `ko`/`hp` assume no luck; `pSurvive` is the chance Focus Band or the enemy endure token saves it anyway.
  const applyHits = (target, hitDamages, { s = sceneNow(), ignoreAbility = false, ohko = false } = {}) => {
    const f = targetFacts(s, target, ignoreAbility);
    const perHit = hitDamages.length ? hitDamages.map(d => new Map([[Math.max(0, Math.floor(d)), 1]])) : [new Map([[0, 1]])];
    const dist = [{ n: perHit.length, p: 1 }];
    const [end] = resolve({ ...f, pFocus: 0, pEndure: 0 }, perHit, dist, 1, false, ohko);
    const ko = end.hp <= 0;
    const pSurvive = ko ? resolve(f, perHit, dist, 1, false, ohko).filter(x => x.hp > 0).reduce((t, x) => t + x.p, 0) : 1;
    return { hp: Math.max(0, end.hp), segIdx: end.idx, ko, pSurvive };
  };

  // ---- Turn end (spec §8). The HP a pokémon gains (+) or loses (−) between this turn's moves and the next command,
  // in the game's order: weather chip (WeatherEffectPhase), status chip (PostTurnStatusEffectPhase), berries
  // (BerryPhase), then TurnEndPhase heals. Chip can faint it, and a fainted mon heals nothing. `hp`: the HP it will
  // have by then, if not its current HP; `tookSuperEffective`: Enigma; `dealt`: damage it dealt this turn (Shell Bell).
  // Reads fields and item/ability attributes only.
  const abAttrs = (p, name) => (ability(p, name)
    ? [p.getAbility?.(), p.hasPassive?.() ? p.getPassiveAbility?.() : null].flatMap(a => a?.getAttrs?.(name) ?? []) : []);
  const frac = (max, n) => Math.max(1, Math.floor(max / n));
  const WEATHER_SPARED = { 3: [4, 5, 8], 4: [14] }; // sandstorm: Ground, Rock, Steel; hail: Ice
  const ORB_SPARED = { 1: [3, 8], 2: [3, 8], 6: [9] }; // poison: Poison, Steel; burn: Fire
  const endOfTurnHp = (p, { s = sceneNow(), tookSuperEffective = false, hp = p.hp, dealt = 0 } = {}) => {
    if (hp <= 0) return 0;
    const max = p.getMaxHp();
    const types = p.getTypes?.() ?? [];
    const guard = ability(p, "BlockNonDirectDamageAbAttr");
    const w = s?.arena?.weather?.weatherType ?? 0;
    const weather = w && !(s.getField?.(true) ?? []).some(q => q && ability(q, "SuppressWeatherEffectAbAttr")) ? w : 0;
    const inWeather = a => (a.weatherTypes ?? []).includes(weather);
    let chip = 0;
    if (WEATHER_SPARED[weather] && !guard && !types.some(t => WEATHER_SPARED[weather].includes(t))
      && !abAttrs(p, "BlockWeatherDamageAttr").some(a => !a.weatherTypes?.length || inWeather(a))
      && !p.getTag?.("UNDERGROUND") && !p.getTag?.("UNDERWATER")) chip += frac(max, 16);
    // Dry Skin / Solar Power in sun.
    if (!guard) for (const a of abAttrs(p, "PostWeatherLapseDamageAbAttr")) if (inWeather(a)) chip += frac(max, 16 / (a.damageFactor ?? 2));
    // Toxic / Flame Orb put their status on at turn end: counted as if already on, a turn early.
    const orb = p.status?.effect ? null : items(p).find(m => m.constructor.name === "TurnStatusEffectModifier" && !types.some(t => ORB_SPARED[m.effect]?.includes(t)));
    const effect = p.status?.effect || orb?.effect || 0;
    if ([1, 2, 6].includes(effect) && !guard && !abAttrs(p, "BlockStatusDamageAbAttr").some(a => (a.effects ?? []).includes(effect))) {
      let d = effect === 1 ? frac(max, 8) : effect === 2 ? Math.max(1, Math.floor(max * ((p.status?.toxicTurnCount ?? 0) + 1) / 16)) : frac(max, 16);
      if (effect === 6) for (const a of abAttrs(p, "ReduceBurnDamageAbAttr")) d = Math.max(1, Math.floor(d * (a.multiplier ?? 0.5)));
      chip += d;
    }
    const left = hp - chip;
    if (left <= 0) return -hp;

    const quarter = Math.max(1, Math.floor(max / 4)) * (ability(p, "DoubleBerryEffectAbAttr") ? 2 : 1);
    const berry = t => items(p).some(m => m.constructor.name === "BerryModifier" && m.berryType === t);
    let heal = 0;
    if (berry(0) && left / max < 0.5) heal += quarter;
    if (berry(2) && tookSuperEffective) heal += quarter;
    heal += frac(max, 16) * stack(p, "TurnHealModifier");
    if (s?.arena?.terrain?.terrainType === 3 && (p.isGrounded?.() ?? !types.includes(2))) heal += frac(max, 16);
    if (p.isPlayer?.() === false) {
      const n = (s?.enemyModifiers ?? []).filter(m => m.constructor.name === "EnemyTurnHealModifier").reduce((t, m) => t + (m.getStackCount?.() ?? 1), 0);
      if (n) heal += Math.max(Math.floor(max / 50) * n, 1);
    }
    for (const a of abAttrs(p, "PostWeatherLapseHealAbAttr")) if (inWeather(a)) heal += frac(max, 16 / (a.healFactor ?? 1));
    if (abAttrs(p, "PostTurnStatusHealAbAttr").some(a => (a.effects ?? []).includes(effect))) heal += frac(max, 8);
    if (dealt > 0) heal += frac(dealt, 8) * stack(p, "HitHealModifier");
    return Math.min(max, left + heal) - hp;
  };

  // ---- Game path (spec §1, §2, §4, §5)
  const STAT_NAMES = ["HP", "Atk", "Def", "SpA", "SpD", "Spe", "Acc", "Eva"];
  const RESULT_MULT = { 1: 1, 2: 4, 3: 2, 4: 0.5, 5: 0.25, 6: 1, 7: 0, 13: 0 };
  // The random roll is 85..100 %, uniform over 16 values; the simulated call returns the 100 % one.
  const addRolls = (m, max, p) => {
    for (let r = 85; r <= 100; r++) {
      const d = max > 0 ? Math.max(1, Math.floor(max * r / 100)) : 0;
      m.set(d, (m.get(d) ?? 0) + p / 16);
    }
  };
  // Present draws its power from Phaser's RNG: pin the draw to get each power's damage.
  const withSeed = (seed, fn) => {
    const R = Phaser.Math.RND, own = Object.prototype.hasOwnProperty.call(R, "integerInRange"), orig = R.integerInRange;
    R.integerInRange = min => min + seed;
    try { return fn(); } finally { if (own) R.integerInRange = orig; else delete R.integerInRange; }
  };
  const PRESENT = [[0, 0.4], [150, 0.3], [190, 0.1]]; // 40 / 80 / 120 power; the other 20 % heals the target

  const fromGame = (s, atk, def, pm, opts) => {
    const move = pm.getMove();
    if (attrs(move, "CounterDamageAttr").length) return null; // reacts to damage taken this turn: nothing yet
    const aiBlind = !!opts.aiView && !def.waveData?.abilityRevealed;
    const ignoreAbility = aiBlind || ability(atk, "MoveAbilityBypassAbAttr") || hasFlag(move, 32768);
    const ignoreAllyAbility = !!opts.aiView && !def.getAlly?.()?.waveData?.abilityRevealed;
    // A cached Tera Shell result from an earlier call would leak into this move; the sandbox restores it.
    if (def.turnData) def.turnData.moveEffectiveness = null;

    const type = TYPES[atk.getMoveType(move)] ?? "Normal";
    const cat = (atk.getMoveCategory?.(def, move) ?? move.category) === 0 ? "physical" : "special";
    const priority = move.getPriority?.(atk, true) ?? move.priority ?? 0;
    const spread = SPREAD_TARGETS.includes(move.moveTarget);
    const others = (s.getField?.(true) ?? []).filter(p => p && p !== atk && p.hp > 0 && (p.isOnField?.() ?? true));
    const spreadApplied = spread && (move.moveTarget === 2 || move.moveTarget === 4 ? others : others.filter(p => p.isPlayer?.() !== atk.isPlayer?.())).length > 1;

    // Hit counts (§2): MultiHitAttr type, Skill Link, Beat Up, plus Parental Bond / Multi-Lens strikes.
    const mh = attrs(move, "MultiHitAttr")[0];
    let mhType = mh ? mh.multiHitType ?? mh.intrinsicMultiHitType : null;
    if (mh && attrs(move, "ChangeMultiHitTypeAttr").length && atk.species?.speciesId === 658 && atk.formIndex === 2) mhType = 2;
    const skillLink = ability(atk, "MaxMultiHitAbAttr");
    const party = () => (atk.isPlayer?.() ? s.getPlayerParty() : s.getEnemyParty()) ?? [];
    let dist = mhType == null ? [{ n: 1, p: 1 }]
      : mhType === 1 ? (skillLink ? [{ n: 5, p: 1 }] : [{ n: 2, p: 0.35 }, { n: 3, p: 0.35 }, { n: 4, p: 0.15 }, { n: 5, p: 0.15 }])
      : [{ n: mhType === 0 ? 2 : mhType === 2 ? 3 : mhType === 3 ? 10 : party().reduce((t, n) => t + (n.id === atk.id ? 1 : n?.status && n.status.effect !== 0 ? 0 : 1), 0), p: 1 }];
    const enhanced = (...args) => (typeof move.canBeMultiStrikeEnhanced === "function" ? !!move.canBeMultiStrikeEnhanced(...args) : !mh && !spread);
    const lenses = stack(atk, "PokemonMultiHitModifier");
    const extra = (ability(atk, "AddSecondStrikeAbAttr") && enhanced(atk, true, def) ? 1 : 0) + (lenses && enhanced(atk) ? lenses : 0);
    if (extra) dist = dist.map(x => ({ n: x.n + extra, p: x.p }));
    const hitsMax = Math.max(...dist.map(x => x.n));

    // One hit at the max roll. Multi-hit power steps and Parental Bond / Multi-Lens factors read the user's
    // turnData, which is fresh (hitCount 0) at the command phase, so set it the way MoveEffectPhase does. The 2–5
    // hit moves reuse the longest count's per-hit numbers: nothing that reads hitCount applies to them.
    const call = (k, isCritical) => {
      if (atk.turnData) { atk.turnData.hitCount = hitsMax; atk.turnData.hitsLeft = hitsMax - k; }
      return def.getAttackDamage({ source: atk, move, ignoreAbility, ignoreSourceAbility: false, ignoreAllyAbility, ignoreSourceAllyAbility: false, isCritical, simulated: true });
    };
    const first = call(0, false);
    const eGame = def.getMoveEffectiveness?.(atk, move, ignoreAbility, true);
    const e = first.cancelled ? 0 : typeof eGame === "number" ? eGame : RESULT_MULT[first.result] ?? 1;
    const base = { name: pm.getName(), type, cat, e, priority, spread, spreadApplied, ...traits(atk, move, true), self: 0 };
    if (first.cancelled || first.result === 7 || first.result === 13) {
      return { ...base, acc: 0, crit: 0, dist, perHit: [{ max: 0, min: 0 }], expected: 0, uncapped: 0, max: 0, pKo: 0, revive: 0, notes: ["no effect"] };
    }

    const ohko = first.result === 6;
    const fixed = !ohko && attrs(move, "FixedDamageAttr").length > 0;
    const psywave = attrs(move, "RandomLevelDamageAttr").length > 0;
    const present = attrs(move, "PresentPowerAttr").length > 0;
    const crit = opts.crit === true ? 1 : opts.crit === false || fixed || ohko ? 0 : (() => {
      if (!ignoreAbility && ability(def, "BlockCritAbAttr")) return 0;
      const side = def.isPlayer?.() ? 1 : 2;
      if ((s.arena?.tags ?? []).some(t => t.constructor.name === "NoCritTag" && (!t.side || t.side === side))) return 0;
      if (attrs(move, "CritOnlyAttr").length || atk.getTag?.("ALWAYS_CRIT") || (ability(atk, "ConditionalCritAbAttr") && [1, 2].includes(def.status?.effect))) return 1;
      return [1 / 24, 1 / 8, 1 / 2, 1][Math.max(0, Math.min(3, def.getCritStage?.(atk, move) ?? 0))];
    })();

    // Damage outcomes per hit index: Map damage → probability, plus the non-crit max roll for the worst case.
    const maxes = [];
    const perHit = [];
    for (let k = 0; k < hitsMax; k++) {
      const m = new Map();
      if (ohko) {
        const blocked = !ignoreAbility && ability(def, "BlockOneHitKOAbAttr");
        maxes.push(blocked ? 0 : def.hp);
        m.set(maxes[k], 1);
      } else if (psywave) {
        for (let r = 50; r <= 150; r++) { const d = Math.max(1, Math.floor(atk.level * r / 100)); m.set(d, (m.get(d) ?? 0) + 1 / 101); }
        maxes.push(Math.floor(atk.level * 1.5));
      } else if (fixed) {
        maxes.push(k ? call(k, false).damage : first.damage);
        m.set(maxes[k], 1);
      } else {
        let top = 0;
        for (const [seed, pv] of present ? PRESENT : [[null, 1]]) {
          const run = isCritical => (seed === null ? (k || isCritical ? call(k, isCritical) : first) : withSeed(seed, () => call(k, isCritical))).damage;
          if (crit < 1) { const d = run(false); top = Math.max(top, d); addRolls(m, d, pv * (1 - crit)); }
          if (crit > 0) { const d = run(true); if (crit === 1) top = Math.max(top, d); addRolls(m, d, pv * crit); }
        }
        if (present) m.set(0, (m.get(0) ?? 0) + 0.2);
        maxes.push(top);
      }
      perHit.push(m);
    }
    // Disguise / Ice Face take the first hit (the simulated call doesn't zero it).
    const disguise = !ignoreAbility && !!def.getAbility?.()?.getAttrs?.("FormBlockDamageAbAttr")?.some(a => a.formIndex === def.formIndex);
    if (disguise) { perHit[0] = new Map([[0, 1]]); maxes[0] = 0; }

    // Accuracy (§5): P(hit) = min(ceil(acc × multiplier), 100) %; later hits only roll for CHECK_ALL_HITS moves.
    const acc = (() => {
      if (move.moveTarget === 0) return 1;
      if (ability(atk, "AlwaysHitAbAttr") || ability(def, "AlwaysHitAbAttr") || atk.getTag?.("IGNORE_ACCURACY")
        || def.getTag?.("ALWAYS_GET_HIT") || (def.getTag?.("TELEKINESIS") && !ohko)) return 1;
      const w = typeof move.calculateBattleAccuracy === "function" ? move.calculateBattleAccuracy(atk, def, true) : move.accuracy;
      if (w === -1 || w == null) return 1;
      const mult = atk.getAccuracyMultiplier?.(def, move) ?? 1;
      return Math.max(0, Math.min(100, Math.ceil(w * mult - 1e-9))) / 100;
    })();
    const checkAll = hasFlag(move, 65536) && !skillLink;

    const f = targetFacts(s, def, ignoreAbility);
    const ends = resolve(f, perHit, dist, acc, checkAll, ohko);
    const expected = f.hp - ends.reduce((t, x) => t + x.p * Math.max(0, x.hp), 0);
    const pKo = f.revive ? 0 : ends.filter(x => x.hp <= 0).reduce((t, x) => t + x.p, 0);
    // Expected damage per use before the target's HP or a boss bar's boundary cuts it: what later turns deal.
    const uncapped = perHit.reduce((t, m, k) => t + (k === 0 || checkAll ? acc ** (k + 1) : acc)
      * dist.filter(x => x.n > k).reduce((u, x) => u + x.p, 0) * [...m].reduce((u, [d, p]) => u + d * p, 0), 0);
    const [worst] = resolve({ ...f, pFocus: 0, pEndure: 0 }, maxes.map(d => new Map([[d, 1]])), [{ n: hitsMax, p: 1 }], 1, false, ohko);

    // A target mid-Dig / Fly / Dive / Shadow Force is only hit if it moves first and comes out (spec §5), unless the
    // move reaches it there (Earthquake into Dig) or accuracy is bypassed. The planner knows the order.
    const semiTag = (def.summonData?.tags ?? []).find(t => isA(t, "SemiInvulnerableTag"));
    const semi = !!semiTag && move.moveTarget !== 0 && !(ability(atk, "AlwaysHitAbAttr") || ability(def, "AlwaysHitAbAttr")
      || atk.getTag?.("IGNORE_ACCURACY") || attrs(move, "HitsTagAttr").some(h => h.tagType === semiTag.tagType));
    const notes = [];

    // What the move costs its user per use: the target's contact-chip ability (Rough Skin / Iron Barbs, 1/8 max HP)
    // for each landed contact hit, and recoil (a share of the damage dealt, or of max HP). Magic Guard blocks both,
    // Rock Head the recoil. Hits are counted as if the target doesn't faint before the last one.
    const maxHp = atk.getMaxHp?.() ?? 0;
    const guard = ability(atk, "BlockNonDirectDamageAbAttr");
    let self = 0;
    const landed = checkAll
      ? Array.from({ length: hitsMax }, (_, k) => acc ** (k + 1) * dist.filter(x => x.n > k).reduce((t, x) => t + x.p, 0)).reduce((t, x) => t + x, 0)
      : acc * dist.reduce((t, x) => t + x.n * x.p, 0);
    const contact = typeof move.doesFlagEffectApply === "function" ? move.doesFlagEffectApply({ flag: 1, user: atk, target: def }) : hasFlag(move, 1);
    if (contact && !guard && maxHp && ability(def, "PostDefendContactDamageAbAttr")) {
      const [abName, ratio] = [def.getAbility?.(), def.hasPassive?.() ? def.getPassiveAbility?.() : null]
        .flatMap(a => (a?.getAttrs?.("PostDefendContactDamageAbAttr") ?? []).map(x => [a.name, x.damageRatio])).find(Boolean) ?? ["contact", 8];
      const chip = Math.max(1, Math.floor(maxHp / (ratio || 8))) * landed;
      self += chip;
      notes.push(`${abName}: ${base.name} ≈−${Math.round(chip / maxHp * 100)}%`);
    }
    const pctOf = x => Math.round(x / maxHp * 100);
    const recoil = attrs(move, "RecoilAttr")[0];
    if (recoil && maxHp && !(!recoil.unblockable && (guard || ability(atk, "BlockRecoilDamageAttr")))) {
      const hurt = recoil.useHp ? Math.max(1, Math.floor(maxHp * recoil.damageRatio)) * acc : expected * (recoil.damageRatio ?? 0.25);
      self += hurt;
      notes.push(`recoil ≈−${pctOf(hurt)}%`);
    }
    // Steel Beam / Mind Blown cost half max HP, hit or miss; High Jump Kick-type moves crash for half on a miss
    // (Outrage's miss effect only ends its lock). Magic Guard blocks all three.
    if (maxHp && !guard && attrs(move, "HalfSacrificialAttr").length) {
      self += Math.max(1, Math.floor(maxHp / 2));
      notes.push(`${base.name}: −50% HP`);
    }
    if (maxHp && !guard && acc < 1 && attrs(move, "MissEffectAttr").length && !attrs(move, "FrenzyAttr").length) {
      self += Math.max(1, Math.floor(maxHp / 2)) * (1 - acc);
      notes.push(`${base.name}: crash −50% on a miss`);
    }
    // Explosion / Self-Destruct faint the user regardless; Final Gambit only when it hits.
    const selfKo = attrs(move, "SacrificialAttrOnHit").length ? acc : attrs(move, "SacrificialAttr").length ? 1 : 0;
    if (selfKo) notes.push(`${base.name}: user faints`);
    // Outrage / Thrash / Petal Dance / Raging Fury: locked in for 2–3 turns, then confused.
    const lock = attrs(move, "FrenzyAttr").length > 0;
    if (lock) notes.push(`${base.name}: locks 2–3 turns → confused`);
    // Gigaton Hammer / Blood Moon can't be selected twice in a row.
    const noRepeat = (move.restrictions ?? []).some(r => r.i18nkey === "battle:moveDisabledConsecutive");
    if (noRepeat) notes.push(`${base.name}: not twice in a row`);
    // Guaranteed drops to the user's own stats (Overheat −2 SpA, Close Combat −1 Def/SpD): { stat index: stages }.
    const drops = {};
    for (const a of attrs(move, "StatStageChangeAttr")) {
      if (!a.selfTarget || !(a.stages < 0) || (move.chance > 0 && move.chance < 100)) continue;
      for (const st of a.stats ?? []) drops[st] = (drops[st] ?? 0) + a.stages;
    }
    const dropText = Object.entries(drops).map(([st, n]) => `−${-n} ${STAT_NAMES[st] ?? st}`);
    if (dropText.length) notes.push(`${base.name}: ${dropText.join(" ")}`);

    if (dist.length > 1) notes.push(`${dist[0].n}–${hitsMax} hits`);
    else if (hitsMax > 1) notes.push(`${hitsMax} hits`);
    if (f.boss && f.idx > 0) notes.push(`boss ${f.idx + 1} bars`);
    if (f.sturdy && f.hp >= f.maxHp) notes.push("sturdy");
    if (f.pFocus) notes.push("focus band");
    if (f.revive) notes.push("reviver seed");
    if (disguise) notes.push("disguise");
    if (crit === 1) notes.push("crit");
    if (base.charge) notes.push("charges a turn");
    if (base.recharge) notes.push("recharges a turn");
    if (base.interrupt) notes.push("fails if hit");
    if (semi) notes.push("target semi-invulnerable");
    return {
      ...base, acc, crit, dist, semi, self, selfKo, lock, noRepeat, drops,
      perHit: maxes.map(max => ({ max, min: Math.floor(max * 0.85) })),
      expected, uncapped, max: f.hp - Math.max(0, worst.hp), pKo, revive: f.revive, notes,
    };
  };

  // ---- Approximation, for when game calls aren't allowed
  const ATE = { Refrigerate: "Ice", Pixilate: "Fairy", Aerilate: "Flying", Galvanize: "Electric" };
  // Rough max-roll damage of one move, or null when it isn't a damaging move with power.
  const approx = (a, d, pm) => {
    const mv = pm.getMove();
    if (mv.category === 2 || !(mv.power > 0) || pm.getMovePp() - pm.ppUsed <= 0) return null;
    const ab = abilitiesOf(a);
    let type = TYPES[mv.type];
    let power = mv.power;
    const ate = ab.map(x => ATE[x]).find(Boolean);
    if (ate && type === "Normal") { type = ate; power *= 1.2; }
    if (ab.includes("Technician") && power <= 60) power *= 1.5;
    const phys = mv.category === 0;
    let atk = stat(a, phys ? 1 : 3);
    if (phys && (ab.includes("Huge Power") || ab.includes("Pure Power"))) atk *= 2;
    if (phys && ab.includes("Hustle")) atk *= 1.5;
    const base = ((2 * a.level / 5 + 2) * power * atk / stat(d, phys ? 2 : 4)) / 50 + 2;
    const e = effectiveness(type, d);
    const stab = typesOf(a).includes(type) ? (ab.includes("Adaptability") ? 2 : 1.5) : 1;
    let dmg = base * stab * e;
    if (phys && ab.includes("Tough Claws")) dmg *= 1.3; // most physical moves make contact
    if (ab.includes("Sheer Force")) dmg *= 1.3;
    if (ab.includes("Strong Jaw") && /bite|crunch|fang|jaw/i.test(pm.getName())) dmg *= 1.5;
    return { name: pm.getName(), type, cat: phys ? "physical" : "special", e, dmg, spread: SPREAD_TARGETS.includes(mv.moveTarget), priority: mv.priority ?? 0 };
  };
  const fromApprox = (s, atk, def, pm) => {
    const x = approx(atk, def, pm);
    if (!x) return null;
    const mv = pm.getMove();
    const acc = mv.accuracy > 0 ? mv.accuracy / 100 : 1;
    const max = Math.floor(x.dmg);
    const end = applyHits(def, [max], { s });
    const revive = targetFacts(s, def).revive;
    return {
      name: x.name, type: x.type, cat: x.cat, e: x.e, priority: x.priority, spread: x.spread, spreadApplied: false, ...traits(atk, mv, false), semi: false, self: 0,
      acc, crit: 0, dist: [{ n: 1, p: 1 }], perHit: [{ max, min: Math.floor(max * 0.85) }],
      expected: Math.min(def.hp - end.hp, max * 0.925) * acc, uncapped: max * 0.925 * acc, max: def.hp - end.hp, pKo: end.ko && !revive ? acc : 0, revive, notes: ["estimate"],
    };
  };

  // ---- Public
  // One sandbox per outermost call (a caller's own sandbox or moveOutcomes covers the calls inside it); the
  // per-turn cache keeps repeated planner queries free.
  let depth = 0;
  const guarded = (s, fn) => {
    if (depth) return fn();
    depth++;
    try { return sandbox(s, fn); } finally { depth--; }
  };
  const moveOutcome = (s, atk, def, pm, opts = {}) => {
    if (!gameReady(s, atk, def)) return fromApprox(s, atk, def, pm);
    const turn = turnKey(s);
    if (cache.key !== turn) cache = { key: turn, map: new Map() };
    // A predicted Tera is set and taken back off around parts of a refresh (20-enemy-ai), and it changes types,
    // STAB and Tera Blast's type: both sides' flags belong in the key.
    const key = [atk.id, atk.hp, def.id, def.hp, atk.moveset.indexOf(pm), pm.getMove().id, !!opts.aiView, opts.crit,
      !!atk.isTerastallized, !!def.isTerastallized].join("|");
    if (cache.map.has(key)) return cache.map.get(key);
    let out;
    try {
      out = guarded(s, () => fromGame(s, atk, def, pm, opts));
    } catch (e) {
      moveOutcome.lastError = e;
      return fromApprox(s, atk, def, pm);
    }
    cache.map.set(key, out);
    return out;
  };
  const moveOutcomes = (s, atk, def) => (gameReady(s, atk, def) ? guarded(s, () => usable(atk, def, s).map(pm => moveOutcome(s, atk, def, pm))) : usable(atk).map(pm => fromApprox(s, atk, def, pm))).filter(Boolean);

  // Per-move damage records for the planner and learn cards: `dmg` is the expected damage (discounted for moves
  // that may not land) for our moves, the max roll for a foe's. The game already applies the ¾ spread factor when
  // a spread move has two targets; the planner applies it itself, so it is taken back out here.
  const hits = (a, d, foe = false, s = sceneNow()) => {
    if (gameReady(s, a, d)) {
      // No sandbox here: moveOutcome opens one only on a cache miss, and the panel asks every second.
      return usable(a, d, s).map(pm => {
        const o = moveOutcome(s, a, d, pm);
        return o && { ...o, dmg: (foe ? o.max : o.expected * reliability(pm.getMove())) / (o.spreadApplied ? 0.75 : 1) };
      }).filter(Boolean);
    }
    const out = [];
    for (const pm of a.moveset.filter(Boolean)) {
      const x = approx(a, d, pm);
      if (x) out.push({ ...x, dmg: x.dmg * (foe ? FOE_MARGIN : reliability(pm.getMove())) });
    }
    return out;
  };

  return { moveOutcome, moveOutcomes, applyHits, endOfTurnHp, hits };
})();

const bestMove = (a, d, foe = false) => hits(a, d, foe).reduce((best, x) => (!best || x.dmg > best.dmg ? x : best), null);
// `heal`: turn-end HP change. A heal (+) comes only on turns the target survives the hit; chip (−) lands every turn,
// the KO turn included.
const turnsToKo = (hp, dmg, heal = 0) => {
  if (heal < 0) return Math.min(9, Math.ceil(hp / (Math.max(0, dmg) - heal)));
  return !(dmg > 0) ? 9 : hp <= dmg ? Math.ceil(hp / dmg) : dmg > heal ? Math.min(9, Math.ceil((hp - heal) / (dmg - heal))) : 9;
};

// Positive score = we KO it in fewer turns than it KOs us.
const matchup = (me, foe) => {
  const mine = bestMove(me, foe);
  const theirs = bestMove(foe, me, true);
  const myTurns = mine?.dmg > 0 ? Math.min(9, Math.ceil(foe.hp / mine.dmg)) : 9;
  const theirTurns = theirs?.dmg > 0 ? Math.min(9, Math.ceil(me.hp / theirs.dmg)) : 9;
  const faster = stat(me, 5) >= stat(foe, 5);
  return { me, mine, myTurns, score: theirTurns - myTurns + (faster ? 0.5 : -0.5) };
};
