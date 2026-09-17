import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, IsObject, IsNumber } from 'class-validator';

export class VendorConversationDto {
  @ApiProperty({ description: '设备唯一标识' })
  @IsString()
  @IsNotEmpty()
  deviceId: string;

  @ApiProperty({ description: '用户输入文字' })
  @IsString()
  @IsNotEmpty()
  userText: string;

  @ApiProperty({ description: 'AI 回复文字' })
  @IsString()
  @IsNotEmpty()
  aiText: string;

  @ApiPropertyOptional({ description: '对话开始时间戳' })
  @IsOptional()
  @IsNumber()
  startedAt?: number;

  @ApiPropertyOptional({ description: '对话结束时间戳' })
  @IsOptional()
  @IsNumber()
  endedAt?: number;

  @ApiPropertyOptional({ description: '扩展字段：命中单元、难度等' })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;
}
