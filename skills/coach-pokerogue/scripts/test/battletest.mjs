import { bundle } from "../hud-bundle.mjs";
const TY = ["Normal","Fighting","Flying","Poison","Ground","Rock","Bug","Ghost","Steel","Fire","Water","Grass","Electric","Psychic","Ice","Dragon","Dark","Fairy"];
const cat = { P: 0, S: 1, X: 2 };
// moves: [name, type, power, cat, target=3]
const mon = (name, lv, types, ability, [hp, atk, def, spa, spd, spe], moves, field, curHp) => ({
  getMoveQueue: () => [], isTrapped: () => false, trainerSlot: 0, species: { legendary: false },
  name, level: lv, hp: curHp ?? hp, getMaxHp: () => hp, getTypes: () => types.map(t => TY.indexOf(t)), getAbility: () => ({ name: ability }), hasPassive: () => false,
  getStat: i => [hp, atk, def, spa, spd, spe][i], summonData: { statStages: [0,0,0,0,0,0,0] }, isOnField: () => field, isBoss: () => false,
  getIconAtlasKey: () => "k", getIconId: () => 1, status: null,
  moveset: moves.map(([n, t, p, c, target = 3]) => ({ getName: () => n, getMove: () => ({ type: TY.indexOf(t), power: p, category: cat[c], moveTarget: target }), getMovePp: () => 10, ppUsed: 0 })),
});
// A mon whose types follow its Tera flag, the way the game's getTypes does once TeraPhase has run.
const teraMon = (...args) => {
  const teraType = TY.indexOf(args.pop());
  const p = mon(...args);
  const base = p.getTypes();
  p.getTeraType = () => teraType;
  p.getTypes = () => (p.isTerastallized ? [teraType] : base);
  return p;
};
const party = [
  mon("Charizard", 66, ["Fire","Flying"], "Blaze", [190,125,118,160,128,148], [["Heat Wave","Fire",95,"S",6],["Flare Blitz","Fire",120,"P"],["Air Slash","Flying",75,"S"],["Flamethrower","Fire",90,"S"]], true),
  mon("Venusaur", 65, ["Grass","Poison"], "Overgrow", [200,135,122,144,144,118], [["Double-Edge","Normal",120,"P"],["Power Whip","Grass",120,"P"]], true),
  mon("Blastoise", 64, ["Water"], "Torrent", [187,122,144,125,151,116], [["Wave Crash","Water",120,"P"],["Hydro Pump","Water",110,"S"],["Flash Cannon","Steel",80,"S"]], false),
  mon("Scrafty", 64, ["Dark","Fighting"], "Shed Skin", [163,152,172,63,165,80], [["High Jump Kick","Fighting",130,"P"],["Brick Break","Fighting",75,"P"],["Rock Climb","Normal",90,"P"]], false),
];
const scenarios = {
  // Early-run wild waves with nothing to decide: one line.
  easy: { double: false, party, foes: [mon("Rattata", 20, ["Normal"], "Run Away", [60,50,40,30,40,70], [["Tackle","Normal",40,"P"],["Quick Attack","Normal",40,"P"]], true)] },
  easyDouble: { double: true, party, foes: [mon("Rattata", 20, ["Normal"], "Run Away", [60,50,40,30,40,70], [["Tackle","Normal",40,"P"]], true), mon("Pidgey", 20, ["Normal","Flying"], "Keen Eye", [60,45,40,35,35,56], [["Gust","Flying",40,"S"]], true)] },
  double: { double: true, party, foes: [
    mon("Bisharp", 60, ["Dark","Steel"], "Inner Focus", [152,140,120,70,80,90], [["Iron Head","Steel",80,"P"],["Night Slash","Dark",70,"P"]], true),
    mon("Nidoqueen", 64, ["Poison","Ground"], "Rivalry", [201,120,115,100,110,100], [["Earth Power","Ground",90,"S"],["Sludge Bomb","Poison",90,"S"]], true)] },
  // Doubles with one foe left: both of our slots still need a move.
  lastFoe: { double: true, party, foes: [
    mon("Bisharp", 60, ["Dark","Steel"], "Inner Focus", [152,140,120,70,80,90], [["Iron Head","Steel",80,"P"],["Night Slash","Dark",70,"P"]], false, 0),
    mon("Nidoqueen", 64, ["Poison","Ground"], "Rivalry", [201,120,115,100,110,100], [["Earth Power","Ground",90,"S"],["Sludge Bomb","Poison",90,"S"]], true)] },
  threat: { double: false, party: [
    mon("Charizard", 66, ["Fire","Flying"], "Blaze", [190,125,118,160,128,120], [["Flamethrower","Fire",90,"S"],["Air Slash","Flying",75,"S"]], true, 120),
    mon("Blastoise", 64, ["Water"], "Torrent", [187,122,144,125,151,116], [["Wave Crash","Water",120,"P"]], false)],
    foes: [mon("Lycanroc", 70, ["Rock"], "Keen Eye", [200,190,100,80,90,140], [["Stone Edge","Rock",100,"P"]], true)] },
  switchin: { double: false, party: [
    mon("Charizard", 80, ["Fire","Flying"], "Blaze", [250,140,130,180,140,150], [["Flamethrower","Fire",90,"S"],["Air Slash","Flying",75,"S"]], true),
    mon("Morpeko", 80, ["Electric","Dark"], "Hunger Switch", [220,150,90,120,100,170], [["Aura Wheel","Electric",110,"P"]], false),
    mon("Blastoise", 80, ["Water"], "Torrent", [250,130,170,140,180,130], [["Wave Crash","Water",120,"P"]], false, 90)],
    foes: [mon("Lycanroc", 90, ["Rock"], "Tough Claws", [300,300,140,120,150,165], [["Stone Edge","Rock",100,"P"],["Crunch","Dark",80,"P"]], true)] },
  predict: { double: false, trainer: { isBoss: false }, party: [
    mon("Blastoise", 80, ["Water"], "Torrent", [250,130,170,140,180,130], [["Wave Crash","Water",120,"P"],["Flash Cannon","Steel",80,"S"]], true),
    mon("Venusaur", 80, ["Grass","Poison"], "Overgrow", [260,140,140,160,160,120], [["Power Whip","Grass",120,"P"]], false)],
    foes: [
      mon("Arcanine", 80, ["Fire"], "Intimidate", [260,170,130,150,130,140], [["Flare Blitz","Fire",120,"P"],["Extreme Speed","Normal",80,"P"]], true),
      mon("Ludicolo", 80, ["Water","Grass"], "Swift Swim", [250,110,120,150,170,110], [["Giga Drain","Grass",75,"S"],["Surf","Water",90,"S"]], false)] },
  risk: { double: false, party: [
    mon("Venusaur", 66, ["Grass","Poison"], "Overgrow", [220,135,122,144,144,150], [["Power Whip","Grass",120,"P"]], true)],
    foes: [mon("Aurorus", 66, ["Rock","Ice"], "Refrigerate", [230,90,110,150,120,100], [["Ice Beam","Ice",90,"S"]], true)] },
  single: { double: false, party, foes: [mon("Ninetales", 72, ["Fire"], "Flash Fire", [188,90,100,130,140,130], [["Flamethrower","Fire",90,"S"],["Extrasensory","Psychic",80,"S"]], true)] },
  // A trap the planned move runs into goes on the slot line (collapsed and mini): a 1-hit KO into Sturdy.
  // A trainer mon that Terastallizes before it moves: the panel plans against the Tera type (Steel here, so
  // Flamethrower is super effective and Stone Edge loses its STAB), and marks the row TERA.
  tera: { double: false, trainer: { isBoss: false }, teras: ["Lycanroc"], party: [
    mon("Charizard", 66, ["Fire","Flying"], "Blaze", [190,125,118,160,128,120], [["Flamethrower","Fire",90,"S"],["Air Slash","Flying",75,"S"]], true, 120)],
    foes: [teraMon("Lycanroc", 70, ["Rock"], "Keen Eye", [200,190,100,80,90,140], [["Stone Edge","Rock",100,"P"]], true, "Steel")] },
  trap: { double: false, party: [
    mon("Charizard", 66, ["Fire","Flying"], "Blaze", [190,125,118,160,128,148], [["Flamethrower","Fire",90,"S"]], true)],
    foes: [mon("Pineco", 20, ["Bug"], "Sturdy", [60,50,80,30,30,20], [["Tackle","Normal",40,"P"]], true)] },
};
const txt = n => (n == null ? "" : typeof n === "string" ? n : n.children ? n.children.map(txt).join(" ") + (n.title ? ` {${n.title}}` : "") : "");
const lines = el => (el.kids ?? []).map(txt).map(t => t.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n") + (el.textContent ? `\nTEXT ${el.textContent}` : "");
// Every node with a click handler, depth first, to press the panel's buttons.
const buttons = n => (n == null || typeof n === "string" ? [] : [...(n.onclick ? [n] : []), ...(n.children ?? []).flatMap(buttons)]);

for (const [label, sc] of Object.entries(scenarios)) {
  for (const VIEW of ["full", "mini"]) {
    let el;
    globalThis.window = globalThis; delete globalThis.__coachHud; delete globalThis.__queued;
    class PM { queueMessage() { globalThis.__queued = (globalThis.__queued ?? 0) + 1; } getCurrentPhase() { return { phaseName: "CommandPhase" }; } }
    const pm = new PM();
    const onField = () => sc.party.filter(p => p.isOnField());
    for (const f of sc.foes) { f.getOpponents = () => onField(); f.getMatchupScore = () => { pm.queueMessage("side effect"); return 1; }; f.id = f.name; }
    for (const p of sc.party) p.id = p.name;
    const trainer = sc.trainer ? { getName: () => "Tester", config: sc.trainer, isDouble: () => false,
      getPartyMemberMatchupScores: () => { pm.queueMessage("side effect"); return sc.foes.slice(1).map((f, i) => [i + 1, 5]); },
      getSortedPartyMemberMatchupScores: sc2 => sc2.slice().sort((a, b) => b[1] - a[1]),
      getNextSummonIndex: () => 1, shouldTera: e => !!sc.teras?.includes(e.name) } : null;
    const scene = { phaseManager: pm, getField: () => [...onField(), ...sc.foes.filter(f => f.isOnField())], currentBattle: { waveIndex: 89, turn: 1, double: sc.double, enemySwitchCounter: 0, getBattlerCount: () => (sc.double ? 2 : 1), trainer }, ui: { getMode: () => 0, getHandler: () => ({}) }, getPlayerParty: () => sc.party, getEnemyParty: () => sc.foes };
    globalThis.Phaser = { Math: { RND: { _s: "!rnd,0", state(v) { if (v !== undefined) this._s = v; return this._s; } } }, Display: { Canvas: { CanvasPool: { pool: [{ parent: { game: { scene: { getScene: () => scene }, textures: { exists: () => false } } } }] } } } };
    const node = () => { const n = { style: {}, children: [], addEventListener(ev, fn) { if (ev === "click") n.onclick = fn; }, remove() {}, append(...k) { n.children.push(...k); }, replaceChildren(...k) { n.kids = k; } }; return n; };
    globalThis.document = { documentElement: { dataset: {} }, body: { appendChild: e => (el = e) }, createElement: node };
    globalThis.setInterval = () => 0; globalThis.clearInterval = () => {};
    globalThis.localStorage = { getItem: () => VIEW, setItem() {} };
    eval(bundle("hud"));
    if (sc.trainer && VIEW === "full") console.log(`queued during prediction: ${globalThis.__queued ?? 0}; queueMessage restored: ${!Object.prototype.hasOwnProperty.call(pm, "queueMessage") && typeof pm.queueMessage === "function"}`);
    console.log(`== ${label} (${VIEW})\n${lines(el)}`);
    if (VIEW === "full") console.log(`summary ${JSON.stringify(globalThis.__coachHud.summary())}`);
    // A collapsed wave: `+` shows the chosen view, and it holds for the rest of the wave.
    const plus = (el.kids ?? []).length === 1 ? buttons(el.kids[0]).find(b => b.children.includes("+")) : null;
    if (plus) {
      plus.onclick({ stopPropagation() {} });
      console.log(`-- after + (${VIEW})\n${lines(el)}`);
    }
  }
}
