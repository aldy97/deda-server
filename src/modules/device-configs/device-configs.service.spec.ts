import { Test, TestingModule } from "@nestjs/testing";
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { validate } from "class-validator";
import { ConfigService } from "@nestjs/config";
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
            textbook: {
              findUnique: jest.fn(),
            },
            unit: {
              findUnique: jest.fn(),
            },
            conversationMode: {
              findFirst: jest.fn(),
            },
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              if (key === "DEFAULT_TEXTBOOK_ID") return "sample-textbook";
              if (key === "DEFAULT_UNIT_ID") return "unit-1";
              return undefined;
            }),
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
        textbookId: null,
        unitId: null,
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
        textbookId: null,
        textbookName: null,
        unitId: null,
        unitName: null,
        cefrLevel: "A1",
        language: "bilingual",
        speechRate: "normal",
      });
    });

    it("should return default config when no active config exists", async () => {
      prisma.userDeviceBinding.findFirst.mockResolvedValue(mockBinding);
      prisma.deviceConfig.findFirst.mockResolvedValue(null);
      prisma.textbook.findUnique.mockResolvedValue({
        id: "textbook-uuid-default",
        name: "Sample Textbook",
      });
      prisma.unit.findUnique.mockResolvedValue({
        id: "unit-uuid-default",
        name: "Unit 1",
      });

      const result = await service.current("user-001", "dev-001");

      expect(result).toEqual({
        deviceId: "dev-001",
        mode: "locked_unit",
        textbookId: "sample-textbook",
        textbookName: "Sample Textbook",
        unitId: "unit-1",
        unitName: "Unit 1",
        conversationModeKey: null,
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
    it("should create a new active config for textbook unit", async () => {
      const dto: ApplyDeviceConfigDto = {
        mode: "locked_unit",
        textbookId: "unlock-l1-speaking-listening",
        unitId: "unit-1",
      };

      prisma.userDeviceBinding.findFirst.mockResolvedValue(mockBinding);
      prisma.textbook = { findUnique: jest.fn() };
      prisma.textbook.findUnique.mockResolvedValue({
        id: "textbook-uuid-001",
        textbookId: "unlock-l1-speaking-listening",
      });
      prisma.unit.findUnique.mockResolvedValue({
        id: "unit-uuid-001",
        unitId: "unit-1",
        textbookId: "textbook-uuid-001",
      });
      prisma.deviceConfig.updateMany.mockResolvedValue({ count: 1 });
      prisma.deviceConfig.create.mockResolvedValue({
        id: "config-new",
        deviceId: "device-uuid-001",
        mode: "locked_unit",
        textbookId: "unlock-l1-speaking-listening",
        unitId: "unit-1",
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
          mode: "locked_unit",
          textbookId: "unlock-l1-speaking-listening",
          unitId: "unit-1",
          conversationModeKey: null,
          cefrLevel: null,
          language: "bilingual",
          speechRate: "normal",
          isActive: true,
        },
      });
      expect(result.mode).toBe("locked_unit");
    });

    it("should throw NotFoundException when textbook does not exist", async () => {
      const dto: ApplyDeviceConfigDto = {
        mode: "locked_unit",
        textbookId: "not-exist",
        unitId: "unit-1",
      };

      prisma.userDeviceBinding.findFirst.mockResolvedValue(mockBinding);
      prisma.textbook = { findUnique: jest.fn() };
      prisma.textbook.findUnique.mockResolvedValue(null);

      await expect(service.apply("user-001", "dev-001", dto)).rejects.toThrow(
        NotFoundException,
      );
    });

    it("should throw NotFoundException when unit does not exist", async () => {
      const dto: ApplyDeviceConfigDto = {
        mode: "locked_unit",
        textbookId: "unlock-l1-speaking-listening",
        unitId: "unit-999",
      };

      prisma.userDeviceBinding.findFirst.mockResolvedValue(mockBinding);
      prisma.textbook = { findUnique: jest.fn() };
      prisma.textbook.findUnique.mockResolvedValue({
        id: "textbook-uuid-001",
        textbookId: "unlock-l1-speaking-listening",
      });
      prisma.unit.findUnique.mockResolvedValue(null);

      await expect(service.apply("user-001", "dev-001", dto)).rejects.toThrow(
        NotFoundException,
      );
    });

    it("should throw ForbiddenException when user does not own the device", async () => {
      const dto: ApplyDeviceConfigDto = {
        mode: "locked_unit",
        textbookId: "unlock-l1-speaking-listening",
        unitId: "unit-1",
      };

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
        textbookId: null,
        unitId: null,
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
          textbookId: null,
          unitId: null,
          cefrLevel: null,
          language: "bilingual",
          speechRate: "normal",
          isActive: true,
        },
      });
      expect(result.mode).toBe("free_chat");
      expect(result.conversationModeKey).toBe("free_chat_roleplay");
    });

    it("should create a new active config for textbook learning mode", async () => {
      const dto: SwitchModeDto = {
        mode: "textbook_learning",
        textbookId: "unlock-l1-speaking-listening",
      };

      prisma.userDeviceBinding.findFirst.mockResolvedValue(mockBinding);
      prisma.textbook.findUnique.mockResolvedValue({
        id: "textbook-uuid-001",
        textbookId: "unlock-l1-speaking-listening",
      });
      prisma.deviceConfig.updateMany.mockResolvedValue({ count: 1 });
      prisma.deviceConfig.create.mockResolvedValue({
        id: "config-new",
        deviceId: "device-uuid-001",
        mode: "textbook_learning",
        conversationModeKey: null,
        textbookId: "unlock-l1-speaking-listening",
        unitId: null,
        cefrLevel: null,
        language: "bilingual",
        speechRate: "normal",
        isActive: true,
      });

      const result = await service.switchMode("user-001", "dev-001", dto);

      expect(result.mode).toBe("textbook_learning");
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
      prisma.textbook.findUnique.mockResolvedValue({
        id: "textbook-uuid-001",
        textbookId: "unlock-l1-speaking-listening",
      });
      prisma.unit.findUnique.mockResolvedValue({
        id: "unit-uuid-001",
        unitId: "unit-1",
        textbookId: "textbook-uuid-001",
      });
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

    it("should reject free_chat with textbookId", async () => {
      await expect(
        service.switchMode("user-001", "dev-001", {
          mode: "free_chat",
          conversationModeKey: "free_chat_casual",
          textbookId: "unlock-l1-speaking-listening",
        }),
      ).rejects.toThrow(BadRequestException);
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

    it("should reject conversationModeKey whose category mismatches the mode", async () => {
      prisma.conversationMode.findFirst.mockResolvedValue({
        id: "mode-uuid-002",
        key: "textbook_follow",
        isActive: true,
        category: { key: "textbook_learning" },
      });

      await expect(
        service.switchMode("user-001", "dev-001", {
          mode: "free_chat",
          conversationModeKey: "textbook_follow",
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("should reject textbook_learning without textbookId", async () => {
      await expect(
        service.switchMode("user-001", "dev-001", {
          mode: "textbook_learning",
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("should reject locked_unit without unitId", async () => {
      await expect(
        service.switchMode("user-001", "dev-001", {
          mode: "locked_unit",
          textbookId: "unlock-l1-speaking-listening",
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("should reject free_textbook with unitId", async () => {
      await expect(
        service.switchMode("user-001", "dev-001", {
          mode: "free_textbook",
          textbookId: "unlock-l1-speaking-listening",
          unitId: "unit-1",
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("should accept textbook-category conversationModeKey for textbook_learning", async () => {
      prisma.conversationMode.findFirst.mockResolvedValue({
        id: "mode-uuid-002",
        key: "textbook_follow",
        isActive: true,
        category: { key: "textbook_learning" },
      });
      prisma.deviceConfig.updateMany.mockResolvedValue({ count: 1 });
      prisma.deviceConfig.create.mockResolvedValue({
        id: "config-new",
        deviceId: "device-uuid-001",
        mode: "textbook_learning",
        conversationModeKey: "textbook_follow",
        textbookId: "unlock-l1-speaking-listening",
        unitId: null,
        cefrLevel: null,
        language: "bilingual",
        speechRate: "normal",
        isActive: true,
      });

      const result = await service.switchMode("user-001", "dev-001", {
        mode: "textbook_learning",
        textbookId: "unlock-l1-speaking-listening",
        conversationModeKey: "textbook_follow",
      });

      expect(result.conversationModeKey).toBe("textbook_follow");
    });

    it("should throw NotFoundException in switchMode when textbook does not exist", async () => {
      prisma.textbook.findUnique.mockResolvedValue(null);

      await expect(
        service.switchMode("user-001", "dev-001", {
          mode: "textbook_learning",
          textbookId: "not-exist",
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it("should throw NotFoundException in switchMode when unit does not exist", async () => {
      prisma.unit.findUnique.mockResolvedValue(null);

      await expect(
        service.switchMode("user-001", "dev-001", {
          mode: "locked_unit",
          textbookId: "unlock-l1-speaking-listening",
          unitId: "unit-999",
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it("should reject apply with free_chat missing conversationModeKey", async () => {
      await expect(
        service.apply("user-001", "dev-001", { mode: "free_chat" }),
      ).rejects.toThrow(BadRequestException);
    });

    it("should reject apply with textbook_learning missing textbookId", async () => {
      await expect(
        service.apply("user-001", "dev-001", { mode: "textbook_learning" }),
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
      for (const mode of [
        "free_chat",
        "textbook_learning",
        "locked_unit",
        "free_textbook",
      ]) {
        const dto = Object.assign(new SwitchModeDto(), { mode });
        const errors = await validate(dto);
        expect(errors).toHaveLength(0);
      }
    });
  });
});
