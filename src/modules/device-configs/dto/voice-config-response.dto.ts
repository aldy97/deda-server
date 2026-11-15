import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import type { VoiceCatalogEntry } from "@/modules/baidu-agent/baidu-agent.types";

/**
 * 目录条目精简版——只暴露 App 需要的三个字段。
 * 不暴露 status（非 TRAINED 的已由 catalog 过滤）和 auditionAudioUrl（试听 URL 只有 1 小时有效期，属未解决问题 Q8）。
 */
class VoiceCatalogItemDto {
  @ApiProperty({ description: "音色 ID（百度 timbreId）" })
  timbreId: string;

  @ApiProperty({ description: "音色名称" })
  name: string;

  @ApiProperty({ description: "支持语种" })
  language: string;
}

export class VoiceConfigResponseDto {
  @ApiProperty({ description: "设备业务 ID" })
  deviceId: string;

  @ApiPropertyOptional({
    description: "当前期望音色 ID，未设置则为 null",
    nullable: true,
  })
  vcn: string | null;

  @ApiPropertyOptional({
    description: "当前期望语速档位，未设置则为 null",
    nullable: true,
  })
  speechRate: string | null;

  @ApiPropertyOptional({
    description:
      "语速档位对应的 spd 倍速值，resolvedSpd 的结果；未配置映射或档位缺失则为 null",
    nullable: true,
  })
  spd: number | null;

  @ApiProperty({
    description: "可用音色目录",
    type: [VoiceCatalogItemDto],
  })
  catalog: Array<Pick<VoiceCatalogEntry, "timbreId" | "name" | "language">>;

  @ApiProperty({ description: "音色目录是否可用（catalog.available）" })
  available: boolean;

  @ApiProperty({
    description:
      "是否具备实时下发条件。只表示配置齐备（vcn + speechRate + spd 三者都有值），" +
      "实际是否 live 生效取决于 POST 时设备是否有活跃实例",
  })
  canApplyLive: boolean;

  @ApiPropertyOptional({
    description:
      "canApplyLive=false 时的归因，如 empty_catalog / incomplete_tts_target；" +
      "null 表示没有期望值或条件满足",
    nullable: true,
  })
  reason: string | null;
}
