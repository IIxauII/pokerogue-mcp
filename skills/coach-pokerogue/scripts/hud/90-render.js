// Panel DOM, views, drawing and the refresh loop.
let game = null;
const sprites = new Map();
let missed = false; // a wanted sprite wasn't loaded yet during the last draw
const sprite = (key, frame) => {
  const id = `${key}/${frame}`;
  if (!sprites.has(id)) {
    try {
      const t = game.textures;
      // Icon atlases load lazily; don't cache a miss, retry next refresh.
      if (t.exists(key) && t.get(key).has(frame)) sprites.set(id, t.getBase64(key, frame));
    } catch {}
  }
  return sprites.get(id) ?? "";
};

const h = (tag, style, ...kids) => {
  const n = document.createElement(tag);
  Object.assign(n.style, style);
  n.append(...kids.flat().filter(k => k != null && k !== ""));
  return n;
};
const img = (key, frame, title, height, fallback = title) => {
  const url = sprite(key, frame);
  if (!url) {
    // Optional sprites (fallback null) may simply not exist; don't retry those.
    if (fallback !== null) missed = true;
    return fallback;
  }
  const i = document.createElement("img");
  i.src = url;
  i.title = title;
  Object.assign(i.style, { height: `${height}px`, imageRendering: "pixelated", verticalAlign: "middle", margin: "0 1px" });
  return i;
};
const mon = (icon, name, height = 24) => (icon ? img(icon[0], icon[1], name, height, name) : name);
const badge = (type, suffix = "") => h("span", { whiteSpace: "nowrap", marginRight: "3px" },
  img("types", type.toLowerCase(), type, 12), suffix && h("b", { fontSize: "10px" }, suffix));
const dim = { color: "#9aa" };
const line = (label, color, ...kids) => h("div", { display: "flex", alignItems: "center", flexWrap: "wrap", gap: "1px" },
  h("span", { color, width: "14px", flex: "none" }, label), ...kids);
const hpColor = hp => (hp > 50 ? "#6d6" : hp > 20 ? "#ec4" : "#e55");

// Panel views: "full" (everything), "mini" (one line per foe), "closed" (tab).
// An easy wild wave collapses to one line in either view; a view button pressed during a wave holds for the rest
// of it (`hold` is that wave's key), so the panel doesn't collapse again under the user.
const VIEW_KEY = "coach-hud-view";
let view = "full";
try { view = localStorage.getItem(VIEW_KEY) || view; } catch {}
let shownWave = null, hold = null;
const redraw = () => { last = ""; tick(); };
const setView = v => {
  view = v;
  hold = shownWave;
  try { localStorage.setItem(VIEW_KEY, v); } catch {}
  redraw();
};
// `next`: the view to switch to, or a function to run.
const button = (label, title, next) => {
  const n = h("span", { cursor: "pointer", padding: "0 4px", borderRadius: "3px", background: "rgba(255,255,255,.1)", fontWeight: "bold" }, label);
  n.title = title;
  n.addEventListener("click", e => { e.stopPropagation(); typeof next === "function" ? next() : setView(next); });
  return n;
};
const hitsText = n => `${n} hit${n === 1 ? "" : "s"}`;

const tab = (emoji, icon) => {
  const n = h("span", { cursor: "pointer", display: "flex", alignItems: "center", gap: "3px" }, emoji, icon);
  n.title = "Open coach";
  n.addEventListener("click", e => { e.stopPropagation(); setView("mini"); });
  return n;
};
const bar = (emoji, title, ...right) => h("div", { display: "flex", alignItems: "center", gap: "4px", fontWeight: "bold" },
  emoji, title, h("span", { flex: "1" }), ...right,
  h("span", { width: "4px" }),
  view === "full" ? button("−", "Minimal overview", "mini") : button("+", "Expand", "full"),
  button("×", "Close", "closed"));

// "3× Water" (the move would be the third of its type) reads as "3rd Water move".
const ordinal = n => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
const learnNote = n => n.replace(/^(\d+)× (\w+)$/, (_, k, t) => `${ordinal(+k)} ${t} move`);
// What the effective power is made of, as the power's tooltip: the card stays one number per move.
const powerTitle = x => [`base ${x.power}${x.hits > 1 ? ` × ${x.hits} hits` : ""}`, x.acc < 100 ? `${x.acc}% acc` : null,
  x.stab ? "STAB" : null, x.fixed ? "fixed damage" : null].filter(Boolean).join(" · ");
const drawLearn = m => {
  if (view === "closed") return [tab("🎓", mon(m.icon, m.name, 20))];
  const header = bar("🎓", `${m.name} learns`, mon(m.icon, m.name, 20),
    view === "full" && m.atk != null ? h("span", { ...dim, fontWeight: "normal", fontSize: "9px" }, `Atk ${m.atk} / SpA ${m.spa}`) : null);
  // The slot the new move would take: the one to forget, or on a skip the one it lost to.
  const slot = m.forget >= 0 ? m.forget : m.compare;
  // Only-type loss: the slot's own "only X move on team" note becomes a ⚠ by its name; the team line says it.
  const onlyNote = m.team?.onlyType ? `only ${m.team.onlyType} move on team` : null;
  const row = (x, mark, color, warn) => {
    const notes = warn ? x.notes.filter(n => n !== onlyNote) : x.notes;
    const power = h("span", dim, x.value === null ? "status" : `power ${x.value}`);
    if (x.value !== null && x.power != null) power.title = powerTitle(x);
    return line(mark, color,
      badge(x.type), img("categories", x.cat, x.cat, 12, null),
      h("span", { fontWeight: "bold", marginLeft: "2px" }, x.name),
      warn ? h("span", { color: "#fa4", marginLeft: "3px" }, "⚠") : null,
      h("span", { flex: "1" }),
      notes.length ? h("span", { color: "#9aa", fontSize: "9px", marginRight: "4px" }, notes.map(learnNote).join(" · ")) : null,
      power);
  };
  const warnAt = i => i === slot && !!onlyNote;
  const loses = onlyNote ? h("span", { color: "#fa4" }, `⚠ loses only ${m.team.onlyType} move`) : null;
  // Net change only: a type both gained and lost (a same-type swap) is no change.
  const gains = (m.team?.gains ?? []).filter(t => !m.team.loses.includes(t));
  const lost = (m.team?.loses ?? []).filter(t => !m.team.gains.includes(t));
  const teamParts = [
    gains.length ? h("span", { color: "#6d6" }, `+SE ${gains.slice(0, 3).join("/")}${gains.length > 3 ? "…" : ""}`) : null,
    lost.length ? h("span", { color: "#e77" }, `−SE ${lost.slice(0, 3).join("/")}${lost.length > 3 ? "…" : ""}`) : null,
    loses,
  ].filter(Boolean);
  const teamLine = parts => (parts.length
    ? line("", "#9aa", h("span", { ...dim, marginRight: "4px" }, "team:"), ...parts.flatMap((p, i) => [i ? h("span", dim, " · ") : null, p]))
    : null);
  // Effective power the swap gains; on a skip only a loss (a gain under the learn threshold would read as a contradiction).
  const gain = (m.decision === "learn" || (m.decision === "skip" && m.gain < 0)) && m.gain
    ? h("span", { ...dim, fontWeight: "normal", marginLeft: "6px" }, `${m.gain > 0 ? "+" : "−"}${Math.abs(m.gain)} power`) : null;
  const verdict = h("div", { color: m.verdict[1], fontWeight: "bold", marginTop: "3px" }, m.verdict[0], view === "full" ? gain : null);
  if (view === "mini") {
    return [header, row(m.move, "✚", "#6d6"), m.forget >= 0 ? row(m.moves[m.forget], "✕", "#e55", warnAt(m.forget)) : null,
      m.forget >= 0 ? teamLine([loses].filter(Boolean)) : null, verdict].filter(Boolean);
  }
  return [header, row(m.move, "✚", "#6d6"),
    h("div", { borderTop: "1px solid rgba(255,255,255,.12)", margin: "3px 0" }),
    ...m.moves.map((x, i) => (i === m.forget ? row(x, "✕", "#e55", warnAt(i)) : i === slot ? row(x, "↔", "#fa4", warnAt(i)) : row(x, "·", "#9aa"))),
    teamLine(teamParts), verdict].filter(Boolean);
};

const itemImg = (icon, name) => img("items", icon, name, 18, null);
const sep = { borderTop: "1px solid rgba(255,255,255,.12)", margin: "3px 0" };
const drawShop = m => {
  const p = m.pick >= 0 ? m.free[m.pick] : null;
  if (view === "closed") return [tab("🛒", p ? itemImg(p.icon, p.name) : null)];
  const header = bar("🛒", `$${m.money}`, m.buys.length ? h("span", dim, `→ $${m.left}`) : null,
    view === "full" && !m.buys.length && m.affordable === 0 ? h("span", { ...dim, fontWeight: "normal", fontSize: "9px" }, "nothing affordable") : null,
    m.bossNext ? h("span", { color: "#fa4", fontSize: "9px" }, "👑 boss next") : null);
  const buyRows = m.buys.length
    ? m.buys.map(b => line("💰", "#ec4", itemImg(b.icon, b.name),
        h("span", { fontWeight: "bold" }, b.name), h("span", { ...dim, marginLeft: "4px" }, `$${b.cost}`),
        h("span", { flex: "1" }), mon(b.target, b.targetName, 20), h("span", dim, b.why)))
    : [];
  // A TM names its best recipient by icon and the move it replaces, instead of the "TM for X (over Y)" text; full view
  // adds the effective power it gains. Other options' rows use it too, in their smaller type.
  const tmTo = (f, style = dim) => {
    const b = f.best;
    if (!b) return null;
    const forget = b.forget ? `→ forget ${b.forget}` : "free slot";
    const what = b.setup ? `setup ${b.setup}${b.forget ? ` ${forget}` : ""}` : f.tm === "maybe" ? `${b.reason} — your call` : forget;
    const gain = view === "full" && f.tm === "take" && !b.setup && b.gain > 0 ? ` · +${b.gain} power` : "";
    return [mon(b.icon, b.name, 20), h("span", style, what + gain)];
  };
  const take = p ? line("🎁", "#6d6", itemImg(p.icon, p.name),
    h("span", { fontWeight: "bold" }, p.name), h("span", { flex: "1" }), tmTo(p) ?? h("span", dim, p.why)) : null;
  if (view === "mini") return [header, ...buyRows, take].filter(Boolean);
  // Who can use it, when the reason doesn't already name them.
  const usersText = f => {
    const rest = (f.users ?? []).filter(n => !f.why.includes(n));
    return rest.length ? ` · for ${rest.slice(0, 2).join("/")}${rest.length > 2 ? ` +${rest.length - 2}` : ""}` : "";
  };
  const others = m.free.filter((_, i) => i !== m.pick).map(f => line("·", "#9aa", itemImg(f.icon, f.name),
    h("span", dim, f.name), h("span", { flex: "1" }),
    tmTo(f, { color: "#9aa", fontSize: "9px" }) ?? h("span", { color: f.tm === "skip" ? "#e77" : "#9aa", fontSize: "9px" }, `${f.why}${usersText(f)}`)));
  return [header,
    m.buys.length ? h("div", { ...dim, fontSize: "9px" }, "buy first — taking the free reward closes the shop") : null,
    ...buyRows, m.buys.length ? h("div", sep) : null, take, ...others,
    m.reroll ? line("🎲", "#8cf", h("span", dim, m.reroll)) : null].filter(Boolean);
};

// Danger the panel flags on our side: the 💀 / ⚠ tags on field slots and on mons a switch takes out.
const dangerTags = m => (m.field ? [...m.field.slots.map(sl => [sl.name, sl.threat]), ...m.field.switches.map(sw => [sw.out?.name, sw.out?.threat])] : [])
  .filter(([name, t]) => name && t).map(([name, t]) => ({ mon: name, level: t.level, from: t.from, move: t.move }));
const catchWorthIt = m => !!m.catch?.targets?.some(t => t.verdict !== "skip");
const planLost = m => !!m.teamPlan && m.teamPlan.result !== "win";
// An easy wave: a wild fight with nothing to decide. No boss, no danger tag, no switch (nor a missing one), every
// slot KOs in 1–2 hits, and no catch worth a ball. Anything else expands the panel on its own.
const easyWave = m => {
  const f = m.field;
  if (m.kind !== "battle" || m.trainer || !f || f.freeSwitch || m.enemySwitches?.length || m.rows.some(r => r.boss)) return false;
  if (f.switches.length || f.noSafeSwitch || dangerTags(m).length || catchWorthIt(m) || planLost(m)) return false;
  return f.slots.length > 0 && f.slots.every(sl => sl.move && slowestKo(sl) >= 1 && slowestKo(sl) <= 2);
};
// A spread move KOing the two foes on different turns carries `koEach` instead of one `ko`: the slower one counts.
const slowestKo = sl => (sl.koEach?.length ? Math.max(...sl.koEach) : sl.ko);
// easy / trainer / danger / catch / fight, most specific first: what the watcher and Claude's brief key off.
const verdictOf = m => (easyWave(m) ? "easy" : m.trainer ? "trainer"
  : dangerTags(m).length || m.rows.some(r => r.boss) || m.field?.noSafeSwitch ? "danger"
  : catchWorthIt(m) ? "catch" : "fight");
const slotText = sl => `${sl.name} ${sl.move ?? "—"}${sl.target === "both" ? " → both" : sl.target ? ` → ${sl.target.name}` : ""}${slowestKo(sl) > 0 && slowestKo(sl) <= 3 ? ` · ${hitsText(slowestKo(sl))}` : ""}`;

// Plain-text verdict of what the panel shows, for the watcher and the battle read (`window.__coachHud.summary()`).
// `danger` lists the 💀 tags only: a likely KO before our mon acts.
const hudSummary = m => {
  if (!m) return null;
  const base = { kind: m.kind, wave: m.wave ?? null, verdict: null, field: null, danger: [], learn: null, rewards: null };
  if (m.kind === "biome") return biomeSummary(m);
  if (m.kind === "learn") {
    const only = m.team?.onlyType && m.forget >= 0 ? ` · ⚠ loses only ${m.team.onlyType} move` : "";
    return { ...base, learn: `${m.verdict[0]}${only}` };
  }
  if (m.kind === "shop") {
    const p = m.pick >= 0 ? m.free[m.pick] : null;
    const buys = m.buys.length ? `buy ${m.buys.map(x => x.name).join(", ")}` : null;
    return { ...base, rewards: [p ? `take ${p.name}${p.best ? ` → ${p.best.name}${p.best.forget ? ` (forget ${p.best.forget})` : ""}` : ""}` : null, buys].filter(Boolean).join(" · ") || null };
  }
  return { ...base, verdict: verdictOf(m), field: m.field ? m.field.slots.map(slotText).join(" ; ") : null,
    danger: dangerTags(m).filter(d => d.level === "ko").map(({ mon: name, from, move }) => ({ mon: name, from, move })) };
};

// Trap abilities on a slot's target that its planned move runs into: by type, by category (Intimidate, Fluffy), a
// super-effective hit (Filter and co.) or a 1-hit KO (Sturdy). Rows carry names and types only, so this is by name.
const trapsHit = (m, sl) => {
  if (!sl.move) return [];
  const foes = m.rows.filter(r => (sl.target === "both" ? !r.pick?.later : r.name === sl.target?.name));
  const phys = sl.cat === "physical";
  const hits = (a, r) => ABILITY_IMMUNE[a] === sl.type
    || (a === "Thick Fat" && (sl.type === "Fire" || sl.type === "Ice")) || (a === "Heatproof" && sl.type === "Fire")
    || (a === "Fluffy" && (phys || sl.type === "Fire")) || (a === "Intimidate" && phys) || (a === "Sturdy" && sl.ko === 1)
    || a === "Wonder Guard"
    || (["Filter", "Solid Rock", "Prism Armor"].includes(a) && r.types.reduce((x, d) => x * vs(sl.type, d), 1) >= 2);
  return [...new Set(foes.flatMap(r => r.abilities.filter(a => TRAPS.has(a) && hits(a, r))))];
};

let collapsed = false; // set per draw by tick: this battle panel is the one-line easy-wave view
const drawBattle = m => {
  if (view === "closed") return [tab("🎯", m.order[0] ? mon(m.order[0].icon, m.order[0].name, 20) : null)];
  const f = m.field;
  const trapTag = sl => trapsHit(m, sl).map(a => h("span", { color: "#fa4", fontSize: "9px", marginLeft: "3px" }, `⚠ ${a}`));

  // Easy wild wave: one line, one ⚔ per slot. `+` shows the chosen view for the rest of the wave.
  if (collapsed) {
    return [h("div", { display: "flex", alignItems: "center", flexWrap: "wrap", gap: "3px", fontWeight: "bold" },
      "🎯", m.title,
      ...f.slots.flatMap(sl => [h("span", { color: "#8cf", marginLeft: "4px" }, "⚔"), mon(sl.icon, sl.name, 20),
        h("span", {}, sl.move),
        ...(sl.target === "both" ? [h("span", dim, "→ both")] : sl.target ? [h("span", dim, "→"), mon(sl.target.icon, sl.target.name, 18)] : []),
        h("span", { ...dim, fontWeight: "normal" }, `· ${hitsText(slowestKo(sl))}`), ...trapTag(sl)]),
      h("span", { flex: "1" }), h("span", { width: "4px" }), button("+", "Show details", view), button("×", "Close", "closed"))];
  }

  // Send-in icons only add something when they go beyond the ⚔ mons: a trainer's later foes.
  const slotNames = new Set(f?.slots.map(sl => sl.name) ?? []);
  const order = m.trainer || m.order.some(o => !slotNames.has(o.name)) ? m.order : [];
  const header = bar("🎯", m.title,
    ...order.flatMap((o, i) => [i ? h("span", dim, "›") : null, mon(o.icon, o.name, 20)]));

  const threatTag = t => {
    const n = h("span", { display: "inline-flex", alignItems: "center", marginRight: "4px", color: t.level === "ko" ? "#e55" : "#fa4" },
      t.level === "ko" ? "💀" : "⚠", badge(t.type, t.e >= 2 ? `×${t.e}` : ""),
      h("span", { fontSize: "9px", marginLeft: "1px" }, `${t.pct}%${t.hits ? ` ${t.hits}-hit` : ""}`));
    n.title = `${t.next ? "next turn: " : ""}${t.from}'s ${t.move}: ~${t.pct}% of current HP`
      + `${t.pko > 0 && t.pko < 100 ? `, ${t.pko}% KO` : ""}${t.level === "ko" ? ", before it can act" : ""}`;
    return n;
  };
  // A switch uses the turn: with one, the plan reads as steps — `now:` the switch (and any slot that still
  // attacks this turn), `next:` the switch-in's move.
  const step = (label, icon, color, ...kids) => h("div", { display: "flex", alignItems: "center", flexWrap: "wrap", gap: "1px" },
    label ? h("span", { ...dim, width: "30px", flex: "none" }, label) : null,
    h("span", { color, width: "14px", flex: "none" }, icon), ...kids);
  const swapLine = (sw, color, tail, label) => step(label, "⇄", color,
    ...(sw.out ? [mon(sw.out.icon, sw.out.name, 20), sw.out.threat ? threatTag(sw.out.threat) : null, h("span", { color, margin: "0 3px" }, "out ›")] : [h("span", { color, marginRight: "3px" }, "send")]),
    mon(sw.in.icon, sw.in.name, 20), h("span", { color, marginLeft: "3px" }, tail));
  // ⚔ what each field slot should do; ⇄ the switches to get there (dim: better, but not worth a turn). Mini has no
  // foe rows, so a trap ability the move runs into goes on the slot itself.
  const slotLine = (sl, label) => step(label, "⚔", "#8cf",
    mon(sl.icon, sl.name, 22),
    sl.threat ? threatTag(sl.threat) : null,
    ...(sl.move ? [badge(sl.type), h("span", { fontWeight: "bold" }, sl.move)] : [h("span", dim, "no damaging move")]),
    ...(sl.target === "both" ? [h("span", { color: "#8cf", marginLeft: "4px" }, "→ both")]
      : sl.target ? [h("span", { color: "#8cf", margin: "0 2px 0 4px" }, "→"), mon(sl.target.icon, sl.target.name, 20)] : []),
    ...(view === "mini" ? trapTag(sl) : []),
    h("span", { flex: "1" }),
    sl.ko ? h("span", dim, hitsText(sl.ko)) : null,
    sl.notes?.length ? h("span", { ...dim, fontSize: "9px", marginLeft: "4px" }, sl.notes.join(" · ")) : null);
  const firstText = p => (p >= 100 ? "moves first" : p <= 0 ? "moves after" : `${p}% first`);
  const slotMove = sl => [
    mon(sl.icon, sl.name, 20),
    ...(sl.move ? [badge(sl.type), h("span", { marginRight: "2px" }, sl.move)] : [h("span", dim, "—")]),
    ...(sl.target === "both" ? [h("span", dim, "→ both")] : sl.target ? [h("span", dim, "→"), mon(sl.target.icon, sl.target.name, 18)] : []),
  ];
  const enemySwitches = m.enemySwitches.map(es => line("⇆", "#c9f",
    mon(es.from.icon, es.from.name, 20), h("span", { color: "#c9f", margin: "0 3px" }, "→"),
    mon(es.to.icon, es.to.name, 20), h("span", { color: "#c9f", marginLeft: "3px" }, "switches — moves aimed at it")));
  const ifStay = m.ifStay && view === "full"
    ? line("↺", "#9aa", h("span", { ...dim, marginRight: "4px" }, "if it stays:"), ...m.ifStay.flatMap((sl, i) => [i ? h("span", dim, " · ") : null, ...slotMove(sl)]))
    : null;
  const noSafeSwitch = () => {
    const n = line("⇄", "#e55", h("span", { color: "#e55" }, "no safe switch"));
    n.title = "every bench mon is KO'd coming in or before it acts";
    return n;
  };
  const split = !!f?.slots.some(sl => sl.enter);
  const field = !f ? [...enemySwitches] : [
    ...enemySwitches,
    // The game is asking whether to switch before the turn: the answer first, then the coming turn's plan.
    ...(f.freeSwitch
      ? [...(f.switches.length
          ? f.switches.map(sw => line("⇄", "#6d6", h("span", { color: "#6d6", marginRight: "3px" }, "free switch?"),
              ...(sw.out ? [mon(sw.out.icon, sw.out.name, 20), h("span", { color: "#6d6", margin: "0 3px" }, "→")] : []),
              mon(sw.in.icon, sw.in.name, 20), h("span", { ...dim, marginLeft: "3px" }, "(no hit taken)")))
          : [line("⇄", "#6d6", h("span", { color: "#6d6", marginRight: "3px" }, "free switch? stay —"),
              h("span", dim, `${f.slots.map(sl => sl.name).join(" & ")} ${f.slots.length > 1 ? "are" : "is"} best here`))]),
        ...f.slots.map(sl => slotLine(sl))]
      : split
      ? [...f.switches.map(sw => swapLine(sw, "#fa4", "in", "now:")),
        ...f.slots.filter(sl => !sl.enter).map(sl => slotLine(sl, "now:")),
        ...f.slots.filter(sl => sl.enter).map(sl => slotLine(sl, "next:"))]
      : [...f.slots.map(sl => slotLine(sl)), ...f.switches.map(sw => swapLine(sw, "#fa4", "in"))]),
    // Doubles: both slots on one foe says why. A split needs no line: the ⚔ targets already show it.
    f.targeting?.kind === "focus" ? line("◎", "#8cf", h("span", { color: "#8cf", marginRight: "3px" }, "focus"), mon(f.targeting.target.icon, f.targeting.target.name, 18),
      h("span", dim, `: ${f.targeting.note}${f.targeting.pko > 0 && f.targeting.pko < 100 ? ` (${f.targeting.pko}%)` : ""}`)) : null,
    ...(view === "full" ? f.optional.map(sw => swapLine(sw, "#9aa", "in · optional")) : []),
    f.noSafeSwitch ? noSafeSwitch() : null,
    ifStay,
  ];

  if (view === "mini") return [header, ...field, ...drawCatch(m), ...drawTeamPlan(m)].filter(Boolean);

  // Only types the party has a damaging move of: a weakness nobody can hit is noise.
  const usable = ([t]) => !m.moveTypes || m.moveTypes.includes(t);
  const teamWeak = m.team.filter(usable);
  const team = m.trainer && m.rows.length > 1 && teamWeak.length
    ? line("", "#e77", h("span", { color: "#e77", marginRight: "4px" }, "team weak to:"), ...teamWeak.map(([t, n]) => badge(t, `×${n}`)))
    : null;
  const rows = m.rows.map(r => {
    const traps = r.abilities.filter(a => TRAPS.has(a));
    const weak = r.weak.filter(usable), avoid = r.avoid.filter(usable);
    return h("div", { marginTop: "5px", paddingTop: "4px", borderTop: "1px solid rgba(255,255,255,.12)" },
      h("div", { display: "flex", alignItems: "center", gap: "3px" },
        mon(r.icon, r.name, 28),
        h("span", { fontWeight: "bold" }, r.name),
        h("span", dim, `L${r.lv}`),
        ...r.types.map(t => badge(t)),
        // It Terastallizes before it moves this turn, so the types, weaknesses and damage above are already its
        // Tera type's.
        r.tera ? h("span", { color: "#c9f", fontSize: "9px", marginRight: "3px" }, "TERA") : null,
        r.boss ? "👑" : null,
        STATUS_FRAMES[r.status] ? img("statuses", STATUS_FRAMES[r.status], STATUS_FRAMES[r.status], 10, null) : null,
        h("span", { flex: "1" }),
        h("span", { color: hpColor(r.hp) }, `${r.hp}%`)),
      traps.length ? line("✦", "#fa4", ...traps.map(a => h("span", { color: "#fa4", marginRight: "6px" }, `⚠ ${a}`))) : null,
      line("▲", "#6d6", ...(weak.length ? weak.map(([t, x]) => badge(t, x)) : [h("span", dim, "—")])),
      avoid.length ? line("✕", "#e55", ...avoid.map(([t, x]) => badge(t, x))) : null,
      // The enemy's likely move into the pokémon we put in front of it: its damage (% of that mon's HP) once the
      // model carries it, otherwise how likely the AI is to pick it.
      r.likely ? line("↯", "#e77",
        badge(r.likely.type), h("span", { color: "#e77" }, r.likely.move),
        ...(r.pick ? [h("span", { ...dim, margin: "0 2px 0 3px" }, "→"), mon(r.pick.icon, r.pick.name, 18)] : []),
        h("span", { ...dim, marginLeft: "4px" }, [
          r.likely.pct != null ? `~${r.likely.pct}% HP` : r.likely.p != null ? `${r.likely.p}% likely` : null,
          r.likely.hits ? `${r.likely.hits}-hit` : null, firstText(r.likely.first)].filter(Boolean).join(" · "))) : null,
      // A foe on the field already has its ⚔ line; the pick is only news for one no slot is on yet.
      r.pick?.later
        ? line("➜", "#8cf",
            mon(r.pick.icon, r.pick.name, 22),
            img("categories", r.pick.cat, r.pick.cat, 12, null),
            badge(r.pick.type),
            h("span", { fontWeight: "bold" }, r.pick.move),
            h("span", { ...dim, marginLeft: "4px" }, `~${r.pick.pct}%${r.pick.ko ? ` · ${hitsText(r.pick.ko)}` : ""}`),
            r.pick.risky ? h("span", { color: "#fa4" }, " ⚠ loses trade") : null,
            h("span", { color: "#9aa", fontSize: "9px", marginLeft: "4px" }, "later"),
            r.pick.notes?.length ? h("span", { color: "#9aa", fontSize: "9px", marginLeft: "4px" }, r.pick.notes.join(" · ")) : null)
        : !r.pick && !f ? line("➜", "#8cf", h("span", dim, "no damaging move lands")) : null,
      r.notes?.length ? line("·", "#9aa", h("span", { ...dim, fontSize: "9px" }, r.notes.join(" · "))) : null);
  });
  return [header, ...field, ...drawCatch(m), team, ...rows, ...drawTeamPlan(m)].filter(Boolean);
};

const el = document.createElement("div");
el.id = "coach-hud";
Object.assign(el.style, {
  position: "fixed", top: "8px", left: "8px", zIndex: "2147483647",
  maxWidth: "min(300px, calc(100vw - 16px))", padding: "6px 8px", borderRadius: "6px",
  background: "rgba(12,12,24,.88)", color: "#eee",
  font: "11px/1.4 ui-monospace, Menlo, monospace",
  userSelect: "none", display: "none",
});
// Keep clicks on the panel from reaching the game underneath.
for (const ev of ["click", "mousedown", "pointerdown", "touchstart"]) el.addEventListener(ev, e => e.stopPropagation());
let last = "";
let shown = null; // the model last drawn: `window.__coachHud.last()` / `summary()`
document.body.appendChild(el);

// Damaging move types across the living party: the foe rows only list weaknesses we can hit.
const moveTypesOf = party => [...new Set(party.flatMap(p => p.moveset.filter(Boolean).map(pm => {
  try { const mv = pm.getMove(); return mv.category !== 2 && mv.power > 0 ? TYPES[mv.type] : null; } catch { return null; }
})).filter(Boolean))];

const tick = () => {
  try {
    game ??= Phaser.Display.Canvas.CanvasPool.pool.map(p => p.parent).find(p => p && p.game).game;
    const s = game.scene.getScene("battle");
    // Mid-reload or on the title screen: nothing to coach, and the scene isn't wired up yet.
    if (!s?.ui) { el.style.display = "none"; shown = null; return; }
    const learn = learnState(s);
    const handler = s.ui.getHandler();
    let m;
    if (learn) {
      m = learnModel(learn);
    } else if (s.ui.getMode() === 6 && handler?.options?.length) {
      m = shopModel(s, handler);
    } else if (biomeScreen(s, handler)) {
      m = biomeModel(s, handler);
    } else {
      const b = s.currentBattle;
      const foes = s.getEnemyParty().filter(p => p.hp > 0);
      const party = s.getPlayerParty().filter(p => p.hp > 0);
      if (!b || !foes.length || !party.length) { el.style.display = "none"; shown = null; return; }
      m = { ...model(s, b, party, foes), trainer: !!b.trainer, double: !!b.double, moveTypes: moveTypesOf(party) };
    }
    m.wave = s.currentBattle?.waveIndex ?? null;
    shown = m;
    // A view picked by a button holds until the card or wave changes.
    shownWave = `${m.kind}:${m.wave}`;
    collapsed = view !== "closed" && hold !== shownWave && easyWave(m);
    const sig = JSON.stringify([view, collapsed, m]);
    el.style.display = "block";
    el.style.width = view === "full" && !collapsed ? "300px" : "auto";
    if (sig !== last) {
      missed = false;
      el.replaceChildren(...({ learn: drawLearn, shop: drawShop, battle: drawBattle, biome: drawBiome }[m.kind])(m));
      // Icon atlases load lazily; redraw next tick until every sprite is in.
      last = missed ? "" : sig;
    }
  } catch (e) {
    game = null;
    el.style.display = "block";
    el.textContent = `coach: ${e.message}`;
    last = "";
  }
};
