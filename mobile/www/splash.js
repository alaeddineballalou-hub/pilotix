/*
 * Pilotix app: the start animation (owner's choice 19 « La livraison », 30 Oct 2026).
 * The big wordmark enters « eyes first » (the two orange dots, the smile, then the letters); then the letters fly
 * off, the smile turns into a dotted road, the orange dot drives along it to the icon's place and « delivers » the
 * small winking app icon, with a ring of light. The icon lands exactly on the page's own logo (.logo), so the
 * « Connexion à Pilotix… » screen takes over with no jump.
 * The first opening of the day plays it whole (about 2.6 s); later openings that day play the short end (1.4 s).
 * door.js waits for window.PILOTIX_SPLASH before leaving the page. No outside files: it must work offline.
 */
(function () {
  'use strict';
  var main = document.querySelector('main');
  var logo = document.querySelector('.logo');
  if (!main || !logo || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  // ---- the brand's real outlines (same as apps/web/src/layout/PxLogo.tsx)
  var GL = ['M24.6875 120.41015625H41.484375V92.333984375H41.6796875C44.365234375 98.046875 49.443359375 101.123046875 56.23046875 101.123046875C69.755859375 101.123046875 78.49609375 90.4296875 78.49609375 74.12109375C78.49609375 58.349609375 69.4140625 47.314453125 56.376953125 47.314453125C49.6875 47.314453125 44.609375 49.951171875 41.533203125 55.17578125H41.2890625V48.4375H24.6875ZM51.494140625 87.6953125C45.146484375 87.6953125 40.80078125 82.373046875 40.80078125 74.12109375C40.80078125 65.966796875 45.146484375 60.693359375 51.494140625 60.693359375C57.6953125 60.693359375 61.50390625 65.72265625 61.50390625 74.12109375C61.50390625 82.6171875 57.6953125 87.6953125 51.494140625 87.6953125Z', 'M83.771484375 100.0H100.568359375V48.4375H83.771484375Z', 'M124.740234375 27.24609375H107.943359375V100.0H124.740234375Z', 'M157.115234375 101.171875C173.27734375 101.171875 184.21484375 90.576171875 184.21484375 74.21875C184.21484375 57.958984375 173.27734375 47.265625 157.115234375 47.265625C140.953125 47.265625 129.966796875 57.958984375 129.966796875 74.21875C129.966796875 90.576171875 140.953125 101.171875 157.115234375 101.171875ZM157.115234375 87.79296875C151.20703125 87.79296875 147.0078125 82.958984375 147.0078125 74.21875C147.0078125 65.52734375 151.255859375 60.64453125 157.115234375 60.64453125C162.974609375 60.64453125 167.22265625 65.52734375 167.22265625 74.21875C167.22265625 82.958984375 162.974609375 87.79296875 157.115234375 87.79296875Z', 'M221.912109375 48.4375H211.31640625V34.375H194.470703125V48.4375H185.681640625V61.42578125H194.470703125V85.498046875C194.470703125 95.5078125 200.037109375 100.0 212.390625 100.0H221.912109375V87.01171875H216.1015625C212.341796875 87.01171875 211.31640625 85.986328125 211.31640625 82.666015625V61.42578125H221.912109375Z', 'M226.650390625 100.0H243.447265625V48.4375H226.650390625Z'];
  var GCX = [51, 92, 116, 157, 204, 235, 273];
  var X_STROKE = 'M254.42,55.79 L292.73,92.64', X_W = 14.71;
  var SMILE = [[64.5, 110], [138.5, 160], [226.33, 120], [314.82, 34.44], [226.33, 104.04], [138.5, 144.04]];
  var DOTS = [[92.17, 32.3, 10.41], [235.05, 32.3, 10.41]];
  var WAVE = 'M0,250 C120,200 200,320 300,280 C380,248 440,230 512,250 V512 H0 Z';
  var MOUTH = 'M146,296 C217.4,372 324.5,364.4 384,272 C324.5,329.82 217.4,337.42 146,296 Z';

  // ---- where things go on this phone's screen
  var VW = window.innerWidth, VH = window.innerHeight;
  var lr = logo.getBoundingClientRect();
  var CX = VW / 2, CY = VH * 0.46;
  var sW = Math.min(1.03, (VW - 70) / 291); // the wordmark is about 300 px wide on a normal phone
  var WCX = 169.5, WCY = 93;
  var IX = lr.left + lr.width / 2, IY = lr.top + lr.height / 2, IS = lr.width;
  function W(x, y) { return [CX + (x - WCX) * sW, CY + (y - WCY) * sW]; }

  // ---- easing
  function cl(v) { return Math.max(0, Math.min(1, v)); }
  function P(t, a, b) { return cl((t - a) / (b - a)); }
  function eo(p) { return 1 - Math.pow(1 - p, 3); }
  function eio(p) { return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2; }
  function bo(p) { var c = 1.9; return p === 0 ? 0 : 1 + (c + 1) * Math.pow(p - 1, 3) + c * Math.pow(p - 1, 2); }

  // ---- the drawing
  var NS = 'http://www.w3.org/2000/svg';
  function el(tag, attrs, parent) { var e = document.createElementNS(NS, tag); set(e, attrs); (parent || svg).appendChild(e); return e; }
  function set(e, o) { for (var k in o) e.setAttribute(k, o[k]); }
  var svg = document.createElementNS(NS, 'svg');
  set(svg, { viewBox: '0 0 ' + VW + ' ' + VH, width: VW, height: VH, 'aria-hidden': 'true' });
  svg.style.cssText = 'position:fixed;inset:0;z-index:50;background:#1B2A47;pointer-events:none;transition:opacity .25s ease';
  var defs = el('defs', {});
  defs.innerHTML = '<clipPath id="sxClip"><rect id="sxClipR" x="0" y="0" width="0" height="' + VH + '"/></clipPath>' +
    '<mask id="sxM" maskUnits="userSpaceOnUse" x="0" y="0" width="512" height="512"><rect width="512" height="512" rx="112" fill="#fff"/></mask>' +
    '<filter id="sxSh" x="-40%" y="-40%" width="180%" height="180%"><feDropShadow dx="0" dy="10" stdDeviation="14" flood-color="#000" flood-opacity=".30"/></filter>';
  var road = el('path', { fill: 'none', stroke: '#F7A823', 'stroke-width': 4, 'stroke-linecap': 'round', 'stroke-dasharray': '0.1 12', opacity: 0 });
  var ring = el('circle', { fill: 'none', stroke: '#F7A823', 'stroke-width': 3, opacity: 0 });
  var word = el('g', {});
  var letters = GL.map(function (d) { return el('path', { d: d, fill: '#fff', opacity: 0 }, word); });
  letters.push(el('path', { d: X_STROKE, stroke: '#fff', 'stroke-width': X_W, fill: 'none', opacity: 0 }, word));
  var smile = el('path', { fill: '#F7A823', 'clip-path': 'url(#sxClip)' });
  var wink = el('circle', { fill: '#F7A823', opacity: 0 });
  var eye = el('circle', { fill: '#F7A823', opacity: 0 });
  var icon = el('g', { filter: 'url(#sxSh)', opacity: 0 });
  icon.innerHTML = '<g mask="url(#sxM)"><rect width="512" height="512" fill="#1B2A47"/><path d="' + WAVE + '" fill="#F7A823"/></g>' +
    '<rect width="512" height="512" rx="112" fill="none" stroke="rgba(255,255,255,.12)" stroke-width="10"/>' +
    '<path d="' + MOUTH + '" fill="#1B2A47"/><ellipse class="sx-eye" cx="186" cy="186" rx="50" ry="50" fill="#F7A823"/>' +
    '<path d="M290,186 H364" stroke="#F7A823" stroke-width="44" stroke-linecap="round" fill="none"/>';
  var iconEye = icon.querySelector('.sx-eye');
  var clipR = defs.querySelector('#sxClipR');
  var sm = SMILE.map(function (p) { return W(p[0], p[1]); });
  set(smile, { d: 'M' + sm[0] + ' C' + sm[1] + ' ' + sm[2] + ' ' + sm[3] + ' C' + sm[4] + ' ' + sm[5] + ' ' + sm[0] + ' Z' });
  var d0 = W(DOTS[0][0], DOTS[0][1]), d1 = W(DOTS[1][0], DOTS[1][1]), dr = DOTS[0][2] * sW;
  set(road, { d: 'M' + d0[0] + ',' + d0[1] + ' C' + (d0[0] - 120) + ',' + (d0[1] + 120) + ' ' + (IX + 160) + ',' + (IY - 140) + ' ' + IX + ',' + IY });
  var roadLen = 0;

  function letter(i, dy, o) {
    var c = W(GCX[i], 74 + dy);
    set(letters[i], { transform: 'translate(' + c[0] + ' ' + c[1] + ') scale(' + sW + ') translate(' + (-GCX[i]) + ' -74)', opacity: o });
  }

  function draw(t) {
    if (t < 1.2) {
      // eyes first, the smile draws, then the letters
      var p0 = P(t, 0.05, 0.45), p1 = P(t, 0.17, 0.57);
      var blink = t > 0.95 && t < 1.15 ? Math.sin(P(t, 0.95, 1.15) * Math.PI) : 0;
      set(eye, { cx: d0[0], cy: d0[1], r: dr * bo(p0), opacity: p0 > 0 ? 1 : 0 });
      set(wink, { cx: d1[0], cy: d1[1], r: dr * bo(p1) * (1 - blink * 0.5), opacity: p1 > 0 ? 1 : 0 });
      set(clipR, { x: sm[0][0] - 10, width: (sm[3][0] - sm[0][0] + 20) * eo(P(t, 0.3, 0.75)) });
      for (var i = 0; i < 7; i++) { var p = eo(P(t, 0.5 + 0.06 * i, 0.9 + 0.06 * i)); letter(i, (1 - p) * 16, p); }
      return;
    }
    // the page's logo may move (door.js changes the words under it): aim at where it is now
    var lr2 = logo.getBoundingClientRect(), nx = lr2.left + lr2.width / 2, ny = lr2.top + lr2.height / 2;
    if (Math.abs(nx - IX) + Math.abs(ny - IY) > 0.5) {
      IX = nx; IY = ny; IS = lr2.width; roadLen = 0;
      set(road, { d: 'M' + d0[0] + ',' + d0[1] + ' C' + (d0[0] - 120) + ',' + (d0[1] + 120) + ' ' + (IX + 160) + ',' + (IY - 140) + ' ' + IX + ',' + IY });
    }
    set(clipR, { x: -5000, width: 20000 });
    for (var j = 0; j < 7; j++) { var q = eio(P(t, 1.2 + 0.03 * j, 1.5 + 0.03 * j)); letter(j, -30 * q, 1 - q); }
    set(wink, { opacity: 1 - P(t, 1.2, 1.4) });
    set(smile, { opacity: 1 - P(t, 1.2, 1.35) });
    // the dotted road, and the orange dot driving along it
    set(road, { opacity: P(t, 1.25, 1.4) * (1 - P(t, 2.1, 2.3)) });
    if (!roadLen) roadLen = road.getTotalLength();
    var m = eio(P(t, 1.4, 2.05)), pt = road.getPointAtLength(roadLen * m);
    set(eye, { cx: pt.x, cy: pt.y, r: dr * (1 + 0.4 * Math.sin(m * Math.PI)), opacity: t < 2.08 ? 1 : 0 });
    // the icon is delivered, with a ring of light
    var g = P(t, 2.05, 2.45), s = (IS * bo(g)) / 512;
    set(icon, { opacity: g > 0 ? 1 : 0, transform: 'translate(' + IX + ' ' + IY + ') scale(' + s + ') translate(-256 -256)' });
    var r = P(t, 2.05, 2.6);
    set(ring, { cx: IX, cy: IY, r: 40 + 150 * r, opacity: r > 0 ? 0.7 * (1 - r) : 0 });
    var bl = t > 2.6 && t < 2.8 ? Math.sin(P(t, 2.6, 2.8) * Math.PI) : 0;
    set(iconEye, { ry: 50 * (1 - bl * 0.9) });
  }

  // the whole animation once a day, the short end after that
  var today = new Date().toDateString(), first = true;
  try { first = localStorage.getItem('pxSplashDay') !== today; localStorage.setItem('pxSplashDay', today); } catch (e) {}
  var START = first ? 0 : 1.2, END = 2.85;

  main.style.visibility = 'hidden';
  document.body.appendChild(svg);
  draw(START);
  window.PILOTIX_SPLASH = new Promise(function (done) {
    var t0 = null;
    function frame(now) {
      if (t0 === null) t0 = now;
      var t = START + (now - t0) / 1000;
      draw(Math.min(t, END));
      if (t < END) return requestAnimationFrame(frame);
      // the page's own screen (same logo, same place) takes over
      main.style.visibility = '';
      svg.style.opacity = '0';
      setTimeout(function () { svg.remove(); }, 300);
      done();
    }
    requestAnimationFrame(frame);
  });
})();
