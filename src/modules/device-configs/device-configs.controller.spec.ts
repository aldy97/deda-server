import { Test, TestingModule } from "@nestjs/testing";
import { DeviceConfigsController } from "./device-configs.controller";
import { DeviceConfigsService } from "./device-configs.service";
import { JwtAuthGuard } from "@/modules/users/guards/jwt-auth.guard";
import { ApplyDeviceConfigDto } from "./dto/apply-device-config.dto";
import { SwitchModeDto } from "./dto/switch-mode.dto";
import { UpdateVoiceConfigDto } from "./dto/update-voice-config.dto";

type AuthedRequest = Parameters<DeviceConfigsController["getVoiceConfig"]>[1];

/** controller 只读 req.user.userId，用最小替身，不引入 any */
const authedReq = (userId: string): AuthedRequest =>
  ({ user: { userId } }) as unknown as AuthedRequest;

describe("DeviceConfigsController", () => {
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
            getVoiceConfig: jest.fn(),
            updateVoiceConfig: jest.fn(),
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

  it("should be defined", () => {
    expect(controller).toBeDefined();
  });

  describe("current", () => {
    it("should return current config", async () => {
      const config = {
        deviceId: "dev-001",
        mode: "free_chat",
      };
      service.current.mockResolvedValue(config);

      const req = authedReq("user-001");
      const result = await controller.current("dev-001", req);

      expect(service.current).toHaveBeenCalledWith("user-001", "dev-001");
      expect(result).toEqual(config);
    });
  });

  describe("apply", () => {
    it("should apply device config", async () => {
      const dto: ApplyDeviceConfigDto = {
        mode: "english_chat",
      };
      const config = {
        deviceId: "dev-001",
        mode: "english_chat",
      };
      service.apply.mockResolvedValue(config);

      const req = authedReq("user-001");
      const result = await controller.apply("dev-001", dto, req);

      expect(service.apply).toHaveBeenCalledWith("user-001", "dev-001", dto);
      expect(result).toEqual(config);
    });
  });

  describe("switchMode", () => {
    it("should switch mode", async () => {
      const dto: SwitchModeDto = {
        mode: "free_chat",
      };
      const config = {
        deviceId: "dev-001",
        mode: "free_chat",
      };
      service.switchMode.mockResolvedValue(config);

      const req = authedReq("user-001");
      const result = await controller.switchMode("dev-001", dto, req);

      expect(service.switchMode).toHaveBeenCalledWith(
        "user-001",
        "dev-001",
        dto,
      );
      expect(result).toEqual(config);
    });
  });

  describe("getVoiceConfig", () => {
    it("should return voice config", async () => {
      const voiceConfig = {
        deviceId: "dev-001",
        vcn: "1000063",
        speechRate: "normal",
        spd: 1,
        catalog: [{ timbreId: "1000063", name: "度小熊", language: "chinese" }],
        available: true,
        canApplyLive: true,
        reason: null,
      };
      service.getVoiceConfig.mockResolvedValue(voiceConfig);

      const req = authedReq("user-001");
      const result = await controller.getVoiceConfig("dev-001", req);

      expect(service.getVoiceConfig).toHaveBeenCalledWith(
        "user-001",
        "dev-001",
      );
      expect(result).toEqual(voiceConfig);
    });
  });

  describe("updateVoiceConfig", () => {
    it("should update voice config", async () => {
      const dto: UpdateVoiceConfigDto = { vcn: "1000063", speechRate: "slow" };
      const outcome = {
        deviceId: "dev-001",
        vcn: "1000063",
        speechRate: "slow",
        spd: 0.8,
        applied: "live",
        reason: null,
      };
      service.updateVoiceConfig.mockResolvedValue(outcome);

      const req = authedReq("user-001");
      const result = await controller.updateVoiceConfig("dev-001", dto, req);

      expect(service.updateVoiceConfig).toHaveBeenCalledWith(
        "user-001",
        "dev-001",
        dto,
      );
      expect(result).toEqual(outcome);
    });
  });
});
