import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { SleepConfigsService } from "./sleep-configs.service";
import { PrismaService } from "@/common/prisma/prisma.service";
import { UpdateSleepConfigDto } from "./dto/update-sleep-config.dto";

describe("SleepConfigsService", () => {
  let service: SleepConfigsService;
  let prisma: any;

  const mockBinding = {
    id: "binding-001",
    userId: "user-001",
    deviceId: "device-uuid-001",
    device: { id: "device-uuid-001", deviceId: "dev-001" },
  };

  const existingConfig = {
    id: "sleep-001",
    deviceId: "device-uuid-001",
    enabled: true,
    durationMode: "custom",
    durationMinutes: 20,
    contentType: "story",
    sleepTime: "21:30",
    forceSleep: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SleepConfigsService,
        {
          provide: PrismaService,
          useValue: {
            userDeviceBinding: {
              findFirst: jest.fn(),
            },
            sleepConfig: {
              findUnique: jest.fn(),
              upsert: jest.fn(),
            },
          },
        },
      ],
    }).compile();

    service = module.get<SleepConfigsService>(SleepConfigsService);
    prisma = module.get(PrismaService);
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  describe("getByDevice", () => {
    it("should return sleep config for bound device", async () => {
      prisma.userDeviceBinding.findFirst.mockResolvedValue(mockBinding);
      prisma.sleepConfig.findUnique.mockResolvedValue(existingConfig);

      const result = await service.getByDevice("user-001", "dev-001");

      expect(prisma.userDeviceBinding.findFirst).toHaveBeenCalledWith({
        where: { userId: "user-001", device: { deviceId: "dev-001" } },
        include: { device: true },
      });
      expect(prisma.sleepConfig.findUnique).toHaveBeenCalledWith({
        where: { deviceId: "device-uuid-001" },
      });
      expect(result).toEqual(existingConfig);
    });

    it("should return null when config not set", async () => {
      prisma.userDeviceBinding.findFirst.mockResolvedValue(mockBinding);
      prisma.sleepConfig.findUnique.mockResolvedValue(null);

      const result = await service.getByDevice("user-001", "dev-001");

      expect(result).toBeNull();
    });

    it("should throw ForbiddenException when user does not own the device", async () => {
      prisma.userDeviceBinding.findFirst.mockResolvedValue(null);

      await expect(service.getByDevice("user-001", "dev-001")).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  describe("upsertByDevice", () => {
    it("should create config with defaults plus provided fields on first PATCH", async () => {
      prisma.userDeviceBinding.findFirst.mockResolvedValue(mockBinding);
      prisma.sleepConfig.findUnique.mockResolvedValue(null);
      prisma.sleepConfig.upsert.mockResolvedValue(existingConfig);

      const result = await service.upsertByDevice("user-001", "dev-001", {
        enabled: true,
        sleepTime: "21:00",
      });

      expect(prisma.sleepConfig.upsert).toHaveBeenCalledWith({
        where: { deviceId: "device-uuid-001" },
        update: {
          enabled: true,
          durationMode: undefined,
          durationMinutes: null,
          contentType: undefined,
          sleepTime: "21:00",
          forceSleep: undefined,
        },
        create: {
          deviceId: "device-uuid-001",
          enabled: true,
          durationMode: undefined,
          durationMinutes: null,
          contentType: undefined,
          sleepTime: "21:00",
          forceSleep: undefined,
        },
      });
      expect(result).toEqual(existingConfig);
    });

    it("should partially update only provided fields on existing config", async () => {
      prisma.userDeviceBinding.findFirst.mockResolvedValue(mockBinding);
      prisma.sleepConfig.findUnique.mockResolvedValue(existingConfig);
      prisma.sleepConfig.upsert.mockResolvedValue({
        ...existingConfig,
        contentType: "mixed",
      });

      await service.upsertByDevice("user-001", "dev-001", {
        contentType: "mixed",
      });

      expect(prisma.sleepConfig.upsert).toHaveBeenCalledWith({
        where: { deviceId: "device-uuid-001" },
        update: {
          enabled: undefined,
          durationMode: undefined,
          durationMinutes: 20, // 沿用已存值（effective custom）
          contentType: "mixed",
          sleepTime: undefined,
          forceSleep: undefined,
        },
        create: {
          deviceId: "device-uuid-001",
          enabled: undefined,
          durationMode: undefined,
          durationMinutes: 20,
          contentType: "mixed",
          sleepTime: undefined,
          forceSleep: undefined,
        },
      });
    });

    it("should reject custom mode without durationMinutes", async () => {
      prisma.userDeviceBinding.findFirst.mockResolvedValue(mockBinding);
      prisma.sleepConfig.findUnique.mockResolvedValue(null);

      await expect(
        service.upsertByDevice("user-001", "dev-001", {
          durationMode: "custom",
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("should reject explicit null durationMinutes in custom mode", async () => {
      prisma.userDeviceBinding.findFirst.mockResolvedValue(mockBinding);
      prisma.sleepConfig.findUnique.mockResolvedValue(existingConfig);

      await expect(
        service.upsertByDevice("user-001", "dev-001", {
          durationMinutes: null,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("should accept custom mode with valid durationMinutes", async () => {
      prisma.userDeviceBinding.findFirst.mockResolvedValue(mockBinding);
      prisma.sleepConfig.findUnique.mockResolvedValue(null);
      prisma.sleepConfig.upsert.mockResolvedValue(existingConfig);

      await service.upsertByDevice("user-001", "dev-001", {
        durationMode: "custom",
        durationMinutes: 15,
      });

      expect(prisma.sleepConfig.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            durationMode: "custom",
            durationMinutes: 15,
          }),
        }),
      );
    });

    it("should accept durationMinutes alone when existing mode is custom", async () => {
      prisma.userDeviceBinding.findFirst.mockResolvedValue(mockBinding);
      prisma.sleepConfig.findUnique.mockResolvedValue(existingConfig);
      prisma.sleepConfig.upsert.mockResolvedValue(existingConfig);

      await service.upsertByDevice("user-001", "dev-001", {
        durationMinutes: 25,
      });

      expect(prisma.sleepConfig.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({ durationMinutes: 25 }),
        }),
      );
    });

    it("should clear durationMinutes when effective mode is default", async () => {
      prisma.userDeviceBinding.findFirst.mockResolvedValue(mockBinding);
      prisma.sleepConfig.findUnique.mockResolvedValue(existingConfig);
      prisma.sleepConfig.upsert.mockResolvedValue({
        ...existingConfig,
        durationMode: "default",
        durationMinutes: null,
      });

      await service.upsertByDevice("user-001", "dev-001", {
        durationMode: "default",
      });

      expect(prisma.sleepConfig.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            durationMode: "default",
            durationMinutes: null,
          }),
        }),
      );
    });

    it("should ignore durationMinutes when effective mode is default", async () => {
      prisma.userDeviceBinding.findFirst.mockResolvedValue(mockBinding);
      prisma.sleepConfig.findUnique.mockResolvedValue(null);
      prisma.sleepConfig.upsert.mockResolvedValue(existingConfig);

      await service.upsertByDevice("user-001", "dev-001", {
        durationMinutes: 15,
      });

      expect(prisma.sleepConfig.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ durationMinutes: null }),
        }),
      );
    });

    it("should upsert with defaults when dto is empty", async () => {
      prisma.userDeviceBinding.findFirst.mockResolvedValue(mockBinding);
      prisma.sleepConfig.findUnique.mockResolvedValue(null);
      prisma.sleepConfig.upsert.mockResolvedValue(existingConfig);

      await service.upsertByDevice("user-001", "dev-001", {});

      expect(prisma.sleepConfig.upsert).toHaveBeenCalledWith({
        where: { deviceId: "device-uuid-001" },
        update: {
          enabled: undefined,
          durationMode: undefined,
          durationMinutes: null,
          contentType: undefined,
          sleepTime: undefined,
          forceSleep: undefined,
        },
        create: {
          deviceId: "device-uuid-001",
          enabled: undefined,
          durationMode: undefined,
          durationMinutes: null,
          contentType: undefined,
          sleepTime: undefined,
          forceSleep: undefined,
        },
      });
    });

    it("should throw ForbiddenException when user does not own the device", async () => {
      prisma.userDeviceBinding.findFirst.mockResolvedValue(null);

      await expect(
        service.upsertByDevice("user-001", "dev-001", { enabled: true }),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe("applyVoiceUpdate", () => {
    it("should upsert patch by internal device id without ownership check", async () => {
      prisma.sleepConfig.upsert.mockResolvedValue(existingConfig);

      await service.applyVoiceUpdate("device-uuid-001", {
        contentType: "song",
      });

      expect(prisma.sleepConfig.upsert).toHaveBeenCalledWith({
        where: { deviceId: "device-uuid-001" },
        update: { contentType: "song" },
        create: { deviceId: "device-uuid-001", contentType: "song" },
      });
      // 语音链路以设备本身为身份，不走用户绑定校验
      expect(prisma.userDeviceBinding.findFirst).not.toHaveBeenCalled();
    });
  });

  describe("getByDeviceId", () => {
    it("should return config by internal device id or null", async () => {
      prisma.sleepConfig.findUnique.mockResolvedValue(existingConfig);

      const result = await service.getByDeviceId("device-uuid-001");

      expect(prisma.sleepConfig.findUnique).toHaveBeenCalledWith({
        where: { deviceId: "device-uuid-001" },
      });
      expect(result).toEqual(existingConfig);
    });
  });
});

describe("UpdateSleepConfigDto validation", () => {
  async function validateDto(plain: Record<string, unknown>) {
    const dto = plainToInstance(UpdateSleepConfigDto, plain);
    return validate(dto);
  }

  it("should accept a full valid dto", async () => {
    const errors = await validateDto({
      enabled: true,
      durationMode: "custom",
      durationMinutes: 30,
      contentType: "song",
      sleepTime: "20:45",
      forceSleep: true,
    });
    expect(errors).toHaveLength(0);
  });

  it("should accept empty dto", async () => {
    const errors = await validateDto({});
    expect(errors).toHaveLength(0);
  });

  it("should accept null durationMinutes (cleared at pipe level)", async () => {
    const errors = await validateDto({ durationMinutes: null });
    expect(errors).toHaveLength(0);
  });

  it("should reject sleepTime outside HH:mm range", async () => {
    const errors = await validateDto({ sleepTime: "25:00" });
    expect(errors.length).toBeGreaterThan(0);

    const errors2 = await validateDto({ sleepTime: "9:30" });
    expect(errors2.length).toBeGreaterThan(0);

    const errors3 = await validateDto({ sleepTime: "21:60" });
    expect(errors3.length).toBeGreaterThan(0);
  });

  it("should reject invalid contentType", async () => {
    const errors = await validateDto({ contentType: "video" });
    expect(errors.length).toBeGreaterThan(0);
  });

  it("should reject invalid durationMode", async () => {
    const errors = await validateDto({ durationMode: "auto" });
    expect(errors.length).toBeGreaterThan(0);
  });

  it("should reject durationMinutes outside the allowed set", async () => {
    const errors = await validateDto({ durationMinutes: 12 });
    expect(errors.length).toBeGreaterThan(0);
  });

  it("should reject non-boolean enabled", async () => {
    const errors = await validateDto({ enabled: "yes" });
    expect(errors.length).toBeGreaterThan(0);
  });
});
