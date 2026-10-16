"use strict";
/* Dexplorer: all content comes from /data. See README.md for the file formats. */
const $ = id => document.getElementById(id), NS = "http://www.w3.org/2000/svg";
const getJSON = async u => { const r = await fetch(u); if (!r.ok) throw new Error(u + " (" + r.status + ")"); return r.json() };
const pad = n => String(n).padStart(3, "0");
const state = { gens: [], regions: [], mons: [], gen: null, region: null, game: null, sel: null, zones: {}, rows: [] };
const regionData = {};
const seg = $("seg"), gb = $("gb"), gm = $("gm"), mb = $("mb"), mn = $("mn");

/* ---------- helpers ---------- */
const gameName = id => (state.gen.games.find(g => g.id === id) || {}).name || id;
const vlab = games => games.length === state.gen.games.length ? "" : " · " + games.map(gameName).join("/");
const heat = r => r.rate == null ? 100 : r.rate;
function mk(t, a) { const e = document.createElementNS(NS, t); for (const k in a) e.setAttribute(k, a[k]); return e }
function shape(s, a) {
  return s.type === "circle"
    ? mk("circle", { cx: s.cx, cy: s.cy, r: s.r, ...a })
    : mk("rect", { x: s.x, y: s.y, width: s.w, height: s.h, rx: 10, ...a });
}
function setColor() {
  const g = state.gen.games.find(g => g.id === state.game);
  document.documentElement.style.setProperty("--gc", (g && g.color) || "#e63946");
}

/* ---------- encounters ---------- */
function find(id) {
  const m = {};
  for (const r of state.rows) if (r.pokemon === id && r.games.includes(state.game) && state.zones[r.zone]) (m[r.zone] = m[r.zone] || []).push(r);
  return Object.entries(m).map(([k, rows]) => ({ k, z: state.zones[k], rows, peak: Math.max(...rows.map(heat)) }));
}
function draw() {
  $("tipbox").hidden = true;
  const H = $("heat"), X = $("hits"), L = $("list");
  H.replaceChildren(); X.replaceChildren(); L.replaceChildren();
  const sel = state.sel;
  if (!sel) { $("t").textContent = "Select a Pokémon"; L.innerHTML = '<p class="empty">Pick a Pokémon to see where it appears.</p>'; return }
  $("t").textContent = "#" + pad(sel.id) + " " + sel.name + " · " + gameName(state.game);
  $("t").classList.remove("pop"); void $("t").offsetWidth; $("t").classList.add("pop");
  const res = find(sel.id).sort((a, b) => b.peak - a.peak);
  if (state.game !== "yellow" && state.gen.id === 1 && res.some(x => x.k === "r21" && x.rows.some(r => r.method === "Walking"))) {
    const t = $("tipbox");
    t.textContent = "Tip (Red/Blue glitch): when you surf on the east shore tiles (water with a shoreline on its left) near Cinnabar Island or the Seafoam Islands, wild Pokémon come from the land table of the last area you visited, such as Route 21, so you can meet " + sel.name + " there. Fixed in Yellow.";
    t.hidden = false;
  }
  if (!res.length) L.innerHTML = '<p class="empty">Not found in the wild in ' + gameName(state.game) + " (evolution, trade, or version-exclusive).</p>";
  for (const x of res) {
    const t = Math.sqrt(x.peak / 100);
    x.z.shapes.forEach(s => {
      H.appendChild(shape(s, { fill: `hsl(${215 - 90 * t} ${85 - 15 * t}% ${50 - 8 * t}%)`, opacity: .45 + .5 * t }));
      const h = shape(s, { class: "hit", tabindex: 0, stroke: `hsl(${215 - 90 * t} 80% 26%)`, "aria-label": x.z.name + ": " + x.rows.map(r => r.method + " level " + r.levels + (r.rate != null ? " " + r.rate + "%" : "")).join(", ") });
      h.onmousemove = e => tip(e.clientX, e.clientY, x);
      h.onmouseleave = () => $("tip").style.display = "none";
      h.onfocus = () => { const b = h.getBoundingClientRect(); tip(b.right, b.top, x) };
      h.onblur = h.onmouseleave;
      X.appendChild(h);
    });
    const bm = {}; x.rows.forEach(r => bm[r.method] = Math.max(bm[r.method] || 0, heat(r)));
    const d = document.createElement("div"); d.className = "row";
    d.innerHTML = "<b>" + x.z.name + "</b><span>" + Object.entries(bm).map(([m, v]) => m + " " + v + "%").join(" · ") + "</span>";
    L.appendChild(d);
  }
}
function tip(cx, cy, x) {
  const e = $("tip");
  e.innerHTML = "<b>" + x.z.name + "</b>" + x.rows.map(r => `<div class="it"><div><span>${r.sublocation ? r.sublocation + " · " : ""}${r.method}${vlab(r.games)}</span><span>${r.rate != null ? r.rate + "%" : ""}</span></div><small>Lv ${r.levels}${r.note ? " · " + r.note : ""}</small></div>`).join("");
  e.style.display = "block";
  e.style.left = Math.max(8, Math.min(cx + 14, innerWidth - e.offsetWidth - 8)) + "px";
  e.style.top = Math.max(8, Math.min(cy + 14, innerHeight - e.offsetHeight - 8)) + "px";
}

/* ---------- Pokémon grid ---------- */
function list(f = "") {
  const u = $("dex"); u.replaceChildren(); f = f.toLowerCase();
  const [lo, hi] = state.region.dex;
  state.mons.filter(m => m.id >= lo && m.id <= hi && (m.name.toLowerCase().includes(f) || String(m.id).includes(f))).forEach(m => {
    const b = document.createElement("button");
    b.className = "cell"; b.setAttribute("aria-pressed", !!state.sel && state.sel.id === m.id); b.setAttribute("aria-label", m.name);
    b.innerHTML = `<img alt="" src="${m.sprite}"><small>#${pad(m.id)}</small><span>${m.name}</span>`;
    b.onclick = () => { state.sel = m; u.querySelectorAll(".cell").forEach(c => c.setAttribute("aria-pressed", c === b)); draw() };
    u.appendChild(b);
  });
}

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
  state.gen.games.forEach(g => {
    const b = document.createElement("button"); b.textContent = g.name; b.setAttribute("aria-pressed", g.id === state.game);
    b.onclick = () => { state.game = g.id; setColor(); seg.querySelectorAll("button").forEach(c => c.setAttribute("aria-pressed", c === b)); thumb(true); draw() };
    seg.appendChild(b);
  });
  thumb(false); requestAnimationFrame(() => thumb(true));
}
addEventListener("resize", () => thumb(false));

/* ---------- generation menu ---------- */
const genOn = () => [...gm.querySelectorAll("[role=menuitemradio]:not([aria-disabled=true])")];
function setH(el, h) {
  clearTimeout(el._t);
  if (!h) { el.hidden = false; el.classList.remove("out"); return }
  if (el.hidden) return;
  el.classList.add("out"); el._t = setTimeout(() => { el.hidden = true; el.classList.remove("out") }, 120);
}
function go(o) { setH(gm, !o); gb.setAttribute("aria-expanded", o); if (o) (gm.querySelector("[aria-checked=true]") || genOn()[0]).focus(); else gb.focus() }
function drawGens() {
  gm.replaceChildren();
  for (const g of state.gens) {
    const ok = g.ready && g.region && state.regions.some(r => r.id === g.region);
    const b = document.createElement("button");
    b.setAttribute("role", "menuitemradio"); b.setAttribute("aria-checked", g === state.gen);
    if (!ok) b.setAttribute("aria-disabled", "true");
    b.innerHTML = "<span>" + g.name + "</span>" + (ok ? "" : "<small>Soon</small>");
    b.onclick = async () => { if (!ok) return; go(false); await setGeneration(g) };
    gm.appendChild(b);
  }
}
gb.onclick = () => go(gm.hidden);
gb.onkeydown = e => { if (e.key === "ArrowDown") { e.preventDefault(); go(true) } };
document.addEventListener("click", e => { if (!gm.hidden && !gm.parentNode.contains(e.target)) go(false) });
gm.onkeydown = e => {
  const it = genOn(), i = it.indexOf(document.activeElement);
  if (e.key === "Escape") { e.preventDefault(); go(false) }
  else if (e.key === "ArrowDown") { e.preventDefault(); it[(i + 1) % it.length].focus() }
  else if (e.key === "ArrowUp") { e.preventDefault(); it[(i - 1 + it.length) % it.length].focus() }
  else if (e.key === "Tab") go(false);
};

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
mn.querySelectorAll("[role=menuitem]").forEach(b => b.onclick = () => { if (b.getAttribute("aria-disabled") !== "true") mo(false) });

/* ---------- loading ---------- */
async function setGeneration(g) {
  const region = state.regions.find(r => r.id === g.region);
  if (!regionData[region.id]) regionData[region.id] = Promise.all([getJSON(region.zones), getJSON(region.encounters)]);
  const [zones, rows] = await regionData[region.id];
  Object.assign(state, { gen: g, region, zones, rows, game: g.games[0].id, sel: null });
  $("gbt").textContent = g.name;
  $("mapimg").setAttribute("href", region.map);
  $("mapimg").setAttribute("width", region.mapSize[0]); $("mapimg").setAttribute("height", region.mapSize[1]);
  $("m").setAttribute("viewBox", `0 0 ${region.mapSize[0]} ${region.mapSize[1]}`);
  setColor(); buildGames(); drawGens(); list($("q").value); draw();
}
$("q").oninput = e => list(e.target.value);
(async () => {
  try {
    [state.gens, state.regions, state.mons] = await Promise.all([getJSON("data/generations.json"), getJSON("data/regions.json"), getJSON("data/pokemon.json")]);
    await setGeneration(state.gens.find(g => g.ready));
  } catch (err) {
    console.error(err);
    $("list").innerHTML = '<p class="empty">Could not load the data files. Open this folder through a local web server (for example <code>python3 -m http.server</code>, then visit http://localhost:8000) instead of double-clicking index.html.</p>';
  }
})();
