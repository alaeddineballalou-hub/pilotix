// One part of the film: every frame drawn from the time alone (window.seek), piped to ffmpeg as JPEG.
// node render.cjs <from s> <to s> <out.mp4>   (see README.md)
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const [a, b, out] = [Number(process.argv[2]), Number(process.argv[3]), process.argv[4]];
const FPS = 30;
(async () => {
  const br = await chromium.launch();
  const p = await br.newPage({ viewport: { width: 1920, height: 1080 } });
  await p.goto(`file://${__dirname}/index.html`);
  await p.waitForTimeout(800);
  const tmp = out.replace(/\.mp4$/, '.part.mp4');
  const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(FPS), tmp], { stdio: ['pipe', 'inherit', 'inherit'] });
  const n = Math.round((b - a) * FPS);
  for (let i = 0; i < n; i++) {
    await p.evaluate((x) => window.seek(x), a + i / FPS);
    const buf = await p.screenshot({ type: 'jpeg', quality: 92 });
    if (!ff.stdin.write(buf)) await new Promise((ok) => ff.stdin.once('drain', ok));
  }
  ff.stdin.end();
  const code = await new Promise((ok) => ff.on('close', ok));
  await br.close();
  if (code !== 0) process.exit(1);
  fs.renameSync(tmp, out);
  console.log(out, n, 'frames');
})();
