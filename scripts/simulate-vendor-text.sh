#!/usr/bin/env bash
# 【DEPRECATED — 备选链路专用】2026-11 起主链路为百度 RTC 直连
# （POST /v1/chat/completions，本仓 src/modules/llm-adapter/）。
# 本脚本仅在老 vendor 链路（降级备份）回归测试时使用；
# 新链路请用 scripts/simulate-baidu-llm.sh。
#
# 用 curl 模拟机芯厂商云通过 WebSocket 向我方发送用户 ASR 文字
# 实际调用的是 POST /vendor/text HTTP 端点，内部复用 WebSocket 同一套业务逻辑

set -e

API_BASE_URL="${API_BASE_URL:-http://localhost:3000}"
DEVICE_ID="${DEVICE_ID:-dev-sample-001}"
TEXT="${TEXT:-Hello, how are you?}"

echo "Simulating vendor:text:in via HTTP..."
echo "  deviceId: $DEVICE_ID"
echo "  text:     $TEXT"
echo "  url:      $API_BASE_URL/vendor/text"
echo ""

curl -s -X POST "$API_BASE_URL/vendor/text" \
  -H "Content-Type: application/json" \
  -d "{
    \"deviceId\": \"$DEVICE_ID\",
    \"asrText\": \"$TEXT\"
  }" | jq .
