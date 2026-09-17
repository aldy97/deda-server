import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty } from 'class-validator';

export class WifiConfigDto {
  @ApiProperty({ description: '设备唯一标识' })
  @IsString()
  @IsNotEmpty()
  deviceId: string;

  @ApiProperty({ description: 'WiFi SSID' })
  @IsString()
  @IsNotEmpty()
  ssid: string;

  @ApiProperty({ description: 'WiFi 密码' })
  @IsString()
  @IsNotEmpty()
  password: string;
}
