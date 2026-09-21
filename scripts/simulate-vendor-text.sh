#!/usr/bin/env bash
# 用 curl 模拟机芯厂商云通过 WebSocket 向我方发送用户 ASR 文字
# 实际调用的是 POST /vendor/text HTTP 端点，内部复用 WebSocket 同一套业务逻辑

set -e

API_BASE_URL="${API_BASE_URL:-http://localhost:3000}"
DEVICE_ID="${DEVICE_ID:-dev-sample-001}"
TEXT="${TEXT:-Hello, how are you?}"
TEXTBOOK_ID="${TEXTBOOK_ID:-sample-textbook}"
UNIT_ID="${UNIT_ID:-unit-1}"

echo "Simulating vendor:text:in via HTTP..."
echo "  deviceId:   $DEVICE_ID"
echo "  text:       $TEXT"
echo "  textbookId: $TEXTBOOK_ID"
echo "  unitId:     $UNIT_ID"
echo "  url:        $API_BASE_URL/vendor/text"
echo ""

curl -s -X POST "$API_BASE_URL/vendor/text" \
  -H "Content-Type: application/json" \
  -d "{
    \"deviceId\": \"$DEVICE_ID\",
    \"asrText\": \"$TEXT\",
    \"textbookId\": \"$TEXTBOOK_ID\",
    \"unitId\": \"$UNIT_ID\"
  }" | jq .
