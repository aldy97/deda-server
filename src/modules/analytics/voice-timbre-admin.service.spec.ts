import { Test } from "@nestjs/testing";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { VoiceTimbreAdminService } from "./voice-timbre-admin.service";
import { PrismaService } from "@/common/prisma/prisma.service";
import { CHARACTER_TIMBRE_PORT } from "@/modules/baidu-agent/baidu-agent.types";

const prismaError = (code: string) => Object.assign(new Error(code), { code });

describe("VoiceTimbreAdminService", () => {
  let service: VoiceTimbreAdminService;
  let prisma: {
    characterTimbre: {
      findMany: jest.Mock;
      findUnique: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      delete: jest.Mock;
    };
    device: { groupBy: jest.Mock; count: jest.Mock };
  };
  let cache: {
    get: jest.Mock;
    list: jest.Mock;
    invalidate: jest.Mock;
    reload: jest.Mock;
  };

  const moduleFor = async () => {
    const module = await Test.createTestingModule({
      providers: [
        VoiceTimbreAdminService,
        { provide: PrismaService, useValue: prisma },
        { provide: CHARACTER_TIMBRE_PORT, useValue: cache },
      ],
    }).compile();
    return module.get(VoiceTimbreAdminService);
  };

  beforeEach(async () => {
    prisma = {
      characterTimbre: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
      device: {
        groupBy: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
    };
    cache = {
      get: jest.fn().mockResolvedValue(null),
      list: jest.fn().mockResolvedValue([]),
      invalidate: jest.fn(),
      reload: jest.fn().mockResolvedValue(undefined),
    };
    service = await moduleFor();
  });

  describe("list", () => {
    it("returns rows with persona status and in-use device counts", async () => {
      prisma.characterTimbre.findMany.mockResolvedValue([
        {
          characterKey: "elly",
          timbreId: "1000957",
          updatedAt: new Date("2026-11-21T00:00:00Z"),
        },
        {
          characterKey: "nemo",
          timbreId: "1009999",
          updatedAt: new Date("2026-11-21T00:00:00Z"),
        },
      ]);
      prisma.device.groupBy.mockResolvedValue([
        { characterKey: "elly", _count: { _all: 3 } },
      ]);

      await expect(service.list()).resolves.toEqual([
        {
          characterKey: "elly",
          timbreId: "1000957",
          updatedAt: "2026-11-21T00:00:00.000Z",
          personaConfigured: true,
          devicesInUse: 3,
        },
        {
          characterKey: "nemo",
          timbreId: "1009999",
          updatedAt: "2026-11-21T00:00:00.000Z",
          personaConfigured: false,
          devicesInUse: 0,
        },
      ]);
    });
  });

  describe("create", () => {
    it("creates the row and invalidates the read cache", async () => {
      prisma.characterTimbre.create.mockResolvedValue({
        characterKey: "nemo",
        timbreId: "1009999",
        updatedAt: new Date("2026-11-21T00:00:00Z"),
      });

      await expect(
        service.create({ characterKey: "nemo", timbreId: "1009999" }),
      ).resolves.toMatchObject({ characterKey: "nemo", timbreId: "1009999" });
      expect(prisma.characterTimbre.create).toHaveBeenCalledWith({
        data: { characterKey: "nemo", timbreId: "1009999" },
      });
      expect(cache.invalidate).toHaveBeenCalled();
    });

    it("maps a duplicate key to 409", async () => {
      prisma.characterTimbre.create.mockRejectedValue(prismaError("P2002"));

      await expect(
        service.create({ characterKey: "elly", timbreId: "1" }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(cache.invalidate).not.toHaveBeenCalled();
    });
  });

  describe("update", () => {
    it("updates the row and invalidates the read cache", async () => {
      prisma.characterTimbre.findUnique.mockResolvedValue({
        characterKey: "elly",
        timbreId: "1000957",
        updatedAt: new Date("2026-11-20T00:00:00Z"),
      });
      prisma.characterTimbre.update.mockResolvedValue({
        characterKey: "elly",
        timbreId: "1000958",
        updatedAt: new Date("2026-11-21T00:00:00Z"),
      });

      await expect(
        service.update("elly", { timbreId: "1000958" }),
      ).resolves.toMatchObject({ timbreId: "1000958" });
      expect(prisma.characterTimbre.update).toHaveBeenCalledWith({
        where: { characterKey: "elly" },
        data: { timbreId: "1000958" },
      });
      expect(cache.invalidate).toHaveBeenCalled();
    });

    it("maps a missing row to 404 before writing", async () => {
      prisma.characterTimbre.findUnique.mockResolvedValue(null);

      await expect(
        service.update("nemo", { timbreId: "1" }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.characterTimbre.update).not.toHaveBeenCalled();
    });

    it("maps a write race (P2025) to 404", async () => {
      prisma.characterTimbre.findUnique.mockResolvedValue({
        characterKey: "elly",
        timbreId: "1000957",
        updatedAt: new Date("2026-11-20T00:00:00Z"),
      });
      prisma.characterTimbre.update.mockRejectedValue(prismaError("P2025"));

      await expect(
        service.update("elly", { timbreId: "1" }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe("remove", () => {
    it("refuses to delete a character that devices still use", async () => {
      prisma.device.count.mockResolvedValue(2);

      const error = await service.remove("elly", false).catch((e) => e);
      expect(error).toBeInstanceOf(ConflictException);
      expect(JSON.stringify(error.getResponse())).toContain("2 台设备在用");
      expect(prisma.characterTimbre.delete).not.toHaveBeenCalled();
    });

    it("deletes when forced even if devices are in use", async () => {
      prisma.device.count.mockResolvedValue(2);
      prisma.characterTimbre.delete.mockResolvedValue({});

      await expect(service.remove("elly", true)).resolves.toBeUndefined();
      expect(prisma.characterTimbre.delete).toHaveBeenCalledWith({
        where: { characterKey: "elly" },
      });
      expect(cache.invalidate).toHaveBeenCalled();
    });

    it("deletes an unused character without force", async () => {
      prisma.device.count.mockResolvedValue(0);
      prisma.characterTimbre.delete.mockResolvedValue({});

      await expect(service.remove("nemo", false)).resolves.toBeUndefined();
      expect(cache.invalidate).toHaveBeenCalled();
    });

    it("maps a missing row to 404", async () => {
      prisma.device.count.mockResolvedValue(0);
      prisma.characterTimbre.delete.mockRejectedValue(prismaError("P2025"));

      await expect(service.remove("nemo", false)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe("unexpected database errors", () => {
    it("rethrows non-P2002 create failures instead of masking them as 409", async () => {
      prisma.characterTimbre.create.mockRejectedValue(prismaError("P1001"));

      await expect(
        service.create({ characterKey: "elly", timbreId: "1" }),
      ).rejects.toMatchObject({ code: "P1001" });
    });

    it("rethrows non-P2025 update failures instead of masking them as 404", async () => {
      prisma.characterTimbre.findUnique.mockResolvedValue({
        characterKey: "elly",
        timbreId: "1000957",
        updatedAt: new Date("2026-11-20T00:00:00Z"),
      });
      prisma.characterTimbre.update.mockRejectedValue(prismaError("P1001"));

      await expect(
        service.update("elly", { timbreId: "1" }),
      ).rejects.toMatchObject({ code: "P1001" });
    });

    it("rethrows non-P2025 delete failures instead of masking them as 404", async () => {
      prisma.device.count.mockResolvedValue(0);
      prisma.characterTimbre.delete.mockRejectedValue(prismaError("P1001"));

      await expect(service.remove("elly", false)).rejects.toMatchObject({
        code: "P1001",
      });
    });
  });
});
