// a few frames at full size, to look at before the film
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  await p.goto(`file://${__dirname}/index.html`);
  await p.waitForTimeout(800);
  for (const t of (process.argv[2] || '').split(',').map(Number)) {
    await p.evaluate((x) => window.seek(x), t);
    await p.screenshot({ path: `${process.env.OUT || '/tmp'}/f-${String(t).replace('.', '_')}.jpg`, type: 'jpeg', quality: 85 });
  }
  console.log('errors:', errs.join(' | ') || 'none');
  await b.close();
})();
