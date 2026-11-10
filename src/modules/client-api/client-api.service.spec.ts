import { Test, TestingModule } from "@nestjs/testing";
import {
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ClientApiService } from "./client-api.service";
import { PrismaService } from "@/common/prisma/prisma.service";
import { RedisService } from "@/common/redis/redis.service";
import {
  BOT_INSTANCE_TTL_SECONDS,
  DEFAULT_PROVISION_WINDOW_SECONDS,
  PROVISION_RECENT_KEY,
  botCurrentKey,
  botInstanceKey,
} from "./client-api.constants";

const TEST_MAC_KEY = "test-mac-key";
const TEST_LLM_API_KEY = "test-llm-api-key";
const MAC = "aabbccddeeff";
// 黄金值：md5_ascii(md5_utf8(TEST_MAC_KEY + MAC).hexdigest()).hexdigest()
const GOLDEN_PASSWORD = "84080871e18d02315d66c72e07bcaf45";

describe("ClientApiService", () => {
  let service: ClientApiService;
  let prisma: { device: { upsert: jest.Mock; findUnique: jest.Mock } };
  let redisStore: Map<string, string>;
  let redis: {
    getValue: jest.Mock;
    setValue: jest.Mock;
    zAdd: jest.Mock;
    zRemRangeByScore: jest.Mock;
  };
  let configValues: Record<string, string | undefined>;

  const createService = async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ClientApiService,
        {
          provide: ConfigService,
          useValue: { get: (key: string) => configValues[key] },
        },
        { provide: PrismaService, useValue: prisma },
        { provide: RedisService, useValue: redis },
      ],
    }).compile();
    return module.get(ClientApiService);
  };

  beforeEach(async () => {
    prisma = {
      device: {
        upsert: jest.fn().mockResolvedValue({ id: "device-uuid-1" }),
        findUnique: jest.fn().mockResolvedValue({ id: "device-uuid-1" }),
      },
    };
    redisStore = new Map();
    redis = {
      getValue: jest
        .fn()
        .mockImplementation(async (key: string) => redisStore.get(key) ?? null),
      setValue: jest
        .fn()
        .mockImplementation(async (key: string, value: string) => {
          redisStore.set(key, value);
        }),
      zAdd: jest.fn().mockResolvedValue(undefined),
      zRemRangeByScore: jest.fn().mockResolvedValue(undefined),
    };
    configValues = {
      DEVICE_LOGIN_MAC_KEY: TEST_MAC_KEY,
      LLM_ADAPTER_API_KEY: TEST_LLM_API_KEY,
    };
    service = await createService();
  });

  describe("loginMac", () => {
    it("upserts device, records provision window and returns api key", async () => {
      const result = await service.loginMac({
        mac: MAC,
        password: GOLDEN_PASSWORD,
      });

      expect(result).toEqual({ mac: MAC, apiKey: TEST_LLM_API_KEY });
      expect(prisma.device.upsert).toHaveBeenCalledWith({
        where: { deviceId: MAC },
        create: { deviceId: MAC, macAddress: MAC },
        update: { macAddress: MAC },
      });
      expect(redis.zAdd).toHaveBeenCalledWith(
        PROVISION_RECENT_KEY,
        expect.any(Number),
        MAC,
      );
      expect(redis.zRemRangeByScore).toHaveBeenCalledWith(
        PROVISION_RECENT_KEY,
        0,
        expect.any(Number),
      );
    });

    it("normalizes mac with separators and uppercase before verifying", async () => {
      const result = await service.loginMac({
        mac: "AA:BB:CC:DD:EE:FF",
        password: GOLDEN_PASSWORD,
      });
      expect(result.mac).toBe(MAC);
      expect(prisma.device.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ where: { deviceId: MAC } }),
      );
    });

    it("rejects wrong password with 401 and does not upsert", async () => {
      await expect(
        service.loginMac({ mac: MAC, password: "0".repeat(32) }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(prisma.device.upsert).not.toHaveBeenCalled();
    });

    it("rejects with 401 when mac key is not configured", async () => {
      delete configValues.DEVICE_LOGIN_MAC_KEY;
      service = await createService();
      await expect(
        service.loginMac({ mac: MAC, password: GOLDEN_PASSWORD }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(prisma.device.upsert).not.toHaveBeenCalled();
    });

    it("fails with 500 when llm api key is not configured", async () => {
      delete configValues.LLM_ADAPTER_API_KEY;
      service = await createService();
      await expect(
        service.loginMac({ mac: MAC, password: GOLDEN_PASSWORD }),
      ).rejects.toBeInstanceOf(InternalServerErrorException);
      expect(prisma.device.upsert).not.toHaveBeenCalled();
    });

    it("rejects malformed mac with 400", async () => {
      await expect(
        service.loginMac({ mac: "not-a-mac", password: GOLDEN_PASSWORD }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.device.upsert).not.toHaveBeenCalled();
    });

    it("is idempotent for repeated online reports", async () => {
      await service.loginMac({ mac: MAC, password: GOLDEN_PASSWORD });
      await service.loginMac({ mac: MAC, password: GOLDEN_PASSWORD });
      expect(prisma.device.upsert).toHaveBeenCalledTimes(2);
      expect(redis.zAdd).toHaveBeenCalledTimes(2);
    });
  });

  describe("botStart", () => {
    const startDto = {
      mac: MAC,
      appid: "baidu-app-1",
      instanceid: "9223372036854775806",
      authorization: "baidu-control-auth",
    };

    it("rejects with 401 when device has not logged in", async () => {
      prisma.device.findUnique.mockResolvedValue(null);
      await expect(service.botStart(startDto)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it("registers a new instance as current", async () => {
      await service.botStart(startDto);
      const key = botInstanceKey(MAC, startDto.instanceid);
      const record = JSON.parse(redisStore.get(key) ?? "{}");
      expect(record).toMatchObject({
        instanceid: startDto.instanceid,
        appid: startDto.appid,
        authorization: startDto.authorization,
        cloudNode: "cn",
        lang: "zh",
        status: "active",
      });
      expect(redis.setValue).toHaveBeenCalledWith(
        key,
        expect.any(String),
        BOT_INSTANCE_TTL_SECONDS,
      );
      expect(redisStore.get(botCurrentKey(MAC))).toBe(startDto.instanceid);
    });

    it("is idempotent for the same instance and refreshes authorization", async () => {
      await service.botStart(startDto);
      await service.botStart({ ...startDto, authorization: "rotated-auth" });
      const record = JSON.parse(
        redisStore.get(botInstanceKey(MAC, startDto.instanceid)) ?? "{}",
      );
      expect(record.authorization).toBe("rotated-auth");
      expect(record.status).toBe("active");
    });

    it("returns 409 when reviving an ended instance", async () => {
      await service.botStart(startDto);
      await service.botStop({
        mac: MAC,
        instanceid: startDto.instanceid,
      });
      await expect(service.botStart(startDto)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it("switches current instance when a new one starts", async () => {
      await service.botStart(startDto);
      await service.botStart({ ...startDto, instanceid: "111" });
      expect(redisStore.get(botCurrentKey(MAC))).toBe("111");
    });
  });

  describe("botStop", () => {
    const startDto = {
      mac: MAC,
      appid: "baidu-app-1",
      instanceid: "9223372036854775806",
      authorization: "baidu-control-auth",
    };

    it("rejects with 401 when device has not logged in", async () => {
      prisma.device.findUnique.mockResolvedValue(null);
      await expect(
        service.botStop({ mac: MAC, instanceid: startDto.instanceid }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it("returns 404 for unknown instance", async () => {
      await expect(
        service.botStop({ mac: MAC, instanceid: "123" }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("ends instance and clears authorization", async () => {
      await service.botStart(startDto);
      await service.botStop({ mac: MAC, instanceid: startDto.instanceid });
      const record = JSON.parse(
        redisStore.get(botInstanceKey(MAC, startDto.instanceid)) ?? "{}",
      );
      expect(record.status).toBe("ended");
      expect(record.authorization).toBeUndefined();
      expect(record.endedAt).toBeDefined();
    });

    it("is idempotent for repeated stop", async () => {
      await service.botStart(startDto);
      await service.botStop({ mac: MAC, instanceid: startDto.instanceid });
      await expect(
        service.botStop({ mac: MAC, instanceid: startDto.instanceid }),
      ).resolves.toBeUndefined();
    });

    it("stopping an old instance does not clear the new current one", async () => {
      await service.botStart(startDto);
      await service.botStart({ ...startDto, instanceid: "222" });
      await service.botStop({ mac: MAC, instanceid: startDto.instanceid });
      expect(redisStore.get(botCurrentKey(MAC))).toBe("222");
    });
  });

  describe("provision window", () => {
    it("honours PROVISION_CLAIM_WINDOW_SEC when configured", async () => {
      configValues.PROVISION_CLAIM_WINDOW_SEC = "30";
      service = await createService();
      const before = Date.now();
      await service.loginMac({ mac: MAC, password: GOLDEN_PASSWORD });
      const cutoff = redis.zRemRangeByScore.mock.calls[0][2] as number;
      expect(cutoff).toBeGreaterThanOrEqual(before - 30_000);
      expect(cutoff).toBeLessThanOrEqual(Date.now() - 30_000);
    });

    it("falls back to the default window for invalid env values", async () => {
      configValues.PROVISION_CLAIM_WINDOW_SEC = "not-a-number";
      service = await createService();
      const before = Date.now();
      await service.loginMac({ mac: MAC, password: GOLDEN_PASSWORD });
      const cutoff = redis.zRemRangeByScore.mock.calls[0][2] as number;
      expect(cutoff).toBeGreaterThanOrEqual(
        before - DEFAULT_PROVISION_WINDOW_SECONDS * 1000,
      );
    });
  });
});
