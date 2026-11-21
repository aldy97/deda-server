import { UnauthorizedException } from "@nestjs/common";
import { JwtStrategy } from "./jwt.strategy";

describe("JwtStrategy", () => {
  const strategy = new JwtStrategy({
    get: jest.fn().mockReturnValue(undefined),
  } as never);

  it("validate 有 sub 时返回用户标识", async () => {
    const r = await strategy.validate({ sub: "u1", openid: "o1" });
    expect(r).toEqual({ userId: "u1", openid: "o1" });
  });

  it("validate 缺 sub 时拒绝", async () => {
    await expect(strategy.validate({ sub: "", openid: "" })).rejects.toThrow(
      UnauthorizedException,
    );
  });
});
