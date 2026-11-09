# Suivi demo scenarios

Réclamation is in Suivi → Alertes. Swap is in Alertes → Annulés, after cancelling an alert. Desktop tables and phone parcel details use the same placement; cancelling through Traiter first moves the parcel into Annulés before a swap is offered.

The fresh demo has 2,400 base orders over 60 days, 16 catalog products plus existing feature fixtures, 19 store accounts covering all existing roles (including a combined confirmation/suivi agent), courier claims in several stages, returns, SAV exchanges, and up to four completed same-product swaps. Existing partner demos are preserved. All store accounts use the documented demo password. Small test seeds can still request fewer orders.

On Suivi lists, demo suivi agents and administrators can expand **API transporteur simulée · Démo**, select a tracked parcel and simulate an alert, delivery, return, loss or API 503 response. This calls `delivery.demoScenario` through the existing RPC and tracking reconciliation rules. A 503 makes no changes. Treated alerts and returns retain the normal manual holds; the depot still receives returned parcels. Claims, redelivery requests, swaps and shipping already use the existing simulated courier behavior.

Safety boundaries:

- The scenario RPC requires Suivi or Dépôt permission and rejects any context with server hooks or an explicitly non-demo shop before reading orders.
- The server's demo shop continues to have no real server hooks; browser demos use an in-memory PGlite database.
- The real courier adapter entry refuses both demo shops and demo credentials.
- No real courier endpoint, credential or production seed is changed. The simulator writes only to its existing demo context.
- The production demo shop receives the expanded data on its normal demo reset (or an administrator's existing reset action). Deploying code alone does not reseed any existing shop. Never run `seed:demo` on a real shop to update the demo.

Validation: typecheck, core demo/Suivi/permissions regressions, web production and artifact builds, then browser checks on desktop and phone. Deployment remains gated on successful CI on main. After deployment, verify both the live version and the Android app's Suivi navigation; Android loads the live website.
