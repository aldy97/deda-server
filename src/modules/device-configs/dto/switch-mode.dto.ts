import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsString, IsOptional, IsIn } from "class-validator";
import { DEVICE_MODES } from "../device-config.constants";

export class SwitchModeDto {
  @ApiProperty({
    description: "对话模式",
    enum: ["free_chat", "english_chat"],
  })
  @IsIn(DEVICE_MODES)
  mode: string;

  @ApiPropertyOptional({ description: "语言：zh/en/bilingual" })
  @IsOptional()
  @IsString()
  language?: string;

  @ApiPropertyOptional({ description: "语速：slow/normal/fast" })
  @IsOptional()
  @IsString()
  speechRate?: string;
}
