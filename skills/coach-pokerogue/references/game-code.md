# PokéRogue game-code spec for the coach HUD (damage, enemy AI, turn order)

Source: live build `https://pokerogue.net/assets/loading-scene-BqCzRPcm.js` (Pokemon, Move, attrs, modifiers,
AI) and `battle-scene-BmkpVc5x.js` (phases, BattleScene). Minified identifiers differ between the two bundles
(`T` in loading-scene = `B` in battle-scene = the BattleScene). Class names survive minification
(`x.constructor.name`, `move.hasAttr("MultiHitAttr")`, `attr.is("…")` all work). Local copies for grepping:
fetched game bundles (not committed).

Live state caveat: by the time the source was read, `s.currentBattle` was `undefined` (the wave-115 battle had
ended), so **no game function was called live**; everything below is from reading source. The only live reads
were prototype method lists and `Phaser.Math.RND.state()` (confirmed: returns a `"!rnd,…"` string).

Enum values used below (confirmed from switch statements in source):
- MoveCategory: 0 PHYSICAL, 1 SPECIAL, 2 STATUS.
- MoveTarget: 0 USER, 1 OTHER, 2 ALL_OTHERS, 3 NEAR_OTHER, 4 ALL_NEAR_OTHERS, 5 NEAR_ENEMY, 6 ALL_NEAR_ENEMIES,
  7 RANDOM_NEAR_ENEMY, 8 ALL_ENEMIES, 9 ATTACKER, 10 NEAR_ALLY, 11 ALLY, 12 USER_OR_NEAR_ALLY, 13 USER_AND_ALLIES,
  14 ALL, 15 USER_SIDE, 16 ENEMY_SIDE, 17 BOTH_SIDES, 18 PARTY, 19 CURSE. Spread (`multiple`) = 2,4,6,8 (+14,17,13).
- HitResult (getAttackDamage `result`): 1 EFFECTIVE, 2 EXTREMELY (≥4×), 3 SUPER (≥2×), 4 NOT_VERY (≤½),
  5 MOSTLY_INEFFECTIVE (≤¼), 6 ONE_HIT_KO, 7 NO_EFFECT, 13 IMMUNE (Sheer Cold only).
- MultiHitType: 0 `_2`, 1 `_2_TO_5`, 2 `_3`, 3 `_10`, 4 `BEAT_UP`. MoveFlags 65536 = CHECK_ALL_HITS,
  32768 = IGNORE_ABILITIES. MovePriorityInBracket (`Nd`): 0 LAST, 1 NORMAL, 2 FIRST.
- aiType: 0 RANDOM, 1 SMART_RANDOM, 2 SMART. BerryType: 0 SITRUS, 1 LUM, 2 ENIGMA, 3 LIECHI, 4 GANLON,
  5 PETAYA, 6 APICOT, 7 SALAC, 8 LANSAT, 9 STARF, 10 LEPPA.

---

## 0. The side-effect landscape, and the `sandbox` every HUD call must use

`muted()` (current HUD) is **not sufficient**. Reading the call graphs of `getAttackDamage`, move scoring and
conditions shows four kinds of hidden effects even on the "simulated" paths:

1. **Ability application bookkeeping.** `applySingleAbAttrs` (the core of `applyAbAttrs`):
   ```
   let{simulated:i=!1,passive:a=!1,pokemon:o}=t; … e.showAbility&&!i&&(T.phaseManager.queueAbilityDisplay(o,a,!0),l=!0);
   let u=e.getTriggerMessage(t,s.name);u&&(i||T.phaseManager.queueMessage(u),r?.push(u)),e.apply(t),
   l&&T.phaseManager.queueAbilityDisplay(o,a,!1),i||(o.waveData.abilitiesApplied.add(s.id),o.summonData.abilitiesApplied.add(s.id))
   ```
   `simulated` defaults to **false**. Many internal call sites omit it: `hitsSubstitute` / `WeakenMoveScreenTag.apply`
   (`applyAbAttrs('InfiltratorAbAttr',{pokemon:e,bypassed:n})`), `getEffectiveWeatherForMove`
   (`PreAttackWeatherOverrideAbAttr`, Mega Sol), `getAccuracyMultiplier` (every call), `getCritStage`
   (`BonusCritAbAttr`), `OneHitKOAttr` condition (`BlockOneHitKOAbAttr`), `ForceSwitchOutAttr.getSwitchOutCondition`
   (`ForceSwitchOutImmunityAbAttr`, showAbility=true → queues display), explosion condition `Bd`
   (`FieldPreventExplosiveMovesAbAttr`, simulated only when current phase is EnemyCommandPhase → queues message),
   `canSetStatus` (`IgnoreTypeStatusEffectImmunityAbAttr`), berry predicates (`ReduceBerryUseThresholdAbAttr`).
   Effect: queued ability bars/messages (muted fixes) **and** `waveData/summonData.abilitiesApplied.add(id)` (muted
   does not fix; read by `getOncePerBattleCondition` and Battle Bond).
2. **Battle RNG** (`currentBattle.randSeedInt` advances `battleSeedState`):
   - `getMoveTargets(user, id)` for MoveTarget 7 (Outrage/Thrash/Petal Dance) with ≥2 opponents:
     `case 7:o=[a[e.randBattleSeedInt(a.length)]]` — reached from **getAttackDamage** and `canBeMultiStrikeEnhanced`.
   - `ProtectAttr.getCondition`: `r===0||e.randBattleSeedInt(3**r)===0` (consecutive protects) — reached from
     `move.applyConditions`.
   - `ShellSideArmCategoryAttr` tie: `a===o&&e.randBattleSeedInt(2)===0` — reached from getAttackDamage.
   - `RandomLevelDamageAttr` (Psywave): `e.randBattleSeedIntRange(50,150)` — reached from getAttackDamage.
   - `EnemyPokemon.getNextTargets` (always, when target weight sum > 1) and `getNextMove` (aiType 0/1/2 chains).
3. **Global Phaser RNG**: `PresentPowerAttr.apply` calls `randSeedInt` (`x(...)`, = `Phaser.Math.RND.integerInRange`)
   directly, and on the heal branch sets `e.turnData.hitCount=1,hitsLeft=1` and `unshiftNew('PokemonHealPhase')`.
   Reached from `calculateBattlePower` (getAttackDamage) and `AttackMove.getTargetBenefitScore`.
   `executeWithSeedOffset` (Magnitude, DoublePowerChanceAttr, `sortInSpeedOrder` shuffle) is OK: it saves and
   restores `RND.state()`, `rngOffset`, `rngSeedOverride` (no try/finally, but deterministic callbacks).
4. **turnData writes**: `FullHpResistTypeAbAttr.apply` (Tera Shell) does `t.turnData.moveEffectiveness=.5`
   **regardless of simulated**, and `getMoveEffectiveness` returns that cached value first
   (`if(this.turnData?.moveEffectiveness!=null)return this.turnData?.moveEffectiveness`). Multi-hit math needs the
   HUD itself to set `turnData.hitCount/hitsLeft` temporarily (§2).

Other benign writes: `RepeatMoveAttr` condition sets `this.movesetMove` on the shared attr (Instruct; overwritten on
real use); `EnemyPokemon.getNextMove` resets `summonData.moveQueue=[]`/`splice`s the queue (never call it).

**`sandbox(s, fn)` spec** (replace `muted` for every game call; it is synchronous, so restoring is exact):
- mute `phaseManager.{pushPhase,unshiftPhase,pushNew,unshiftNew,queueMessage,queueAbilityDisplay,hideAbilityBar,queueFaintPhase}`;
- save `Phaser.Math.RND.state()` (string), `s.currentBattle.battleSeedState` (string|null), `s.rngOffset`,
  `s.rngSeedOverride`;
- for every pokemon in `s.getPlayerParty()` and `s.getEnemyParty()`: `new Set(p.waveData.abilitiesApplied)`,
  `new Set(p.summonData.abilitiesApplied)`, and `{hitCount, hitsLeft, moveEffectiveness}` of `p.turnData`;
- `try { return fn() } finally { restore all of the above (RND via Phaser.Math.RND.state(saved)) }`.
- Dev assertion (optional, cheap): compare `RND.state()` and `battleSeedState` after restore.
Cost: ~12 Set copies + 3 strings per call; wrap a whole refresh (all damage + AI scoring) in **one** sandbox.

Even inside the sandbox, results from RNG-drawing code are random draws: special-case Present
(`hasAttr('PresentPowerAttr')`: power 40/80/120 at 40/30/10 %, 20 % heals target) and Psywave
(`RandomLevelDamageAttr`: level × U[0.50,1.50]) instead of trusting one call.

---

## 1. Damage — `Pokemon.getAttackDamage`

Signature (called on the **defender**):
```
getAttackDamage({source, move, ignoreAbility=false, ignoreSourceAbility=false, ignoreAllyAbility=false,
                 ignoreSourceAllyAbility=false, isCritical=false, simulated=true, effectiveness})
  → { cancelled: boolean, result: HitResult, damage: number }
```
Flow (quoted in order):
1. Category: `applyMoveAttrs('VariableMoveCategoryAttr',e,this,t,d)` (Photon Geyser, Shell Side Arm).
2. Effectiveness: `h=c??this.getMoveEffectiveness(e,t,n,s,m); if(m.value||h===0)return{cancelled:m.value,result:t.id===329?13:7,damage:0}`
   — includes type chart, Tar Shot, type-immunity abilities (Levitate/Flash Fire/…; their heal/boost/tag side
   effects are gated on `simulated`), Wonder Guard, Tera Shell, Dazzling-family (only when simulated), substitute
   for status moves. `ignoreAbility` skips defender abilities.
3. Fixed damage: `applyMoveAttrs('FixedDamageAttr',…)` → returns `{result:1, damage: N(fixed×MultiLensMult)}` (Seismic
   Toss, Super Fang, Psywave, Endeavor…). OHKO: `OneHitKOAttr` → `{result:6, damage:this.hp}` (no accuracy/level check here).
4. Base: `getBaseDamage` = `(2*L/5+2) * calculateBattlePower(src,def,sim) * Atk / Def / 50 + 2` where
   `Atk = src.getEffectiveStat(phys?1:3,{opponent,isCritical,simulated,…})` + `VariableAtkAttr` (Foul Play, Body Press),
   `Def = def.getEffectiveStat(phys?2:4,{…,forDefend:true})` + `VariableDefAttr` (Psyshock). getEffectiveStat
   covers: StatBoosterModifier items (Eviolite, Light Ball, Thick Club, Deep Sea items), stat-multiplier abilities
   (Huge Power, Hustle, Fur Coat, Marvel Scale, ally/field abilities), stages (crit ignores attacker drops /
   defender boosts; Unaware/Chip Away), X-item stage boosters (player only), Sandstorm SpD for Rock, Snow Def for Ice,
   Slow Start, paralysis/Tailwind (speed), Protosynthesis/Quark Drive tag.
5. `calculateBattlePower` (move): `VariablePowerAttr` (Knock Off, Facade, Gyro Ball, Low Kick, Acrobatics, Hex, Stored
   Power, Triple Axel increments, Magnitude …), `VariableMovePowerAbAttr` (Technician, Iron Fist, Sheer Force,
   -ate ×1.2, Tough Claws, Strong Jaw, Blaze-family ≤⅓ HP …), ally/field power abilities, Tera-60 floor, TypeBoostTag
   (Charge), Mud/Water Sport, **AttackTypeBoosterModifier**
   (`n.value=Math.floor(n.value*(1+this.getStackCount()*this.boostMultiplier))`, boostMultiplier 0.20/stack —
   Never-Melt Ice, Silk Scarf…; keyed on base type after `MoveTypeChangeAbAttr` only, **not** on `VariableMoveTypeAttr`
   — so Aura Wheel checks Electric boosters even in Hangry form), Helping Hand ×1.5, Supreme Overlord, terrain ×1.3
   (grounded user), Misty terrain halves Dragon vs grounded target.
6. Multipliers: `l.value=N(y*ee*te.value*b*C.value*w.value*E*D*h*ne*re.value*O.value)` where
   `ee` spread 0.75 (`getMoveTargets(...).targets.length>1`), `te` Multi-Lens per-hit factor, `b` weather
   (`getWeatherMultiplierForMove`: sun/rain 1.5/0.5), `C` 2 if `RECEIVE_DOUBLE_DAMAGE` tag, `w` crit 1.5
   (×Sniper via `MultCritAbAttr`), `E` random roll, `D` STAB (`calculateStabMultiplier`: +0.5 same type,
   Adaptability +0.5, Tera boosts, cap 2.25; STAB uses `getMoveType` so Hangry Aura Wheel is not STAB for Morpeko
   unless Dark), `h` effectiveness, `ne` burn 0.5 (physical, not Guts/Facade), `re` screens (skipped on crit;
   Infiltrator bypass; 1/2 singles, 2/3 doubles), `O` HitsTagAttr ×2 (Stomp on Minimize, Surf on Dive…).
   `N(x)=Math.max(Math.floor(x),1)`.
7. Post: `MoveDamageBoostAbAttr` (Parental Bond 2nd hit ×0.25, Punk Rock…), `EnemyDamageBoosterModifier`
   (attacker is enemy: `N(v*1.05**stack)`), `EnemyDamageReducerModifier` (defender is enemy: `N(v*0.975**stack)`),
   defender `ReceivedMoveDamageMultiplierAbAttr` (Multiscale, Fluffy, Ice Scales, Filter/Solid Rock/Prism Armor,
   Thick Fat? — type-based ones), ally Friend Guard, `ModifiedDamageAttr` (False Swipe), then
   `this.isFullHp()&&!n&&applyAbAttrs('PreDefendFullHpEndureAbAttr',ie)` (Sturdy: **only adds the STURDY tag when not
   simulated; damage is not reduced here**).

What `simulated:true` changes: `E=s?1:this.randBattleSeedIntRange(85,100)/100` → **max roll (1.00)**; no strong-winds
message; ability side effects (Flash Fire tag, Volt Absorb heal, Sturdy tag, Disguise/Ice Face) are skipped —
**`FormBlockDamageAbAttr.apply` only zeroes damage when `!simulated`**, so simulated damage ignores Disguise/Ice Face.
Crit is **not rolled** — it's the `isCritical` input. No items are consumed; berries never trigger here.
Not in getAttackDamage at all: Focus Band, Sturdy survival, enemy endure token, boss segments, berries, Life Orb /
Choice / Expert Belt / Focus Sash (these items **do not exist** in PokéRogue — confirmed from `modifier-type.json`
keys; the held items that matter are listed in §8).

Random roll: 16 integer values 85..100, uniform. There is no RNG-free call for the min roll. Use
`min ≈ floor(max × 0.85)` (error ≤ 2 HP because post-multipliers re-floor) — or scale linearly for a distribution.

Per hit: it computes **one hit**. Multi-hit power increments and Multi-Lens/Parental Bond factors read
`source.turnData.hitCount/hitsLeft`. At CommandPhase turnData is fresh (`TurnInitPhase` calls `resetTurnData()`:
`hitCount=0; hitsLeft=-1; moveEffectiveness=null`), which yields hit-1 power for Triple Axel, and — a game quirk —
**×0.25 for any Multi-Lens holder** (`applyDamageModifier`: `hitsLeft===hitCount`? no → `hitCount-hitsLeft===stack+1`? no
→ `t.value*=.25`). The enemy AI's own KO check inherits that quirk. Set turnData explicitly (§2).

Crit: `getCriticalHitResult` rolls (`T.randBattleSeedInt(i)===0`) → **unsafe**. Use instead:
`def.getCritStage(atk, move)` (HighCritAttr, Scope Lens/Leek `CritBoosterModifier`, Dire Hit, Super Luck, Focus Energy
`CritBoostTag`) → chance `[1/24, 1/8, 1/2, 1][clamp(stage,0,3)]`; forced crit if `move.hasAttr('CritOnlyAttr')`,
`atk.getTag('ALWAYS_CRIT')`, or `ConditionalCritAbAttr` (Merciless vs poisoned); blocked by
`def.hasAbilityWithAttr('BlockCritAbAttr')` (Battle/Shell Armor) or arena `NoCritTag` (Lucky Chant, check
`s.arena.tags` by `constructor.name`).

**Recommended call**
```
sandbox(s, () => def.getAttackDamage({ source: atk, move, ignoreAbility: false, ignoreSourceAbility: false,
  ignoreAllyAbility: false, ignoreSourceAllyAbility: false, isCritical: crit, simulated: true }))
```
Safe? **only in sandbox** (Infiltrator/Mega Sol `abilitiesApplied`, RNG for MoveTarget 7 in doubles / Shell Side
Arm tie / Psywave / Present, Tera Shell `turnData.moveEffectiveness`). No phases are queued on this path when
simulated (all non-simulated ability calls on it are `showAbility:false` attrs), but mute anyway.
Cost: ~0.05–0.2 ms (dozens of attr/ability loops). 6 party × 4 moves × 2 foes × both directions × ≤3 hits ≈ 300
calls → cache per `(wave, turn, field ids+hp, stat stages)` key; recompute only when it changes.

Also safe in sandbox, useful standalone: `atk.getMoveType(move)` (effective type, §4),
`def.getMoveEffectiveness(atk, move, ignoreAbility, true)`, `move.calculateBattlePower(atk, def, true)`,
`atk.getEffectiveStat(stat, {opponent: def, simulated: true})` (this one is pure even unsandboxed).

---

## 2. Multi-hit

`MultiHitAttr` (constructor arg = intrinsic type; apply decides hit count at the first MoveEffectPhase):
```
getHitCount(e,t){switch(this.multiHitType){case 1:{let t=new M(e.randBattleSeedInt(20));
  applyAbAttrs(`MaxMultiHitAbAttr`,{pokemon:e,hits:t});return t.value>=13?2:t.value>=6?3:t.value>=3?4:5}
 case 0:return 2;case 2:return 3;case 3:return 10;
 case 4:return(party).reduce((t,n)=>t+(n.id===e.id?1:n?.status&&n.status.effect!==0?0:1),0)}}
```
- `_2_TO_5` (1): P(2)=7/20, P(3)=7/20, P(4)=3/20, P(5)=3/20 → mean 3.1. Skill Link (`MaxMultiHitAbAttr` sets roll 0) → 5.
  No Loaded Dice in the game.
- `_2` (0): Double Kick, Dual Wingbeat… `_3` (2): **Triple Axel (id 813: power 20, acc 90,
  `.attr(MultiHitAttr,2).attr(MultiHitPowerIncrementAttr,3).checkAllHits()`)**, Triple Kick (167). `_10` (3):
  Population Bomb (860, checkAllHits). `BEAT_UP` (4): party members without status.
- Type override: `ChangeMultiHitTypeAttr` (only Water Shuriken for Ash-Greninja → `_3`).
- MoveEffectPhase first hit: `qt('MultiHitAttr',…,m)`, then `AddSecondStrikeAbAttr` (Parental Bond +1 if
  `move.canBeMultiStrikeEnhanced(user,true,target)`), then `B.applyModifiers(PokemonMultiHitModifier,…,m)`
  (Multi-Lens +stack if `canBeMultiStrikeEnhanced`), then `turnData.hitCount=hitsLeft=m`.
- `MultiHitPowerIncrementAttr(maxHits)`: `i=e.turnData.hitCount-Math.max(e.turnData.hitsLeft,0); power=n.power*(1+i%this.maxHits)`
  → Triple Axel 20/40/60 on hits 1/2/3 (hitsLeft is decremented in `MoveEffectPhase.end`).
- Per-hit factors: Multi-Lens hit 1 `×(1-0.25·stack)`, extra lens hits ×0.25; Parental Bond 2nd hit ×0.25
  (`MoveDamageBoostAbAttr,.25,(e,t,n)=>e.turnData.hitCount>1&&e.turnData.hitsLeft===1&&…`).
- Accuracy per hit (`hitCheck`): `if(t.turnData.hitsLeft<t.turnData.hitCount&&(!m.hasFlag(65536)||t.hasAbilityWithAttr('MaxMultiHitAbAttr')))return[HIT]`
  → later hits auto-hit unless CHECK_ALL_HITS (and no Skill Link). A miss on a later hit sets `hitCount=hitsLeft=1`
  and the move stops. Hits stop early when the target faints.
- `move.calculateEffectivePower()` does account for multi-hit (`MultiHitPowerIncrementAttr`: `47.07*(power/10)`
  magic; else `calculateExpectedHitCount(...)*power`) but it is an AI heuristic (base power × expected hits ×
  accuracy, divided for charge/recharge) — **not** usable as damage.
- `mh.calculateExpectedHitCount(move,{ignoreAcc,maxMultiHit,partySize,accMultiplier})` is pure (no RNG), but
  its accuracy term is buggy (`Math.min(e.accuracy/100*i,100)` caps at 100 not 1). Don't use for accuracy.

**RNG-free exact multi-hit damage with game code** (inside one sandbox):
```
const mh = move.getAttrs('MultiHitAttr')[0];
type = mh ? mh.intrinsicMultiHitType : null   // or 2 for Water Shuriken Ash-Greninja
counts = type==null ? [{n:1,p:1}] : type===1 ? (skillLink ? [{n:5,p:1}] : [{n:2,p:.35},{n:3,p:.35},{n:4,p:.15},{n:5,p:.15}])
       : [{n: [2,_,3,10,beatUp][type], p:1}]
extra = (atk.hasAbilityWithAttr('AddSecondStrikeAbAttr') && move.canBeMultiStrikeEnhanced(atk,true,def) ? 1 : 0)
      + (move.canBeMultiStrikeEnhanced(atk) ? multiLensStack : 0)      // multiLensStack: held item constructor.name==='PokemonMultiHitModifier'
for each count H (= n + extra): for k in 0..H-1:
   atk.turnData.hitCount = H; atk.turnData.hitsLeft = H - k;      // restored by sandbox
   perHit[k] = def.getAttackDamage({source: atk, move, simulated: true, isCritical}).damage
```
Expected damage of a CHECK_ALL_HITS move with per-hit hit chance `a`: `Σ_k a^(k+1) · perHit[k]` (stop at first miss);
otherwise `a · Σ_k perHit[k]`. Apply per-hit HP/segment logic (§3) — don't sum first when the target is a boss.

---

## 3. Boss segments

`EnemyPokemon.damage(e, ignoreSegments=false, preventEndure=false, ignoreFaintPhase=false)`:
```
let i=this.getMaxHp()/this.bossSegments,a=this.isBoss()?this.bossSegmentIndex+1:0;
this.isBoss()&&!t&&([e,a]=calculateBossSegmentDamage(e,this.hp,i,this.getMinimumSegmentIndex(),this.bossSegmentIndex)),
T.currentBattle.isClassicFinalBoss&&this.formIndex===0&&this.bossSegmentIndex<1&&(e=Math.min(e,this.hp-1));
let o=super.damage(e,t,n,r); … a<=this.bossSegmentIndex&&this.handleBossSegmentCleared(a)
```
Module-private (re-implement verbatim; pure):
```
function calculateBossSegmentDamage(dmg, hp, segSize, minIdx = 0, idx) {
  const a = idx ?? Math.ceil(hp / segSize) - 1;
  if (a <= 0) return [dmg, 1];
  const floorHp = segSize * a;                       // HP at the bottom of the current segment
  const excess = dmg - (hp - Math.round(floorHp));
  if (excess < 0) return [dmg, a + 1];               // stays inside the segment
  if (excess === 0) return [dmg, a];                 // exactly clears it
  const c = Math.min(Math.max(Math.floor(Math.log2(excess / segSize)), 0), a - minIdx);
  return [Math.max(Math.floor(hp - floorHp + segSize * c), 1), a - c];
}
```
`minIdx = currentBattle.isClassicFinalBoss && !formIndex ? 1 : 0`. `ignoreSegments` is true only for OHKO results
(`ignoreSegments:C` with `C=y===6`). Segment size `maxHp / bossSegments`; `isBoss() = !!bossSegments`.

So one hit deals at most `hp − segSize·idx` (down to the current boundary) unless the overflow past that boundary is
≥ `2^c · segSize`, which breaks `c` further segments (capped at `idx − minIdx`). A 2-segment boss at full HP H is
one-shot only by a hit ≥ `H − round(H/2) + H` ≈ **1.5 × maxHp**; otherwise it stops at exactly H/2. Each hit of a
multi-hit move is clamped independently, so hit 2 continues from the new index.

Segment clears: `handleBossSegmentCleared` decrements `bossSegmentIndex`; **wild** bosses (`!hasTrainer()`) gain
+1 stage (weighted random stat; +2 on the last segment of ≥3-segment bosses) via `StatStageChangePhase`; trainer
bosses (Cyrus's mons) get nothing. Healing (berries, Leftovers) raises `hp` but never raises `bossSegmentIndex`,
so HP above the current boundary is just buffer before the next clamp.

Survival after segments (`Pokemon.damage`, only if `hp - dmg <= 0` and not indirect): `ENDURING` tag (Endure),
`STURDY` tag at full HP (set by the non-simulated damage calc), `ENDURE_TOKEN`; else Focus Band
(`SurviveDamageModifier`: `e.randBattleSeedInt(10)<this.getStackCount()` → 10 %/stack, max 5) → survive at 1 HP.
For enemies about to be KO'd, MoveEffectPhase first applies `EnemyEndureChanceModifier`
(`randBattleSeedInt(100) >= chance*stack` fails; chance 2 → 2 %/stack, once per wave via `waveData.endured`).

Berries do **not** trigger on hit: `BerryModifier` is only applied in `BerryPhase` (turn end), besides Bug Bite /
Pluck / Stuff Cheeks / Teatime. Thresholds (`getBerryPredicate`): Sitrus HP < 50 % → heal `N(maxHp/4)`;
Enigma if any `turnData.attacksReceived` this turn had result SUPER/EXTREMELY → heal `N(maxHp/4)`; both ×2 with
Ripen (`DoubleBerryEffectAbAttr`); pinch berries HP < 25 % (Gluttony threshold via `ReduceBerryUseThresholdAbAttr`).
Sitrus and Enigma are separate modifiers → both can fire in the same BerryPhase. Stacks: one consumed per trigger
(`consumed`), Sitrus/Lum/Enigma/Leppa max 2, others 3.

---

## 4. Move type / power overrides

`Pokemon.getMoveType(move, simulated=true)` (on the user):
```
let n=new M(e.type);applyMoveAttrs(`VariableMoveTypeAttr`,this,null,e,n),e.hasAttr(`CallMoveAttr`)||
applyAbAttrs(`MoveTypeChangeAbAttr`,{pokemon:this,move:e,simulated:t,moveType:n,opponent:this}), … ION_DELUGE, ELECTRIFIED
```
Covers `VariableMoveTypeAttr` subclasses: AuraWheelTypeAttr (`formIndex 1 → 16 Dark, else 12 Electric`),
FormChangeItemTypeAttr (Judgment/Multi-Attack/Techno Blast), RagingBull, IvyCudgel, WeatherBall, TerrainPulse,
HiddenPower, TeraBlast, TeraStarstorm, MatchUserType (Revelation Dance), CombinedPledge; and -ate / Normalize /
Liquid Voice (`MoveTypeChangeAbAttr`). Target is `null` → no target-dependent attrs.
Safe? **only in sandbox** (`WeatherBallTypeAttr` → `getEffectiveWeatherForMove` → non-simulated
`PreAttackWeatherOverrideAbAttr` bookkeeping; otherwise pure). Cost trivial.
Hunger Switch flips form at turn end (`PostTurnFormChangeAbAttr`), so Aura Wheel alternates Electric/Dark each turn;
the current `formIndex` is what the move uses this turn.

Variable power: `move.calculateBattlePower(atk, def, true)` → final power used by the damage formula (all items and
abilities in §1 step 5). Safe? **only in sandbox** (Present consumes global RNG; see §0). Knock Off, Facade, Gyro
Ball, Low Kick, Hex, Acrobatics, Brine, Stored Power, Assurance, Payback, Fishious Rend, Bolt Beak (the last few read
`turnCommands`/`turnData.order`, which are empty at CommandPhase → pessimistic "moves second" values) all scanned
free of side effects. `LastMoveDoublePowerAttr` reads `dynamicQueueManager.getLastTurnOrder()` (read-only).

Category: `atk.getMoveCategory(def, move)` (Photon Geyser / Shell Side Arm). Only safe in sandbox (Shell Side Arm tie).

---

## 5. Accuracy, priority, turn order

**Hit chance** (`MoveEffectPhase.hitCheck`, first hit):
```
if(m.moveTarget===0)return HIT; … semi-invulnerable (no bypass) → MISS; protect → PROTECTED; reflect;
C=e.getMoveEffectiveness(t,m,!1,!1,S); if(C===0) NO_EFFECT;
w=m.calculateBattleAccuracy(t,e);  (user t, target e)
if (later hit && (!CHECK_ALL_HITS || SkillLink)) HIT;
E=bypass||e.getTag('ALWAYS_GET_HIT')||e.getTag('TELEKINESIS')&&!OHKO; if(w===-1||E)return HIT;
O=t.getAccuracyMultiplier(e,this.move); return t.randBattleSeedInt(100)<w*O?HIT:MISS
```
bypass (`checkBypassAccAndInvuln`): `AlwaysHitAbAttr` on either side (No Guard), Toxic by Poison-type user,
Lock-On/Mind Reader `IGNORE_ACCURACY` on that target. So **P(hit) = min(ceil(w·O), 100) / 100** (w·O ≤ 0 → 0).
- `move.calculateBattleAccuracy(atk, def, true)` → integer accuracy or −1 (never misses). Includes
  `VariableAccuracyAttr` (Thunder/Hurricane weather, Blizzard snow, OHKO level formula), Wonder Skin (status moves
  → 50), **Wide Lens** (`PokemonMoveAccuracyBoosterModifier`: `t.value+=this.accuracyAmount*stack`, amount 5 → +5 per
  stack, additive, not on OHKO), fog ×0.9, Gravity ×1.67. Pass `true`: default `simulated=false`.
  Safe? only in sandbox (cheap).
- `atk.getAccuracyMultiplier(def, move)` → stage ratio `(3+min(acc−eva,6))/3` or `3/(3+min(eva−acc,6))` (Keen Eye /
  Unaware / Chip Away ignore stages; Foresight/Miracle Eye `ExposedTag` caps evasion at 0), × Compound Eyes / Victory
  Star / Hustle (`StatMultiplierAbAttr` on stat 6), ÷ Sand Veil / Snow Cloak / Tangled Feet (stat 7). X Accuracy stage
  boost (player). Safe? **only in sandbox** (every `applyAbAttrs` here omits `simulated` → `abilitiesApplied` writes;
  no display since all those attrs have `showAbility:false`).

**Priority**: `move.getPriority(pokemon, true)` = base + `IncrementMovePriorityAttr` (Grassy Glide) +
`ChangeMovePriorityAbAttr` (Prankster status +1, Gale Wings full-HP Flying +1, Triage heal +3). **Safe** (simulated,
pure attrs). Bracket: `move.getPriorityModifier(pokemon, true)` → 2 FIRST if `pokemon.getTag('BYPASS_SPEED')`,
0 LAST for Stall (`ChangeMovePriorityInBracketAbAttr`), else 1. **Safe.** Psychic Terrain cancels priority moves
into grounded targets (`arena.isMoveTerrainCancelled`); Prankster status moves fail vs Dark (in MovePhase).

**Turn order** (TurnStartPhase + MovePhasePriorityQueue):
1. Non-FIGHT commands first: `if(v?.command!==y?.command){if(v?.command===0)return 1;…}` → switches, balls, runs
   resolve before any move (switch-ins take the hit).
2. Before ordering, for each FIGHT command: `BypassSpeedChanceAbAttr` (Quick Draw, 30 %, attacking moves) and
   `BypassSpeedChanceModifier` (**Quick Claw: `e.randBattleSeedInt(10)<this.getStackCount()`** → 10 %/stack, max 3)
   add `BYPASS_SPEED`.
3. Each pop re-sorts (dynamic): `sortInSpeedOrder` = speed desc by `getEffectiveStat(5)` with ties shuffled by
   `executeWithSeedOffset(shuffle, turn*1000+len, waveSeed)` (deterministic per turn but not queryable), whole list
   reversed under `TRICK_ROOM`; then stable sort by `timingModifier`, then priority desc, then bracket desc.
No safe function returns the order before the turn (phases are only created in TurnStartPhase). Compute:
`key = [priority, bracket, trickRoom ? -speed : speed]`, `speed = p.getEffectiveStat(5)` (**safe unsandboxed**: all
ability applications on this path pass `simulated`; includes paralysis ½, Tailwind ×2, Unburden, stat items,
Swift Swim/Chlorophyll etc.). Ties → 50 %. Quick Claw → P(first in bracket) = 0.1·stack. Trick Room:
`s.arena.getTag('TRICK_ROOM')`.

---

## 6. Enemy AI move choice

Who decides what: `EnemyPokemon` constructor: `this.aiType=r||this.hasTrainer()?2:1` → **trainer mons and bosses
(wild or trainer) = SMART (2); wild non-boss = SMART_RANDOM (1)**. RANDOM (0) only via mystery-encounter data
(`t.aiType!=null&&(d.aiType=t.aiType)`). `trainer.config.isBoss` only affects the switch threshold (§7).
EnemyCommandPhase runs **after** the player's CommandPhase in the same turn (TurnInitPhase pushes Command then
EnemyCommand per field slot), so conditions that read `turnCommands` (Sucker Punch `Id`) see the player's choice.

`EnemyPokemon.getNextMove()` (verbatim logic):
1. **Move queue**: for each queued `{move,useMode}`: if virtual or its moveset entry `isUsable(this, ignorePP, true)` →
   drop entries before it, return it. Else `summonData.moveQueue=[]` (charging, Outrage/Rollout locks, Bide…).
2. `t = moveset.filter(m => m.isUsable(this,false,true)[0])` (PP, `(N)` unimplemented, restricting tags: Disable,
   Taunt, Torment, Throat Chop, Heal Block, Gorilla Tactics, Imprison; move restrictions like Stuff Cheeks).
   Empty → **Struggle** `{move:165, useMode:IGNORE_PP}`.
3. One usable move → it. **Encore**: `this.getTag(EncoreTag)` (tagType `'ENCORE'`) and encored move usable → it.
4. aiType 0: `t[randBattleSeedInt(t.length)]` → uniform.
5. aiType 1/2 — **KO filter**:
   ```
   e=t.filter(m=>{ t=m.getMove(); if(t.moveTarget===9)return!1;
     r=getMoveTargets(this,t.id).targets.map(i=>field[i]).filter(p=>this.isPlayer()!==p.isPlayer());
     crit=t.hasAttr('CritOnlyAttr')||!!this.getTag('ALWAYS_CRIT');
     return t.category!==2&&r.some(p=>!arena.isMoveWeatherCancelled(this,t)&&!arena.isMoveTerrainCancelled(this,[p.getBattlerIndex()],t)
       &&(t.applyConditions(this,p,-1)||[389,918,909].includes(t.id))
       &&p.getAttackDamage({source:this,move:t,ignoreAbility:!p.waveData.abilityRevealed,ignoreSourceAbility:!1,
          ignoreAllyAbility:!p.getAlly()?.waveData.abilityRevealed,ignoreSourceAllyAbility:!1,isCritical:crit,simulated:!0}).damage>=p.hp)});
   e.length>0&&(t=e)
   ```
   i.e. if any damaging move's **max-roll, non-crit, single-hit** damage (with our **unrevealed abilities ignored**)
   reaches a target's current HP, only those moves stay in the pool. (389 Sucker Punch, 909 Thunderclap, 918 Upper
   Hand bypass conditions.) Multi-hit counts one hit (hit-1 power); Multi-Lens holders get the ×0.25 quirk.
6. **Targets per move**: `r[moveId] = this.getNextTargets(moveId)` (RNG, see below).
7. **Score per move** = max over its targets (loop `break`s on target −1):
   ```
   n = move.getUserBenefitScore(this,p,move) + move.getTargetBenefitScore(this,p,move) * (p is foe ? -1 : 1)
   NaN → 0
   if ((name endsWith ' (N)' || !move.applyConditions(this,p,-1)) && ![389,918,909].includes(id)) n = -20
   else if (weatherCancelled || terrainCancelled) n = -20
   else if (move.is('AttackMove')) { eff = p.getMoveEffectiveness(this,move,!p.waveData.abilityRevealed,undefined,undefined,true);
      foe: n *= eff, if this.isOfType(move.type) n *= 1.5;  ally: if eff { n /= eff; STAB n /= 1.5 }   n ||= -20 }
   ```
   (`move.type` = **base type**; `-Infinity` if no targets, e.g. Counter.) Scoring pieces:
   - `Move.getUserBenefitScore` = Σ attrs' `getUserBenefitScore` + Σ conditions' (FirstMoveCondition: +10 or −20).
   - `Move.getTargetBenefitScore` = Σ attrs (self-target attrs scored against user, sign-flipped); +20/−20 if the
     target is being Commanded.
   - `AttackMove.getTargetBenefitScore` = `super − attackScore` where
     `attackScore = (eff−1)²·(eff<1?−2:2)` with `eff = target.getAttackTypeEffectiveness(this.type,{source,move})`,
     ×2 if user's other attack stat ≤ 0.75× the used one (×1.5 if ≤ 0.875), `+ floor(VariablePower(calculateEffectivePower())/5)`.
     Multiplied by −1 for foes → roughly `+ (eff−1)² stuff + power/5`.
   - Status/secondary attrs: `StatusEffectAttr` `floor(chance·−0.1)` (−10 for guaranteed) if `canSetStatus`;
     `StatStageChangeAttr`, `AddBattlerTagAttr` `floor(tagScore·chance/100)`, `HighCritAttr` +3, `CritOnlyAttr` +5,
     `MultiHitAttr` target −5, `TargetHalfHpDamageAttr`, heals, hazards, switch attrs, etc. — call them, don't
     re-implement.
8. Sort desc (stable; ties keep moveset order). Pick index `a` from 0:
   - SMART_RANDOM: `while(a<len-1 && randBattleSeedInt(8)>=5) a++` → advance prob **3/8** per step.
   - SMART: `while(a<len-1 && s[a+1]/s[a]>=0 && randBattleSeedInt(100)<Math.round(s[a+1]/s[a]*50)) a++`
     → advance prob `p_a = clamp(round(ratio·50), 0, 100)/100` when `ratio>=0` (NaN/negative → stop).
     Note both-negative scores give ratio > 1 → p = 1 (the AI slides to the *worse* negative move); `0` top score
     with `0` next → NaN → stop.

`getNextTargets(moveId)`: spread (`multiple`) → all targets. Single: candidates' `getTargetBenefitScore × (same
side ? 1 : −1)` sorted desc; if the lowest < 1, add `|lowest−1|` to all; drop everything from the first weight
< top/2; draw `randBattleSeedInt(sum)` over cumulative weights → **P(target i) ≈ wᵢ/Σw** (exact: integer
`floor(U·Σw)` against cumulative thresholds). Empty → `[-1]` for `CounterDamageAttr` else `[]`. Consumes RNG
even in singles when Σw > 1 → **never call it**; re-implement.

**RNG-free distribution (spec for `enemyMoveDistribution`)** — run inside one `sandbox`:
```
if (moveQueue.length) → queued move with p=1 (check isUsable like step 1)
pool = usable; if !pool.length → Struggle p=1; if pool.length===1 → p=1; if ENCORE tag & encored usable → p=1
if aiType===0 → uniform
koPool = step-5 filter (needs getMoveTargets; re-implement: foes = e.getOpponents() filtered by moveTarget ∈
  {1,2,3,4,5,6,7,8,14,16,17}; for 7 use all opponents) → if non-empty pool = koPool
targets[m] = singles or spread: deterministic list; doubles single-target: weight table per getNextTargets
enumerate target assignments (≤ 2^4 combos) with joint prob Π P(target);
  for each: scores via step 7; ProtectAttr moves with r consecutive successful protects: branch condition
  pass (p=1/3^r) vs fail (score −20);
  order = stable sort desc; P(index k) = Π_{j<k} p_j · (1 − p_k), p_last := 0
  (SMART p_j from ratio rule; SMART_RANDOM p_j = 3/8)
accumulate P(move, target) over combos.
```
Calls used, all **only in sandbox**: `pm.isUsable(e,false,true)`, `e.getTag('ENCORE')`, `move.applyConditions(e,p,-1)`
(Protect RNG, Damp message, OHKO/Suction Cups ability bookkeeping), `move.getUserBenefitScore(e,p,move)`,
`move.getTargetBenefitScore(e,p,move)` (Present RNG via VariablePowerAttr; Suction Cups display),
`p.getMoveEffectiveness(e,move,!p.waveData.abilityRevealed,undefined,undefined,true)` (Tera Shell write),
`s.arena.isMoveWeatherCancelled(e,move)`, `s.arena.isMoveTerrainCancelled(e,[idx],move)` (pure), and the KO-filter
`getAttackDamage` exactly as quoted (keep the AI's `ignoreAbility` flags — do **not** use our "true info" call).
Cost: ≤ 4 moves × ≤ 2 targets × ~5 calls; once per turn key.

---

## 7. Enemy switch logic (EnemyCommandPhase) — confirmation

```
if(t.double&&e.hasAbility(279)&&e.getAlly()?.getTag('COMMANDED'))this.skipTurn=!0;
if(m&&e.getMoveQueue().length===0){ let v=e.getOpponents(); if(!e.isTrapped()){
  y=m.getPartyMemberMatchupScores(e.trainerSlot,!0); if(y.length>0){ x=v.map(t=>e.getMatchupScore(t)); S=avg(x);
  C=m.getSortedPartyMemberMatchupScores(y); w=1-(t.enemySwitchCounter?.1**(1/t.enemySwitchCounter):0);
  if(C[0][1]*w>=S*(m.config.isBoss?2:3)){ cursor=m.getNextSummonIndex(e.trainerSlot,y);
    turnCommands[fieldIndex+2]={command:2,cursor,…}; t.enemySwitchCounter++; return this.end() }}}}
v=e.getNextMove(); this.shouldTera(e)&&(preTurnCommands[fieldIndex+2]={command:4});
turnCommands[…]={command:0,move:v,skip:this.skipTurn}; enemySwitchCounter=Math.max(counter-1,0)
```
The HUD's `predictSwitches` matches this rule. Gaps:
- **Doubles sequencing**: slot 0 is decided first and mutates `enemySwitchCounter` (+1 on switch, −1 floor 0 on move)
  before slot 1 is evaluated. Use `counter0 = counter`, `counter1 = counter0 + (slot0 switches ? 1 : -1 clamp 0)`.
- `getMatchupScore` uses `simulated:!1` for the second type → strong-winds `queueMessage`; also `isActive`/speed reads —
  keep it in the sandbox (muted already covers the message).
- `skipTurn` (Commander: Tatsugiri inside Dondozo; `mysteryEncounter.skipEnemyBattleTurns`) → no action; Commanded
  Dondozo is always trapped (`isTrapped`: `COMMANDED` source active → true).
- **Tera**: `trainer.shouldTera(e)` = `config.trainerAI.teraMode===1 && !e.isTerastallized &&
  config.trainerAI.instantTeras.includes(e.initialTeamIndex) && !enemyFaintsHistory.some(pokemon.id===e.id)` — pure,
  **safe unsandboxed**. TeraPhase runs at TurnStart before any move (`isTerastallized=true`, `summonData.addedType=null`),
  so this turn the enemy defends with `[getTeraType()]` and gets Tera STAB. To model with game code, set
  `e.isTerastallized=true` (and restore) inside the sandbox around damage calls into/out of it.
  The HUD does that for the whole refresh (`withPredictedTera` in 20-enemy-ai, applied in `model`), so every damage,
  threat and team-plan number is post-Tera. EnemyCommandPhase runs **before** TeraPhase, so the AI's own choices —
  `enemyMoveDistribution`, `predictSwitches` — are computed with the flag taken back off (`beforeTera`).
- Move-queue locked (charging, Outrage, Uproar, Bide, Rollout…) → never switches, repeats the queued move.

---

## 8. Held items and abilities that change KO math

| Effect | Where the game reads it | RNG? | HUD query |
|---|---|---|---|
| Never-Melt Ice & type boosters | `calculateBattlePower`: `Math.floor(power*(1+0.2*stack))` | no | inside getAttackDamage |
| Wide Lens | `calculateBattleAccuracy`: `+5*stack` accuracy | no | `move.calculateBattleAccuracy(atk,def,true)` (sandbox) |
| Multi-Lens | hit count +stack; hit 1 ×(1−.25·stack), extra hits ×.25 | no | set turnData (§2) |
| Scope Lens / Leek / Dire Hit | `getCritStage` | crit roll | `def.getCritStage(atk,move)` (sandbox) |
| Eviolite, Light Ball, Thick Club, Deep Sea items | `getEffectiveStat` (`StatBoosterModifier`) | no | inside getAttackDamage |
| Enemy damage booster/reducer (wave items) | end of getAttackDamage | no | inside getAttackDamage |
| Focus Band | `Pokemon.damage`: survive at 1 HP if `randBattleSeedInt(10)<stack` | 10 %/stack | `holderItems(p)` → P(survive lethal hit) |
| Enemy Endure Chance | MoveEffectPhase before damage (enemy only), once/wave | 2 %/stack | `s.enemyModifiers` `constructor.name==='EnemyEndureChanceModifier'`, `!p.waveData.endured` |
| Sturdy | `PreDefendFullHpEndureAbAttr` (non-simulated only) → `STURDY` tag → survive at 1 | no | `p.isFullHp() && p.getMaxHp()>1 && p.hasAbilityWithAttr('PreDefendFullHpEndureAbAttr')` unless attacker Mold Breaker (`ignoreAbility`) |
| Disguise / Ice Face | `FormBlockDamageAbAttr` (non-simulated only) → 0 damage, 1/8 recoil | no | `p.getAbility().getAttrs('FormBlockDamageAbAttr')` + `formIndex===attr.formIndex` |
| Multiscale / Shadow Shield / Tera Shell | ReceivedMoveDamageMultiplier / FullHpResistType | no | inside getAttackDamage (sandbox for Tera Shell) |
| Reviver Seed | `PokemonInstantReviveModifier` in FaintPhase → back at `toDmgValue(maxHp/2)`, summon data reset | no | held item constructor.name → outcome `pKo 0`, `revive` |
| Sitrus / Enigma | BerryPhase only (turn end): <50 % / hit super-effectively this turn → +25 % max HP (Ripen ×2) | no | held items + §3 |
| Lum | BerryPhase: status or confusion → cured at turn end | no | held item |
| Liechi/Ganlon/Petaya/Apicot/Salac | BerryPhase: <25 % (Gluttony 50 %) → +1 Atk/Def/SpA/SpD/Spe | no | held item |
| Starf | BerryPhase <25 %: +2 random stat (global RNG) | yes | expectation |
| Lansat | BerryPhase <25 %: `CRIT_BOOST` tag | no | |
| Quick Claw / Quick Draw | TurnStartPhase: `BYPASS_SPEED` → FIRST bracket | 10 %/stack; 30 % | held item / ability |
| King's Rock | `FlinchChanceModifier` after damaging hit (flinches only if the holder moved first) | 10 %/stack | held item |
| Leftovers / Shell Bell | TurnEndPhase heal 1/16·stack / MoveEffectPhase `toDmgValue(totalDamageDealt/8)·stack` | no | held item |
| Toxic / Flame Orb | `TurnStatusEffectModifier` at TurnEndPhase (`trySetStatus`, type immunities apply) | no | held item + `effect` |
| Boss bar break | `handleBossSegmentCleared`, wild bosses only: +1 to a stat below +6 picked weighted by `getStat(s,false)`; +2 for idx 0 when ≥3 bars, idx 1 when ≥5 | yes | expectation, on its defences (our hits) and its Atk/SpA (its hits) |
| Grip Claw | `ContactHeldItemTransferChanceModifier`, MoveEffectPhase after each hit of any attack move (no contact check): `randSeedFloat() <= 0.1·stack` → one stack of a random transferable item of the target | yes | expectation: steals per landed hit |
| Mini Black Hole | `TurnHeldItemTransferModifier`, TurnEndPhase after the heals, holder not fainted: `stack` steals from a random opponent, one stack of a random transferable item each | target pick | expectation: steals per turn |
| Sticky Hold | `BlockItemTheftAbAttr` on the victim: `tryTransferHeldItemModifier` cancels across sides | no | ability attr |
| Sleep / freeze / paralysis timing | `doSetStatus`: sleep `sleepTurnsRemaining` 2 (⅓) or 3 (⅔), freeze `freezeTurnsRemaining` 3. MovePhase `checkSleep` ticks the counter (Early Bird via `ReduceStatusEffectDurationAbAttr`), wakes at ≤0 → 1 or 2 attempts lost; `checkFreeze` ticks, thaws on `randBattleSeedInt(4)===0` or counter ≤0 → ¾, then 9/16 lost; paralysis `randBattleSeedInt(8)===0` → ⅛ lost, `getEffectiveStat` Speed `>>1` | yes | expectation |
| Enemy wave heal | `EnemyTurnHealModifier` at TurnEndPhase: `max(floor(maxHp/50)·stack, 1)` when not full | no | `s.enemyModifiers` |
| Enemy wave status | `EnemyAttackStatusEffectChanceModifier` after each hit of an enemy attack move, shuffled: 5 % (burn/poison) / 2.5 % ·stack (max 10) → `trySetStatus` (any status or immunity blocks; `canSetStatus(effect, quiet=true)` is pure); `EnemyStatusEffectHealChanceModifier` 2.5 %·stack cure at turn end | yes | `s.enemyModifiers` |
| Choice items, Life Orb, Expert Belt, Focus Sash, Loaded Dice | **not in the game** | — | drop from models |

Item lookup: `p.getHeldItems()` (player → `s.modifiers`, enemy → `s.enemyModifiers`); identify by
`m.constructor.name` (`BerryModifier` + `m.berryType`, `SurviveDamageModifier`, `AttackTypeBoosterModifier` +
`moveType`, `PokemonMoveAccuracyBoosterModifier`, `PokemonMultiHitModifier`, `BypassSpeedChanceModifier`,
`FlinchChanceModifier`, `PokemonInstantReviveModifier`) and `m.getStackCount()`. Pure reads.
Choice-like locks that do exist: Gorilla Tactics tag, Encore, Outrage-family move queue, Torment — all already
reflected by `isUsable` / move queue.

### Turn-end HP order

`WeatherEffectPhase` (sandstorm/hail `toDmgValue(maxHp/16)`, `ignoreSegments`; spared: Ground/Rock/Steel in sand,
Ice in hail, `SuppressWeatherEffectAbAttr` on the field, `BlockWeatherDamageAttr` for the weather, Magic Guard,
UNDERGROUND/UNDERWATER; then `PostWeatherLapse{Heal,Damage}AbAttr`: Rain Dish/Ice Body 1/16, Dry Skin ±1/8, Solar
Power −1/8) → `PostTurnStatusEffectPhase` (poison 1/8, toxic `maxHp·toxicTurnCount/16` after the counter ticks, burn
1/16 ×`ReduceBurnDamageAbAttr`; blocked by Magic Guard and `BlockStatusDamageAbAttr`) → BerryPhase → `TurnEndPhase`
(Leftovers, Grassy Terrain 1/16 if grounded, enemy wave heal and status cure, `PostTurnAbAttr`: Poison Heal 1/8,
then orbs). HUD: `endOfTurnHp`.

---

## Unsafe to call (never, even sandboxed, unless noted)

- `EnemyPokemon.getNextMove()`, `getNextTargets()` — RNG + moveQueue writes (sandbox would restore RNG but returns one sample; re-implement).
- `Pokemon.getCriticalHitResult` — battle RNG.
- `Pokemon.damage`, `damageAndUpdate`, `heal`, `EnemyPokemon.handleBossSegmentCleared` — mutate HP / unshift phases.
- `getAttackDamage({simulated:false})` — RNG roll, Sturdy tag, Disguise form change + recoil, strong-winds message.
- `move.calculateBattleAccuracy(a,d)` without the `true` argument; `move.calculateEffectivePower(pokemon)` with a
  pokemon (non-simulated `VariableMovePowerAbAttr`).
- `BerryModifier.shouldApply/apply`, `getBerryPredicate` — consumption / non-simulated ability calls.
- `BypassSpeedChanceModifier.apply`, `SurviveDamageModifier.apply`, `EnemyEndureChanceModifier.apply` — RNG + tags.
- `s.applyModifiers(...)` with RNG modifier classes; `s.applyShuffledModifiers`.
- Anything under `phaseManager.create(...)`, and phases' `start()`.
- Without the §0 sandbox: `getAttackDamage` (simulated), `getMoveType`, `getMoveEffectiveness`, `calculateBattlePower`,
  `applyConditions`, `get*BenefitScore`, `getAccuracyMultiplier`, `getCritStage`, `getMatchupScore`.
- Safe unsandboxed (pure reads): `getEffectiveStat(stat,{simulated:true,…})`, `move.getPriority(p,true)`,
  `move.getPriorityModifier(p,true)`, `trainer.shouldTera(e)`, `getHeldItems`, `getMoveQueue`, `getTag`, `isFullHp`,
  `hasAbilityWithAttr`, `getStatStage`, `isTrapped()` (default simulated), `getTypes`.

---

## Recommended API for the HUD

### Shared (01-core.js)
- `sandbox(s, fn)` — §0 (supersedes `muted`; keep `muted` as an alias). Returns `fn()`.
- `heldItems(p)` → `Map<constructorName, {stack, list}>` via `p.getHeldItems()`; helpers `berries(p)` → `[{type, stack}]`.
- `SKIP_RNG_MOVE = m => m.hasAttr('PresentPowerAttr') || m.hasAttr('RandomLevelDamageAttr')` — use modelled values.

### Damage (10-damage.js)
- `moveInfo(s, atk, def, pm)` → `{ move, type: atk.getMoveType(move), category: atk.getMoveCategory(def, move),
  power: move.calculateBattlePower(atk, def, true), priority: move.getPriority(atk, true),
  spread: [2,4,6,8].includes(move.moveTarget), acc: hitChance(...), critChance }`. Sandbox.
- `hitChance(atk, def, move, hitIndex=0)` → 0..1. Calls `move.calculateBattleAccuracy(atk, def, true)`,
  `atk.getAccuracyMultiplier(def, move)`, `hasAbilityWithAttr('AlwaysHitAbAttr')` both sides; later hits 1 unless
  `move.hasFlag(65536)` and no Skill Link. Sandbox.
- `critChance(atk, def, move)` → 0..1 from `def.getCritStage(atk, move)`, CritOnlyAttr / ALWAYS_CRIT / BlockCritAbAttr / Lucky Chant.
- `hitCounts(s, atk, def, move)` → `[{n, p}]` (§2; MultiHitAttr type, Skill Link, Parental Bond, Multi-Lens, Beat Up).
- `hitDamage(s, atk, def, move, { hit, hits, crit = false, aiView = false })` → `{ max, min, result, cancelled }`.
  Sets `atk.turnData.hitCount = hits; hitsLeft = hits - hit`, calls
  `def.getAttackDamage({ source: atk, move, isCritical: crit, simulated: true, ignoreAbility: aiView && !def.waveData.abilityRevealed, ignoreAllyAbility: aiView && !def.getAlly()?.waveData.abilityRevealed })`;
  `min = Math.floor(max * 0.85)`. Sandbox (turnData restored).
- `applyHits(target, hits[], { mold })` → `{ hp, segIdx, ko, survivedBy }` — per hit: Disguise first hit 0; boss clamp
  with verbatim `calculateBossSegmentDamage` (uses `target.getMaxHp()/bossSegments`, `bossSegmentIndex`, classic
  final-boss min index); Sturdy at full HP → hp-1; returns separately `pSurvive` from Focus Band (0.1·stack) and
  enemy endure (0.02·stack). No game calls (pure math on read fields).
- `moveOutcome(s, atk, def, pm)` → `{ type, cat, e: result→multiplier, perHit: [{max,min}], dist: [{n,p}], acc,
  expectedDamage, pKo, pKoCrit, name, priority, spread }` — combines the above; replaces `hits()`'s per-move record so
  30-planner keeps working (`dmg` = expectedDamage vs non-boss; for bosses use `applyHits`).
- `endOfTurnHp(p, { s, hp, tookSuperEffective, dealt })` → signed turn-end HP change in the order above: weather and
  status chip (orbs counted as already on), berries (Sitrus <50 %, Enigma on SE hit, Ripen), Leftovers, Grassy
  Terrain, enemy wave heal, weather/Poison Heal abilities, Shell Bell from `dealt`.

### Enemy AI (20-enemy-ai.js)
- `aiTargets(s, e, move)` → `[{battlerIndex, p}]` — re-implementation of getMoveTargets (opponent side) + getNextTargets
  weighting using `move.getTargetBenefitScore(e, p, move)`. Sandbox.
- `aiKoPool(s, e, usable)` → moves passing the step-5 filter, with the AI's own `ignoreAbility` flags.
- `aiMoveScore(s, e, pm, targetIdx)` → number, exactly step 7 (`getUserBenefitScore`, `getTargetBenefitScore`,
  `applyConditions(e,p,-1)`, weather/terrain cancel, `getMoveEffectiveness(…,true)` ×, STAB via `e.isOfType(move.type)`).
- `enemyMoveDistribution(s, e)` → `[{ pm, move, targets: [{battlerIndex, p}], p, score }]` (§6 algorithm; queue /
  Struggle / Encore / aiType 0,1,2; Protect branch). Cache per turn key.
- `predictSwitches(s, b, active)` — keep, run in `sandbox`, fix doubles counter sequencing, skip Commander `skipTurn`.
- `enemyAction(s, e)` → `{ kind: 'switch', to } | { kind: 'move', dist, tera: tr?.shouldTera(e) ?? false }`.
- `predictedTeras(s, b)` → the active foes whose action this turn Terastallizes; `withPredictedTera(mons, fn)` runs
  `fn` with `isTerastallized` set (and `summonData.addedType` cleared) on them, `beforeTera(fn)` takes it back off,
  `teraTypeOf(e)` names the type for the panel.

### Planner (30-planner.js)
- `actionOrder(s, a, aMove, b, bMove)` → `P(a acts before b)`: switches first; else compare
  `move.getPriority(p,true)`, `move.getPriorityModifier(p,true)`, Quick Claw (0.1·stack) / Quick Draw (0.3, attacking)
  → FIRST, `p.getEffectiveStat(5)` (reversed under `s.arena.getTag('TRICK_ROOM')`), tie 0.5.
- `threatFrom(s, foe, me)` → Σ over `enemyMoveDistribution` of `p × moveOutcome(foe, me, …)`; exposes worst-case
  (`max` roll + crit) for the "ko" flag and expected for scoring. Replaces `hits(f, me, true)` + `FOE_MARGIN`.
- `turnsToKo(s, atk, def, pm, { firstHitAlreadyTaken })` → expected turns using `applyHits` per turn plus
  `endOfTurnHp` between turns and boss segment state carried over; cap 9.
- `exchange(s, me, myPm, foe)` → `{ pWeKoFirst, pTheyKoFirst, expectedHpLeft }` combining `actionOrder`,
  `moveOutcome` (acc, crit, dist), `enemyMoveDistribution` and survival items. Feeds `fieldPlan` scores.

---

## 9. Free switches, and when a switch costs the turn

Read from `battle-scene-BmkpVc5x.js` (phases). `PhaseTree`: `pushPhase` appends to level 0 (the turn's base queue,
where TurnStartPhase also pushes the MovePhase markers and `queueTurnEndPhases` —
`WeatherEffectPhase, PositionalTagPhase, BerryPhase, CheckStatusEffectPhase, TurnEndPhase`); `unshiftPhase` /
`queueDeferred` add to a deeper level that runs before control returns to level 0.

**CheckSwitchPhase** ("Will you switch Pokémon?"):
```
start(){ let e=B.getPlayerField()[this.fieldIndex]; if(B.battleStyle===1){this.end();return}
  if(field lacks e) → unshiftNew('SummonMissingPhase'); if(no healthy bench) end;
  if(e.getTag('FRENZY')||e.isTrapped()||B.getPlayerField().some(p=>p.getTag('COMMANDED'))) end;
  B.ui.showText(t('battle:switchQuestion'),null,()=>{ B.ui.setMode(14 /*CONFIRM*/,
    ()=>{ B.ui.setMode(0); B.phaseManager.unshiftNew('SwitchPhase',0,this.fieldIndex,false,true); this.end() },
    ()=>{ B.ui.setMode(0); this.end() }) }) }
```
- Queued (`pushNew('CheckSwitchPhase', 0, double)`, plus slot 1 in doubles) only at encounter start:
  `EncounterPhase.end` (`battleType!==1 && (waveIndex>1 || !isDaily) && allowedParty.length > (double?2:1)`),
  mystery-encounter `endBattleSetup` (`encounterMode!==1 && !disableSwitch`), TitlePhase loading a session, and
  GameOverPhase retry. **Never in trainer battles** (BattleType 1 = TRAINER; `trainer.genAI` is gated on it) and
  **never when a trainer sends its next mon** (the post-KO `SwitchSummonPhase` queues nothing for the player).
  `battleStyle` is the "Battle Style" setting: 0 Switch (default), 1 Set (skips the prompt).
- Yes → `SwitchPhase(SWITCH, slot, isModal=false, doReturn=true)` → party UI (mode 8) → `SwitchSummonPhase`, all
  before `InitEncounterPhase`/`TurnInitPhase`. The enemy has no command yet: TurnInitPhase pushes our CommandPhase,
  then EnemyCommandPhase, so its first move choice and switch check see the new field. No hit, no turn lost.
- Game calls during it: the phase sits in the text/CONFIRM callbacks with nothing mid-execution, same as a waiting
  CommandPhase. Sandboxed calls are safe; `turnData` hasn't been reset (TurnInitPhase does that) and
  `turnCommands` are empty.

**Other switch moments**
| Moment | Phases | Enemy acts on the switch-in first? | Enemy's next command decided against |
|---|---|---|---|
| Switch command in CommandPhase | TurnStartPhase: non-FIGHT commands first → `SwitchSummonPhase(1,…)` | yes: every enemy move this turn (targets resolved to the slot) | old field this turn; new field next turn |
| Faint replacement (ours) | FaintPhase → `pushNew('SwitchPhase',1,slot,isModal=true,doReturn=false)` → level 0, after TurnEndPhase | no (turn is over) | new field |
| Trainer post-KO send-in | FaintPhase → `pushNew('SwitchSummonPhase',1,slot,-1,false,false)` (`getNextSummonIndex`) → after TurnEndPhase | — | its new mon decides next turn against our field then |
| U-turn / Volt Switch / Flip Turn / Baton Pass / Eject Button / Emergency Exit | `ForceSwitchOutHelper.switchOutLogic` → `queueDeferred('SwitchPhase',type,slot,true,true)` (Baton Pass type 2 transfers stages) | yes, if the enemy moves later in the turn (its command was already chosen against the old mon's slot) | old field this turn; new field next turn |
| Roar/Dragon Tail on us | `queueDeferred('SwitchSummonPhase',4,…)` random bench mon | same as above | same |

Faint-replacement `SwitchPhase` is also idle UI (party screen), so game calls are safe there; tell it apart from a
mid-turn U-turn `SwitchPhase` by `isModal && !doReturn`.

---

## 10. Biome choice, and module-private game tables

`SelectBiomePhase` (the current phase while UiMode 15 OPTION_SELECT shows the choice) offers the current biome's
`biomeLinks` (an id, or `[id, n]` rolled in with chance 1/n) as `{label: getBiomeName(id), handler}`, only with a
`MapModifier` and ≥ 2 links left. The handler closes over the id: the HUD sees only `handler.config.options[].label`.

`allBiomes` (Map BiomeId → `{biomeId, pokemonPool, trainerPool, trainerChance, weatherPool, terrainPool, biomeLinks}`),
the species data registry and `getBiomeName` are module-private: no scene path reaches another biome's pools (`Arena`
copies only its own, merged for the time of day). The live build exports them across chunks under mangled export names
but keeps function names (`ar as us` in loading-scene = allBiomes; `t as $t` in FadeOut = the registry, set by
`setSpeciesDataRegistry`; `getBiomeName as P`). Re-`import()`ing an already-loaded `/assets/<name>-<hash>.js` URL from
the page returns the same module instance without re-running it, so `47-biome.js` scans those namespaces by shape (a Map
whose values carry `biomeLinks` + `pokemonPool`; an object with `getSpecies`/`getAllSpecies`; a function named
`getBiomeName`). It is async: the first ticks have no tables. Pool keys: tier 0–4 COMMON…ULTRA_RARE, 5–8
BOSS…BOSS_ULTRA_RARE; time of day -1 ALL, 0 DAWN, 1 DAY, 2 DUSK, 3 NIGHT. Spawn odds and time-of-day rules: the header
of `47-biome.js`. Not verified against a live tab yet (none was open); read from the fetched build.
