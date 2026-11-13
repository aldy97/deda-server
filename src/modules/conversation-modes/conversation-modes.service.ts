import { Injectable, OnModuleInit } from "@nestjs/common";
import { PrismaService } from "@/common/prisma/prisma.service";
import { ConversationModeCategoryDto } from "./dto/conversation-mode-category.dto";
import { ConversationModeDto } from "./dto/conversation-mode.dto";
import { ConversationModeTreeDto } from "./dto/conversation-mode-tree.dto";

/**
 * 默认对话模式分类
 */
const DEFAULT_CATEGORIES: Pick<
  ConversationModeCategoryDto,
  "key" | "name" | "description" | "sortOrder"
>[] = [
  {
    key: "free_chat",
    name: "自由对话模式",
    description: "围绕孩子兴趣自由交流",
    sortOrder: 0,
  },
  {
    key: "english_chat",
    name: "英语对话",
    description: "围绕孩子兴趣进行开放式英语对话",
    sortOrder: 1,
  },
];

/**
 * 默认对话子模式：仅自由对话保留子模式。
 */
const DEFAULT_MODES: (Pick<
  ConversationModeDto,
  "key" | "name" | "description" | "sortOrder"
> & { categoryKey: string })[] = [
  {
    categoryKey: "free_chat",
    key: "free_chat_casual",
    name: "自由闲聊",
    description: "围绕日常生活、兴趣爱好展开自由对话",
    sortOrder: 0,
  },
  {
    categoryKey: "free_chat",
    key: "free_chat_roleplay",
    name: "角色扮演",
    description: "孩子与 AI 扮演不同角色进行情景对话",
    sortOrder: 1,
  },
  {
    categoryKey: "free_chat",
    key: "free_chat_qa",
    name: "百科问答",
    description: "孩子提问，AI 用适合儿童的方式解答",
    sortOrder: 2,
  },
];

@Injectable()
export class ConversationModesService implements OnModuleInit {
  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    await this.seedDefaults();
  }

  /**
   * 获取所有启用的顶层分类
   */
  async findCategories(): Promise<ConversationModeCategoryDto[]> {
    const categories = await this.prisma.conversationModeCategory.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: "asc" },
    });
    return categories.map(this.mapCategory);
  }

  /**
   * 获取所有启用的子模式
   * @param categoryKey 可选：按顶层分类过滤
   */
  async findModes(categoryKey?: string): Promise<ConversationModeDto[]> {
    let categoryId: string | undefined;

    if (categoryKey) {
      const category = await this.prisma.conversationModeCategory.findUnique({
        where: { key: categoryKey },
        select: { id: true },
      });
      if (!category) {
        return [];
      }
      categoryId = category.id;
    }

    const modes = await this.prisma.conversationMode.findMany({
      where: { isActive: true, ...(categoryId ? { categoryId } : {}) },
      orderBy: { sortOrder: "asc" },
    });
    return modes.map(this.mapMode);
  }

  /**
   * 获取分类 + 子模式树形结构
   */
  async findTree(): Promise<ConversationModeTreeDto[]> {
    const [categories, modes] = await Promise.all([
      this.prisma.conversationModeCategory.findMany({
        where: { isActive: true },
        orderBy: { sortOrder: "asc" },
      }),
      this.prisma.conversationMode.findMany({
        where: { isActive: true },
        orderBy: { sortOrder: "asc" },
      }),
    ]);

    const modesByCategory = new Map<string, ConversationModeDto[]>();
    for (const mode of modes) {
      const list = modesByCategory.get(mode.categoryId) || [];
      list.push(this.mapMode(mode));
      modesByCategory.set(mode.categoryId, list);
    }

    return categories.map((category) => ({
      ...this.mapCategory(category),
      modes: modesByCategory.get(category.id) || [],
    }));
  }

  /**
   * 初始化默认分类和子模式（幂等）
   */
  async seedDefaults(): Promise<void> {
    // createMany + skipDuplicates 为单条 ON CONFLICT DO NOTHING，多实例并发启动时
    // 不会像逐行 upsert 那样在唯一键上竞争（P2002）
    await this.prisma.conversationModeCategory.createMany({
      data: DEFAULT_CATEGORIES,
      skipDuplicates: true,
    });

    const categories = await this.prisma.conversationModeCategory.findMany({
      where: { key: { in: DEFAULT_MODES.map((mode) => mode.categoryKey) } },
      select: { id: true, key: true },
    });
    const categoryIds = new Map(categories.map((c) => [c.key, c.id]));

    const modes = DEFAULT_MODES.flatMap((mode) => {
      const categoryId = categoryIds.get(mode.categoryKey);
      if (!categoryId) {
        return [];
      }
      const { categoryKey, ...modeData } = mode;
      return [{ ...modeData, categoryId }];
    });
    if (modes.length > 0) {
      await this.prisma.conversationMode.createMany({
        data: modes,
        skipDuplicates: true,
      });
    }
  }

  private mapCategory(category: any): ConversationModeCategoryDto {
    return {
      id: category.id,
      key: category.key,
      name: category.name,
      description: category.description,
      sortOrder: category.sortOrder,
      isActive: category.isActive,
    };
  }

  private mapMode(mode: any): ConversationModeDto {
    return {
      id: mode.id,
      categoryId: mode.categoryId,
      key: mode.key,
      name: mode.name,
      description: mode.description,
      sortOrder: mode.sortOrder,
      isActive: mode.isActive,
      configSchema: mode.configSchema as
        Record<string, unknown> | null | undefined,
      promptTemplate: mode.promptTemplate,
    };
  }
}
