import { Test, TestingModule } from '@nestjs/testing';
import { DeviceConfigsController } from './device-configs.controller';
import { DeviceConfigsService } from './device-configs.service';
import { JwtAuthGuard } from '@/modules/users/guards/jwt-auth.guard';
import { ApplyDeviceConfigDto } from './dto/apply-device-config.dto';
import { SwitchModeDto } from './dto/switch-mode.dto';

describe('DeviceConfigsController', () => {
  let controller: DeviceConfigsController;
  let service: any;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [DeviceConfigsController],
      providers: [
        {
          provide: DeviceConfigsService,
          useValue: {
            current: jest.fn(),
            apply: jest.fn(),
            switchMode: jest.fn(),
          },
        },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<DeviceConfigsController>(DeviceConfigsController);
    service = module.get(DeviceConfigsService);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('current', () => {
    it('should return current config', async () => {
      const config = {
        deviceId: 'dev-001',
        mode: 'free_chat',
        conversationModeKey: 'free_chat_casual',
      };
      service.current.mockResolvedValue(config);

      const req = { user: { userId: 'user-001' } };
      const result = await controller.current('dev-001', req as any);

      expect(service.current).toHaveBeenCalledWith('user-001', 'dev-001');
      expect(result).toEqual(config);
    });
  });

  describe('apply', () => {
    it('should apply device config', async () => {
      const dto: ApplyDeviceConfigDto = {
        mode: 'locked_unit',
        textbookId: 'unlock-l1-speaking-listening',
        unitId: 'unit-1',
      };
      const config = {
        deviceId: 'dev-001',
        mode: 'locked_unit',
        textbookId: 'unlock-l1-speaking-listening',
        unitId: 'unit-1',
      };
      service.apply.mockResolvedValue(config);

      const req = { user: { userId: 'user-001' } };
      const result = await controller.apply('dev-001', dto, req as any);

      expect(service.apply).toHaveBeenCalledWith('user-001', 'dev-001', dto);
      expect(result).toEqual(config);
    });
  });

  describe('switchMode', () => {
    it('should switch mode', async () => {
      const dto: SwitchModeDto = {
        mode: 'free_chat',
        conversationModeKey: 'free_chat_roleplay',
      };
      const config = {
        deviceId: 'dev-001',
        mode: 'free_chat',
        conversationModeKey: 'free_chat_roleplay',
      };
      service.switchMode.mockResolvedValue(config);

      const req = { user: { userId: 'user-001' } };
      const result = await controller.switchMode('dev-001', dto, req as any);

      expect(service.switchMode).toHaveBeenCalledWith(
        'user-001',
        'dev-001',
        dto,
      );
      expect(result).toEqual(config);
    });
  });
});
