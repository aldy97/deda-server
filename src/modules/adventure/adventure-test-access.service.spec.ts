import { ConfigService } from "@nestjs/config";
import { RedisService } from "@/common/redis/redis.service";
import {
  AdventureTestAccessService,
  AdventureTestSession,
} from "./adventure-test-access.service";
import {
  ADVENTURE_TEST_DEFAULTS,
  ADVENTURE_TEST_ENV,
  ADVENTURE_TEST_TRIGGER_PREFIX,
} from "./adventure.constants";

/**
 * 内存版 RedisService 替身：如实复刻真实 RedisService 内存模式的 TTL 过期语义
 * （getValue 读到过期键时返回 null 并删除），zset 按 score 区间过滤——
 * 试播会话的「TTL 到期自动失效」必须由替身反映出来，否则单测绿而真库上过期会话
 * 仍被当作用户有效的武装态。
 */
function createFakeRedis() {
  const strings = new Map<
    string,
    { value: string; expiresAt: number | null }
  >();
  const zsets = new Map<string, Map<string, number>>();
  return {
    strings,
    zsets,
    service: {
      getValue: jest.fn(async (key: string) => {
        const item = strings.get(key);
        if (!item) return null;
        if (item.expiresAt !== null && Date.now() > item.expiresAt) {
          strings.delete(key);
          return null;
        }
        return item.value;
      }),
      setValue: jest.fn(
        async (key: string, value: string, ttlSeconds?: number) => {
          strings.set(key, {
            value,
            expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null,
          });
        },
      ),
      deleteValue: jest.fn(async (key: string) => {
        strings.delete(key);
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

describe("AdventureTestAccessService", () => {
  let service: AdventureTestAccessService;
  let fakeRedis: ReturnType<typeof createFakeRedis>;
  let fakeNow = 1_700_000_000_000;

  const armInput = {
    episodeId: "ep1",
    episodeVersionId: null,
    title: "听风原野第一天",
    source: "voice_trigger" as const,
  };

  beforeEach(() => {
    fakeNow = 1_700_000_000_000;
    jest.spyOn(Date, "now").mockImplementation(() => fakeNow);
    fakeRedis = createFakeRedis();
    service = new AdventureTestAccessService(fakeRedis.service, createConfig());
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("environment gate", () => {
    it("is disabled when the env var is unset", () => {
      expect(service.isEnabled()).toBe(false);
    });

    it("is disabled when the env var is misspelled or not literally true", () => {
      service = new AdventureTestAccessService(
        fakeRedis.service,
        createConfig({ [ADVENTURE_TEST_ENV.enabled]: "TRUE" }),
      );
      expect(service.isEnabled()).toBe(false);
      service = new AdventureTestAccessService(
        fakeRedis.service,
        createConfig({ [ADVENTURE_TEST_ENV.enabled]: "1" }),
      );
      expect(service.isEnabled()).toBe(false);
    });

    it("is enabled only for the literal string true", () => {
      service = new AdventureTestAccessService(
        fakeRedis.service,
        createConfig({ [ADVENTURE_TEST_ENV.enabled]: "true" }),
      );
      expect(service.isEnabled()).toBe(true);
    });

    it("never touches redis while disabled", async () => {
      expect(await service.peek("dev-1")).toBeNull();
      expect(
        await service.arm("dev-1", { ...armInput, source: "admin_api" }),
      ).toBeNull();
      expect(await service.listArmed()).toEqual([]);
      expect(fakeRedis.service.getValue).not.toHaveBeenCalled();
      expect(fakeRedis.service.setValue).not.toHaveBeenCalled();
    });
  });

  describe("trigger matching", () => {
    beforeEach(() => {
      service = new AdventureTestAccessService(
        fakeRedis.service,
        createConfig({ [ADVENTURE_TEST_ENV.enabled]: "true" }),
      );
    });

    it("returns the title after the prefix", () => {
      expect(
        service.matchTrigger(`${ADVENTURE_TEST_TRIGGER_PREFIX}Elly与三个巨人`),
      ).toBe("Elly与三个巨人");
    });

    it("trims surrounding whitespace from both the text and the title", () => {
      expect(
        service.matchTrigger(
          `  ${ADVENTURE_TEST_TRIGGER_PREFIX} Elly与三个巨人  `,
        ),
      ).toBe("Elly与三个巨人");
    });

    it("returns null when the prefix is missing or the title is empty", () => {
      expect(service.matchTrigger("我想听故事")).toBeNull();
      expect(
        service.matchTrigger(` ${ADVENTURE_TEST_TRIGGER_PREFIX} `),
      ).toBeNull();
      expect(service.matchTrigger("")).toBeNull();
      expect(service.matchTrigger(null)).toBeNull();
      expect(service.matchTrigger(undefined)).toBeNull();
    });

    it("returns null while disabled even when the text matches", () => {
      service = new AdventureTestAccessService(
        fakeRedis.service,
        createConfig(),
      );
      expect(
        service.matchTrigger(`${ADVENTURE_TEST_TRIGGER_PREFIX}Elly与三个巨人`),
      ).toBeNull();
    });
  });

  describe("arm / peek / clear", () => {
    beforeEach(() => {
      service = new AdventureTestAccessService(
        fakeRedis.service,
        createConfig({ [ADVENTURE_TEST_ENV.enabled]: "true" }),
      );
    });

    it("round-trips a session through redis", async () => {
      const session = await service.arm("dev-1", armInput);
      expect(session).not.toBeNull();
      const peeked = await service.peek("dev-1");
      expect(peeked).toEqual(session);
      expect(peeked?.episodeId).toBe("ep1");
      expect(peeked?.title).toBe("听风原野第一天");
      expect(peeked?.source).toBe("voice_trigger");
      expect(peeked?.runSeq).toBe(1);
      expect(peeked?.armedAt).toBe(new Date(fakeNow).toISOString());
    });

    it("applies the default TTL to the stored session", async () => {
      await service.arm("dev-1", armInput);
      expect(fakeRedis.service.setValue).toHaveBeenCalledWith(
        expect.stringContaining("adventure:test:session:dev-1"),
        expect.any(String),
        ADVENTURE_TEST_DEFAULTS.sessionTtlMinutes * 60,
      );
    });

    it("increments runSeq on every arm so event keys stay unique", async () => {
      const first = await service.arm("dev-1", armInput);
      const second = await service.arm("dev-1", armInput);
      expect(first?.runSeq).toBe(1);
      expect(second?.runSeq).toBe(2);
    });

    it("expires a session once the TTL has passed", async () => {
      await service.arm("dev-1", armInput);
      fakeNow += ADVENTURE_TEST_DEFAULTS.sessionTtlMinutes * 60_000 + 1;
      expect(await service.peek("dev-1")).toBeNull();
    });

    it("clears a session idempotently", async () => {
      await service.arm("dev-1", armInput);
      await service.clear("dev-1");
      await service.clear("dev-1");
      expect(await service.peek("dev-1")).toBeNull();
    });

    it("returns null for corrupt stored payloads instead of throwing", async () => {
      fakeRedis.strings.set("adventure:test:session:dev-1", {
        value: "{not-json",
        expiresAt: null,
      });
      expect(await service.peek("dev-1")).toBeNull();
    });
  });

  describe("listArmed", () => {
    beforeEach(() => {
      service = new AdventureTestAccessService(
        fakeRedis.service,
        createConfig({ [ADVENTURE_TEST_ENV.enabled]: "true" }),
      );
    });

    it("lists sessions for all armed devices", async () => {
      await service.arm("dev-1", armInput);
      await service.arm("dev-2", {
        ...armInput,
        episodeId: "ep2",
        source: "admin_api",
        armedBy: "alice",
      });
      const sessions = await service.listArmed();
      expect(sessions).toHaveLength(2);
      expect(
        sessions.map((s: AdventureTestSession) => s.deviceInternalId).sort(),
      ).toEqual(["dev-1", "dev-2"]);
    });

    it("filters out expired sessions from the index", async () => {
      await service.arm("dev-1", armInput);
      fakeNow += ADVENTURE_TEST_DEFAULTS.sessionTtlMinutes * 60_000 + 1;
      await service.arm("dev-2", armInput);
      const sessions = await service.listArmed();
      expect(
        sessions.map((s: AdventureTestSession) => s.deviceInternalId),
      ).toEqual(["dev-2"]);
    });

    it("returns an empty list while disabled", async () => {
      service = new AdventureTestAccessService(
        fakeRedis.service,
        createConfig(),
      );
      expect(await service.listArmed()).toEqual([]);
    });
  });
});
