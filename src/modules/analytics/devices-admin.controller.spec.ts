import { Test, TestingModule } from "@nestjs/testing";
import { NotFoundException } from "@nestjs/common";
import { DevicesAdminController } from "./devices-admin.controller";
import { AnalyticsAuthGuard } from "./guards/analytics-auth.guard";
import { PrismaService } from "@/common/prisma/prisma.service";
import { DeviceLinkService } from "../device-link/device-link.service";

describe("DevicesAdminController", () => {
  let controller: DevicesAdminController;
  let prisma: any;
  let deviceLink: any;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [DevicesAdminController],
      providers: [
        {
          provide: PrismaService,
          useValue: {
            device: {
              findUnique: jest.fn(),
              delete: jest.fn().mockResolvedValue({}),
            },
          },
        },
        {
          provide: DeviceLinkService,
          useValue: {
            getStatus: jest.fn(),
            factoryReset: jest.fn(),
          },
        },
      ],
    }).compile();

    controller = module.get<DevicesAdminController>(DevicesAdminController);
    prisma = module.get(PrismaService);
    deviceLink = module.get(DeviceLinkService);
  });

  it("should be guarded by AnalyticsAuthGuard", () => {
    const guards = Reflect.getMetadata("__guards__", DevicesAdminController);
    expect(guards).toBeDefined();
    expect(guards).toContain(AnalyticsAuthGuard);
  });

  describe("wipe", () => {
    it("should send factory reset and delete device with all related data when online", async () => {
      prisma.device.findUnique.mockResolvedValue({
        id: "device-uuid-001",
        deviceId: "AABBCCDDEEFF",
        macAddress: "AABBCCDDEEFF",
      });
      deviceLink.getStatus.mockResolvedValue({
        mac: "AABBCCDDEEFF",
        battery: 80,
        volume: 50,
        version: "1.2.3",
        lastSeenAt: Date.now(),
        online: true,
      });

      const result = await controller.wipe("AABBCCDDEEFF");

      expect(deviceLink.factoryReset).toHaveBeenCalledWith("AABBCCDDEEFF");
      expect(prisma.device.delete).toHaveBeenCalledWith({
        where: { id: "device-uuid-001" },
      });
      expect(result).toEqual({
        success: true,
        deviceId: "AABBCCDDEEFF",
        deviceOnline: true,
      });
    });

    it("should still wipe data when device offline and report deviceOnline=false", async () => {
      prisma.device.findUnique.mockResolvedValue({
        id: "device-uuid-002",
        deviceId: "dev-002",
        macAddress: null,
      });
      deviceLink.getStatus.mockResolvedValue({
        mac: "dev-002",
        battery: null,
        volume: null,
        version: null,
        lastSeenAt: null,
        online: false,
      });

      const result = await controller.wipe("dev-002");

      // macAddress 缺失时回落到 deviceId
      expect(deviceLink.factoryReset).toHaveBeenCalledWith("dev-002");
      expect(prisma.device.delete).toHaveBeenCalledWith({
        where: { id: "device-uuid-002" },
      });
      expect(result.deviceOnline).toBe(false);
    });

    it("should send recover before deleting the device row", async () => {
      const callOrder: string[] = [];
      prisma.device.findUnique.mockResolvedValue({
        id: "device-uuid-003",
        deviceId: "dev-003",
        macAddress: "AABBCCDDEEFF",
      });
      deviceLink.getStatus.mockResolvedValue({ online: true });
      deviceLink.factoryReset.mockImplementation(() => {
        callOrder.push("factoryReset");
      });
      prisma.device.delete.mockImplementation(() => {
        callOrder.push("delete");
        return Promise.resolve({});
      });

      await controller.wipe("dev-003");

      expect(callOrder).toEqual(["factoryReset", "delete"]);
    });

    it("should throw NotFoundException when device not found", async () => {
      prisma.device.findUnique.mockResolvedValue(null);

      await expect(controller.wipe("dev-999")).rejects.toThrow(
        NotFoundException,
      );
      expect(deviceLink.factoryReset).not.toHaveBeenCalled();
      expect(prisma.device.delete).not.toHaveBeenCalled();
    });
  });
});
