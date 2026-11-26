import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { SuperAdminGuard } from "./guards/super-admin.guard";
import {
  CreateVoiceTimbreDto,
  UpdateVoiceTimbreDto,
} from "./dto/voice-timbre-admin.dto";
import { VoiceTimbreAdminService } from "./voice-timbre-admin.service";
import { normalizeCharacterKey } from "@/modules/baidu-agent/character-timbre.service";

/**
 * 角色音色映射的管理端接口（dashboard「语速与音色」）。
 *
 * 路径挂在 analytics/ 前缀下（dashboard 的 dev proxy 与生产 nginx 都只转发
 * /analytics）。写后 getvalue 下一轮生效，无需重启；prod 同样可写（运维配置）。
 */
@ApiTags("analytics-voice-timbres")
@ApiBearerAuth()
@UseGuards(SuperAdminGuard)
@Controller("analytics/voice-timbres")
export class VoiceTimbreAdminController {
  constructor(private readonly service: VoiceTimbreAdminService) {}

  @Get()
  @ApiOperation({ summary: "角色音色映射列表（含人设状态与在用设备数）" })
  list() {
    return this.service.list();
  }

  @Post()
  @ApiOperation({ summary: "新增角色音色映射；重复 key 返回 409" })
  create(@Body() dto: CreateVoiceTimbreDto) {
    return this.service.create(dto);
  }

  @Put(":characterKey")
  @ApiOperation({ summary: "更新角色音色；角色不存在返回 404" })
  update(
    @Param("characterKey") characterKey: string,
    @Body() dto: UpdateVoiceTimbreDto,
  ) {
    return this.service.update(
      normalizeCharacterKey(characterKey) ?? characterKey,
      dto,
    );
  }

  @Delete(":characterKey")
  @ApiOperation({
    summary: "删除角色音色；仍有设备在用且未带 force=true 时返回 409",
  })
  async remove(
    @Param("characterKey") characterKey: string,
    @Query("force") force?: string,
  ): Promise<void> {
    await this.service.remove(
      normalizeCharacterKey(characterKey) ?? characterKey,
      force === "true",
    );
  }
}
