"use strict";
/*
 * DexCheck save reader.
 *
 * Reads Pokémon save files entirely in the browser (nothing is uploaded) and lists every Pokémon stored in the
 * party, the PC boxes and the daycare, together with the game it came from.
 *
 * The layouts, offsets, checksums and encryption schemes follow PKHeX (github.com/kwsch/PKHeX, PKHeX.Core/Saves):
 *   Gen 1-2   plain lists, species stored as a one-byte index
 *   Gen 3     sectors with footers, 80-byte boxed Pokémon: XOR with PID^TID/SID, then four blocks shuffled by PID % 24
 *   Gen 4-5   136-byte Pokémon: LCG stream cipher keyed by the checksum, then four blocks shuffled by (PID >> 13) & 31
 *   Gen 6-7   232-byte Pokémon: same scheme keyed by the encryption constant, 56-byte blocks
 *   Gen 8-9   SCBlock file: SHA-256 trailer, static XOR pad, per-block xorshift; 0x148-byte Pokémon with 80-byte blocks
 *
 * parse(buffer) returns { ok: true, gen, game, label, mons: [{ n: species, g: game id, s: "p"|"b"|"d" }], eggs }
 * or { ok: false, reason }. Species are National Dex numbers. Eggs are counted but not listed.
 */
const SaveReader = (() => {
  /* ---------- tables ---------- */
  // Gen 1 internal index -> National Dex (0 = unused slot). From PKHeX SpeciesConverter.
  const T1 = [
    0,112,115,32,35,21,100,34,80,2,103,108,102,88,94,29,
    31,104,111,131,59,151,130,90,72,92,123,120,9,127,114,0,
    0,58,95,22,16,79,64,75,113,67,122,106,107,24,47,54,
    96,76,0,126,0,125,82,109,0,56,86,50,128,0,0,0,
    83,48,149,0,0,0,84,60,124,146,144,145,132,52,98,0,
    0,0,37,38,25,26,0,0,147,148,140,141,116,117,0,0,
    27,28,138,139,39,40,133,136,135,134,66,41,23,46,61,62,
    13,14,15,0,85,57,51,49,87,0,0,10,11,12,68,0,
    55,97,42,150,143,129,0,0,89,0,99,91,0,101,36,110,
    53,105,0,93,63,65,17,18,121,1,3,73,0,118,119,0,
    0,0,0,77,78,19,20,33,30,74,137,142,0,81,0,0,
    4,7,5,8,6,0,0,0,0,43,44,45,69,70,71,0,
    0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
    0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
    0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
    0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0
  ];
  // Gen 3 internal species 277.. -> National Dex (252..386). Internal 1-251 are National already; 252-276 are unused.
  const T3 = [
    252,253,254,255,256,257,258,259,260,261,262,263,264,265,266,267,
    268,269,270,271,272,273,274,275,290,291,292,276,277,285,286,327,
    278,279,283,284,320,321,300,301,352,343,344,299,324,302,339,340,
    370,341,342,349,350,318,319,328,329,330,296,297,309,310,322,323,
    363,364,365,331,332,361,362,337,338,298,325,326,311,312,303,307,
    308,333,334,360,355,356,315,287,288,289,316,317,357,293,294,295,
    366,367,368,359,353,354,336,335,369,304,305,306,351,313,314,345,
    346,347,348,280,281,282,371,372,373,374,375,376,377,378,379,382,
    383,384,380,381,385,386,358
  ];
  // Gen 3 internal species 277.. -> National Dex (252..386). Internal 1-251 are National already; 252-276 are unused.
  // Block order table: for shuffle value sv, decrypted block i = stored block BP[sv * 4 + i].
  const BP = [0,1,2,3,0,1,3,2,0,2,1,3,0,3,1,2,0,2,3,1,0,3,2,1,1,0,2,3,1,0,3,2,2,0,1,3,3,0,1,2,2,0,3,1,3,0,2,1,1,2,0,3,1,3,0,2,2,1,0,3,3,1,0,2,2,3,0,1,3,2,0,1,1,2,3,0,1,3,2,0,2,1,3,0,3,1,2,0,2,3,1,0,3,2,1,0,0,1,2,3,0,1,3,2,0,2,1,3,0,3,1,2,0,2,3,1,0,3,2,1,1,0,2,3,1,0,3,2];

  /* ---------- games ---------- */
  // c = one or two colours (two = split chip). Gen 1/2 cartridges cannot tell Red from Blue or Gold from Silver apart.
  const GAMES = [
    { id: "rb", name: "Red / Blue", gen: 1, c: ["#e63946", "#3b6fd8"] },
    { id: "yellow", name: "Yellow", gen: 1, c: ["#f2c100"] },
    { id: "gs", name: "Gold / Silver", gen: 2, c: ["#d4a017", "#9aa5b1"] },
    { id: "crystal", name: "Crystal", gen: 2, c: ["#3fb6e8"] },
    { id: "ruby", name: "Ruby", gen: 3, c: ["#b5173b"] },
    { id: "sapphire", name: "Sapphire", gen: 3, c: ["#2a5db0"] },
    { id: "emerald", name: "Emerald", gen: 3, c: ["#1f9d6b"] },
    { id: "firered", name: "FireRed", gen: 3, c: ["#f26a21"] },
    { id: "leafgreen", name: "LeafGreen", gen: 3, c: ["#5fb04a"] },
    { id: "cxd", name: "Colosseum / XD", gen: 3, c: ["#7c5cff"] },
    { id: "diamond", name: "Diamond", gen: 4, c: ["#5b8fd8"] },
    { id: "pearl", name: "Pearl", gen: 4, c: ["#d77fa1"] },
    { id: "platinum", name: "Platinum", gen: 4, c: ["#8e8e93"] },
    { id: "heartgold", name: "HeartGold", gen: 4, c: ["#d9a441"] },
    { id: "soulsilver", name: "SoulSilver", gen: 4, c: ["#a4aeb8"] },
    { id: "black", name: "Black", gen: 5, c: ["#48484a"] },
    { id: "white", name: "White", gen: 5, c: ["#b8b8be"] },
    { id: "black2", name: "Black 2", gen: 5, c: ["#2c2c2e"] },
    { id: "white2", name: "White 2", gen: 5, c: ["#d1d1d6"] },
    { id: "x", name: "X", gen: 6, c: ["#2f6df6"] },
    { id: "y", name: "Y", gen: 6, c: ["#e8445a"] },
    { id: "omegaruby", name: "Omega Ruby", gen: 6, c: ["#c0392b"] },
    { id: "alphasapphire", name: "Alpha Sapphire", gen: 6, c: ["#1f5fbf"] },
    { id: "sun", name: "Sun", gen: 7, c: ["#f39c12"] },
    { id: "moon", name: "Moon", gen: 7, c: ["#5856d6"] },
    { id: "ultrasun", name: "Ultra Sun", gen: 7, c: ["#e67e22"] },
    { id: "ultramoon", name: "Ultra Moon", gen: 7, c: ["#6c3fc9"] },
    { id: "letsgopikachu", name: "Let's Go, Pikachu!", gen: 7, c: ["#f5c400"] },
    { id: "letsgoeevee", name: "Let's Go, Eevee!", gen: 7, c: ["#b07a3f"] },
    { id: "go", name: "Pokémon GO", gen: 7, c: ["#34a853"] },
    { id: "sword", name: "Sword", gen: 8, c: ["#38b6ff"] },
    { id: "shield", name: "Shield", gen: 8, c: ["#e0245e"] },
    { id: "brilliantdiamond", name: "Brilliant Diamond", gen: 8, c: ["#4aa3df"] },
    { id: "shiningpearl", name: "Shining Pearl", gen: 8, c: ["#e58ab0"] },
    { id: "legendsarceus", name: "Legends: Arceus", gen: 8, c: ["#8c7a5b"] },
    { id: "scarlet", name: "Scarlet", gen: 9, c: ["#e5382d"] },
    { id: "violet", name: "Violet", gen: 9, c: ["#8a3ffc"] },
    { id: "legendsza", name: "Legends: Z-A", gen: 9, c: ["#2bb5a0"] },
    { id: "unknown", name: "Unknown origin", gen: 0, c: ["#8e8e93"] },
  ];
  // Origin game byte stored in each Pokémon (PKHeX GameVersion). Virtual Console transfers keep their Gen 1/2 identity.
  const VERSION = {
    1: "sapphire", 2: "ruby", 3: "emerald", 4: "firered", 5: "leafgreen", 7: "heartgold", 8: "soulsilver",
    10: "diamond", 11: "pearl", 12: "platinum", 15: "cxd", 20: "white", 21: "black", 22: "white2", 23: "black2",
    24: "x", 25: "y", 26: "alphasapphire", 27: "omegaruby", 30: "sun", 31: "moon", 32: "ultrasun", 33: "ultramoon",
    34: "go", 35: "rb", 36: "rb", 37: "rb", 38: "yellow", 39: "gs", 40: "gs", 41: "crystal",
    42: "letsgopikachu", 43: "letsgoeevee", 44: "sword", 45: "shield", 47: "legendsarceus", 48: "brilliantdiamond",
    49: "shiningpearl", 50: "scarlet", 51: "violet", 52: "legendsza",
  };
  const gameOf = v => VERSION[v] || "unknown";

  /* ---------- byte helpers ---------- */
  const u16 = (d, o) => (d[o] | (d[o + 1] << 8)) & 0xFFFF;
  const u32 = (d, o) => ((d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0);
  const allZero = (d, o, n) => { for (let i = 0; i < n; i++) if (d[o + i]) return false; return true };
  const sum16 = (d, a, b) => { let s = 0; for (let o = a; o < b; o += 2) s = (s + u16(d, o)) & 0xFFFF; return s };
  // Nickname decoders (international character sets). Returns "" when unreadable.
  const C12 = c => c === 0x7F ? " " : c >= 0x80 && c <= 0x99 ? String.fromCharCode(65 + c - 0x80) : c >= 0xA0 && c <= 0xB9 ? String.fromCharCode(97 + c - 0xA0) : c >= 0xF6 && c <= 0xFF ? String(c - 0xF6) : ({ 0xE3: "-", 0xE6: "?", 0xE7: "!", 0xE8: ".", 0xF4: ",", 0xE0: "'", 0xEF: "♂", 0xF5: "♀", 0xF3: "/", 0x9A: "(", 0x9B: ")", 0x9C: ":", 0x9D: ";", 0x9E: "[", 0x9F: "]", 0xBA: "é", 0xE1: "PK", 0xE2: "MN" }[c] || "");
  const C3 = c => c === 0 ? " " : c >= 0xBB && c <= 0xD4 ? String.fromCharCode(65 + c - 0xBB) : c >= 0xD5 && c <= 0xEE ? String.fromCharCode(97 + c - 0xD5) : c >= 0xA1 && c <= 0xAA ? String(c - 0xA1) : ({ 0xAB: "!", 0xAC: "?", 0xAD: ".", 0xAE: "-", 0xB0: "…", 0xB1: "“", 0xB2: "”", 0xB3: "‘", 0xB4: "’", 0xB5: "♂", 0xB6: "♀", 0xB8: ",", 0xBA: "/", 0xF0: ":" }[c] || "");
  const text = (d, off, n, map, end) => { let t = ""; for (let i = 0; i < n; i++) { const c = d[off + i]; if (c === end) break; t += map(c) } return t.trim() };
  const utf16 = (d, off, n) => { let t = ""; for (let i = 0; i < n; i++) { const c = u16(d, off + 2 * i); if (c === 0 || c === 0xFFFF) break; t += String.fromCharCode(c) } return t.trim() };
  const fail = reason => ({ ok: false, reason });

  /* ---------- Pokémon decryption (PKHeX PokeCrypto) ---------- */
  // LCG used by the Gen 4+ stream cipher, applied to 16-bit little-endian words.
  function cryptWords(b, start, end, seed) {
    for (let o = start; o < end; o += 2) {
      seed = (Math.imul(seed, 0x41C64E6D) + 0x6073) >>> 0;
      const x = seed >>> 16;
      b[o] ^= x & 0xFF; b[o + 1] ^= x >>> 8;
    }
  }
  // Undo the block shuffle: decrypted block i = stored block BP[sv * 4 + i].
  function unshuffle(b, start, size, sv) {
    const src = b.slice(start, start + 4 * size);
    for (let i = 0; i < 4; i++) {
      const j = BP[sv * 4 + i] * size;
      b.set(src.subarray(j, j + size), start + i * size);
    }
  }
  /** Gen 3: 80-byte box format. Returns { species (national), version, egg } or null if empty/invalid. */
  function pk3(d, off) {
    const b = d.slice(off, off + 80);
    if (b.length < 80 || allZero(b, 0, 80)) return null;
    const pid = u32(b, 0), key = (pid ^ u32(b, 4)) >>> 0;
    for (let o = 0x20; o < 0x50; o += 4) {
      const w = (u32(b, o) ^ key) >>> 0;
      b[o] = w & 255; b[o + 1] = (w >>> 8) & 255; b[o + 2] = (w >>> 16) & 255; b[o + 3] = w >>> 24;
    }
    unshuffle(b, 0x20, 12, pid % 24);
    if (sum16(b, 0x20, 0x50) !== u16(b, 0x1C)) return null;
    const raw = u16(b, 0x20), species = raw <= 251 ? raw : raw >= 277 && raw - 277 < T3.length ? T3[raw - 277] : 0;
    if (!species) return null;
    const iv = u32(b, 0x48), nib = (w, i) => (w >>> (5 * i)) & 31, party = d.length >= off + 100 && d[off + 0x54] > 0 && d[off + 0x54] <= 100 ? d[off + 0x54] : 0;
    const x = { nn: b[0x12] === 1 ? "" : text(b, 8, 10, C3, 0xFF), abs: (iv >>> 31) & 1, fr: b[0x29], bl: (u16(b, 0x46) >> 11) & 15, sh: ((u16(b, 4) ^ u16(b, 6) ^ (pid >>> 16) ^ (pid & 0xFFFF)) < 8) ? 1 : 0, pid, exp: u32(b, 0x24), it: u16(b, 0x22), mv: [0x2C, 0x2E, 0x30, 0x32].map(o => u16(b, o)), ev: [0x38, 0x39, 0x3A, 0x3C, 0x3D, 0x3B].map(o => b[o]), iv: [0, 1, 2, 4, 5, 3].map(i => nib(iv, i)), loc: b[0x45], mlv: u16(b, 0x46) & 127 };
    if (party) x.lv = party;
    return { species, version: (u16(b, 0x46) >> 7) & 0xF, egg: ((iv >>> 30) & 1) === 1, x };
  }
  /** Gen 4/5: 136-byte format (party/daycare slots are longer; only the first 136 bytes matter). */
  function pk45(d, off, gen5) {
    const b = d.slice(off, off + 136);
    if (b.length < 136 || allZero(b, 0, 136)) return null;
    const chk = u16(b, 6), sv = (u32(b, 0) >>> 13) & 31;
    cryptWords(b, 8, 136, chk); unshuffle(b, 8, 32, sv);
    if (sum16(b, 8, 136) !== chk) return null;
    const species = u16(b, 8);
    if (!species) return null;
    return { species, version: b[0x5F], egg: ((u32(b, 0x38) >>> 30) & 1) === 1, x: { ab: b[0x15], sh: ((u16(b, 0x0C) ^ u16(b, 0x0E) ^ (u32(b, 0) >>> 16) ^ (u32(b, 0) & 0xFFFF)) < 8) ? 1 : 0, ...(gen5 ? { nn: utf16(b, 0x48, 11) } : {}) } };
  }
  /** Gen 6/7: 232-byte format. */
  function pk67(d, off) {
    const b = d.slice(off, off + 232);
    if (b.length < 232 || allZero(b, 0, 232)) return null;
    const pv = u32(b, 0), sv = (pv >>> 13) & 31;
    cryptWords(b, 8, 232, pv); unshuffle(b, 8, 56, sv);
    if (sum16(b, 8, 232) !== u16(b, 6)) return null;
    const species = u16(b, 8);
    if (!species) return null;
    return { species, version: b[0xDF], egg: ((u32(b, 0x74) >>> 30) & 1) === 1, x: { nn: utf16(b, 0x40, 12), ab: b[0x14], abn: b[0x15] & 7, sh: ((u16(b, 0x0C) ^ u16(b, 0x0E) ^ (u32(b, 0x18) >>> 16) ^ (u32(b, 0x18) & 0xFFFF)) < 16) ? 1 : 0 } };
  }
  /** Gen 8/9: 0x148-byte format with 80-byte blocks. versionAt: 0xDE (Sword/Shield) or 0xCE (Scarlet/Violet). */
  function pk89(d, off, versionAt) {
    const b = d.slice(off, off + 0x148);
    if (b.length < 0x148 || allZero(b, 0, 0x148)) return null;
    const pv = u32(b, 0), sv = (pv >>> 13) & 31;
    cryptWords(b, 8, 0x148, pv); unshuffle(b, 8, 80, sv);
    if (sum16(b, 8, 0x148) !== u16(b, 6)) return null;
    const species = u16(b, 8);
    if (!species) return null;
    return { species, version: b[versionAt], egg: ((u32(b, 0x8C) >>> 30) & 1) === 1, x: { nn: utf16(b, 0x58, 12), ab: u16(b, 0x14), abn: b[0x16] & 7, sh: ((u16(b, 0x0C) ^ u16(b, 0x0E) ^ (u32(b, 0x1C) >>> 16) ^ (u32(b, 0x1C) & 0xFFFF)) < 16) ? 1 : 0 } };
  }

  /* ---------- result collector ---------- */
  function collector() {
    const r = { mons: [], eggs: 0 };
    r.add = (p, src, game) => {
      if (!p) return;
      if (p.egg) { r.eggs++; return }
      r.mons.push(Object.assign({ n: p.species, g: game || gameOf(p.version), s: src }, p.x || {}));
    };
    return r;
  }

  /* ---------- Generation 1 and 2: plain lists ---------- */
  // A list is: count, species[capacity], 0xFF terminator. Valid when count fits and the terminator follows the last entry.
  const listOk = (d, off, cap) => off + 2 + cap <= d.length && d[off] <= cap && d[off + 1 + d[off]] === 0xFF;
  const listOf = (d, off, cap) => listOk(d, off, cap) ? Array.from(d.subarray(off + 1, off + 1 + d[off])) : [];

  const G1 = {
    int: { party: 0x2F2C, cur: 0x30C0, curIdx: 0x284C, dc: 0x2CF4, cap: 20, str: 11, boxes: 12, size: 0x462, chk: 0x3523, starter: 0x29C3, pika: 0x271C },
    jpn: { party: 0x2ED5, cur: 0x302D, curIdx: 0x2842, dc: 0x2CA7, cap: 30, str: 6, boxes: 8, size: 0x566, chk: 0x3594, starter: 0x29B9, pika: 0x2712 },
  };
  function rbyChecksumOk(d, o) {
    let s = 0;
    for (let i = 0x2598; i < o.chk; i++) s = (s + d[i]) & 255;
    return d[o.chk] === ((~s) & 255);
  }
  function readGen1(d) {
    const hasJ = listOk(d, G1.jpn.party, 30) && listOk(d, G1.jpn.cur, 30);
    const hasI = listOk(d, G1.int.party, 20) && listOk(d, G1.int.cur, 20);
    if (!hasJ && !hasI) return null;
    const o = hasJ && hasI ? (rbyChecksumOk(d, G1.int) ? G1.int : G1.jpn) : hasJ ? G1.jpn : G1.int;
    const yellow = d[o.starter] ? d[o.starter] === 0x54 : d[o.pika] !== 0;
    const game = yellow ? "yellow" : "rb", r = collector();
    const mon1 = (off, party, nn) => ({ nn, lv: party ? d[off + 0x21] : d[off + 3], mv: [8, 9, 10, 11].map(i => d[off + i]), ev: [17, 19, 21, 23, 25].map(i => (d[off + i] << 8) | d[off + i + 1]), dv: [d[off + 27] >> 4, d[off + 27] & 15, d[off + 28] >> 4, d[off + 28] & 15] });
    const nick = off => o.str === 11 ? text(d, off, 11, C12, 0x50) : "";
    const add = (raw, src, off, party, nOff) => { const n = T1[raw] || 0; if (n) r.add({ species: n, x: mon1(off, party, nOff ? nick(nOff) : "") }, src, game) };
    const lst = (base, cap, src, hdr, size, party) => listOf(d, base, cap).forEach((x, i) => add(x, src, base + hdr + i * size, party, base + hdr + cap * size + cap * o.str + i * o.str));
    lst(o.party, 6, "p", 8, 44, true);
    const idx = d[o.curIdx] & 0x7F, ready = (d[o.curIdx] & 0x80) !== 0;
    if (idx < o.boxes) lst(o.cur, o.cap, "b", 2 + o.cap, 33);
    if (ready) for (let i = 0; i < o.boxes; i++) {
      if (i === idx) continue; // the working copy above is newer than the stored one
      const base = i < o.boxes / 2 ? 0x4000 + i * o.size : 0x6000 + (i - o.boxes / 2) * o.size;
      lst(base, o.cap, "b", 2 + o.cap, 33);
    }
    if (d[o.dc] === 1) add(d[o.dc + 1 + 2 * o.str], "d", o.dc + 1 + 2 * o.str, false, o.dc + 1);
    return { gen: 1, game, label: yellow ? "Yellow" : "Red / Blue", mons: r.mons, eggs: r.eggs };
  }

  const G2 = [
    { game: "gs", label: "Gold / Silver", party: 0x288A, cur: 0x2D6C, cap: 20, str: 11, seen: 0x2A6C, boxes: 14 },
    { game: "crystal", label: "Crystal", party: 0x2865, cur: 0x2D10, cap: 20, str: 11, seen: 0x2A47, boxes: 14 },
    { game: "gs", label: "Gold / Silver (Japan)", party: 0x283E, cur: 0x2D10, cap: 30, str: 6, seen: 0x29EE, boxes: 9 },
    { game: "crystal", label: "Crystal (Japan)", party: 0x281A, cur: 0x2D10, cap: 30, str: 6, seen: 0x29CA, boxes: 9 },
    { game: "gs", label: "Gold / Silver (Korea)", party: 0x28CC, cur: 0x2DAE, cap: 20, str: 11, seen: 0x2AAE, boxes: 14 },
  ];
  function readGen2(d) {
    const o = G2.find(v => listOk(d, v.party, v.cap) && listOk(d, v.cur, v.cap));
    if (!o) return null;
    const r = collector();
    const shiny2 = dv => dv[1] === 10 && dv[2] === 10 && dv[3] === 10 && [2, 3, 6, 7, 10, 11, 14, 15].includes(dv[0]);
    const mon2 = (off, nn) => { const dv = [d[off + 21] >> 4, d[off + 21] & 15, d[off + 22] >> 4, d[off + 22] & 15]; return { nn, fr: d[off + 27], tod: d[off + 29] >> 6, sh: shiny2(dv) ? 1 : 0, lv: d[off + 31], it: d[off + 1], mv: [2, 3, 4, 5].map(i => d[off + i]), ev: [11, 13, 15, 17, 19].map(i => (d[off + i] << 8) | d[off + i + 1]), dv: [d[off + 21] >> 4, d[off + 21] & 15, d[off + 22] >> 4, d[off + 22] & 15], loc: d[off + 30] & 0x7F, mlv: d[off + 29] & 63 } };
    const add = (raw, src, off, nOff) => {
      if (raw === 0xFD) { r.eggs++; return }
      if (raw >= 1 && raw <= 251) r.add({ species: raw, x: mon2(off, nOff && o.str === 11 ? text(d, nOff, 11, C12, 0x50) : "") }, src, o.game);
    };
    const lst = (base, cap, src, hdr, size) => listOf(d, base, cap).forEach((x, i) => add(x, src, base + hdr + i * size, base + hdr + cap * size + cap * o.str + i * o.str));
    if (d[o.party] <= 6) lst(o.party, 6, "p", 8, 48);
    const list = (((o.str * 2) + 32 + 1) * o.cap) + 2, split = o.cap === 30 ? 6 : 7;
    for (let i = 0; i < o.boxes; i++) {
      const base = i < split ? 0x4000 + i * (list + 2) : 0x6000 + (i - split) * (list + 2);
      lst(base, o.cap, "b", 2 + o.cap, 32);
    }
    // Daycare: flag, nickname, OT, Pokémon (32 bytes); the second slot follows after a flag, steps and Ditto byte.
    const dc = o.seen + 0x1F + 28 + 1;
    if (d[dc] & 1) add(d[dc + 1 + 2 * o.str], "d", dc + 1 + 2 * o.str, dc + 1);
    const f1 = dc + 2 * o.str + 33;
    if (d[f1] & 1) add(d[f1 + 3 + 2 * o.str], "d", f1 + 3 + 2 * o.str, f1 + 3);
    return { gen: 2, game: o.game, label: o.label, mons: r.mons, eggs: r.eggs };
  }

  /* ---------- Generation 3: sector save ---------- */
  function g3Sectors(d, slot) {
    const start = 0xE000 * slot, at = []; let bits = 0;
    if (start + 0xE000 > d.length) return null;
    for (let i = 0; i < 14; i++) {
      const ofs = start + i * 0x1000, id = (d[ofs + 0xFF4] | (d[ofs + 0xFF5] << 8)) << 16 >> 16;
      if (id < 0 || id >= 14) return null;
      bits |= 1 << id; at[id] = ofs;
    }
    return bits === 0x3FFF ? at : null;
  }
  // The save with the higher counter in its footer is the newest.
  function g3Newest(d, a, b) {
    const c1 = u32(d, a + 0xFFC), c2 = u32(d, b + 0xFFC);
    if (c1 === 0xFFFFFFFF && c2 !== 0xFFFFFFFE) return 1;
    if (c2 === 0xFFFFFFFF && c1 !== 0xFFFFFFFE) return 0;
    return c2 > c1 ? 1 : 0;
  }
  function readGen3(d) {
    const slots = [g3Sectors(d, 0), d.length >= 0x1C000 ? g3Sectors(d, 1) : null];
    if (!slots[0] && !slots[1]) return null;
    const at = !slots[0] ? slots[1] : !slots[1] ? slots[0] : slots[g3Newest(d, slots[0][0], slots[1][0])];
    const join = (from, to) => { const out = new Uint8Array((to - from + 1) * 0xF80); for (let id = from; id <= to; id++) out.set(d.subarray(at[id], at[id] + 0xF80), (id - from) * 0xF80); return out };
    const large = join(1, 4), store = join(5, 13), small0 = at[0];
    // Game: FireRed/LeafGreen keep a fixed 1 at 0xAC of the first sector; Ruby/Sapphire have battle tower data there; Emerald has a key.
    const k = u32(d, small0 + 0xAC);
    let kind = k === 1 ? "frlg" : k === 0 ? "rs" : (d.subarray(small0 + 0x890, small0 + 0xF2C).some(x => x) ? "e" : "rs");
    const cfg = { rs: { party: 0x234, dc: 0x2F9C, dcSize: 80, label: "Ruby / Sapphire" }, e: { party: 0x234, dc: 0x3030, dcSize: 0x8C, label: "Emerald" }, frlg: { party: 0x34, dc: 0x2F80, dcSize: 0x8C, label: "FireRed / LeafGreen" } }[kind];
    const r = collector();
    const n = Math.min(large[cfg.party], 6);
    for (let i = 0; i < n; i++) r.add(pk3(large, cfg.party + 4 + i * 100), "p");
    for (let b = 0; b < 14; b++) for (let s = 0; s < 30; s++) r.add(pk3(store, 4 + (b * 30 + s) * 80), "b");
    for (let i = 0; i < 2; i++) r.add(pk3(large, cfg.dc + i * cfg.dcSize), "d");
    return { gen: 3, game: kind === "e" ? "emerald" : kind, label: cfg.label, mons: r.mons, eggs: r.eggs };
  }

  /* ---------- Generation 4 and 5 (Nintendo DS) ---------- */
  const G4 = [
    { label: "Diamond / Pearl", gSize: 0xC100, sStart: 0xC100, sSize: 0x121E0, party: 0x98, dc: 0x141C, boxStep: 0xFF0, boxBase: 4 },
    { label: "Platinum", gSize: 0xCF2C, sStart: 0xCF2C, sSize: 0x121E4, party: 0xA0, dc: 0x1654, boxStep: 0xFF0, boxBase: 4 },
    { label: "HeartGold / SoulSilver", gSize: 0xF628, sStart: 0xF700, sSize: 0x12310, party: 0x98, dc: 0x15FC, boxStep: 0x1000, boxBase: 0 },
  ];
  // The block with the higher major (then minor) counter in its footer is the newest.
  function g4Newest(d, off) {
    const m1 = u32(d, off), m2 = u32(d, off + 0x40000);
    if (m1 !== m2) return m2 > m1 ? 1 : 0;
    return u32(d, off + 4 + 0x40000) > u32(d, off + 4) ? 1 : 0;
  }
  function readGen4(d) {
    if (d.length < 0x80000) return null;
    const o = G4.find(v => {
      const end = 0x40000 + v.gSize;
      return u32(d, end - 0xC) === v.gSize && (u32(d, end - 8) === 0x20060623 || u32(d, end - 8) === 0x20070903);
    });
    if (!o) return null;
    const gBase = g4Newest(d, o.gSize - 0x14) ? 0x40000 : 0;
    const sBase = (g4Newest(d, o.sStart + o.sSize - 0x14) ? 0x40000 : 0) + o.sStart;
    const r = collector(), n = Math.min(d[gBase + o.party - 4], 6);
    for (let i = 0; i < n; i++) r.add(pk45(d, gBase + o.party + i * 236), "p");
    for (let i = 0; i < 2; i++) r.add(pk45(d, gBase + o.dc + i * 236), "d");
    for (let b = 0; b < 18; b++) for (let s = 0; s < 30; s++) r.add(pk45(d, sBase + o.boxBase + b * o.boxStep + s * 136), "b");
    return { gen: 4, game: null, label: o.label, mons: r.mons, eggs: r.eggs };
  }

  // CRC-16/CCITT as used by the Gen 5 footer (PKHeX Checksums.CRC16_CCITT).
  function crc16(d, a, b) {
    let top = 0xFF, bot = 0xFF;
    for (let i = a; i < b; i++) {
      let x = d[i] ^ top; x ^= x >> 4;
      top = (bot ^ (x >> 3) ^ (x << 4)) & 255; bot = (x ^ (x << 5)) & 255;
    }
    return (top << 8) | bot;
  }
  const G5 = [
    { label: "Black / White", main: 0x24000, info: 0x8C, dc: 0x20E00 },
    { label: "Black 2 / White 2", main: 0x26000, info: 0x94, dc: 0x20D00 },
  ];
  function readGen5(d) {
    if (d.length < 0x80000) return null;
    const o = G5.find(v => {
      const f = v.main - 0x100;
      return u16(d, f + v.info + 0x10 - 2) === crc16(d, f, f + v.info);
    });
    if (!o) return null;
    const r = collector(), n = Math.min(d[0x18E00 + 4], 6);
    for (let i = 0; i < n; i++) r.add(pk45(d, 0x18E00 + 8 + i * 220, 1), "p");
    for (let i = 0; i < 2; i++) if (u32(d, o.dc + i * 228) === 1) r.add(pk45(d, o.dc + i * 228 + 4, 1), "d");
    for (let b = 0; b < 24; b++) for (let s = 0; s < 30; s++) r.add(pk45(d, 0x400 + b * 0x1000 + s * 136, 1), "b");
    return { gen: 5, game: null, label: o.label, mons: r.mons, eggs: r.eggs };
  }

  /* ---------- Generation 6 and 7 (Nintendo 3DS) ---------- */
  const G67 = [
    { gen: 6, label: "X / Y", size: 0x65600, party: 0x14200, box: 0x22600, boxes: 31 },
    { gen: 6, label: "Omega Ruby / Alpha Sapphire", size: 0x76000, party: 0x14200, box: 0x33000, boxes: 31 },
    { gen: 7, label: "Sun / Moon", size: 0x6BE00, party: 0x1400, box: 0x4E00, boxes: 32 },
    { gen: 7, label: "Ultra Sun / Ultra Moon", size: 0x6CC00, party: 0x1600, box: 0x5200, boxes: 32 },
  ];
  function readGen67(d) {
    const o = G67.find(v => v.size === d.length && u32(d, d.length - 0x1F0) === 0x42454546);
    if (!o) return null;
    const r = collector(), n = Math.min(d[o.party + 6 * 0x104], 6);
    for (let i = 0; i < n; i++) r.add(pk67(d, o.party + i * 0x104), "p");
    for (let b = 0; b < o.boxes; b++) for (let s = 0; s < 30; s++) r.add(pk67(d, o.box + (b * 30 + s) * 0xE8), "b");
    return { gen: o.gen, game: null, label: o.label, mons: r.mons, eggs: r.eggs };
  }

  /* ---------- Generation 8 and 9 (Switch): SCBlock saves ---------- */
  const K_BOX = 0x0D66012C, K_PARTY_8 = 0x2985FE5D, K_PARTY_9 = 0x3AA1A9AD;
  const INTRO = [0x9E,0xC9,0x9C,0xD7,0x0E,0xD3,0x3C,0x44,0xFB,0x93,0x03,0xDC,0xEB,0x39,0xB4,0x2A,0x19,0x47,0xE9,0x63,0x4B,0xA2,0x33,0x44,0x16,0xBF,0x82,0xA2,0xBA,0x63,0x55,0xB6,
    0x3D,0x9D,0xF2,0x4B,0x5F,0x7B,0x6A,0xB2,0x62,0x1D,0xC2,0x1B,0x68,0xE5,0xC8,0xB5,0x3A,0x05,0x90,0x00,0xE8,0xA8,0x10,0x3D,0xE2,0xEC,0xF0,0x0C,0xB2,0xED,0x4F,0x6D];
  const OUTRO = [0xD6,0xC0,0x1C,0x59,0x8B,0xC8,0xB8,0xCB,0x46,0xE1,0x53,0xFC,0x82,0x8C,0x75,0x75,0x13,0xE0,0x45,0xDF,0x32,0x69,0x3C,0x75,0xF0,0x59,0xF8,0xD9,0xA2,0x5F,0xB2,0x17,
    0xE0,0x80,0x52,0xDB,0xEA,0x89,0x73,0x99,0x75,0x79,0xAF,0xCB,0x2E,0x80,0x07,0xE6,0xF1,0x26,0xE0,0x03,0x0A,0xE6,0x6F,0xF6,0x41,0xBF,0x7E,0x59,0xC2,0xAE,0x55,0xFD];
  const XORPAD = [0xA0,0x92,0xD1,0x06,0x07,0xDB,0x32,0xA1,0xAE,0x01,0xF5,0xC5,0x1E,0x84,0x4F,0xE3,0x53,0xCA,0x37,0xF4,0xA7,0xB0,0x4D,0xA0,0x18,0xB7,0xC2,0x97,0xDA,0x5F,0x53,0x2B,
    0x75,0xFA,0x48,0x16,0xF8,0xD4,0x8A,0x6F,0x61,0x05,0xF4,0xE2,0xFD,0x04,0xB5,0xA3,0x0F,0xFC,0x44,0x92,0xCB,0x32,0xE6,0x1B,0xB9,0xB1,0x2E,0x01,0xB0,0x56,0x53,0x36,
    0xD2,0xD1,0x50,0x3D,0xDE,0x5B,0x2E,0x0E,0x52,0xFD,0xDF,0x2F,0x7B,0xCA,0x63,0x50,0xA4,0x67,0x5D,0x23,0x17,0xC0,0x52,0xE1,0xA6,0x30,0x7C,0x2B,0xB6,0x70,0x36,0x5B,
    0x2A,0x27,0x69,0x33,0xF5,0x63,0x7B,0x36,0x3F,0x26,0x9B,0xA3,0xED,0x7A,0x53,0x00,0xA4,0x48,0xB3,0x50,0x9E,0x14,0xA0,0x52,0xDE,0x7E,0x10,0x2B,0x1B,0x77,0x6E];

  // SHA-256 (the page may be served over plain http, where crypto.subtle is unavailable).
  const K256 = (() => { const k = []; for (let n = 2; k.length < 64; n++) { let p = true; for (let i = 2; i * i <= n; i++) if (n % i === 0) { p = false; break } if (p) k.push(Math.floor((Math.cbrt(n) % 1) * 2 ** 32) >>> 0) } return k })();
  function sha256(parts) {
    const len = parts.reduce((a, p) => a + p.length, 0), pad = (64 - ((len + 9) % 64)) % 64, total = len + 9 + pad;
    const m = new Uint8Array(total); let o = 0;
    for (const p of parts) { m.set(p, o); o += p.length }
    m[len] = 0x80;
    const bits = len * 8; m[total - 4] = (bits >>> 24) & 255; m[total - 3] = (bits >>> 16) & 255; m[total - 2] = (bits >>> 8) & 255; m[total - 1] = bits & 255;
    m[total - 5] = Math.floor(len / 0x20000000) & 255; // bit length above 32 bits (saves are far smaller; kept for correctness)
    const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19], w = new Uint32Array(64);
    for (let i = 0; i < total; i += 64) {
      for (let t = 0; t < 16; t++) w[t] = (m[i + 4 * t] << 24) | (m[i + 4 * t + 1] << 16) | (m[i + 4 * t + 2] << 8) | m[i + 4 * t + 3];
      for (let t = 16; t < 64; t++) {
        const a = w[t - 15], b = w[t - 2];
        const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3), s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
        w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
      }
      let [a, b, c, dd, e, f, g, h] = H;
      for (let t = 0; t < 64; t++) {
        const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7)), ch = (e & f) ^ (~e & g);
        const t1 = (h + S1 + ch + K256[t] + w[t]) | 0;
        const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10)), mj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (S0 + mj) | 0;
        h = g; g = f; f = e; e = (dd + t1) | 0; dd = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + dd) | 0; H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
    }
    const out = new Uint8Array(32);
    H.forEach((v, i) => { out[4 * i] = v >>> 24; out[4 * i + 1] = (v >>> 16) & 255; out[4 * i + 2] = (v >>> 8) & 255; out[4 * i + 3] = v & 255 });
    return out;
  }
  const hashOk = d => {
    const h = sha256([Uint8Array.from(INTRO), d.subarray(0, d.length - 32), Uint8Array.from(OUTRO)]);
    for (let i = 0; i < 32; i++) if (h[i] !== d[d.length - 32 + i]) return false;
    return true;
  };
  // xorshift stream that obscures each SCBlock (PKHeX SCXorShift32).
  function xs(seed) {
    const adv = s => { s ^= s << 2; s ^= s >>> 15; s ^= s << 13; return s >>> 0 };
    let s = seed >>> 0, c = 0, pop = 0;
    for (let v = s; v; v &= v - 1) pop++;
    for (let i = 0; i < pop; i++) s = adv(s);
    const next = () => { const r = (s >>> (c * 8)) & 255; if (c === 3) { s = adv(s); c = 0 } else c++; return r };
    return { next, next32: () => (next() | (next() << 8) | (next() << 16) | (next() << 24)) };
  }
  const TYPE_SIZE = { 3: 1, 8: 1, 9: 2, 10: 4, 11: 8, 12: 1, 13: 2, 14: 4, 15: 8, 16: 4, 17: 8 };
  /** Walks the decrypted SCBlock list and returns the contents of the blocks whose keys are wanted. */
  function scBlocks(p, wanted) {
    const found = {}; let o = 0;
    while (o + 5 <= p.length) {
      const key = u32(p, o); o += 4;
      const x = xs(key), type = p[o++] ^ x.next();
      let size = 0, keep = false;
      if (type === 1 || type === 2 || type === 3) continue;
      if (type === 4) { size = (u32(p, o) ^ x.next32()) | 0; o += 4; keep = true }
      else if (type === 5) { const n = (u32(p, o) ^ x.next32()) | 0; o += 4; const sub = p[o++] ^ x.next(); size = n * (TYPE_SIZE[sub] || 0) }
      else size = TYPE_SIZE[type] || 0;
      if (size < 0 || o + size > p.length) throw new Error("block overrun");
      if (keep && wanted.includes(key)) {
        const out = p.slice(o, o + size);
        for (let i = 0; i < size; i++) out[i] ^= x.next();
        found[key] = out;
      }
      o += size;
    }
    return found;
  }
  function readGen89(d) {
    if (d.length < 0x100000 || !hashOk(d)) return null;
    const p = d.slice(0, d.length - 32);
    for (let i = 0; i < p.length; i++) p[i] ^= XORPAD[i % 0x7F];
    const blocks = scBlocks(p, [K_BOX, K_PARTY_8, K_PARTY_9]);
    const box = blocks[K_BOX];
    if (!box) return null; // Legends: Arceus uses a different box key
    const gen = blocks[K_PARTY_8] ? 8 : 9, party = blocks[gen === 8 ? K_PARTY_8 : K_PARTY_9];
    const at = gen === 8 ? 0xDE : 0xCE, r = collector();
    if (party) { const n = Math.min(party[6 * 0x158], 6); for (let i = 0; i < n; i++) r.add(pk89(party, i * 0x158, at), "p") }
    for (let o = 0; o + 0x158 <= box.length && o < 32 * 30 * 0x158; o += 0x158) r.add(pk89(box, o, at), "b");
    return { gen, game: null, label: gen === 8 ? "Sword / Shield" : "Scarlet / Violet", mons: r.mons, eggs: r.eggs };
  }

  /* ---------- container clean-up and detection ---------- */
  // Emulators append a real-time-clock footer (12-48 bytes) to Game Boy / GBA saves; DeSmuME appends a 122-byte footer.
  function unwrap(d) {
    const sig = "|-DESMUME SAVE-|";
    if (d.length > 0x7A && String.fromCharCode(...d.subarray(d.length - sig.length)) === sig) return d.subarray(0, d.length - 0x7A);
    const foot = d.length & 0x3F;
    if (foot && (foot === 7 || (foot % 2 === 0 && foot >= 0x0C && foot <= 0x30)) && [0x20000, 0x10000, 0x8000].includes(d.length - foot)) return d.subarray(0, d.length - foot);
    return d;
  }
  // Recognised formats that are not read yet, so the message can say so instead of "unknown".
  function recognised(d) {
    const sizes = { 0x100000: "Let's Go, Pikachu! / Eevee!", 0x136DDE: "Legends: Arceus", 0x13AD06: "Legends: Arceus", 0xE9828: "Brilliant Diamond / Shining Pearl", 0xEDC20: "Brilliant Diamond / Shining Pearl", 0xEED8C: "Brilliant Diamond / Shining Pearl", 0xEF0A4: "Brilliant Diamond / Shining Pearl", 0x2F3284: "Legends: Z-A", 0x2F3289: "Legends: Z-A", 0x309FA6: "Legends: Z-A", 0x309FB3: "Legends: Z-A" };
    return sizes[d.length] || null;
  }

  function parse(buffer) {
    let d = new Uint8Array(buffer);
    if (d.length < 0x100) return fail("This file is too small to be a save file.");
    d = unwrap(d);
    try {
      let r = null;
      if (d.length === 0x8000) r = readGen1(d) || readGen2(d);
      else if (d.length === 0x10000) r = readGen2(d) || readGen3(d);
      else if (d.length === 0x20000) r = readGen3(d);
      else if (d.length === 0x80000) r = readGen4(d) || readGen5(d);
      else r = readGen67(d) || (recognised(d) ? null : readGen89(d));
      if (r) return Object.assign({ ok: true }, r);
      const known = recognised(d);
      if (known) return fail("This looks like a " + known + " save. That format is not supported yet.");
    } catch (e) {
      return fail("The save file could not be read (" + e.message + ").");
    }
    return fail("Not a recognised Pokémon save file (" + d.length.toLocaleString("en-US") + " bytes).");
  }

  return { parse, GAMES, gameOf };
})();
if (typeof module !== "undefined") module.exports = SaveReader;
