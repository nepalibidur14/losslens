npx tsx server.ts

SHOP=$(curl -s -F file=@bakery_sales_sample.csv localhost:4000/api/upload | node -pe 'JSON.parse(require("fs").readFileSync(0)).shopId')

echo $SHOP


in another terminal:
curl -s -H 'Content-Type: application/json' -d "{\"shopId\":\"$SHOP\",\"message\":\"How much was wasted last month vs same month last year?\"}" localhost:4000/api/chat


curl -s -H 'Content-Type: application/json' -d "{\"shopId\":\"$SHOP\",\"message\":\"雨の日に一番ロスが多い商品は?\"}" localhost:4000/api/chat
