import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { ChildProfilesService } from './child-profiles.service';
import { PrismaService } from '@/common/prisma/prisma.service';
import { UpsertChildProfileDto } from './dto/upsert-child-profile.dto';

describe('ChildProfilesService', () => {
  let service: ChildProfilesService;
  let prisma: any;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChildProfilesService,
        {
          provide: PrismaService,
          useValue: {
            userDeviceBinding: {
              findFirst: jest.fn(),
            },
            childProfile: {
              findUnique: jest.fn(),
              upsert: jest.fn(),
            },
          },
        },
      ],
    }).compile();

    service = module.get<ChildProfilesService>(ChildProfilesService);
    prisma = module.get(PrismaService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  const mockBinding = {
    id: 'binding-001',
    userId: 'user-001',
    deviceId: 'device-uuid-001',
    device: { id: 'device-uuid-001', deviceId: 'dev-001' },
  };

  describe('getByDevice', () => {
    it('should return owner info for bound device', async () => {
      const ownerInfo = {
        id: 'child-001',
        userId: 'user-001',
        deviceId: 'device-uuid-001',
        name: 'Alice',
        birthday: '2018-05-20',
        englishName: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      prisma.userDeviceBinding.findFirst.mockResolvedValue(mockBinding);
      prisma.childProfile.findUnique.mockResolvedValue(ownerInfo);

      const result = await service.getByDevice('user-001', 'dev-001');

      expect(prisma.userDeviceBinding.findFirst).toHaveBeenCalledWith({
        where: { userId: 'user-001', device: { deviceId: 'dev-001' } },
        include: { device: true },
      });
      expect(prisma.childProfile.findUnique).toHaveBeenCalledWith({
        where: { deviceId: 'device-uuid-001' },
      });
      expect(result).toEqual(ownerInfo);
    });

    it('should return null when owner info not filled', async () => {
      prisma.userDeviceBinding.findFirst.mockResolvedValue(mockBinding);
      prisma.childProfile.findUnique.mockResolvedValue(null);

      const result = await service.getByDevice('user-001', 'dev-001');

      expect(result).toBeNull();
    });

    it('should throw ForbiddenException when user does not own the device', async () => {
      prisma.userDeviceBinding.findFirst.mockResolvedValue(null);

      await expect(service.getByDevice('user-001', 'dev-001')).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  describe('upsertByDevice', () => {
    it('should create owner info for bound device', async () => {
      const dto: UpsertChildProfileDto = {
        name: 'Alice',
        birthday: '2018-05-20',
        englishName: 'Ali',
      };
      const created = {
        id: 'child-001',
        userId: 'user-001',
        deviceId: 'device-uuid-001',
        name: 'Alice',
        birthday: '2018-05-20',
        englishName: 'Ali',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      prisma.userDeviceBinding.findFirst.mockResolvedValue(mockBinding);
      prisma.childProfile.upsert.mockResolvedValue(created);

      const result = await service.upsertByDevice('user-001', 'dev-001', dto);

      expect(prisma.childProfile.upsert).toHaveBeenCalledWith({
        where: { deviceId: 'device-uuid-001' },
        update: { name: 'Alice', birthday: '2018-05-20', englishName: 'Ali' },
        create: {
          userId: 'user-001',
          deviceId: 'device-uuid-001',
          name: 'Alice',
          birthday: '2018-05-20',
          englishName: 'Ali',
        },
      });
      expect(result).toEqual(created);
    });

    it('should update existing owner info', async () => {
      const dto: UpsertChildProfileDto = {
        name: 'Bob',
        englishName: 'Bobby',
      };
      const updated = {
        id: 'child-001',
        userId: 'user-001',
        deviceId: 'device-uuid-001',
        name: 'Bob',
        birthday: '2018-05-20',
        englishName: 'Bobby',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      prisma.userDeviceBinding.findFirst.mockResolvedValue(mockBinding);
      prisma.childProfile.upsert.mockResolvedValue(updated);

      const result = await service.upsertByDevice('user-001', 'dev-001', dto);

      expect(prisma.childProfile.upsert).toHaveBeenCalledWith({
        where: { deviceId: 'device-uuid-001' },
        update: { name: 'Bob', birthday: undefined, englishName: 'Bobby' },
        create: {
          userId: 'user-001',
          deviceId: 'device-uuid-001',
          name: 'Bob',
          birthday: undefined,
          englishName: 'Bobby',
        },
      });
      expect(result).toEqual(updated);
    });

    it('should throw ForbiddenException when user does not own the device', async () => {
      const dto: UpsertChildProfileDto = { name: 'Alice' };
      prisma.userDeviceBinding.findFirst.mockResolvedValue(null);

      await expect(
        service.upsertByDevice('user-001', 'dev-001', dto),
      ).rejects.toThrow(ForbiddenException);
    });
  });
});
