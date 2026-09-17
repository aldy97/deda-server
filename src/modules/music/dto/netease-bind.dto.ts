import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional } from 'class-validator';

export class NeteaseBindDto {
  @ApiProperty({ description: '设备唯一标识' })
  @IsString()
  @IsNotEmpty()
  deviceId: string;

  @ApiProperty({ description: '网易云音乐用户授权码/Token' })
  @IsString()
  @IsNotEmpty()
  authCode: string;

  @ApiPropertyOptional({ description: '网易云音乐用户 ID' })
  @IsOptional()
  @IsString()
  neteaseUserId?: string;
}
