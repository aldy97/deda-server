import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { RedisService } from "@/common/redis/redis.service";
import {
  ADVENTURE_BREAKER_KEYS,
  ADVENTURE_BREAKER_TRIPPED_MARKER,
} from "./adventure.constants";
import { AdventureCircuitBreaker } from "./adventure-circuit-breaker.service";

/**
 * 内存版 RedisService 替身：真的实现滑动窗口语义（zset 按 score 过滤），
 * 而不是把断言写成「某个 mock 被调用过」——熔断的核心是计数对不对，
 * 用假实现才能验到「窗口外的失败不再计入」这类真实行为。
 */
function createFakeRedis() {
  const zsets = new Map<string, Map<string, number>>();
  const strings = new Map<string, string>();
  const ttls = new Map<string, number>();
  return {
    zsets,
    strings,
    ttls,
    service: {
      getValue: jest.fn(async (key: string) => strings.get(key) ?? null),
      setValue: jest.fn(async (key: string, value: string, ttl?: number) => {
        strings.set(key, value);
        if (ttl) ttls.set(key, ttl);
      }),
      // 与真实 RedisService 的 DEL 语义一致：不区分类型，string 与 zset 都删。
      // 「两个 key 都删到了吗」由下面的 toHaveBeenCalledWith 断言负责，
      // 不靠这个替身的类型差异来隐式检验。
      deleteValue: jest.fn(async (key: string) => {
        strings.delete(key);
        ttls.delete(key);
        zsets.delete(key);
      }),
      zAdd: jest.fn(async (key: string, score: number, member: string) => {
        const set = zsets.get(key) ?? new Map<string, number>();
        set.set(member, score);
        zsets.set(key, set);
      }),
      zRangeByScoreWithScores: jest.fn(
        async (key: string, min: number, max: number) => {
          const set = zsets.get(key);
          if (!set) return [];
          return [...set.entries()]
            .filter(([, score]) => score >= min && score <= max)
            .map(([member, score]) => ({ member, score }))
            .sort((a, b) => a.score - b.score);
        },
      ),
      zRemRangeByScore: jest.fn(
        async (key: string, min: number, max: number) => {
          const set = zsets.get(key);
          if (!set) return;
          for (const [member, score] of set.entries()) {
            if (score >= min && score <= max) set.delete(member);
          }
        },
      ),
    } as unknown as RedisService,
  };
}

function createConfig(env: Record<string, string> = {}) {
  return {
    get: jest.fn((key: string) => env[key]),
  } as unknown as ConfigService;
}

describe("AdventureCircuitBreaker", () => {
  let errorSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  let fakeNow = 1_700_000_000_000;

  beforeEach(() => {
    errorSpy = jest.spyOn(Logger.prototype, "error").mockReturnValue(undefined);
    warnSpy = jest.spyOn(Logger.prototype, "warn").mockReturnValue(undefined);
    fakeNow = 1_700_000_000_000;
    jest.spyOn(Date, "now").mockImplementation(() => fakeNow);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function build(env: Record<string, string> = {}) {
    const fake = createFakeRedis();
    const breaker = new AdventureCircuitBreaker(
      fake.service,
      createConfig(env),
    );
    return { breaker, fake };
  }

  describe("计数与熔断", () => {
    it("窗口内失败未达阈值时不熔断、不写标记、不告警", async () => {
      const { breaker, fake } = build();
      for (let i = 0; i < 4; i++) {
        fakeNow += 1000;
        const result = await breaker.recordFailure(`reason-${i}`);
        expect(result.tripped).toBe(false);
      }
      const state = await breaker.getState();
      expect(state.tripped).toBe(false);
      expect(state.failureCount).toBe(4);
      expect(fake.strings.has(ADVENTURE_BREAKER_KEYS.tripped)).toBe(false);
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it("窗口内失败达到阈值即熔断，写下带 TTL 的标记并打出固定告警标记", async () => {
      const { breaker, fake } = build();
      let last = { tripped: false, failureCount: 0 };
      for (let i = 0; i < 5; i++) {
        fakeNow += 1000;
        last = await breaker.recordFailure(`boom-${i}`);
      }
      expect(last.tripped).toBe(true);
      expect(last.failureCount).toBe(5);

      const raw = fake.strings.get(ADVENTURE_BREAKER_KEYS.tripped);
      expect(raw).toBeDefined();
      expect(fake.ttls.get(ADVENTURE_BREAKER_KEYS.tripped)).toBe(3600);
      const parsed = JSON.parse(raw as string);
      expect(parsed.count).toBe(5);
      expect(parsed.trippedAt).toBeTruthy();
      expect(parsed.reasons).toContain("boom-4");

      const message = String(errorSpy.mock.calls[0][0]);
      expect(message).toContain(ADVENTURE_BREAKER_TRIPPED_MARKER);

      const state = await breaker.getState();
      expect(state.tripped).toBe(true);
      expect(state.trippedAt).toBeTruthy();
    });

    it("已熔断后继续失败只累加计数，不重复写标记也不重复告警", async () => {
      const { breaker, fake } = build();
      for (let i = 0; i < 5; i++) {
        fakeNow += 1000;
        await breaker.recordFailure(`boom-${i}`);
      }
      expect(fake.service.setValue).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledTimes(1);

      fakeNow += 1000;
      const again = await breaker.recordFailure("boom-5");
      expect(again.tripped).toBe(true);
      expect(again.failureCount).toBe(6);
      expect(fake.service.setValue).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledTimes(1);
    });

    it("窗口外的旧失败被清掉，不再计入阈值", async () => {
      const { breaker } = build({ ADVENTURE_BREAKER_WINDOW_MS: "10000" });
      await breaker.recordFailure("old-1");
      await breaker.recordFailure("old-2");
      // 跳出 10s 窗口
      fakeNow += 60_000;
      await breaker.recordFailure("new-1");
      const state = await breaker.getState();
      expect(state.failureCount).toBe(1);
      expect(state.tripped).toBe(false);
    });

    it("阈值可被环境变量下调", async () => {
      const { breaker } = build({ ADVENTURE_BREAKER_THRESHOLD: "2" });
      await breaker.recordFailure("a");
      const second = await breaker.recordFailure("b");
      expect(second.tripped).toBe(true);
    });

    it("非法的环境变量值回落默认阈值，不会因为写错配置就永久熔断或永不熔断", async () => {
      const { breaker } = build({
        ADVENTURE_BREAKER_THRESHOLD: "not-a-number",
        ADVENTURE_BREAKER_WINDOW_MS: "",
      });
      const state = await breaker.getState();
      expect(state.threshold).toBe(5);
      expect(state.windowMs).toBe(600_000);
    });
  });

  describe("Redis 不可用时绝不熔断", () => {
    function buildBrokenRedis() {
      const fake = createFakeRedis();
      const broken = {
        getValue: jest.fn(async () => {
          throw new Error("redis down");
        }),
        setValue: fake.service.setValue,
        deleteValue: fake.service.deleteValue,
        zAdd: jest.fn(async () => {
          throw new Error("redis down");
        }),
        zRangeByScoreWithScores: fake.service.zRangeByScoreWithScores,
        zRemRangeByScore: fake.service.zRemRangeByScore,
      } as unknown as RedisService;
      return {
        breaker: new AdventureCircuitBreaker(broken, createConfig()),
        fake,
      };
    }

    it("recordFailure 不向上抛，也不把系统判成熔断（熔断只是观测面）", async () => {
      const { breaker } = buildBrokenRedis();
      for (let i = 0; i < 20; i++) {
        await expect(breaker.recordFailure("boom")).resolves.toEqual({
          enabled: true,
          tripped: false,
          failureCount: 0,
          degraded: true,
        });
      }
      expect(warnSpy).toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it("getState 返回 degraded 而不是抛错，dashboard 仍能读出面板", async () => {
      const { breaker } = buildBrokenRedis();
      const state = await breaker.getState();
      expect(state.degraded).toBe(true);
      expect(state.tripped).toBe(false);
      expect(state.error).toContain("redis down");
    });
  });

  describe("总开关", () => {
    it("enabled=false 时 recordFailure 短路，完全不碰 Redis", async () => {
      const { breaker, fake } = build({ ADVENTURE_RECOVERY_ENABLED: "false" });
      const result = await breaker.recordFailure("boom");
      expect(result).toEqual({
        enabled: false,
        tripped: false,
        failureCount: 0,
        degraded: false,
      });
      expect(fake.service.zAdd).not.toHaveBeenCalled();
      expect(fake.service.setValue).not.toHaveBeenCalled();
    });

    it("enabled=false 时 getState 报告关闭状态，仍给出阈值供面板展示", async () => {
      const { breaker } = build({ ADVENTURE_RECOVERY_ENABLED: "false" });
      const state = await breaker.getState();
      expect(state.enabled).toBe(false);
      expect(state.tripped).toBe(false);
      expect(state.threshold).toBe(5);
    });
  });

  describe("recentReasons 与 reset", () => {
    it("getState 按时间升序返回最近的失败原因，最多 10 条", async () => {
      const { breaker } = build();
      for (let i = 0; i < 12; i++) {
        fakeNow += 1000;
        await breaker.recordFailure(`reason-${i}`);
      }
      const state = await breaker.getState();
      expect(state.recentReasons).toHaveLength(10);
      expect(state.recentReasons[0]).toBe("reason-2");
      expect(state.recentReasons[9]).toBe("reason-11");
      expect(state.failureCount).toBe(12);
    });

    it("原因里的换行与分隔符被压平，不会破坏 member 解析", async () => {
      const { breaker } = build();
      await breaker.recordFailure("line1\nline2|pipe");
      const state = await breaker.getState();
      expect(state.recentReasons[0]).toBe("line1 line2 pipe");
    });

    it("reset 清掉窗口与熔断标记", async () => {
      const { breaker, fake } = build();
      for (let i = 0; i < 5; i++) {
        fakeNow += 1000;
        await breaker.recordFailure("boom");
      }
      expect((await breaker.getState()).tripped).toBe(true);
      await breaker.reset();
      expect(fake.service.deleteValue).toHaveBeenCalledWith(
        ADVENTURE_BREAKER_KEYS.tripped,
      );
      expect(fake.service.deleteValue).toHaveBeenCalledWith(
        ADVENTURE_BREAKER_KEYS.window,
      );
      expect(fake.strings.has(ADVENTURE_BREAKER_KEYS.tripped)).toBe(false);
      const after = await breaker.getState();
      expect(after.tripped).toBe(false);
      expect(after.failureCount).toBe(0);
    });

    it("熔断标记过期后，窗口内仍超阈值会重新熔断并再次告警", async () => {
      const { breaker, fake } = build();
      for (let i = 0; i < 5; i++) {
        fakeNow += 1000;
        await breaker.recordFailure("boom");
      }
      expect(errorSpy).toHaveBeenCalledTimes(1);
      // 模拟 TTL 到期
      fake.strings.delete(ADVENTURE_BREAKER_KEYS.tripped);
      fakeNow += 1000;
      const result = await breaker.recordFailure("boom-again");
      expect(result.tripped).toBe(true);
      expect(errorSpy).toHaveBeenCalledTimes(2);
    });
  });
});
