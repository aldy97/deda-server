import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  VoiceCatalogEntry,
  VoiceCatalogPort,
  TIMBRE_LANGUAGE_BY_LANG,
} from "./baidu-agent.types";

/**
 * 音色目录服务（placeholder 实现）。
 *
 * TODO(Q1/Q7): 音色目录当前是 placeholder，来自 VOICE_CATALOG_JSON 配置，默认为空。
 * 权威来源是百度 GET /api/v1/timbres（返回 timbreId/name/status/language/auditionAudioUrl），
 * 但该接口需要 BCE 签名，我方无 AK/SK、设备也未为此操作签名，无法自动同步。
 * 需机芯公司用其账号导出音色清单后填入配置；拿到只读 AK/SK 后改成定时同步。
 *
 * TODO(Q8): auditionAudioUrl 有效期仅 1 小时，不能入库长期持有；
 * App 试听功能需先解决续签通道，未解决前不下发该字段。
 */
@Injectable()
export class VoiceCatalogService implements VoiceCatalogPort {
  private readonly logger = new Logger(VoiceCatalogService.name);
  private readonly all: VoiceCatalogEntry[];
  private readonly usable: VoiceCatalogEntry[];

  constructor(private readonly configService: ConfigService) {
    const raw = this.configService.get<string>("VOICE_CATALOG_JSON");
    this.all = this.parseCatalog(raw);
    this.usable = this.all.filter((e) => e.status === "TRAINED");
    if (this.all.length === 0 && raw && raw.trim().length > 0) {
      this.logger.warn(
        "VOICE_CATALOG_JSON is configured but yielded no valid entries; " +
          "check JSON structure and entry field types",
      );
    }
  }

  /** 结构合法的条目原样返回（含 UNTRAINED）。 */
  listAll(): VoiceCatalogEntry[] {
    return this.all;
  }

  /** 仅 status === "TRAINED" 的条目。 */
  listUsable(): VoiceCatalogEntry[] {
    return this.usable;
  }

  /**
   * usable 且 language 匹配 instance lang。
   *
   * lang 为空或映射不到 TIMBRE_LANGUAGE_BY_LANG → 返回空数组（fail-closed）：
   * switchSceneRole 明确「不可跨语言互切角色」，在映射未确认前严格拒绝未知语种。
   */
  listForLang(lang: string | undefined): VoiceCatalogEntry[] {
    if (!lang) return [];
    const timbreLang = TIMBRE_LANGUAGE_BY_LANG[lang];
    if (!timbreLang) return [];
    return this.usable.filter((e) => e.language === timbreLang);
  }

  /**
   * 按 timbreId 查找可用条目；可选 lang 进一步做语种匹配。
   * 未找到或条目非 TRAINED 返回 null。
   */
  find(timbreId: string, lang?: string): VoiceCatalogEntry | null {
    const entry = this.usable.find((e) => e.timbreId === timbreId);
    if (!entry) return null;
    if (lang) {
      const timbreLang = TIMBRE_LANGUAGE_BY_LANG[lang];
      if (!timbreLang || entry.language !== timbreLang) return null;
    }
    return entry;
  }

  /** listUsable().length > 0 */
  get available(): boolean {
    return this.usable.length > 0;
  }

  // ---------------------------------------------------------------------------
  // private helpers
  // ---------------------------------------------------------------------------

  private parseCatalog(raw: string | undefined): VoiceCatalogEntry[] {
    if (!raw || raw.trim().length === 0) return [];

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .map((item: unknown) => this.validateEntry(item))
      .filter((e): e is VoiceCatalogEntry => e !== null);
  }

  private validateEntry(item: unknown): VoiceCatalogEntry | null {
    if (typeof item !== "object" || item === null) return null;
    const obj = item as Record<string, unknown>;

    // timbreId: string or number (百度侧是 Long)
    const rawTimbreId = obj.timbreId;
    let timbreId: string;
    if (typeof rawTimbreId === "string" && rawTimbreId.length > 0) {
      timbreId = rawTimbreId;
    } else if (
      typeof rawTimbreId === "number" &&
      Number.isFinite(rawTimbreId)
    ) {
      timbreId = String(rawTimbreId);
    } else {
      return null;
    }

    const name = obj.name;
    if (typeof name !== "string") return null;

    const status = obj.status;
    if (typeof status !== "string") return null;

    const language = obj.language;
    if (typeof language !== "string") return null;

    return { timbreId, name, status, language };
  }
}
