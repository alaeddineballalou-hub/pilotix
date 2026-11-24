// Pilotix extension — the customer card on WhatsApp Web (card.html, in a frame that wa-card.js puts beside the chat).
// It asks Pilotix through the worker (the open Pilotix tab answers, with the agent's rights): customers.waCard gives who
// this number is (level, blacklist, last orders) and quick replies from the sales guide. A quick reply clicked goes into
// the chat's message box (the worker hands it to wa-card.js); the agent sends it himself.
const $ = (id) => document.getElementById(id);
const LEVEL = { top: 'Très fiable', good: 'Fiable', watch: 'À surveiller', risk: 'Risqué', new: 'Nouveau' };
const SAY = {
  top: 'Reçoit et paie ses colis.',
  good: 'Plutôt sérieux.',
  watch: 'Confirmez bien avant d’envoyer.',
  risk: 'Fort risque de fausse commande ou de refus : vérifiez tout, ou proposez le stop-desk.',
  new: 'Pas encore d’historique.',
};
const CONF = {
  to_check: 'À vérifier', new: 'Nouvelle', no_answer: 'Pas de réponse', busy: 'Occupé', callback: 'À rappeler', postponed: 'Reportée', no_stock: 'Confirmée sans stock',
  confirmed: 'Confirmée', cancelled: 'Annulée', duplicate: 'Doublon', wrong_number: 'Faux numéro', fake: 'Fausse commande',
};
const FOLLOW = {
  to_prepare: 'À préparer', prepared: 'Préparée', shipped: 'Expédiée', out_for_delivery: 'En livraison', failed: 'Reportée / échec', alert: 'Alerte', in_exchange: 'En échange',
  delivered: 'Livrée', returning: 'Retour en cours', returned: 'Retournée', exchanged: 'Échangée', lost: 'Perdue', cancelled: 'Annulée',
};
const GOOD = new Set(['delivered', 'exchanged', 'confirmed']);
const BAD = new Set(['returned', 'returning', 'lost', 'cancelled', 'fake', 'wrong_number', 'duplicate']);

let phone = null;
let productId = null;
let data = null;
let open = false;
let seq = 0;

const da = (n) => `${Math.round(Number(n) || 0).toLocaleString('fr-FR').replace(/ | /g, ' ')} DA`;
const day = (iso) => {
  try {
    return new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
  } catch {
    return '';
  }
};
/** 213555123456 → 05 55 12 34 56 (an Algerian number), else +… as it is */
function phoneText(p) {
  const d = String(p || '').replace(/\D/g, '');
  const local = d.startsWith('213') && d.length === 12 ? `0${d.slice(3)}` : d.length === 10 && d.startsWith('0') ? d : null;
  return local ? local.replace(/^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/, '$1 $2 $3 $4 $5') : `+${d}`;
}
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = String(text);
  return e;
};

/** The frame's size, said to wa-card.js on WhatsApp's page (numbers only): the pill, or the whole card (it scrolls). */
function size() {
  const box = (open ? $('card') : $('pill')).getBoundingClientRect();
  const h = open ? $('card').scrollHeight + 2 : box.height;
  window.parent.postMessage({ pilotixCard: 'size', w: Math.ceil(box.width) + 20, h: Math.ceil(h) + 16 }, 'https://web.whatsapp.com');
}
new ResizeObserver(size).observe(document.body);

function setOpen(v) {
  open = v;
  $('card').hidden = !open;
  $('pill').hidden = open;
  $('pill').setAttribute('aria-expanded', String(open));
  requestAnimationFrame(size);
}
$('pill').addEventListener('click', () => setOpen(true));
$('close').addEventListener('click', () => setOpen(false));

function pill(text, tone) {
  $('pillText').textContent = text;
  $('pill').className = `pill ${tone || ''}`.trim();
}
function message(text, tone = '') {
  $('msg').textContent = text;
  $('msg').className = `msg ${tone}`.trim();
}

async function ask(name, input) {
  const r = await chrome.runtime.sendMessage({ kind: 'pilotix', name, input });
  if (!r?.ok) throw new Error(r?.message || 'Pilotix ne répond pas.');
  return r.out;
}

async function load() {
  const mine = ++seq;
  $('phone').textContent = phoneText(phone);
  $('name').textContent = '…';
  $('body').replaceChildren();
  message('');
  pill('Pilotix…', '');
  try {
    const out = await ask('customers.waCard', { phone, ...(productId ? { productId } : {}) });
    if (mine !== seq) return;
    data = out;
    render();
  } catch (e) {
    if (mine !== seq) return;
    data = null;
    $('name').textContent = 'Pilotix';
    pill('Pilotix', 'off');
    message(String(e?.message || e), 'bad');
  }
  requestAnimationFrame(size);
}

function render() {
  const c = data.customer;
  const body = $('body');
  body.replaceChildren();
  if (!c) {
    $('name').textContent = 'Nouveau numéro';
    pill('Nouveau numéro', 'new');
    body.append(el('p', 'muted', 'Ce numéro n’a encore jamais commandé dans Pilotix.'));
  } else {
    $('name').textContent = c.name || 'Client';
    const lv = c.score?.level ?? 'new';
    if (c.blacklisted) pill('Liste noire', 'risk');
    else pill(`${LEVEL[lv] ?? lv}${lv !== 'new' ? ` · ${c.score.score}` : ''}`, lv);
    if (c.blacklisted) {
      const b = el('div', 'black');
      b.append(el('b', '', 'Liste noire'), el('span', '', c.blacklistReason || 'Ce client est dans la liste noire.'));
      body.append(b);
    }
    const lvl = el('div', `level ${lv}`);
    lvl.append(el('b', '', `${LEVEL[lv] ?? lv}${lv !== 'new' ? ` ${c.score.score}/100` : ''}`), el('span', '', SAY[lv] ?? ''));
    body.append(lvl);
    const counts = el('div', 'counts');
    for (const [n, label, tone] of [
      [c.orders, c.orders === 1 ? 'commande' : 'commandes', ''],
      [c.delivered, c.delivered === 1 ? 'livrée' : 'livrées', 'ok'],
      [c.returned, c.returned === 1 ? 'retournée' : 'retournées', c.returned ? 'bad' : ''],
      [c.cancelled, c.cancelled === 1 ? 'annulée' : 'annulées', ''],
    ]) {
      const s = el('span', tone);
      s.append(el('b', '', n), ` ${label}`);
      counts.append(s);
    }
    body.append(counts);
    if (data.orders.length) {
      body.append(el('h2', '', 'Dernières commandes'));
      const ul = el('ul', 'orders');
      for (const o of data.orders.slice(0, 4)) {
        const li = el('li');
        const top = el('div', 'row');
        top.append(el('b', 'ltr', o.ref), el('span', 'muted', day(o.createdAt)), el('span', 'amt ltr', da(o.total)));
        const st = o.followStatus && o.followStatus !== 'to_prepare' ? o.followStatus : o.confStatus;
        const label = (o.followStatus && o.followStatus !== 'to_prepare' ? FOLLOW : CONF)[st] ?? st;
        const bottom = el('div', 'row');
        bottom.append(el('span', 'items', o.itemsText || '—'), el('span', `st ${GOOD.has(st) ? 'ok' : BAD.has(st) ? 'bad' : ''}`, label));
        li.append(top, bottom);
        ul.append(li);
      }
      body.append(ul);
    }
  }
  replies(body);
}

/** Quick replies from the sales guide of a product (the one of their last order, or the one chosen). */
function replies(body) {
  const head = el('div', 'rhead');
  head.append(el('h2', '', 'Réponses rapides'));
  if (data.products.length) {
    const sel = document.createElement('select');
    sel.setAttribute('aria-label', 'Produit');
    sel.append(new Option('Choisir un produit…', ''));
    for (const p of data.products) sel.append(new Option(p.name, String(p.id), false, p.id === data.product?.id));
    sel.addEventListener('change', () => {
      productId = Number(sel.value) || null;
      if (productId) load();
    });
    head.append(sel);
  }
  body.append(head);
  if (!data.products.length) {
    body.append(el('p', 'muted', 'Aucun guide de vente pour vos produits.'));
    return;
  }
  if (!data.replies.length) {
    body.append(el('p', 'muted', data.product ? 'Le guide de ce produit n’a pas encore de réponse écrite.' : 'Choisissez un produit pour voir ses réponses.'));
    return;
  }
  const ul = el('ul', 'replies');
  for (const r of data.replies) {
    const li = el('li');
    const b = el('button', 'reply');
    b.type = 'button';
    b.title = 'Mettre dans la discussion';
    b.append(el('small', '', `${r.kind === 'doubt' ? 'Le client hésite : ' : ''}${r.q}`), el('span', '', r.a));
    b.dir = 'auto';
    b.addEventListener('click', async () => {
      const done = await chrome.runtime.sendMessage({ kind: 'wa-insert', text: r.a }).catch(() => null);
      message(done?.ok ? 'Réponse mise dans la discussion : relisez, puis envoyez.' : 'Ouvrez la discussion, puis cliquez à nouveau.', done?.ok ? 'ok' : 'bad');
      requestAnimationFrame(size);
    });
    li.append(b);
    ul.append(li);
  }
  body.append(ul);
}

/** The chat's number: from the frame's address, then from wa-card.js when another chat opens. */
function setPhone(p) {
  const d = String(p || '').replace(/\D/g, '');
  if (!d || d === phone) return;
  phone = d;
  productId = null;
  load();
}
window.addEventListener('message', (e) => {
  if (e.origin !== 'https://web.whatsapp.com' || e.source !== window.parent || e.data?.pilotixCard !== 'phone') return;
  setPhone(e.data.phone);
});
setPhone(new URLSearchParams(location.hash.slice(1)).get('p'));
setOpen(false);
