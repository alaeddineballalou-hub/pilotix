// Real Pilotix screens for the install video (demo build, Samira, French): the order, « Envoyer des photos » without
// the add-on, its install guide, and the same window once the add-on is there. Sizes match the video's browser body.
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');
const fs = require('fs');
const W = process.env.DEMO_URL || 'http://127.0.0.1:8814/';
const OUT = `${__dirname}/shots`;
const VW = { width: 1440, height: 694 }, DPR = 1680 / 1440;
const PRODUCT = /Poussette canne/;
const EXT = () => document.addEventListener('DOMContentLoaded', () => document.documentElement.setAttribute('data-pilotix-wa', '1.0.0'));
const pos = fs.existsSync(`${OUT}/px-pos.json`) ? JSON.parse(fs.readFileSync(`${OUT}/px-pos.json`, 'utf8')) : {};
(async () => {
  const b = await chromium.launch();
  const box = async (p, loc, name) => { const r = await loc.first().boundingBox(); pos[name] = r && { x: +(r.x * DPR).toFixed(1), y: +(r.y * DPR).toFixed(1), w: +(r.width * DPR).toFixed(1), h: +(r.height * DPR).toFixed(1) }; };
  const run = async (withExt) => {
    const ctx = await b.newContext({ viewport: VW, deviceScaleFactor: DPR });
    await ctx.addInitScript(() => { localStorage.setItem('px.lang', 'fr'); localStorage.setItem('px.theme', 'light'); });
    if (withExt) await ctx.addInitScript(EXT);
    const p = await ctx.newPage();
    const errs = [];
    p.on('pageerror', (e) => errs.push(e.message.slice(0, 160)));
    await p.goto(W);
    const btn = p.locator('.demo-accounts button', { hasText: /Samira/ }).first();
    await btn.waitFor({ timeout: 120000 });
    await btn.click();
    await p.waitForURL(/#\/[a-z]/, { timeout: 90000 });
    await p.waitForTimeout(5000);
    const photosBtn = p.locator('.qd6-photos');
    if (!(await photosBtn.count())) {
      const exp = p.locator('td.qexp button').first();
      if ((await exp.getAttribute('aria-expanded').catch(() => null)) !== 'true') { await exp.click(); await p.waitForTimeout(3500); }
    }
    await photosBtn.first().scrollIntoViewIfNeeded();
    await p.waitForTimeout(600);
    if (!withExt) { await p.screenshot({ path: `${OUT}/px-order.png` }); await box(p, photosBtn, 'photosBtn'); }
    await photosBtn.first().click();
    await p.waitForTimeout(2500);
    // only the stroller, with all its colours
    let row = p.locator('.sph-it', { hasText: PRODUCT }).first();
    if (!(await row.count())) {
      const add = p.locator('.sph-add input').first();
      await add.click(); await add.fill('Pouss'); await p.waitForTimeout(900);
      const it = p.locator('.pxf-it', { hasText: PRODUCT }).first();
      if (await it.count()) { await it.dispatchEvent('mousedown'); await p.waitForTimeout(1800); }
      row = p.locator('.sph-it', { hasText: PRODUCT }).first();
    }
    await row.locator('.sph-var').selectOption('all');
    await p.waitForTimeout(1500);
    const other = p.locator('.sph-it', { hasNotText: PRODUCT }).first();
    if (await other.count()) { await other.locator('button').last().click(); await p.waitForTimeout(900); }
    console.log(withExt ? 'ext' : 'noext', 'rows:', await p.locator('.sph-it').count());
    await p.screenshot({ path: `${OUT}/px-modal-${withExt ? 'ext' : 'noext'}.png` });
    await box(p, p.locator('.sph-wa'), withExt ? 'sendBtn' : 'installBtn');
    if (!withExt) await box(p, p.locator('.sph-ext-need'), 'need');
    await box(p, p.locator('.sph-it').first(), withExt ? 'rowExt' : 'row');
    if (!withExt) {
      await p.locator('.sph-wa').first().click();
      await p.waitForTimeout(1500);
      await p.screenshot({ path: `${OUT}/px-guide.png` });
      await box(p, p.locator('a[href*="pilotix-whatsapp.zip"]'), 'download');
      await box(p, p.locator('.sph-ext').locator('button', { hasText: 'chrome://extensions' }), 'chromeUrl');
      await box(p, p.locator('.sph-ext, .modal, .sheet').locator('button', { hasText: /Recharger/ }), 'reload');
    }
    console.log(withExt ? 'ext' : 'noext', 'errors:', errs.join(' | ') || 'none');
    await ctx.close();
  };
  await run(false);
  await run(true);
  fs.writeFileSync(`${OUT}/px-pos.json`, JSON.stringify(pos, null, 1));
  console.log(JSON.stringify(pos));
  await b.close();
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
