import { UsersController } from "./users.controller";
import { UsersService } from "./users.service";

describe("UsersController.reportClientInfo", () => {
  it("从 JWT 取 userId 并透传品牌", async () => {
    const result = { success: true, skipped: false };
    const service = {
      reportClientInfo: jest.fn().mockResolvedValue(result),
    };
    const controller = new UsersController(service as never);

    const req = { user: { userId: "u1", openid: "openid-1" } };
    await expect(
      controller.reportClientInfo({ brand: "Apple" }, req as never),
    ).resolves.toBe(result);
    expect(service.reportClientInfo).toHaveBeenCalledWith("u1", {
      brand: "Apple",
    });
  });
});
