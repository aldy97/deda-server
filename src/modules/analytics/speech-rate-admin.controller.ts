import { Body, Controller, Get, Patch, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { AnalyticsAuthGuard } from "./guards/analytics-auth.guard";
import { SpeechRateAdminService } from "./speech-rate-admin.service";
import { UpsertSpeechRateDto } from "./dto/speech-rate-admin.dto";

/**
 * 语速档位 → 倍数映射的管理端接口（dashboard）。
 *
 * 路径挂在 analytics/ 前缀下（dashboard 的 vite dev proxy 与生产 nginx 都只转发
 * /analytics）。写后 getvalue 每轮实时查库，无需重启。
 */
@ApiTags("analytics-speech-rate")
@ApiBearerAuth()
@UseGuards(AnalyticsAuthGuard)
@Controller("analytics/speech-rate")
export class SpeechRateAdminController {
  constructor(private readonly speechRate: SpeechRateAdminService) {}

  @Get()
  @ApiOperation({ summary: "语速档位 → spd 倍数映射（全量）" })
  list() {
    return this.speechRate.list();
  }

  @Patch()
  @ApiOperation({
    summary: "批量 upsert 语速档位映射，改后下一轮 getvalue 生效",
  })
  upsert(@Body() dto: UpsertSpeechRateDto) {
    return this.speechRate.upsert(dto.items);
  }
}
