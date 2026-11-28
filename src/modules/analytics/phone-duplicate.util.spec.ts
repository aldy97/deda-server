import { findDuplicatePhones } from "./phone-duplicate.util";

function buildPrisma(counts: Record<string, number>) {
  return {
    user: {
      groupBy: jest.fn(async ({ where }: any) => {
        const phones: string[] = where?.phone?.in ?? [];
        return phones
          .filter((phone) => (counts[phone] ?? 0) > 0)
          .map((phone) => ({
            phone,
            _count: { _all: counts[phone] ?? 0 },
          }));
      }),
    },
  };
}

describe("findDuplicatePhones", () => {
  it("同一个号码出现 ≥2 次才判重复", async () => {
    const prisma = buildPrisma({
      "13800138000": 2,
      "13900139000": 1,
      "13700137000": 3,
    });

    const result = await findDuplicatePhones(prisma as never, [
      "13800138000",
      "13900139000",
      "13700137000",
    ]);

    expect(result).toEqual(new Set(["13800138000", "13700137000"]));
  });

  it("去重入参后只查一次，空值不参与", async () => {
    const prisma = buildPrisma({ "13800138000": 2 });

    const result = await findDuplicatePhones(prisma as never, [
      "13800138000",
      "13800138000",
      null,
      undefined,
      "",
    ]);

    expect(result).toEqual(new Set(["13800138000"]));
    expect(prisma.user.groupBy).toHaveBeenCalledTimes(1);
    expect(prisma.user.groupBy).toHaveBeenCalledWith({
      by: ["phone"],
      where: { phone: { in: ["13800138000"] } },
      _count: { _all: true },
    });
  });

  it("没有有效号码时不查库", async () => {
    const prisma = buildPrisma({});

    const result = await findDuplicatePhones(prisma as never, [null, ""]);

    expect(result.size).toBe(0);
    expect(prisma.user.groupBy).not.toHaveBeenCalled();
  });
});
