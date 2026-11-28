import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { UpdateProfileDto } from "./update-profile.dto";

describe("UpdateProfileDto", () => {
  function validateInput(input: Record<string, unknown>) {
    return validate(plainToInstance(UpdateProfileDto, input));
  }

  function properties(errors: Awaited<ReturnType<typeof validate>>) {
    return errors.map((error) => error.property);
  }

  it("接受合法昵称，并先 trim", async () => {
    const instance = plainToInstance(UpdateProfileDto, {
      nickname: "  熊熊妈妈  ",
    });
    expect(instance.nickname).toBe("熊熊妈妈");
    expect(await validate(instance)).toHaveLength(0);
  });

  it("昵称可省略，允许只更新性别或生日", async () => {
    expect(await validateInput({ gender: "female" })).toHaveLength(0);
    expect(await validateInput({ birthday: "1990-05-20" })).toHaveLength(0);
  });

  it("边界：1 字与 20 字均通过", async () => {
    expect(await validateInput({ nickname: "熊" })).toHaveLength(0);
    expect(await validateInput({ nickname: "熊".repeat(20) })).toHaveLength(0);
  });

  it.each(["", "   "])("空白昵称 %p 拒绝", async (nickname) => {
    expect(properties(await validateInput({ nickname }))).toContain("nickname");
  });

  it("超 20 字拒绝", async () => {
    expect(
      properties(await validateInput({ nickname: "熊".repeat(21) })),
    ).toContain("nickname");
  });

  it.each([1, true, ["熊"], { name: "熊" }])(
    "非字符串昵称 %p 拒绝",
    async (nickname) => {
      expect(properties(await validateInput({ nickname }))).toContain(
        "nickname",
      );
    },
  );

  it.each(["male", "female", null])("性别 %p 通过", async (gender) => {
    expect(await validateInput({ gender })).toHaveLength(0);
  });

  it.each(["m", "男", "", 1, true])("非法性别 %p 拒绝", async (gender) => {
    expect(properties(await validateInput({ gender }))).toContain("gender");
  });

  it.each(["1900-01-01", "1990-05-20", "2024-02-29", null])(
    "生日 %p 通过",
    async (birthday) => {
      expect(await validateInput({ birthday })).toHaveLength(0);
    },
  );

  it.each([
    "2026-02-29",
    "2026-04-31",
    "1899-12-31",
    "2999-01-01",
    "1990-1-1",
    "",
    19900520,
  ])("非法生日 %p 拒绝", async (birthday) => {
    expect(properties(await validateInput({ birthday }))).toContain("birthday");
  });

  it("空对象通过 DTO 校验，由 service 拒绝空更新", async () => {
    expect(await validateInput({})).toHaveLength(0);
  });
});
