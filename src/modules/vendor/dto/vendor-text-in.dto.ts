import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, IsNumber, IsObject } from 'class-validator';

export class VendorTextInDto {
  @ApiProperty({ description: '设备唯一标识' })
  @IsString()
  @IsNotEmpty()
  deviceId: string;

  @ApiProperty({ description: 'ASR 识别后的用户输入文字' })
  @IsString()
  @IsNotEmpty()
  asrText: string;

  @ApiPropertyOptional({ description: 'ASR 识别置信度 0-1' })
  @IsOptional()
  @IsNumber()
  confidence?: number;

  @ApiPropertyOptional({ description: '当前设备固件版本' })
  @IsOptional()
  @IsString()
  firmwareVersion?: string;

  @ApiPropertyOptional({ description: '当前教材 ID（可选，未传则使用设备配置或默认值）' })
  @IsOptional()
  @IsString()
  textbookId?: string;

  @ApiPropertyOptional({ description: '当前单元 ID（可选，未传则使用设备配置或默认值）' })
  @IsOptional()
  @IsString()
  unitId?: string;

  @ApiPropertyOptional({ description: '扩展字段：语言、模式等' })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;
}
