// Which addresses exist at a courier (made-up keys): 401/403 = the address exists (keys refused), 404 = no such address. Temporary.
const M = (p, method = 'GET') => [`maystro ${method} ${p}`, `https://b.maystro-delivery.com/api/${p}`, { Authorization: 'Token x' }, method];
const calls = [
  ...["base/communes/?wilaya=16", "base/delivery-prices/", "orders/history_order/1", "stores/history_order/1/", "stores/orders/", "base/wilayas/?country=1", "starter_bordureau/", "delivery/starter/starter_bordureau/", "stock/products", "orders/1/", "orders/", "base/", "stores/orders/1/"].map((p) => M(p)),
];
for (const [name, url, headers, method] of calls) {
  try {
    const r = await fetch(url, { method: method ?? 'GET', headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(headers ?? {}) }, body: method && method !== 'GET' ? '{}' : undefined, signal: AbortSignal.timeout(30000) });
    const t = (await r.text()).replace(/\s+/g, ' ').slice(0, 160);
    console.log(`${name} → ${r.status} ${t}`);
  } catch (e) {
    console.log(`${name} → ERR ${e.message}`);
  }
}
