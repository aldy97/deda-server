import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@/common/prisma/prisma.service';
import * as fs from 'fs';
import * as path from 'path';

export interface ParsedUnit {
  unitId: string;
  name: string;
  description: string;
  cefrLevel: string;
  difficulty: number | null;
  sortOrder: number;
  content: string;
}

export interface ParsedTextbook {
  textbookId: string;
  name: string;
  description: string;
  cefrLevel: string;
  promptTemplate?: string;
  units: ParsedUnit[];
}

/**
 * 教材导入服务
 * 解析 Markdown 文件并写入 DB。
 * Phase 1 用于从本地文件快速初始化教材数据。
 */
@Injectable()
export class TextbookImportService {
  private readonly logger = new Logger(TextbookImportService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * 从服务器本地 Markdown 文件导入一本教材
   */
  async importFromFile(
    filePath: string,
    overrides: {
      textbookId: string;
      name?: string;
      description?: string;
      cefrLevel?: string;
      promptTemplate?: string;
      singleUnit?: boolean;
      unitMarkers?: boolean;
      singleUnitName?: string;
      singleUnitId?: string;
    },
  ): Promise<ParsedTextbook> {
    const resolvedPath = path.isAbsolute(filePath)
      ? filePath
      : path.join(process.cwd(), filePath);

    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Textbook file not found: ${resolvedPath}`);
    }

    const raw = fs.readFileSync(resolvedPath, 'utf-8');
    let parsed: ParsedTextbook;
    if (overrides.singleUnit) {
      parsed = this.parseMarkdownAsSingleUnit(raw, overrides);
    } else if (overrides.unitMarkers) {
      parsed = this.parseMarkdownByUnits(raw, overrides);
    } else {
      parsed = this.parseMarkdown(raw, overrides);
    }

    await this.saveToDb(parsed);

    this.logger.log(
      `Imported textbook ${parsed.textbookId} with ${parsed.units.length} units`,
    );
    return parsed;
  }

  /**
   * 把整个 Markdown 文件解析为单一教材 + 单一单元
   * 用于导入尚未按单元拆分的教材文件。
   */
  parseMarkdownAsSingleUnit(
    raw: string,
    overrides: {
      textbookId: string;
      name?: string;
      description?: string;
      cefrLevel?: string;
      promptTemplate?: string;
      singleUnitName?: string;
      singleUnitId?: string;
    },
  ): ParsedTextbook {
    const lines = raw.split(/\r?\n/);

    let name = overrides.name || overrides.textbookId;
    let description = overrides.description || '';
    let textbookCefrLevel = overrides.cefrLevel || '';

    const contentLines: string[] = [];

    for (const line of lines) {
      const h1Match = line.match(/^#\s+(.+)$/);
      if (h1Match) {
        name = overrides.name || h1Match[1].trim();
        continue;
      }

      const descMatch = line.match(/^<!--\s*desc:\s*(.+)\s*-->$/);
      if (descMatch) {
        description = descMatch[1].trim();
        continue;
      }

      contentLines.push(line);
    }

    const content = contentLines.join('\n').trim();

    if (!description) {
      description = this.generateDescription(content, name);
    }

    const unitName = overrides.singleUnitName || name;
    const unitId =
      overrides.singleUnitId || this.slugify(unitName) || 'unit-1';

    return {
      textbookId: overrides.textbookId,
      name,
      description,
      cefrLevel: textbookCefrLevel,
      promptTemplate: overrides.promptTemplate,
      units: [
        {
          unitId,
          name: unitName,
          description,
          cefrLevel:
            textbookCefrLevel || this.inferCefrLevelFromContent(content),
          difficulty: null,
          sortOrder: 1,
          content,
        },
      ],
    };
  }

  /**
   * 解析 Markdown 教材文件
   * 支持 H2 标题格式：
   *   ## unit-id: Unit Name
   *   ## Unit Name
   *   ## 1.2 Unit Name
   */
  parseMarkdown(
    raw: string,
    overrides: {
      textbookId: string;
      name?: string;
      description?: string;
      cefrLevel?: string;
      promptTemplate?: string;
    },
  ): ParsedTextbook {
    const lines = raw.split(/\r?\n/);

    let name = overrides.name || overrides.textbookId;
    let description = overrides.description || '';
    let textbookCefrLevel = overrides.cefrLevel || '';

    const units: ParsedUnit[] = [];
    let currentUnit: Partial<ParsedUnit> | null = null;
    let currentContentLines: string[] = [];
    let sortOrder = 1;

    const flushUnit = () => {
      if (currentUnit && currentUnit.unitId) {
        const content = currentContentLines.join('\n').trim();
        units.push({
          unitId: currentUnit.unitId,
          name: currentUnit.name || currentUnit.unitId,
          description: this.generateDescription(content, currentUnit.name || ''),
          cefrLevel:
            currentUnit.cefrLevel ||
            this.inferCefrLevelFromContent(content, textbookCefrLevel),
          difficulty: null,
          sortOrder: currentUnit.sortOrder || sortOrder++,
          content,
        });
      }
      currentContentLines = [];
    };

    for (const line of lines) {
      const h1Match = line.match(/^#\s+(.+)$/);
      if (h1Match) {
        name = overrides.name || h1Match[1].trim();
        continue;
      }

      const descMatch = line.match(/^<!--\s*desc:\s*(.+)\s*-->$/);
      if (descMatch) {
        description = descMatch[1].trim();
        continue;
      }

      const h2Match = line.match(/^##\s+(.+)$/);
      if (h2Match) {
        flushUnit();
        const heading = h2Match[1].trim();

        const explicitMatch = heading.match(/^([^:]+)\s*:\s*(.+)$/);
        if (explicitMatch && explicitMatch[1].trim().length > 0) {
          currentUnit = {
            unitId: explicitMatch[1].trim(),
            name: explicitMatch[2].trim(),
            sortOrder: sortOrder++,
          };
        } else {
          const cleanedName = heading.replace(/^\d+(\.\d+)*\s+/, '').trim();
          currentUnit = {
            unitId: this.slugify(cleanedName || heading),
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

    if (!description) {
      description = `共 ${units.length} 个单元，适合 ${textbookCefrLevel || '初学者'} 水平。`;
    }

    return {
      textbookId: overrides.textbookId,
      name,
      description,
      cefrLevel: textbookCefrLevel,
      promptTemplate: overrides.promptTemplate,
      units,
    };
  }

  /**
   * 按教材单元拆分 Markdown。
   * 识别两种单元起点：
   *   1. 显式 `## UNIT X` 标题
   *   2. `## UNLOCK YOUR KNOWLEDGE`（Unlock 教材每个单元的第一个活动）
   * 文件开头到第一个起点之间的内容作为 Unit 1。
   * 单元名称优先取 UNLOCK YOUR KNOWLEDGE 前一个 H2 主题标题。
   */
  parseMarkdownByUnits(
    raw: string,
    overrides: {
      textbookId: string;
      name?: string;
      description?: string;
      cefrLevel?: string;
      promptTemplate?: string;
    },
  ): ParsedTextbook {
    const lines = raw.split(/\r?\n/);

    let name = overrides.name || overrides.textbookId;
    let description = overrides.description || '';
    const textbookCefrLevel = overrides.cefrLevel || '';

    // 1. 提取教材级 H1 标题与描述注释，并在附录/脚本区前截断
    const bodyLines: string[] = [];
    const appendixMarkers = [
      /VIDEO\s+AND\s+AUDIO\s+SCRIPTS/i,
      /AUDIO\s+SCRIPTS/i,
      /ANSWER\s+KEY/i,
      /ACKNOWLEDGEMENTS/i,
      /ADVISORY\s+PANEL/i,
      /CONTENTS/i,
    ];
    for (const line of lines) {
      const h1Match = line.match(/^#\s+(.+)$/);
      if (h1Match) {
        if (bodyLines.length === 0) {
          name = overrides.name || h1Match[1].trim();
          continue;
        }
        const heading = h1Match[1].trim();
        if (appendixMarkers.some((re) => re.test(heading))) {
          break;
        }
      }
      const descMatch = line.match(/^<!--\s*desc:\s*(.+)\s*-->$/);
      if (descMatch) {
        description = descMatch[1].trim();
        continue;
      }
      bodyLines.push(line);
    }

    // 2. 逐行扫描，按单元起点拆分
    const units: ParsedUnit[] = [];
    let currentUnitNumber = 1;
    let currentContentLines: string[] = [];
    let currentStartedByUnitMarker = false;
    let currentStartedByTheme = false;
    let nextSequentialNumber = 1;

    const flushUnit = () => {
      const content = currentContentLines.join('\n').trim();
      if (!content) {
        currentContentLines = [];
        currentStartedByUnitMarker = false;
        return;
      }

      const unitId = `unit-${currentUnitNumber}`;
      const extractedName = this.extractUnitName(content);
      const unitName =
        extractedName ||
        (currentStartedByUnitMarker ? `Unit ${currentUnitNumber}` : null) ||
        `Unit ${currentUnitNumber}`;

      units.push({
        unitId,
        name: unitName,
        description: this.generateDescription(content, unitName),
        cefrLevel: this.inferCefrLevelFromContent(content, textbookCefrLevel),
        difficulty: null,
        sortOrder: currentUnitNumber,
        content,
      });

      currentContentLines = [];
      currentStartedByUnitMarker = false;
      currentStartedByTheme = false;
      nextSequentialNumber = currentUnitNumber + 1;
    };

    for (let i = 0; i < bodyLines.length; i++) {
      const line = bodyLines[i];
      // 找到下一个非空行（用于判断主题 H2 后是否紧跟 UNLOCK YOUR KNOWLEDGE）
      let nextNonEmptyLine = '';
      for (let j = i + 1; j < bodyLines.length; j++) {
        if (bodyLines[j].trim()) {
          nextNonEmptyLine = bodyLines[j];
          break;
        }
      }

      const unitHeadingMatch = line.match(/^##\s+UNIT\s+(\d+)\s*$/i);
      if (unitHeadingMatch) {
        const unitNumber = parseInt(unitHeadingMatch[1], 10);
        // 如果当前单元已经由主题 H2 启动且单元号一致，则把 UNIT X 当作内容，不新建单元
        if (
          currentStartedByTheme &&
          unitNumber === currentUnitNumber &&
          currentContentLines.length > 0
        ) {
          currentContentLines.push(line);
          continue;
        }
        flushUnit();
        currentUnitNumber = unitNumber;
        currentStartedByUnitMarker = true;
        currentContentLines.push(line);
        continue;
      }

      // 如果当前行是主题 H2 且下一非空行是 UNLOCK YOUR KNOWLEDGE 或 UNIT X，
      // 则当前行标志新单元开始
      const h2Match = line.match(/^##\s+(.+)$/);
      const nextIsUnlock = /^##\s+UNLOCK\s+YOUR\s+KNOWLEDGE\s*$/i.test(
        nextNonEmptyLine.trim(),
      );
      const nextIsUnit = /^##\s+UNIT\s+\d+\s*$/i.test(nextNonEmptyLine.trim());
      if (
        h2Match &&
        (nextIsUnlock || nextIsUnit) &&
        !currentStartedByUnitMarker &&
        currentContentLines.length > 0
      ) {
        flushUnit();
        currentUnitNumber = nextSequentialNumber;
        currentStartedByTheme = true;
        currentContentLines.push(line);
        continue;
      }

      const unlockMatch = line.match(/^##\s+UNLOCK\s+YOUR\s+KNOWLEDGE\s*$/i);
      if (unlockMatch && !currentStartedByUnitMarker && !currentStartedByTheme) {
        // 只有当前单元不是由主题 H2 或显式 UNIT X 开始时，UNLOCK YOUR KNOWLEDGE 才标志新单元
        flushUnit();
        currentUnitNumber = nextSequentialNumber;
        currentContentLines.push(line);
        continue;
      }

      if (line.trim()) {
        currentStartedByTheme = false;
      }
      currentContentLines.push(line);
    }

    // 文件末尾剩余内容
    if (currentContentLines.join('\n').trim().length > 0) {
      flushUnit();
    }

    if (!description) {
      description = `共 ${units.length} 个单元，适合 ${textbookCefrLevel || '初学者'} 水平。`;
    }

    return {
      textbookId: overrides.textbookId,
      name,
      description,
      cefrLevel: textbookCefrLevel,
      promptTemplate: overrides.promptTemplate,
      units,
    };
  }

  /**
   * 将解析结果写入数据库
   */
  private async saveToDb(parsed: ParsedTextbook): Promise<void> {
    const textbook = await this.prisma.textbook.upsert({
      where: { textbookId: parsed.textbookId },
      update: {
        name: parsed.name,
        description: parsed.description,
        cefrLevel: parsed.cefrLevel,
        promptTemplate: parsed.promptTemplate,
      },
      create: {
        textbookId: parsed.textbookId,
        name: parsed.name,
        description: parsed.description,
        cefrLevel: parsed.cefrLevel,
        promptTemplate: parsed.promptTemplate,
      },
    });

    for (const unit of parsed.units) {
      await this.prisma.unit.upsert({
        where: {
          textbookId_unitId: {
            textbookId: textbook.id,
            unitId: unit.unitId,
          },
        },
        update: {
          name: unit.name,
          description: unit.description,
          cefrLevel: unit.cefrLevel,
          difficulty: unit.difficulty,
          sortOrder: unit.sortOrder,
          content: unit.content,
        },
        create: {
          textbookId: textbook.id,
          unitId: unit.unitId,
          name: unit.name,
          description: unit.description,
          cefrLevel: unit.cefrLevel,
          difficulty: unit.difficulty,
          sortOrder: unit.sortOrder,
          content: unit.content,
        },
      });
    }
  }

  /**
   * 从没有显式 UNIT 标题的单元块中提取单元名称。
   * 优先取 UNLOCK YOUR KNOWLEDGE 前一个 H2 标题（通常是单元主题）；
   * 否则取第一个非练习指令的 H2 标题。
   */
  private extractUnitName(block: string): string | null {
    const lines = block.split(/\r?\n/);

    // 优先：UNLOCK YOUR KNOWLEDGE 前面的 H2 就是单元主题
    for (let i = 0; i < lines.length; i++) {
      if (/^##\s+UNLOCK\s+YOUR\s+KNOWLEDGE\s*$/i.test(lines[i].trim())) {
        for (let j = i - 1; j >= 0; j--) {
          const h2Match = lines[j].match(/^##\s+(.+)$/);
          if (h2Match) {
            const heading = h2Match[1].trim();
            if (
              !/OBJECTIVES\s+REVIEW/i.test(heading) &&
              !/^UNIT\s+\d+$/i.test(heading) &&
              !/^UNLOCK\s+YOUR\s+KNOWLEDGE/i.test(heading)
            ) {
              return heading;
            }
          }
        }
      }
    }

    // 兜底：第一个非练习指令的 H2
    for (const line of lines) {
      const h2Match = line.match(/^##\s+(.+)$/);
      if (!h2Match) continue;
      const heading = h2Match[1].trim();
      if (/^\d+\s+\d+\.\d+\s/.test(heading)) continue;
      if (/^\d+\s+\w/.test(heading)) continue;
      if (/OBJECTIVES\s+REVIEW/i.test(heading)) continue;
      if (/^UNIT\s+\d+$/i.test(heading)) continue;
      if (/^UNLOCK\s+YOUR\s+KNOWLEDGE/i.test(heading)) continue;
      // 跳过常见子章节标题，避免把练习小节当作单元主题
      if (
        /\b(PREPARING TO|LISTENING FOR|WHILE LISTENING|WATCH AND LISTEN|CRITICAL THINKING|DISCUSSION|PRONUNCIATION|LANGUAGE DEVELOPMENT|SPEAKING TASK|PREPARATION FOR|UNDERSTAND|GLOSSARY|VOCABULARY)\b/i.test(
          heading,
        )
      ) {
        continue;
      }
      return heading;
    }
    return null;
  }

  /**
   * 根据单元内容生成描述
   * 优先取正文第一句；若为空则使用单元名。
   */
  private generateDescription(content: string, unitName: string): string {
    const firstSentence = content
      .split(/[.!?。！？]\s*/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)[0];

    if (firstSentence && firstSentence.length > 10) {
      const sentence = firstSentence.replace(/\s+/g, ' ').trim();
      return sentence.length > 120 ? sentence.slice(0, 120) + '...' : sentence;
    }

    return `学习单元：${unitName}`;
  }

  /**
   * 根据单元内容推断 CEFR 等级
   * 基于平均句长和总词数做简单启发式判断。
   */
  private inferCefrLevelFromContent(
    content: string,
    textbookCefrLevel?: string,
  ): string {
    if (textbookCefrLevel) return textbookCefrLevel;

    const trimmed = content.trim();
    if (!trimmed) return 'A1';

    const sentences = trimmed
      .split(/[.!?。！？]\s*/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    if (sentences.length === 0) return 'A1';

    const totalWords = trimmed.split(/\s+/).length;
    const avgWordsPerSentence = totalWords / sentences.length;

    if (avgWordsPerSentence < 6) return 'A1';
    if (avgWordsPerSentence < 10) return 'A2';
    if (avgWordsPerSentence < 15) return 'B1';
    if (avgWordsPerSentence < 20) return 'B2';
    return 'C1';
  }

  /**
   * 根据单元顺序推断数值化难度
   */
  private inferDifficulty(sortOrder: number): number {
    if (sortOrder <= 5) return 1;
    if (sortOrder <= 10) return 2;
    if (sortOrder <= 15) return 3;
    if (sortOrder <= 20) return 4;
    return 5;
  }

  /**
   * 将文本转换为 URL/ID 友好的 slug
   */
  private slugify(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .substring(0, 60);
  }
}
