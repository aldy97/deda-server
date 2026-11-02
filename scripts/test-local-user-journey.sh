#!/usr/bin/env bash
# 本地全链路人工验收：真实 HTTP + 真实 LLM + 当前开发数据库。
# 不接入 CI/CD；仅在用户明确运行时写入本文件指定的测试数据。
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
if [[ -f .env ]]; then
  set -a
  source .env
  set +a
fi

API_BASE_URL="${API_BASE_URL:-http://127.0.0.1:3000}"
export DEVICE_INTERNAL_ID="${DEVICE_INTERNAL_ID:-d6652314-2a68-4893-9014-322bc938856a}"
PASS_COUNT=0
PARENT_TOKEN=""
PARENT_RESPONSE=""
VENDOR_RESPONSE=""
EPISODE1_ORIGINAL_DATE=""

function db() {
  node -r ts-node/register/transpile-only -r tsconfig-paths/register \
    scripts/local-user-journey-db.ts "$@"
}

function pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  echo "PASS ${PASS_COUNT}: $1"
}

function restore_episode1() {
  if [[ -n "$EPISODE1_ORIGINAL_DATE" ]]; then
    db set-episode1-date "$EPISODE1_ORIGINAL_DATE" >/dev/null || true
  fi
}
trap restore_episode1 EXIT

function call_vendor() {
  local text="$1"
  local payload
  payload=$(jq -n --arg deviceId "$BUSINESS_DEVICE_ID" --arg asrText "$text" \
    '{deviceId:$deviceId,asrText:$asrText}')
  VENDOR_RESPONSE=$(curl -sS --fail-with-body -X POST "$API_BASE_URL/vendor/text" \
    -H "Content-Type: application/json" -d "$payload")
  echo "$VENDOR_RESPONSE" | jq -e '.data.responseText | type == "string" and length > 0' >/dev/null
  pass "vendor text [$text]"
}

function assert_message() {
  db assert-message "$1" "$2" >/dev/null
  pass "database mode=$2 [$1]"
}

function parent_login() {
  local response
  response=$(curl -sS --fail-with-body -X POST "$API_BASE_URL/users/login" \
    -H "Content-Type: application/json" -d '{"code":"local-user-journey"}')
  PARENT_TOKEN=$(echo "$response" | jq -er '.data.token')
  pass "parent login"
}

function parent_get() {
  local path="$1"
  PARENT_RESPONSE=$(curl -sS --fail-with-body "$API_BASE_URL$path" \
    -H "Authorization: Bearer $PARENT_TOKEN")
  echo "$PARENT_RESPONSE" | jq -e '.code == 0' >/dev/null
}

function parent_post() {
  local path="$1"
  local body="$2"
  PARENT_RESPONSE=$(curl -sS --fail-with-body -X POST "$API_BASE_URL$path" \
    -H "Authorization: Bearer $PARENT_TOKEN" \
    -H "Content-Type: application/json" -d "$body")
  echo "$PARENT_RESPONSE" | jq -e '.code == 0' >/dev/null
}

# 失败重跑时显式清理脚本消息、颜色记忆和第 2 集进度；默认绝不重置历史。
if [[ "${RESET_LOCAL_JOURNEY:-0}" == "1" ]]; then
  db reset-local-journey
  echo "Reset script-owned local journey"
fi

PREPARE=$(db prepare)
BUSINESS_DEVICE_ID=$(echo "$PREPARE" | jq -er '.deviceId')
EPISODE1_ORIGINAL_DATE=$(echo "$PREPARE" | jq -er '.episode1OriginalDate')
TODAY=$(db today)
YESTERDAY=$(db yesterday)
TWO_DAYS_AGO=$(db date-offset -2)
echo "Local journey: $BUSINESS_DEVICE_ID / $TODAY"
pass "Elly episode 2 prepared with five interactions"

parent_login
parent_get "/devices"
echo "$PARENT_RESPONSE" | jq -e --arg id "$BUSINESS_DEVICE_ID" \
  '.data | any(.[]; .deviceId == $id)' >/dev/null
pass "parent device list"
parent_get "/devices/$BUSINESS_DEVICE_ID"
pass "parent device detail"
parent_get "/devices/$BUSINESS_DEVICE_ID/status"
pass "parent device status"
parent_get "/child-profiles/device/$BUSINESS_DEVICE_ID"
pass "parent child profile"
parent_get "/conversation-modes/tree"
pass "conversation mode tree"

call_vendor "我最喜欢的颜色是红色。"
assert_message "我最喜欢的颜色是红色。" "free_chat"
db wait-memory "红色" >/dev/null
pass "ChildMemory active red preference"
call_vendor "我现在最喜欢蓝色。"
assert_message "我现在最喜欢蓝色。" "free_chat"
db wait-memory "蓝色" >/dev/null
pass "ChildMemory superseded red with blue"
call_vendor "你还记得我最喜欢什么颜色吗？"
assert_message "你还记得我最喜欢什么颜色吗？" "free_chat"
echo "$VENDOR_RESPONSE" | jq -e '.data.responseText | ascii_downcase | contains("蓝色") or contains("blue")' >/dev/null
pass "free chat recalls updated preference"

# ASR 边界：含糊输入仍自由对话，中英混杂可自由聊天或显式切换。
UNCLEAR_TEXT="嗯……那个……啊……我也不知道要说什么。"
call_vendor "$UNCLEAR_TEXT"
assert_message "$UNCLEAR_TEXT" "free_chat"
echo "$VENDOR_RESPONSE" | jq -e '.data.responseText | test("铅笔|刷牙|小鸟") | not' >/dev/null
pass "unclear ASR does not revive unrelated legacy topics"
MIXED_FREE_TEXT="Can we just chat? 我们今天随便聊聊。"
call_vendor "$MIXED_FREE_TEXT"
assert_message "$MIXED_FREE_TEXT" "free_chat"

ENGLISH_TEXT="I want to hear an English story and practice speaking."
call_vendor "$ENGLISH_TEXT"
assert_message "$ENGLISH_TEXT" "english_story"
call_vendor "继续讲。"
assert_message "继续讲。" "english_story"
pass "continue keeps english story session"
IDIOM_TEXT="讲一个守株待兔的成语故事。"
call_vendor "$IDIOM_TEXT"
assert_message "$IDIOM_TEXT" "idiom_story"
SLEEP_TEXT="我要睡觉了，讲一个温柔的哄睡故事。"
call_vendor "$SLEEP_TEXT"
assert_message "$SLEEP_TEXT" "sleep_story"
# 前端「如何进入哄睡模式」方式1 的四类语音指令覆盖。
call_vendor "进入哄睡模式"
assert_message "进入哄睡模式" "sleep_story"
call_vendor "陪我睡觉"
assert_message "陪我睡觉" "sleep_story"
call_vendor "我要听睡前故事"
assert_message "我要听睡前故事" "sleep_story"
# 「我要听睡前儿歌」依赖儿歌内容源（后续批次），当前仅记录实际路由模式，不断言。
call_vendor "我要听睡前儿歌"
SONG_MODE=$(psql "${DATABASE_URL%%\?*}" -tAc \
  "SELECT mode FROM messages WHERE role = 'user' AND content = '我要听睡前儿歌' ORDER BY \"createdAt\" DESC LIMIT 1")
echo "INFO: 睡前儿歌 routed mode => ${SONG_MODE:-unknown}"
FREE_TEXT="不想听故事了，我们随便聊聊。今天天气怎么样？"
call_vendor "$FREE_TEXT"
assert_message "$FREE_TEXT" "free_chat"

# 真实生成后仅回写测试消息时间，用于历史趋势和昨日日报。
db backdate "$ENGLISH_TEXT" "$YESTERDAY"
db backdate "继续讲。" "$YESTERDAY"
db backdate "$SLEEP_TEXT" "$YESTERDAY"
db backdate "$IDIOM_TEXT" "$TWO_DAYS_AGO"
pass "historical messages backdated across modes"

# 第 1 集今天完成：第 2 集当天不可开启。
db set-episode1-date "$TODAY"
call_vendor "我想玩下一集每日冒险。"
assert_message "我想玩下一集每日冒险。" "free_chat"
db assert-no-progress 2
pass "next episode blocked on episode 1 completion day"

# 模拟第二天：只能进入第 2 集，明确回上一集也不会重播第 1 集。
db set-episode1-date "$YESTERDAY"
call_vendor "我想回到上一集，再听一遍风铃树。"
assert_message "我想回到上一集，再听一遍风铃树。" "adventure_story"
db assert-current "awaiting_reply" 2
echo "$VENDOR_RESPONSE" | jq -e '.data.context.adventure == true' >/dev/null
pass "next day enters episode 2 without replaying episode 1"
restore_episode1

# 互动 1：退出、当日恢复、首次跑题引回、正常二选一。
call_vendor "我不想玩了。"
assert_message "我不想玩了。" "adventure_story"
db assert-current "exited" 2
pass "adventure exit preserves progress"
call_vendor "我想继续今天的冒险。"
assert_message "我想继续今天的冒险。" "adventure_story"
db assert-current "awaiting_reply" 2
pass "same-day resume keeps episode and segment"
call_vendor "我想吃披萨，不想回答这个。"
assert_message "我想吃披萨，不想回答这个。" "adventure_story"
db assert-current "awaiting_reply" 2
pass "first off-topic choice redirects without advancing"
call_vendor "沿着小河走。"
assert_message "沿着小河走。" "adventure_story"
db assert-current "awaiting_reply" 4
pass "two-choice interaction advances"

# 互动 2：开放式正常回答；互动 3：跟读。
call_vendor "你可以请小松鼠一起帮忙，朋友会很愿意的。"
assert_message "你可以请小松鼠一起帮忙，朋友会很愿意的。" "adventure_story"
db assert-current "awaiting_reply" 6
pass "open question receives contextual reply"
call_vendor "请帮我一下，好吗？"
assert_message "请帮我一下，好吗？" "adventure_story"
db assert-current "awaiting_reply" 8
pass "repeat-after-me interaction advances"

# 互动 4：退出、跨天恢复、沉默超时后兜底推进。
call_vendor "我不想玩了，明天再继续。"
assert_message "我不想玩了，明天再继续。" "adventure_story"
db assert-current "exited" 8
db move-current-daily-yesterday
pass "unfinished adventure moved to yesterday"
call_vendor "我想继续昨天的冒险。"
assert_message "我想继续昨天的冒险。" "adventure_story"
db assert-current "awaiting_reply" 8
pass "next-day resume keeps yesterday episode"
sleep 15
db assert-current "awaiting_reply" 10
pass "ten-second silence uses fallback and advances"

# 互动 5：首次跑题引回，第二次跑题兜底完集；迟到回答不得回滚。
call_vendor "我想吃披萨，不想回答这个。"
assert_message "我想吃披萨，不想回答这个。" "adventure_story"
db assert-current "awaiting_reply" 10
pass "final choice first off-topic reply redirects"
call_vendor "一加一等于几？我还是不想回答。"
assert_message "一加一等于几？我还是不想回答。" "adventure_story"
db assert-completed
pass "final choice second off-topic reply completes through fallback"
call_vendor "我选择绕过去。"
assert_message "我选择绕过去。" "free_chat"
pass "late answer cannot roll back completed adventure"

# 今日完成后，上一集和下一集都不可进入；明确其他模式仍可切换。
call_vendor "我想回到上一集，再听一遍风铃树。"
assert_message "我想回到上一集，再听一遍风铃树。" "free_chat"
call_vendor "我想玩下一集每日冒险。"
assert_message "我想玩下一集每日冒险。" "free_chat"
db assert-entry-blocked
pass "completed-day gate prevents old and new adventures"
AFTER_COMPLETED_ENGLISH="今天冒险结束了，那讲一个英语故事吧。"
call_vendor "$AFTER_COMPLETED_ENGLISH"
assert_message "$AFTER_COMPLETED_ENGLISH" "english_story"
pass "explicit english intent works after adventure completion"

# 全部集数均在过去完成后，不得重播旧集或伪造新的冒险进度。
db set-current-completed-date "$YESTERDAY"
call_vendor "我还想玩每日冒险。"
assert_message "我还想玩每日冒险。" "free_chat"
echo "$VENDOR_RESPONSE" | jq -e '.data.responseText | test("马上.{0,2}开始|开始每日冒险|进入每日冒险") | not' >/dev/null
pass "unavailable adventure makes no false start promise"
db assert-adventure-exhausted
pass "completed catalogue never replays old episodes"

# 家长端：手动生成昨日报告、趋势一致性、反馈和统计接口。
db generate-report "$YESTERDAY"
db assert-report "$YESTERDAY"
pass "manual parent report generation with real LLM and complete database fields"
parent_get "/learning-stats/parent-report?deviceId=$BUSINESS_DEVICE_ID&date=$YESTERDAY"
REPORT_JSON="$PARENT_RESPONSE"
echo "$REPORT_JSON" | jq -e '.data.generationStatus == "completed"' >/dev/null
echo "$REPORT_JSON" | jq -e '.data.summary | type == "object"' >/dev/null
echo "$REPORT_JSON" | jq -e '.data.modeUsage | all(.[]; (.label | type == "string" and length > 0))' >/dev/null
pass "parent report status summary and Chinese labels"
REPORT_MINUTES=$(echo "$REPORT_JSON" | jq -er '.data.durationMinutes')
parent_get "/learning-stats/daily?deviceId=$BUSINESS_DEVICE_ID&days=7&scope=all"
DAILY_JSON="$PARENT_RESPONSE"
DAILY_MINUTES=$(echo "$DAILY_JSON" | jq -er --arg date "$YESTERDAY" \
  '.data[] | select(.date == $date) | .durationMinutes')
[[ "$REPORT_MINUTES" == "$DAILY_MINUTES" ]]
echo "$DAILY_JSON" | jq -e '.data | length == 7 and all(.[]; .date | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}$"))' >/dev/null
pass "seven-day full dates and report duration consistency"
FEEDBACK_BODY=$(jq -n --arg deviceId "$BUSINESS_DEVICE_ID" --arg reportDate "$YESTERDAY" \
  '{deviceId:$deviceId,reportDate:$reportDate,useful:true}')
parent_post "/learning-stats/parent-report/feedback" "$FEEDBACK_BODY"
parent_get "/learning-stats/parent-report?deviceId=$BUSINESS_DEVICE_ID&date=$YESTERDAY"
echo "$PARENT_RESPONSE" | jq -e '.data.feedback == "useful"' >/dev/null
db assert-report "$YESTERDAY" "useful"
pass "parent report feedback persisted"

parent_get "/conversations?deviceId=$BUSINESS_DEVICE_ID&page=1&pageSize=20"
echo "$PARENT_RESPONSE" | jq -e '.data.items | length > 0' >/dev/null
pass "parent conversation history"
for endpoint in \
  "/learning-stats/dashboard?deviceId=$BUSINESS_DEVICE_ID&range=week" \
  "/learning-stats/topics?deviceId=$BUSINESS_DEVICE_ID" \
  "/learning-stats/timeline?deviceId=$BUSINESS_DEVICE_ID&page=1&pageSize=10" \
  "/learning-stats/activities?deviceId=$BUSINESS_DEVICE_ID&range=week" \
  "/learning-stats/insights?deviceId=$BUSINESS_DEVICE_ID&range=week" \
  "/learning-stats/health?deviceId=$BUSINESS_DEVICE_ID&range=week" \
  "/device-configs/$BUSINESS_DEVICE_ID/current"; do
  parent_get "$endpoint"
  pass "parent API $endpoint"
done

restore_episode1
EPISODE1_ORIGINAL_DATE=""
db summary
echo "LOCAL USER JOURNEY PASSED: ${PASS_COUNT} checks"
