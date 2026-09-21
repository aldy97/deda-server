#!/usr/bin/env bash
# 测试对话边界与多轮上下文：
# 1. 同一教材同一单元的多轮对话，历史会被拼接到 prompt
# 2. 不同单元之间的对话历史互相隔离
# 3. 当用户偏离当前单元时，DS 会简短回应并引导回单元内容

set -e

API_BASE_URL="${API_BASE_URL:-http://localhost:3000}"
TEXTBOOK_ID="unlock_l1_speaking&listening"
DEVICE_ID="dev-multi-turn-001"

echo "=========================================="
echo "多轮对话边界测试：$TEXTBOOK_ID"
echo "API: $API_BASE_URL/vendor/text"
echo "Device: $DEVICE_ID"
echo "=========================================="
echo ""

# 同一单元多轮对话：unit-listening-2 Famous People
echo "[Round 1] unit-listening-2: Famous People and Jobs"
echo "User: Who is Nadiya Hussain?"
curl -s -X POST "$API_BASE_URL/vendor/text" \
  -H "Content-Type: application/json" \
  -d "{
    \"deviceId\": \"$DEVICE_ID\",
    \"asrText\": \"Who is Nadiya Hussain?\",
    \"textbookId\": \"$TEXTBOOK_ID\",
    \"unitId\": \"unit-listening-2\"
  }" | jq .
echo ""

echo "[Round 2] 同一单元继续：询问 Salman Khan"
echo "User: What about Salman Khan?"
curl -s -X POST "$API_BASE_URL/vendor/text" \
  -H "Content-Type: application/json" \
  -d "{
    \"deviceId\": \"$DEVICE_ID\",
    \"asrText\": \"What about Salman Khan?\",
    \"textbookId\": \"$TEXTBOOK_ID\",
    \"unitId\": \"unit-listening-2\"
  }" | jq .
echo ""

echo "[Round 3] 同一单元继续：偏离话题测试"
echo "User: I like eating pizza."
curl -s -X POST "$API_BASE_URL/vendor/text" \
  -H "Content-Type: application/json" \
  -d "{
    \"deviceId\": \"$DEVICE_ID\",
    \"asrText\": \"I like eating pizza.\",
    \"textbookId\": \"$TEXTBOOK_ID\",
    \"unitId\": \"unit-listening-2\"
  }" | jq .
echo ""

echo "[Round 4] 同一单元继续：拉回到单元内容"
echo "User: What jobs does she have?"
curl -s -X POST "$API_BASE_URL/vendor/text" \
  -H "Content-Type: application/json" \
  -d "{
    \"deviceId\": \"$DEVICE_ID\",
    \"asrText\": \"What jobs does she have?\",
    \"textbookId\": \"$TEXTBOOK_ID\",
    \"unitId\": \"unit-listening-2\"
  }" | jq .
echo ""

# 切换到不同单元，验证历史隔离
echo "[Round 5] 切换到 unit-listening-1: Seasons and Weather"
echo "User: What's winter like?"
curl -s -X POST "$API_BASE_URL/vendor/text" \
  -H "Content-Type: application/json" \
  -d "{
    \"deviceId\": \"$DEVICE_ID\",
    \"asrText\": \"What's winter like?\",
    \"textbookId\": \"$TEXTBOOK_ID\",
    \"unitId\": \"unit-listening-1\"
  }" | jq .
echo ""

echo "=========================================="
echo "验证数据库中的对话记录（应看到单元隔离）："
psql "postgresql://xiong@localhost:5432/deda_db" -c "
  SELECT \"unitId\", \"asrText\", LEFT(\"aiReply\", 70) as ai_reply_preview
  FROM conversations
  WHERE \"deviceId\" IN (
    SELECT id FROM devices WHERE \"deviceId\" = '$DEVICE_ID'
  )
  ORDER BY \"createdAt\" ASC;
"
echo "=========================================="
