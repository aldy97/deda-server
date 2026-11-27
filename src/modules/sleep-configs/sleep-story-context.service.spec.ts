import { Logger } from "@nestjs/common";
import { PrismaService } from "@/common/prisma/prisma.service";
import {
  SLEEP_STORY_SUMMARY_MAX_CHARS,
  SleepStoryContextService,
} from "./sleep-story-context.service";

function makeService(findMany: jest.Mock) {
  const prisma = { message: { findMany } };
  return new SleepStoryContextService(prisma as unknown as PrismaService);
}

describe("SleepStoryContextService", () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("只取今天、adventure_story、assistant 的消息，按时间正序拼接", async () => {
    const findMany = jest
      .fn()
      .mockResolvedValue([
        { content: "你们走进月光草地。" },
        { content: "   " },
        { content: "小河的水凉凉的。" },
      ]);
    const service = makeService(findMany);

    const vars = await service.buildVars("dev-internal-1");

    expect(vars.todayAdventureSummary).toBe(
      "你们走进月光草地。\n小河的水凉凉的。",
    );
    const args = findMany.mock.calls[0][0];
    expect(args.where).toMatchObject({
      deviceId: "dev-internal-1",
      mode: "adventure_story",
      role: "assistant",
    });
    expect(args.where.spokeAt.gte).toBeInstanceOf(Date);
    expect(args.orderBy).toEqual({ spokeAt: "asc" });
  });

  it("过滤以问号结尾的互动引导，避免晚安故事复述提问", async () => {
    const findMany = jest
      .fn()
      .mockResolvedValue([
        { content: "月光落在草地上。" },
        { content: "你想走哪一条路呀？" },
        { content: "前面有一座小桥。" },
      ]);
    const service = makeService(findMany);

    await expect(service.buildVars("dev-1")).resolves.toEqual({
      todayAdventureSummary: "月光落在草地上。\n前面有一座小桥。",
    });
  });

  it("超长摘要在句末截断且不超过上限", async () => {
    const sentence = "你们一起走过安静的小路。";
    const findMany = jest
      .fn()
      .mockResolvedValue([{ content: sentence.repeat(80) }]);
    const service = makeService(findMany);

    const { todayAdventureSummary } = await service.buildVars("dev-1");

    expect(todayAdventureSummary.length).toBeLessThanOrEqual(
      SLEEP_STORY_SUMMARY_MAX_CHARS,
    );
    expect(todayAdventureSummary.endsWith("。")).toBe(true);
  });

  it("超长且前半段没有句末标点时按硬上限截断", async () => {
    const findMany = jest
      .fn()
      .mockResolvedValue([{ content: "很长的一句话没有句号".repeat(80) }]);
    const service = makeService(findMany);

    const { todayAdventureSummary } = await service.buildVars("dev-1");

    expect(todayAdventureSummary).toHaveLength(SLEEP_STORY_SUMMARY_MAX_CHARS);
  });

  it("没有冒险播报时返回空串（走原野的夜晚兜底）", async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const service = makeService(findMany);

    await expect(service.buildVars("dev-1")).resolves.toEqual({
      todayAdventureSummary: "",
    });
  });

  it("查询以非 Error 值时同样降级为空串", async () => {
    const findMany = jest.fn().mockRejectedValue("db offline");
    const service = makeService(findMany);

    await expect(service.buildVars("dev-1")).resolves.toEqual({
      todayAdventureSummary: "",
    });
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      expect.stringContaining("db offline"),
    );
  });

  it("查询失败只 warn，返回空串，绝不阻塞哄睡", async () => {
    const findMany = jest.fn().mockRejectedValue(new Error("db down"));
    const service = makeService(findMany);

    await expect(service.buildVars("dev-1")).resolves.toEqual({
      todayAdventureSummary: "",
    });
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      expect.stringContaining("Sleep story context failed"),
    );
  });
});
