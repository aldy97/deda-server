import { plainToInstance } from "class-transformer";
import { FleetController } from "./fleet.controller";
import { FleetService } from "./fleet.service";
import {
  FleetChurnRiskQueryDto,
  FleetDeviceDetailQueryDto,
  FleetDevicesQueryDto,
} from "./dto/fleet-query.dto";

describe("FleetController", () => {
  it("getSummary 透传 query 给 service", async () => {
    const service = {
      getSummary: jest.fn().mockResolvedValue({ date: "2026-11-05" }),
    } as unknown as FleetService;
    const controller = new FleetController(service);

    const query = { date: "2026-11-05" };
    await controller.getSummary(query);
    expect(service.getSummary).toHaveBeenCalledWith(query);
  });

  it("getPresenceTrend 透传 query 给 service", async () => {
    const service = {
      getPresenceTrend: jest.fn().mockResolvedValue({}),
    } as unknown as FleetService;
    const controller = new FleetController(service);

    const query = { startDate: "2026-11-01", endDate: "2026-11-05" };
    await controller.getPresenceTrend(query);
    expect(service.getPresenceTrend).toHaveBeenCalledWith(query);
  });

  it("getFirmwareDistribution 不传参", async () => {
    const service = {
      getFirmwareDistribution: jest.fn().mockResolvedValue({}),
    } as unknown as FleetService;
    const controller = new FleetController(service);

    await controller.getFirmwareDistribution();
    expect(service.getFirmwareDistribution).toHaveBeenCalled();
  });

  it("getChurnRisk 透传 query 给 service", async () => {
    const service = {
      getChurnRisk: jest.fn().mockResolvedValue({}),
    } as unknown as FleetService;
    const controller = new FleetController(service);

    const query = { days: 14 };
    await controller.getChurnRisk(query);
    expect(service.getChurnRisk).toHaveBeenCalledWith(query);
  });

  it("getDevices 透传 query 给 service", async () => {
    const service = {
      getDevices: jest.fn().mockResolvedValue({}),
    } as unknown as FleetService;
    const controller = new FleetController(service);

    const query = { page: 1, pageSize: 20 };
    await controller.getDevices(query);
    expect(service.getDevices).toHaveBeenCalledWith(query);
  });

  it("getDeviceDetail 透传 deviceId 和 query 给 service，不存在返回 404", async () => {
    const service = {
      getDeviceDetail: jest.fn().mockResolvedValue(null),
    } as unknown as FleetService;
    const controller = new FleetController(service);

    const query = { days: 30 };
    // On null result, controller should throw NotFoundException
    await expect(
      controller.getDeviceDetail("nonexistent", query),
    ).rejects.toThrow("Device not found");
    expect(service.getDeviceDetail).toHaveBeenCalledWith("nonexistent", query);
  });

  it("getDeviceDetail 透传正常 deviceId", async () => {
    const service = {
      getDeviceDetail: jest
        .fn()
        .mockResolvedValue({ deviceId: "aa0000000001" }),
    } as unknown as FleetService;
    const controller = new FleetController(service);

    const query = { days: 30 };
    const result = await controller.getDeviceDetail("aa0000000001", query);
    expect(result).toEqual({ deviceId: "aa0000000001" });
    expect(service.getDeviceDetail).toHaveBeenCalledWith("aa0000000001", query);
  });
});

describe("Fleet query DTO 转换（query string → number + 缺省值）", () => {
  it("churn-risk days 缺省 7，字符串转数字", () => {
    expect(plainToInstance(FleetChurnRiskQueryDto, {}).days).toBe(7);
    expect(plainToInstance(FleetChurnRiskQueryDto, { days: "14" }).days).toBe(
      14,
    );
  });

  it("device detail days 缺省 30，字符串转数字", () => {
    expect(plainToInstance(FleetDeviceDetailQueryDto, {}).days).toBe(30);
    expect(
      plainToInstance(FleetDeviceDetailQueryDto, { days: "60" }).days,
    ).toBe(60);
  });

  it("devices page/pageSize 缺省 1/20，字符串转数字（clamp 在 service 层）", () => {
    const defaults = plainToInstance(FleetDevicesQueryDto, {});
    expect(defaults.page).toBe(1);
    expect(defaults.pageSize).toBe(20);

    const filled = plainToInstance(FleetDevicesQueryDto, {
      page: "3",
      pageSize: "500",
    });
    expect(filled.page).toBe(3);
    expect(filled.pageSize).toBe(500);
  });
});
