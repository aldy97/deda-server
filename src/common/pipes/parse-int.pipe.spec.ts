import { BadRequestException } from "@nestjs/common";
import { ParseIntPipe } from "./parse-int.pipe";

describe("ParseIntPipe", () => {
  const pipe = new ParseIntPipe();

  it("解析数字字符串", () => {
    expect(pipe.transform("42", { data: "id", type: "param" } as never)).toBe(
      42,
    );
  });

  it("非数字抛 BadRequestException", () => {
    expect(() =>
      pipe.transform("abc", { data: "id", type: "param" } as never),
    ).toThrow(BadRequestException);
  });
});
