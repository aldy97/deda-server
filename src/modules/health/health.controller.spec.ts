import { Test, TestingModule } from '@nestjs/testing';
import { HealthController } from './health.controller';
import { VendorService } from '../vendor/vendor.service';

describe('HealthController', () => {
  let controller: HealthController;
  let vendorService: jest.Mocked<VendorService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        {
          provide: VendorService,
          useValue: {
            getHealth: jest.fn(),
          },
        },
      ],
    }).compile();

    controller = module.get<HealthController>(HealthController);
    vendorService = module.get(VendorService);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('GET /health', () => {
    it('should return health status', async () => {
      const expected = { status: 'up', timestamp: 1234567890, expectedRecovery: null };
      vendorService.getHealth.mockReturnValue(expected);

      const result = controller.health();

      expect(vendorService.getHealth).toHaveBeenCalled();
      expect(result).toEqual(expected);
    });
  });
});
