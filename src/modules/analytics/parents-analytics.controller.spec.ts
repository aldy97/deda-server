import { NotFoundException } from "@nestjs/common";
import { ParentsAnalyticsController } from "./parents-analytics.controller";

describe("ParentsAnalyticsController", () => {
  it("正常委托 service，返回家长视角详情", async () => {
    const result = { user: { id: "u1" }, summary: {}, devices: [] };
    const service = {
      getParentDetail: jest.fn().mockResolvedValue(result),
    };
    const controller = new ParentsAnalyticsController(service as never);

    await expect(controller.getParent("u1")).resolves.toBe(result);
    expect(service.getParentDetail).toHaveBeenCalledWith("u1");
  });

  it("service 返回 null 时抛 NotFoundException", async () => {
    const service = {
      getParentDetail: jest.fn().mockResolvedValue(null),
    };
    const controller = new ParentsAnalyticsController(service as never);

    await expect(controller.getParent("missing")).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
