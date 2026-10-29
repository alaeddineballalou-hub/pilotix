// Does every address Pilotix calls exist at each courier? Made-up keys: 401/403 (keys refused) = it exists, 404 = it
// does not. Nothing is created (the keys are refused before anything happens). Temporary check, kept for later runs.
const B = { Authorization: 'Bearer x', Accept: 'application/json' };
const set = {
  zimou: ['https://zimou.express/api', B, ['GET /v3/user', 'GET /v3/helpers/communes', 'GET /v3/helpers/offices', 'GET /v3/helpers/wilayas', 'GET /v3/my/prices', 'POST /v3/packages', 'DELETE /v3/packages/bulk', 'POST /v3/packages/labels', 'POST /v3/packages/mark-as-returned', 'GET /v3/packages/status', 'POST /v3/orders/1/comments', 'PUT /v3/packages/1', 'GET /v3/packages/1/histories', 'GET /v3/packages/1']],
  near: ['https://api.neardelivery.app/api/v1', { ApiKey: 'x', ApiSecret: 'y' }, ['POST /parcels', 'GET /sender/buralists', 'GET /sender/centers', 'GET /sender/delivery-fees', 'GET /sender/wilayas', 'PATCH /parcels/1', 'DELETE /parcels/1', 'GET /parcels/X1/status-history/sender', 'GET /sender/parcels/X1/bordereau', 'GET /track/X1']],
  mdm: ['https://api.mdm.express', { 'x-api-key': 'x' }, ['GET /api/auth/me', 'GET /api/geo/cities', 'GET /api/geo/countries', 'POST /api/prints/parcel-slips', 'GET /api/prints/files/1', 'POST /api/v2/orders', 'POST /api/v2/orders/search', 'GET /api/v2/shipping/companies/offices', 'GET /api/v2/orders/X1/status-history', 'GET /api/v2/orders/X1']],
  ecom: ['https://ecom-dz.net', { Token: 'x', Key: 'y' }, ['GET /Api_v1/Test', 'POST /Api_v1/Colis', 'POST /Api_v1/Colis/Liste', 'GET /Api_v1/Stopdesk', 'PUT /Api_v1/Supprimer', 'PUT /Api_v1/Colis/X1', 'GET /Api_v1/Colis/Tracking/X1', 'GET /Api_v1/Commune/16', 'GET /Api_v1/Historique/Tracking/X1', 'PUT /Api_v1/aExp%C3%A9dier']],
  noest: ['https://app.noest-dz.com/api/public', B, ['POST /add/maj', 'POST /ask/new-tentative', 'POST /ask/return', 'POST /create/order', 'POST /delete/order', 'GET /desks', 'POST /get/trackings/info', 'POST /update/order', 'POST /valid/order', 'GET /get/order/label?tracking=X1', 'GET /fees', 'GET /get/fees']],
  ecotrack: ['https://dhd.ecotrack.dz/api/v1', B, ['POST /add/maj', 'POST /ask/for/order/return', 'POST /create/order', 'DELETE /delete/order', 'GET /get/communes?wilaya_id=16', 'GET /get/fees', 'GET /get/order/label?tracking=X1', 'GET /get/orders', 'GET /get/orders/status', 'GET /get/tracking/info?tracking=X1', 'POST /update/order', 'POST /valid/order', 'GET /validate/token?api_token=x']],
  elogistia: ['https://api.elogistia.com', {}, ['GET /deleteOrder?key=x&tracking=1', 'GET /getAgences?key=x', 'GET /getManyTracking?key=x&tracking=1', 'GET /getMunicipalities?key=x&wilaya=16', 'GET /getOrders/1?key=x', 'GET /getShippingCost?key=x', 'GET /getTracking?key=x&tracking=1', 'POST /insertCommande?key=x', 'GET /printBordereau_10x15?key=x&tracking=1']],
  yalidine: ['https://api.yalidine.app/v1', { 'X-API-ID': '123', 'X-API-TOKEN': 'x' }, ['GET /wilayas/', 'GET /communes/', 'GET /centers/', 'GET /parcels/', 'POST /parcels/', 'PATCH /parcels/yal-X1', 'DELETE /parcels/yal-X1', 'GET /histories/', 'GET /fees/']],
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
