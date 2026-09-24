import { Test, TestingModule } from '@nestjs/testing';
import { ChildProfilesController } from './child-profiles.controller';
import { ChildProfilesService } from './child-profiles.service';
import { JwtAuthGuard } from '@/modules/users/guards/jwt-auth.guard';

const mockReq = (userId: string) =>
  ({ user: { userId, openid: `openid-${userId}` } } as any);

describe('ChildProfilesController', () => {
  let controller: ChildProfilesController;
  let service: jest.Mocked<ChildProfilesService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ChildProfilesController],
      providers: [
        {
          provide: ChildProfilesService,
          useValue: {
            getByDevice: jest.fn(),
            upsertByDevice: jest.fn(),
          },
        },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<ChildProfilesController>(ChildProfilesController);
    service = module.get(ChildProfilesService);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('GET /child-profiles/device/:deviceId', () => {
    it('should return owner info with valid JWT', async () => {
      const expected = {
        id: 'child-001',
        name: 'Alice',
        birthday: '2018-05-20',
      };
      service.getByDevice.mockResolvedValue(expected as any);

      const result = await controller.getByDevice('dev-001', mockReq('user-001'));

      expect(service.getByDevice).toHaveBeenCalledWith('user-001', 'dev-001');
      expect(result).toEqual(expected);
    });

    it('should return null when owner info not filled', async () => {
      service.getByDevice.mockResolvedValue(null);

      const result = await controller.getByDevice('dev-001', mockReq('user-001'));

      expect(result).toBeNull();
    });
  });

  describe('PATCH /child-profiles/device/:deviceId', () => {
    it('should update owner info with valid JWT and dto', async () => {
      const dto = { name: 'Alice', birthday: '2018-05-20' };
      const expected = {
        id: 'child-001',
        name: 'Alice',
        birthday: '2018-05-20',
      };
      service.upsertByDevice.mockResolvedValue(expected as any);

      const result = await controller.updateByDevice(
        'dev-001',
        dto,
        mockReq('user-001'),
      );

      expect(service.upsertByDevice).toHaveBeenCalledWith(
        'user-001',
        'dev-001',
        dto,
      );
      expect(result).toEqual(expected);
    });

    it('should ignore fields other than name and birthday', async () => {
      const dto = { name: 'Alice', birthday: '2018-05-20', englishName: 'A' } as any;
      const expected = {
        id: 'child-001',
        name: 'Alice',
        birthday: '2018-05-20',
      };
      service.upsertByDevice.mockResolvedValue(expected as any);

      await controller.updateByDevice('dev-001', dto, mockReq('user-001'));

      expect(service.upsertByDevice).toHaveBeenCalledWith(
        'user-001',
        'dev-001',
        dto,
      );
    });
  });
});
