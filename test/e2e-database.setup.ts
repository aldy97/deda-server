const testDatabaseUrl = process.env.TEST_DATABASE_URL;

if (testDatabaseUrl) {
  const databaseName = new URL(testDatabaseUrl).pathname.split("/").pop() ?? "";
  if (!/(^|[_-])test([_-]|$)/i.test(databaseName)) {
    throw new Error(
      "TEST_DATABASE_URL must point to a database whose name contains test",
    );
  }
  process.env.DATABASE_URL = testDatabaseUrl;
}

process.env.REDIS_URL = "";
process.env.MQTT_URL = "";
process.env.PARENT_REPORT_GENERATION_ENABLED = "false";
