import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, IsObject, IsBoolean } from 'class-validator';

export class VendorDebugLogDto {
  @ApiProperty({ description: '设备唯一标识' })
  @IsString()
  @IsNotEmpty()
  deviceId: string;

  @ApiProperty({ description: '日志级别：info/warn/error/debug' })
  @IsString()
  @IsNotEmpty()
  level: string;

  @ApiProperty({ description: '日志内容' })
  @IsString()
  @IsNotEmpty()
  message: string;

  @ApiPropertyOptional({ description: '扩展字段' })
  @IsOptional()
  @IsObject()
  payload?: Record<string, any>;
}

export class VendorDebugRebootDto {
  @ApiProperty({ description: '设备唯一标识' })
  @IsString()
  @IsNotEmpty()
  deviceId: string;

  @ApiPropertyOptional({ description: '是否恢复出厂设置' })
  @IsOptional()
  @IsBoolean()
  factoryReset?: boolean;
}

export class VendorDebugTestModeDto {
  @ApiProperty({ description: '设备唯一标识' })
  @IsString()
  @IsNotEmpty()
  deviceId: string;

  @ApiProperty({ description: '是否进入测试模式' })
  @IsBoolean()
  enabled: boolean;
}

export class VendorDebugOtaDto {
  @ApiProperty({ description: '设备唯一标识' })
  @IsString()
  @IsNotEmpty()
  deviceId: string;

  @ApiProperty({ description: 'OTA 固件版本号' })
  @IsString()
  @IsNotEmpty()
  firmwareVersion: string;

  @ApiProperty({ description: '固件下载 URL' })
  @IsString()
  @IsNotEmpty()
  firmwareUrl: string;
}
