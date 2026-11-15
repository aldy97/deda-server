import { ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsString,
  IsOptional,
  IsNotEmpty,
  MaxLength,
  IsIn,
} from "class-validator";
import { SPEECH_RATES } from "@/modules/baidu-agent/baidu-agent.types";

export class UpdateVoiceConfigDto {
  @ApiPropertyOptional({
    description:
      "音色 ID（百度 timbreId 字符串），如 1000063。不传则保持当前音色不变",
    example: "1000063",
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  vcn?: string;

  @ApiPropertyOptional({
    description: "语速档位（slow/normal/fast），不传则保持当前语速不变",
    enum: SPEECH_RATES,
  })
  @IsOptional()
  @IsIn(SPEECH_RATES)
  speechRate?: string;
}
