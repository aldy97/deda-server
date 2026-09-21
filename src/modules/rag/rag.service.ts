import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';

export interface TextbookUnit {
  unitId: string;
  name: string;
  sortOrder: number;
  cefrLevel?: string;
  content: string;
}

export interface Textbook {
  textbookId: string;
  name: string;
  description?: string;
  cefrLevel?: string;
  units: TextbookUnit[];
}

export interface RetrieveResult {
  textbookId: string;
  unitId: string;
  unitName: string;
  content: string;
  found: boolean;
}

/**
 * MVP 阶段极简 RAG 服务
 * - 教材内容以 JSON 文件形式存放在 data/textbooks/{textbookId}.json
 * - 按 textbookId + unitId 直接定位单元内容
 * - 不做 embedding/向量检索，返回整个单元 content 作为 LLM context
 */
@Injectable()
export class RagService {
  private readonly logger = new Logger(RagService.name);
  private readonly dataDir: string;

  constructor(private readonly configService: ConfigService) {
    // 优先使用环境变量指定目录；否则根据运行环境推断
    const configuredDir = this.configService.get<string>('TEXTBOOK_DATA_DIR');
    if (configuredDir) {
      this.dataDir = configuredDir;
    } else if (fs.existsSync(path.join(process.cwd(), 'data', 'textbooks'))) {
      this.dataDir = path.join(process.cwd(), 'data', 'textbooks');
    } else {
      // 编译后 dist 目录与 data 目录的相对关系
      this.dataDir = path.join(process.cwd(), '..', 'data', 'textbooks');
    }
  }

  /**
   * 加载指定教材文件
   * 优先尝试 .md，不存在则回退到 .json
   */
  loadTextbook(textbookId: string): Textbook | null {
    const mdPath = path.join(this.dataDir, `${textbookId}.md`);
    if (fs.existsSync(mdPath)) {
      return this.loadMarkdownTextbook(textbookId, mdPath);
    }

    const jsonPath = path.join(this.dataDir, `${textbookId}.json`);
    if (fs.existsSync(jsonPath)) {
      return this.loadJsonTextbook(textbookId, jsonPath);
    }

    this.logger.warn(`Textbook file not found: ${textbookId}.md or ${textbookId}.json`);
    return null;
  }

  private loadJsonTextbook(textbookId: string, filePath: string): Textbook | null {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(raw) as Textbook;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to load JSON textbook ${textbookId}: ${message}`);
      return null;
    }
  }

  /**
   * 解析 Markdown 教材文件
   * 支持多种 H2 标题格式：
   *   1. ## unit-id: Unit Name        （显式 unit id，推荐）
   *   2. ## Unit Name                 （隐式 unit id = slugify(name)）
   *   3. ## 1.2 Unit Name             （数字前缀会被去掉，unit id = slugify(name)）
   * 格式约定：
   *   # 教材名称
   *   ## unit-id: Unit Name
   *   单元内容（支持多行）
   *   ## next-unit-id: Next Unit Name
   *   ...
   */
  private loadMarkdownTextbook(textbookId: string, filePath: string): Textbook | null {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const lines = raw.split(/\r?\n/);

      let name = textbookId;
      const units: TextbookUnit[] = [];
      let currentUnit: Partial<TextbookUnit> | null = null;
      let currentContentLines: string[] = [];
      let sortOrder = 1;

      const flushUnit = () => {
        if (currentUnit && currentUnit.unitId) {
          units.push({
            unitId: currentUnit.unitId,
            name: currentUnit.name || currentUnit.unitId,
            sortOrder: currentUnit.sortOrder || sortOrder++,
            cefrLevel: currentUnit.cefrLevel,
            content: currentContentLines.join('\n').trim(),
          });
        }
        currentContentLines = [];
      };

      const slugify = (text: string): string => {
        return text
          .toLowerCase()
          .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .substring(0, 60);
      };

      for (const line of lines) {
        const h1Match = line.match(/^#\s+(.+)$/);
        if (h1Match) {
          name = h1Match[1].trim();
          continue;
        }

        const h2Match = line.match(/^##\s+(.+)$/);
        if (h2Match) {
          flushUnit();
          const heading = h2Match[1].trim();

          // 格式 1：## unit-id: Unit Name
          const explicitMatch = heading.match(/^([^:]+)\s*:\s*(.+)$/);
          if (explicitMatch && explicitMatch[1].trim().length > 0) {
            currentUnit = {
              unitId: explicitMatch[1].trim(),
              name: explicitMatch[2].trim(),
              sortOrder: sortOrder++,
            };
          } else {
            // 格式 2/3：## Unit Name 或 ## 1.2 Unit Name
            const cleanedName = heading
              .replace(/^\d+(\.\d+)*\s+/, '')
              .trim();
            currentUnit = {
              unitId: slugify(cleanedName || heading),
              name: cleanedName || heading,
              sortOrder: sortOrder++,
            };
          }
          continue;
        }

        if (currentUnit) {
          currentContentLines.push(line);
        }
      }
      flushUnit();

      return {
        textbookId,
        name,
        units,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to load Markdown textbook ${textbookId}: ${message}`);
      return null;
    }
  }

  /**
   * 按教材和单元检索内容
   * @param textbookId 教材 ID
   * @param unitId 单元 ID
   * @param query 用户查询（MVP 阶段仅用于日志，不影响检索结果）
   * @returns 检索结果，包含单元内容和 found 标记
   */
  retrieve(textbookId: string, unitId: string, query?: string): RetrieveResult {
    const textbook = this.loadTextbook(textbookId);
    if (!textbook) {
      return { textbookId, unitId, unitName: '', content: '', found: false };
    }

    const unit = textbook.units.find((u) => u.unitId === unitId);
    if (!unit) {
      this.logger.warn(
        `Unit not found: textbookId=${textbookId}, unitId=${unitId}`,
      );
      return { textbookId, unitId, unitName: '', content: '', found: false };
    }

    if (query) {
      this.logger.debug(
        `RAG retrieve: textbookId=${textbookId}, unitId=${unitId}, query=${query}`,
      );
    }

    return {
      textbookId,
      unitId,
      unitName: unit.name,
      content: unit.content,
      found: true,
    };
  }

  /**
   * 估算文本 token 数（粗略：英文 1 token ≈ 4 字符，中文 1 token ≈ 1 字符）
   * MVP 阶段用于内容截断。
   */
  estimateTokens(text: string): number {
    if (!text) return 0;
    const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
    const nonChineseChars = text.length - chineseChars;
    return Math.ceil(chineseChars + nonChineseChars / 4);
  }

  /**
   * 按最大 token 数截断内容
   */
  truncateContent(content: string, maxTokens: number): string {
    if (this.estimateTokens(content) <= maxTokens) {
      return content;
    }
    // 简单按字符截断，保留完整句子
    let truncated = content;
    while (this.estimateTokens(truncated) > maxTokens && truncated.length > 0) {
      const lastSentenceEnd = Math.max(
        truncated.lastIndexOf('.'),
        truncated.lastIndexOf('。'),
        truncated.lastIndexOf('!'),
        truncated.lastIndexOf('?'),
      );
      if (lastSentenceEnd > 0) {
        truncated = truncated.slice(0, lastSentenceEnd + 1);
      } else {
        truncated = truncated.slice(0, Math.floor(truncated.length * 0.9));
      }
    }
    return truncated;
  }
}
