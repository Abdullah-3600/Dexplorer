"use strict";
/* DexCheck: read save files on-device and show a living dex (National Dex 1-386). Parsing lives in saves.js. */
const $ = id => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e };
const GAMES = SaveReader.GAMES, G = Object.fromEntries(GAMES.map(g => [g.id, g]));
const REGIONS = [{ name: "Kanto", gen: "I", from: 1, to: 151 }, { name: "Johto", gen: "II", from: 152, to: 251 }, { name: "Hoenn", gen: "III", from: 252, to: 386 }];
const ROMAN = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX"], MAX = 386, KEY = "pokebank.v3";
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
const SRC = { p: "party", b: "boxes", d: "daycare" };
let dupes = [], order = "national", groups = [], dex = [], saves = [], sel = new Set(), status = "all", query = "", idx = new Map(), cells = [], seen = new Set(), tick = 0;

/* ---------- Dexplorer menu (same behaviour as the map page) ---------- */
const mb = $("mb"), mn = $("mn"), items = () => [...mn.querySelectorAll("[role=menuitem]:not([aria-disabled=true])")];
function menu(o) { mn.hidden = !o; mb.setAttribute("aria-expanded", o); if (o) (mn.querySelector("[aria-current=page]") || items()[0]).focus(); else mb.focus() }
mb.onclick = () => menu(mn.hidden);
mb.onkeydown = e => { if (e.key === "ArrowDown") { e.preventDefault(); menu(true) } };
document.addEventListener("click", e => { if (!mn.hidden && !mn.parentNode.contains(e.target)) menu(false) });
mn.onkeydown = e => {
  const it = items(), i = it.indexOf(document.activeElement);
  if (e.key === "Escape") { e.preventDefault(); menu(false) }
  else if (e.key === "ArrowDown") { e.preventDefault(); it[(i + 1) % it.length].focus() }
  else if (e.key === "ArrowUp") { e.preventDefault(); it[(i - 1 + it.length) % it.length].focus() }
  else if (e.key === "Tab") menu(false);
};
mn.querySelectorAll("[role=menuitem]").forEach(b => b.onclick = () => { if (b.dataset.href) location.href = b.dataset.href; else if (b.getAttribute("aria-disabled") !== "true") menu(false) });

/* ---------- keeping the page usable ---------- */
function guard(fn) { try { return fn() } catch (e) { console.error(e); recover("Something went wrong opening that Pokémon. Try again.") } }
function recover(msg) { // put the page back into a clickable state
  const d = $("drop"); if (d) d.hidden = true;
  const dlg = $("dlg"); if (dlg && dlg.open) dlg.close();
  if (msg) toast(msg);
}
addEventListener("error", () => recover("Something went wrong. If the page stops responding, reload it."));
addEventListener("unhandledrejection", () => recover("Something went wrong. If the page stops responding, reload it."));
addEventListener("keydown", e => { if (e.key === "Escape") recover() });

/* ---------- helpers ---------- */
const dot = g => { const d = el("i", "dot"); d.style.setProperty("--c1", g.c[0]); d.style.setProperty("--c2", g.c[1] || g.c[0]); return d };
const pad = n => String(n).padStart(3, "0");
const spriteGen = g => g && g.gen >= 1 && g.gen <= 3 ? g.gen : 3;
function spriteFor(p, g) { // the sprite of the game's own generation; later games fall back to the newest sprite we have
  const want = spriteGen(G[g]), have = Object.keys(p.sprites).map(Number);
  const gen = have.includes(want) ? want : Math.max(...have.filter(x => x <= want), Math.min(...have));
  return { gen, src: p.sprites[gen] };
}
let toastT;
function toast(msg, action) {
  const t = $("toast"); t.replaceChildren(el("span", "", msg)); t.hidden = false; clearTimeout(toastT);
  if (action) { const b = el("button", "", action.label); b.type = "button"; b.onclick = () => { t.hidden = true; action.run() }; t.appendChild(b) }
  toastT = setTimeout(() => t.hidden = true, action ? 7000 : 3500);
}
const store = () => {
  const pack = full => ({ saves: saves.map(x => ({ ...x, mons: full ? x.mons : x.mons.map(m => ({ n: m.n, g: m.g, s: m.s })) })), dupes: dupes.map(x => ({ ...x, mons: full ? x.mons : [] })), sel: [...sel] });
  try { localStorage.setItem(KEY, JSON.stringify(pack(true))) } catch (e) { try { localStorage.setItem(KEY, JSON.stringify(pack(false))) } catch (e2) { } } // quota: keep the dex, drop the extra details
};
function stale() { // saves stored by v1 lack levels, moves and nicknames; they cannot be re-read without the file
  try { let hit = false; for (const k of ["pokebank.v1", "pokebank.v2"]) if (localStorage.getItem(k)) { localStorage.removeItem(k); hit = true } return hit } catch (e) { }
  return false;
}
let outdated = 0;
function restore() {
  try {
    const o = JSON.parse(localStorage.getItem(KEY) || "null"); if (!o) return;
    const cur = x => x && x.fmt === 2; // older saves were stored without friendship, ball and shiny data
    outdated = (o.saves || []).filter(x => !cur(x)).length;
    saves = (o.saves || []).filter(cur); dupes = (o.dupes || []).filter(cur); sel = new Set(o.sel || []);
  } catch (e) { saves = []; sel = new Set() }
}

/* ---------- index of what is caught ---------- */
function reindex() {
  idx = new Map();
  for (const sv of saves) for (const m of sv.mons) {
    if (m.n < 1 || m.n > MAX) continue;
    let byGame = idx.get(m.n); if (!byGame) idx.set(m.n, byGame = new Map());
    let e = byGame.get(m.g); if (!e) byGame.set(m.g, e = { p: 0, b: 0, d: 0, sh: 0, files: new Set() });
    e[m.s]++; if (m.sh) e.sh++; e.files.add(sv.name);
  }
}
// The entries that count as "caught" under the current game filter.
const entriesOf = n => { const m = idx.get(n); if (!m) return []; return [...m].filter(([g]) => !sel.size || sel.has(g)) };
const gameRank = g => GAMES.findIndex(x => x.id === g);

/* ---------- grid ---------- */
function makeGroups() {
  const by = (title, list, key) => ({ title, items: list.map(p => ({ p, no: key ? p.dex[key] : p.id })).sort((x, y) => x.no - y.no) });
  if (order === "region") return [["Kanto", "kanto"], ["Johto", "johto"], ["Hoenn", "hoenn"]].map(([n, k]) => by(n + " Dex", dex.filter(p => p.dex && p.dex[k]), k));
  if (order === "generation") return REGIONS.map(r => by("Generation " + r.gen + " · " + r.name, dex.filter(p => p.id >= r.from && p.id <= r.to)));
  return [by("National Dex", dex)];
}
function buildGrid() {
  const grid = $("grid"); grid.replaceChildren(); cells = []; groups = makeGroups();
  for (const r of groups) {
    const head = el("div", "rg"), h = el("h2", "", r.title), c = el("span"); head.append(h, c);
    const gr = el("div", "gr"); gr.setAttribute("role", "list");
    for (const { p, no } of r.items) {
      const b = el("button", "cell"); b.type = "button"; b.setAttribute("role", "listitem"); b.dataset.n = p.id;
      const art = el("span", "art"), img = el("img"); img.alt = ""; img.decoding = "async"; art.appendChild(img);
      b.append(art, el("small", "no", "#" + pad(no)), el("span", "nm", p.name), el("span", "dots"), el("i", "gen"));
      gr.appendChild(b); cells.push({ p, b, img, r, head, count: c, grid: gr, cyc: Object.keys(p.sprites).map(Number).sort(), off: p.id % 3 });
    }
    grid.append(head, gr);
  }
  if (io) { io.disconnect(); vis.clear() }
  if (!grid.__bound) { grid.__bound = true; grid.addEventListener("click", e => { const b = e.target.closest(".cell"); if (b) guard(() => detail(dex.find(p => p.id === +b.dataset.n))) }) }
  if ("IntersectionObserver" in window) {
    io = new IntersectionObserver(es => es.forEach(e => { const c = e.target.__c; if (e.isIntersecting) { vis.add(c); preload(c) } else vis.delete(c) }), { rootMargin: "100px" });
    cells.forEach(c => { c.b.__c = c; io.observe(c.b) });
  }
}
var io; const vis = new Set(); const pre = new Set();
function preload(c) { for (const s of Object.values(c.p.sprites)) if (!pre.has(s)) { pre.add(s); new Image().src = s } }

function update() {
  reindex();
  const per = groups.map(() => 0), total = groups.map(r => r.items.length);
  const q = query.trim().toLowerCase(), qn = /^#?\d+$/.test(q) ? parseInt(q.replace("#", ""), 10) : null;
  const fresh = []; const now = new Set();
  for (const c of cells) {
    const es = entriesOf(c.p.id), ok = es.length > 0, b = c.b;
    b.classList.toggle("ok", ok); b.classList.toggle("miss", !ok); c.ok = ok;
    const dots = b.querySelector(".dots"), gen = b.querySelector(".gen"), old = b.querySelector(".cp"); if (old) old.remove();
    dots.replaceChildren();
    if (ok) {
      per[groups.indexOf(c.r)]++; now.add(c.p.id);
      const sorted = es.sort((a, z) => gameRank(a[0]) - gameRank(z[0])), best = sorted.reduce((a, z) => spriteGen(G[z[0]]) >= spriteGen(G[a[0]]) ? z : a);
      const sp = spriteFor(c.p, best[0]); c.img.src = sp.src; b.style.setProperty("--gc", G[best[0]].c[0]);
      const oldS = b.querySelector(".shn"); if (oldS) oldS.remove();
      const shEs = es.filter(([g, e]) => e.sh > 0 && G[g].gen !== 1 && c.p.shinySprites && c.p.shinySprites[spriteGen(G[g])]); // a shiny copy: show the shiny sprite
      if (shEs.length) { const sb = shEs.reduce((a, z) => spriteGen(G[z[0]]) >= spriteGen(G[a[0]]) ? z : a); c.img.src = c.p.shinySprites[spriteGen(G[sb[0]])]; const bd = el("i", "shn", "✦"); bd.setAttribute("aria-hidden", "true"); b.appendChild(bd) }
      c.shiny = shEs.length > 0;
      sorted.slice(0, 4).forEach(([g]) => dots.appendChild(dot(G[g]))); if (sorted.length > 4) dots.appendChild(el("small", "", "+" + (sorted.length - 4)));
      gen.hidden = true; const copies = es.reduce((n, [, e]) => n + e.p + e.b + e.d, 0);
      if (copies > 1) { const cp = el("i", "cp", "×" + copies); cp.setAttribute("aria-hidden", "true"); b.appendChild(cp) }
      b.setAttribute("aria-label", c.p.name + ", number " + c.p.id + (c.shiny ? ", shiny" : "") + ", caught in " + sorted.map(([g]) => G[g].name).join(", "));
      if (!seen.has(c.p.id)) fresh.push(c);
    } else {
      { const oldS = b.querySelector(".shn"); if (oldS) oldS.remove() } showCycle(c); b.setAttribute("aria-label", c.p.name + ", number " + c.p.id + ", not caught");
    }
    const name = c.p.name.toLowerCase(), hit = !q || (qn != null ? c.p.id === qn : name.includes(q));
    b.hidden = !hit || (status === "caught" && !ok) || (status === "missing" && ok);
  }
  fresh.slice(0, 60).forEach((c, i) => { if (reduce) return; c.b.style.setProperty("--d", Math.min(i * 0.012, 0.5) + "s"); c.b.classList.remove("in"); void c.b.offsetWidth; c.b.classList.add("in") });
  seen = now;
  let any = false;
  const caught = now.size;
  groups.forEach((r, i) => {
    const first = cells.find(c => c.r === r); first.count.textContent = per[i] + " / " + total[i];
    const some = cells.some(c => c.r === r && !c.b.hidden); first.head.hidden = first.grid.hidden = !some; any = any || some;
  });
  $("none").hidden = any;
  $("bn").textContent = caught; $("pf").style.width = (caught / MAX * 100) + "%";
  const pr = $("pr"); pr.setAttribute("aria-valuenow", caught); pr.setAttribute("aria-valuetext", caught + " of " + MAX);
  const total2 = saves.reduce((n, s) => n + s.mons.length, 0);
  $("stat").textContent = saves.length ? Math.round(caught / MAX * 1000) / 10 + "% complete · " + total2.toLocaleString("en-US") + " Pokémon in " + saves.length + (saves.length === 1 ? " save" : " saves") + (sel.size ? " · filtered by game" : "") : "Add a save file to start filling your dex.";
  renderSaves(); renderGames();
}
// Missing Pokémon cycle through the sprite of every generation they have.
function showCycle(c) {
  const s = c.cyc, i = (tick + c.off) % s.length; c.img.src = c.p.sprites[s[reduce ? s.length - 1 : i]];
  const g = c.b.querySelector(".gen"); g.textContent = ROMAN[s[reduce ? s.length - 1 : i]]; g.hidden = s.length < 2;
}
// Cycling only runs while the tab is visible and focused, no dialog is open, and the person has touched the page in the last minute.
let lastInput = Date.now();
["pointermove", "pointerdown", "keydown", "wheel", "touchstart", "scroll"].forEach(t => addEventListener(t, () => { lastInput = Date.now() }, { passive: true, capture: true }));
function cycle() {
  if (reduce || document.hidden || !document.hasFocus() || $("dlg").open || Date.now() - lastInput > 60000) return; tick++;
  for (const c of vis) if (!c.ok && c.cyc.length > 1) showCycle(c);
}
setInterval(cycle, 2400);

/* ---------- sidebar ---------- */
function renderSaves() {
  const ul = $("saves"); ul.replaceChildren();
  for (const s of saves) {
    const li = el("li", "sv"), tx = el("div", "tx"), n = s.mons.length;
    const meta = el("small", "meta"), fn = el("span", "fn", s.name), np = el("span", "np", "· " + n.toLocaleString("en-US") + " Pokémon");
    fn.title = s.name; np.title = s.eggs ? s.eggs + (s.eggs === 1 ? " egg" : " eggs") + " not counted" : "";
    meta.append(fn, np); tx.append(el("b", "", s.label), meta); li.title = s.name + " · " + n.toLocaleString("en-US") + " Pokémon" + (s.eggs ? " · " + s.eggs + " eggs not counted" : "");
    const x = el("button", "x"); x.type = "button"; x.setAttribute("aria-label", "Remove " + s.label + " save " + s.name);
    x.innerHTML = '<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
    x.onclick = () => {
    const at = saves.indexOf(s); saves.splice(at, 1);
    const wait = dupes.findIndex(d => d.sig === s.sig); let promoted = null;
    if (wait >= 0) { promoted = dupes.splice(wait, 1)[0]; saves.splice(at, 0, promoted) } // a duplicate of it was waiting: load that one
    store(); update();
    toast(promoted ? "Removed " + s.name + ". Loaded " + promoted.name + " instead." : "Removed " + s.label, { label: "Undo", run: () => {
      if (promoted) { const i = saves.indexOf(promoted); if (i >= 0) saves.splice(i, 1); dupes.push(promoted) }
      saves.splice(at, 0, s); store(); update() } });
  };
    li.append(dot(G[s.game] || G.unknown), tx, x); ul.appendChild(li);
  }
}
function renderGames() {
  const box = $("gl"); box.replaceChildren();
  const per = {}; for (const [n, m] of idx) for (const g of m.keys()) per[g] = (per[g] || 0) + 1;
  const present = new Set(); saves.forEach(s => s.mons.forEach(m => present.add(m.g)));
  for (let gen = 1; gen <= 9; gen++) {
    const gs = GAMES.filter(g => g.gen === gen && (gen <= 3 || present.has(g.id) || sel.has(g.id)));
    if (!gs.length) continue;
    box.appendChild(el("div", "gg", "Generation " + ROMAN[gen]));
    const row = el("div", "gc"); row.setAttribute("role", "group"); row.setAttribute("aria-label", "Generation " + ROMAN[gen] + " games");
    for (const g of gs) row.appendChild(chip(g, per[g.id] || 0));
    box.appendChild(row);
  }
  if (present.has("unknown")) { box.appendChild(el("div", "gg", "Other")); const row = el("div", "gc"); row.appendChild(chip(G.unknown, per.unknown || 0)); box.appendChild(row) }
  const act = sel.size + (order !== "national" ? 1 : 0); $("gsum").textContent = act + " active"; $("gsum").hidden = !act; $("gclr").hidden = !act;
}
function chip(g, n) {
  const b = el("button", "chip" + (n ? "" : " z")); b.type = "button"; b.setAttribute("aria-pressed", sel.has(g.id));
  b.append(dot(g), el("span", "", g.name), el("small", "", String(n)));
  b.setAttribute("aria-label", g.name + ", " + n + " caught"); b.onclick = () => { sel.has(g.id) ? sel.delete(g.id) : sel.add(g.id); store(); update() };
  return b;
}
$("gclr").onclick = () => { sel.clear(); if (order !== "national") { order = "national"; document.querySelectorAll("#srt button").forEach(x => x.setAttribute("aria-pressed", x.dataset.v === "national")); seen = new Set(); buildGrid() } store(); update() };

/* ---------- sort ---------- */
document.querySelectorAll("#srt button").forEach(b => b.onclick = () => { order = b.dataset.v; document.querySelectorAll("#srt button").forEach(x => x.setAttribute("aria-pressed", x === b)); seen = new Set(); buildGrid(); update() });
/* ---------- toolbar ---------- */
$("q").oninput = e => { query = e.target.value; update() };
const seg = $("seg"), th = el("i", "thumb"); seg.appendChild(th);
function thumb(anim) {
  const a = seg.querySelector("button[aria-pressed=true]"); if (!a) return;
  th.classList.toggle("ready", anim); th.style.width = a.offsetWidth + "px"; th.style.height = a.offsetHeight + "px"; th.style.transform = `translate(${a.offsetLeft}px,${a.offsetTop}px)`;
}
seg.querySelectorAll("button").forEach(b => b.onclick = () => { status = b.dataset.v; seg.querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", x === b)); thumb(true); update() });
thumb(false); requestAnimationFrame(() => thumb(true)); addEventListener("resize", () => thumb(false));

/* ---------- detail ---------- */
// Extra data (stats, moves, learnsets, encounters, item and place names) loads on first use.
let extra = null;
function loadExtra() {
  if (extra) return extra;
  if (typeof EXTRA !== "undefined") return extra = Promise.resolve(EXTRA);
  return extra = fetch("data/dexcheck.json").then(r => r.json());
}
const VG = { rb: "red-blue", yellow: "yellow", gs: "gold-silver", crystal: "crystal", ruby: "ruby-sapphire", sapphire: "ruby-sapphire", emerald: "emerald", firered: "firered-leafgreen", leafgreen: "firered-leafgreen" };
const VERS = { rb: ["red", "blue"], gs: ["gold", "silver"] };
const REGION_NAME = { kanto: "Kanto", johto: "Johto", hoenn: "Hoenn" };
function dexLine(p) { // National number plus each regional number, under the name
  const d = el("div", "dexn"); d.appendChild(el("span", "", "National #" + pad(p.id)));
  for (const [k, n] of Object.entries(p.dex || {})) d.appendChild(el("span", "", (REGION_NAME[k] || title(k)) + " #" + pad(n)));
  return d;
}
const nick = (p, m) => m.nn && m.nn.toLowerCase() !== p.name.toLowerCase() ? m.nn : p.name;
const BALL3 = { 1: "master", 2: "ultra", 3: "great", 4: "poke", 5: "safari", 6: "net", 7: "dive", 8: "nest", 9: "repeat", 10: "timer", 11: "luxury", 12: "premier" };
const BALL_NAME = { poke: "Poké Ball", great: "Great Ball", ultra: "Ultra Ball", master: "Master Ball", safari: "Safari Ball", net: "Net Ball", dive: "Dive Ball", nest: "Nest Ball", repeat: "Repeat Ball", timer: "Timer Ball", luxury: "Luxury Ball", premier: "Premier Ball" };
function ballOf(m) { // small icon of the ball it was caught in (recorded from Generation III on)
  const k = BALL3[m.bl]; if (!k) return null; const i = el("img", "ball"); i.alt = BALL_NAME[k]; i.title = "Caught in a " + BALL_NAME[k];
  i.src = typeof BALL_DATA !== "undefined" ? BALL_DATA[k] : "assets/balls/" + k + "-ball.png"; i.width = i.height = 24; return i;
}
const GK = { 2: "ii", 3: "iii" };
const GENN = ["", "i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix"];
const title = s => s.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase());
const SPD = { hp: "HP", attack: "Atk", defense: "Def", "special-attack": "SpA", "special-defense": "SpD", speed: "Spe" };
const GROWTH = { fast: n => 4 * n ** 3 / 5, medium: n => n ** 3, "medium-slow": n => 6 / 5 * n ** 3 - 15 * n * n + 100 * n - 140, slow: n => 5 * n ** 3 / 4,
  "slow-then-very-fast": n => n <= 50 ? n ** 3 * (100 - n) / 50 : n <= 68 ? n ** 3 * (150 - n) / 100 : n <= 98 ? n ** 3 * Math.floor((1911 - 10 * n) / 3) / 500 : n ** 3 * (160 - n) / 100,
  "fast-then-very-slow": n => n <= 15 ? n ** 3 * (Math.floor((n + 1) / 3) + 24) / 50 : n <= 36 ? n ** 3 * (n + 14) / 50 : n ** 3 * (Math.floor(n / 2) + 32) / 50 };
const levelOf = (m, rec) => { if (m.lv) return m.lv; if (m.exp == null) return null; const f = GROWTH[rec.growthRate] || GROWTH.medium; let l = 1; while (l < 100 && f(l + 1) <= m.exp) l++; return l };
const NAT = ["Hardy", "Lonely", "Brave", "Adamant", "Naughty", "Bold", "Docile", "Relaxed", "Impish", "Lax", "Timid", "Hasty", "Serious", "Jolly", "Naive", "Modest", "Mild", "Quiet", "Bashful", "Rash", "Calm", "Gentle", "Sassy", "Careful", "Quirky"];
function genderOf(m, rec, gen) {
  const r = rec.genderRate; if (r < 0) return "Genderless"; if (r === 0) return "Male"; if (r === 8) return "Female";
  if (gen === 2) return m.dv[0] < r * 2 ? "Female" : "Male";
  if (gen === 3) return (m.pid & 255) < r * 32 - 1 ? "Female" : "Male";
  return "";
}
// Stats in the order HP, Atk, Def, SpA, SpD, Spe (current base stats; Gen I-II use the Gen II formula).
function calc(m, rec, gen) {
  const B = rec.baseStats, L = levelOf(m, rec); if (!L) return null;
  const base = [B.hp, B.attack, B.defense, B["special-attack"], B["special-defense"], B.speed];
  if (gen === 1 && rec.gen1Special) base[3] = base[4] = rec.gen1Special; // Gen I has one Special stat
  if (gen <= 2) {
    const [da, dd, ds, dc] = m.dv, dh = ((da & 1) << 3) | ((dd & 1) << 2) | ((ds & 1) << 1) | (dc & 1), [eh, ea, ed, es, ec] = m.ev.map(e => Math.floor(Math.ceil(Math.min(255, Math.sqrt(e))) / 4));
    const dv = [dh, da, dd, dc, dc, ds], ev = [eh, ea, ed, ec, ec, es];
    return base.map((b, i) => Math.floor(((b + dv[i]) * 2 + ev[i]) * L / 100) + (i ? 5 : L + 10));
  }
  const n = m.pid % 25, up = Math.floor(n / 5), dn = n % 5, map = [null, 0, 1, 3, 4, 2];
  return base.map((b, i) => { const v = Math.floor((2 * b + m.iv[i] + Math.floor(m.ev[i] / 4)) * L / 100); if (!i) return v + L + 10; const k = map[i], f = up === dn ? 1 : k === up ? 1.1 : k === dn ? .9 : 1; return Math.floor((v + 5) * f) });
}
const slug = n => n.toLowerCase().replace(/[^a-z]/g, "");
function abilityInfo(x, name) { const id = Object.keys(x.abilities).find(k => slug(x.abilities[k].name) === slug(name)); return id ? x.abilities[id] : { name: title(name), effect: "" } }
// Abilities began in Generation III; hidden abilities in Generation V.
function abilitiesFor(rec, gen) {
  if (gen <= 2) return [];
  if (gen <= 4) return (rec.gen3Abilities || []).map(n => ({ name: n, hidden: false }));
  return (rec.abilitySlots || []).map(a => ({ name: a.name, hidden: a.hidden }));
}
function ownAbility(x, rec, m, gen) { // the ability this particular Pokémon has
  if (gen === 3 && m.abs != null) { const l = rec.gen3Abilities || []; const n = l[m.abs] || l[0]; return n ? { ...abilityInfo(x, n), hidden: false } : null }
  if (gen >= 4 && m.ab) { const a = x.abilities[m.ab]; return a ? { ...a, hidden: m.abn === 4 } : null }
  return null;
}
// Damage multipliers against this Pokémon, using the type chart of its game's generation.
function matchups(x, types, gen) {
  const c = x.typechart[String(Math.min(gen, 3))]; if (!c) return null; const out = { 4: [], 2: [], .5: [], .25: [], 0: [] };
  for (const a of c.types) { const k = types.reduce((v, d) => v * (c.chart[a][d] == null ? 1 : c.chart[a][d]), 1); if (out[k]) out[k].push(a) }
  return out;
}
function matchupBlock(mu) {
  const box = el("div", "mu"), rows = [["Weak to", [[4, "×4"], [2, "×2"]]], ["Resists", [[.5, "×½"], [.25, "×¼"]]], ["Immune to", [[0, "×0"]]]];
  for (const [label, groups] of rows) {
    const row = el("div", "mur"), chips = el("div", "muc"); row.appendChild(el("span", "mul", label));
    for (const [k, txt] of groups) for (const t of mu[k]) { const c = chipT(t); c.appendChild(el("b", "", txt)); chips.appendChild(c) }
    if (!chips.childNodes.length) chips.appendChild(el("span", "none2", "None"));
    row.appendChild(chips); box.appendChild(row);
  }
  return box;
}
function typesFor(rec, gen) {
  const past = (rec.pastTypes || []).find(t => GENN.indexOf(t.untilGeneration.split("-")[1]) >= gen); return past ? past.types : rec.types;
}
const TYPE_COLOR = { normal: "#8d8d86", fire: "#e5612a", water: "#3d7dd8", electric: "#e0b01c", grass: "#3a8d42", ice: "#4fb3c4", fighting: "#c0392b", poison: "#9b4fb8", ground: "#b08a4a", flying: "#7a8fe0", psychic: "#e0457b", bug: "#7f9c1e", rock: "#a39254", ghost: "#6a5aa8", dragon: "#5b46d6", dark: "#4a4a52", steel: "#6c8aa0", unknown: "#8e8e93" };
function radar(vals, color) {
  const C = 120, R = 78, ang = i => (-90 + i * 60) * Math.PI / 180, pt = (i, k) => [C + Math.cos(ang(i)) * R * k, C + Math.sin(ang(i)) * R * k];
  const order = [0, 1, 2, 3, 4, 5], lab = ["HP", "Atk", "Def", "SpA", "SpD", "Spe"];
  const ring = k => order.map(i => pt(i, k).join(",")).join(" "), mx = Math.max(140, ...vals) * 1.05;
  const line = "fill:none;stroke:var(--mu);stroke-opacity:.45";
  let g = [1 / 3, 2 / 3, 1].map(k => `<polygon points="${ring(k)}" style="${line}"/>`).join("") + order.map(i => `<line x1="${C}" y1="${C}" x2="${pt(i, 1)[0]}" y2="${pt(i, 1)[1]}" style="${line}"/>`).join("");
  g += `<polygon points="${vals.map((v, i) => pt(i, v / mx).join(",")).join(" ")}" fill="${color}" fill-opacity=".42" stroke="${color}" stroke-width="2.5" stroke-linejoin="round"/>`;
  g += lab.map((t, i) => { const [x, y] = pt(i, 1.2); return `<text x="${x}" y="${y}" style="fill:var(--tx)" font-size="12" font-weight="600" text-anchor="middle" dominant-baseline="middle">${t} ${vals[i]}</text>` }).join("");
  return `<svg viewBox="0 0 240 240" role="img" aria-label="Stats chart: ${lab.map((t, i) => t + " " + vals[i]).join(", ")}">${g}</svg>`;
}
const chipT = t => { const c = el("span", "ty", title(t)); c.dataset.t = t; return c };
const mvAt = (m, vg) => m && m.vg && m.vg[vg] ? { ...m, ...m.vg[vg] } : m; // power, type, accuracy and PP as in that game
function moveRow(mv, lead) {
  const li = el("li", "mv"); if (lead != null) li.appendChild(el("b", "lv", String(lead)));
  li.append(el("span", "mvn", mv ? mv.name : "—")); if (mv) { li.appendChild(chipT(mv.type)); li.appendChild(el("small", "", (mv.power || "—") + " pow · " + (mv.accuracy || "—") + "%")) } return li;
}
const sec = (h, kids) => { const d = el("details", "ls"); const sm = el("summary", "dis"); sm.append(el("span", "dlab", h), el("i", "chv")); d.appendChild(sm); const ul = el("ul", "ml"); kids.forEach(k => ul.appendChild(k)); d.appendChild(ul); return d };

function detail(p) {
  const dl = $("dl"), dv = $("dv"); dl.hidden = false; dv.hidden = true;
  $("dt").textContent = p.name; $("dn").replaceChildren(dexLine(p)); $("dn").hidden = false;
  $("dlg").dataset.mode = "list";
  const ds = $("ds"); ds.replaceChildren();
  for (const [g, src] of Object.entries(p.sprites)) { const f = el("figure"), i = el("img"); i.src = src; i.alt = p.name + " sprite, generation " + ROMAN[g]; f.append(i, el("figcaption", "", "Gen " + ROMAN[g])); ds.appendChild(f) }
  const ul = $("dc"); ul.replaceChildren(); $("dlg").querySelector("h3").textContent = "Caught";
  const mons = saves.flatMap(sv => sv.mons.filter(m => m.n === p.id && (!sel.size || sel.has(m.g))).map(m => ({ m, file: sv.name })));
  const old = $("dw"); if (old) old.remove();
  if (!mons.length) {
    ul.appendChild(el("li", "e", "Not caught in any loaded save yet."));
    const wait = el("p", "e", "Loading where to find…"); wait.id = "dw"; $("dl").appendChild(wait);
    loadExtra().then(x => { const w = whereToFind(p, x); w.id = "dw"; w.open = true; if (wait.isConnected) wait.replaceWith(w) }); // missing: show where to find it
  } else {
    loadExtra();
    for (const g of [...new Set(mons.map(x => x.m.g))].sort((a, z) => gameRank(a) - gameRank(z))) {
      const h = el("li", "dg"); h.append(dot(G[g]), el("b", "", "Pokémon " + G[g].name)); ul.appendChild(h);
      for (const { m, file } of mons.filter(x => x.m.g === g)) {
        const li = el("li", "dm"), can = m.mv || m.pid != null, b = el(can ? "button" : "div", "row"); if (can) b.type = "button";
        const parts = [p.name]; const gen = G[g].gen;
        b.append(el("span", "rn", nick(p, m))); const sub = el("small", "");
        sub.textContent = ["In " + SRC[m.s], file].join(" · "); b.appendChild(sub);
        li.appendChild(b); ul.appendChild(li);
        if (can) { b.onclick = () => showMon(p, m, g); loadExtra().then(x => { const rec = x.stats[p.id], lv = levelOf(m, rec), loc = (x.locs[GK[gen]] || {})[m.loc]; b.querySelector(".rn").textContent = nick(p, m) + (m.sh ? " ✦" : "") + (lv ? " · Lv. " + lv : "") + (loc ? " · " + loc : ""); }) }
      }
    }
  }
  if (!$("dlg").open) $("dlg").showModal();
}
const GAME_COLOR = { red: "rb", blue: "rb", yellow: "yellow", gold: "gs", silver: "gs", crystal: "crystal", ruby: "ruby", sapphire: "sapphire", emerald: "emerald", firered: "firered", leafgreen: "leafgreen" };
const GAME_ORDER = ["red", "blue", "yellow", "gold", "silver", "crystal", "ruby", "sapphire", "emerald", "firered", "leafgreen"], GAME_NAME = { red: "Red", blue: "Blue", yellow: "Yellow", gold: "Gold", silver: "Silver", crystal: "Crystal", ruby: "Ruby", sapphire: "Sapphire", emerald: "Emerald", firered: "FireRed", leafgreen: "LeafGreen" };
const METHOD = { walk: "Grass", surf: "Surfing", "old-rod": "Old Rod", "good-rod": "Good Rod", "super-rod": "Super Rod", "rock-smash": "Rock Smash", "headbutt-low": "Headbutt (low)", "headbutt-normal": "Headbutt (normal)", "headbutt-high": "Headbutt (high)", "headbutt": "Headbutt", "npc-trade": "Trade", gift: "Gift", "gift-egg": "Gift egg", static: "Static", "roaming-grass": "Roaming", "roaming-water": "Roaming", seaweed: "Seaweed", "feebas-tile-fishing": "Fishing (Feebas tile)", pokeflute: "Poké Flute", "squirt-bottle": "Squirtbottle", "wailmer-pail": "Wailmer Pail", "devon-scope": "Devon Scope" };
const condText = c => ({ "tree-low": "Low trees", "tree-normal": "Normal trees", "tree-high": "High trees", "time-morning": "Morning", "time-day": "Day", "time-night": "Night", "swarm-yes": "Swarm", "weekday-friday": "Fridays" })[c]
  || (/^coins-/.test(c) ? c.slice(6) + " coins" : /^trade-/.test(c) ? "for " + title(c.slice(6)) : /^starter-/.test(c) ? "with " + title(c.slice(8)) + " as starter" : title(c.replace(/^(story-progress|item|tv-option|other)-/, "")));
const areaName = a => title(a.replace(/^(johto|kanto|hoenn|sinnoh)-/, "").replace(/-area$/, "")).replace(/\b(b?\d+f)\b/gi, m => m.toUpperCase());
const lvText = (lo, hi) => "Lv. " + (lo === hi ? lo : lo + "–" + hi);
// One row per area; each way of finding it (grass, surfing, rods...) is a line, with time of day shown when the odds change.
function areasOf(list) {
  const areas = new Map();
  for (let e of list) {
    if (e.conditions.includes("swarm-no")) continue;
    if (/^headbutt-/.test(e.method)) e = { ...e, conditions: [...e.conditions, "tree-" + e.method.slice(9)], method: "headbutt" }; // one Headbutt line, odds per tree type
    const key = areaName(e.area), a = areas.get(key) || { area: e.area, methods: new Map(), top: 0 }, m = a.methods.get(e.method) || [];
    m.push(e); a.methods.set(e.method, m); a.top = Math.max(a.top, e.chance); areas.set(key, a);
  }
  return [...areas.values()].sort((x, y) => y.top - x.top || areaName(x.area).localeCompare(areaName(y.area)));
}
const timeRank = e => { const i = ["time-morning", "time-day", "time-night"].findIndex(t => e.conditions.includes(t)); return i < 0 ? 9 : i };
const dexplorerLink = (game, id) => "Dexplorer.html?game=" + game + "&pokemon=" + id;
// "Where to find": collapsed; opens to the games it appears in, and each game opens to its areas. Areas open Dexplorer when it is available.
function whereToFind(p, x) {
  const outer = el("details", "ls wf"), V = (x.enc[p.id] && x.enc[p.id].versions) || {}, linked = typeof EXTRA === "undefined";
  const sum = el("summary", "dis"); sum.append(el("span", "dlab", "Where to find"), el("small", "cnt", ""), el("i", "chv")); outer.appendChild(sum);
  const games = GAME_ORDER.filter(v => areasOf(V[v] || []).length);
  sum.querySelector(".cnt").textContent = games.length ? games.length + (games.length === 1 ? " game" : " games") : "None";
  if (!games.length) { outer.appendChild(el("p", "e", "Not found in the wild in any Generation I–III game (gift, evolution, trade or event).")); return outer }
  for (const v of games) {
    const areas = areasOf(V[v]), d = el("details", "ls sub");
    const gs = el("summary", "dis"), gd = dot(G[GAME_COLOR[v]]); gs.append(gd, el("span", "dlab", "Pokémon " + GAME_NAME[v]), el("small", "cnt", areas.length + (areas.length === 1 ? " area" : " areas")), el("i", "chv")); d.appendChild(gs);
    const ul = el("ul", "ml");
    for (const a of areas) {
      const row = el(linked ? "a" : "div", "ar"); if (linked) { row.href = dexplorerLink(v, p.id); row.setAttribute("aria-label", areaName(a.area) + ", open in Dexplorer") }
      const body = el("span", "ad"); body.appendChild(el("b", "", areaName(a.area)));
      for (const [method, es] of a.methods) {
        const lo = Math.min(...es.map(e => e.minLevel)), hi = Math.max(...es.map(e => e.maxLevel));
        const odds = es.length === 1 && !es[0].conditions.length ? es[0].chance + "%" : [...es].sort((x, y) => timeRank(x) - timeRank(y)).map(e => (e.conditions.length ? e.conditions.map(condText).join(", ") + " " : "") + e.chance + "%").join(" · ");
        body.appendChild(el("small", "", (METHOD[method] || title(method)) + " · " + lvText(lo, hi) + " · " + odds));
      }
      row.appendChild(body); if (linked) { const c = el("span", "chev", "›"); c.setAttribute("aria-hidden", "true"); row.appendChild(c) }
      const li = el("li"); li.appendChild(row); ul.appendChild(li);
    }
    d.appendChild(ul); outer.appendChild(d);
  }
  return outer;
}
function showMon(p, m, g) {
  loadExtra().then(x => {
    $("dn").hidden = true; const vg0 = VG[g], rec = x.stats[p.id], gen = G[g].gen, lv = levelOf(m, rec), dv = $("dv"); dv.replaceChildren(); $("dl").hidden = true; dv.hidden = false;
    const back = el("button", "link", "‹ " + p.name); back.type = "button"; back.onclick = () => detail(p); dv.appendChild(back);
    const sg = Math.min(gen, 3), shinyOk = !!(p.shinySprites && p.shinySprites[sg]); let shiny = !!m.sh && shinyOk; // a shiny copy opens in shiny colours
    const art = el("div", "hero"), img = el("img");
    const setImg = () => { img.src = (shiny ? p.shinySprites[sg] : p.sprites[sg] || Object.values(p.sprites).pop()); img.alt = (shiny ? "Shiny " : "") + p.name }; setImg(); art.appendChild(img);
    if (shinyOk) {
      const tg = el("div", "tog"), b1 = el("button", "", "Normal"), b2 = el("button", "", "✦ Shiny"); tg.setAttribute("role", "group"); tg.setAttribute("aria-label", "Sprite colours");
      const sync = () => { b1.setAttribute("aria-pressed", !shiny); b2.setAttribute("aria-pressed", shiny); setImg() };
      [b1, b2].forEach(b => b.type = "button"); b1.onclick = () => { shiny = false; sync() }; b2.onclick = () => { shiny = true; sync() };
      tg.append(b1, b2); sync(); art.appendChild(tg);
    }
    const meta = el("div", "meta"), t = el("div", "tys"); typesFor(rec, gen).forEach(k => t.appendChild(chipT(k)));
    const gd = genderOf(m, rec, gen), table = x.locs[GK[gen]] || {}, it = (x.items[GK[gen]] || {})[m.it];
    const SPECIAL_LOC = { 253: "In-game trade", 254: "Fateful encounter", 255: "Not recorded" }, TOD = { 1: "Morning", 2: "Day", 3: "Night" };
    const loc = m.loc == null ? null : gen === 3 && SPECIAL_LOC[m.loc] ? SPECIAL_LOC[m.loc] : table[m.loc] || (m.loc === 0 && gen === 2 ? "Unknown" : "Unknown (#" + m.loc + ")");
    const met = m.mlv ? "Lv. " + m.mlv + (gen === 2 && TOD[m.tod] ? " · " + TOD[m.tod] : "") : null;
    const kv = [["Level", lv], ["Gender", gd || "—"], ["Nature", m.pid != null ? NAT[m.pid % 25] : null], ["Held item", gen === 1 ? null : m.it ? it || "Item #" + m.it : "None"], ["Met location", loc], ["Met level", met], ["Game", "Pokémon " + G[g].name]];
    const dl = el("dl", "kv"); kv.filter(r => r[1]).forEach(([k, v]) => { dl.append(el("dt", "", k), el("dd", "", String(v))) });
    if (m.fr != null) { // friendship: value with a small meter
      const dd = el("dd", "fr"), bar = el("span", "fmeter"), fill = el("i"); fill.style.width = Math.round(m.fr / 255 * 100) + "%"; bar.appendChild(fill);
      bar.setAttribute("role", "img"); bar.setAttribute("aria-label", "Friendship " + m.fr + " of 255"); dd.append(el("span", "", m.fr + " / 255"), bar); dl.append(el("dt", "", "Friendship"), dd);
    }
    const head = el("h3", "", nick(p, m)), bs = ballOf(m); if (bs) head.appendChild(bs); if (m.sh) head.appendChild(el("span", "shtag", "✦ Shiny"));
    meta.append(head, nick(p, m) !== p.name ? el("p", "stat", p.name) : el("span"), dexLine(p), t, dl); const top = el("div", "top"); top.append(art, meta); dv.appendChild(top);
    const mtx = matchups(x, typesFor(rec, gen), gen); if (mtx) { dv.appendChild(el("h3", "", "Type matchups")); dv.appendChild(matchupBlock(mtx)) }
    const own = ownAbility(x, rec, m, gen), pool = abilitiesFor(rec, gen);
    if (own || pool.length) {
      dv.appendChild(el("h3", "", "Abilities")); const al = el("ul", "ml");
      if (own) { const li = el("li", "ab own"); li.append(el("b", "", own.name + (own.hidden ? " · Hidden" : "")), el("small", "", own.effect || "")); al.appendChild(li) }
      for (const a of pool) { const info = abilityInfo(x, a.name); if (own && slug(own.name) === slug(info.name)) continue; const li = el("li", "ab"); li.append(el("b", "", info.name + (a.hidden ? " · Hidden" : "")), el("small", "", info.effect || "")); al.appendChild(li) }
      dv.appendChild(al);
    } else if (gen <= 2) dv.appendChild(el("p", "e", "Abilities were introduced in Generation III."));
    const st = calc(m, rec, gen); if (st) { const c = el("div", "radar"); c.innerHTML = radar(st, TYPE_COLOR[typesFor(rec, gen)[0]] || TYPE_COLOR.unknown); dv.appendChild(el("h3", "", "Stats")); dv.appendChild(c) }
    const mv = (m.mv || []).filter(Boolean).map(id => moveRow(mvAt(x.moves[id], vg0))); dv.appendChild(el("h3", "", "Moves")); const mu = el("ul", "ml"); (mv.length ? mv : [el("li", "e", "No moves recorded")]).forEach(k => mu.appendChild(k)); dv.appendChild(mu);
    const vg = VG[g], L = x.learn[p.id] && (x.learn[p.id].versionGroups[g] || x.learn[p.id].versionGroups[vg]);
    if (L) {
      dv.appendChild(el("h3", "", "Moveset"));
      dv.appendChild(sec("Level up (" + L["level-up"].length + ")", L["level-up"].map(([l, id]) => moveRow(mvAt(x.moves[id], vg0), l ? "Lv. " + l : "—"))));
      dv.appendChild(sec("Egg moves (" + L.egg.length + ")", L.egg.length ? L.egg.map(id => moveRow(mvAt(x.moves[id], vg0))) : [el("li", "e", "None")]));
      dv.appendChild(sec("TM / HM / Tutor (" + (L.machine.length + L.tutor.length) + ")", [...L.machine, ...L.tutor].map(id => moveRow(mvAt(x.moves[id], vg0)))));
    } else dv.appendChild(el("p", "e", "Moveset data covers Generation I–III games for now."));
    dv.appendChild(whereToFind(p, x));
    dv.scrollIntoView({ block: "start" }); $("dlg").scrollTop = 0;
  });
}
$("dx").onclick = () => $("dlg").close();
$("dlg").addEventListener("click", e => { if (e.target === $("dlg")) $("dlg").close() });

/* ---------- adding files ---------- */
const issues = $("issues");
function issue(name, why) {
  const li = el("li", "is"), tx = el("div", "tx"); tx.append(el("b", "", name), el("span", "", why));
  const x = el("button", "x"); x.type = "button"; x.setAttribute("aria-label", "Dismiss"); x.innerHTML = '<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'; x.onclick = () => li.remove();
  li.append(tx, x); issues.appendChild(li);
}
async function addFiles(list) {
  const files = [...list]; if (!files.length) return;
  const add = $("add"); add.setAttribute("aria-busy", "true"); add.querySelector("span").textContent = "Reading…"; issues.replaceChildren();
  let added = 0, mons = 0;
  for (const f of files) {
    await new Promise(r => setTimeout(r, 0));
    if (f.size > 8 * 1024 * 1024) { issue(f.name, "This file is too large to be a save file. It was not added."); continue }
    let r; try { r = SaveReader.parse(await f.arrayBuffer()) } catch (e) { r = { ok: false, reason: "The file could not be read." } }
    if (!r.ok) { issue(f.name, r.reason + " It was not added."); continue }
    const sig = r.label + "|" + r.mons.map(m => m.n + m.g + m.s).join(",");
    const rec = { fmt: 2, id: Date.now() + "-" + added, sig, name: f.name, label: r.label, gen: r.gen, game: r.game || (r.mons[0] && r.mons[0].g) || "unknown", mons: r.mons, eggs: r.eggs };
    const twin = saves.find(s => s.sig === sig);
    if (twin) { if (!dupes.some(d => d.sig === sig && d.name === f.name)) dupes.push(rec); store(); issue(f.name, "Same Pokémon as " + twin.name + ", so it is not shown twice. It loads automatically if that save is removed."); continue }
    saves.push(rec);
    added++; mons += r.mons.length;
  }
  add.removeAttribute("aria-busy"); add.querySelector("span").textContent = "Add Save Files";
  if (added) { store(); update(); toast("Added " + added + (added === 1 ? " save" : " saves") + " · " + mons.toLocaleString("en-US") + " Pokémon") }
  else if (files.length) toast("No save files were added");
}
$("add").onclick = () => $("file").click();
$("file").onchange = e => { addFiles(e.target.files); e.target.value = "" };
const drop = $("drop"), hasFiles = e => e.dataTransfer && [...e.dataTransfer.types].includes("Files");
let dropT; const hideDrop = () => { clearTimeout(dropT); drop.hidden = true };
// dragover repeats while a file is held over the page; when it stops (left the window, cancelled) the overlay goes away on its own
addEventListener("dragover", e => { if (hasFiles(e)) { e.preventDefault(); drop.hidden = false; clearTimeout(dropT); dropT = setTimeout(hideDrop, 400) } });
addEventListener("drop", e => { if (hasFiles(e)) { e.preventDefault(); hideDrop(); addFiles(e.dataTransfer.files) } });
["dragend", "pointerdown", "keydown", "blur"].forEach(t => addEventListener(t, hideDrop));
document.addEventListener("dragstart", e => { if (e.target.tagName === "IMG") e.preventDefault() }); // dragging a sprite is not adding a file

/* ---------- start ---------- */
restore();
(window.requestIdleCallback || setTimeout)(() => loadExtra()); // warm the detail data so pages open instantly
if (outdated) setTimeout(() => { store(); toast("Saves from an earlier version were removed. Add them again to see friendship, Poké Ball and shiny data.") }, 600);
else if (stale()) setTimeout(() => toast("Saves from an older version were cleared. Add them again to see levels, moves and details."), 600);
fetch("data/pokemon.json").then(r => r.json()).then(d => { dex = d.filter(p => p.id <= MAX); buildGrid(); update() })
  .catch(() => { $("stat").textContent = "Could not load the Pokémon list." });
