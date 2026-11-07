import {
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Query,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { IsIn, IsOptional, Matches } from "class-validator";
import { AnalyticsDateRangeQueryDto } from "./dto/analytics-query.dto";
import { AnalyticsAuthGuard } from "./guards/analytics-auth.guard";
import { ContentService } from "./content.service";
import { QualityService } from "./quality.service";

class QualityConversationQueryDto extends AnalyticsDateRangeQueryDto {
  @IsOptional()
  @IsIn(["day", "week", "month"])
  granularity?: "day" | "week" | "month";
}

class AdventureQueryDto {
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: "日期格式必须为 YYYY-MM-DD" })
  startDate?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: "日期格式必须为 YYYY-MM-DD" })
  endDate?: string;
}

@ApiTags("analytics-content")
@ApiBearerAuth()
@UseGuards(AnalyticsAuthGuard)
@Controller("analytics/content")
export class ContentController {
  constructor(private readonly contentService: ContentService) {}

  @Get("adventure")
  @ApiOperation({ summary: "冒险故事完集率与集排行" })
  getAdventure(@Query() query: AdventureQueryDto) {
    return this.contentService.getAdventure(query);
  }

  @Get("learning")
  @ApiOperation({ summary: "学习内容（新词/开口/习惯计划）" })
  getLearning(@Query() query: AnalyticsDateRangeQueryDto) {
    return this.contentService.getLearning(query);
  }

  @Get("parent-report")
  @ApiOperation({ summary: "家长报告生成成功率与有用率" })
  getParentReport(@Query() query: AnalyticsDateRangeQueryDto) {
    return this.contentService.getParentReport(query);
  }
}

@ApiTags("analytics-quality")
@ApiBearerAuth()
@UseGuards(AnalyticsAuthGuard)
@Controller("analytics/quality")
export class QualityController {
  constructor(private readonly qualityService: QualityService) {}

  @Get("conversation")
  @ApiOperation({ summary: "对话失败率与安全拦截率趋势" })
  getConversation(@Query() query: QualityConversationQueryDto) {
    return this.qualityService.getConversationQuality(query);
  }

  @Get("llm-usage")
  @ApiOperation({
    summary: "LLM 用量与成本（一期未落库，恒 501；二期上线）",
  })
  getLlmUsage() {
    throw new HttpException(
      "llm_usage_logs 未落库，该接口二期上线",
      HttpStatus.NOT_IMPLEMENTED,
    );
  }
}
