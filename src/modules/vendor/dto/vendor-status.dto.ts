import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, IsNumber, IsBoolean, IsObject } from 'class-validator';

export class VendorStatusDto {
  @ApiProperty({ description: '设备唯一标识' })
  @IsString()
  @IsNotEmpty()
  deviceId: string;

  @ApiPropertyOptional({ description: '是否在线' })
  @IsOptional()
  @IsBoolean()
  online?: boolean;

  @ApiPropertyOptional({ description: '电量百分比 0-100' })
  @IsOptional()
  @IsNumber()
  batteryPercent?: number;

  @ApiPropertyOptional({ description: '是否充电中' })
  @IsOptional()
  @IsBoolean()
  charging?: boolean;

  @ApiPropertyOptional({ description: 'WiFi 信号强度 dBm 或百分比' })
  @IsOptional()
  @IsNumber()
  signalStrength?: number;

  @ApiPropertyOptional({ description: '当前连接 WiFi SSID' })
  @IsOptional()
  @IsString()
  wifiSsid?: string;

  @ApiPropertyOptional({ description: '当前生效对话模式' })
  @IsOptional()
  @IsString()
  currentMode?: string;

  @ApiPropertyOptional({ description: '扩展状态字段' })
  @IsOptional()
  @IsObject()
  extra?: Record<string, any>;
}
