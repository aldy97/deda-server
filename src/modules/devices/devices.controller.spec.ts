import { Test, TestingModule } from '@nestjs/testing';
import { DevicesController } from './devices.controller';
import { DevicesService } from './devices.service';
import { BindDeviceDto } from './dto/bind-device.dto';
import { DeviceControlDto } from './dto/device-control.dto';
import { WifiConfigDto } from './dto/wifi-config.dto';
import { JwtAuthGuard } from '@/modules/users/guards/jwt-auth.guard';

const mockReq = (userId: string) =>
  ({ user: { userId, openid: `openid-${userId}` } } as any);

describe('DevicesController', () => {
  let controller: DevicesController;
  let service: jest.Mocked<DevicesService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [DevicesController],
      providers: [
        {
          provide: DevicesService,
          useValue: {
            bind: jest.fn(),
            unbind: jest.fn(),
            list: jest.fn(),
            detail: jest.fn(),
            status: jest.fn(),
            control: jest.fn(),
            applyWifi: jest.fn(),
            findMembers: jest.fn(),
          },
        },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<DevicesController>(DevicesController);
    service = module.get(DevicesService);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('POST /devices/bind', () => {
    it('should call service.bind with userId and dto', async () => {
      const dto: BindDeviceDto = {
        deviceId: 'dev-001',
        childProfileId: 'child-001',
      };
      const expected = { success: true, deviceId: 'dev-001', alreadyBound: false };
      service.bind.mockResolvedValue(expected);

      const result = await controller.bind(dto, mockReq('user-001'));

      expect(service.bind).toHaveBeenCalledWith('user-001', dto);
      expect(result).toEqual(expected);
    });
  });

  describe('DELETE /devices/:id', () => {
    it('should call service.unbind with userId and id', async () => {
      const expected = { success: true, deviceId: 'dev-001' };
      service.unbind.mockResolvedValue(expected);

      const result = await controller.unbind('dev-001', mockReq('user-001'));

      expect(service.unbind).toHaveBeenCalledWith('user-001', 'dev-001');
      expect(result).toEqual(expected);
    });
  });

  describe('GET /devices', () => {
    it('should call service.list with userId', async () => {
      const expected = [
        { deviceId: 'dev-001', name: 'Device 001' },
      ] as any;
      service.list.mockResolvedValue(expected);

      const result = await controller.list(mockReq('user-001'));

      expect(service.list).toHaveBeenCalledWith('user-001');
      expect(result).toEqual(expected);
    });
  });

  describe('GET /devices/:id', () => {
    it('should call service.detail with userId and id', async () => {
      const expected = { deviceId: 'dev-001', name: 'Device 001' } as any;
      service.detail.mockResolvedValue(expected);

      const result = await controller.detail('dev-001', mockReq('user-001'));

      expect(service.detail).toHaveBeenCalledWith('user-001', 'dev-001');
      expect(result).toEqual(expected);
    });
  });

  describe('GET /devices/:id/members', () => {
    it('should call service.findMembers with id', async () => {
      const expected = [{ userId: 'user-001', isOwner: false }] as any;
      service.findMembers.mockResolvedValue(expected);

      const result = await controller.members('dev-001');

      expect(service.findMembers).toHaveBeenCalledWith('dev-001');
      expect(result).toEqual(expected);
    });
  });

  describe('GET /devices/:id/status', () => {
    it('should call service.status with id', async () => {
      const expected = {
        deviceId: 'dev-001',
        online: { status: 'ONLINE' as const, lastSeenAt: 1784298000000 },
        battery: { percent: 80, chargingStatus: 'CHARGING' as const, lowBattery: 0, reportedAt: 1784298000000 },
        version: null,
        runtime: null,
        network: null,
        updatedAt: 1784298000000,
      };
      service.status.mockResolvedValue(expected as any);

      const result = await controller.status('dev-001');

      expect(service.status).toHaveBeenCalledWith('dev-001');
      expect(result).toEqual(expected);
    });
  });

  describe('POST /devices/:id/control', () => {
    it('should call service.control with id and dto', async () => {
      const dto: DeviceControlDto = {
        action: 'volume',
        volume: 50,
      };
      const expected = { success: true, deviceId: 'dev-001', action: 'volume' };
      service.control.mockResolvedValue(expected);

      const result = await controller.control('dev-001', dto);

      expect(service.control).toHaveBeenCalledWith('dev-001', dto);
      expect(result).toEqual(expected);
    });
  });

  describe('POST /devices/:id/wifi', () => {
    it('should call service.applyWifi with id and dto', async () => {
      const dto: WifiConfigDto = {
        deviceId: 'dev-001',
        ssid: 'MyWiFi',
        password: 'password123',
      };
      const expected = { success: true, deviceId: 'dev-001', ssid: 'MyWiFi' };
      service.applyWifi.mockResolvedValue(expected);

      const result = await controller.wifi('dev-001', dto);

      expect(service.applyWifi).toHaveBeenCalledWith('dev-001', dto);
      expect(result).toEqual(expected);
    });
  });
});
