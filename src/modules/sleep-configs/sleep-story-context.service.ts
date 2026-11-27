import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "@/common/prisma/prisma.service";

/**
 * 哄睡故事的单轮上限：只保留能支撑「今天的旅程」复述的叙述量，
 * 避免把整集冒险塞进 prompt 推高首音延迟与成本。
 */
export const SLEEP_STORY_SUMMARY_MAX_CHARS = 600;

/**
 * 哄睡话术的上下文取数：把当天冒险播报压成一段可复述的摘要。
 *
 * 口径：
 * - 只取当天、mode=adventure_story、role=assistant 的消息（孩子自己的话不进摘要）；
 * - 过滤以问号结尾的互动引导，避免晚安故事把冒险里的提问再问一遍；
 * - 超长在句末截断，不做二次 LLM 总结（不增加调用与延迟）；
 * - 任何失败都返回空串，由话术走「原野的夜晚」兜底，绝不阻塞哄睡。
 */
@Injectable()
export class SleepStoryContextService {
  private readonly logger = new Logger(SleepStoryContextService.name);

  constructor(private readonly prisma: PrismaService) {}

  async buildVars(
    deviceInternalId: string,
  ): Promise<{ todayAdventureSummary: string }> {
    try {
      const now = new Date();
      const startOfToday = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate(),
      );
      const rows = await this.prisma.message.findMany({
        where: {
          deviceId: deviceInternalId,
          mode: "adventure_story",
          role: "assistant",
          spokeAt: { gte: startOfToday },
        },
        orderBy: { spokeAt: "asc" },
        select: { content: true },
      });
      return { todayAdventureSummary: this.summarize(rows) };
    } catch (error) {
      this.logger.warn(
        `Sleep story context failed for device=${deviceInternalId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return { todayAdventureSummary: "" };
    }
  }

  private summarize(rows: Array<{ content: string }>): string {
    const texts = rows
      .map((row) => row.content.trim())
      .filter((text) => text.length > 0)
      .filter((text) => !/[？?]\s*$/.test(text));
    const joined = texts.join("\n");
    if (joined.length <= SLEEP_STORY_SUMMARY_MAX_CHARS) return joined;

    const head = joined.slice(0, SLEEP_STORY_SUMMARY_MAX_CHARS);
    const breakAt = Math.max(
      head.lastIndexOf("。"),
      head.lastIndexOf("！"),
      head.lastIndexOf("？"),
      head.lastIndexOf("\n"),
    );
    const cut =
      breakAt >= SLEEP_STORY_SUMMARY_MAX_CHARS / 2
        ? head.slice(0, breakAt + 1)
        : head;
    return cut.trim();
  }
}
