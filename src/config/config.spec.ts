import appConfig from "./app.config";
import databaseConfig from "./database.config";
import redisConfig from "./redis.config";

describe("config 命名空间注册", () => {
  it("三个配置命名空间已注册", () => {
    expect(appConfig).toBeDefined();
    expect(databaseConfig).toBeDefined();
    expect(redisConfig).toBeDefined();
  });

  it("app 配置工厂产出默认字段", () => {
    const cfg = appConfig();
    expect(cfg.nodeEnv).toBeDefined();
    expect(cfg.name).toBeDefined();
    expect(cfg.port).toBeDefined();
  });

  it("database/redis 配置工厂产出 url 字段", () => {
    expect(databaseConfig()).toHaveProperty("url");
    expect(redisConfig()).toHaveProperty("url");
  });
});
