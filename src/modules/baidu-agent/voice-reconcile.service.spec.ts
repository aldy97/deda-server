import { Test, TestingModule } from "@nestjs/testing";
import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "@/common/prisma/prisma.service";
import { RedisService } from "@/common/redis/redis.service";
import {
  VOICE_CATALOG_PORT,
  BAIDU_AGENT_CLIENT_PORT,
  CHARACTER_TIMBRE_PORT,
  VOICE_PAYLOAD_KEY,
} from "./baidu-agent.types";
import { VoiceReconcileService } from "./voice-reconcile.service";
import {
  botCurrentKey,
  botInstanceKey,
} from "../client-api/client-api.constants";

// buildTtsConfig 被 mock：本 spec 只验证编排，tts 串的组装由 tts-config.util.spec.ts 覆盖
jest.mock("./tts-config.util", () => ({
  buildTtsConfig: jest.fn(),
}));

import { buildTtsConfig } from "./tts-config.util";

const MAC = "aabbccddeeff";
const INSTANCE_ID = "1234567890123456789";
const DEVICE_UUID = "device-uuid-001";

const buildBotInstanceRecord = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    instanceid: INSTANCE_ID,
    appid: "app-001",
    authorization_Role: "bce-auth-v1/.../role-sig",
    authorization_TTS: "bce-auth-v1/.../tts-sig",
    roleSignedAt: "2026-01-01T00:00:00Z",
    ttsSignedAt: "2026-01-01T00:00:00Z",
    cloudNode: "cn",
    lang: "zh",
    status: "active",
    startedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  });

describe("VoiceReconcileService", () => {
  let service: VoiceReconcileService;
  let prisma: {
    device: { findUnique: jest.Mock };
    deviceConfig: { findFirst: jest.Mock };
    voiceSpeedConfig: { findUnique: jest.Mock };
  };
  let redis: { getValue: jest.Mock };
  let configValues: Record<string, string | undefined>;
  let mockCatalog: {
    listUsable: jest.Mock;
    listForLang: jest.Mock;
    find: jest.Mock;
    available: boolean;
  };
  let mockClient: {
    enabled: boolean;
    switchSceneRole: jest.Mock;
    interrupt: jest.Mock;
  };
  let characterTimbre: { get: jest.Mock };

  const createService = async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VoiceReconcileService,
        { provide: PrismaService, useValue: prisma },
        { provide: RedisService, useValue: redis },
        {
          provide: ConfigService,
          useValue: { get: (key: string) => configValues[key] },
        },
        { provide: VOICE_CATALOG_PORT, useValue: mockCatalog },
        { provide: BAIDU_AGENT_CLIENT_PORT, useValue: mockClient },
        { provide: CHARACTER_TIMBRE_PORT, useValue: characterTimbre },
      ],
    }).compile();
    return module.get(VoiceReconcileService);
  };

  beforeEach(async () => {
    prisma = {
      device: { findUnique: jest.fn().mockResolvedValue(null) },
      deviceConfig: { findFirst: jest.fn().mockResolvedValue(null) },
      voiceSpeedConfig: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    redis = { getValue: jest.fn().mockResolvedValue(null) };
    configValues = {};
    mockCatalog = {
      listUsable: jest.fn().mockReturnValue([]),
      listForLang: jest.fn().mockReturnValue([]),
      find: jest.fn().mockReturnValue(null),
      available: false,
    };
    mockClient = {
      enabled: true,
      switchSceneRole: jest.fn().mockResolvedValue({ ok: true } as const),
      interrupt: jest.fn(),
    };
    characterTimbre = { get: jest.fn().mockResolvedValue(null) };

    jest.clearAllMocks();
    service = await createService();
  });

  // ==========================================================================
  // resolveNormalSpd / resolveSleepSpd
  // ==========================================================================
  describe("resolveNormalSpd / resolveSleepSpd", () => {
    it("should return the stored normal spd", async () => {
      prisma.voiceSpeedConfig.findUnique.mockResolvedValue({
        normalSpd: 0.8,
        sleepSpd: 0.5,
      });
      await expect(service.resolveNormalSpd()).resolves.toBe(0.8);
    });

    it("should return the stored sleep spd", async () => {
      prisma.voiceSpeedConfig.findUnique.mockResolvedValue({
        normalSpd: 0.7,
        sleepSpd: 0.6,
      });
      await expect(service.resolveSleepSpd()).resolves.toBe(0.6);
    });

    it("should fall back to default when the row is missing", async () => {
      prisma.voiceSpeedConfig.findUnique.mockResolvedValue(null);
      await expect(service.resolveNormalSpd()).resolves.toBe(0.7);
      await expect(service.resolveSleepSpd()).resolves.toBe(0.5);
    });

    it("should fall back to default when normal spd is below TTS_SPD_MIN", async () => {
      prisma.voiceSpeedConfig.findUnique.mockResolvedValue({
        normalSpd: 0.3,
        sleepSpd: 0.5,
      });
      await expect(service.resolveNormalSpd()).resolves.toBe(0.7);
    });

    it("should fall back to default when sleep spd is above TTS_SPD_MAX", async () => {
      prisma.voiceSpeedConfig.findUnique.mockResolvedValue({
        normalSpd: 0.7,
        sleepSpd: 2.5,
      });
      await expect(service.resolveSleepSpd()).resolves.toBe(0.5);
    });

    it("should accept boundary values", async () => {
      prisma.voiceSpeedConfig.findUnique.mockResolvedValue({
        normalSpd: 0.5,
        sleepSpd: 2,
      });
      await expect(service.resolveNormalSpd()).resolves.toBe(0.5);
      await expect(service.resolveSleepSpd()).resolves.toBe(2);
    });
  });

  // ==========================================================================
  // readDesired
  // ==========================================================================
  describe("readDesired", () => {
    it("should return null vcn and speechRate when no active config exists", async () => {
      prisma.deviceConfig.findFirst.mockResolvedValue(null);

      const result = await service.readDesired(DEVICE_UUID);
      expect(result).toEqual({ vcn: null, speechRate: null });
    });

    it("should return vcn from payload.voice when active config exists", async () => {
      prisma.deviceConfig.findFirst.mockResolvedValue({
        speechRate: "normal",
        payload: { [VOICE_PAYLOAD_KEY]: { vcn: "1000063" } },
      });

      const result = await service.readDesired(DEVICE_UUID);
      expect(result).toEqual({ vcn: "1000063", speechRate: "normal" });
    });

    it("should return null vcn when payload.voice is missing", async () => {
      prisma.deviceConfig.findFirst.mockResolvedValue({
        speechRate: "fast",
        payload: {},
      });

      const result = await service.readDesired(DEVICE_UUID);
      expect(result).toEqual({ vcn: null, speechRate: "fast" });
    });

    it("should return null vcn when payload is null", async () => {
      prisma.deviceConfig.findFirst.mockResolvedValue({
        speechRate: "slow",
        payload: null,
      });

      const result = await service.readDesired(DEVICE_UUID);
      expect(result).toEqual({ vcn: null, speechRate: "slow" });
    });

    it("should return null speechRate when config has null speechRate", async () => {
      prisma.deviceConfig.findFirst.mockResolvedValue({
        speechRate: null,
        payload: { [VOICE_PAYLOAD_KEY]: { vcn: "1000063" } },
      });

      const result = await service.readDesired(DEVICE_UUID);
      expect(result).toEqual({ vcn: "1000063", speechRate: null });
    });

    it("should query latest active config by createdAt desc", async () => {
      prisma.deviceConfig.findFirst.mockResolvedValue({
        speechRate: "normal",
        payload: null,
      });

      await service.readDesired(DEVICE_UUID);

      expect(prisma.deviceConfig.findFirst).toHaveBeenCalledWith({
        where: { deviceId: DEVICE_UUID, isActive: true },
        orderBy: { createdAt: "desc" },
      });
    });
  });

  // ==========================================================================
  // applyToActiveInstance decision tree
  // ==========================================================================
  describe("applyToActiveInstance", () => {
    const setupActiveInstance = () => {
      redis.getValue
        .mockResolvedValueOnce(INSTANCE_ID) // botCurrentKey
        .mockResolvedValueOnce(buildBotInstanceRecord()); // botInstanceKey
    };

    describe("step 1: both null → noop", () => {
      it("should return noop", async () => {
        const result = await service.applyToActiveInstance(MAC, {
          vcn: null,
          speechRate: null,
        });
        expect(result).toEqual({ applied: "noop" });
        expect(mockClient.switchSceneRole).not.toHaveBeenCalled();
      });
    });

    describe("step 2: client disabled", () => {
      it("should return disabled deferred", async () => {
        mockClient.enabled = false;
        const result = await service.applyToActiveInstance(MAC, {
          vcn: "1000063",
          speechRate: null,
        });
        expect(result).toEqual({ applied: "deferred", reason: "disabled" });
        expect(mockClient.switchSceneRole).not.toHaveBeenCalled();
      });
    });

    describe("step 3: no current instance (botCurrentKey null)", () => {
      it("should return no_active_instance deferred", async () => {
        redis.getValue.mockResolvedValue(null);
        const result = await service.applyToActiveInstance(MAC, {
          vcn: "1000063",
          speechRate: null,
        });
        expect(result).toEqual({
          applied: "deferred",
          reason: "no_active_instance",
        });
        expect(mockClient.switchSceneRole).not.toHaveBeenCalled();
        expect(redis.getValue).toHaveBeenCalledWith(botCurrentKey(MAC));
      });
    });

    describe("step 4: instance record not found", () => {
      it("should return no_active_instance deferred", async () => {
        redis.getValue
          .mockResolvedValueOnce(INSTANCE_ID) // botCurrentKey
          .mockResolvedValueOnce(null); // botInstanceKey
        const result = await service.applyToActiveInstance(MAC, {
          vcn: "1000063",
          speechRate: null,
        });
        expect(result).toEqual({
          applied: "deferred",
          reason: "no_active_instance",
        });
        expect(mockClient.switchSceneRole).not.toHaveBeenCalled();
      });
    });

    describe("step 4b: instance record JSON parse failure", () => {
      it("should return no_active_instance deferred", async () => {
        redis.getValue
          .mockResolvedValueOnce(INSTANCE_ID)
          .mockResolvedValueOnce("not json");
        const result = await service.applyToActiveInstance(MAC, {
          vcn: "1000063",
          speechRate: null,
        });
        expect(result).toEqual({
          applied: "deferred",
          reason: "no_active_instance",
        });
        expect(mockClient.switchSceneRole).not.toHaveBeenCalled();
      });
    });

    describe("step 5: instance status not active", () => {
      it("should return no_active_instance deferred", async () => {
        redis.getValue
          .mockResolvedValueOnce(INSTANCE_ID)
          .mockResolvedValueOnce(buildBotInstanceRecord({ status: "ended" }));
        const result = await service.applyToActiveInstance(MAC, {
          vcn: "1000063",
          speechRate: null,
        });
        expect(result).toEqual({
          applied: "deferred",
          reason: "no_active_instance",
        });
        expect(mockClient.switchSceneRole).not.toHaveBeenCalled();
      });
    });

    describe("step 5b: no authorization_Role", () => {
      it("should return no_active_instance deferred", async () => {
        redis.getValue
          .mockResolvedValueOnce(INSTANCE_ID)
          .mockResolvedValueOnce(
            buildBotInstanceRecord({ authorization_Role: undefined }),
          );
        const result = await service.applyToActiveInstance(MAC, {
          vcn: "1000063",
          speechRate: null,
        });
        expect(result).toEqual({
          applied: "deferred",
          reason: "no_active_instance",
        });
        expect(mockClient.switchSceneRole).not.toHaveBeenCalled();
      });
    });

    describe("step 6: catalog not available", () => {
      it("should return empty_catalog deferred", async () => {
        setupActiveInstance();
        mockCatalog.available = false;
        const result = await service.applyToActiveInstance(MAC, {
          vcn: "1000063",
          speechRate: null,
        });
        expect(result).toEqual({
          applied: "deferred",
          reason: "empty_catalog",
        });
        expect(mockClient.switchSceneRole).not.toHaveBeenCalled();
      });
    });

    describe("step 7: vcn not in catalog", () => {
      it("should return voice_not_in_catalog deferred", async () => {
        setupActiveInstance();
        mockCatalog.available = true;
        mockCatalog.find.mockReturnValue(null);
        const result = await service.applyToActiveInstance(MAC, {
          vcn: "1000063",
          speechRate: null,
        });
        expect(result).toEqual({
          applied: "deferred",
          reason: "voice_not_in_catalog",
        });
        expect(mockClient.switchSceneRole).not.toHaveBeenCalled();
        expect(mockCatalog.find).toHaveBeenCalledWith("1000063", "zh");
      });
    });

    describe("step 8: no vcn → noop even when speechRate is set", () => {
      it("should return noop without touching the client", async () => {
        setupActiveInstance();
        const result = await service.applyToActiveInstance(MAC, {
          vcn: null,
          speechRate: "normal",
        });
        expect(result).toEqual({ applied: "noop" });
        expect(mockClient.switchSceneRole).not.toHaveBeenCalled();
      });
    });

    describe("step 10: buildTtsConfig throws", () => {
      beforeEach(() => {
        (buildTtsConfig as jest.Mock).mockImplementation(() => {
          throw new Error("bad config");
        });
      });

      it("should return deferred invalid_request", async () => {
        setupActiveInstance();
        mockCatalog.available = true;
        mockCatalog.find.mockReturnValue({
          timbreId: "1000063",
          name: "度小熊",
          status: "TRAINED",
          language: "chinese",
        });
        prisma.voiceSpeedConfig.findUnique.mockResolvedValue({
          normalSpd: 1,
          sleepSpd: 0.5,
        });
        const result = await service.applyToActiveInstance(MAC, {
          vcn: "1000063",
          speechRate: "normal",
        });
        expect(result).toEqual({
          applied: "deferred",
          reason: "invalid_request",
        });
        expect(mockClient.switchSceneRole).not.toHaveBeenCalled();
      });
    });

    describe("step 11: switchSceneRole ok → live", () => {
      beforeEach(() => {
        (buildTtsConfig as jest.Mock).mockReturnValue(
          'DEFAULT{"vcn":"1000063","spd":1}',
        );
        mockClient.switchSceneRole.mockResolvedValue({ ok: true } as const);
      });

      it("should return live and pass correct params to switchSceneRole", async () => {
        setupActiveInstance();
        mockCatalog.available = true;
        mockCatalog.find.mockReturnValue({
          timbreId: "1000063",
          name: "度小熊",
          status: "TRAINED",
          language: "chinese",
        });
        prisma.voiceSpeedConfig.findUnique.mockResolvedValue({
          normalSpd: 1,
          sleepSpd: 0.5,
        });

        const result = await service.applyToActiveInstance(MAC, {
          vcn: "1000063",
          speechRate: "normal",
        });

        expect(result).toEqual({ applied: "live" });
        expect(mockClient.switchSceneRole).toHaveBeenCalledTimes(1);
        expect(mockClient.switchSceneRole).toHaveBeenCalledWith({
          appId: "app-001",
          instanceId: INSTANCE_ID,
          tts: 'DEFAULT{"vcn":"1000063","spd":1}',
          lang: "zh",
          authString: "bce-auth-v1/.../role-sig",
          cloudNode: "cn",
        });
      });
    });

    describe("step 11b: switchSceneRole fails → deferred", () => {
      beforeEach(() => {
        (buildTtsConfig as jest.Mock).mockReturnValue(
          'DEFAULT{"vcn":"1000063","spd":1}',
        );
        mockClient.switchSceneRole.mockResolvedValue({
          ok: false,
          reason: "upstream_error",
          detail: "timeout",
        });
      });

      it("should return deferred with reason", async () => {
        setupActiveInstance();
        mockCatalog.available = true;
        mockCatalog.find.mockReturnValue({
          timbreId: "1000063",
          name: "度小熊",
          status: "TRAINED",
          language: "chinese",
        });
        prisma.voiceSpeedConfig.findUnique.mockResolvedValue({
          normalSpd: 1,
          sleepSpd: 0.5,
        });

        const result = await service.applyToActiveInstance(MAC, {
          vcn: "1000063",
          speechRate: "normal",
        });

        expect(result).toEqual({
          applied: "deferred",
          reason: "upstream_error",
        });
      });
    });

    describe("telemetry: logs must not contain auth values", () => {
      beforeEach(() => {
        jest.spyOn(Logger.prototype, "log").mockImplementation();
        jest.spyOn(Logger.prototype, "warn").mockImplementation();
      });

      afterEach(() => {
        jest.restoreAllMocks();
      });

      it("should log success without leaking authString", async () => {
        (buildTtsConfig as jest.Mock).mockReturnValue(
          'DEFAULT{"vcn":"1000063","spd":1}',
        );
        mockClient.switchSceneRole.mockResolvedValue({ ok: true } as const);
        setupActiveInstance();
        mockCatalog.available = true;
        mockCatalog.find.mockReturnValue({
          timbreId: "1000063",
          name: "度小熊",
          status: "TRAINED",
          language: "chinese",
        });
        prisma.voiceSpeedConfig.findUnique.mockResolvedValue({
          normalSpd: 1,
          sleepSpd: 0.5,
        });

        await service.applyToActiveInstance(MAC, {
          vcn: "1000063",
          speechRate: "normal",
        });

        const logCalls = (Logger.prototype.log as jest.Mock).mock.calls
          .flat()
          .join(" ");
        const warnCalls = (Logger.prototype.warn as jest.Mock).mock.calls
          .flat()
          .join(" ");
        const allLogs = logCalls + warnCalls;

        expect(allLogs).not.toContain("bce-auth-v1");
        expect(allLogs).not.toContain("role-sig");
        expect(allLogs).not.toContain("tts-sig");
      });
    });
  });

  // ==========================================================================
  // onInstanceRegistered
  // ==========================================================================
  describe("onInstanceRegistered", () => {
    const setupDeviceAndConfig = () => {
      prisma.device.findUnique.mockResolvedValue({ id: DEVICE_UUID });
      prisma.deviceConfig.findFirst.mockResolvedValue({
        speechRate: "normal",
        payload: { [VOICE_PAYLOAD_KEY]: { vcn: "1000063" } },
      });
    };

    it("should return noop and touch neither Redis nor the client when nothing is desired", async () => {
      prisma.device.findUnique.mockResolvedValue({ id: DEVICE_UUID });
      prisma.deviceConfig.findFirst.mockResolvedValue(null);

      const result = await service.onInstanceRegistered(MAC, INSTANCE_ID);

      expect(result).toEqual({ applied: "noop" });
      expect(redis.getValue).not.toHaveBeenCalled();
      expect(mockClient.switchSceneRole).not.toHaveBeenCalled();
    });

    it("should return deferred disabled without calling the client", async () => {
      setupDeviceAndConfig();
      mockClient.enabled = false;

      const result = await service.onInstanceRegistered(MAC, INSTANCE_ID);

      expect(result).toEqual({ applied: "deferred", reason: "disabled" });
      expect(mockClient.switchSceneRole).not.toHaveBeenCalled();
    });

    it("should look up device, read desired, and apply", async () => {
      setupDeviceAndConfig();
      // onInstanceRegistered 已有 instanceId，只读 botInstanceKey 一次
      redis.getValue.mockResolvedValueOnce(buildBotInstanceRecord());
      mockCatalog.available = true;
      mockCatalog.find.mockReturnValue({
        timbreId: "1000063",
        name: "度小熊",
        status: "TRAINED",
        language: "chinese",
      });
      prisma.voiceSpeedConfig.findUnique.mockResolvedValue({
        normalSpd: 1,
        sleepSpd: 0.5,
      });
      (buildTtsConfig as jest.Mock).mockReturnValue(
        'DEFAULT{"vcn":"1000063","spd":1}',
      );
      mockClient.switchSceneRole.mockResolvedValue({ ok: true } as const);

      const result = await service.onInstanceRegistered(MAC, INSTANCE_ID);

      expect(result).toEqual({ applied: "live" });
      expect(prisma.device.findUnique).toHaveBeenCalledWith({
        where: { deviceId: MAC },
      });
      expect(mockClient.switchSceneRole).toHaveBeenCalledTimes(1);
      expect(redis.getValue).toHaveBeenCalledTimes(1);
      expect(redis.getValue).toHaveBeenCalledWith(
        botInstanceKey(MAC, INSTANCE_ID),
      );
    });

    it("should return deferred internal_error when prisma throws", async () => {
      jest.spyOn(Logger.prototype, "warn").mockImplementation();
      prisma.device.findUnique.mockRejectedValue(new Error("DB down"));

      const result = await service.onInstanceRegistered(MAC, INSTANCE_ID);

      expect(result).toEqual({
        applied: "deferred",
        reason: "internal_error",
      });
      expect(Logger.prototype.warn).toHaveBeenCalled();
      jest.restoreAllMocks();
    });

    it("should return deferred invalid_request when device not found", async () => {
      jest.spyOn(Logger.prototype, "warn").mockImplementation();
      prisma.device.findUnique.mockResolvedValue(null);

      const result = await service.onInstanceRegistered(MAC, INSTANCE_ID);

      expect(result).toEqual({
        applied: "deferred",
        reason: "invalid_request",
      });
      expect(Logger.prototype.warn).toHaveBeenCalled();
      jest.restoreAllMocks();
    });

    it("should never throw even on unexpected error", async () => {
      prisma.device.findUnique.mockRejectedValue(new Error("unexpected"));

      const result = await service.onInstanceRegistered(MAC, INSTANCE_ID);

      expect(result).toEqual({
        applied: "deferred",
        reason: "internal_error",
      });
      // Should not throw
    });

    it("should skip the device lookup when deviceInternalId is provided", async () => {
      prisma.deviceConfig.findFirst.mockResolvedValue(null);

      const result = await service.onInstanceRegistered(
        MAC,
        INSTANCE_ID,
        DEVICE_UUID,
      );

      expect(result).toEqual({ applied: "noop" });
      expect(prisma.device.findUnique).not.toHaveBeenCalled();
      expect(prisma.deviceConfig.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { deviceId: DEVICE_UUID, isActive: true },
        }),
      );
    });

    it("should fall back to looking up the device when deviceInternalId is omitted", async () => {
      prisma.device.findUnique.mockResolvedValue({ id: DEVICE_UUID });
      prisma.deviceConfig.findFirst.mockResolvedValue(null);

      await service.onInstanceRegistered(MAC, INSTANCE_ID);

      expect(prisma.device.findUnique).toHaveBeenCalledWith({
        where: { deviceId: MAC },
      });
    });
  });

  // ==========================================================================
  // getTimbreForCharacter — IP/角色 → timbreId 权威映射查表（委托缓存端口）
  // ==========================================================================
  describe("getTimbreForCharacter", () => {
    it("should delegate to the character timbre port for a known character", async () => {
      characterTimbre.get.mockResolvedValue("1000957");

      await expect(service.getTimbreForCharacter("elly")).resolves.toBe(
        "1000957",
      );
      expect(characterTimbre.get).toHaveBeenCalledWith("elly");
    });

    it("should short-circuit null and empty keys without touching the port", async () => {
      await expect(service.getTimbreForCharacter(null)).resolves.toBeNull();
      await expect(service.getTimbreForCharacter("")).resolves.toBeNull();
      await expect(service.getTimbreForCharacter("   ")).resolves.toBeNull();

      expect(characterTimbre.get).not.toHaveBeenCalled();
    });

    it("should return null when the port has no mapping", async () => {
      characterTimbre.get.mockResolvedValue(null);

      await expect(service.getTimbreForCharacter("nemo")).resolves.toBeNull();
    });

    it("should never throw when the port fails", async () => {
      characterTimbre.get.mockRejectedValue(new Error("db down"));
      const warn = jest.spyOn(service["logger"], "warn");

      await expect(service.getTimbreForCharacter("elly")).resolves.toBeNull();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("timbre lookup failed"),
      );
    });
  });

  // ==========================================================================
  // applySpd（哄睡临时降速：直接给倍数，不校验音色目录、不走语速档位）
  // ==========================================================================
  describe("applySpd", () => {
    const setupActiveInstance = () => {
      redis.getValue
        .mockResolvedValueOnce(INSTANCE_ID) // botCurrentKey
        .mockResolvedValueOnce(buildBotInstanceRecord()); // botInstanceKey
    };

    beforeEach(() => {
      (buildTtsConfig as jest.Mock).mockReturnValue(
        'DEFAULT{"vcn":"1000957","spd":0.7}',
      );
    });

    it("should return disabled deferred when client disabled", async () => {
      mockClient.enabled = false;
      const result = await service.applySpd(MAC, "1000957", 0.7);
      expect(result).toEqual({ applied: "deferred", reason: "disabled" });
      expect(mockClient.switchSceneRole).not.toHaveBeenCalled();
    });

    it("should return no_active_instance deferred when no current instance", async () => {
      redis.getValue.mockResolvedValueOnce(null);
      const result = await service.applySpd(MAC, "1000957", 0.7);
      expect(result).toEqual({
        applied: "deferred",
        reason: "no_active_instance",
      });
      expect(mockClient.switchSceneRole).not.toHaveBeenCalled();
    });

    it("should return incomplete_tts_target deferred when vcn empty", async () => {
      setupActiveInstance();
      const result = await service.applySpd(MAC, "", 0.7);
      expect(result).toEqual({
        applied: "deferred",
        reason: "incomplete_tts_target",
      });
      expect(mockClient.switchSceneRole).not.toHaveBeenCalled();
    });

    it("should return invalid_request deferred when spd out of range", async () => {
      setupActiveInstance();
      const result = await service.applySpd(MAC, "1000957", 3);
      expect(result).toEqual({
        applied: "deferred",
        reason: "invalid_request",
      });
      expect(mockClient.switchSceneRole).not.toHaveBeenCalled();
    });

    it("should return live and pass spd to switchSceneRole", async () => {
      setupActiveInstance();
      mockClient.switchSceneRole.mockResolvedValue({ ok: true } as const);

      const result = await service.applySpd(MAC, "1000957", 0.7);

      expect(result).toEqual({ applied: "live" });
      expect(mockClient.switchSceneRole).toHaveBeenCalledTimes(1);
      expect(mockClient.switchSceneRole).toHaveBeenCalledWith({
        appId: "app-001",
        instanceId: INSTANCE_ID,
        tts: 'DEFAULT{"vcn":"1000957","spd":0.7}',
        lang: "zh",
        authString: "bce-auth-v1/.../role-sig",
        cloudNode: "cn",
      });
    });

    it("should return deferred upstream_error when switchSceneRole fails", async () => {
      setupActiveInstance();
      mockClient.switchSceneRole.mockResolvedValue({
        ok: false,
        reason: "upstream_error",
        detail: "timeout",
      });

      const result = await service.applySpd(MAC, "1000957", 0.7);

      expect(result).toEqual({ applied: "deferred", reason: "upstream_error" });
    });
  });
});
