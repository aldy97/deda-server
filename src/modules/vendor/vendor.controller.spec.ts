import { Test, TestingModule } from '@nestjs/testing';
import { VendorController } from './vendor.controller';
import { VendorService } from './vendor.service';
import { VendorTextInDto } from './dto/vendor-text-in.dto';

describe('VendorController', () => {
  let controller: VendorController;
  let vendorService: jest.Mocked<VendorService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [VendorController],
      providers: [
        {
          provide: VendorService,
          useValue: {
            handleTextIn: jest.fn(),
            handleStatusReport: jest.fn(),
            handleBindCallback: jest.fn(),
            handleConversationBackup: jest.fn(),
            getHealth: jest.fn(),
          },
        },
      ],
    }).compile();

    controller = module.get<VendorController>(VendorController);
    vendorService = module.get(VendorService);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('POST /vendor/text', () => {
    it('should simulate vendor:text:in and return vendor:text:out structure', async () => {
      const dto: VendorTextInDto = {
        deviceId: 'dev-001',
        asrText: 'Hello',
        textbookId: 'sample-textbook',
        unitId: 'unit-1',
      };
      const reply = {
        deviceId: 'dev-001',
        responseText: 'Hi there!',
        context: {
          textbookId: 'sample-textbook',
          unitId: 'unit-1',
          ragFound: true,
        },
        ttsOptions: {},
      };

      vendorService.handleTextIn.mockResolvedValue(reply);

      const result = await controller.textExchange(dto);

      expect(vendorService.handleTextIn).toHaveBeenCalledWith(dto);
      expect(result).toEqual(reply);
    });
  });

  describe('POST /vendor/health', () => {
    it('should return health status', () => {
      const health = {
        status: 'up',
        timestamp: Date.now(),
        expectedRecovery: null,
      };
      vendorService.getHealth.mockReturnValue(health);

      const result = controller.health();

      expect(result).toEqual(health);
    });
  });
});
