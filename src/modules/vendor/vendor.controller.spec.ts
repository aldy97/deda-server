import { Test, TestingModule } from "@nestjs/testing";
import { VendorController } from "./vendor.controller";
import { VendorService } from "./vendor.service";
import { VendorTextInDto } from "./dto/vendor-text-in.dto";
import { ADVENTURE_DEGRADED_REPLIES } from "@/modules/adventure/adventure.constants";

describe("VendorController", () => {
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
            sendDegradedReply: jest.fn(),
          },
        },
      ],
    }).compile();

    controller = module.get<VendorController>(VendorController);
    vendorService = module.get(VendorService);
  });

  it("should be defined", () => {
    expect(controller).toBeDefined();
  });

  describe("POST /vendor/text", () => {
    it("should simulate vendor:text:in and return vendor:text:out structure", async () => {
      const dto: VendorTextInDto = {
        deviceId: "dev-001",
        asrText: "Hello",
      };
      const reply = {
        deviceId: "dev-001",
        responseText: "Hi there!",
        context: { mode: "english_chat" },
        ttsOptions: {},
      };

      vendorService.handleTextIn.mockResolvedValue(reply);

      const result = await controller.textExchange(dto);

      expect(vendorService.handleTextIn).toHaveBeenCalledWith(dto);
      expect(result).toEqual(reply);
    });
  });

  describe("POST /vendor/health", () => {
    it("should return health status", () => {
      const health = {
        status: "up",
        timestamp: Date.now(),
        expectedRecovery: null,
      };
      vendorService.getHealth.mockReturnValue(health);

      const result = controller.health();

      expect(result).toEqual(health);
    });
  });

  /**
   * HTTP 备用入口的「永不沉默」。
   * 抛 500 对设备端等于静音，所以这里必须交出与正常回复同形状的信封。
   */
  describe("POST /vendor/text 的 L0 兜底", () => {
    const dto: VendorTextInDto = { deviceId: "dev-001", asrText: "你好" };

    it("服务抛错时返回兜底信封而不是 500", async () => {
      const degraded = {
        deviceId: "dev-001",
        responseText: "我在这儿呢，我们等一会儿再玩好不好？",
        context: { degraded: true },
        ttsOptions: {},
      };
      vendorService.handleTextIn.mockRejectedValue(new Error("pipeline down"));
      vendorService.sendDegradedReply.mockResolvedValue(degraded);

      await expect(controller.textExchange(dto)).resolves.toEqual(degraded);
      expect(vendorService.sendDegradedReply).toHaveBeenCalledWith("dev-001");
    });

    it("兜底话术也失败时返回本地构造的信封（最后一道闸不能再抛）", async () => {
      vendorService.handleTextIn.mockRejectedValue(new Error("pipeline down"));
      vendorService.sendDegradedReply.mockRejectedValue(new Error("ws down"));

      await expect(controller.textExchange(dto)).resolves.toEqual({
        deviceId: "dev-001",
        responseText: ADVENTURE_DEGRADED_REPLIES.lastResort,
        context: { degraded: true },
        ttsOptions: {},
      });
    });

    it("正常回复时不碰兜底话术", async () => {
      const reply = {
        deviceId: "dev-001",
        responseText: "你好呀",
        context: {},
        ttsOptions: {},
      };
      vendorService.handleTextIn.mockResolvedValue(reply);

      await expect(controller.textExchange(dto)).resolves.toEqual(reply);
      expect(vendorService.sendDegradedReply).not.toHaveBeenCalled();
    });
  });
});
