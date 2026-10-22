#!/usr/bin/env bash
# End-to-end check of a running Pilotix server filled with the demo shop (npm run seed:demo -w @pilotix/server).
set -euo pipefail
API="${API:-http://localhost:3000/api}"
PASS="demo-pilotix"

j() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s);const v=eval('o'+process.argv[1]);console.log(typeof v==='object'?JSON.stringify(v):v)})" "$1"; }
login() { curl -fsS -X POST "$API/auth/login" -H 'Content-Type: application/json' -d "{\"email\":\"$1\",\"password\":\"$PASS\"}" | j .token; }
rpc() { local tok=$1 name=$2 body=${3:-'{}'}; curl -fsS -X POST "$API/rpc/$name" -H "Authorization: Bearer $tok" -H 'Content-Type: application/json' -d "$body"; }
code() { local tok=$1 name=$2 body=${3:-'{}'}; curl -s -o /dev/null -w '%{http_code}' -X POST "$API/rpc/$name" -H "Authorization: Bearer $tok" -H 'Content-Type: application/json' -d "$body"; }

echo "→ health";                     curl -fsS "$API/health" >/dev/null
echo "→ wrong password refused";     [ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/auth/login" -H 'Content-Type: application/json' -d '{"email":"admin@demo.pilotix.dz","password":"nope"}')" = 401 ]
echo "→ no token refused";           [ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/rpc/orders.list" -H 'Content-Type: application/json' -d '{}')" = 401 ]
ADMIN=$(login admin@demo.pilotix.dz); CONF=$(login samira@demo.pilotix.dz); DEPOT=$(login karim@demo.pilotix.dz); LIV=$(login lamine@demo.pilotix.dz)
echo "→ orders.list";                [ "$(rpc "$CONF" orders.list '{"pageSize":5}' | j .total)" -ge 100 ]
echo "→ counts";                     rpc "$ADMIN" orders.counts | grep -q '"conf"'
PID=$(rpc "$ADMIN" orders.list '{"pageSize":1}' | j '.rows[0].items[0].productId')
VID=$(rpc "$ADMIN" orders.list '{"pageSize":1}' | j '.rows[0].items[0].variantId')
echo "→ create order (phone normalized, fee from grid)"
O=$(rpc "$CONF" orders.create "{\"customerName\":\"Test Serveur\",\"phone\":\"+213 661 22 33 44\",\"wilayaId\":16,\"commune\":\"Hydra\",\"items\":[{\"productId\":$PID,\"variantId\":$VID,\"qty\":1}]}")
OID=$(echo "$O" | j .id); [ "$(echo "$O" | j .phone)" = "0661223344" ]; [ "$(echo "$O" | j .deliveryFee)" -gt 0 ]
echo "→ callback needs a date";      [ "$(code "$CONF" orders.setConf "{\"ids\":[$OID],\"status\":\"callback\"}")" = 400 ]
echo "→ confirm";                    rpc "$CONF" orders.setConf "{\"ids\":[$OID],\"status\":\"confirmed\"}" >/dev/null
[ "$(rpc "$CONF" orders.get "{\"id\":$OID}" | j .followStatus)" = "to_prepare" ]
echo "→ confirmation agent cannot ship"; [ "$(code "$CONF" orders.setFollow "{\"ids\":[$OID],\"status\":\"shipped\"}")" = 403 ]
echo "→ depot prepares and ships";   rpc "$DEPOT" orders.setFollow "{\"ids\":[$OID],\"status\":\"prepared\"}" >/dev/null; rpc "$DEPOT" orders.setFollow "{\"ids\":[$OID],\"status\":\"shipped\",\"tracking\":\"T-1\"}" >/dev/null
echo "→ products locked after shipping"; [ "$(code "$CONF" orders.update "{\"id\":$OID,\"items\":[{\"productId\":$PID,\"variantId\":$VID,\"qty\":2}]}")" = 400 ]
echo "→ livreur sees only own orders"
LIVID=$(rpc "$LIV" me.get | j .profile.id)
rpc "$LIV" orders.list '{"pageSize":200}' | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s);if(!o.rows.every(r=>r.livreurId===$LIVID))process.exit(1)})"
[ "$(code "$LIV" orders.get "{\"id\":$OID}")" = 403 ]
echo "→ non-admin cannot create users"; [ "$(code "$CONF" users.create '{"name":"X Y","email":"x@y.dz","password":"12345678","roles":["admin"]}')" = 403 ]
echo "→ unknown action";             [ "$(code "$ADMIN" nope.nope)" = 404 ]
echo "→ website webhook"
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/hooks/orders/site?key=wrong" -H 'Content-Type: application/json' -d '{}')" = 401 ]
SKU=$(rpc "$ADMIN" orders.get "{\"id\":$OID}" >/dev/null; echo PX-POU-1)
curl -fsS -X POST "$API/hooks/orders/site?key=demo-webhook-key" -H 'Content-Type: application/json' \
  -d "{\"name\":\"Client Site\",\"phone\":\"0770112233\",\"wilaya\":31,\"commune\":\"Oran\",\"items\":[{\"sku\":\"$SKU\",\"qty\":1}]}" | grep -q '"ok":true'
echo "→ grouped action names";       rpc "$ADMIN" dellal.settings.get | grep -q '"verifyToken"'; rpc "$ADMIN" cm.settings.get | grep -q '"replyPublic"'
echo "→ Meta comment webhook (CM AI agent): signed only, answered after the shop's delay"
SECRET=smoke-app-secret
merge() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s).settings;console.log(JSON.stringify(Object.assign(o,JSON.parse(process.argv[1]))))})" "$1"; }
rpc "$ADMIN" dellal.settings.save "$(rpc "$ADMIN" dellal.settings.get | merge "{\"secrets\":{\"appSecret\":\"$SECRET\"}}")" >/dev/null
rpc "$ADMIN" cm.settings.save "$(rpc "$ADMIN" cm.settings.get | merge '{"enabled":true,"delaySec":0}')" >/dev/null
BODY='{"object":"page","entry":[{"id":"111","time":1,"changes":[{"field":"feed","value":{"item":"comment","verb":"add","comment_id":"999_smoke1","post_id":"111_999","parent_id":"111_999","message":"ch7al la poussette ?","from":{"id":"5551","name":"Smoke Test"},"created_time":1}}]}]}'
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/hooks/meta" -H 'Content-Type: application/json' --data-binary "$BODY")" = 401 ]
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.*= //')
curl -fsS -X POST "$API/hooks/meta" -H 'Content-Type: application/json' -H "x-hub-signature-256: sha256=$SIG" --data-binary "$BODY" | grep -q '"received":1'
# the demo page has no page token: the agent ran and the comment waits for a person, with the error
ST=new
for i in $(seq 1 30); do
  ST=$(rpc "$CONF" cm.feed '{"tab":"all"}' | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const c=JSON.parse(s).rows.find(r=>r.externalId==='999_smoke1');console.log(c?c.status:'none')})")
  [ "$ST" != new ] && [ "$ST" != none ] && break; sleep 0.5
done
[ "$ST" = error ]
echo "→ cron needs its key";         [ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/hooks/cron?key=x")" = 401 ]
echo "✅ All server checks passed"
