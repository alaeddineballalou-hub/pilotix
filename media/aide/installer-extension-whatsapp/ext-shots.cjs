// Real chrome://extensions screens (Chromium, French), for the install video: dev mode off, on, then with the add-on.
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');
const fs = require('fs');
const OUT = `${__dirname}/shots`;
const EXT = require('path').resolve(__dirname, '../../../apps/wa-extension');
const VW = { width: 1440, height: 694 }, DPR = 1680 / 1440;
(async () => {
  const pos = {};
  const box = async (p, sel, name) => { const b = await p.locator(sel).first().boundingBox(); pos[name] = b && { x: b.x * DPR, y: b.y * DPR, w: b.width * DPR, h: b.height * DPR }; };
  // 1 · a fresh Chrome: no add-on, developer mode off, then on
  for (const withExt of [false, true]) {
    const dir = fs.mkdtempSync('/tmp/ext-prof-');
    const ctx = await chromium.launchPersistentContext(dir, {
      channel: 'chromium', headless: true, viewport: VW, deviceScaleFactor: DPR, locale: 'fr-FR',
      args: ['--lang=fr-FR', '--no-proxy-server', ...(withExt ? [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] : [])],
      env: { ...process.env, LANGUAGE: 'fr' },
    });
    const p = ctx.pages()[0] || (await ctx.newPage());
    await p.goto('chrome://extensions');
    await p.waitForTimeout(1500);
    // what a person's own Chrome does not show here: the test build's logo, « géré par votre organisation », a promo
    await p.evaluate(() => {
      const all = [];
      const walk = (root) => { for (const el of root.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot); } };
      walk(document);
      for (const el of all) {
        const tag = el.tagName.toLowerCase();
        if (tag === 'managed-footnote') el.style.display = 'none';
        if (el.id === 'product-logo' || el.id === 'web-store-icon') el.style.visibility = 'hidden';
        if (tag === 'a' && /Web Store skill|Chrome Ex/.test(el.textContent) && el.parentElement) el.parentElement.style.display = 'none';
      }
      document.querySelectorAll('*').forEach(() => 0);
    });
    await p.mouse.click(1000, 600);
    await p.waitForTimeout(300);
    const tag = withExt ? 'with' : 'none';
    if (!withExt) {
      await p.screenshot({ path: `${OUT}/ext-off.png` });
      await box(p, '#devMode', 'devMode');
    }
    // developer mode on (the toggle at the top right)
    const dm = p.locator('#devMode');
    if ((await dm.getAttribute('aria-pressed')) !== 'true') await dm.click();
    await p.waitForTimeout(900);
    await p.evaluate(() => {
      const all = [];
      const walk = (root) => { for (const el of root.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot); } };
      walk(document);
      for (const el of all) if (el.tagName.toLowerCase() === 'a' && /Web Store skill|Chrome Ex/.test(el.textContent) && el.parentElement) el.parentElement.style.display = 'none';
    });
    await p.mouse.click(1000, 600);
    await p.waitForTimeout(300);
    await p.screenshot({ path: `${OUT}/ext-on-${tag}.png` });
    if (!withExt) await box(p, '#loadUnpacked', 'loadUnpacked');
    else await box(p, 'extensions-item', 'card');
    console.log(tag, 'texts:', (await p.locator('#devMode').getAttribute('aria-label')) || '', '|', (await p.locator('#loadUnpacked').innerText().catch(() => '?')).trim());
    await ctx.close();
  }
  fs.writeFileSync(`${OUT}/ext-pos.json`, JSON.stringify(pos, null, 1));
  console.log(JSON.stringify(pos));
})().catch((e) => { console.error(e); process.exit(1); });
