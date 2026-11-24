// Pilotix extension — the list of the person's ads with Pilotix's numbers, in Meta's Ads Manager (adspanel.html, in a
// frame that adsmanager.js puts in the corner). It asks the open Pilotix tab through the worker (ads.extNumbers).
const $ = (id) => document.getElementById(id);
const LEVEL = { good: 'Sous le bid limit', over: 'Au-dessus du bid limit', alert: 'Alert limit dépassé', stop: 'Stop limit dépassé' };
let open = false;
let days = 7;
const da = (n) => `${Math.round(Number(n) || 0).toLocaleString('fr-FR').replace(/ | /g, ' ')} DA`;
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = String(text);
  return e;
};

function size() {
  const box = (open ? $('panel') : $('pill')).getBoundingClientRect();
  const h = open ? $('panel').scrollHeight + 2 : box.height;
  const top = window.parent;
  for (const origin of ['https://adsmanager.facebook.com', 'https://business.facebook.com']) top.postMessage({ pilotixAds: 'size', w: Math.ceil(box.width) + 20, h: Math.ceil(h) + 16 }, origin);
}
new ResizeObserver(size).observe(document.body);
function setOpen(v) {
  open = v;
  $('panel').hidden = !open;
  $('pill').hidden = open;
  $('pill').setAttribute('aria-expanded', String(open));
  requestAnimationFrame(size);
}
$('pill').addEventListener('click', () => setOpen(true));
$('close').addEventListener('click', () => setOpen(false));
$('days').addEventListener('change', () => {
  days = Number($('days').value) || 7;
  load();
});

async function load() {
  $('msg').textContent = 'Lecture dans Pilotix…';
  $('msg').className = 'msg';
  const r = await chrome.runtime.sendMessage({ kind: 'pilotix', name: 'ads.extNumbers', input: { days } }).catch(() => null);
  if (!r?.ok) {
    $('msg').textContent = r?.message || 'Pilotix ne répond pas.';
    $('msg').className = 'msg bad';
    $('pillText').textContent = 'Pilotix';
    $('pill').className = 'pill off';
    $('list').replaceChildren();
    requestAnimationFrame(size);
    return;
  }
  const ads = r.out.ads;
  const bad = ads.filter((a) => a.level === 'alert' || a.level === 'stop').length;
  $('pillText').textContent = bad ? `Pilotix · ${bad} au-dessus` : `Pilotix · ${days} j`;
  $('pill').className = `pill ${bad ? 'stop' : ads.some((a) => a.level === 'over') ? 'over' : 'good'}`;
  $('msg').textContent = ads.length ? '' : 'Aucune pub avec des dépenses ou des commandes sur ces jours.';
  $('list').replaceChildren(
    ...ads.map((a) => {
      const li = el('li', a.level ?? '');
      const top = el('div', 'row');
      top.append(el('b', 'name', a.name), el('span', `lv ${a.level ?? ''}`, a.level ? LEVEL[a.level] : a.bidLimit ? '—' : 'Pas de bid limit'));
      const nums = el('div', 'nums');
      for (const [n, label] of [
        [a.confirmed, 'confirmées'],
        [a.delivered, 'livrées'],
        [a.orders, 'commandes'],
      ]) {
        const s = el('span');
        s.append(el('b', '', n), ` ${label}`);
        nums.append(s);
      }
      const money = el('div', 'money');
      money.append(
        el('span', '', a.costConfirmed !== null ? `${da(a.costConfirmed)} par confirmée` : a.spendDzd ? 'Pas encore de confirmée' : 'Pas de dépense'),
        el('span', 'muted', [a.spendDzd !== null ? `dépense ${da(a.spendDzd)}` : null, a.bidLimit ? `bid limit ${da(a.bidLimit)}` : null].filter(Boolean).join(' · ')),
      );
      li.append(top, a.product ? el('div', 'muted small', a.product) : '', nums, money);
      return li;
    }),
  );
  requestAnimationFrame(size);
}

setOpen(false);
load();
setInterval(load, 5 * 60_000);
