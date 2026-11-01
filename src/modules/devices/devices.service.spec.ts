import { Test, TestingModule } from "@nestjs/testing";
import { NotFoundException } from "@nestjs/common";
import { DevicesService } from "./devices.service";
import { PrismaService } from "@/common/prisma/prisma.service";
import { DeviceStatusService } from "../device-status/device-status.service";
import { ManufacturerService } from "../manufacturer/manufacturer.service";
import { BindDeviceDto } from "./dto/bind-device.dto";
import { DeviceControlDto } from "./dto/device-control.dto";
import { WifiConfigDto } from "./dto/wifi-config.dto";

describe("DevicesService", () => {
  let service: DevicesService;
  let prisma: any;
  let deviceStatusService: any;
  let manufacturer: any;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DevicesService,
        {
          provide: PrismaService,
          useValue: {
            $transaction: jest.fn((callback: any) => callback(prisma)),
            device: {
              findUnique: jest.fn(),
              findMany: jest.fn(),
              create: jest.fn(),
            },
            userDeviceBinding: {
              findUnique: jest.fn(),
              findMany: jest.fn(),
              findFirst: jest.fn(),
              aggregate: jest
                .fn()
                .mockResolvedValue({ _max: { sortOrder: -1 } }),
              create: jest.fn(),
              update: jest.fn(),
              deleteMany: jest.fn(),
            },
          },
        },
        {
          provide: DeviceStatusService,
          useValue: {
            getStatus: jest.fn(),
          },
        },
        {
          provide: ManufacturerService,
          useValue: {
            controlVolume: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<DevicesService>(DevicesService);
    prisma = module.get(PrismaService);
    deviceStatusService = module.get(DeviceStatusService);
    manufacturer = module.get(ManufacturerService);
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  describe("bind", () => {
    it("should create device and binding when both are new", async () => {
      const dto: BindDeviceDto = {
        deviceId: "dev-001",
        childProfileId: "child-001",
      };

      prisma.device.findUnique.mockResolvedValue(null);
      prisma.device.create.mockResolvedValue({
        id: "device-uuid-001",
        deviceId: "dev-001",
      });
      prisma.userDeviceBinding.findUnique.mockResolvedValue(null);
      prisma.userDeviceBinding.create.mockResolvedValue({ id: "binding-001" });

      const result = await service.bind("user-001", dto);

      expect(prisma.device.create).toHaveBeenCalledWith({
        data: { deviceId: "dev-001" },
      });
      expect(prisma.userDeviceBinding.aggregate).toHaveBeenCalledWith({
        where: { userId: "user-001" },
        _max: { sortOrder: true },
      });
      expect(prisma.userDeviceBinding.create).toHaveBeenCalledWith({
        data: {
          userId: "user-001",
          deviceId: "device-uuid-001",
          isOwner: true,
          sortOrder: 0,
        },
      });
      expect(result).toEqual({
        success: true,
        deviceId: "dev-001",
        alreadyBound: false,
      });
    });

    it("should reuse existing device and binding", async () => {
      const dto: BindDeviceDto = {
        deviceId: "dev-002",
      };

      prisma.device.findUnique.mockResolvedValue({
        id: "device-uuid-002",
        deviceId: "dev-002",
      });
      prisma.userDeviceBinding.findUnique.mockResolvedValue({
        id: "binding-002",
      });

      const result = await service.bind("user-001", dto);

      expect(prisma.device.create).not.toHaveBeenCalled();
      expect(prisma.userDeviceBinding.create).not.toHaveBeenCalled();
      expect(result).toEqual({
        success: true,
        deviceId: "dev-002",
        alreadyBound: true,
      });
    });

    it("should bind by deviceCode", async () => {
      const dto: BindDeviceDto = {
        deviceCode: "CODE123",
      };

      prisma.device.findUnique.mockResolvedValue({
        id: "device-uuid-003",
        deviceId: "dev-003",
        deviceCode: "CODE123",
      });
      prisma.userDeviceBinding.findUnique.mockResolvedValue(null);
      prisma.userDeviceBinding.create.mockResolvedValue({ id: "binding-003" });

      const result = await service.bind("user-001", dto);

      expect(prisma.device.findUnique).toHaveBeenCalledWith({
        where: { deviceCode: "CODE123" },
      });
      expect(result).toEqual({
        success: true,
        deviceId: "dev-003",
        alreadyBound: false,
      });
    });

    it("should throw when deviceCode not found", async () => {
      const dto: BindDeviceDto = {
        deviceCode: "CODE999",
      };

      prisma.device.findUnique.mockResolvedValue(null);

      await expect(service.bind("user-001", dto)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("unbind", () => {
    it("should delete user binding", async () => {
      prisma.device.findUnique.mockResolvedValue({
        id: "device-uuid-001",
        deviceId: "dev-001",
      });
      prisma.userDeviceBinding.deleteMany.mockResolvedValue({ count: 1 });

      const result = await service.unbind("user-001", "dev-001");

      expect(prisma.userDeviceBinding.deleteMany).toHaveBeenCalledWith({
        where: { userId: "user-001", deviceId: "device-uuid-001" },
      });
      expect(result).toEqual({ success: true, deviceId: "dev-001" });
    });

    it("should throw NotFoundException when device not found", async () => {
      prisma.device.findUnique.mockResolvedValue(null);

      await expect(service.unbind("user-001", "dev-999")).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("list", () => {
    it("should return devices bound to user with child profile", async () => {
      prisma.userDeviceBinding.findMany.mockResolvedValue([
        {
          device: {
            id: "device-uuid-001",
            deviceId: "dev-001",
            childProfile: { name: "二狗", englishName: "Lebron" },
          },
        },
        {
          device: {
            id: "device-uuid-002",
            deviceId: "dev-002",
            childProfile: null,
          },
        },
      ]);

      const result = await service.list("user-001");

      expect(prisma.userDeviceBinding.findMany).toHaveBeenCalledWith({
        where: { userId: "user-001" },
        include: { device: { include: { childProfile: true } } },
        orderBy: [
          { sortOrder: "asc" },
          { createdAt: "asc" },
          { deviceId: "asc" },
        ],
      });
      expect(result).toEqual([
        {
          id: "dev-001",
          name: "dev-001",
          deviceId: "dev-001",
          deviceCode: undefined,
          networkType: undefined,
          firmwareVersion: undefined,
          childProfile: { name: "二狗", englishName: "Lebron" },
        },
        {
          id: "dev-002",
          name: "dev-002",
          deviceId: "dev-002",
          deviceCode: undefined,
          networkType: undefined,
          firmwareVersion: undefined,
          childProfile: null,
        },
      ]);
    });
  });

  describe("updateOrder", () => {
    const mockBoundDevices = () => {
      prisma.userDeviceBinding.findMany.mockResolvedValue([
        {
          id: "binding-a",
          device: { id: "device-uuid-a", deviceId: "dev-a" },
        },
        {
          id: "binding-b",
          device: { id: "device-uuid-b", deviceId: "dev-b" },
        },
      ]);
      prisma.device.findMany.mockResolvedValue([
        { id: "device-uuid-a", deviceId: "dev-a" },
        { id: "device-uuid-b", deviceId: "dev-b" },
      ]);
    };

    it("atomically writes zero-based positions and uses serializable isolation", async () => {
      mockBoundDevices();
      prisma.userDeviceBinding.update.mockResolvedValue({});

      const result = await service.updateOrder("user-001", {
        orderedDeviceIds: ["dev-b", "dev-a"],
      });

      expect(result).toEqual({ orderedDeviceIds: ["dev-b", "dev-a"] });
      expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
        isolationLevel: "Serializable",
      });
      expect(prisma.userDeviceBinding.update).toHaveBeenNthCalledWith(1, {
        where: { id: "binding-b" },
        data: { sortOrder: 0 },
      });
      expect(prisma.userDeviceBinding.update).toHaveBeenNthCalledWith(2, {
        where: { id: "binding-a" },
        data: { sortOrder: 1 },
      });
    });

    it("rejects empty and duplicate orders before writing", async () => {
      prisma.$transaction.mockClear();

      await expect(
        service.updateOrder("user-001", { orderedDeviceIds: [] }),
      ).rejects.toMatchObject({ status: 400 });
      await expect(
        service.updateOrder("user-001", {
          orderedDeviceIds: ["dev-a", "dev-a"],
        }),
      ).rejects.toMatchObject({ status: 400 });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it("rejects missing and unknown IDs with 409 and no updates", async () => {
      mockBoundDevices();

      await expect(
        service.updateOrder("user-001", { orderedDeviceIds: ["dev-a"] }),
      ).rejects.toMatchObject({ status: 409 });
      await expect(
        service.updateOrder("user-001", {
          orderedDeviceIds: ["dev-b", "dev-a", "dev-unknown"],
        }),
      ).rejects.toMatchObject({ status: 409 });
      expect(prisma.userDeviceBinding.update).not.toHaveBeenCalled();
    });

    it("rejects a known device that is not bound to the user with 403", async () => {
      mockBoundDevices();
      prisma.device.findMany.mockResolvedValue([
        { id: "device-uuid-a", deviceId: "dev-a" },
        { id: "device-uuid-b", deviceId: "dev-b" },
        { id: "device-uuid-c", deviceId: "dev-c" },
      ]);

      await expect(
        service.updateOrder("user-001", {
          orderedDeviceIds: ["dev-b", "dev-a", "dev-c"],
        }),
      ).rejects.toMatchObject({ status: 403 });
      expect(prisma.userDeviceBinding.update).not.toHaveBeenCalled();
    });

    it("maps a serialization conflict to 409", async () => {
      prisma.$transaction.mockRejectedValueOnce({ code: "P2034" });

      await expect(
        service.updateOrder("user-001", {
          orderedDeviceIds: ["dev-b", "dev-a"],
        }),
      ).rejects.toMatchObject({ status: 409 });
    });
  });

  describe("detail", () => {
    it("should return device detail for bound user", async () => {
      prisma.userDeviceBinding.findFirst.mockResolvedValue({
        device: { id: "device-uuid-001", deviceId: "dev-001" },
      });

      const result = await service.detail("user-001", "dev-001");

      expect(result).toEqual({ id: "device-uuid-001", deviceId: "dev-001" });
    });

    it("should return null if user not bound", async () => {
      prisma.userDeviceBinding.findFirst.mockResolvedValue(null);

      const result = await service.detail("user-001", "dev-001");

      expect(result).toBeNull();
    });
  });

  describe("findMembers", () => {
    it("should return members of device", async () => {
      prisma.device.findUnique.mockResolvedValue({
        id: "device-uuid-001",
        deviceId: "dev-001",
      });
      prisma.userDeviceBinding.findMany.mockResolvedValue([
        {
          userId: "user-001",
          isOwner: false,
          createdAt: new Date("2026-01-01"),
          user: { id: "user-001", openid: "openid-001", nickname: "爸爸" },
        },
      ]);

      const result = await service.findMembers("dev-001");

      expect(result).toHaveLength(1);
      expect(result[0].userId).toBe("user-001");
      expect(result[0].isOwner).toBe(false);
    });
  });

  describe("status", () => {
    it("should return hardcoded status for wechat-app integration (TODO: replace with real MQTT status)", async () => {
      const result = await service.status("dev-001");

      expect(result).toMatchObject({
        deviceId: "dev-001",
        status: "online",
        battery: 78,
        isCharging: true,
      });
      expect(result.lastActiveAt).toBeDefined();
      expect(deviceStatusService.getStatus).not.toHaveBeenCalled();
    });

    it("should not call manufacturer status methods", async () => {
      await service.status("dev-001");

      expect(manufacturer.controlVolume).not.toHaveBeenCalled();
    });
  });

  describe("control", () => {
    it("should return success with action", async () => {
      const dto: DeviceControlDto = {
        action: "volume",
        volume: 50,
      };

      const result = await service.control("dev-001", dto);

      expect(result).toEqual({
        success: true,
        deviceId: "dev-001",
        action: "volume",
      });
    });
  });

  describe("applyWifi", () => {
    it("should return success with ssid", async () => {
      const dto: WifiConfigDto = {
        deviceId: "dev-001",
        ssid: "MyWiFi",
        password: "password123",
      };

      const result = await service.applyWifi("dev-001", dto);

      expect(result).toEqual({
        success: true,
        deviceId: "dev-001",
        ssid: "MyWiFi",
      });
    });
  });
});
