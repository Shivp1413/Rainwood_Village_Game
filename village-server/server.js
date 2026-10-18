#!/usr/bin/env node
/* ============================================================
   Rainwood Village — persistent multiplayer server
   Pure Node.js, zero dependencies. Run:  node server.js
   Then open  http://localhost:8111  (or http://<your-ip>:8111)

   The village lives in village-db.json: every house built, plot
   planted … survives restarts. Players are ephemeral
   (name only, no accounts) — the world is what persists.
   ============================================================ */
'use strict';
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT || '8111', 10);
const INDEX = path.join(__dirname, 'public', 'index.html');
const DB_PATH = path.resolve(__dirname, process.env.DB || 'village-db.json');
const BAK_PATH = DB_PATH + '.bak';

/* ---------------- helpers ---------------- */
function sanitizeName(s) {
  return String(s || '').replace(/[<>&"'`\\\x00-\x1f]/g, '').trim().slice(0, 14) || 'Friend';
}
function isFiniteNum(v) { return typeof v === 'number' && isFinite(v); }
function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

/* ---------------- world constants (must match the client build) ---------------- */
const N_PLOTS = 18;
const CROPS = { wheat: 60000, carrot: 110000, pumpkin: 170000 }; // grow ms
const BERRY_REGEN_MS = 45000;
const TREE_REGEN_MS = 75000;
const ROSE_REGEN_MS = 120000;
const VEHICLES = ['tractor', 'car', 'truck'];

/* ---------------- world state (server authority, persisted) ---------------- */
const world = {
  farm: [],        // [{s, c, at}]  s: 0 empty 1 tilled 2 planted 3 watered 4 grown
  build: [0, 0],   // progress, done
  weather: 'rainy',
  trees: [],       // [{i, until}] felled, waiting to regrow
  berries: [],     // [{i, until}] picked empty
  roses: [],       // [{i, until}] picked
  berryCount: {},  // i -> berries left on the bush
};
for (let i = 0; i < N_PLOTS; i++) world.farm.push({ s: 0, c: null, at: 0 });
const FARM_TRANS = { '0-1': 'till', '1-2': 'plant', '2-3': 'water', '4-1': 'harvest' };

/* ---------------- database file ---------------- */
let dirty = false, saveCount = 0, lastBak = 0;
function markDirty() { dirty = true; }
function dbState() {
  return {
    v: 4, savedAt: Date.now(),
    farm: world.farm.map((p) => ({ s: p.s, c: p.c, at: p.at })),
    build: [world.build[0], world.build[1]],
    weather: world.weather,
    trees: world.trees.map((t) => ({ i: t.i, until: t.until })),
    berries: world.berries.map((b) => ({ i: b.i, until: b.until })),
    roses: world.roses.map((r) => ({ i: r.i, until: r.until })),
    berryCount: world.berryCount,
  };
}
function saveNow(quiet) {
  try {
    const tmp = DB_PATH + '.tmp';
    // keep a backup copy every ~10 minutes
    try {
      const st = fs.statSync(DB_PATH);
      if (st.isFile() && Date.now() - lastBak > 600000) {
        fs.copyFileSync(DB_PATH, BAK_PATH);
        lastBak = Date.now();
      }
    } catch (e) { /* no file yet */ }
    fs.writeFileSync(tmp, JSON.stringify(dbState()));
    fs.renameSync(tmp, DB_PATH);
    saveCount++;
    if (!quiet) console.log(`[db] village saved (${saveCount} saves) → ${path.basename(DB_PATH)}`);
  } catch (e) {
    console.error('[db] save failed:', e.message);
  }
}
function loadDB() {
  const tryParse = (p) => {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
  };
  let db = tryParse(DB_PATH);
  if (!db) {
    db = tryParse(BAK_PATH);
    if (db) console.log('[db] main db unreadable — restored from backup');
  }
  if (!db || !Array.isArray(db.farm)) {
    console.log('[db] no village-db.json — starting a fresh village');
    return false;
  }
  const now = Date.now();
  world.farm = [];
  for (let i = 0; i < N_PLOTS; i++) {
    const p = db.farm[i] || {};
    world.farm.push({
      s: [0, 1, 2, 3, 4].includes(p.s) ? p.s : 0,
      c: CROPS[p.c] ? p.c : null,
      at: isFiniteNum(p.at) ? p.at : 0,
    });
  }
  if (Array.isArray(db.build)) {
    world.build[0] = clamp(db.build[0] | 0, 0, 12);
    world.build[1] = db.build[1] ? 1 : 0;
  }
  world.weather = ['sunny', 'rainy', 'night'].includes(db.weather) ? db.weather : 'rainy';
  const alive = (arr, regen) => (Array.isArray(arr) ? arr : [])
    .filter((t) => t && isFiniteNum(t.i) && isFiniteNum(t.until) && t.until > now)
    .slice(0, 400)
    .map((t) => ({ i: clamp(t.i | 0, 0, 400), until: t.until }));
  world.trees = alive(db.trees, TREE_REGEN_MS);
  world.berries = alive(db.berries, BERRY_REGEN_MS);
  world.roses = alive(db.roses, ROSE_REGEN_MS);
  world.berryCount = {};
  if (db.berryCount && typeof db.berryCount === 'object') {
    for (const k of Object.keys(db.berryCount).slice(0, 200)) {
      const v = db.berryCount[k] | 0;
      if (v > 0 && v <= 4) world.berryCount[clamp(k | 0, 0, 200)] = v;
    }
  }
  console.log(`[db] village restored: build ${world.build[0]}/12` +
    `${world.build[1] ? ' (done)' : ''}, weather ${world.weather}`);
  return true;
}

/* ---------------- bots ---------------- */
const BOT_PATHS = [
  [[38, 14], [26, 6], [16, 4], [13.4, 2.3], [-2, 1.5], [-19, -1.2], [-30, -2]],
  [[16, 4], [15, -6], [14, -13], [10.5, -16], [9.3, -17.4]],
  [[20, 6], [23, 13], [24.3, 19.6]],
  [[-1.2, 1.7], [-6, 8], [-12, 12.4], [-15.4, 13.6]],
  [[38, 14], [41.5, 9], [43.2, 5.2]],
  [[23, -11], [15, -6], [16, 4]],
  [[17.5, 2.5], [20, -10], [14, -13], [12, -3]],
  [[-1.2, 1.7], [-4, 12], [-8, 26], [-16, 32], [-22, 34]],   // to the rental barn
  [[38, 22], [47, 23.2], [57, 24]],                          // hillcrest lane
  [[43.2, 5.2], [44.6, -18], [44.8, -46], [44.5, -76]],      // the long walk to the halt
  /* v5: the wider village */
  [[-10, -17], [-15, -22], [-19, -26], [-22, -31], [-24, -33]],       // the square
  [[-19, -26], [-15, -32], [-13, -38], [-12, -42]],                   // to the gallery
  [[-28, -33.5], [-31, -28], [-33, -24], [-35, -21.5]],               // to the museum
  [[-46, 54], [-30, 54], [-14, 54]],                                  // north estate
  [[-46, 80], [-30, 80], [-14, 80]],
  [[-46, 106], [-30, 106], [-14, 106]],
  [[66, -48], [66, -10], [66, 30]],                                   // east meadows
  [[90, -48], [90, 0], [90, 36]],
  [[114, -44], [114, -10], [114, 30]],
  [[-34, -62], [-24, -62], [-16, -62]],                               // south rows
  [[12, -62], [24, -62], [34, -62]],
  [[-34, -84], [-24, -84], [-16, -84]],
  [[8, -84], [16, -84], [30, -84]],
  [[-72, -26], [-72, 0], [-72, 32]],                                  // west hamlet
  [[-96, -20], [-96, 4], [-96, 28]],
  [[-28, -130], [-16, -130], [-6, -130]],                             // far south
  [[-38, 130], [-20, 130], [-2, 130]],                                // far north
  [[-18, 44], [6, 43], [22, 42]],                                     // north bridge
  [[-14, -46], [0, -48], [14, -48], [24, -44]],                       // south bridge
  [[66, 42], [76, 46], [86, 48]],                                     // east north link
  [[-24, 34], [-40, 38], [-56, 36], [-68, 30]],                       // rental → west hamlet
];
const BOT_NAMES = [
  ['Mila', 'f'], ['Jonas', 'm'], ['Greta', 'f'], ['Piet', 'm'],
  ['Alma', 'f'], ['Ruben', 'm'], ['Freja', 'f'], ['Ivo', 'm'],
  ['Nora', 'f'], ['Timo', 'm'], ['Svea', 'f'], ['Otto', 'm'],
  ['Lena', 'f'], ['Kaspar', 'm'], ['Ines', 'f'], ['Jonte', 'm'],
  ['Rosa', 'f'], ['Elias', 'm'], ['Tilda', 'f'], ['Aron', 'm'],
  ['Maja', 'f'], ['Levin', 'm'],
];
const bots = BOT_NAMES.map((nb, i) => {
  const p = BOT_PATHS[i % BOT_PATHS.length];
  return {
    id: 10001 + i, name: nb[0], gender: nb[1],
    path: p, seg: Math.floor(Math.random() * p.length), dir: Math.random() < 0.5 ? 1 : -1,
    x: p[0][0] + (Math.random() * 4 - 2), z: p[0][1] + (Math.random() * 4 - 2),
    yaw: Math.random() * 6.28, speed: 0.9 + Math.random() * 0.5,
    pause: 0, v: 0,
  };
});
/* v5: villagers that drive loops through the village */
const VEHICLE_BOTS = [
  { n: 'Klara', g: 'f', v: 'bike', speed: 4.2, path: [[16, 4], [20, 6], [23, 13], [24.3, 19.6], [20, 26], [14, 20], [15, -6], [16, 4]] },
  { n: 'Henrik', g: 'm', v: 'car', speed: 7, path: [[38, 14], [26, 6], [16, 4], [-10, 1], [-19, -2], [-30, -2], [-36, 10], [-30, 30], [-20, 42], [10, 42], [24, 44], [34, 40], [38, 22], [38, 14]] },
  { n: 'Bo', g: 'm', v: 'tractor', speed: 2.7, path: [[33, -17], [27, -13], [19, -15], [14, -19], [16, -26], [25, -26], [31, -22], [33, -17]] },
  { n: 'Stina', g: 'f', v: 'bike', speed: 4, path: [[16, 4], [20, 6], [23, 13], [24.3, 19.6], [28, 32], [24, 42], [-4, 41], [-14, 38], [-24, 34], [-32, 30], [-36, 10], [-30, -2], [-19, -1.2], [16, 4]] },
  { n: 'Ravi', g: 'm', v: 'car', speed: 6.5, path: [[43.2, 5.2], [50, -2], [56, -11], [64, -18], [74, -36], [82, -50], [94, -52], [104, -44], [106, -30], [104, -10], [96, -6], [84, -10], [70, -14], [58, -12], [50, -4], [43.2, 5.2]] },
];
VEHICLE_BOTS.forEach((vb, i) => {
  bots.push({
    id: 20001 + i, name: vb.n, gender: vb.g, v: vb.v,
    path: vb.path, seg: 0, dir: 1,
    x: vb.path[0][0], z: vb.path[0][1],
    yaw: 0, speed: vb.speed, pause: 0, loop: true,
  });
});
function tickBots(dt) {
  for (const b of bots) {
    if (b.pause > 0) { b.pause -= dt; continue; }
    let tgt = b.path[b.seg + b.dir];
    if (!tgt) {
      if (b.loop) { b.seg = 0; tgt = b.path[1]; }
      else { b.dir *= -1; b.pause = 1 + Math.random() * 3; tgt = b.path[b.seg + b.dir]; }
      if (!tgt) continue;
    }
    const dx = tgt[0] - b.x, dz = tgt[1] - b.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.3) {
      b.seg += b.dir;
      if (!b.loop && (b.seg <= 0 || b.seg >= b.path.length - 1)) { b.dir *= -1; b.pause = 2 + Math.random() * 4; }
      continue;
    }
    b.x += (dx / d) * b.speed * dt;
    b.z += (dz / d) * b.speed * dt;
    b.yaw = Math.atan2(dx, dz);
  }
}

/* ---------------- connections ---------------- */
let nextId = 1;
const clients = new Map(); // socket -> state

/* ---------- minimal websocket ---------- */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
function wsAccept(key) {
  return crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
}
function encodeFrame(str) {
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81; header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81; header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}
function parseFrames(state) {
  const frames = [];
  let buf = state.buf;
  while (true) {
    if (buf.length < 2) break;
    const fin = (buf[0] & 0x80) !== 0;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let off = 2;
    if (len === 126) {
      if (buf.length < 4) break;
      len = buf.readUInt16BE(2); off = 4;
    } else if (len === 127) {
      if (buf.length < 10) break;
      const big = buf.readBigUInt64BE(2);
      if (big > BigInt(32768)) throw new Error('frame too large');
      len = Number(big); off = 10;
    }
    if (len > 32768) throw new Error('frame too large');
    const maskLen = masked ? 4 : 0;
    if (buf.length < off + maskLen + len) break;
    let payload = buf.slice(off + maskLen, off + maskLen + len);
    if (masked) {
      const mask = buf.slice(off, off + 4);
      payload = Buffer.from(payload);
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    }
    buf = buf.slice(off + maskLen + len);
    frames.push({ fin, opcode, payload });
  }
  state.buf = buf;
  return frames;
}
function wsSend(sock, obj) {
  if (sock.writable) {
    try { sock.write(encodeFrame(typeof obj === 'string' ? obj : JSON.stringify(obj))); } catch (e) { }
  }
}
function wsClose(sock) {
  try { sock.write(Buffer.from([0x88, 0x00])); } catch (e) { }
  try { sock.end(); } catch (e) { }
}

/* ---------- rate limiting: token bucket ---------- */
function allow(st, cost) {
  const now = Date.now();
  if (!st.tokens) { st.tokens = 30; st.lastRefill = now; }
  st.tokens = Math.min(30, st.tokens + (now - st.lastRefill) * 0.012); // ~12/s refill
  st.lastRefill = now;
  if (st.tokens >= cost) { st.tokens -= cost; return true; }
  return false;
}

/* ---------- snapshots ---------- */
function broadcast(obj, exceptSock) {
  const s = JSON.stringify(obj);
  for (const [sock, st] of clients) {
    if (sock !== exceptSock && st.joined) wsSend(sock, s);
  }
}
function playersSnapshot(exceptId) {
  const out = {};
  for (const [, st] of clients) {
    if (st.joined && st.id !== exceptId) {
      out[st.id] = {
        n: st.name, g: st.gender, x: st.lastX, y: st.lastY, z: st.lastZ,
        yaw: st.lastYaw, a: st.lastA, v: st.lastV, vy: st.lastVy,
      };
    }
  }
  return out;
}
function worldSnapshot() {
  const now = Date.now();
  return {
    farm: world.farm.map((p) => [
      p.s, p.c || 0,
      p.s === 3 ? Math.max(0, (CROPS[p.c] || CROPS.wheat) - (now - p.at)) : 0,
    ]),
    build: [world.build[0], world.build[1]],
    trees: world.trees.map((t) => [t.i, Math.max(0, t.until - now)]),
    berries: world.berries.map((b) => [b.i, Math.max(0, b.until - now)]),
    roses: world.roses.map((r) => [r.i, Math.max(0, r.until - now)]),
  };
}
function botSnapshot() {
  return bots.map((b) => [b.id, +b.x.toFixed(2), 0, +b.z.toFixed(2), +b.yaw.toFixed(2), b.name, b.gender, b.v || 0]);
}

/* ---------- message handling ---------- */
function handleMessage(sock, st, m) {
  if (!m || typeof m !== 'object') return;
  if (!allow(st, 1)) return; // generic rate limit

  if (m.t === 'cap') {
    if (st.joined || st.verified) return;
    st.capTries = (st.capTries || 0) + 1;
    if (st.capTries > 4) { wsSend(sock, { t: 'capfail' }); wsClose(sock); return; }
    const stops = Array.isArray(m.stops) ? m.stops : [];
    const ok2 = st.capTargets && st.capTargets.every((tg, i) => {
      const s = stops[i];
      if (typeof s !== 'number' || !isFinite(s)) return false;
      const diff = Math.abs(((s - tg + 180 + 360) % 360) - 180);
      return diff <= 34;
    });
    if (ok2) {
      st.verified = true;
      wsSend(sock, { t: 'capok' });
    } else {
      wsSend(sock, { t: 'cap', targets: [Math.floor(Math.random() * 360), Math.floor(Math.random() * 360)] });
    }
    return;
  }

  if (m.t === 'join') {
    if (st.joined) return;
    if (!st.verified) { wsClose(sock); return; }
    st.joined = true;
    st.id = nextId++;
    st.name = sanitizeName(m.name);
    st.gender = m.gender === 'm' ? 'm' : 'f';
    st.lastX = isFiniteNum(m.x) ? clamp(m.x, -126, 126) : 14;
    st.lastY = isFiniteNum(m.y) ? clamp(m.y, -10, 30) : 1;
    st.lastZ = isFiniteNum(m.z) ? clamp(m.z, -126, 126) : 5;
    wsSend(sock, {
      t: 'welcome', id: st.id, wx: world.weather, world: worldSnapshot(),
      players: playersSnapshot(st.id), tr: Date.now(), bots: botSnapshot(),
    });
    broadcast({ t: 'join', id: st.id, n: st.name, g: st.gender, x: st.lastX, y: st.lastY, z: st.lastZ }, sock);
    console.log(`[+] ${st.name} (#${st.id}) — ${countJoined()} villagers in-world`);
    return;
  }

  if (!st.joined) return;

  if (m.t === 'st') {
    if (!allow(st, 0.85)) return;
    if (!isFiniteNum(m.x) || !isFiniteNum(m.z)) return;
    st.lastX = clamp(m.x, -126, 126);
    st.lastY = isFiniteNum(m.y) ? clamp(m.y, -10, 30) : st.lastY;
    st.lastZ = clamp(m.z, -126, 126);
    st.lastYaw = isFiniteNum(m.yaw) ? m.yaw : 0;
    st.lastA = ['idle', 'walk', 'run', 'chop'].includes(m.a) ? m.a : 'idle';
    st.lastV = VEHICLES.includes(m.v) ? m.v : 0;
    st.lastVy = isFiniteNum(m.vy) ? clamp(m.vy, -100, 100) : 0;
    const msg = JSON.stringify({
      t: 'st', id: st.id, x: st.lastX, y: st.lastY, z: st.lastZ, yaw: st.lastYaw,
      a: st.lastA, n: st.name, g: st.gender, v: st.lastV, vy: st.lastVy,
    });
    for (const [s2, st2] of clients) {
      if (s2 !== sock && st2.joined) wsSend(s2, msg);
    }
    return;
  }

  if (m.t === 'chat') {
    const now = Date.now();
    if (now - (st.lastChat || 0) < 400) return;
    st.lastChat = now;
    const msg = String(m.msg || '').replace(/[\x00-\x1f]/g, '').slice(0, 200);
    if (!msg.trim()) return;
    broadcast({ t: 'chat', name: st.name, msg });
    return;
  }

  if (m.t === 'wx') {
    if (!['sunny', 'rainy', 'night'].includes(m.w)) return;
    if (world.weather === m.w) return;
    world.weather = m.w;
    markDirty();
    broadcast({ t: 'wx', w: m.w }, sock);
    console.log(`[w] weather → ${m.w} (by ${st.name})`);
    return;
  }

  if (m.t === 'p2p') {
    const to = m.to | 0;
    const payload = m.m;
    if (!payload || typeof payload !== 'object' || typeof payload.t !== 'string') return;
    for (const [s2, st2] of clients) {
      if (st2.joined && st2.id === to) { wsSend(s2, { t: 'p2p', m: payload }); return; }
    }
    return;
  }

  if (m.t === 'ev') {
    const ev = m.ev;
    if (!ev || typeof ev !== 'object' || typeof ev.k !== 'string') return;
    if (ev.k === 'farm') {
      const i = ev.i | 0;
      if (i < 0 || i >= N_PLOTS) return;
      const next = { till: 1, plant: 2, water: 3, harvest: 1 }[ev.a];
      const key = `${world.farm[i].s}-${next}`;
      if (!FARM_TRANS[key]) return; // invalid transition
      if (ev.a === 'plant' && !CROPS[ev.c]) return;
      world.farm[i].s = next;
      if (ev.a === 'plant') world.farm[i].c = ev.c;
      if (ev.a === 'harvest') world.farm[i].c = null;
      if (ev.a === 'water') world.farm[i].at = Date.now();
      markDirty();
    } else if (ev.k === 'build') {
      if (world.build[1]) return;
      const n = clamp(ev.n | 0, 1, 12);
      world.build[0] = Math.min(12, world.build[0] + n);
      if (world.build[0] >= 12) world.build[1] = 1;
      markDirty();
    } else if (ev.k === 'fell') {
      const i = ev.i | 0;
      if (i < 0 || i > 400) return;
      if (!world.trees.some((t) => t.i === i)) {
        world.trees.push({ i, until: Date.now() + TREE_REGEN_MS });
        if (world.trees.length > 400) world.trees.shift();
        markDirty();
      }
    } else if (ev.k === 'berry') {
      const i = ev.i | 0;
      if (i < 0 || i > 200) return;
      world.berryCount[i] = (world.berryCount[i] === undefined ? 4 : world.berryCount[i]) - 1;
      if (world.berryCount[i] <= 0) {
        delete world.berryCount[i];
        if (!world.berries.some((b) => b.i === i)) {
          world.berries.push({ i, until: Date.now() + BERRY_REGEN_MS });
          markDirty();
        }
      }
    } else if (ev.k === 'rose') {
      const i = ev.i | 0;
      if (i < 0 || i > 200) return;
      if (!world.roses.some((r) => r.i === i)) {
        world.roses.push({ i, until: Date.now() + ROSE_REGEN_MS });
        markDirty();
      }
    }
    broadcast({ t: 'fx', ev }, sock);
    return;
  }
}

function countJoined() {
  let n = 0;
  for (const [, st] of clients) if (st.joined) n++;
  return n;
}

/* ---------------- http server ---------------- */
let indexHtml = null;
try { indexHtml = fs.readFileSync(INDEX); }
catch (e) {
  console.error('!! could not read public/index.html — run the client build first (src/build.py)');
  process.exit(1);
}
const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(indexHtml);
  } else if (url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
  } else if (url === '/db.json') {
    // read-only peek at the persisted village (no credentials, no writes)
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(dbState()));
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('404');
  }
});

server.on('upgrade', (req, sock) => {
  const key = req.headers['sec-websocket-key'];
  if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') {
    sock.destroy(); return;
  }
  // Only allow same-origin / local requests (basic hardening)
  const origin = req.headers.origin || '';
  const host = req.headers.host || '';
  if (origin && host && !origin.includes(host)) {
    sock.write('HTTP/1.1 403 Forbidden\r\n\r\n'); sock.destroy(); return;
  }
  sock.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${wsAccept(key)}\r\n\r\n`
  );
  sock.setNoDelay(true);
  const st = {
    id: 0, name: '?', gender: 'f', joined: false, verified: false,
    capTargets: [Math.floor(Math.random() * 360), Math.floor(Math.random() * 360)],
    capTries: 0, buf: Buffer.alloc(0), alive: true,
    lastV: 0, lastVy: 0,
  };
  clients.set(sock, st);
  // send the human check right away
  wsSend(sock, { t: 'cap', targets: st.capTargets });

  sock.on('data', (chunk) => {
    st.buf = Buffer.concat([st.buf, chunk]);
    if (st.buf.length > 65536) { wsClose(sock); return; }
    let frames;
    try { frames = parseFrames(st); }
    catch (e) { wsClose(sock); return; }
    for (const f of frames) {
      if (f.opcode === 8) { wsClose(sock); return; }
      if (f.opcode === 9) { // ping → pong
        try { sock.write(Buffer.from([0x8a, 0x00])); } catch (e) { }
        continue;
      }
      if (f.opcode === 1 || f.opcode === 2) {
        let m;
        try { m = JSON.parse(f.payload.toString('utf8')); }
        catch (e) { continue; }
        try { handleMessage(sock, st, m); } catch (err) { console.error('handler error', err.message); }
      }
    }
  });
  const drop = () => {
    if (clients.has(sock)) {
      clients.delete(sock);
      if (st.joined) {
        broadcast({ t: 'left', id: st.id });
        console.log(`[-] ${st.name} left — ${countJoined()} in-world`);
      }
    }
  };
  sock.on('close', drop);
  sock.on('error', drop);
});

/* ---------------- loops ---------------- */
let lastTick = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = Math.min((now - lastTick) / 1000, 0.5);
  lastTick = now;
  tickBots(dt);
}, 250);
setInterval(() => {
  broadcast({ t: 'bots', b: botSnapshot() });
}, 500);
// crops grow server-side too, so late joiners see the truth
setInterval(() => {
  const now = Date.now();
  let grew = false;
  for (let i = 0; i < N_PLOTS; i++) {
    const p = world.farm[i];
    if (p.s === 3 && now - p.at > (CROPS[p.c] || CROPS.wheat)) {
      p.s = 4; grew = true;
    }
  }
  if (grew) markDirty();
}, 3000);
// shared train clock
setInterval(() => {
  broadcast({ t: 'tr', e: Date.now() });
}, 10000);
// autosave (debounced) + safety save
setInterval(() => {
  if (dirty) { dirty = false; saveNow(); }
}, 4000);
setInterval(() => { saveNow(true); }, 180000);

/* ---------------- boot ---------------- */
loadDB();
saveNow(true); // make sure the file exists right away

function shutdown() {
  console.log('\n[db] saving village before shutdown…');
  saveNow();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  🌧️  Rainwood Village server is running');
  console.log(`  →  http://localhost:${PORT}`);
  const os = require('os');
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const addr of ifs[name]) {
      if (addr.family === 'IPv4' && !addr.internal) {
        console.log(`  →  http://${addr.address}:${PORT}   (share this on your wifi)`);
      }
    }
  }
  console.log('');
  console.log(`  📜 village database: ${DB_PATH}`);
  console.log('     (delete it to reset the village — a .bak backup is kept too)');
  console.log('  No logins, no accounts — join with any name. Ctrl+C to stop.');
});
