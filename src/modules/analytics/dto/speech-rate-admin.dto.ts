import { ApiProperty } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  ArrayNotEmpty,
  IsArray,
  IsNotEmpty,
  IsNumber,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";
import {
  TTS_SPD_MAX,
  TTS_SPD_MIN,
} from "@/modules/baidu-agent/baidu-agent.types";

/** 档位键最大长度：足够容纳 slow/normal/fast 与未来新增档位，防误填整段正文 */
const TIER_MAX_CHARS = 32;

export class SpeechRateItemDto {
  @ApiProperty({
    description: "档位键，如 slow / normal / fast",
    example: "slow",
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(TIER_MAX_CHARS)
  tier!: string;

  @ApiProperty({
    description: "语速倍数，合法范围 [0.5, 2.0]（设备端协议 v1.4 §4.2）",
    minimum: TTS_SPD_MIN,
    maximum: TTS_SPD_MAX,
    example: 0.7,
  })
  @IsNumber()
  @Min(TTS_SPD_MIN)
  @Max(TTS_SPD_MAX)
  spd!: number;
}

export class UpsertSpeechRateDto {
  @ApiProperty({ type: [SpeechRateItemDto] })
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => SpeechRateItemDto)
  items!: SpeechRateItemDto[];
}
