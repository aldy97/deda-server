import { Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "@/common/prisma/prisma.service";
import {
  DEFAULT_REPORT_TIMEZONE,
  reportDateInTimezone,
} from "@/modules/learning-stats/parent-report-date.util";
import type { ConversationNetworkMode } from "./network-mode.util";

export interface RecordTurnInput {
  deviceId: string;
  networkMode: ConversationNetworkMode;
  spokeAt: Date;
}

type TurnCounters = {
  wifiTurns: number;
  fourGTurns: number;
  unknownTurns: number;
};

/**
 * 对话网络日聚合写入器。
 *
 * 每条 role=user 消息落库成功后调用一次；按 (date, deviceId) upsert 增量。
 * 无外键，删除 messages / devices 不影响历史聚合。
 * 永不抛错：聚合失败只记日志，不能反过来影响对话主链路。
 */
@Injectable()
export class ConversationNetworkAggregator {
  private readonly logger = new Logger(ConversationNetworkAggregator.name);

  constructor(private readonly prisma: PrismaService) {}

  async recordTurn(input: RecordTurnInput): Promise<void> {
    const deviceId = input.deviceId.trim().toLowerCase();
    if (!deviceId) return;

    const date = reportDateInTimezone(input.spokeAt, DEFAULT_REPORT_TIMEZONE);
    const update: Prisma.ConversationNetworkDailyUpdateInput = {
      lastSeenAt: input.spokeAt,
    };
    if (input.networkMode === "wifi") {
      update.wifiTurns = { increment: 1 };
    } else if (input.networkMode === "4g") {
      update.fourGTurns = { increment: 1 };
    } else {
      update.unknownTurns = { increment: 1 };
    }

    try {
      await this.prisma.conversationNetworkDaily.upsert({
        where: { date_deviceId: { date, deviceId } },
        create: {
          date,
          deviceId,
          ...this.initialCounters(input.networkMode),
          firstSeenAt: input.spokeAt,
          lastSeenAt: input.spokeAt,
        },
        update,
      });
    } catch (error) {
      if ((error as { code?: string }).code === "P2002") {
        try {
          await this.prisma.conversationNetworkDaily.update({
            where: { date_deviceId: { date, deviceId } },
            data: update,
          });
          return;
        } catch (retryError) {
          this.logger.error(
            `recordTurn retry failed for device=${deviceId} date=${date}`,
            retryError as Error,
          );
          return;
        }
      }
      this.logger.error(
        `recordTurn failed for device=${deviceId} date=${date}`,
        error as Error,
      );
    }
  }

  private initialCounters(mode: ConversationNetworkMode): TurnCounters {
    return {
      wifiTurns: mode === "wifi" ? 1 : 0,
      fourGTurns: mode === "4g" ? 1 : 0,
      unknownTurns: mode === "wifi" || mode === "4g" ? 0 : 1,
    };
  }
}
