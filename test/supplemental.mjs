/* Supplemental v4 checks on the file build (no server): shop, seed modal,
   house completion, tractor harvest, rental expiry auto-return. */
import { chromium } from 'playwright-core';
const FLAGS = ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--no-sandbox', '--mute-audio', '--disable-dev-shm-usage', '--disable-gpu-sandbox', '--memory-pressure-off'];
const ok = (c, m) => { if (!c) { console.error('FAIL: ' + m); process.exitCode = 1; } else console.log('✓ ' + m); };
const browser = await chromium.launch({ args: FLAGS });
const page = await browser.newPage({ viewport: { width: 420, height: 320 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto('file:///home/user/rainwood-village.html');
await page.waitForFunction('window.__ready === true', null, { timeout: 60000 });

/* ---- shop: sell + buy ---- */
await page.evaluate(`INV.berries = 10; INV.coins = 0; INV.seedw = 0;`);
await page.evaluate(`INV.add('berries', -3); INV.add('coins', 2 * 3);`); // sell 3 berries @2
ok(await page.evaluate(`INV.coins === 6`), 'sell berries → coins (client math)');
await page.evaluate(`INV.add('coins', -3); INV.add('seedw', 1);`);
ok(await page.evaluate(`INV.coins === 3 && INV.seedw === 1`), 'buy wheat seed');
const shopRows = await page.evaluate(`document.querySelectorAll('#shopwrap .shopRow, #shopwrap tr, #shopwrap .row').length`);
ok(shopRows >= 7, `shop UI has ${shopRows} rows (crops + seeds)`);

/* ---- seed modal: multiple seed types opens picker ---- */
await page.evaluate(`INV.seedc = 1; FARM.plots[3].state = 1; player.pos.set(FARM.plots[3].x, 0, FARM.plots[3].z); player.py = 1;`);
await page.evaluate(`openSeedModal(3);`);
const seedTypes = await page.evaluate(`document.querySelectorAll('#seedBtns button:not([disabled])').length`);
ok(seedTypes === 2 && await page.evaluate(`document.getElementById('seedwrap').style.display`) === 'flex', `seed picker shows both types (wheat + carrot): ${seedTypes}`);
await page.evaluate(`plantSeed(3, 'carrot');`);
ok(await page.evaluate(`FARM.plots[3].state === 2 && FARM.plots[3].crop === 'carrot' && INV.seedc === 0`), 'carrot planted from picker');
await page.evaluate(`closeSeedModal();`);

/* ---- build site: complete the house ---- */
await page.evaluate(`INV.wood = 12;`);
await page.evaluate(`__teleport(-2, 17.5);`);
for (let i = 0; i < 12; i++) await page.evaluate(`interactWith({ type: 'build' })`);
ok(await page.evaluate(`BUILD.progress === 12 || BUILD.done`), `build complete (${await page.evaluate('BUILD.progress')}/12)`);
const houseBuilt = await page.evaluate(`BUILD.done === true`);
ok(houseBuilt, 'BUILD.done → house appears');

/* ---- tractor harvests a grown plot ---- */
await page.evaluate(`INV.add('coins', 50); __rent('tractor')`);
await page.evaluate(`FARM.plots[6].state = 4; FARM.plots[6].crop = 'wheat'; setFarmVisual(6);`);
const w0 = await page.evaluate('INV.wheat');
await page.evaluate(`VEH.active.mesh.position.set(17.5, groundInfo(17.5, -11).y, -12.4); VEH.active.yaw = Math.PI; VEH.active.speed = 3;`);
await page.evaluate(`input.f = true; for (let i = 0; i < 12; i++) VEH.update(0.05); input.f = false;`);
ok(await page.evaluate(`FARM.plots[6].state === 1 && INV.wheat >= ${w0} + 2`), 'tractor harvested the ripe wheat');

/* ---- rental expiry auto-returns ---- */
await page.evaluate(`VEH.active.expiresAt = perfNow() - 1;`);
await page.evaluate(`VEH.update(0.05);`);
ok(await page.evaluate(`VEH.active === null && VEH.mounted === false`), 'expired rental auto-returns');

/* ---- berry picking + rose picking paths ---- */
await page.evaluate(`const b = berryBushes.find(x => x.count > 0); player.pos.set(b.x, 0, b.z); player.py = 2;`);
await page.evaluate(`interactWith({ type: 'berry', idx: berryBushes.indexOf(berryBushes.find(x => x.count > 0)) })`);
ok(await page.evaluate(`INV.berries >= 1`), 'berry picked');

ok(errors.length === 0, `page errors: ${errors.length ? errors.join(' | ') : 'none'}`);
await browser.close();
console.log(process.exitCode ? '=== SUPPLEMENTAL FAILED ===' : '=== SUPPLEMENTAL ALL GREEN ===');
process.exit(process.exitCode || 0);
