import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional } from 'class-validator';

export class SwitchModeDto {
  @ApiProperty({ description: '对话模式：free_chat/textbook/free_study', enum: ['free_chat', 'textbook', 'free_study'] })
  @IsString()
  @IsNotEmpty()
  mode: string;

  @ApiPropertyOptional({ description: '教材 ID' })
  @IsOptional()
  @IsString()
  textbookId?: string;

  @ApiPropertyOptional({ description: '单元 ID' })
  @IsOptional()
  @IsString()
  unitId?: string;

  @ApiPropertyOptional({ description: '语言：zh/en/bilingual' })
  @IsOptional()
  @IsString()
  language?: string;

  @ApiPropertyOptional({ description: '语速：slow/normal/fast' })
  @IsOptional()
  @IsString()
  speechRate?: string;
}
