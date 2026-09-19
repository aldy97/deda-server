import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { VendorService } from '../vendor/vendor.service';

@ApiTags('健康检查')
@Controller('health')
export class HealthController {
  constructor(private readonly vendorService: VendorService) {}

  @Get()
  @ApiOperation({ summary: '我方服务器健康检查（供机芯厂定时探测）' })
  health() {
    return this.vendorService.getHealth();
  }
}
