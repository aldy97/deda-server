import { Injectable, Logger } from "@nestjs/common";
import { SleepConfigsService } from "./sleep-configs.service";
import { LlmService } from "@/modules/llm/llm.service";

/**
 * 孩子语音修改哄睡配置（sleep_config 意图的处理层）。
 *
 * 职责：
 * - 小模型从孩子的话里抽取「要改哪个字段、改成什么值」；
 * - 白名单校验（孩子语音只能改 contentType / durationMinutes / sleepTime，
 *   enabled / forceSleep 仅家长端可改，本层根本不接受这两个字段）；
 * - 落库走 SleepConfigsService.applyVoiceUpdate；
 * - 回复为确定性模板话术，不走 LLM，保证可控、零幻觉。
 *
 * 所有外部依赖（LLM / DB）异常一律内部 catch，返回兜底话术，
 * 不向上抛 —— 语音链路不能因为配置解析失败而整轮无回复。
 */

export type SleepConfigField = "contentType" | "durationMinutes" | "sleepTime";

export interface SleepVoiceConfigResult {
  replyText: string;
  applied: boolean;
  field?: SleepConfigField;
}

const CONTENT_TYPES = ["story", "song", "mixed"] as const;
type ContentType = (typeof CONTENT_TYPES)[number];

const ALLOWED_DURATIONS = [10, 15, 20, 25, 30] as const;

const SLEEP_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/** 哄睡内容类型 → 孩子能听懂的叫法 */
const CONTENT_TYPE_LABEL: Record<ContentType, string> = {
  story: "睡前故事",
  song: "睡前儿歌",
  mixed: "睡前故事和儿歌",
};

const EXTRACT_SYSTEM_PROMPT = `你是儿童陪伴产品的哄睡配置解析器。孩子会通过语音要求修改哄睡设置。
从孩子的话中抽取要修改的字段，只输出一行 JSON，禁止任何解释。

字段与取值：
- contentType：哄睡内容类型，只能是 "story"（睡前故事）、"song"（睡前儿歌）、"mixed"（故事加儿歌都要）
- durationMinutes：哄睡时长分钟数，只能是 10、15、20、25、30 之一；就近取档
- sleepTime：哄睡开始时间，24 小时制 "HH:mm"，例如晚上九点半是 "21:30"

输出格式：
- 能确定字段：{"field":"contentType","value":"song"} 或 {"field":"durationMinutes","value":20} 或 {"field":"sleepTime","value":"21:30"}
- 无法确定要改什么：{"field":null}

示例：
孩子：以后睡前都听儿歌 → {"field":"contentType","value":"song"}
孩子：我想听睡前故事 → {"field":"contentType","value":"story"}
孩子：故事和儿歌都要 → {"field":"contentType","value":"mixed"}
孩子：哄睡改成二十分钟 → {"field":"durationMinutes","value":20}
孩子：明天九点半哄我睡觉 → {"field":"sleepTime","value":"21:30"}
孩子：哄睡嘛随便啦 → {"field":null}`;

@Injectable()
export class SleepVoiceConfigService {
  private readonly logger = new Logger(SleepVoiceConfigService.name);

  constructor(
    private readonly sleepConfigs: SleepConfigsService,
    private readonly llm: LlmService,
  ) {}

  /**
   * 处理一句 sleep_config 意图的孩子语音：
   * 抽取 → 校验 → 落库 → 返回确认/兜底话术。
   */
  async handle(
    deviceInternalId: string,
    asrText: string,
  ): Promise<SleepVoiceConfigResult> {
    const extracted = await this.extract(deviceInternalId, asrText);
    if (!extracted) {
      return { replyText: this.fallbackReply(), applied: false };
    }

    const patch = this.validate(extracted);
    if (!patch) {
      return {
        replyText: this.fallbackReply(extracted.field),
        applied: false,
        field: extracted.field,
      };
    }

    try {
      await this.sleepConfigs.applyVoiceUpdate(deviceInternalId, patch);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Apply voice sleep config failed (device=${deviceInternalId}): ${message}`,
      );
      return { replyText: this.fallbackReply(), applied: false };
    }

    return {
      replyText: this.confirmReply(extracted.field, extracted.value),
      applied: true,
      field: extracted.field,
    };
  }

  /** 小模型抽取目标字段与值；任何异常/解析失败返回 null */
  private async extract(
    deviceInternalId: string,
    asrText: string,
  ): Promise<{ field: SleepConfigField; value: unknown } | null> {
    let text: string;
    try {
      const result = await this.llm.complete({
        scene: "sleep_config_extract",
        deviceId: deviceInternalId,
        model: this.llm.smallModelName,
        temperature: 0,
        maxTokens: 64,
        messages: [
          { role: "system", content: EXTRACT_SYSTEM_PROMPT },
          { role: "user", content: `孩子：${asrText}` },
        ],
      });
      text = result.text;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Sleep config extraction LLM failed (device=${deviceInternalId}): ${message}`,
      );
      return null;
    }

    let parsed: { field?: unknown; value?: unknown };
    try {
      // 兼容小模型输出带 ```json 包裹或前后多余文字的情况：截取首个 {...}
      const start = text.indexOf("{");
      const end = text.lastIndexOf("}");
      if (start < 0 || end <= start) {
        return null;
      }
      parsed = JSON.parse(text.slice(start, end + 1));
    } catch {
      this.logger.warn(
        `Sleep config extraction returned malformed output: ${text}`,
      );
      return null;
    }

    if (
      parsed.field !== "contentType" &&
      parsed.field !== "durationMinutes" &&
      parsed.field !== "sleepTime"
    ) {
      return null;
    }

    return { field: parsed.field, value: parsed.value };
  }

  /**
   * 白名单校验 + 组装落库 patch。
   * 返回 null 表示值非法，不落库。
   */
  private validate(extracted: {
    field: SleepConfigField;
    value: unknown;
  }): Parameters<SleepConfigsService["applyVoiceUpdate"]>[1] | null {
    switch (extracted.field) {
      case "contentType": {
        if (
          typeof extracted.value !== "string" ||
          !CONTENT_TYPES.includes(extracted.value as ContentType)
        ) {
          return null;
        }
        return { contentType: extracted.value };
      }
      case "durationMinutes": {
        const minutes =
          typeof extracted.value === "number"
            ? extracted.value
            : Number(extracted.value);
        if (
          !Number.isInteger(minutes) ||
          !ALLOWED_DURATIONS.includes(
            minutes as (typeof ALLOWED_DURATIONS)[number],
          )
        ) {
          return null;
        }
        // 语音改时长即视为手动模式
        return { durationMode: "custom", durationMinutes: minutes };
      }
      case "sleepTime": {
        if (
          typeof extracted.value !== "string" ||
          !SLEEP_TIME_PATTERN.test(extracted.value)
        ) {
          return null;
        }
        return { sleepTime: extracted.value };
      }
    }
  }

  /** 应用成功后的确定性确认话术 */
  private confirmReply(field: SleepConfigField, value: unknown): string {
    switch (field) {
      case "contentType":
        return `好呀，以后哄睡时间就放${CONTENT_TYPE_LABEL[value as ContentType]}啦！`;
      case "durationMinutes":
        return `好呀，以后哄睡时间就改成 ${value} 分钟啦！`;
      case "sleepTime":
        return `好呀，以后 ${value} 我就来哄你睡觉啦！`;
    }
  }

  /** 抽取失败 / 值非法 / 落库失败的兜底话术 */
  private fallbackReply(field?: SleepConfigField): string {
    if (field === "durationMinutes") {
      return "这个时长我做不到哦，可以说哄睡 10 分钟、15 分钟、20 分钟、25 分钟或者 30 分钟。";
    }
    if (field === "sleepTime") {
      return "这个时间我没听懂哦，可以说晚上九点、九点半这样的时间。";
    }
    return "这个我还没有学会哦，可以告诉我睡前想听故事还是儿歌，或者说几点哄你睡觉。";
  }
}
