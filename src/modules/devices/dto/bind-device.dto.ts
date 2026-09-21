import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional } from 'class-validator';

export class BindDeviceDto {
  @ApiPropertyOptional({ description: '设备唯一标识（deviceId 和 deviceCode 至少传一个）' })
  @IsOptional()
  @IsString()
  deviceId?: string;

  @ApiPropertyOptional({ description: '设备编码/序列号（deviceId 和 deviceCode 至少传一个）' })
  @IsOptional()
  @IsString()
  deviceCode?: string;

  @ApiPropertyOptional({ description: '孩子档案 ID' })
  @IsOptional()
  @IsString()
  childProfileId?: string;
}
