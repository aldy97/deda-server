import { Controller, Get, Query } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiQuery } from "@nestjs/swagger";
import { ConversationModesService } from "./conversation-modes.service";
import { ConversationModeCategoryDto } from "./dto/conversation-mode-category.dto";
import { ConversationModeDto } from "./dto/conversation-mode.dto";
import { ConversationModeTreeDto } from "./dto/conversation-mode-tree.dto";

@ApiTags("对话模式")
@Controller("conversation-modes")
export class ConversationModesController {
  constructor(
    private readonly conversationModesService: ConversationModesService,
  ) {}

  @Get("categories")
  @ApiOperation({ summary: "获取对话模式顶层分类" })
  async findCategories(): Promise<ConversationModeCategoryDto[]> {
    return this.conversationModesService.findCategories();
  }

  @Get()
  @ApiOperation({ summary: "获取对话子模式列表" })
  @ApiQuery({
    name: "categoryKey",
    required: false,
    description: "按顶层分类过滤",
  })
  async findModes(
    @Query("categoryKey") categoryKey?: string,
  ): Promise<ConversationModeDto[]> {
    return this.conversationModesService.findModes(categoryKey);
  }

  @Get("tree")
  @ApiOperation({ summary: "获取分类 + 子模式树形结构" })
  async findTree(): Promise<ConversationModeTreeDto[]> {
    return this.conversationModesService.findTree();
  }
}
