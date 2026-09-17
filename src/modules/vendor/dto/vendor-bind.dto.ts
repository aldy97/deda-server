import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, IsBoolean } from 'class-validator';

export class VendorBindDto {
  @ApiProperty({ description: '设备唯一标识' })
  @IsString()
  @IsNotEmpty()
  deviceId: string;

  @ApiPropertyOptional({ description: '设备序列号/硬件编码' })
  @IsOptional()
  @IsString()
  serialNumber?: string;

  @ApiPropertyOptional({ description: 'true=绑定，false=解绑' })
  @IsOptional()
  @IsBoolean()
  bound?: boolean;

  @ApiPropertyOptional({ description: '绑定用户 openid' })
  @IsOptional()
  @IsString()
  userOpenid?: string;
}
