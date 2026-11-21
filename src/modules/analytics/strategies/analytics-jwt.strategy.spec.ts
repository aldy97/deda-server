import { UnauthorizedException } from "@nestjs/common";
import { AnalyticsJwtStrategy } from "./analytics-jwt.strategy";

describe("AnalyticsJwtStrategy", () => {
  const build = () =>
    new AnalyticsJwtStrategy({ get: jest.fn(() => undefined) } as never);

  it("validate 合法 payload 返回 adminId 与 scopes 默认值", async () => {
    const r = await build().validate({
      sub: "u1",
      username: "alice",
      displayName: "Alice",
      scope: "analytics",
    });
    expect(r.adminId).toBe("u1");
    expect(r.scopes).toEqual(["analytics"]);
  });

  it("validate 过滤 scopes 里的非 string/空串", async () => {
    const r = await build().validate({
      sub: "u1",
      username: "alice",
      displayName: "Alice",
      scope: "analytics",
      scopes: ["analytics", "devices", "", 123 as never],
    });
    expect(r.scopes).toEqual(["analytics", "devices"]);
  });

  it("validate 缺 sub 或 scope 非 analytics → 拒绝", async () => {
    const strategy = build();
    await expect(
      strategy.validate({
        sub: "",
        username: "alice",
        displayName: "Alice",
        scope: "analytics",
      }),
    ).rejects.toThrow(UnauthorizedException);
    await expect(
      strategy.validate({
        sub: "u1",
        username: "alice",
        displayName: "Alice",
        scope: "other",
      }),
    ).rejects.toThrow(UnauthorizedException);
  });
});
