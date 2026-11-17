import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from "class-validator";
import { AnalyticsAuthGuard } from "./guards/analytics-auth.guard";
import {
  MEMORY_SLOT_KEYS,
  MemoriesAnalyticsService,
} from "./memories-analytics.service";

export class MemoriesDevicesQueryDto {
  /** 模糊匹配业务 deviceId / deviceCode */
  @IsOptional()
  @IsString()
  @MaxLength(50)
  keyword?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number = 20;
}

export class MemoriesCurrentQueryDto {
  /** 业务设备 ID（Device.deviceId），非内部 UUID */
  @IsString()
  @IsNotEmpty()
  deviceId!: string;
}

export class MemoriesHistoryQueryDto {
  /** 业务设备 ID（Device.deviceId），非内部 UUID */
  @IsString()
  @IsNotEmpty()
  deviceId!: string;

  /** 5 槽位白名单之一，非法值 400 */
  @IsIn([...MEMORY_SLOT_KEYS])
  key!: string;
}

@ApiTags("analytics-memories")
@ApiBearerAuth()
@UseGuards(AnalyticsAuthGuard)
@Controller("analytics/memories")
export class MemoriesAnalyticsController {
  constructor(private readonly memories: MemoriesAnalyticsService) {}

  @Get("overview")
  @ApiOperation({
    summary:
      "记忆档案全局汇总（分母为至少有 1 条消息的设备数；coverage 为 0-1 四位小数）",
  })
  getOverview() {
    return this.memories.getOverview();
  }

  @Get("devices")
  @ApiOperation({
    summary:
      "有记忆版本行的设备列表（keyword 模糊匹配业务 deviceId/deviceCode；按 lastChangeAt 倒序）",
  })
  listDevices(@Query() query: MemoriesDevicesQueryDto) {
    return this.memories.listDevices(query);
  }

  @Get("current")
  @ApiOperation({
    summary:
      "某设备当前有效记忆（仅 status=active；空槽位不回；设备不存在 404）",
  })
  getCurrent(@Query() query: MemoriesCurrentQueryDto) {
    return this.memories.getCurrentMemories(query.deviceId);
  }

  @Get("history")
  @ApiOperation({
    summary:
      "单槽位版本链（version 升序，含 retract 墓碑行；key 非法 400，设备不存在 404）",
  })
  getHistory(@Query() query: MemoriesHistoryQueryDto) {
    return this.memories.getMemoryHistory(query.deviceId, query.key);
  }
}
