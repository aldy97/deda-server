import { Test, TestingModule } from "@nestjs/testing";
import { SleepConfigsController } from "./sleep-configs.controller";
import { SleepConfigsService } from "./sleep-configs.service";
import { JwtAuthGuard } from "@/modules/users/guards/jwt-auth.guard";

const mockReq = (userId: string) =>
  ({ user: { userId, openid: `openid-${userId}` } }) as any;

describe("SleepConfigsController", () => {
  let controller: SleepConfigsController;
  let service: jest.Mocked<SleepConfigsService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [SleepConfigsController],
      providers: [
        {
          provide: SleepConfigsService,
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

    controller = module.get<SleepConfigsController>(SleepConfigsController);
    service = module.get(SleepConfigsService);
  });

  it("should be defined", () => {
    expect(controller).toBeDefined();
  });

  describe("GET /sleep-configs/device/:deviceId", () => {
    it("should return sleep config with valid JWT", async () => {
      const expected = {
        id: "sleep-001",
        deviceId: "device-uuid-001",
        enabled: true,
        durationMode: "custom",
        durationMinutes: 20,
        contentType: "story",
        sleepTime: "21:30",
        forceSleep: false,
      };
      service.getByDevice.mockResolvedValue(expected as any);

      const result = await controller.getByDevice(
        "dev-001",
        mockReq("user-001"),
      );

      expect(service.getByDevice).toHaveBeenCalledWith("user-001", "dev-001");
      expect(result).toEqual(expected);
    });

    it("should return null when config not set", async () => {
      service.getByDevice.mockResolvedValue(null);

      const result = await controller.getByDevice(
        "dev-001",
        mockReq("user-001"),
      );

      expect(result).toBeNull();
    });
  });

  describe("PATCH /sleep-configs/device/:deviceId", () => {
    it("should update config with valid JWT and partial dto", async () => {
      const dto = { enabled: true, sleepTime: "21:00" };
      const expected = {
        id: "sleep-001",
        enabled: true,
        sleepTime: "21:00",
      };
      service.upsertByDevice.mockResolvedValue(expected as any);

      const result = await controller.updateByDevice(
        "dev-001",
        dto,
        mockReq("user-001"),
      );

      expect(service.upsertByDevice).toHaveBeenCalledWith(
        "user-001",
        "dev-001",
        dto,
      );
      expect(result).toEqual(expected);
    });
  });
});
