// Does every address Pilotix calls exist at each courier? Made-up keys: 401/403 (keys refused) = it exists, 404 = it
// does not. Nothing is created (the keys are refused before anything happens). Temporary check, kept for later runs.
const B = { Authorization: 'Bearer x', Accept: 'application/json' };
const set = {
  near: ['https://api.neardelivery.app/api/v1', { ApiKey: 'x', ApiSecret: 'y' }, ['GET /track/1', 'GET /track/NR123456', 'GET /track/ND-12345678', 'GET /parcels/1/status-history/sender', 'GET /parcels/NR123456/status-history/sender', 'GET /sender/parcels/1', 'GET /sender/parcels/NR123456', 'GET /sender/parcels/1/status-history', 'GET /parcels/1', 'GET /sender/parcels', 'GET /parcels', 'GET /sender/track/1', 'GET /tracking/1', 'GET /public/track/1']],
  elogistia: ['https://api.elogistia.com', {}, ['GET /getOrders?key=x&tracking=1', 'GET /getOrders?key=x']],
};
for (const [name, [base, headers, list]] of Object.entries(set)) {
  for (const line of list) {
    const [method, path] = line.split(' ');
    try {
      const r = await fetch(base + path, { method, headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...headers }, body: method === 'GET' || method === 'DELETE' ? undefined : '{}', signal: AbortSignal.timeout(20000) });
      const t = (await r.text()).replace(/\s+/g, ' ').slice(0, 110);
      console.log(`${name} ${line} → ${r.status} ${t}`);
    } catch (e) {
      console.log(`${name} ${line} → ERR ${e.message}`);
    }
  }
}
