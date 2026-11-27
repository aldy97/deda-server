import { EngagementController } from "./engagement.controller";
import { EngagementService } from "./engagement.service";

describe("EngagementController.getNetworkUsage", () => {
  it("把日期区间透传给 service", async () => {
    const result = { totalTurns: 1 };
    const service = {
      getNetworkUsage: jest.fn().mockResolvedValue(result),
    };
    const controller = new EngagementController(service as never);

    await expect(
      controller.getNetworkUsage({
        startDate: "2026-11-01",
        endDate: "2026-11-30",
      }),
    ).resolves.toBe(result);
    expect(service.getNetworkUsage).toHaveBeenCalledWith({
      startDate: "2026-11-01",
      endDate: "2026-11-30",
    });
  });
});
