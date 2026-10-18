/* v4 E2E: hosted server, 2 players, vehicles, farming, build, train,
   challenges, chat, weather, and DB persistence across a restart.
   Max 2 browser worlds at once (sandbox RAM). */
import { chromium } from 'playwright-core';
import { spawn } from 'child_process';
import fs from 'fs';

const PORT = 8161;
const DB = '/home/user/test/village-db-test.json';
const FLAGS = ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--no-sandbox', '--mute-audio', '--disable-dev-shm-usage', '--disable-gpu-sandbox', '--memory-pressure-off'];
const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ` + m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => { console.error('WATCHDOG: forced exit after 20 min'); process.exit(1); }, 20 * 60 * 1000).unref();

function startServer() {
  const p = spawn('node', ['/home/user/village-server/server.js'], {
    env: { ...process.env, PORT: String(PORT), DB },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stdout.on('data', (d) => process.stdout.write('[srv] ' + d));
  p.stderr.on('data', (d) => process.stdout.write('[srv-err] ' + d));
  return p;
}
async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://localhost:${PORT}/healthz`); if (r.ok) return true; } catch (e) { }
    await sleep(500);
  }
  throw new Error('server did not come up');
}
async function joinPlayer(name, gender) {
  const browser = await chromium.launch({ args: FLAGS });
  const page = await browser.newPage({ viewport: { width: 320, height: 240 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForFunction('window.__ready === true', null, { timeout: 60000 });
  await page.evaluate(([n, g]) => {
    window.runHumanCheck = (cap, cb) => cb(cap.targets);
    document.getElementById('nameIn').value = n;
    MP.name = n; MP.gender = g;
  }, [name, gender]);
  await page.click('#btnSolo');
  await page.waitForFunction('MP.myId > 0 && MP.mode === "guest"', null, { timeout: 30000 });
  return { browser, page, errors, name };
}
const ok = (cond, msg) => { if (!cond) { console.error('FAIL: ' + msg); process.exitCode = 1; } else log('✓ ' + msg); };

for (const f of [DB, DB + '.bak', DB + '.tmp']) { try { fs.unlinkSync(f); } catch (e) { } }

let srv = startServer();
try {
  await waitUp();
  log('--- server up, joining Alice & Ben ---');
  const A = await joinPlayer('Alice', 'f');
  const B = await joinPlayer('Ben', 'm');
  const aid = await A.page.evaluate('MP.myId');
  const bid = await B.page.evaluate('MP.myId');
  ok(aid > 0 && bid > 0 && aid !== bid, `both joined (A=#${aid}, B=#${bid})`);

  await A.page.waitForFunction((id) => MP.rigs[id] && MP.rigs[id].name === 'Ben', bid, { timeout: 15000 }).catch(() => { });
  await B.page.waitForFunction((id) => MP.rigs[id] && MP.rigs[id].name === 'Alice', aid, { timeout: 15000 }).catch(() => { });
  ok(await A.page.evaluate((id) => !!MP.rigs[id], bid), 'A sees Ben');
  ok(await B.page.evaluate((id) => !!MP.rigs[id], aid), 'B sees Alice');
  ok((await B.page.evaluate('Object.keys(MP.bots).length')) >= 20, `bots visible (${await B.page.evaluate('Object.keys(MP.bots).length')})`);
  {
    const vBots = await B.page.evaluate("Object.values(MP.bots).filter(b => b.target.v).map(b => b.name + ':' + b.target.v)");
    ok(vBots.length >= 5, 'vehicle bots present: ' + vBots.join(', '));
  }
  ok(await A.page.evaluate('!!TR.base'), 'train clock synced from server');

  /* ---- chat + weather ---- */
  await A.page.evaluate(`MP.broadcast({ t: 'chat', name: MP.name, msg: 'hello village' })`);
  await B.page.waitForFunction(`document.getElementById('chatlog').textContent.includes('hello village')`, null, { timeout: 10000 }).catch(() => { });
  ok(await B.page.evaluate(`document.getElementById('chatlog').textContent.includes('hello village')`), 'chat relayed A→B');
  await A.page.evaluate(`WX.set('sunny', true); MP.broadcast({ t: 'wx', w: 'sunny' })`);
  await B.page.waitForFunction(`WX.mode === 'sunny'`, null, { timeout: 10000 }).catch(() => { });
  ok(await B.page.evaluate(`WX.mode === 'sunny'`), 'weather synced A→B');

  /* ---- tractor: rent, drive, auto-till ---- */
  await A.page.evaluate(`INV.add('coins', 80); INV.seedc = 0; INV.seedp = 0;`);
  await A.page.evaluate(`__rent('tractor')`);
  ok(await A.page.evaluate(`VEH.active && VEH.active.type === 'tractor' && VEH.mounted`), 'tractor rented + mounted');
  await A.page.evaluate(`VEH.active.mesh.position.set(17.5, groundInfo(17.5, -15.5).y, -15.5); VEH.active.yaw = Math.PI; VEH.active.speed = 4;`);
  await A.page.evaluate(`input.f = true; for (let i = 0; i < 60; i++) VEH.update(0.05); input.f = false;`);
  const tilled = await A.page.evaluate(`FARM.plots.map(p => p.state)`);
  ok(tilled[0] === 1 && tilled[6] === 1 && tilled[12] === 1, `tractor tilled column 0 (plots 0,6,12 = ${tilled[0]},${tilled[6]},${tilled[12]})`);

  /* ---- plant + water ---- */
  await A.page.evaluate(`player.pos.set(17.5, 0, -13.2); player.py = groundInfo(17.5, -13.2).y;`);
  await A.page.evaluate(`interactWith({ type: 'farm', idx: 0 })`);
  ok(await A.page.evaluate(`FARM.plots[0].state === 2 && FARM.plots[0].crop === 'wheat' && INV.seedw === 1`), 'wheat planted');
  await A.page.evaluate(`INV.add('water', 2); interactWith({ type: 'farm', idx: 0 })`);
  ok(await A.page.evaluate(`FARM.plots[0].state === 3`), 'plot watered');

  /* ---- truck: cargo unload at build site ---- */
  await A.page.evaluate(`VEH.returnVehicle()`);
  await A.page.evaluate(`__rent('truck')`);
  await A.page.evaluate(`VEH.active.cargo = 5; updateVehicleLogs(VEH.active.mesh, 5, 12);`);
  await A.page.evaluate(`VEH.active.mesh.position.set(-2, groundInfo(-2, 16.4).y, 16.4); VEH.active.yaw = Math.PI; VEH.active.speed = 2; input.f = true; for (let i = 0; i < 25; i++) VEH.update(0.05); input.f = false;`);
  await A.page.evaluate(`player.pos.copy(VEH.active.mesh.position); player.pos.y = 0; player.py = VEH.active.mesh.position.y;
    player.yaw = Math.atan2(-(BUILD.x - player.pos.x), -(BUILD.z - player.pos.z)); scanInteract();`);
  const buildPrompt = await A.page.evaluate(`currentInteract && currentInteract.type === 'build' ? currentInteract.label : null`);
  log('   build prompt: ' + buildPrompt);
  ok(buildPrompt && /unload/.test(buildPrompt), 'truck unload prompt at build site');
  await A.page.evaluate(`interactWith(currentInteract)`);
  ok(await A.page.evaluate(`BUILD.progress >= 5 && VEH.active && VEH.active.cargo === 0`), `wood unloaded → build ${await A.page.evaluate('BUILD.progress')}/12`);
  await B.page.waitForFunction(`BUILD.progress >= 5`, null, { timeout: 15000 }).catch(() => { });
  ok(await B.page.evaluate(`BUILD.progress >= 5`), 'build progress relayed to B');

  /* ---- chop a tree ---- */
  const treePos = await A.page.evaluate(`({ x: chopTrees[0].x, z: chopTrees[0].z })`);
  await A.page.evaluate(`VEH.returnVehicle()`);
  await A.page.evaluate(`__teleport(${treePos.x + 2}, ${treePos.z}, -Math.PI / 2)`);
  for (let i = 0; i < 3; i++) await A.page.evaluate(`interactWith({ type: 'tree', idx: 0 })`);
  ok(await A.page.evaluate(`chopTrees[0].state >= 2`), 'tree felled on A');
  await A.page.waitForFunction(`chopTrees[0].state === 3`, null, { timeout: 40000 }).catch(() => { });
  ok(await A.page.evaluate(`chopTrees[0].state === 3`), 'tree fell over (state 3)');
  await B.page.waitForFunction(`chopTrees[0].state === 3`, null, { timeout: 15000 }).catch(() => { });
  ok(await B.page.evaluate(`chopTrees[0].state === 3`), 'fell relayed to B');

  /* ---- challenges ---- */
  await A.page.evaluate(`CHALLENGES.start('forager')`);
  await A.page.evaluate(`CHALLENGES.bump('berry', 20)`);
  ok(await A.page.evaluate(`CHALLENGES.list.find(c => c.id === 'forager').state === 2`), 'forager challenge completed');
  const coinsBefore = await A.page.evaluate('INV.coins');
  await A.page.evaluate(`CHALLENGES.claim('forager')`);
  ok(await A.page.evaluate(`CHALLENGES.list.find(c => c.id === 'forager').state === 3 && INV.coins === ${coinsBefore} + 10`), 'reward claimed (+10 coins)');

  /* ---- vehicle relay: B sees Alice's car ---- */
  await A.page.evaluate(`__rent('car')`);
  await A.page.evaluate(`input.f = true; for (let i = 0; i < 20; i++) VEH.update(0.05); input.f = false;`);
  await A.page.evaluate(`for (let i = 0; i < 8; i++) MP.update(0.1);`);
  await B.page.waitForFunction((id) => MP.rigs[id] && MP.rigs[id].target.v === 'car' && !!MP.rigs[id].veh, aid, { timeout: 20000 }).catch(() => { });
  const bSees = await B.page.evaluate((id) => ({ v: MP.rigs[id] ? MP.rigs[id].target.v : null, veh: !!(MP.rigs[id] && MP.rigs[id].veh) }), aid);
  ok(bSees.v === 'car' && bSees.veh, `B sees Alice driving (${JSON.stringify(bSees)})`);
  await A.page.evaluate(`VEH.returnVehicle()`);
  await B.page.waitForFunction((id) => MP.rigs[id] && !MP.rigs[id].target.v, aid, { timeout: 20000 }).catch(() => { });
  ok(await B.page.evaluate((id) => MP.rigs[id] && !MP.rigs[id].veh, aid), 'vehicle gone after return');

  /* ---- close B before the long train wait (RAM) ---- */
  ok(B.errors.length === 0, `Ben page errors: ${B.errors.length ? B.errors.join(' | ') : 'none'}`);
  await B.browser.close();

  /* ---- train ride (real schedule) ---- */
  log('--- waiting for the train at Rainwood Station ---');
  await A.page.evaluate(`CHALLENGES.start('conductor')`);
  await A.page.waitForFunction(`TR.state().stoppedAt === 'station'`, null, { timeout: 120000 });
  const boarded = await A.page.evaluate(`const s = TR.state(); const bz = s.z + TR.rideOffs[0];
    player.pos.set(44.6, 0, bz); player.py = groundInfo(44.6, bz).y;
    player.yaw = Math.atan2(-(STATION.trackX - player.pos.x), 0);
    scanInteract(); doInteract(); !!player.riding`);
  ok(boarded, 'boarded the train at the station');
  await A.page.waitForFunction(`TR.state().stoppedAt === null`, null, { timeout: 30000 });
  await A.page.waitForFunction(`!!player.riding && Math.abs(player.pos.z - 3) > 4`, null, { timeout: 30000 });
  ok(true, 'riding down the line (z=' + await A.page.evaluate('player.pos.z.toFixed(0)') + ')');
  await A.page.waitForFunction(`TR.state().stoppedAt === 'halt'`, null, { timeout: 140000 });
  await A.page.evaluate(`doInteract()`);
  ok(await A.page.evaluate(`!player.riding && Math.abs(player.pos.x - 46.5) < 6 && player.pos.z < -60`), 'hopped off at Meadow Halt (z=' + await A.page.evaluate('player.pos.z.toFixed(0)') + ')');
  ok(await A.page.evaluate(`CHALLENGES.list.find(c => c.id === 'conductor').state === 2`), 'conductor challenge completed by the ride');

  /* ---- fell a FRESH tree right before the restart (tree 0 has regrown by now) ---- */
  const tree1 = await A.page.evaluate(`({ x: chopTrees[1].x, z: chopTrees[1].z })`);
  await A.page.evaluate(`__teleport(${tree1.x + 2}, ${tree1.z}, -Math.PI / 2)`);
  for (let i = 0; i < 3; i++) await A.page.evaluate(`interactWith({ type: 'tree', idx: 1 })`);
  ok(await A.page.evaluate(`chopTrees[1].state >= 2`), 'fresh tree felled for the persistence check');

  /* ---- persistence ---- */
  log('--- persistence across restart ---');
  await sleep(6000);
  const db = await (await fetch(`http://localhost:${PORT}/db.json`)).json();
  ok(db.farm[0].s >= 3 && db.farm[0].c === 'wheat', `db: plot0 = [${db.farm[0].s}, ${db.farm[0].c}] (4 = server grew the wheat!)`);
  ok(db.build[0] === 5, `db: build = ${db.build[0]}/12`);
  ok(Array.isArray(db.trees) && db.trees.some((t) => t.i === 1), 'db: felled tree recorded');
  ok(db.weather === 'sunny', 'db: weather saved');

  srv.kill('SIGTERM');
  await sleep(1500);
  srv = startServer();
  await waitUp();
  ok(A.errors.length === 0, `Alice page errors: ${A.errors.length ? A.errors.join(' | ') : 'none'}`);
  await A.browser.close(); // only one world from here

  const C = await joinPlayer('Cara', 'f');
  ok(await C.page.evaluate(`FARM.plots[0].state >= 3 && FARM.plots[0].crop === 'wheat' && FARM.plots[6].state === 1`), `Cara sees the grown wheat + tilled plots after restart (plot0=${await C.page.evaluate('FARM.plots[0].state')})`);
  ok(await C.page.evaluate(`BUILD.progress === 5`), 'Cara sees build progress 5 after restart');
  ok(await C.page.evaluate(`chopTrees[1].state === 3`), 'Cara sees the fresh-felled tree after restart');
  ok(await C.page.evaluate(`WX.mode === 'sunny'`), 'weather restored');
  ok(await C.page.evaluate('Object.keys(MP.bots).length >= 20'), `bots alive after restart (${await C.page.evaluate('Object.keys(MP.bots).length')})`);
  ok(await C.page.evaluate('!!TR.base'), 'train clock synced after restart');

  /* ---- rejoin test: Alice comes back with a NEW connection ---- */
  const A2 = await joinPlayer('Alice', 'f');
  const a2id = await A2.page.evaluate('MP.myId');
  await C.page.waitForFunction((id) => !!MP.rigs[id], a2id, { timeout: 15000 }).catch(() => { });
  ok(await C.page.evaluate((id) => !!MP.rigs[id], a2id), 'Cara sees the returning Alice');
  await A2.browser.close();
  await C.page.waitForFunction((id) => !MP.rigs[id], a2id, { timeout: 20000 }).catch(() => { });
  ok(await C.page.evaluate((id) => !MP.rigs[id], a2id), 'Alice disappears again after leaving');
  ok(C.errors.length === 0, `Cara page errors: ${C.errors.length ? C.errors.join(' | ') : 'none'}`);
  await C.browser.close();
} catch (e) {
  console.error('E2E crashed: ' + (e && e.stack || e));
  process.exitCode = 1;
} finally {
  try { srv.kill('SIGTERM'); } catch (e) { }
}
console.log(process.exitCode ? '=== E2E FAILED ===' : '=== E2E ALL GREEN ===');
process.exit(process.exitCode || 0);
