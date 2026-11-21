import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { PrismaService } from "@/common/prisma/prisma.service";
import type { CharacterTimbrePort } from "./baidu-agent.types";

/** 缓存有效期：过期后下一次读回源；失败时继续用旧值 */
export const CHARACTER_TIMBRE_CACHE_TTL_MS = 60_000;

/** key 归一化：trim + 小写，空串视为未配置 */
export function normalizeCharacterKey(
  raw: string | null | undefined,
): string | null {
  if (typeof raw !== "string") return null;
  const key = raw.trim().toLowerCase();
  return key.length > 0 ? key : null;
}

/**
 * IP/角色 → timbreId 映射的只读缓存。
 *
 * 设备端 getvalue 每轮都查，必须热路径零 DB：启动预加载 + 60s TTL +
 * 管理端写后 invalidate。刷新失败时保留上次成功值，只有从未成功加载过
 * 才返回 null（由 getvalue 按 v1.4 §4.3 fail-closed 抛 500）。
 */
@Injectable()
export class CharacterTimbreService
  implements CharacterTimbrePort, OnModuleInit
{
  private readonly logger = new Logger(CharacterTimbreService.name);
  private cache: ReadonlyMap<string, string> | null = null;
  private loadedAt = 0;
  private inFlight: Promise<void> | null = null;

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    await this.reload();
  }

  async get(characterKey: string | null): Promise<string | null> {
    const key = normalizeCharacterKey(characterKey);
    if (!key) return null;

    await this.ensureFresh();
    return this.cache?.get(key) ?? null;
  }

  invalidate(): void {
    this.loadedAt = 0;
  }

  async reload(): Promise<void> {
    await this.refresh();
  }

  private async ensureFresh(): Promise<void> {
    if (
      this.cache !== null &&
      Date.now() - this.loadedAt <= CHARACTER_TIMBRE_CACHE_TTL_MS
    ) {
      return;
    }
    await this.refresh();
  }

  /** 并发读共享同一次回源，避免缓存过期瞬间打出一串相同查询 */
  private async refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.load().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async load(): Promise<void> {
    try {
      const rows = await this.prisma.characterTimbre.findMany();
      const next = new Map<string, string>();
      for (const row of rows) {
        const key = normalizeCharacterKey(row.characterKey);
        const timbreId =
          typeof row.timbreId === "string" ? row.timbreId.trim() : "";
        if (key && timbreId) next.set(key, timbreId);
      }
      this.cache = next;
      this.loadedAt = Date.now();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.cache === null) {
        this.logger.warn(
          `character timbre preload failed; getvalue stays fail-closed: ${message}`,
        );
      } else {
        this.logger.warn(
          `character timbre refresh failed; serving stale cache: ${message}`,
        );
      }
    }
  }
}
