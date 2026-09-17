import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, IsNumber } from 'class-validator';

export class MusicControlDto {
  @ApiProperty({ description: '设备唯一标识' })
  @IsString()
  @IsNotEmpty()
  deviceId: string;

  @ApiProperty({ description: '操作：play/pause/resume/stop/next/prev/volume', enum: ['play', 'pause', 'resume', 'stop', 'next', 'prev', 'volume'] })
  @IsString()
  @IsNotEmpty()
  action: string;

  @ApiPropertyOptional({ description: '歌曲 ID/URL，action=play 时必填' })
  @IsOptional()
  @IsString()
  songId?: string;

  @ApiPropertyOptional({ description: '音量 0-100，action=volume 时必填' })
  @IsOptional()
  @IsNumber()
  volume?: number;
}
