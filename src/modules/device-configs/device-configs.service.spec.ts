import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { validate } from "class-validator";
import { DeviceConfigsService } from "./device-configs.service";
import { PrismaService } from "@/common/prisma/prisma.service";
import { ApplyDeviceConfigDto } from "./dto/apply-device-config.dto";
import { SwitchModeDto } from "./dto/switch-mode.dto";
import {
  VOICE_CATALOG_PORT,
  VOICE_RECONCILE_PORT,
  VOICE_PAYLOAD_KEY,
} from "@/modules/baidu-agent/baidu-agent.types";

type PrismaMock = {
  $transaction: jest.Mock;
  deviceConfig: {
    findFirst: jest.Mock;
    updateMany: jest.Mock;
    create: jest.Mock;
  };
  userDeviceBinding: { findFirst: jest.Mock };
};

type CatalogMock = {
  listUsable: jest.Mock;
  listForLang: jest.Mock;
  find: jest.Mock;
  available: boolean;
};

type ReconcileMock = {
  readDesired: jest.Mock;
  applyToActiveInstance: jest.Mock;
  onInstanceRegistered: jest.Mock;
  resolveNormalSpd: jest.Mock;
};

describe("DeviceConfigsService", () => {
  let service: DeviceConfigsService;
  let prisma: PrismaMock;
  let mockCatalog: CatalogMock;
  let mockReconcile: ReconcileMock;

  beforeEach(async () => {
    mockCatalog = {
      listUsable: jest.fn(),
      listForLang: jest.fn(),
      find: jest.fn(),
      available: false,
    };
    mockReconcile = {
      readDesired: jest.fn(),
      applyToActiveInstance: jest.fn(),
      onInstanceRegistered: jest.fn(),
      resolveNormalSpd: jest.fn(),
    };

    prisma = {
      $transaction: jest.fn((cb: (tx: PrismaMock) => unknown) => cb(prisma)),
      deviceConfig: {
        findFirst: jest.fn(),
        updateMany: jest.fn(),
        create: jest.fn(),
      },
      userDeviceBinding: {
        findFirst: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DeviceConfigsService,
        {
          provide: PrismaService,
          useValue: prisma,
        },
        {
          provide: VOICE_CATALOG_PORT,
          useValue: mockCatalog,
        },
        {
          provide: VOICE_RECONCILE_PORT,
          useValue: mockReconcile,
        },
      ],
    }).compile();

    service = module.get<DeviceConfigsService>(DeviceConfigsService);
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  const mockBinding = {
    id: "binding-001",
    device: {
      id: "device-uuid-001",
      deviceId: "dev-001",
      macAddress: "aa:bb:cc:dd:ee:ff",
    },
  };

  describe("current", () => {
    it("should return the latest active config", async () => {
      const activeConfig = {
        id: "config-1",
        deviceId: "device-uuid-001",
        mode: "free_chat",
        cefrLevel: "A1",
        language: "bilingual",
        speechRate: "normal",
        isActive: true,
        createdAt: new Date(),
      };

      prisma.userDeviceBinding.findFirst.mockResolvedValue(mockBinding);
      prisma.deviceConfig.findFirst.mockResolvedValue(activeConfig);

      const result = await service.current("user-001", "dev-001");

      expect(prisma.userDeviceBinding.findFirst).toHaveBeenCalledWith({
        where: { userId: "user-001", device: { deviceId: "dev-001" } },
        include: { device: true },
      });
      expect(result).toEqual({
        deviceId: "dev-001",
        mode: "free_chat",
        cefrLevel: "A1",
        language: "bilingual",
        speechRate: "normal",
      });
    });

    it("should return free chat defaults when no active config exists", async () => {
      prisma.userDeviceBinding.findFirst.mockResolvedValue(mockBinding);
      prisma.deviceConfig.findFirst.mockResolvedValue(null);

      const result = await service.current("user-001", "dev-001");

      expect(result).toEqual({
        deviceId: "dev-001",
        mode: "free_chat",
        cefrLevel: null,
        language: "bilingual",
        speechRate: "normal",
      });
    });

    it("should throw ForbiddenException when user does not own the device", async () => {
      prisma.userDeviceBinding.findFirst.mockResolvedValue(null);

      await expect(service.current("user-001", "dev-001")).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  describe("apply", () => {
    it("should create a new active English chat config", async () => {
      const dto: ApplyDeviceConfigDto = { mode: "english_chat" };

      prisma.userDeviceBinding.findFirst.mockResolvedValue(mockBinding);
      prisma.deviceConfig.updateMany.mockResolvedValue({ count: 1 });
      prisma.deviceConfig.create.mockResolvedValue({
        id: "config-new",
        deviceId: "device-uuid-001",
        mode: "english_chat",
        cefrLevel: null,
        language: "bilingual",
        speechRate: "normal",
        isActive: true,
      });

      const result = await service.apply("user-001", "dev-001", dto);

      expect(prisma.deviceConfig.updateMany).toHaveBeenCalledWith({
        where: { deviceId: "device-uuid-001", isActive: true },
        data: { isActive: false },
      });
      expect(prisma.deviceConfig.create).toHaveBeenCalledWith({
        data: {
          deviceId: "device-uuid-001",
          mode: "english_chat",
          cefrLevel: null,
          language: "bilingual",
          speechRate: "normal",
          isActive: true,
        },
      });
      expect(result.mode).toBe("english_chat");
    });

    it("should throw ForbiddenException when user does not own the device", async () => {
      const dto: ApplyDeviceConfigDto = { mode: "english_chat" };

      prisma.userDeviceBinding.findFirst.mockResolvedValue(null);

      await expect(service.apply("user-001", "dev-001", dto)).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  describe("switchMode", () => {
    it("should create a new active config for free chat sub-mode", async () => {
      const dto: SwitchModeDto = {
        mode: "free_chat",
      };

      prisma.userDeviceBinding.findFirst.mockResolvedValue(mockBinding);
      prisma.deviceConfig.updateMany.mockResolvedValue({ count: 1 });
      prisma.deviceConfig.create.mockResolvedValue({
        id: "config-new",
        deviceId: "device-uuid-001",
        mode: "free_chat",
        cefrLevel: null,
        language: "bilingual",
        speechRate: "normal",
        isActive: true,
      });

      const result = await service.switchMode("user-001", "dev-001", dto);

      expect(prisma.deviceConfig.create).toHaveBeenCalledWith({
        data: {
          deviceId: "device-uuid-001",
          mode: "free_chat",
          cefrLevel: null,
          language: "bilingual",
          speechRate: "normal",
          isActive: true,
        },
      });
      expect(result.mode).toBe("free_chat");
    });

    it("should create a new active config for English chat", async () => {
      const dto: SwitchModeDto = { mode: "english_chat" };

      prisma.userDeviceBinding.findFirst.mockResolvedValue(mockBinding);
      prisma.deviceConfig.updateMany.mockResolvedValue({ count: 1 });
      prisma.deviceConfig.create.mockResolvedValue({
        id: "config-new",
        deviceId: "device-uuid-001",
        mode: "english_chat",
        cefrLevel: null,
        language: "bilingual",
        speechRate: "normal",
        isActive: true,
      });

      const result = await service.switchMode("user-001", "dev-001", dto);
      expect(result.mode).toBe("english_chat");
    });

    it("should throw ForbiddenException when user does not own the device", async () => {
      const dto: SwitchModeDto = { mode: "free_chat" };

      prisma.userDeviceBinding.findFirst.mockResolvedValue(null);

      await expect(
        service.switchMode("user-001", "dev-001", dto),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  it.each(["textbook_learning", "locked_unit", "free_textbook"])(
    "should reject removed legacy mode %s",
    async (mode) => {
      prisma.userDeviceBinding.findFirst.mockResolvedValue(mockBinding);

      await expect(
        service.switchMode("user-001", "dev-001", {
          mode,
        } as SwitchModeDto),
      ).rejects.toThrow(BadRequestException);
    },
  );

  describe("DTO mode enum", () => {
    it("should reject invalid mode on SwitchModeDto", async () => {
      const dto = Object.assign(new SwitchModeDto(), { mode: "invalid_mode" });
      const errors = await validate(dto);
      expect(errors.length).toBeGreaterThan(0);
    });

    it("should reject invalid mode on ApplyDeviceConfigDto", async () => {
      const dto = Object.assign(new ApplyDeviceConfigDto(), {
        mode: "invalid_mode",
      });
      const errors = await validate(dto);
      expect(errors.length).toBeGreaterThan(0);
    });

    it("should accept valid modes on SwitchModeDto", async () => {
      for (const mode of ["free_chat", "english_chat"]) {
        const dto = Object.assign(new SwitchModeDto(), { mode });
        const errors = await validate(dto);
        expect(errors).toHaveLength(0);
      }
    });
  });

  // ============================================================
  // Voice config tests
  // ============================================================

  const voiceCatalogEntries = [
    {
      timbreId: "1000063",
      name: "度小熊",
      status: "TRAINED",
      language: "chinese",
    },
    {
      timbreId: "1000064",
      name: "度小兔",
      status: "TRAINED",
      language: "chinese",
    },
  ];

  const baseActiveConfig = {
    id: "config-active",
    deviceId: "device-uuid-001",
    mode: "free_chat",
    cefrLevel: "A1",
    language: "bilingual",
    speechRate: "normal",
    payload: null,
    isActive: true,
    createdAt: new Date(),
  };

  describe("getVoiceConfig", () => {
    it("should return empty catalog when catalog.available is false", async () => {
      prisma.userDeviceBinding.findFirst.mockResolvedValue(mockBinding);
      mockCatalog.available = false;
      mockCatalog.listUsable.mockReturnValue([]);
      prisma.deviceConfig.findFirst.mockResolvedValue(null);
      mockReconcile.resolveNormalSpd.mockReturnValue(0.7);

      const result = await service.getVoiceConfig("user-001", "dev-001");

      expect(result).toEqual({
        deviceId: "dev-001",
        vcn: null,
        speechRate: null,
        spd: 0.7,
        catalog: [],
        available: false,
        canApplyLive: false,
        reason: "empty_catalog",
      });
    });

    it("should return canApplyLive=true when desired values exist and spd maps", async () => {
      prisma.userDeviceBinding.findFirst.mockResolvedValue(mockBinding);
      mockCatalog.available = true;
      mockCatalog.listUsable.mockReturnValue(voiceCatalogEntries);
      mockReconcile.resolveNormalSpd.mockReturnValue(1);
      prisma.deviceConfig.findFirst.mockResolvedValue({
        ...baseActiveConfig,
        speechRate: "normal",
        payload: {
          voice: { vcn: "1000063", updatedAt: "2026-01-01T00:00:00.000Z" },
        },
      });

      const result = await service.getVoiceConfig("user-001", "dev-001");

      expect(result.vcn).toBe("1000063");
      expect(result.speechRate).toBe("normal");
      expect(result.spd).toBe(1);
      expect(result.available).toBe(true);
      expect(result.canApplyLive).toBe(true);
      expect(result.reason).toBeNull();
      expect(result.catalog).toEqual([
        { timbreId: "1000063", name: "度小熊", language: "chinese" },
        { timbreId: "1000064", name: "度小兔", language: "chinese" },
      ]);
    });

    it("should return canApplyLive=false with reason=null when only speechRate is set (vcn null)", async () => {
      prisma.userDeviceBinding.findFirst.mockResolvedValue(mockBinding);
      mockCatalog.available = true;
      mockCatalog.listUsable.mockReturnValue(voiceCatalogEntries);
      mockReconcile.resolveNormalSpd.mockReturnValue(0.7);
      prisma.deviceConfig.findFirst.mockResolvedValue({
        ...baseActiveConfig,
        speechRate: "fast",
        payload: null,
      });

      const result = await service.getVoiceConfig("user-001", "dev-001");

      expect(result.canApplyLive).toBe(false);
      expect(result.reason).toBeNull();
      expect(result.vcn).toBeNull();
      expect(result.speechRate).toBe("fast");
      expect(result.spd).toBe(0.7);
    });

    it("should return canApplyLive=false with reason=null when both vcn and speechRate are null", async () => {
      prisma.userDeviceBinding.findFirst.mockResolvedValue(mockBinding);
      mockCatalog.available = true;
      mockCatalog.listUsable.mockReturnValue(voiceCatalogEntries);
      prisma.deviceConfig.findFirst.mockResolvedValue(null);

      const result = await service.getVoiceConfig("user-001", "dev-001");

      expect(result.vcn).toBeNull();
      expect(result.speechRate).toBeNull();
      expect(result.canApplyLive).toBe(false);
      expect(result.reason).toBeNull();
    });

    it("should throw ForbiddenException when user does not own the device", async () => {
      prisma.userDeviceBinding.findFirst.mockResolvedValue(null);

      await expect(
        service.getVoiceConfig("user-001", "dev-001"),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe("updateVoiceConfig", () => {
    it("should throw BadRequest when neither vcn nor speechRate is provided", async () => {
      prisma.userDeviceBinding.findFirst.mockResolvedValue(mockBinding);

      await expect(
        service.updateVoiceConfig("user-001", "dev-001", {}),
      ).rejects.toThrow(BadRequestException);
    });

    it("should throw BadRequest for unknown vcn", async () => {
      prisma.userDeviceBinding.findFirst.mockResolvedValue(mockBinding);
      mockCatalog.find.mockReturnValue(null);
      prisma.deviceConfig.findFirst.mockResolvedValue(baseActiveConfig);

      await expect(
        service.updateVoiceConfig("user-001", "dev-001", { vcn: "9999999" }),
      ).rejects.toThrow(BadRequestException);
    });

    it("should throw BadRequest for non-TRAINED vcn", async () => {
      prisma.userDeviceBinding.findFirst.mockResolvedValue(mockBinding);
      mockCatalog.find.mockReturnValue({
        timbreId: "1000099",
        status: "UNTRAINED",
      });
      prisma.deviceConfig.findFirst.mockResolvedValue(baseActiveConfig);

      await expect(
        service.updateVoiceConfig("user-001", "dev-001", { vcn: "1000099" }),
      ).rejects.toThrow(BadRequestException);
    });

    it("should fall back to defaults and write null payload when no baseline config exists", async () => {
      prisma.userDeviceBinding.findFirst.mockResolvedValue(mockBinding);
      prisma.deviceConfig.findFirst.mockResolvedValue(null);
      prisma.deviceConfig.updateMany.mockResolvedValue({ count: 0 });
      prisma.deviceConfig.create.mockResolvedValue({
        id: "config-voice-bootstrap",
        deviceId: "device-uuid-001",
        mode: "free_chat",
        cefrLevel: null,
        language: "bilingual",
        speechRate: "slow",
        payload: null,
        isActive: true,
        createdAt: new Date(),
      });
      mockReconcile.resolveNormalSpd.mockReturnValue(0.7);
      mockReconcile.applyToActiveInstance.mockResolvedValue({
        applied: "noop",
      });

      const result = await service.updateVoiceConfig("user-001", "dev-001", {
        speechRate: "slow",
      });

      expect(prisma.deviceConfig.create).toHaveBeenCalledWith({
        data: {
          deviceId: "device-uuid-001",
          mode: "free_chat",
          cefrLevel: null,
          language: "bilingual",
          speechRate: "slow",
          isActive: true,
          payload: null,
        },
      });
      expect(result.speechRate).toBe("slow");
      expect(result.vcn).toBeNull();
      expect(result.applied).toBe("noop");
      expect(result.reason).toBeNull();
    });

    it("should succeed with only vcn and return live outcome", async () => {
      prisma.userDeviceBinding.findFirst.mockResolvedValue(mockBinding);
      mockCatalog.find.mockReturnValue({
        timbreId: "1000063",
        status: "TRAINED",
      });
      prisma.deviceConfig.findFirst.mockResolvedValue(baseActiveConfig);
      prisma.deviceConfig.updateMany.mockResolvedValue({ count: 1 });
      prisma.deviceConfig.create.mockResolvedValue({
        id: "config-voice-1",
        deviceId: "device-uuid-001",
        mode: "free_chat",
        cefrLevel: "A1",
        language: "bilingual",
        speechRate: "normal",
        payload: { voice: { vcn: "1000063", updatedAt: expect.any(String) } },
        isActive: true,
        createdAt: new Date(),
      });
      mockReconcile.resolveNormalSpd.mockReturnValue(1);
      mockReconcile.applyToActiveInstance.mockResolvedValue({
        applied: "live",
      });

      const result = await service.updateVoiceConfig("user-001", "dev-001", {
        vcn: "1000063",
      });

      expect(result.deviceId).toBe("dev-001");
      expect(result.vcn).toBe("1000063");
      expect(result.speechRate).toBe("normal");
      expect(result.spd).toBe(1);
      expect(result.applied).toBe("live");
      expect(result.reason).toBeNull();

      // Assert old config was deactivated
      expect(prisma.deviceConfig.updateMany).toHaveBeenCalledWith({
        where: { deviceId: "device-uuid-001", isActive: true },
        data: { isActive: false },
      });
    });

    it("should copy baseline mode/cefrLevel/language and set new speechRate in created config", async () => {
      prisma.userDeviceBinding.findFirst.mockResolvedValue(mockBinding);
      mockCatalog.find.mockReturnValue({
        timbreId: "1000063",
        status: "TRAINED",
      });
      prisma.deviceConfig.findFirst.mockResolvedValue({
        ...baseActiveConfig,
        mode: "english_chat",
        cefrLevel: "B1",
        language: "en",
        speechRate: "slow",
      });
      prisma.deviceConfig.updateMany.mockResolvedValue({ count: 1 });
      mockReconcile.resolveNormalSpd.mockReturnValue(0.8);
      mockReconcile.applyToActiveInstance.mockResolvedValue({
        applied: "live",
      });

      // We need to capture the create call to assert the payload
      let createData: Record<string, unknown>;
      prisma.deviceConfig.create.mockImplementation(
        (args: { data: Record<string, unknown> }) => {
          createData = args.data;
          return Promise.resolve({
            id: "config-voice-2",
            deviceId: "device-uuid-001",
            ...createData,
            createdAt: new Date(),
          } satisfies Record<string, unknown>);
        },
      );

      await service.updateVoiceConfig("user-001", "dev-001", {
        vcn: "1000063",
        speechRate: "fast",
      });

      expect(createData.mode).toBe("english_chat");
      expect(createData.cefrLevel).toBe("B1");
      expect(createData.language).toBe("en");
      expect(createData.speechRate).toBe("fast");
      expect(createData.isActive).toBe(true);
      expect(createData.payload).toEqual({
        [VOICE_PAYLOAD_KEY]: { vcn: "1000063", updatedAt: expect.any(String) },
      });
    });

    it("should not write voice key in payload when final vcn is null", async () => {
      prisma.userDeviceBinding.findFirst.mockResolvedValue(mockBinding);
      // Baseline has no vcn
      prisma.deviceConfig.findFirst.mockResolvedValue({
        ...baseActiveConfig,
        payload: { someOther: "data" },
      });
      prisma.deviceConfig.updateMany.mockResolvedValue({ count: 1 });
      mockReconcile.resolveNormalSpd.mockReturnValue(1);
      mockReconcile.applyToActiveInstance.mockResolvedValue({
        applied: "noop",
      });

      let createData: Record<string, unknown>;
      prisma.deviceConfig.create.mockImplementation(
        (args: { data: Record<string, unknown> }) => {
          createData = args.data;
          return Promise.resolve({
            id: "config-voice-3",
            deviceId: "device-uuid-001",
            ...createData,
            createdAt: new Date(),
          } satisfies Record<string, unknown>);
        },
      );

      await service.updateVoiceConfig("user-001", "dev-001", {
        speechRate: "slow",
      });

      // vcn was null in baseline and not provided, so payload should not have voice key
      expect(createData.payload).toEqual({ someOther: "data" });
    });

    it("should return deferred when reconcile returns deferred", async () => {
      prisma.userDeviceBinding.findFirst.mockResolvedValue(mockBinding);
      mockCatalog.find.mockReturnValue({
        timbreId: "1000063",
        status: "TRAINED",
      });
      prisma.deviceConfig.findFirst.mockResolvedValue(baseActiveConfig);
      prisma.deviceConfig.updateMany.mockResolvedValue({ count: 1 });
      prisma.deviceConfig.create.mockResolvedValue({
        id: "config-voice-4",
        deviceId: "device-uuid-001",
        mode: "free_chat",
        cefrLevel: "A1",
        language: "bilingual",
        speechRate: "normal",
        payload: { voice: { vcn: "1000063" } },
        isActive: true,
        createdAt: new Date(),
      });
      mockReconcile.resolveNormalSpd.mockReturnValue(1);
      mockReconcile.applyToActiveInstance.mockResolvedValue({
        applied: "deferred",
        reason: "no_active_instance",
      });

      const result = await service.updateVoiceConfig("user-001", "dev-001", {
        vcn: "1000063",
      });

      expect(result.applied).toBe("deferred");
      expect(result.reason).toBe("no_active_instance");
    });

    it("should return deferred on reconcile exception without throwing 500", async () => {
      prisma.userDeviceBinding.findFirst.mockResolvedValue(mockBinding);
      mockCatalog.find.mockReturnValue({
        timbreId: "1000063",
        status: "TRAINED",
      });
      prisma.deviceConfig.findFirst.mockResolvedValue(baseActiveConfig);
      prisma.deviceConfig.updateMany.mockResolvedValue({ count: 1 });
      prisma.deviceConfig.create.mockResolvedValue({
        id: "config-voice-5",
        deviceId: "device-uuid-001",
        mode: "free_chat",
        cefrLevel: "A1",
        language: "bilingual",
        speechRate: "normal",
        payload: { voice: { vcn: "1000063" } },
        isActive: true,
        createdAt: new Date(),
      });
      mockReconcile.resolveNormalSpd.mockReturnValue(1);
      mockReconcile.applyToActiveInstance.mockRejectedValue(
        new Error("network failure"),
      );

      const result = await service.updateVoiceConfig("user-001", "dev-001", {
        vcn: "1000063",
      });

      // Must not throw — config was persisted
      expect(result.applied).toBe("deferred");
      expect(result.reason).toBe("internal_error");
      expect(result.vcn).toBe("1000063");
    });

    it("should throw ForbiddenException when user does not own the device", async () => {
      prisma.userDeviceBinding.findFirst.mockResolvedValue(null);

      await expect(
        service.updateVoiceConfig("user-001", "dev-001", { vcn: "1000063" }),
      ).rejects.toThrow(ForbiddenException);
    });
  });
});
