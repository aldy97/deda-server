import { withSerializableRetry } from "./serializable-retry";

/** 构造 Prisma P2034（串行化冲突/死锁）形态的错误 */
function p2034(): Error & { code: string } {
  const err = new Error(
    "Transaction failed due to a write conflict or a deadlock",
  ) as Error & { code: string };
  err.code = "P2034";
  return err;
}

describe("withSerializableRetry", () => {
  it("一次成功：直接返回结果，不重试", async () => {
    const fn = jest.fn().mockResolvedValue("ok");

    await expect(withSerializableRetry(fn)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("P2034 偶发后成功：自动重试并返回结果", async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(p2034())
      .mockRejectedValueOnce(p2034())
      .mockResolvedValue("ok");

    await expect(withSerializableRetry(fn, { baseDelayMs: 0 })).resolves.toBe(
      "ok",
    );
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("P2034 持续超过上限：抛最后一次错误，总调用次数等于上限", async () => {
    const fn = jest.fn().mockRejectedValue(p2034());

    await expect(
      withSerializableRetry(fn, { maxAttempts: 3, baseDelayMs: 0 }),
    ).rejects.toMatchObject({ code: "P2034" });
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("非 P2034 的 Prisma 错误（如 P2002 唯一约束）：不重试直接抛", async () => {
    const err = new Error("Unique constraint failed") as Error & {
      code: string;
    };
    err.code = "P2002";
    const fn = jest.fn().mockRejectedValue(err);

    await expect(withSerializableRetry(fn, { baseDelayMs: 0 })).rejects.toBe(
      err,
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("业务异常（HttpException 等无 code 错误）：不重试直接抛", async () => {
    const err = new Error("device not found");
    const fn = jest.fn().mockRejectedValue(err);

    await expect(withSerializableRetry(fn, { baseDelayMs: 0 })).rejects.toBe(
      err,
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("默认上限为 3 次", async () => {
    const fn = jest.fn().mockRejectedValue(p2034());

    await expect(
      withSerializableRetry(fn, { baseDelayMs: 0 }),
    ).rejects.toMatchObject({ code: "P2034" });
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
