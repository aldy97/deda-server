import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class DeviceConfigResponseDto {
  @ApiProperty({ description: '设备业务 ID' })
  deviceId: string;

  @ApiProperty({
    description: '学习模式',
    enum: ['free_chat', 'textbook_learning', 'locked_unit', 'free_textbook'],
  })
  mode: string;

  @ApiPropertyOptional({ description: '自由对话子模式 key' })
  conversationModeKey?: string | null;

  @ApiPropertyOptional({ description: '教材业务 ID' })
  textbookId?: string | null;

  @ApiPropertyOptional({ description: '教材名称' })
  textbookName?: string | null;

  @ApiPropertyOptional({ description: '单元业务 ID' })
  unitId?: string | null;

  @ApiPropertyOptional({ description: '单元名称' })
  unitName?: string | null;

  @ApiPropertyOptional({ description: 'CEFR 等级' })
  cefrLevel?: string | null;

  @ApiPropertyOptional({ description: '语言' })
  language?: string | null;

  @ApiPropertyOptional({ description: '语速' })
  speechRate?: string | null;
}
