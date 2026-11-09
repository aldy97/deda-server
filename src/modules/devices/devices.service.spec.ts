import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { DevicesService } from "./devices.service";
import { PrismaService } from "@/common/prisma/prisma.service";
import { DeviceStatusService } from "../device-status/device-status.service";
import { DeviceLinkService } from "../device-link/device-link.service";
import { ManufacturerService } from "../manufacturer/manufacturer.service";
import { BindDeviceDto } from "./dto/bind-device.dto";
import { DeviceControlDto } from "./dto/device-control.dto";
import { WifiConfigDto } from "./dto/wifi-config.dto";

describe("DevicesService", () => {
  let service: DevicesService;
  let prisma: any;
  let deviceLink: any;

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
          provide: DeviceLinkService,
          useValue: {
            getStatus: jest.fn(),
            setVolume: jest.fn(),
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
    deviceLink = module.get(DeviceLinkService);
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
    const mockDevice = () =>
      prisma.device.findUnique.mockResolvedValue({
        id: "device-uuid-001",
        deviceId: "dev-001",
        macAddress: "AABBCCDDEEFF",
      });

    it("should return real online status from device-link cache", async () => {
      mockDevice();
      const lastSeenAt = Date.now() - 5000;
      deviceLink.getStatus.mockResolvedValue({
        mac: "AABBCCDDEEFF",
        battery: 80,
        volume: 50,
        version: "1.2.3",
        lastSeenAt,
        online: true,
      });

      const result = await service.status("dev-001");

      expect(deviceLink.getStatus).toHaveBeenCalledWith("AABBCCDDEEFF");
      expect(result).toEqual({
        deviceId: "dev-001",
        status: "online",
        battery: 80,
        isCharging: null,
        lastActiveAt: new Date(lastSeenAt).toISOString(),
      });
    });

    it("should return offline when device exceeds heartbeat window", async () => {
      mockDevice();
      const lastSeenAt = Date.now() - 60_000;
      deviceLink.getStatus.mockResolvedValue({
        mac: "AABBCCDDEEFF",
        battery: 66,
        volume: 50,
        version: "1.2.3",
        lastSeenAt,
        online: false,
      });

      const result = await service.status("dev-001");

      expect(result.status).toBe("offline");
      expect(result.battery).toBe(66);
      expect(result.lastActiveAt).toBe(new Date(lastSeenAt).toISOString());
    });

    it("should return offline null status when device never reported", async () => {
      mockDevice();
      deviceLink.getStatus.mockResolvedValue({
        mac: "AABBCCDDEEFF",
        battery: null,
        volume: null,
        version: null,
        lastSeenAt: null,
        online: false,
      });

      const result = await service.status("dev-001");

      expect(result).toEqual({
        deviceId: "dev-001",
        status: "offline",
        battery: null,
        isCharging: null,
        lastActiveAt: null,
      });
    });

    it("should fall back to deviceId when macAddress is missing", async () => {
      prisma.device.findUnique.mockResolvedValue({
        id: "device-uuid-001",
        deviceId: "dev-001",
        macAddress: null,
      });
      deviceLink.getStatus.mockResolvedValue({
        mac: "dev-001",
        battery: null,
        volume: null,
        version: null,
        lastSeenAt: null,
        online: false,
      });

      await service.status("dev-001");

      expect(deviceLink.getStatus).toHaveBeenCalledWith("dev-001");
    });

    it("should throw NotFoundException when device not found", async () => {
      prisma.device.findUnique.mockResolvedValue(null);

      await expect(service.status("dev-999")).rejects.toThrow(
        NotFoundException,
      );
      expect(deviceLink.getStatus).not.toHaveBeenCalled();
    });
  });

  describe("control", () => {
    const mockDevice = () =>
      prisma.device.findUnique.mockResolvedValue({
        id: "device-uuid-001",
        deviceId: "dev-001",
        macAddress: "AABBCCDDEEFF",
      });

    it("should publish volume command via device-link when action=volume", async () => {
      mockDevice();
      const dto: DeviceControlDto = {
        action: "volume",
        volume: 50,
      };

      const result = await service.control("dev-001", dto);

      expect(deviceLink.setVolume).toHaveBeenCalledWith("AABBCCDDEEFF", 50);
      expect(result).toEqual({
        success: true,
        deviceId: "dev-001",
        action: "volume",
      });
    });

    it("should reject action=volume without volume value", async () => {
      mockDevice();
      const dto: DeviceControlDto = { action: "volume" };

      await expect(service.control("dev-001", dto)).rejects.toMatchObject({
        status: 400,
      });
      expect(deviceLink.setVolume).not.toHaveBeenCalled();
    });

    it("should propagate out-of-range volume as 400", async () => {
      mockDevice();
      deviceLink.setVolume.mockImplementation(() => {
        throw new BadRequestException("volume out of range");
      });
      const dto: DeviceControlDto = { action: "volume", volume: 101 };

      await expect(service.control("dev-001", dto)).rejects.toMatchObject({
        status: 400,
      });
    });

    it("should throw NotFoundException for volume control on unknown device", async () => {
      prisma.device.findUnique.mockResolvedValue(null);
      const dto: DeviceControlDto = { action: "volume", volume: 50 };

      await expect(service.control("dev-999", dto)).rejects.toThrow(
        NotFoundException,
      );
      expect(deviceLink.setVolume).not.toHaveBeenCalled();
    });

    it("should keep stub success for actions not supported by MQTT protocol", async () => {
      const dto: DeviceControlDto = {
        action: "sleep",
        delayMinutes: 30,
      };

      const result = await service.control("dev-001", dto);

      expect(result).toEqual({
        success: true,
        deviceId: "dev-001",
        action: "sleep",
      });
      expect(deviceLink.setVolume).not.toHaveBeenCalled();
      expect(prisma.device.findUnique).not.toHaveBeenCalled();
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
