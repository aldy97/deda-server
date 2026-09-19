import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  OnlineStatus,
  BatteryStatus,
  VersionStatus,
  RuntimeStatus,
  NetworkStatus,
} from '../types/device-status.type';

/**
 * 设备状态 DTO
 *
 * 对应《AI 玩具 MQTT 数据对接文档》中 DEVICE_STATUS 的五个状态模块。
 */
export class DeviceStatusDto {
  @ApiPropertyOptional({ description: '厂商侧设备唯一编号' })
  deviceId: string;

  @ApiPropertyOptional({ description: '在线状态' })
  online?: OnlineStatus | null;

  @ApiPropertyOptional({ description: '电量状态' })
  battery?: BatteryStatus | null;

  @ApiPropertyOptional({ description: '设备版本' })
  version?: VersionStatus | null;

  @ApiPropertyOptional({ description: '运行状态' })
  runtime?: RuntimeStatus | null;

  @ApiPropertyOptional({ description: '网络状态' })
  network?: NetworkStatus | null;

  @ApiPropertyOptional({ description: '状态最后更新时间戳（取最新模块的 occurredAt）' })
  updatedAt?: number | null;
}
