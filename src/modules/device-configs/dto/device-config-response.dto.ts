import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class DeviceConfigResponseDto {
  @ApiProperty({ description: "设备业务 ID" })
  deviceId: string;

  @ApiProperty({
    description: "对话模式",
    enum: ["free_chat", "english_chat"],
  })
  mode: string;

  @ApiPropertyOptional({ description: "自由对话子模式 key" })
  conversationModeKey?: string | null;

  @ApiPropertyOptional({ description: "CEFR 等级" })
  cefrLevel?: string | null;

  @ApiPropertyOptional({ description: "语言" })
  language?: string | null;

  @ApiPropertyOptional({ description: "语速" })
  speechRate?: string | null;
}
