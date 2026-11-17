import { BadRequestException, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "@/common/prisma/prisma.service";
import { ReportPushSubscriptionDto } from "./dto/report-push-subscription.dto";

/** 单次上报最多累计的推送额度（前端批量补额上限） */
export const MAX_QUOTA_PER_REPORT = 30;

/**
 * 订阅消息额度池（user + template 维度）：
 * accept → 额度累加；reject → 额度清零并标记 rejected。
 * 额度消耗与 exhausted 标记在 PushSenderService 发送时完成。
 */
@Injectable()
export class PushSubscriptionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  /** 允许上报的模板白名单（env 配置，未配置则全部拒绝） */
  private allowedTemplateIds(): string[] {
    return [
      this.configService.get<string>("WECHAT_TMPL_SLEEP_REMINDER"),
    ].filter((v): v is string => Boolean(v));
  }

  async report(userId: string, dto: ReportPushSubscriptionDto) {
    if (!this.allowedTemplateIds().includes(dto.templateId)) {
      throw new BadRequestException("不支持的模板 ID");
    }

    if (dto.result === "reject") {
      const saved = await this.prisma.pushSubscription.upsert({
        where: { userId_templateId: { userId, templateId: dto.templateId } },
        update: { quota: 0, status: "rejected" },
        create: {
          userId,
          templateId: dto.templateId,
          quota: 0,
          status: "rejected",
        },
      });
      return {
        templateId: saved.templateId,
        quota: saved.quota,
        status: saved.status,
      };
    }

    const delta = Math.min(dto.count ?? 1, MAX_QUOTA_PER_REPORT);
    const saved = await this.prisma.pushSubscription.upsert({
      where: { userId_templateId: { userId, templateId: dto.templateId } },
      update: { quota: { increment: delta }, status: "active" },
      create: {
        userId,
        templateId: dto.templateId,
        quota: delta,
        status: "active",
      },
    });
    return {
      templateId: saved.templateId,
      quota: saved.quota,
      status: saved.status,
    };
  }
}
