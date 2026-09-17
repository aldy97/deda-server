import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, IsObject } from 'class-validator';

export class VendorTextOutDto {
  @ApiProperty({ description: '设备唯一标识' })
  @IsString()
  @IsNotEmpty()
  deviceId: string;

  @ApiProperty({ description: '需要 TTS 播放的回复文字' })
  @IsString()
  @IsNotEmpty()
  responseText: string;

  @ApiPropertyOptional({ description: '本次回复关联的教材/单元信息' })
  @IsOptional()
  @IsObject()
  context?: Record<string, any>;

  @ApiPropertyOptional({ description: 'TTS 语速、音色等参数' })
  @IsOptional()
  @IsObject()
  ttsOptions?: Record<string, any>;
}
