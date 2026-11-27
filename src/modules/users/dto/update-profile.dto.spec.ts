import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { UpdateProfileDto } from "./update-profile.dto";

describe("UpdateProfileDto", () => {
  function validateInput(input: Record<string, unknown>) {
    return validate(plainToInstance(UpdateProfileDto, input));
  }

  it("接受合法昵称，并先 trim", async () => {
    const instance = plainToInstance(UpdateProfileDto, {
      nickname: "  熊熊妈妈  ",
    });
    expect(instance.nickname).toBe("熊熊妈妈");
    expect(await validate(instance)).toHaveLength(0);
  });

  it("边界：1 字与 20 字均通过", async () => {
    expect(await validateInput({ nickname: "熊" })).toHaveLength(0);
    expect(await validateInput({ nickname: "熊".repeat(20) })).toHaveLength(0);
  });

  it.each(["", "   "])("空白昵称 %p 拒绝", async (nickname) => {
    const errors = await validateInput({ nickname });
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ property: "nickname" }),
      ]),
    );
  });

  it("超 20 字拒绝", async () => {
    const errors = await validateInput({ nickname: "熊".repeat(21) });
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ property: "nickname" }),
      ]),
    );
  });

  it.each([undefined, null, 1, true, ["熊"], { name: "熊" }])(
    "非字符串 %p 拒绝",
    async (nickname) => {
      const errors = await validateInput({ nickname });
      expect(errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ property: "nickname" }),
        ]),
      );
    },
  );
});
