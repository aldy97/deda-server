import { Test } from "@nestjs/testing";
import { PrismaService } from "@/common/prisma/prisma.service";
import { SpeechRateAdminService } from "./speech-rate-admin.service";

describe("SpeechRateAdminService", () => {
  let service: SpeechRateAdminService;
  let prisma: {
    speechRateConfig: { findMany: jest.Mock; upsert: jest.Mock };
    $transaction: jest.Mock;
  };

  beforeEach(async () => {
    prisma = {
      speechRateConfig: {
        findMany: jest.fn(),
        upsert: jest.fn(),
      },
      $transaction: jest.fn(),
    };
    const module = await Test.createTestingModule({
      providers: [
        SpeechRateAdminService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = module.get(SpeechRateAdminService);
  });

  describe("list", () => {
    it("should return rows ordered by tier ascending", async () => {
      prisma.speechRateConfig.findMany.mockResolvedValue([
        { tier: "fast", spd: 0.875 },
        { tier: "normal", spd: 0.7 },
        { tier: "slow", spd: 0.56 },
      ]);

      await expect(service.list()).resolves.toEqual([
        { tier: "fast", spd: 0.875 },
        { tier: "normal", spd: 0.7 },
        { tier: "slow", spd: 0.56 },
      ]);
      expect(prisma.speechRateConfig.findMany).toHaveBeenCalledWith({
        orderBy: { tier: "asc" },
      });
    });
  });

  describe("upsert", () => {
    it("should upsert each item in a transaction and return the refreshed list", async () => {
      prisma.$transaction.mockImplementation(async (ops: unknown[]) => {
        await Promise.all(ops as Promise<unknown>[]);
      });
      prisma.speechRateConfig.upsert.mockResolvedValue({});
      prisma.speechRateConfig.findMany.mockResolvedValue([
        { tier: "normal", spd: 0.7 },
      ]);

      const result = await service.upsert([
        { tier: "slow", spd: 0.56 },
        { tier: "normal", spd: 0.7 },
      ]);

      expect(prisma.speechRateConfig.upsert).toHaveBeenCalledTimes(2);
      expect(prisma.speechRateConfig.upsert).toHaveBeenCalledWith({
        where: { tier: "slow" },
        update: { spd: 0.56 },
        create: { tier: "slow", spd: 0.56 },
      });
      expect(result).toEqual([{ tier: "normal", spd: 0.7 }]);
    });
  });
});
