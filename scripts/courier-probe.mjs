// Calls every delivery company's API with made-up keys (nothing is created): alive and reached from the internet?
// Run after building shared + core: node scripts/courier-probe.mjs > probe.json
const m = await import('../packages/core/dist/couriers/index.js');
const r = await m.probeCouriers();
console.log(JSON.stringify({ at: new Date().toISOString(), results: r }, null, 2));
