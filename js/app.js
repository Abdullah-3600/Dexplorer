"use strict";
/* Dexplorer: all content comes from /data. See README.md for the file formats. */
const $ = id => document.getElementById(id), NS = "http://www.w3.org/2000/svg";
const getJSON = async u => { const r = await fetch(u); if (!r.ok) throw new Error(u + " (" + r.status + ")"); return r.json() };
const pad = n => String(n).padStart(3, "0");
const state = { order: "regional", gens: [], regions: [], mons: [], gen: null, opt: null, region: null, games: [], game: null, sel: null, zones: {}, rows: [], maps: [] };
const regionData = {};
const mapsEl = $("maps"), insetsEl = $("insets");
const seg = $("seg"), gb = $("gb"), gm = $("gm"), rw = $("rw"), rb = $("rb"), rm = $("rm"), mb = $("mb"), mn = $("mn");

/* ---------- helpers ---------- */
/* A generation is either single-region ({region, games}) or multi-region ({regions: [{id, name, region, games}]}). */
const optsOf = g => g.regions || [{ id: g.region, name: null, region: g.region, games: g.games }];
const optOk = o => !!o.region && state.regions.some(r => r.id === o.region && !r.pending);
const spriteSrc = m => m.sprites[state.gen.id] || Object.values(m.sprites).pop();
const gameName = id => (state.games.find(g => g.id === id) || {}).name || id;
const heat = r => r.rate == null ? 100 : r.rate;
function mk(t, a) { const e = document.createElementNS(NS, t); for (const k in a) e.setAttribute(k, a[k]); return e }
const scale = () => state.region ? state.region.mapSize[0] / 1130 : 1;
function shape(s, a) {
  return s.type === "circle"
    ? mk("circle", { cx: s.cx, cy: s.cy, r: s.r, ...a })
    : mk("rect", { x: s.x, y: s.y, width: s.w, height: s.h, rx: 10 * scale(), ...(s.rot ? { transform: `rotate(${s.rot} ${s.x + s.w / 2} ${s.y + s.h / 2})` } : {}), ...a });   // optional "rot" (degrees) tilts a rectangle around its centre, for diagonal routes
}
const TIME = { morning: "Morning", day: "Day", night: "Night" };
const tlab = r => r.time && r.time.length < 3 ? " · " + r.time.map(t => TIME[t]).join("/") : "";

/* fmt:start ---------- hover card format ----------
   Every row has the same shape:   Method · detail · time ........ rate
                                   Lv a–b · place
                                   short note (only when there is one)
   Game names are never shown: the game switcher already filters the rows. */
const DETAIL = { "Safari block": "Safari" };
function parts(r) {
  const m = /^(.*?)\s*\((.*)\)$/.exec(r.method);
  if (!m) return [r.method, ""];
  const d = m[2].replace(/ tree$/i, "");
  return [m[1], DETAIL[d] || d.charAt(0).toUpperCase() + d.slice(1)];
}
const mlab = r => { const [b, d] = parts(r); return b + (d ? " · " + d : "") };
const rlab = r => r.rate != null ? r.rate + "%" : "";
function lvl(r) {
  const l = String(r.levels == null ? "" : r.levels).trim();
  if (!l || l === "—") return "";
  if (/^same as/i.test(l)) return "Lv as traded";
  return "Lv " + l.replace(/(\d)-(\d)/g, "$1–$2");
}
function place(r, zone) {
  let s = (r.sublocation || "").replace(/^Pal Park: /, "").replace(/\s*\([^)]*\)\s*$/, "").trim();
  if (zone && s.toLowerCase().startsWith(zone.toLowerCase()) && (s.length === zone.length || /^\s/.test(s.slice(zone.length)))) s = s.slice(zone.length).replace(/^\s*·?\s*/, "");   // the card title already names the zone
  if (!s) return "";
  const seg = s.split(" · "), items = seg[seg.length - 1].split(", ");
  if (items.length > 2) seg[seg.length - 1] = items.length + (items.every(i => /^B?\d+F$/.test(i)) ? " floors" : " areas");
  return seg.join(" · ");
}
const NOTES = [
  [/^Group ([ABC]) \(([a-z]+)[;)].*$/, "Group $1 · $2"],
  [/^Transfer from a Gen III game.*rarity score (\d+)$/, "Rarity $1"],
  [/^Dual-slot: (.+) inserted$/, (_, g) => "Dual-slot: " + (g.split("/").length > 3 ? "any GBA game" : g)],
  [/^Great Marsh daily rotation \((Before|After) National Dex\): on (\d+) of 32 days$/, "$1 National Dex · $2 of 32 days"],
  [/^After National Dex: appears when Mr\. Backlot mentions it.*$/, "After National Dex · Mr. Backlot"],
  [/^Mass outbreak \([a-z]+\)(?:; (.+))?$/, (_, x) => "Mass outbreak" + (x ? " · " + x : "")],
  [/^Fishing swarm: (.+)$/, "Fishing swarm · $1"],
  [/^Roams Hoenn after you enter the Hall of Fame.*$/, "After Hall of Fame"],
  [/^After you become Champion and defeat Team Rocket on Five Island.*started with (\w+)$/, "After Champion · starter $1"],
  [/^Starts roaming once the legendary beasts escape.*Starts on (Route \d+)\.?.*$/, "After Burned Tower · starts on $1"],
  [/^Needs the (.+?) \(event item.*$/, "Event item: $1"],
  [/^.+?, reached with the (.+?) \(event item.*$/, "Event item: $1"],
  [/^Pokémon Colosseum Bonus Disc.*$/, "Colosseum Bonus Disc"],
  [/^Unown forms: (.+)$/, (_, l) => l.split(", ").length > 4 ? "Unown: " + l.split(", ").length + " forms" : "Unown: " + l],
  [/^Trade (?:an? |any )?(.+?)(?:\. The \w+ holds (?:an? )?(.+)|[;.] .*)?$/, (_, g, h) => "Give " + g + (h ? " · holds " + h : "")],
  [/^Odd Egg \(.*\)$/, "Odd Egg · one of these"],
  [/^Egg from the old woman.*hatches at (Lv \d+)$/, "Hatches at $1"],
  [/^Egg given by .*$/, ""],
  [/^Given by an employee after the Silph Co\. rescue$/, "After the Silph Co. rescue"],
  [/^Safari Zone: Inactive$/, "Safari Zone inactive"],
  [/^Safari Zone: .+$/, n => "Safari · " + n.split("; ").map(x => x.replace(/^Safari Zone: /, "")).join(", ")],
  [/^Sleeps in the road; wake it with the (Poké ?Flute)$/, "Wake with the $1"],
  [/^Wake it with the (Poké ?Flute)$/, "Wake with the $1"],
  [/^Blocks the path to Diglett's Cave.*$/, "Wake with the Poké Flute"],
  [/^Invisible until you use the Devon Scope; (\w+) Kecleon on this route$/, "Needs Devon Scope · $1 Kecleon"],
  [/^Only on six random water tiles of Route 119.*$/, "Six random water tiles"],
  [/^Mirage Island appears only on rare days.*$/, "Rare days only"],
  [/^Marine Cave, a hidden cave.*$/, "Hidden cave · Emerald only"],
  [/^Terra Cave, a hidden cave.*$/, "Hidden cave · Emerald only"],
  [/^Needs the Eon Ticket.*$/, "Event item: Eon Ticket"],
  [/^(Ruby|Sapphire)'s legendary, deepest floor of the Cave of Origin$/, "Cave of Origin, deepest floor"],
  [/^Top of Sky Pillar, after the Groudon\/Kyogre event$/, "Sky Pillar top, after Groudon/Kyogre"],
  [/^Given by the Weather Institute scientists.*$/, "Weather Institute scientists"],
  [/^Reachable after the Network Machine event on One Island$/, "After the Network Machine event"],
  [/^Reached through Three Isle Path.*$/, "After National Dex"],
  [/^Kenya the Spearow, from Randy.*$/, "Kenya the Spearow · holds Flower Mail"],
  [/^Shuckie the Shuckle, from the man in Cianwood City$/, "Shuckie the Shuckle"],
  [/^Requires the GS Ball event.*$/, "Event: GS Ball"],
  [/^After solving at least one puzzle.*$/, "After solving a puzzle"],
  [/^After leaving the Vermilion Pokémon Fan Club with Copycat’s doll$/, "After returning Copycat's doll"],
  [/^Two Electrode look like item balls inside the Power Plant$/, "Looks like an item ball"],
  [/^Revive the (\w+ Fossil); Needs (.+) transferred from a Sinnoh game$/, "$1 · from a Sinnoh game"],
  [/^Requires Odd Keystone; Talked to 32 people underground$/, "Odd Keystone · 32 people underground"],
  [/^Trade for Medicham.*$/, "Trade for Medicham"],
  [/^Take the Poké Ball after entering the Hall of Fame$/, "After Hall of Fame"],
  [/^Egg$/, ""],
];
function note(r) {
  let n = (r.note || "").trim();
  if (!n) return "";
  for (const [re, to] of NOTES) if (re.test(n)) { n = typeof to === "function" ? n.replace(re, to) : n.replace(re, to); break }
  n = n.replace(/^After story event: /, "After: ");
  if (n.length > 44) n = n.split(/[;.] | \(/)[0];                 // long text: keep the first clause only
  if (n.length > 44) n = n.slice(0, 41).replace(/[\s,;:.]+\S*$/, "") + "…";
  return n;
}
/* fmt:end */
function setColor() {
  const g = state.games.find(g => g.id === state.game);
  document.documentElement.style.setProperty("--gc", (g && g.color) || "#e63946");
}

/* ---------- encounters ---------- */
function find(id) {
  const m = {};
  for (const r of state.rows) if (r.pokemon === id && r.games.includes(state.game) && state.zones[r.zone]) (m[r.zone] = m[r.zone] || []).push(r);
  return Object.entries(m).map(([k, rows]) => ({ k, z: state.zones[k], rows, peak: Math.max(...rows.map(heat)) }));
}
const dkey = () => (state.region.dexByGame && state.region.dexByGame[state.game]) || state.region.dexKey; // Sinnoh: Diamond/Pearl and Platinum have different regional dexes
const offMap = id => state.rows.filter(r => r.pokemon === id && !r.zone && r.games.includes(state.game));
/* Picking an entry under the map focuses its zone: the rest of that map is dimmed by 30% (a black layer with the zone cut out of it). Picking it again clears the focus. */
let dimN = 0;
function clearDim() {
  state.maps.forEach(m => { if (m.dim) { m.dim.remove(); m.dim = null } if (m.mask) { m.mask.remove(); m.mask = null } });
  document.querySelectorAll("#list .row[aria-pressed=true]").forEach(r => r.setAttribute("aria-pressed", "false"));
}
function focusZone(x, row) {
  const again = row.getAttribute("aria-pressed") === "true";
  clearDim();
  if (again) return;
  const M = state.maps[x.z.m || 0], svg = M.hits.ownerSVGElement, vb = svg.viewBox.baseVal, id = "dim" + ++dimN;
  const mask = mk("mask", { id, maskUnits: "userSpaceOnUse", x: 0, y: 0, width: vb.width, height: vb.height });
  mask.appendChild(mk("rect", { x: 0, y: 0, width: vb.width, height: vb.height, fill: "#fff" }));
  x.z.shapes.forEach(s => mask.appendChild(shape(s, { fill: "#000" })));
  let defs = svg.querySelector("defs"); if (!defs) { defs = mk("defs", {}); svg.prepend(defs) }
  defs.appendChild(mask);
  const dim = mk("rect", { class: "dim", x: 0, y: 0, width: vb.width, height: vb.height, fill: "#000", opacity: .3, mask: `url(#${id})`, "pointer-events": "none" });
  svg.insertBefore(dim, M.hits);
  M.dim = dim; M.mask = mask; row.setAttribute("aria-pressed", "true");
}
/* The focus ends on any click outside the entries under the map, or on Escape. It also resets whenever the Pokémon, game, generation or map changes (draw / setGeneration / buildMaps). */
document.addEventListener("click", e => { if (!e.target.closest || !e.target.closest("#list .row[role=button]")) clearDim() });
document.addEventListener("keydown", e => { if (e.key === "Escape") clearDim() });
function draw() {
  clearDim();
  $("tipbox").hidden = true;
  const L = $("list");
  state.maps.forEach(m => { m.heat.replaceChildren(); m.hits.replaceChildren() }); L.replaceChildren();
  const sel = state.sel;
  if (!sel) { $("t").textContent = "Select a Pokémon"; L.innerHTML = '<p class="empty">Pick a Pokémon to see where it appears.</p>'; return }
  const rn = dkey() && sel.dex && sel.dex[dkey()];
  $("t").textContent = "#" + pad(sel.id) + (rn && rn !== sel.id ? " · #" + pad(rn) : "") + " " + sel.name + " · " + gameName(state.game);
  $("t").classList.remove("pop"); void $("t").offsetWidth; $("t").classList.add("pop");
  const res = find(sel.id).sort((a, b) => b.peak - a.peak);
  if (state.game !== "yellow" && state.gen.id === 1 && res.some(x => x.k === "r21" && x.rows.some(r => r.method === "Walking"))) {
    const t = $("tipbox");
    t.textContent = "Tip (Red/Blue glitch): when you surf on the east shore tiles (water with a shoreline on its left) near Cinnabar Island or the Seafoam Islands, wild Pokémon come from the land table of the last area you visited, such as Route 21, so you can meet " + sel.name + " there. Fixed in Yellow.";
    t.hidden = false;
  }
  const ev = offMap(sel.id);
  if (!res.length && !ev.length) L.innerHTML = '<p class="empty">Not found in the wild in ' + gameName(state.game) + " (evolution, breeding, trade, event or version-exclusive).</p>";
  for (const x of res) {
    const t = Math.sqrt(x.peak / 100);
    const M = state.maps[x.z.m || 0], zname = x.z.name + (x.z.where ? " · " + x.z.where : "");
    x.z.shapes.forEach(s => {
      M.heat.appendChild(shape(s, { fill: `hsl(${215 - 90 * t} ${85 - 15 * t}% ${50 - 8 * t}%)`, opacity: .45 + .5 * t }));
      const h = shape(s, { class: "hit", tabindex: 0, stroke: `hsl(${215 - 90 * t} 80% 26%)`, "aria-label": zname + ": " + x.rows.map(r => mlab(r) + (lvl(r) ? " " + lvl(r) : "") + (rlab(r) ? " " + rlab(r) : "")).join(", ") });
      h.onmousemove = e => tip(e.clientX, e.clientY, x);
      h.onmouseleave = () => $("tip").style.display = "none";
      h.onfocus = () => { const b = h.getBoundingClientRect(); tip(b.right, b.top, x) };
      h.onblur = h.onmouseleave;
      M.hits.appendChild(h);
    });
    const bm = {}; x.rows.forEach(r => bm[mlab(r)] = Math.max(bm[mlab(r)] || 0, heat(r)));
    const d = document.createElement("div"); d.className = "row";
    d.innerHTML = "<b>" + zname + "</b><span>" + Object.entries(bm).map(([m, v]) => m + " " + v + "%").join(" · ") + "</span>";
    d.tabIndex = 0; d.setAttribute("role", "button"); d.setAttribute("aria-pressed", "false"); d.setAttribute("aria-label", "Focus " + zname + " on the map");
    d.onclick = () => focusZone(x, d);
    d.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); focusZone(x, d) } };
    L.appendChild(d);
  }
  for (const r of ev) {   // events and places with no spot on the map: text only
    const d = document.createElement("div"); d.className = "row";
    d.innerHTML = "<b>" + mlab(r) + " · not on the map</b><span>" + [place(r, ""), lvl(r), rlab(r), note(r)].filter(Boolean).join(" · ") + "</span>";
    L.appendChild(d);
  }
}
function tip(cx, cy, x) {
  const e = $("tip");
  const zn = x.z.name;
  e.innerHTML = "<b>" + zn + (x.z.where ? " · " + x.z.where : "") + "</b>" + x.rows.map(r => {
    const sm = [lvl(r), place(r, zn), note(r)].filter(Boolean).join(" · ");   // same shape as before: name and rate on the left, small detail text on the right
    return `<div class="it"><div><span>${mlab(r)}${tlab(r)}</span><span>${rlab(r)}</span></div>${sm ? "<small>" + sm + "</small>" : ""}</div>`;
  }).join("");
  e.style.display = "block";
  e.style.left = Math.max(8, Math.min(cx + 14, innerWidth - e.offsetWidth - 8)) + "px";
  e.style.top = Math.max(8, Math.min(cy + 14, innerHeight - e.offsetHeight - 8)) + "px";
}

/* ---------- Pokémon grid ---------- */
function list(f = "") {
  const u = $("dex"); u.replaceChildren(); f = f.toLowerCase();
  const [lo, hi] = state.region.dex, k = dkey();
  const reg = m => (k && m.dex && m.dex[k]) || null;
  const inRange = state.mons.filter(m => m.id >= lo && m.id <= hi), split = !!k && inRange.some(m => reg(m) && reg(m) !== m.id);   // the sort button only matters when the regional dex differs from the national one
  sortUI(split);
  const byRegion = split && state.order === "regional";
  inRange.filter(m => m.name.toLowerCase().includes(f) || String(m.id).includes(f) || String(reg(m) || "").includes(f))
    .sort((a, b) => byRegion ? (reg(a) || 1e3 + a.id) - (reg(b) || 1e3 + b.id) : a.id - b.id).forEach(m => {
    const b = document.createElement("button"), r = reg(m);
    b.className = "cell"; b.setAttribute("aria-pressed", !!state.sel && state.sel.id === m.id); b.setAttribute("aria-label", m.name);
    b.innerHTML = `<img alt="" src="${spriteSrc(m)}" width="72" height="72" loading="lazy" decoding="async"><small>#${pad(m.id)}${r && r !== m.id ? " · #" + pad(r) : ""}</small><span>${m.name}</span>`;
    b.onclick = () => { state.sel = m; u.querySelectorAll(".cell").forEach(c => c.setAttribute("aria-pressed", c === b)); draw() };
    u.appendChild(b);
  });
}

/* ---------- dex order toggle: text only, National <-> Regional ---------- */
const srt = $("srt");
function sortUI(show) {
  $("srtbar").hidden = !show;
  const cur = state.order === "regional" ? "Regional" : "National", next = cur === "Regional" ? "national" : "regional";
  srt.textContent = cur;
  srt.setAttribute("aria-label", "Dex order: " + cur.toLowerCase() + ". Switch to " + next);
}
srt.onclick = () => {
  state.order = state.order === "regional" ? "national" : "regional";
  list($("q").value);
  const sel = $("dex").querySelector('.cell[aria-pressed="true"]');
  if (sel) sel.scrollIntoView({ block: "center" }); else $("dex").scrollTop = 0;
};

/* ---------- game switcher ---------- */
function thumb(anim) {
  const t = seg.querySelector(".thumb"), a = seg.querySelector("button[aria-pressed=true]");
  if (!t || !a) return;
  t.classList.toggle("ready", anim);
  t.style.width = a.offsetWidth + "px"; t.style.height = a.offsetHeight + "px";
  t.style.transform = `translate(${a.offsetLeft}px,${a.offsetTop}px)`;
}
function buildGames() {
  seg.replaceChildren();
  const t = document.createElement("i"); t.className = "thumb"; seg.appendChild(t);
  state.games.forEach(g => {
    const b = document.createElement("button"); b.textContent = g.name; b.setAttribute("aria-pressed", g.id === state.game);
    b.onclick = () => { state.game = g.id; setColor(); seg.querySelectorAll("button").forEach(c => c.setAttribute("aria-pressed", c === b)); thumb(true); if (state.region.dexByGame) list($("q").value); draw() };
    seg.appendChild(b);
  });
  thumb(false); requestAnimationFrame(() => thumb(true));
}
addEventListener("resize", () => thumb(false));

/* ---------- generation and region menus ---------- */
function setH(el, h) {
  clearTimeout(el._t);
  if (!h) { el.hidden = false; el.classList.remove("out"); return }
  if (el.hidden) return;
  el.classList.add("out"); el._t = setTimeout(() => { el.hidden = true; el.classList.remove("out") }, 120);
}
function dropdown(btn, menu) {
  const items = () => [...menu.querySelectorAll("[role=menuitemradio]:not([aria-disabled=true])")];
  const go = o => {
    setH(menu, !o); btn.setAttribute("aria-expanded", o);
    if (o) { const f = menu.querySelector("[aria-checked=true]") || items()[0]; if (f) f.focus() } else btn.focus();
  };
  btn.onclick = () => go(menu.hidden);
  btn.onkeydown = e => { if (e.key === "ArrowDown") { e.preventDefault(); go(true) } };
  document.addEventListener("click", e => { if (!menu.hidden && !menu.parentNode.contains(e.target)) go(false) });
  menu.onkeydown = e => {
    const it = items(), i = it.indexOf(document.activeElement);
    if (e.key === "Escape") { e.preventDefault(); go(false) }
    else if (e.key === "ArrowDown") { e.preventDefault(); it[(i + 1) % it.length].focus() }
    else if (e.key === "ArrowUp") { e.preventDefault(); it[(i - 1 + it.length) % it.length].focus() }
    else if (e.key === "Tab") go(false);
  };
  return go;
}
const go = dropdown(gb, gm), goRegion = dropdown(rb, rm);
function item(menu, label, checked, ok, pick) {
  const b = document.createElement("button");
  b.setAttribute("role", "menuitemradio"); b.setAttribute("aria-checked", checked);
  if (!ok) b.setAttribute("aria-disabled", "true");
  b.innerHTML = "<span>" + label + "</span>" + (ok ? "" : "<small>Soon</small>");
  b.onclick = () => { if (ok) pick() };
  menu.appendChild(b);
}
function drawGens() {
  gm.replaceChildren();
  for (const g of state.gens)
    item(gm, g.name, g === state.gen, g.ready && optsOf(g).some(optOk), async () => { go(false); await setGeneration(g) });
}
function drawRegions() {
  const opts = optsOf(state.gen), multi = opts.length > 1;
  rw.hidden = !multi;
  rm.replaceChildren();
  if (!multi) return;
  $("rbt").textContent = state.opt.name;
  for (const o of opts)
    item(rm, o.name, o === state.opt, optOk(o), async () => { goRegion(false); await setGeneration(state.gen, o) });
}

/* ---------- Dexplorer menu ---------- */
const enabled = () => [...mn.querySelectorAll("[role=menuitem]:not([aria-disabled=true])")];
function mo(o) { setH(mn, !o); mb.setAttribute("aria-expanded", o); if (o) enabled()[0].focus(); else mb.focus() }
mb.onclick = () => mo(mn.hidden);
mb.onkeydown = e => { if (e.key === "ArrowDown") { e.preventDefault(); mo(true) } };
document.addEventListener("click", e => { if (!mn.hidden && !mn.parentNode.contains(e.target)) mo(false) });
mn.onkeydown = e => {
  const it = enabled(), i = it.indexOf(document.activeElement);
  if (e.key === "Escape") { e.preventDefault(); mo(false) }
  else if (e.key === "ArrowDown") { e.preventDefault(); it[(i + 1) % it.length].focus() }
  else if (e.key === "ArrowUp") { e.preventDefault(); it[(i - 1 + it.length) % it.length].focus() }
  else if (e.key === "Tab") mo(false);
};
mn.querySelectorAll("[role=menuitem]").forEach(b => b.onclick = () => { if (b.dataset.href) location.href = b.dataset.href; else if (b.getAttribute("aria-disabled") !== "true") mo(false) });

/* ---------- extra maps beside the main one ---------- */
function buildMaps(extras) {
  clearDim();   // the old map layers go away with the old maps
  insetsEl.replaceChildren();
  state.maps = [{ heat: $("heat"), hits: $("hits") }];
  for (const r of extras) {
    const box = document.createElement("div"); box.className = "map inset";
    const cap = document.createElement("div"); cap.className = "cap"; cap.textContent = r.name;
    const svg = mk("svg", { viewBox: `0 0 ${r.mapSize[0]} ${r.mapSize[1]}`, role: "img", "aria-label": r.name + " map with encounter heatmap" });
    const img = mk("image", { href: r.map, width: r.mapSize[0], height: r.mapSize[1] }), heat = mk("g", { filter: "url(#b)" }), hits = mk("g", {});
    svg.append(img, heat, hits); box.append(cap, svg); insetsEl.appendChild(box); state.maps.push({ heat, hits });
  }
  mapsEl.classList.toggle("solo", !extras.length);
}

/* ---------- loading ---------- */
async function setGeneration(g, o) {
  clearDim();
  o = o || optsOf(g).find(optOk);
  const region = state.regions.find(r => r.id === o.region);
  const load = r => regionData[r.id] || (regionData[r.id] = Promise.all([getJSON(r.zones), getJSON(r.encounters)]));
  const extras = (region.insets || []).map(id => state.regions.find(r => r.id === id)).filter(Boolean);   // extra maps shown beside the main one (e.g. the Sevii Islands)
  const all = [region, ...extras], parts = await Promise.all(all.map(load)), zones = {}, rows = [];
  parts.forEach(([z, r], i) => { for (const k in z) { if (zones[k]) console.warn("duplicate zone id", k); zones[k] = { ...z[k], m: i, where: i ? all[i].name : null } } rows.push(...r) });
  Object.assign(state, { gen: g, opt: o, region, zones, rows, games: o.games, game: o.games[0].id, sel: null });
  $("gbt").textContent = g.name;
  $("mapimg").setAttribute("href", region.map);
  $("mapimg").setAttribute("width", region.mapSize[0]); $("mapimg").setAttribute("height", region.mapSize[1]);
  $("m").setAttribute("viewBox", `0 0 ${region.mapSize[0]} ${region.mapSize[1]}`);
  buildMaps(extras);
  document.querySelector("#b feGaussianBlur").setAttribute("stdDeviation", 7 * region.mapSize[0] / 1130);
  $("m").setAttribute("aria-label", region.name + " map with encounter heatmap");
  setColor(); buildGames(); drawGens(); drawRegions(); list($("q").value); draw();
}
$("q").oninput = e => list(e.target.value);
// Deep link: Dexplorer.html?game=gold&pokemon=10 opens that game with that Pokémon selected (used by DexCheck).
async function deepLink() {
  const q = new URLSearchParams(location.search), gid = q.get("game"), pid = parseInt(q.get("pokemon"), 10);
  if (!gid) return;
  for (const g of state.gens) for (const o of optsOf(g)) if (optOk(o) && o.games.some(x => x.id === gid)) {
    if (state.gen !== g || state.opt.id !== o.id) await setGeneration(g, o);
    state.game = gid; setColor(); buildGames();
    const m = state.mons.find(m => m.id === pid);
    if (m) { state.sel = m; list($("q").value); draw(); const c = $("list").querySelector('.cell[aria-pressed="true"]'); if (c) c.scrollIntoView({ block: "center" }) }
    return;
  }
}
(async () => {
  try {
    [state.gens, state.regions, state.mons] = await Promise.all([getJSON("data/generations.json"), getJSON("data/regions.json"), getJSON("data/pokemon.json")]);
    const gid = new URLSearchParams(location.search).get("game");
    let first = [state.gens.find(g => g.ready)];   // a deep link opens its own game straight away, so Gen 1 is not loaded first
    if (gid) for (const g of state.gens) for (const o of optsOf(g)) if (first.length < 2 && optOk(o) && o.games.some(x => x.id === gid)) first = [g, o];
    await setGeneration(...first);
    await deepLink();
  } catch (err) {
    console.error(err);
    $("list").innerHTML = '<p class="empty">Could not load the data files. Open this folder through a local web server (for example <code>python3 -m http.server</code>, then visit http://localhost:8000) instead of double-clicking index.html.</p>';
  }
})();
