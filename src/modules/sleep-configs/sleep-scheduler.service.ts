import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "@/common/prisma/prisma.service";
import { LlmService } from "@/modules/llm/llm.service";
import { VendorGateway } from "@/modules/vendor/vendor.gateway";
import { ConversationSessionService } from "@/modules/vendor/conversation-session.service";
import { PushSenderService } from "@/modules/push-notifications/push-sender.service";
import { SleepConfig } from "@prisma/client";

const SCAN_INTERVAL_MS = 60 * 1000;
// 单一时区约定：sleepTime 一律按北京时间解释
const SLEEP_TIMEZONE = "Asia/Shanghai";

type SleepConfigWithDevice = SleepConfig & {
  device: { id: string; deviceId: string };
};

function beijingParts(date: Date): { dateKey: string; hhmm: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: SLEEP_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = new Map(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return {
    dateKey: `${values.get("year")}-${values.get("month")}-${values.get("day")}`,
    hhmm: `${values.get("hour")}:${values.get("minute")}`,
  };
}

/**
 * 定时进入哄睡：每分钟扫描一次 enabled=true 的配置，
 * 到达 sleepTime（北京时间）时生成哄睡内容并经 Vendor WS 下行。
 * 约定：到点无条件进入；设备离线跳过当天不补发；每设备每天最多一次。
 */
@Injectable()
export class SleepSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SleepSchedulerService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly llmService: LlmService,
    private readonly configService: ConfigService,
    private readonly vendorGateway: VendorGateway,
    private readonly conversationSessionService: ConversationSessionService,
    private readonly pushSender: PushSenderService,
  ) {}

  onModuleInit() {
    if (this.configService.get<string>("SLEEP_SCHEDULER_ENABLED") !== "true") {
      return;
    }
    void this.triggerDueSleepEntries();
    this.timer = setInterval(() => {
      void this.triggerDueSleepEntries();
    }, SCAN_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async triggerDueSleepEntries(now = new Date()): Promise<void> {
    const { dateKey, hhmm } = beijingParts(now);
    const configs = (await this.prisma.sleepConfig.findMany({
      where: { enabled: true },
      include: { device: { select: { id: true, deviceId: true } } },
    })) as SleepConfigWithDevice[];

    for (const config of configs) {
      if (config.sleepTime !== hhmm) continue;
      if (config.lastTriggeredDate === dateKey) continue;

      // 先抢占当天触发标记：多实例/重启不重复，失败当天不重试不补发
      const claimed = await this.prisma.sleepConfig.updateMany({
        where: {
          id: config.id,
          OR: [
            { lastTriggeredDate: null },
            { lastTriggeredDate: { not: dateKey } },
          ],
        },
        data: { lastTriggeredDate: dateKey },
      });
      if (claimed.count !== 1) continue;

      // 服务通知与设备在线状态解耦：离线也推（WS 下行失败时家长的兜底提醒）
      try {
        await this.pushSender.sendSleepReminder({
          deviceInternalId: config.device.id,
          deviceId: config.device.deviceId,
          sleepTime: config.sleepTime,
        });
      } catch (error) {
        this.logger.warn(
          `Sleep push failed for ${config.device.deviceId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      try {
        await this.deliverSleepEntry(config);
      } catch (error) {
        this.logger.error(
          `Sleep entry failed for ${config.device.deviceId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  private async deliverSleepEntry(config: SleepConfigWithDevice) {
    const profile = await this.prisma.childProfile.findUnique({
      where: { deviceId: config.device.id },
      select: { name: true, englishName: true },
    });
    const childName = profile?.name || profile?.englishName || "宝贝";
    const story = await this.generateSleepContent(config, childName);
    const responseText = `晚安，${childName}。${story}`;

    const delivered = this.vendorGateway.pushSleepEntry(
      config.device.deviceId,
      {
        deviceId: config.device.deviceId,
        responseText,
        context: { mode: "sleep_story", trigger: "scheduled" },
        ttsOptions: {},
      },
    );
    if (!delivered) {
      this.logger.warn(
        `Sleep entry skipped: device ${config.device.deviceId} offline`,
      );
      return;
    }
    // 无条件覆写会话：孩子后续接话留在哄睡模式（45 分钟 TTL）
    await this.conversationSessionService.activateSleepMode(config.device.id);
  }

  /**
   * 生成哄睡内容。song/mixed 在儿歌内容源上线前降级为哄睡故事；
   * durationMinutes 暂不控制播放时长（LLM 故事长度不可精确控时）。
   */
  private async generateSleepContent(
    config: SleepConfigWithDevice,
    childName: string,
  ): Promise<string> {
    if (config.contentType !== "story") {
      this.logger.warn(
        `contentType=${config.contentType} not supported yet, falling back to story (device=${config.device.deviceId})`,
      );
    }
    const nameHint = childName !== "宝贝" ? `孩子叫${childName}。` : "";
    const result = await this.llmService.complete({
      scene: "sleep_story_generate",
      deviceId: config.device.id,
      temperature: 0.8,
      maxTokens: 600,
      messages: [
        {
          role: "system",
          content:
            "你是儿童陪伴设备的哄睡故事讲述者。讲一个温柔、安静、适合入睡的短故事，" +
            "100-200 字，不提问、不互动、不制造兴奋点，结尾自然落到睡觉。",
        },
        { role: "user", content: `${nameHint}请讲今晚的哄睡故事。` },
      ],
    });
    return result.text.trim();
  }
}
