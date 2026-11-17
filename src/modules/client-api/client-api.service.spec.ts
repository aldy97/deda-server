import { Test, TestingModule } from "@nestjs/testing";
import {
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ClientApiService } from "./client-api.service";
import { PrismaService } from "@/common/prisma/prisma.service";
import { RedisService } from "@/common/redis/redis.service";
import {
  DEVICE_DEFAULT_LANG,
  VOICE_RECONCILE_PORT,
} from "@/modules/baidu-agent/baidu-agent.types";
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
  let voiceReconcile: {
    onInstanceRegistered: jest.Mock;
    resolveInitialVoice: jest.Mock;
  };

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
        { provide: VOICE_RECONCILE_PORT, useValue: voiceReconcile },
      ],
    }).compile();
    return module.get(ClientApiService);
  };

  beforeEach(async () => {
    prisma = {
      device: {
        upsert: jest
          .fn()
          .mockResolvedValue({ id: "device-uuid-1", characterKey: "elly" }),
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
    voiceReconcile = {
      onInstanceRegistered: jest.fn().mockResolvedValue({ applied: "noop" }),
      resolveInitialVoice: jest.fn().mockResolvedValue({ status: "none" }),
    };
    service = await createService();
  });

  describe("loginMac", () => {
    it("upserts device, records provision window and returns api key", async () => {
      const result = await service.loginMac({
        mac: MAC,
        password: GOLDEN_PASSWORD,
      });

      expect(result).toEqual({
        mac: MAC,
        apiKey: TEST_LLM_API_KEY,
        loginVoice: null,
      });
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

  describe("loginMac initial voice dispatch", () => {
    const login = () =>
      service.loginMac({ mac: MAC, password: GOLDEN_PASSWORD });

    it("passes the upserted device id, its characterKey and the default lang", async () => {
      await login();

      expect(voiceReconcile.resolveInitialVoice).toHaveBeenCalledWith({
        deviceInternalId: "device-uuid-1",
        characterKey: "elly",
        lang: DEVICE_DEFAULT_LANG,
      });
    });

    it("returns the ready field so the controller can spread it into data", async () => {
      voiceReconcile.resolveInitialVoice.mockResolvedValue({
        status: "ready",
        timbreId: "1000063",
        field: { key: "timbreId", value: "1000063" },
      });

      const result = await login();

      expect(result.loginVoice).toEqual({ key: "timbreId", value: "1000063" });
    });

    it("returns no field when nothing is desired", async () => {
      voiceReconcile.resolveInitialVoice.mockResolvedValue({ status: "none" });

      expect((await login()).loginVoice).toBeNull();
    });

    it("returns no field and records the reason when the resolution is blocked", async () => {
      jest.spyOn(Logger.prototype, "warn").mockImplementation();
      voiceReconcile.resolveInitialVoice.mockResolvedValue({
        status: "blocked",
        reason: "empty_catalog",
      });

      const result = await login();

      expect(result.loginVoice).toBeNull();
      expect(Logger.prototype.warn).toHaveBeenCalledWith(
        expect.stringContaining("empty_catalog"),
      );
      jest.restoreAllMocks();
    });

    it("still onboards the device when the voice resolution throws", async () => {
      voiceReconcile.resolveInitialVoice.mockRejectedValue(
        new Error("catalog exploded"),
      );

      await expect(login()).resolves.toEqual({
        mac: MAC,
        apiKey: TEST_LLM_API_KEY,
        loginVoice: null,
      });
      expect(prisma.device.upsert).toHaveBeenCalledTimes(1);
      expect(redis.zAdd).toHaveBeenCalledTimes(1);
    });

    it("does not resolve a voice when credentials are rejected", async () => {
      await expect(
        service.loginMac({ mac: MAC, password: "0".repeat(32) }),
      ).rejects.toBeInstanceOf(UnauthorizedException);

      expect(voiceReconcile.resolveInitialVoice).not.toHaveBeenCalled();
    });
  });

  describe("botStart", () => {
    const startDto = {
      mac: MAC,
      appid: "baidu-app-1",
      instanceid: "9223372036854775806",
      authorization_Role: "baidu-role-auth",
      authorization_TTS: "baidu-tts-auth",
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
        authorization_Role: startDto.authorization_Role,
        authorization_TTS: startDto.authorization_TTS,
        cloudNode: "cn",
        lang: "zh",
        status: "active",
      });
      expect(record.roleSignedAt).toBeDefined();
      expect(record.ttsSignedAt).toBeDefined();
      expect(redis.setValue).toHaveBeenCalledWith(
        key,
        expect.any(String),
        BOT_INSTANCE_TTL_SECONDS,
      );
      expect(redisStore.get(botCurrentKey(MAC))).toBe(startDto.instanceid);
    });

    it("is idempotent for the same instance and refreshes both signatures", async () => {
      await service.botStart(startDto);
      await service.botStart({
        ...startDto,
        authorization_Role: "rotated-role-auth",
        authorization_TTS: "rotated-tts-auth",
      });
      const record = JSON.parse(
        redisStore.get(botInstanceKey(MAC, startDto.instanceid)) ?? "{}",
      );
      expect(record.authorization_Role).toBe("rotated-role-auth");
      expect(record.authorization_TTS).toBe("rotated-tts-auth");
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

    it("persists v1.2 dual signatures with signedAt timestamps", async () => {
      await service.botStart(startDto);
      const key = botInstanceKey(MAC, startDto.instanceid);
      const record = JSON.parse(redisStore.get(key) ?? "{}");
      expect(record.authorization_Role).toBe("baidu-role-auth");
      expect(record.authorization_TTS).toBe("baidu-tts-auth");
      expect(record.roleSignedAt).toBeDefined();
      expect(record.ttsSignedAt).toBeDefined();
    });

    it("does not crash when authorization is undefined (v1.1 compat)", async () => {
      const v1_1Dto = {
        mac: MAC,
        appid: "baidu-app-1",
        instanceid: "9223372036854775806",
        authorization: undefined,
        authorization_Role: "role-only",
        authorization_TTS: "tts-only",
      };
      await service.botStart(v1_1Dto);
      const key = botInstanceKey(MAC, v1_1Dto.instanceid);
      const record = JSON.parse(redisStore.get(key) ?? "{}");
      expect(record.authorization).toBeUndefined();
      expect(record.authorization_Role).toBe("role-only");
      expect(record.authorization_TTS).toBe("tts-only");
    });
  });

  describe("botStart voice reconcile hook", () => {
    const startDto = {
      mac: MAC,
      appid: "baidu-app-1",
      instanceid: "9223372036854775806",
      authorization_Role: "baidu-role-auth",
      authorization_TTS: "baidu-tts-auth",
    };

    it("reconciles voice after registering a new instance", async () => {
      await service.botStart(startDto);

      expect(voiceReconcile.onInstanceRegistered).toHaveBeenCalledTimes(1);
      // 第三个参数是 bot/start 401 校验时已经查到的 Device.id，避免重复查询
      expect(voiceReconcile.onInstanceRegistered).toHaveBeenCalledWith(
        MAC,
        startDto.instanceid,
        "device-uuid-1",
      );
      expect(prisma.device.findUnique).toHaveBeenCalledTimes(1);
    });

    it("passes the normalized mac to the hook", async () => {
      await service.botStart({ ...startDto, mac: "AA:BB:CC:DD:EE:FF" });

      expect(voiceReconcile.onInstanceRegistered).toHaveBeenCalledWith(
        MAC,
        startDto.instanceid,
        "device-uuid-1",
      );
    });

    it("does not wait for the reconcile to settle before resolving (protocol 4.2 latency)", async () => {
      let release: () => void = () => undefined;
      voiceReconcile.onInstanceRegistered.mockReturnValue(
        new Promise((resolve) => {
          release = () => resolve({ applied: "live" });
        }),
      );

      // 出站调用百度云最长可阻塞 BAIDU_AGENT_TIMEOUT_MS(5000)；bot/start 必须
      // 先返回 200，否则设备会按协议 6.2 重试，把一次慢调用放大成多次。
      await expect(service.botStart(startDto)).resolves.toBeUndefined();
      expect(voiceReconcile.onInstanceRegistered).toHaveBeenCalledTimes(1);
      expect(redisStore.get(botCurrentKey(MAC))).toBe(startDto.instanceid);

      release();
    });

    it("reconciles again on a repeated start (signature refresh)", async () => {
      await service.botStart(startDto);
      await service.botStart({
        ...startDto,
        authorization_Role: "rotated-role-auth",
      });

      expect(voiceReconcile.onInstanceRegistered).toHaveBeenCalledTimes(2);
    });

    it("still resolves when the hook rejects (protocol 4.2 requires 200)", async () => {
      voiceReconcile.onInstanceRegistered.mockRejectedValue(
        new Error("redis down"),
      );

      await expect(service.botStart(startDto)).resolves.toBeUndefined();
      expect(redisStore.get(botCurrentKey(MAC))).toBe(startDto.instanceid);
    });

    it("still resolves when the hook returns a deferred outcome", async () => {
      voiceReconcile.onInstanceRegistered.mockResolvedValue({
        applied: "deferred",
        reason: "empty_catalog",
      });

      await expect(service.botStart(startDto)).resolves.toBeUndefined();
    });

    it("does not reconcile when the device has not logged in", async () => {
      prisma.device.findUnique.mockResolvedValue(null);

      await expect(service.botStart(startDto)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(voiceReconcile.onInstanceRegistered).not.toHaveBeenCalled();
    });

    it("does not reconcile when reviving an ended instance", async () => {
      await service.botStart(startDto);
      await service.botStop({ mac: MAC, instanceid: startDto.instanceid });
      voiceReconcile.onInstanceRegistered.mockClear();

      await expect(service.botStart(startDto)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(voiceReconcile.onInstanceRegistered).not.toHaveBeenCalled();
    });
  });

  describe("botStop", () => {
    const startDto = {
      mac: MAC,
      appid: "baidu-app-1",
      instanceid: "9223372036854775806",
      authorization_Role: "baidu-role-auth",
      authorization_TTS: "baidu-tts-auth",
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

    it("ends instance and clears both signatures", async () => {
      await service.botStart(startDto);
      await service.botStop({ mac: MAC, instanceid: startDto.instanceid });
      const record = JSON.parse(
        redisStore.get(botInstanceKey(MAC, startDto.instanceid)) ?? "{}",
      );
      expect(record.status).toBe("ended");
      expect(record.authorization).toBeUndefined();
      expect(record.authorization_Role).toBeUndefined();
      expect(record.authorization_TTS).toBeUndefined();
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
