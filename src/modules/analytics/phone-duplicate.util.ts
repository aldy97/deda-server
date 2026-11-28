import { PrismaService } from "@/common/prisma/prisma.service";

/**
 * 批量找出被多个家长账号使用的手机号。
 *
 * 口径与 `GET /analytics/parents/:userId` 的 `phoneDuplicate` 一致：
 * 同一号码在 `users.phone` 上出现 ≥2 次即视为重复。传入一条手机号时
 * 等价于「是否存在其他账号使用同一号码」。
 *
 * 空值不参与比较；返回值是去重后的号码集合。
 */
export async function findDuplicatePhones(
  prisma: PrismaService,
  phones: Array<string | null | undefined>,
): Promise<Set<string>> {
  const unique = Array.from(
    new Set(
      phones.filter(
        (phone): phone is string => typeof phone === "string" && phone !== "",
      ),
    ),
  );
  if (unique.length === 0) return new Set();

  const groups = await prisma.user.groupBy({
    by: ["phone"],
    where: { phone: { in: unique } },
    _count: { _all: true },
  });

  return new Set(
    groups
      .filter((group) => group.phone !== null && group._count._all >= 2)
      .map((group) => group.phone as string),
  );
}
