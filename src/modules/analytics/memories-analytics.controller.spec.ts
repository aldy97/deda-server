import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import {
  MemoriesAnalyticsController,
  MemoriesDevicesQueryDto,
  MemoriesHistoryQueryDto,
  MemoriesCurrentQueryDto,
} from "./memories-analytics.controller";
import { MemoriesAnalyticsService } from "./memories-analytics.service";

describe("MemoriesAnalyticsController", () => {
  it("四个端点透传给 service", async () => {
    const service = {
      getOverview: jest.fn().mockResolvedValue({}),
      listDevices: jest.fn().mockResolvedValue({ total: 0 }),
      getCurrentMemories: jest.fn().mockResolvedValue({}),
      getMemoryHistory: jest.fn().mockResolvedValue({}),
    } as unknown as MemoriesAnalyticsService;
    const controller = new MemoriesAnalyticsController(service);

    await controller.getOverview();
    expect(service.getOverview).toHaveBeenCalled();

    const devicesQuery = new MemoriesDevicesQueryDto();
    await controller.listDevices(devicesQuery);
    expect(service.listDevices).toHaveBeenCalledWith(devicesQuery);

    const currentQuery = plainToInstance(MemoriesCurrentQueryDto, {
      deviceId: "DEDA-001",
    });
    await controller.getCurrent(currentQuery);
    expect(service.getCurrentMemories).toHaveBeenCalledWith("DEDA-001");

    const historyQuery = plainToInstance(MemoriesHistoryQueryDto, {
      deviceId: "DEDA-001",
      key: "favorite_color",
    });
    await controller.getHistory(historyQuery);
    expect(service.getMemoryHistory).toHaveBeenCalledWith(
      "DEDA-001",
      "favorite_color",
    );
  });

  describe("DTO 校验", () => {
    it("devices：缺省分页 1/20；page/pageSize 越界被拒绝；keyword 超 50 字被拒绝", async () => {
      const ok = plainToInstance(MemoriesDevicesQueryDto, {});
      expect(await validate(ok)).toHaveLength(0);
      expect(ok.page).toBe(1);
      expect(ok.pageSize).toBe(20);

      for (const q of [{ page: "0" }, { pageSize: "101" }]) {
        const dto = plainToInstance(MemoriesDevicesQueryDto, q);
        const errors = await validate(dto);
        expect(errors.length).toBeGreaterThan(0);
      }

      const longKw = plainToInstance(MemoriesDevicesQueryDto, {
        keyword: "长".repeat(51),
      });
      expect(
        (await validate(longKw)).some((e) => e.property === "keyword"),
      ).toBe(true);
    });

    it("current：deviceId 必填，缺失或空串被拒绝", async () => {
      for (const q of [{}, { deviceId: "" }]) {
        const dto = plainToInstance(MemoriesCurrentQueryDto, q);
        const errors = await validate(dto);
        expect(errors.some((e) => e.property === "deviceId")).toBe(true);
      }
    });

    it("history：key 非白名单被拒绝，合法值通过", async () => {
      const bad = plainToInstance(MemoriesHistoryQueryDto, {
        deviceId: "DEDA-001",
        key: "favorite_food",
      });
      expect((await validate(bad)).some((e) => e.property === "key")).toBe(
        true,
      );

      const good = plainToInstance(MemoriesHistoryQueryDto, {
        deviceId: "DEDA-001",
        key: "preferred_interaction",
      });
      expect(await validate(good)).toHaveLength(0);
    });
  });
});
