import { UnauthorizedException } from "@nestjs/common";
import { SuperAdminGuard } from "@/modules/analytics/guards/super-admin.guard";
import { DeviceTestAccessController } from "./device-test-access.controller";

/**
 * HTTP 外壳只做三件事：superadmin 闸、从 JWT 取 actor、把 DTO 原样交给服务。
 * 业务语义全部在 DeviceTestAccessService 的单测里，这里只钉「入口没有被降级成普通 admin」。
 */
describe("DeviceTestAccessController", () => {
  const access = {
    list: jest.fn(),
    add: jest.fn(),
    revoke: jest.fn(),
  };
  const controller = new DeviceTestAccessController(access as never);
  const req = {
    user: { username: "alice", displayName: "Alice" },
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("整条路由挂在 SuperAdminGuard 之下", () => {
    const guards = Reflect.getMetadata(
      "__guards__",
      DeviceTestAccessController,
    ) as unknown[];

    expect(guards).toContain(SuperAdminGuard);
  });

  it("GET 透传列表筛选条件", async () => {
    access.list.mockResolvedValue({ enabled: {}, items: [], total: 0 });

    await controller.list({
      keyword: "aa:bb",
      includeRevoked: true,
      page: 2,
      pageSize: 10,
    });

    expect(access.list).toHaveBeenCalledWith({
      keyword: "aa:bb",
      includeRevoked: true,
      page: 2,
      pageSize: 10,
    });
  });

  it("POST 添加时把 JWT 里的 actor 一起传下去", async () => {
    access.add.mockResolvedValue({ item: {}, reactivated: false });

    await controller.add(
      { deviceId: "aa:bb", note: "3 号样机", reason: "需要验证新一集" },
      req,
    );

    expect(access.add).toHaveBeenCalledWith(
      { deviceId: "aa:bb", note: "3 号样机", reason: "需要验证新一集" },
      { username: "alice", displayName: "Alice" },
    );
  });

  it("POST revoke 用路径设备号 + 理由 + actor", async () => {
    access.revoke.mockResolvedValue({
      ok: true,
      clearedAdventureAssignment: false,
    });

    await controller.revoke("CN-001", { reason: "验证结束，收回资格" }, req);

    expect(access.revoke).toHaveBeenCalledWith(
      { deviceId: "CN-001", reason: "验证结束，收回资格" },
      { username: "alice", displayName: "Alice" },
    );
  });

  it("JWT 缺 username 时拒绝，不写一条没有责任人的白名单", async () => {
    await expect(
      controller.add(
        { deviceId: "aa:bb", reason: "需要验证新一集" },
        { user: {} },
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(access.add).not.toHaveBeenCalled();
  });
});
