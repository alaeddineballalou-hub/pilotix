// Raw answers of a few courier endpoints (made-up keys), to find the right addresses. Temporary.
const calls = [
  ['elogistia getWilayas key', 'https://api.elogistia.com/getWilayas?key=x'],
  ['elogistia getWilayas nokey', 'https://api.elogistia.com/getWilayas'],
  ['elogistia getWilayas/ key', 'https://api.elogistia.com/getWilayas/?key=x'],
  ['elogistia getMunicipalities', 'https://api.elogistia.com/getMunicipalities?key=x&wilaya=Alger'],
  ['elogistia root', 'https://api.elogistia.com/'],
  ['maystro b stock', 'https://b.maystro-delivery.com/api/stock/products/', { Authorization: 'Token x' }],
  ['maystro b wilayas', 'https://b.maystro-delivery.com/api/base/wilayas/?country=1', { Authorization: 'Token x' }],
  ['maystro b orders', 'https://b.maystro-delivery.com/api/orders/', { Authorization: 'Token x' }],
  ['maystro b stores/orders', 'https://b.maystro-delivery.com/api/stores/orders/', { Authorization: 'Token x' }],
  ['maystro backend wilayas', 'https://backend.maystro-delivery.com/api/base/wilayas/?country=1', { Authorization: 'Token x' }],
  ['maystro backend orders', 'https://backend.maystro-delivery.com/api/orders/', { Authorization: 'Token x' }],
  ['maystro backend stores/orders', 'https://backend.maystro-delivery.com/api/stores/orders/', { Authorization: 'Token x' }],
  ['maystro backend stock', 'https://backend.maystro-delivery.com/api/stock/products/', { Authorization: 'Token x' }],
  ['maystro backend stores/product', 'https://backend.maystro-delivery.com/api/stores/product/', { Authorization: 'Token x' }],
  ['maystro backend hooks', 'https://backend.maystro-delivery.com/api/stores/hooks/types/', { Authorization: 'Token x' }],
  ['ecom test', 'https://ecom-dz.net/Api_v1/Test', { Token: 'x', Key: 'y' }],
  ['yalidine histories', 'https://api.yalidine.app/v1/histories/', { 'X-API-ID': '123', 'X-API-TOKEN': 'x' }],
  ['yalitec wilayas', 'https://api.yalitec.me/v1/wilayas/', { 'X-API-ID': '123', 'X-API-TOKEN': 'x' }],
  ['guepex wilayas', 'https://api.guepex.app/v1/wilayas/', { 'X-API-ID': '123', 'X-API-TOKEN': 'x' }],
  ['colivraison', 'https://colivraison.express/'],
  ['colivraison api', 'https://api.colivraison.express/'],
];
for (const [name, url, headers] of calls) {
  try {
    const r = await fetch(url, { headers: { Accept: 'application/json', ...(headers ?? {}) }, signal: AbortSignal.timeout(15000) });
    const t = (await r.text()).replace(/\s+/g, ' ').slice(0, 300);
    console.log(`${name} → ${r.status} ${t}`);
  } catch (e) {
    console.log(`${name} → ERR ${e.message}`);
  }
}
