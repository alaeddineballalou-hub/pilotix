#!/usr/bin/env bash
# End-to-end check of a running Pilotix server: login, create an order, move it through its statuses.
set -euo pipefail
API="${API:-http://localhost:3000/api}"
EMAIL="${SEED_ADMIN_EMAIL:-admin@pilotix.dz}"
PASS="${SEED_ADMIN_PASSWORD:?set SEED_ADMIN_PASSWORD}"

j() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s);console.log(eval('o'+process.argv[1]))})" "$1"; }

echo "→ health";      curl -fsS "$API/health" >/dev/null
TOKEN=$(curl -fsS -X POST "$API/auth/login" -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}" | j .token)
H=(-H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json')
echo "→ wrong password is refused"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/auth/login" -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"nope\"}")
[ "$code" = 401 ]
echo "→ no token is refused"
[ "$(curl -s -o /dev/null -w '%{http_code}' "$API/orders")" = 401 ]

PID=$(curl -fsS "${H[@]}" "$API/products" | j '[0].id')
echo "→ create order"
ORDER=$(curl -fsS "${H[@]}" -X POST "$API/orders" -d "{\"customerName\":\"Test Client\",\"phone\":\"+213 661 23 45 67\",\"wilaya\":16,\"commune\":\"Bab Ezzouar\",\"items\":[{\"productId\":$PID,\"variant\":\"M\",\"quantity\":2}],\"deliveryFee\":400}")
OID=$(echo "$ORDER" | j .id)
[ "$(echo "$ORDER" | j .phone)" = "0661234567" ]
echo "→ search by phone";  [ "$(curl -fsS "${H[@]}" "$API/orders?q=0661234567" | j .total)" -ge 1 ]
echo "→ invalid move refused"
[ "$(curl -s -o /dev/null -w '%{http_code}' "${H[@]}" -X POST "$API/orders/$OID/status" -d '{"status":"delivered"}')" = 400 ]
echo "→ new → confirmed (idempotent retry)"
curl -fsS "${H[@]}" -X POST "$API/orders/$OID/status" -d '{"status":"confirmed","clientId":"smoke-test-0001"}' >/dev/null
curl -fsS "${H[@]}" -X POST "$API/orders/$OID/status" -d '{"status":"confirmed","clientId":"smoke-test-0001"}' >/dev/null
echo "→ create livreur and assign"
LID=$(curl -fsS "${H[@]}" -X POST "$API/users" -d '{"name":"Livreur Test","email":"livreur.test@pilotix.dz","password":"livreur-test-123","roles":["livreur"]}' | j .id)
curl -fsS "${H[@]}" -X POST "$API/orders/$OID/status" -d "{\"status\":\"assigned\",\"livreurId\":$LID}" >/dev/null
STOCK_BEFORE=$(curl -fsS "${H[@]}" "$API/products" | j "[0].stock")
curl -fsS "${H[@]}" -X POST "$API/orders/$OID/status" -d '{"status":"shipped","tracking":"YAL-123"}' >/dev/null
STOCK_AFTER=$(curl -fsS "${H[@]}" "$API/products" | j "[0].stock")
[ $((STOCK_BEFORE - STOCK_AFTER)) = 2 ]
curl -fsS "${H[@]}" -X POST "$API/orders/$OID/status" -d '{"status":"delivered"}' >/dev/null
echo "→ offline sync"
curl -fsS "${H[@]}" -X POST "$API/orders/sync" -d "{\"actions\":[{\"clientId\":\"smoke-note-0001\",\"orderId\":$OID,\"kind\":\"note\",\"note\":\"ok\",\"at\":\"2026-01-01T00:00:00Z\"}]}" | grep -q '"ok":true'
echo "→ history";   [ "$(curl -fsS "${H[@]}" "$API/orders/$OID/events" | j .length)" -ge 5 ]
echo "→ dashboard"; curl -fsS "${H[@]}" "$API/dashboard" | grep -q revenueDelivered
echo "→ livreur sees only own orders"
LT=$(curl -fsS -X POST "$API/auth/login" -H 'Content-Type: application/json' -d '{"email":"livreur.test@pilotix.dz","password":"livreur-test-123"}' | j .token)
[ "$(curl -fsS -H "Authorization: Bearer $LT" "$API/orders" | j .total)" = 1 ]
[ "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $LT" "$API/dashboard")" = 403 ]
echo "✅ All checks passed"
