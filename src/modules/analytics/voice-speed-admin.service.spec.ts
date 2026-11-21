import { Test } from "@nestjs/testing";
import { PrismaService } from "@/common/prisma/prisma.service";
import { VoiceSpeedAdminService } from "./voice-speed-admin.service";

describe("VoiceSpeedAdminService", () => {
  let service: VoiceSpeedAdminService;
  let prisma: {
    voiceSpeedConfig: { findUnique: jest.Mock; upsert: jest.Mock };
  };

  beforeEach(async () => {
    prisma = {
      voiceSpeedConfig: {
        findUnique: jest.fn(),
        upsert: jest.fn(),
      },
    };
    const module = await Test.createTestingModule({
      providers: [
        VoiceSpeedAdminService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = module.get(VoiceSpeedAdminService);
  });

  describe("get", () => {
    it("should return the stored speeds", async () => {
      prisma.voiceSpeedConfig.findUnique.mockResolvedValue({
        id: "default",
        normalSpd: 0.7,
        sleepSpd: 0.5,
      });
      await expect(service.get()).resolves.toEqual({
        normalSpd: 0.7,
        sleepSpd: 0.5,
      });
    });

    it("should fall back to defaults when row is missing", async () => {
      prisma.voiceSpeedConfig.findUnique.mockResolvedValue(null);
      await expect(service.get()).resolves.toEqual({
        normalSpd: 0.7,
        sleepSpd: 0.5,
      });
    });
  });

  describe("update", () => {
    it("should upsert and return the refreshed config", async () => {
      prisma.voiceSpeedConfig.upsert.mockResolvedValue({});
      prisma.voiceSpeedConfig.findUnique.mockResolvedValue({
        id: "default",
        normalSpd: 0.6,
        sleepSpd: 0.4,
      });
      await expect(
        service.update({ normalSpd: 0.6, sleepSpd: 0.4 }),
      ).resolves.toEqual({ normalSpd: 0.6, sleepSpd: 0.4 });
      expect(prisma.voiceSpeedConfig.upsert).toHaveBeenCalledWith({
        where: { id: "default" },
        update: { normalSpd: 0.6, sleepSpd: 0.4 },
        create: { id: "default", normalSpd: 0.6, sleepSpd: 0.4 },
      });
    });
  });
});
