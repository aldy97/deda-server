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

describe("UsersController profile", () => {
  it("GET /users/profile 从 JWT 取 userId 委托 service", async () => {
    const result = { id: "u1", nickname: null, deviceCount: 0, childCount: 0 };
    const service = { getProfile: jest.fn().mockResolvedValue(result) };
    const controller = new UsersController(service as never);

    const req = { user: { userId: "u1", openid: "openid-1" } };
    await expect(controller.getProfile(req as never)).resolves.toBe(result);
    expect(service.getProfile).toHaveBeenCalledWith("u1");
  });

  it("PATCH /users/profile 把 DTO 原样交给 service", async () => {
    const result = { id: "u1", nickname: "熊熊妈妈" };
    const service = { updateProfile: jest.fn().mockResolvedValue(result) };
    const controller = new UsersController(service as never);

    const req = { user: { userId: "u1", openid: "openid-1" } };
    await expect(
      controller.updateProfile({ nickname: "熊熊妈妈" }, req as never),
    ).resolves.toBe(result);
    expect(service.updateProfile).toHaveBeenCalledWith("u1", {
      nickname: "熊熊妈妈",
    });
  });
});
