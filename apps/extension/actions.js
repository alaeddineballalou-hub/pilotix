// Pilotix extension: the Pilotix actions that the extension's pieces on other sites may ask the open Pilotix page for.
// background.js checks every request against this list (the action, and the site it comes from); the Pilotix page
// checks its own list again before running it (apps/web/src/lib/extBridge.ts), with the rights of whoever is logged in
// there. Nothing else can be asked: no other action, from no other site.
//   from: the sites (exact host names) whose extension piece may ask.
export const PILOTIX_ACTIONS = Object.freeze({
  // the customer card on WhatsApp Web (card.js): who the chat's number is in Pilotix, and quick replies
  'customers.waCard': { from: ['web.whatsapp.com'] },
  // the buttons on Facebook's ad library (library.js): the products, the tags, the ads already in AI Spy (saving one goes
  // through the worker's 'library-save', which reads the ad from the page first: spy.libraryAd)
  'spy.libraryInfo': { from: ['www.facebook.com', 'web.facebook.com'] },
  // Pilotix's numbers in Meta's Ads Manager (adsmanager.js and its list, adspanel.js)
  'ads.extNumbers': { from: ['adsmanager.facebook.com', 'business.facebook.com'] },
});
