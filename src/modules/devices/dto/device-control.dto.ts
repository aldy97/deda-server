import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, IsNumber, IsBoolean } from 'class-validator';

export class DeviceControlDto {
  @ApiProperty({ description: '控制动作：volume/power/interrupt/sleep/auto_shutdown', enum: ['volume', 'power', 'interrupt', 'sleep', 'auto_shutdown'] })
  @IsString()
  @IsNotEmpty()
  action: string;

  @ApiPropertyOptional({ description: '音量 0-100，action=volume 时必填' })
  @IsOptional()
  @IsNumber()
  volume?: number;

  @ApiPropertyOptional({ description: 'true=开机/唤醒，false=关机/休眠，action=power 时必填' })
  @IsOptional()
  @IsBoolean()
  powerOn?: boolean;

  @ApiPropertyOptional({ description: 'true=开启打断，false=关闭打断，action=interrupt 时必填' })
  @IsOptional()
  @IsBoolean()
  interruptEnabled?: boolean;

  @ApiPropertyOptional({ description: '休眠/自动关机延迟分钟数，action=sleep/auto_shutdown 时必填' })
  @IsOptional()
  @IsNumber()
  delayMinutes?: number;
}
