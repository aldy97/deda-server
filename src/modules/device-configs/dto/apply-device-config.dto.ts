import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional } from 'class-validator';

export class ApplyDeviceConfigDto {
  @ApiProperty({
    description: '学习模式',
    enum: ['free_chat', 'textbook_learning', 'locked_unit', 'free_textbook'],
  })
  @IsString()
  @IsNotEmpty()
  mode: string;

  @ApiPropertyOptional({ description: '教材业务 ID' })
  @IsOptional()
  @IsString()
  textbookId?: string;

  @ApiPropertyOptional({ description: '单元业务 ID' })
  @IsOptional()
  @IsString()
  unitId?: string;

  @ApiPropertyOptional({ description: '自由对话子模式 key' })
  @IsOptional()
  @IsString()
  conversationModeKey?: string;

  @ApiPropertyOptional({ description: 'CEFR 等级' })
  @IsOptional()
  @IsString()
  cefrLevel?: string;

  @ApiPropertyOptional({ description: '语言：zh/en/bilingual' })
  @IsOptional()
  @IsString()
  language?: string;

  @ApiPropertyOptional({ description: '语速：slow/normal/fast' })
  @IsOptional()
  @IsString()
  speechRate?: string;
}
