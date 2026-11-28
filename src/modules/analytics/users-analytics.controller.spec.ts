import { UsersAnalyticsController } from "./users-analytics.controller";
import { UsersAnalyticsService } from "./users-analytics.service";

describe("UsersAnalyticsController.getPhoneBrands", () => {
  it("委托 service 返回厂商分布", async () => {
    const result = { totalUsers: 1, brands: [] };
    const service = {
      getPhoneBrands: jest.fn().mockResolvedValue(result),
    };
    const controller = new UsersAnalyticsController(service as never);

    await expect(controller.getPhoneBrands()).resolves.toBe(result);
    expect(service.getPhoneBrands).toHaveBeenCalledTimes(1);
  });
});

describe("UsersAnalyticsController.getParentDemographics", () => {
  it("委托 service 返回家长画像聚合", async () => {
    const result = { totalUsers: 1, genderSplit: {}, ageDistribution: [] };
    const service = {
      getParentDemographics: jest.fn().mockResolvedValue(result),
    };
    const controller = new UsersAnalyticsController(service as never);

    await expect(controller.getParentDemographics()).resolves.toBe(result);
    expect(service.getParentDemographics).toHaveBeenCalledTimes(1);
  });
});
