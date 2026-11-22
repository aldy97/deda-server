import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  ArrayMaxSize,
  IsArray,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from "class-validator";
import {
  TTS_SPD_MAX,
  TTS_SPD_MIN,
} from "@/modules/baidu-agent/baidu-agent.types";

const MAC_PATTERN = /^([0-9A-Fa-f]{2}[:-]?){5}[0-9A-Fa-f]{2}$/;

export class UpdateVoiceSpeedDto {
  @ApiProperty({
    description: "非哄睡语速倍数，合法范围 [0.5, 2.0]（设备端协议 v1.4 §4.2）",
    minimum: TTS_SPD_MIN,
    maximum: TTS_SPD_MAX,
    example: 0.7,
  })
  @IsNumber()
  @Min(TTS_SPD_MIN, { message: "取值范围 0.5–2.0" })
  @Max(TTS_SPD_MAX, { message: "取值范围 0.5–2.0" })
  normalSpd!: number;

  @ApiProperty({
    description: "哄睡语速倍数，合法范围 [0.5, 2.0]（设备端协议 v1.4 §4.2）",
    minimum: TTS_SPD_MIN,
    maximum: TTS_SPD_MAX,
    example: 0.5,
  })
  @IsNumber()
  @Min(TTS_SPD_MIN, { message: "取值范围 0.5–2.0" })
  @Max(TTS_SPD_MAX, { message: "取值范围 0.5–2.0" })
  sleepSpd!: number;
}

export class ApplyVoiceSpeedDto {
  @ApiPropertyOptional({
    description:
      "只对这些设备执行立即下发（MAC，允许冒号/连字符）。不传则对所有有活跃实例的设备下发。",
    type: [String],
    maxItems: 50,
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @Matches(MAC_PATTERN, { each: true, message: "mac 格式非法" })
  macs?: string[];
}
