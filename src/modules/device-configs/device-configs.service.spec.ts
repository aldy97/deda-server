import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { validate } from "class-validator";
import { DeviceConfigsService } from "./device-configs.service";
import { PrismaService } from "@/common/prisma/prisma.service";
import { ApplyDeviceConfigDto } from "./dto/apply-device-config.dto";
import { SwitchModeDto } from "./dto/switch-mode.dto";

describe("DeviceConfigsService", () => {
  let service: DeviceConfigsService;
  let prisma: any;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DeviceConfigsService,
        {
          provide: PrismaService,
          useValue: {
            $transaction: jest.fn((cb: any) => cb(prisma)),
            deviceConfig: {
              findFirst: jest.fn(),
              updateMany: jest.fn(),
              create: jest.fn(),
            },
            userDeviceBinding: {
              findFirst: jest.fn(),
            },
            conversationMode: {
              findFirst: jest.fn(),
            },
          },
        },
      ],
    }).compile();

    service = module.get<DeviceConfigsService>(DeviceConfigsService);
    prisma = module.get(PrismaService);
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  const mockBinding = {
    id: "binding-001",
    device: { id: "device-uuid-001", deviceId: "dev-001" },
  };

  describe("current", () => {
    it("should return the latest active config", async () => {
      const activeConfig = {
        id: "config-1",
        deviceId: "device-uuid-001",
        mode: "free_chat",
        conversationModeKey: "free_chat_casual",
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
        conversationModeKey: "free_chat_casual",
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
        conversationModeKey: "free_chat_casual",
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
        conversationModeKey: null,
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
          conversationModeKey: null,
          cefrLevel: null,
          language: "bilingual",
          speechRate: "normal",
          isActive: true,
        },
      });
      expect(prisma.conversationMode.findFirst).not.toHaveBeenCalled();
      expect(result.mode).toBe("english_chat");
      expect(result.conversationModeKey).toBeNull();
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
        conversationModeKey: "free_chat_roleplay",
      };

      prisma.userDeviceBinding.findFirst.mockResolvedValue(mockBinding);
      prisma.conversationMode.findFirst.mockResolvedValue({
        id: "mode-uuid-001",
        key: "free_chat_roleplay",
        isActive: true,
        category: { key: "free_chat" },
      });
      prisma.deviceConfig.updateMany.mockResolvedValue({ count: 1 });
      prisma.deviceConfig.create.mockResolvedValue({
        id: "config-new",
        deviceId: "device-uuid-001",
        mode: "free_chat",
        conversationModeKey: "free_chat_roleplay",
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
          conversationModeKey: "free_chat_roleplay",
          cefrLevel: null,
          language: "bilingual",
          speechRate: "normal",
          isActive: true,
        },
      });
      expect(result.mode).toBe("free_chat");
      expect(result.conversationModeKey).toBe("free_chat_roleplay");
    });

    it("should create a new active config for English chat", async () => {
      const dto: SwitchModeDto = { mode: "english_chat" };

      prisma.userDeviceBinding.findFirst.mockResolvedValue(mockBinding);
      prisma.deviceConfig.updateMany.mockResolvedValue({ count: 1 });
      prisma.deviceConfig.create.mockResolvedValue({
        id: "config-new",
        deviceId: "device-uuid-001",
        mode: "english_chat",
        conversationModeKey: null,
        cefrLevel: null,
        language: "bilingual",
        speechRate: "normal",
        isActive: true,
      });

      const result = await service.switchMode("user-001", "dev-001", dto);

      expect(prisma.conversationMode.findFirst).not.toHaveBeenCalled();
      expect(result.mode).toBe("english_chat");
      expect(result.conversationModeKey).toBeNull();
    });

    it("should throw ForbiddenException when user does not own the device", async () => {
      const dto: SwitchModeDto = { mode: "free_chat" };

      prisma.userDeviceBinding.findFirst.mockResolvedValue(null);

      await expect(
        service.switchMode("user-001", "dev-001", dto),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe("validation rules", () => {
    beforeEach(() => {
      prisma.userDeviceBinding.findFirst.mockResolvedValue(mockBinding);
      prisma.conversationMode.findFirst.mockResolvedValue({
        id: "mode-uuid-001",
        key: "free_chat_casual",
        isActive: true,
        category: { key: "free_chat" },
      });
    });

    it("should reject free_chat without conversationModeKey", async () => {
      await expect(
        service.switchMode("user-001", "dev-001", { mode: "free_chat" }),
      ).rejects.toThrow(BadRequestException);
    });

    it("should reject english_chat with a conversationModeKey", async () => {
      await expect(
        service.switchMode("user-001", "dev-001", {
          mode: "english_chat",
          conversationModeKey: "free_chat_casual",
        }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.conversationMode.findFirst).not.toHaveBeenCalled();
    });

    it("should reject unknown or inactive conversationModeKey", async () => {
      prisma.conversationMode.findFirst.mockResolvedValue(null);

      await expect(
        service.switchMode("user-001", "dev-001", {
          mode: "free_chat",
          conversationModeKey: "not_a_mode",
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("should reject conversationModeKey outside the free_chat category", async () => {
      prisma.conversationMode.findFirst.mockResolvedValue({
        id: "mode-uuid-002",
        key: "other_mode",
        isActive: true,
        category: { key: "english_chat" },
      });

      await expect(
        service.switchMode("user-001", "dev-001", {
          mode: "free_chat",
          conversationModeKey: "other_mode",
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it.each(["textbook_learning", "locked_unit", "free_textbook"])(
      "should reject removed legacy mode %s",
      async (mode) => {
        await expect(
          service.switchMode("user-001", "dev-001", {
            mode,
          } as SwitchModeDto),
        ).rejects.toThrow(BadRequestException);
      },
    );

    it("should reject apply with free_chat missing conversationModeKey", async () => {
      await expect(
        service.apply("user-001", "dev-001", { mode: "free_chat" }),
      ).rejects.toThrow(BadRequestException);
    });

    it("should reject apply with english_chat and a conversationModeKey", async () => {
      await expect(
        service.apply("user-001", "dev-001", {
          mode: "english_chat",
          conversationModeKey: "free_chat_casual",
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

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
});
