import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import axios from "axios";
import { PrismaService } from "@/common/prisma/prisma.service";
import { WechatTokenService } from "@/common/wechat/wechat-token.service";

/**
 * 哄睡提醒模板的字段 key 映射。
 * 正式模板申请下来后只需改这里（当前为占位 key）。
 */
const SLEEP_REMINDER_DATA_KEYS = {
  childName: "thing1",
  sleepTime: "time2",
  phrase: "phrase3",
} as const;

/** 微信 thing 类型字段最长 20 字符 */
const MAX_THING_VALUE_LENGTH = 20;

/** 微信 errcode：用户订阅额度用尽 */
const ERRCODE_QUOTA_EXHAUSTED = 43101;
/** 微信 errcode：access_token 无效 / 过期 */
const ERRCODE_TOKEN_INVALID = [40001, 42001];

const SEND_URL = "https://api.weixin.qq.com/cgi-bin/message/subscribe/send";

export interface SleepReminderInput {
  /** 设备内部 ID（数据库 uuid） */
  deviceInternalId: string;
  /** 设备业务 ID（跳转页面参数用） */
  deviceId: string;
  /** 哄睡时间 HH:mm */
  sleepTime: string;
}

export interface SendResult {
  sent: number;
  skipped: number;
}

/**
 * 订阅消息发送器。
 * 按设备当前绑定关系全量推送给所有家长（解绑/wipe 后关系解除，
 * 发送时 join 不到记录即天然不再推送，无需按设备清理订阅表）。
 */
@Injectable()
export class PushSenderService {
  private readonly logger = new Logger(PushSenderService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly wechatToken: WechatTokenService,
    private readonly configService: ConfigService,
  ) {}

  async sendSleepReminder(input: SleepReminderInput): Promise<SendResult> {
    if (
      this.configService.get<string>("PUSH_NOTIFICATIONS_ENABLED") !== "true"
    ) {
      return { sent: 0, skipped: 0 };
    }
    const templateId = this.configService.get<string>(
      "WECHAT_TMPL_SLEEP_REMINDER",
    );
    if (!templateId) {
      this.logger.warn("WECHAT_TMPL_SLEEP_REMINDER not configured, skip push");
      return { sent: 0, skipped: 0 };
    }
    let token = await this.wechatToken.getAccessToken();
    if (!token) {
      return { sent: 0, skipped: 0 };
    }

    const bindings = await this.prisma.userDeviceBinding.findMany({
      where: { deviceId: input.deviceInternalId },
      include: { user: true },
    });
    if (bindings.length === 0) {
      return { sent: 0, skipped: 0 };
    }

    const child = await this.prisma.childProfile.findUnique({
      where: { deviceId: input.deviceInternalId },
      select: { name: true, englishName: true },
    });
    const childName = child?.name || child?.englishName || "宝贝";

    let sent = 0;
    let skipped = 0;
    for (const binding of bindings) {
      const openid = binding.user?.openid;
      if (!openid) {
        skipped += 1;
        continue;
      }
      const subscription = await this.prisma.pushSubscription.findUnique({
        where: {
          userId_templateId: { userId: binding.userId, templateId },
        },
      });
      if (
        !subscription ||
        subscription.status !== "active" ||
        subscription.quota <= 0
      ) {
        skipped += 1;
        continue;
      }

      try {
        let errcode = await this.sendOnce(
          templateId,
          token,
          openid,
          input,
          childName,
        );
        if (ERRCODE_TOKEN_INVALID.includes(errcode)) {
          const fresh = await this.wechatToken.getAccessToken({
            forceRefresh: true,
          });
          if (fresh) {
            token = fresh;
            errcode = await this.sendOnce(
              templateId,
              token,
              openid,
              input,
              childName,
            );
          }
        }

        if (errcode === 0) {
          await this.prisma.pushSubscription.updateMany({
            where: { userId: binding.userId, templateId, quota: { gt: 0 } },
            data: { quota: { decrement: 1 } },
          });
          sent += 1;
        } else if (errcode === ERRCODE_QUOTA_EXHAUSTED) {
          await this.prisma.pushSubscription.updateMany({
            where: { userId: binding.userId, templateId },
            data: { quota: 0, status: "exhausted" },
          });
          skipped += 1;
        } else {
          this.logger.warn(
            `subscribeMessage.send failed: errcode=${errcode} user=${binding.userId} device=${input.deviceId}`,
          );
          skipped += 1;
        }
      } catch (err) {
        this.logger.warn(
          `subscribeMessage.send error: user=${binding.userId} device=${input.deviceId} ${err}`,
        );
        skipped += 1;
      }
    }
    return { sent, skipped };
  }

  /** 发送一次，返回微信 errcode（无 errcode 视为成功 0） */
  private async sendOnce(
    templateId: string,
    token: string,
    openid: string,
    input: SleepReminderInput,
    childName: string,
  ): Promise<number> {
    const res = await axios.post(
      `${SEND_URL}?access_token=${token}`,
      {
        touser: openid,
        template_id: templateId,
        page: `/pages/sleep-manage/sleep-manage?id=${input.deviceId}`,
        data: {
          [SLEEP_REMINDER_DATA_KEYS.childName]: {
            value: `${childName}的哄睡时间到啦`.slice(
              0,
              MAX_THING_VALUE_LENGTH,
            ),
          },
          [SLEEP_REMINDER_DATA_KEYS.sleepTime]: { value: input.sleepTime },
          [SLEEP_REMINDER_DATA_KEYS.phrase]: { value: "记得按时哄睡哦" },
        },
      },
      { timeout: 10000 },
    );
    const data = res.data as { errcode?: number };
    return data.errcode ?? 0;
  }
}
