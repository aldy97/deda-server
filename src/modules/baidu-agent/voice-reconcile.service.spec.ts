import { Test, TestingModule } from "@nestjs/testing";
import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "@/common/prisma/prisma.service";
import { RedisService } from "@/common/redis/redis.service";
import {
  VOICE_CATALOG_PORT,
  VoiceCatalogPort,
  BAIDU_AGENT_CLIENT_PORT,
  BaiduAgentClientPort,
  VOICE_PAYLOAD_KEY,
  TTS_SPD_MIN,
  TTS_SPD_MAX,
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
      ],
    }).compile();
    return module.get(VoiceReconcileService);
  };

  beforeEach(async () => {
    prisma = {
      device: { findUnique: jest.fn().mockResolvedValue(null) },
      deviceConfig: { findFirst: jest.fn().mockResolvedValue(null) },
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

    jest.clearAllMocks();
    service = await createService();
  });

  // ==========================================================================
  // resolveSpd
  // ==========================================================================
  describe("resolveSpd", () => {
    it("should return null when speechRate is null", () => {
      expect(service.resolveSpd(null)).toBeNull();
    });

    it("should return null when SPEECH_RATE_MAP_JSON is not configured", () => {
      expect(service.resolveSpd("normal")).toBeNull();
    });

    it("should return null when JSON is malformed", () => {
      configValues = { SPEECH_RATE_MAP_JSON: "bad json" };
      // Recreate service with new config
      service = new VoiceReconcileService(
        prisma as unknown as PrismaService,
        redis as unknown as RedisService,
        { get: (key: string) => configValues[key] } as ConfigService,
        mockCatalog,
        mockClient,
      );
      expect(service.resolveSpd("normal")).toBeNull();
    });

    it("should return null when JSON is not an object", () => {
      configValues = { SPEECH_RATE_MAP_JSON: '"just a string"' };
      service = new VoiceReconcileService(
        prisma as unknown as PrismaService,
        redis as unknown as RedisService,
        { get: (key: string) => configValues[key] } as ConfigService,
        mockCatalog,
        mockClient,
      );
      expect(service.resolveSpd("normal")).toBeNull();
    });

    it("should return null when key is not in map", () => {
      configValues = {
        SPEECH_RATE_MAP_JSON: '{"slow":0.8,"normal":1,"fast":1.25}',
      };
      service = new VoiceReconcileService(
        prisma as unknown as PrismaService,
        redis as unknown as RedisService,
        { get: (key: string) => configValues[key] } as ConfigService,
        mockCatalog,
        mockClient,
      );
      expect(service.resolveSpd("unknown_key")).toBeNull();
    });

    it("should return null when value is not a finite number", () => {
      configValues = {
        SPEECH_RATE_MAP_JSON: '{"slow":0.8,"normal":"one","fast":1.25}',
      };
      service = new VoiceReconcileService(
        prisma as unknown as PrismaService,
        redis as unknown as RedisService,
        { get: (key: string) => configValues[key] } as ConfigService,
        mockCatalog,
        mockClient,
      );
      expect(service.resolveSpd("normal")).toBeNull();
    });

    it("should return null when value is below TTS_SPD_MIN", () => {
      configValues = {
        SPEECH_RATE_MAP_JSON: '{"slow":0.3,"normal":1,"fast":1.25}',
      };
      service = new VoiceReconcileService(
        prisma as unknown as PrismaService,
        redis as unknown as RedisService,
        { get: (key: string) => configValues[key] } as ConfigService,
        mockCatalog,
        mockClient,
      );
      expect(service.resolveSpd("slow")).toBeNull();
    });

    it("should return null when value is above TTS_SPD_MAX", () => {
      configValues = {
        SPEECH_RATE_MAP_JSON: '{"slow":0.8,"normal":1,"fast":2.5}',
      };
      service = new VoiceReconcileService(
        prisma as unknown as PrismaService,
        redis as unknown as RedisService,
        { get: (key: string) => configValues[key] } as ConfigService,
        mockCatalog,
        mockClient,
      );
      expect(service.resolveSpd("fast")).toBeNull();
    });

    it("should return the mapped number for valid key", () => {
      configValues = {
        SPEECH_RATE_MAP_JSON: '{"slow":0.8,"normal":1,"fast":1.25}',
      };
      service = new VoiceReconcileService(
        prisma as unknown as PrismaService,
        redis as unknown as RedisService,
        { get: (key: string) => configValues[key] } as ConfigService,
        mockCatalog,
        mockClient,
      );
      expect(service.resolveSpd("slow")).toBe(0.8);
      expect(service.resolveSpd("normal")).toBe(1);
      expect(service.resolveSpd("fast")).toBe(1.25);
    });

    it("should accept value exactly at TTS_SPD_MIN", () => {
      configValues = { SPEECH_RATE_MAP_JSON: '{"slow":0.5}' };
      service = new VoiceReconcileService(
        prisma as unknown as PrismaService,
        redis as unknown as RedisService,
        { get: (key: string) => configValues[key] } as ConfigService,
        mockCatalog,
        mockClient,
      );
      expect(service.resolveSpd("slow")).toBe(0.5);
    });

    it("should accept value exactly at TTS_SPD_MAX", () => {
      configValues = { SPEECH_RATE_MAP_JSON: '{"fast":2}' };
      service = new VoiceReconcileService(
        prisma as unknown as PrismaService,
        redis as unknown as RedisService,
        { get: (key: string) => configValues[key] } as ConfigService,
        mockCatalog,
        mockClient,
      );
      expect(service.resolveSpd("fast")).toBe(2);
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

    describe("step 8: speechRate map missing", () => {
      it("should return speech_rate_map_missing deferred", async () => {
        setupActiveInstance();
        mockCatalog.available = true;
        mockCatalog.find.mockReturnValue({
          timbreId: "1000063",
          name: "度小熊",
          status: "TRAINED",
          language: "chinese",
        });
        const result = await service.applyToActiveInstance(MAC, {
          vcn: "1000063",
          speechRate: "normal",
        });
        expect(result).toEqual({
          applied: "deferred",
          reason: "speech_rate_map_missing",
        });
        expect(mockClient.switchSceneRole).not.toHaveBeenCalled();
      });
    });

    describe("step 9: incomplete tts target (only vcn, spd missing)", () => {
      it("should return incomplete_tts_target deferred", async () => {
        setupActiveInstance();
        mockCatalog.available = true;
        mockCatalog.find.mockReturnValue({
          timbreId: "1000063",
          name: "度小熊",
          status: "TRAINED",
          language: "chinese",
        });
        // vcn provided but spd not (and speechRate null means resolveSpd returns null)
        const result = await service.applyToActiveInstance(MAC, {
          vcn: "1000063",
          speechRate: null,
        });
        expect(result).toEqual({
          applied: "deferred",
          reason: "incomplete_tts_target",
        });
        expect(mockClient.switchSceneRole).not.toHaveBeenCalled();
      });
    });

    describe("step 9b: incomplete tts target (only spd, vcn missing)", () => {
      it("should return incomplete_tts_target deferred", async () => {
        configValues = {
          SPEECH_RATE_MAP_JSON: '{"normal":1}',
        };
        service = new VoiceReconcileService(
          prisma as unknown as PrismaService,
          redis as unknown as RedisService,
          { get: (key: string) => configValues[key] } as ConfigService,
          mockCatalog,
          mockClient,
        );
        setupActiveInstance();
        mockCatalog.available = true;
        const result = await service.applyToActiveInstance(MAC, {
          vcn: null,
          speechRate: "normal",
        });
        expect(result).toEqual({
          applied: "deferred",
          reason: "incomplete_tts_target",
        });
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
        configValues = {
          SPEECH_RATE_MAP_JSON: '{"normal":1}',
        };
        service = new VoiceReconcileService(
          prisma as unknown as PrismaService,
          redis as unknown as RedisService,
          { get: (key: string) => configValues[key] } as ConfigService,
          mockCatalog,
          mockClient,
        );
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
        configValues = {
          SPEECH_RATE_MAP_JSON: '{"normal":1}',
        };
        service = new VoiceReconcileService(
          prisma as unknown as PrismaService,
          redis as unknown as RedisService,
          { get: (key: string) => configValues[key] } as ConfigService,
          mockCatalog,
          mockClient,
        );

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
        configValues = {
          SPEECH_RATE_MAP_JSON: '{"normal":1}',
        };
        service = new VoiceReconcileService(
          prisma as unknown as PrismaService,
          redis as unknown as RedisService,
          { get: (key: string) => configValues[key] } as ConfigService,
          mockCatalog,
          mockClient,
        );

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
        configValues = {
          SPEECH_RATE_MAP_JSON: '{"normal":1}',
        };
        service = new VoiceReconcileService(
          prisma as unknown as PrismaService,
          redis as unknown as RedisService,
          { get: (key: string) => configValues[key] } as ConfigService,
          mockCatalog,
          mockClient,
        );

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
      configValues = { SPEECH_RATE_MAP_JSON: '{"normal":1}' };

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
      configValues = { SPEECH_RATE_MAP_JSON: '{"normal":1}' };
      (buildTtsConfig as jest.Mock).mockReturnValue(
        'DEFAULT{"vcn":"1000063","spd":1}',
      );
      mockClient.switchSceneRole.mockResolvedValue({ ok: true } as const);

      service = new VoiceReconcileService(
        prisma as unknown as PrismaService,
        redis as unknown as RedisService,
        { get: (key: string) => configValues[key] } as ConfigService,
        mockCatalog,
        mockClient,
      );

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
  // resolveInitialVoice — loginMac 下发给固件的初始音色
  // ==========================================================================
  describe("resolveInitialVoice", () => {
    const TIMBRE = {
      timbreId: "1000063",
      name: "度小熊",
      status: "TRAINED",
      language: "chinese",
    };
    const TTS = 'DEFAULT{"vcn":"1000063","spd":1}';

    const rebuild = () => {
      service = new VoiceReconcileService(
        prisma as unknown as PrismaService,
        redis as unknown as RedisService,
        { get: (key: string) => configValues[key] } as ConfigService,
        mockCatalog,
        mockClient,
      );
    };
    const resolve = (
      overrides: {
        characterKey?: string | null;
        lang?: string;
      } = {},
    ) =>
      service.resolveInitialVoice({
        deviceInternalId: DEVICE_UUID,
        characterKey:
          overrides.characterKey === undefined
            ? "elly"
            : overrides.characterKey,
        lang: overrides.lang ?? "zh",
      });

    beforeEach(() => {
      (buildTtsConfig as jest.Mock).mockReturnValue(TTS);
      mockCatalog.available = true;
      mockCatalog.find.mockReturnValue(TIMBRE);
    });

    it("should return none when neither DeviceConfig nor a character default exists", async () => {
      prisma.deviceConfig.findFirst.mockResolvedValue(null);
      configValues = {};
      rebuild();

      await expect(resolve()).resolves.toEqual({ status: "none" });
    });

    it("should return none when only a speech rate is configured (never guesses a timbre)", async () => {
      prisma.deviceConfig.findFirst.mockResolvedValue({
        speechRate: "normal",
        payload: null,
      });
      configValues = { SPEECH_RATE_MAP_JSON: '{"normal":1}' };
      rebuild();

      await expect(resolve()).resolves.toEqual({ status: "none" });
      expect(buildTtsConfig).not.toHaveBeenCalled();
    });

    it("should never touch Redis, the instance record or the Baidu client", async () => {
      prisma.deviceConfig.findFirst.mockResolvedValue({
        speechRate: null,
        payload: { [VOICE_PAYLOAD_KEY]: { vcn: "1000063" } },
      });
      configValues = {};
      rebuild();

      await resolve();

      expect(redis.getValue).not.toHaveBeenCalled();
      expect(mockClient.switchSceneRole).not.toHaveBeenCalled();
      expect(mockClient.interrupt).not.toHaveBeenCalled();
    });

    it("should return blocked disabled when the master switch is off", async () => {
      prisma.deviceConfig.findFirst.mockResolvedValue({
        speechRate: null,
        payload: { [VOICE_PAYLOAD_KEY]: { vcn: "1000063" } },
      });
      mockClient.enabled = false;
      configValues = {};
      rebuild();

      await expect(resolve()).resolves.toEqual({
        status: "blocked",
        reason: "disabled",
      });
    });

    it("should return blocked empty_catalog when the catalog placeholder is unfilled", async () => {
      prisma.deviceConfig.findFirst.mockResolvedValue({
        speechRate: null,
        payload: { [VOICE_PAYLOAD_KEY]: { vcn: "1000063" } },
      });
      mockCatalog.available = false;
      configValues = {};
      rebuild();

      await expect(resolve()).resolves.toEqual({
        status: "blocked",
        reason: "empty_catalog",
      });
    });

    it("should return blocked voice_not_in_catalog when the timbre or its language does not match", async () => {
      prisma.deviceConfig.findFirst.mockResolvedValue({
        speechRate: null,
        payload: { [VOICE_PAYLOAD_KEY]: { vcn: "9999999" } },
      });
      mockCatalog.find.mockReturnValue(null);
      configValues = {};
      rebuild();

      await expect(resolve()).resolves.toEqual({
        status: "blocked",
        reason: "voice_not_in_catalog",
      });
      expect(mockCatalog.find).toHaveBeenCalledWith("9999999", "zh");
    });

    it("should return ready with a bare timbreId field by default", async () => {
      prisma.deviceConfig.findFirst.mockResolvedValue({
        speechRate: null,
        payload: { [VOICE_PAYLOAD_KEY]: { vcn: "1000063" } },
      });
      configValues = {};
      rebuild();

      await expect(resolve()).resolves.toEqual({
        status: "ready",
        timbreId: "1000063",
        field: { key: "timbreId", value: "1000063" },
      });
      // 默认形态只下发裸 id，由固件自己拼 tts 串
      expect(buildTtsConfig).not.toHaveBeenCalled();
    });

    it("should return ready with the full tts config when the format is tts", async () => {
      prisma.deviceConfig.findFirst.mockResolvedValue({
        speechRate: "normal",
        payload: { [VOICE_PAYLOAD_KEY]: { vcn: "1000063" } },
      });
      configValues = {
        LOGIN_VOICE_PAYLOAD_FORMAT: "tts",
        SPEECH_RATE_MAP_JSON: '{"normal":1}',
      };
      rebuild();

      await expect(resolve()).resolves.toEqual({
        status: "ready",
        timbreId: "1000063",
        field: { key: "tts", value: TTS },
      });
      expect(buildTtsConfig).toHaveBeenCalledWith({ vcn: "1000063", spd: 1 });
    });

    it("should build tts without spd when no speech rate is configured", async () => {
      prisma.deviceConfig.findFirst.mockResolvedValue({
        speechRate: null,
        payload: { [VOICE_PAYLOAD_KEY]: { vcn: "1000063" } },
      });
      configValues = { LOGIN_VOICE_PAYLOAD_FORMAT: "tts" };
      rebuild();

      await expect(resolve()).resolves.toEqual({
        status: "ready",
        timbreId: "1000063",
        field: { key: "tts", value: TTS },
      });
      expect(buildTtsConfig).toHaveBeenCalledWith({ vcn: "1000063" });
    });

    it("should fall back to an unknown format by using the documented default", async () => {
      prisma.deviceConfig.findFirst.mockResolvedValue({
        speechRate: null,
        payload: { [VOICE_PAYLOAD_KEY]: { vcn: "1000063" } },
      });
      configValues = { LOGIN_VOICE_PAYLOAD_FORMAT: "carrier-pigeon" };
      rebuild();

      await expect(resolve()).resolves.toEqual({
        status: "ready",
        timbreId: "1000063",
        field: { key: "timbreId", value: "1000063" },
      });
    });

    it("should fall back to the character default timbre when DeviceConfig has no vcn", async () => {
      prisma.deviceConfig.findFirst.mockResolvedValue(null);
      configValues = { CHARACTER_DEFAULT_TIMBRE_JSON: '{"elly":"1000063"}' };
      rebuild();

      await expect(resolve()).resolves.toEqual({
        status: "ready",
        timbreId: "1000063",
        field: { key: "timbreId", value: "1000063" },
      });
    });

    it("should prefer an explicit DeviceConfig vcn over the character default", async () => {
      prisma.deviceConfig.findFirst.mockResolvedValue({
        speechRate: null,
        payload: { [VOICE_PAYLOAD_KEY]: { vcn: "1000064" } },
      });
      configValues = { CHARACTER_DEFAULT_TIMBRE_JSON: '{"elly":"1000063"}' };
      rebuild();

      await expect(resolve({ characterKey: "elly" })).resolves.toEqual({
        status: "ready",
        timbreId: "1000064",
        field: { key: "timbreId", value: "1000064" },
      });
      expect(mockCatalog.find).toHaveBeenCalledWith("1000064", "zh");
    });

    it("should pick the default of the actual characterKey, not a hardcoded one", async () => {
      prisma.deviceConfig.findFirst.mockResolvedValue(null);
      configValues = {
        CHARACTER_DEFAULT_TIMBRE_JSON: '{"elly":"1000063","polly":"1000064"}',
      };
      mockCatalog.find.mockReturnValue({ ...TIMBRE, timbreId: "1000064" });
      rebuild();

      await expect(resolve({ characterKey: "polly" })).resolves.toEqual({
        status: "ready",
        timbreId: "1000064",
        field: { key: "timbreId", value: "1000064" },
      });
    });

    it("should return none when characterKey is null and no explicit vcn exists", async () => {
      prisma.deviceConfig.findFirst.mockResolvedValue(null);
      configValues = { CHARACTER_DEFAULT_TIMBRE_JSON: '{"elly":"1000063"}' };
      rebuild();

      await expect(resolve({ characterKey: null })).resolves.toEqual({
        status: "none",
      });
    });

    it("should return none when the characterKey has no default configured", async () => {
      prisma.deviceConfig.findFirst.mockResolvedValue(null);
      configValues = { CHARACTER_DEFAULT_TIMBRE_JSON: '{"elly":"1000063"}' };
      rebuild();

      await expect(resolve({ characterKey: "unknown-ip" })).resolves.toEqual({
        status: "none",
      });
    });

    it("should ignore a malformed character default map and stay fail-closed", async () => {
      prisma.deviceConfig.findFirst.mockResolvedValue(null);
      configValues = { CHARACTER_DEFAULT_TIMBRE_JSON: "not json" };
      rebuild();

      await expect(resolve()).resolves.toEqual({ status: "none" });
    });

    it("should ignore a character default map that is valid JSON but not an object", async () => {
      prisma.deviceConfig.findFirst.mockResolvedValue(null);
      configValues = { CHARACTER_DEFAULT_TIMBRE_JSON: '["1000063"]' };
      rebuild();
      await expect(resolve()).resolves.toEqual({ status: "none" });

      configValues = { CHARACTER_DEFAULT_TIMBRE_JSON: '"1000063"' };
      rebuild();
      await expect(resolve()).resolves.toEqual({ status: "none" });
    });

    it("should ignore non-string and empty entries in the character default map", async () => {
      prisma.deviceConfig.findFirst.mockResolvedValue(null);
      configValues = {
        CHARACTER_DEFAULT_TIMBRE_JSON:
          '{"elly":"","polly":null,"other":["x"],"flag":true}',
      };
      rebuild();

      await expect(resolve()).resolves.toEqual({ status: "none" });
      await expect(resolve({ characterKey: "polly" })).resolves.toEqual({
        status: "none",
      });
    });

    it("should accept a numeric timbreId in the character default map", async () => {
      prisma.deviceConfig.findFirst.mockResolvedValue(null);
      configValues = { CHARACTER_DEFAULT_TIMBRE_JSON: '{"elly":1000063}' };
      rebuild();

      await expect(resolve()).resolves.toEqual({
        status: "ready",
        timbreId: "1000063",
        field: { key: "timbreId", value: "1000063" },
      });
    });

    it("should degrade to the timbre alone when the rate map lacks the tier, and log it", async () => {
      const warn = jest
        .spyOn(Logger.prototype, "warn")
        .mockImplementation(() => undefined);
      prisma.deviceConfig.findFirst.mockResolvedValue({
        speechRate: "fast",
        payload: { [VOICE_PAYLOAD_KEY]: { vcn: "1000063" } },
      });
      configValues = { SPEECH_RATE_MAP_JSON: '{"normal":1}' };
      rebuild();

      await expect(resolve()).resolves.toEqual({
        status: "ready",
        timbreId: "1000063",
        field: { key: "timbreId", value: "1000063" },
      });
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("speech rate map missing"),
      );
      warn.mockRestore();
    });

    it("should keep spd out of the tts payload when degrading", async () => {
      jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
      prisma.deviceConfig.findFirst.mockResolvedValue({
        speechRate: "fast",
        payload: { [VOICE_PAYLOAD_KEY]: { vcn: "1000063" } },
      });
      configValues = {
        SPEECH_RATE_MAP_JSON: '{"normal":1}',
        LOGIN_VOICE_PAYLOAD_FORMAT: "tts",
      };
      rebuild();

      await expect(resolve()).resolves.toEqual({
        status: "ready",
        timbreId: "1000063",
        field: { key: "tts", value: TTS },
      });
      expect(buildTtsConfig).toHaveBeenCalledWith({ vcn: "1000063" });
      jest.restoreAllMocks();
    });

    it("should still apply the rate when the map does contain the tier", async () => {
      prisma.deviceConfig.findFirst.mockResolvedValue({
        speechRate: "fast",
        payload: { [VOICE_PAYLOAD_KEY]: { vcn: "1000063" } },
      });
      configValues = {
        SPEECH_RATE_MAP_JSON: '{"normal":1,"fast":1.25}',
        LOGIN_VOICE_PAYLOAD_FORMAT: "tts",
      };
      rebuild();

      await expect(resolve()).resolves.toEqual({
        status: "ready",
        timbreId: "1000063",
        field: { key: "tts", value: TTS },
      });
      expect(buildTtsConfig).toHaveBeenCalledWith({
        vcn: "1000063",
        spd: 1.25,
      });
    });

    it("should return blocked invalid_request when tts assembly throws", async () => {
      prisma.deviceConfig.findFirst.mockResolvedValue({
        speechRate: null,
        payload: { [VOICE_PAYLOAD_KEY]: { vcn: "1000063" } },
      });
      configValues = { LOGIN_VOICE_PAYLOAD_FORMAT: "tts" };
      (buildTtsConfig as jest.Mock).mockImplementation(() => {
        throw new Error("vcn must be a non-empty string");
      });
      rebuild();

      await expect(resolve()).resolves.toEqual({
        status: "blocked",
        reason: "invalid_request",
      });
    });

    it("should return blocked internal_error and never throw on unexpected failure", async () => {
      jest.spyOn(Logger.prototype, "warn").mockImplementation();
      prisma.deviceConfig.findFirst.mockRejectedValue(new Error("db down"));
      configValues = {};
      rebuild();

      await expect(resolve()).resolves.toEqual({
        status: "blocked",
        reason: "internal_error",
      });
      jest.restoreAllMocks();
    });
  });
});
