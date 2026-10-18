/* boot check for both builds: world builds, v5 features present, no page errors */
import { chromium } from 'playwright-core';
const FLAGS = ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--no-sandbox', '--mute-audio', '--disable-dev-shm-usage', '--disable-gpu-sandbox', '--memory-pressure-off'];
const browser = await chromium.launch({ args: FLAGS });
const ok = (c, m) => { if (!c) { console.error('FAIL: ' + m); process.exitCode = 1; } else console.log('✓ ' + m); };

for (const [name, url] of [['FILE', 'file:///home/user/rainwood-village.html'], ['HOSTED', 'http://localhost:8111/']]) {
  const page = await browser.newPage({ viewport: { width: 420, height: 320 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(url, { waitUntil: 'load', timeout: 90000 });
  await page.waitForFunction('window.__ready === true', null, { timeout: 90000 });
  await page.evaluate(`window.runHumanCheck = (cap, cb) => cb(cap.targets); document.getElementById('nameIn').value='T'; MP.name='T'`);
  await page.click('#btnSolo');
  if (name === 'HOSTED') {
    await page.waitForFunction('MP.myId > 0 && MP.mode === "guest"', null, { timeout: 30000 });
    await page.waitForFunction('Object.keys(MP.bots).length >= 20', null, { timeout: 15000 }).catch(() => { });
  }
  await page.waitForTimeout(1500);
  const st = await page.evaluate(() => {
    const civic = HOUSES.filter((h) => h.kind);
    // grounding: worst gap under full/civic houses
    let worst = 0, worstName = '';
    for (const H of HOUSES) {
      if (H.simple) continue;
      for (const [lx, lz] of [[H.w / 2, H.d / 2], [-H.w / 2, H.d / 2], [H.w / 2, -H.d / 2], [-H.w / 2, -H.d / 2], [0, H.d / 2], [0, -H.d / 2]]) {
        const w = houseToWorld(H, lx, lz);
        const gap = H.baseY - worldHeight(w.x, w.z);
        if (gap > worst) { worst = gap; worstName = H.name; }
      }
    }
    // simple houses: terrain must be within 1.2m under the base (plinth depth)
    let worstS = 0;
    for (const H of HOUSES) {
      if (!H.simple) continue;
      const gap = H.baseY - worldHeight(H.x + Math.cos(H.rot) * H.w * 0.4, H.z - Math.sin(H.rot) * H.w * 0.4);
      if (gap > worstS) worstS = gap;
    }
    return {
      houses: HOUSES.length, simple: HOUSES.filter((h) => h.simple).length,
      civic: civic.map((h) => h.kind), bridges: BRIDGES.length, paths: PATHS.length,
      villagers: villagers.length, drivers: drivers.length,
      driverTypes: drivers.map((d) => d.type),
      bots: Object.keys(MP.bots).length,
      botDrivers: Object.values(MP.bots).filter((b) => b.target.v).map((b) => b.name + ':' + b.target.v),
      chopTrees: chopTrees.length, berries: berryBushes.length, roses: roses.length,
      plaques: PLAQUES.length,
      trainPeriod: TR.period && +TR.period.toFixed(1),
      worstGap: +worst.toFixed(2), worstName, worstSimpleGap: +worstS.toFixed(2),
      bikeRent: !!RENT.bike, pads: RENTAL_PADS.length,
      world: WORLD.size, fps: window.__fps || 0,
    };
  });
  console.log(`=== ${name} ===`);
  console.log(JSON.stringify(st, null, 1));
  ok(st.houses >= 100, `${name}: ≥100 houses (${st.houses})`);
  ok(st.civic.length === 4, `${name}: 4 civic buildings (${st.civic.join(',')})`);
  ok(st.bridges === 4, `${name}: 4 bridges`);
  ok(st.villagers >= 30, `${name}: ≥30 villagers (${st.villagers})`);
  ok(st.drivers === 5, `${name}: 5 drivers (${st.driverTypes.join(',')})`);
  ok(st.plaques >= 10, `${name}: ${st.plaques} plaques/paintings`);
  ok(st.worstGap <= 1.1, `${name}: full houses grounded (worst gap ${st.worstGap} at ${st.worstName}, stone plinth covers 1.17)`);
  if (name === 'HOSTED') {
    ok(st.bots >= 25, `${name}: ≥25 server bots (${st.bots})`);
    ok(st.botDrivers.length >= 5, `${name}: server vehicle bots (${st.botDrivers.join(', ')})`);
  }
  ok(st.worstSimpleGap <= 1.1, `${name}: simple houses grounded (worst ${st.worstSimpleGap})`);
  ok(st.bikeRent && st.pads === 4, `${name}: bike rentable, 4 pads`);
  ok(isFinite(st.trainPeriod), `${name}: train period ${st.trainPeriod}`);
  ok(errors.length === 0, `${name}: page errors ${errors.length ? errors.join(' | ') : 'none'}`);
  // modals still fine
  const modal = await page.evaluate(() => {
    document.getElementById('rentwrap').style.display = 'flex';
    const rows = document.querySelectorAll('#rentwrap [data-rent]').length;
    document.getElementById('rentwrap').style.display = 'none';
    return rows;
  });
  ok(modal === 4, `${name}: rent modal has 4 vehicles`);
  await page.close();
}
await browser.close();
console.log(process.exitCode ? '=== BOOT FAILED ===' : '=== BOOT OK ===');
process.exit(process.exitCode || 0);
