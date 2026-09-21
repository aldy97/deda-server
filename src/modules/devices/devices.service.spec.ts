import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { DevicesService } from './devices.service';
import { PrismaService } from '@/common/prisma/prisma.service';
import { DeviceStatusService } from '../device-status/device-status.service';
import { ManufacturerService } from '../manufacturer/manufacturer.service';
import { BindDeviceDto } from './dto/bind-device.dto';
import { DeviceControlDto } from './dto/device-control.dto';
import { WifiConfigDto } from './dto/wifi-config.dto';

describe('DevicesService', () => {
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
            device: {
              findUnique: jest.fn(),
              create: jest.fn(),
            },
            userDeviceBinding: {
              findUnique: jest.fn(),
              findMany: jest.fn(),
              findFirst: jest.fn(),
              create: jest.fn(),
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

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('bind', () => {
    it('should create device and binding when both are new', async () => {
      const dto: BindDeviceDto = {
        deviceId: 'dev-001',
        childProfileId: 'child-001',
      };

      prisma.device.findUnique.mockResolvedValue(null);
      prisma.device.create.mockResolvedValue({ id: 'device-uuid-001', deviceId: 'dev-001' });
      prisma.userDeviceBinding.findUnique.mockResolvedValue(null);
      prisma.userDeviceBinding.create.mockResolvedValue({ id: 'binding-001' });

      const result = await service.bind('user-001', dto);

      expect(prisma.device.create).toHaveBeenCalledWith({ data: { deviceId: 'dev-001' } });
      expect(prisma.userDeviceBinding.create).toHaveBeenCalledWith({
        data: { userId: 'user-001', deviceId: 'device-uuid-001', isOwner: true },
      });
      expect(result).toEqual({ success: true, deviceId: 'dev-001', alreadyBound: false });
    });

    it('should reuse existing device and binding', async () => {
      const dto: BindDeviceDto = {
        deviceId: 'dev-002',
      };

      prisma.device.findUnique.mockResolvedValue({ id: 'device-uuid-002', deviceId: 'dev-002' });
      prisma.userDeviceBinding.findUnique.mockResolvedValue({ id: 'binding-002' });

      const result = await service.bind('user-001', dto);

      expect(prisma.device.create).not.toHaveBeenCalled();
      expect(prisma.userDeviceBinding.create).not.toHaveBeenCalled();
      expect(result).toEqual({ success: true, deviceId: 'dev-002', alreadyBound: true });
    });

    it('should bind by deviceCode', async () => {
      const dto: BindDeviceDto = {
        deviceCode: 'CODE123',
      };

      prisma.device.findUnique.mockResolvedValue({ id: 'device-uuid-003', deviceId: 'dev-003', deviceCode: 'CODE123' });
      prisma.userDeviceBinding.findUnique.mockResolvedValue(null);
      prisma.userDeviceBinding.create.mockResolvedValue({ id: 'binding-003' });

      const result = await service.bind('user-001', dto);

      expect(prisma.device.findUnique).toHaveBeenCalledWith({ where: { deviceCode: 'CODE123' } });
      expect(result).toEqual({ success: true, deviceId: 'dev-003', alreadyBound: false });
    });

    it('should throw when deviceCode not found', async () => {
      const dto: BindDeviceDto = {
        deviceCode: 'CODE999',
      };

      prisma.device.findUnique.mockResolvedValue(null);

      await expect(service.bind('user-001', dto)).rejects.toThrow(NotFoundException);
    });
  });

  describe('unbind', () => {
    it('should delete user binding', async () => {
      prisma.device.findUnique.mockResolvedValue({ id: 'device-uuid-001', deviceId: 'dev-001' });
      prisma.userDeviceBinding.deleteMany.mockResolvedValue({ count: 1 });

      const result = await service.unbind('user-001', 'dev-001');

      expect(prisma.userDeviceBinding.deleteMany).toHaveBeenCalledWith({
        where: { userId: 'user-001', deviceId: 'device-uuid-001' },
      });
      expect(result).toEqual({ success: true, deviceId: 'dev-001' });
    });

    it('should throw NotFoundException when device not found', async () => {
      prisma.device.findUnique.mockResolvedValue(null);

      await expect(service.unbind('user-001', 'dev-999')).rejects.toThrow(NotFoundException);
    });
  });

  describe('list', () => {
    it('should return devices bound to user', async () => {
      prisma.userDeviceBinding.findMany.mockResolvedValue([
        { device: { id: 'device-uuid-001', deviceId: 'dev-001' } },
      ]);

      const result = await service.list('user-001');

      expect(prisma.userDeviceBinding.findMany).toHaveBeenCalledWith({
        where: { userId: 'user-001' },
        include: { device: true },
      });
      expect(result).toEqual([{
        id: 'dev-001',
        name: 'dev-001',
        deviceId: 'dev-001',
        deviceCode: undefined,
        networkType: undefined,
        firmwareVersion: undefined,
      }]);
    });
  });

  describe('detail', () => {
    it('should return device detail for bound user', async () => {
      prisma.userDeviceBinding.findFirst.mockResolvedValue({
        device: { id: 'device-uuid-001', deviceId: 'dev-001' },
      });

      const result = await service.detail('user-001', 'dev-001');

      expect(result).toEqual({ id: 'device-uuid-001', deviceId: 'dev-001' });
    });

    it('should return null if user not bound', async () => {
      prisma.userDeviceBinding.findFirst.mockResolvedValue(null);

      const result = await service.detail('user-001', 'dev-001');

      expect(result).toBeNull();
    });
  });

  describe('findMembers', () => {
    it('should return members of device', async () => {
      prisma.device.findUnique.mockResolvedValue({ id: 'device-uuid-001', deviceId: 'dev-001' });
      prisma.userDeviceBinding.findMany.mockResolvedValue([
        {
          userId: 'user-001',
          isOwner: false,
          createdAt: new Date('2026-01-01'),
          user: { id: 'user-001', openid: 'openid-001', nickname: '爸爸' },
        },
      ]);

      const result = await service.findMembers('dev-001');

      expect(result).toHaveLength(1);
      expect(result[0].userId).toBe('user-001');
      expect(result[0].isOwner).toBe(false);
    });
  });

  describe('status', () => {
    it('should return status from DeviceStatusService', async () => {
      const expected = {
        deviceId: 'dev-001',
        online: { status: 'ONLINE', lastSeenAt: 1784298000000 },
        battery: { percent: 80, chargingStatus: 'CHARGING', lowBattery: 0, reportedAt: 1784298000000 },
        version: null,
        runtime: null,
        network: null,
        updatedAt: 1784298000000,
      };
      deviceStatusService.getStatus.mockResolvedValue(expected);

      const result = await service.status('dev-001');

      expect(deviceStatusService.getStatus).toHaveBeenCalledWith('dev-001');
      expect(result).toEqual(expected);
    });

    it('should not call manufacturer status methods', async () => {
      deviceStatusService.getStatus.mockResolvedValue({
        deviceId: 'dev-001',
        online: null,
        battery: null,
        version: null,
        runtime: null,
        network: null,
        updatedAt: null,
      });

      await service.status('dev-001');

      expect(manufacturer.controlVolume).not.toHaveBeenCalled();
    });
  });

  describe('control', () => {
    it('should return success with action', async () => {
      const dto: DeviceControlDto = {
        action: 'volume',
        volume: 50,
      };

      const result = await service.control('dev-001', dto);

      expect(result).toEqual({
        success: true,
        deviceId: 'dev-001',
        action: 'volume',
      });
    });
  });

  describe('applyWifi', () => {
    it('should return success with ssid', async () => {
      const dto: WifiConfigDto = {
        deviceId: 'dev-001',
        ssid: 'MyWiFi',
        password: 'password123',
      };

      const result = await service.applyWifi('dev-001', dto);

      expect(result).toEqual({
        success: true,
        deviceId: 'dev-001',
        ssid: 'MyWiFi',
      });
    });
  });
});
