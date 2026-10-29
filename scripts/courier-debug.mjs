// Which addresses exist at a courier (made-up keys): 401/403 = the address exists (keys refused), 404 = no such address. Temporary.
const M = (p, method = 'GET') => [`maystro ${method} ${p}`, `https://backend.maystro-delivery.com/api/${p}`, { Authorization: 'Token x' }, method];
const calls = [
  ...["base/communes", "base/commune/", "base/communes/1/", "base/wilayas/16/communes/", "base/wilayas/16/", "base/wilayas/", "base/delivery_prices/", "base/delivery-price/", "base/prices/", "delivery/prices/", "delivery/delivery_prices/", "stores/delivery_prices/", "base/delivery_price/", "delivery/price/", "stores/history_order/1/", "stores/orders/1/history_order/", "base/communes/?wilaya=16&country=1", "base/municipalities/", "base/cities/", "base/region/", "base/regions/", "base/zones/", "base/countries/", "delivery/starter/", "delivery/", "stores/", "base/"].map((p) => M(p)),
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
