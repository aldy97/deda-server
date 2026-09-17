import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional } from 'class-validator';

export class BindDeviceDto {
  @ApiProperty({ description: '设备唯一标识（扫码或输入码获得）' })
  @IsString()
  @IsNotEmpty()
  deviceId: string;

  @ApiPropertyOptional({ description: '设备序列号' })
  @IsOptional()
  @IsString()
  serialNumber?: string;

  @ApiPropertyOptional({ description: '孩子档案 ID' })
  @IsOptional()
  @IsString()
  childProfileId?: string;
}
