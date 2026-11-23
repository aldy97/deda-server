-- 「测试哄睡模式」已从代码中移除：清掉历史遗留在 turn_decision_logs 的 test_sleep 分桶。
-- 该来源只在 staging 产生过（prod 从未转发 SLEEP_TEST_MODE_ENABLED），prod 执行时为空操作。
DELETE FROM "turn_decision_logs" WHERE "intentSource" = 'test_sleep';
