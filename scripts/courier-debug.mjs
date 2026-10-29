// Which addresses exist at a courier (made-up keys): 401/403 = the address exists (keys refused), 404 = no such address. Temporary.
const M = (p, method = 'GET') => [`maystro ${method} ${p}`, `https://backend.maystro-delivery.com/api/${p}`, { Authorization: 'Token x' }, method];
const calls = [
  ...['stores/orders/', 'stores/orders/1/', 'stores/orders/1/history/', 'stores/orders/history_order/1', 'stores/orders/history_order/1/', 'orders/history_order/1', 'stores/history_order/1/',
    'stores/orders/1/status/', 'stores/orders/status/', 'stores/orders/cancel/', 'stores/orders/bulk_cancel/', 'delivery/starter/starter_bordureau/', 'starter_bordureau/', 'stores/starter_bordureau/',
    'base/delivery-prices/', 'base/communes/?wilaya=16', 'stores/hooks/costume/', 'stores/hooks/types/', 'stores/order_history/', 'stores/orders/1/history_order/',
    'delivery/orders/1/', 'stores/orders/1/abort/', 'stores/orders/abort/', 'base/wilayas/?country=1'].map((p) => M(p)),
  M('stores/orders/1/', 'PATCH'), M('stores/orders/1/status/', 'PATCH'), M('stores/orders/', 'POST'), M('delivery/starter/starter_bordureau/', 'POST'),
  ['elogistia getMunicipalities', 'https://api.elogistia.com/getMunicipalities?key=x&wilaya=Alger'],
  ['elogistia getWilayas name', 'https://api.elogistia.com/getWilayas?key=x&name=Alger'],
  ['elogistia getTracking', 'https://api.elogistia.com/getTracking?key=x&tracking=1'],
  ['elogistia getManyTracking', 'https://api.elogistia.com/getManyTracking?key=x&tracking=1'],
  ['elogistia getAgences', 'https://api.elogistia.com/getAgences?key=x'],
  ['elogistia getShippingCost', 'https://api.elogistia.com/getShippingCost?key=x'],
];
for (const [name, url, headers, method] of calls) {
  try {
    const r = await fetch(url, { method: method ?? 'GET', headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(headers ?? {}) }, body: method && method !== 'GET' ? '{}' : undefined, signal: AbortSignal.timeout(15000) });
    const t = (await r.text()).replace(/\s+/g, ' ').slice(0, 160);
    console.log(`${name} → ${r.status} ${t}`);
  } catch (e) {
    console.log(`${name} → ERR ${e.message}`);
  }
}
