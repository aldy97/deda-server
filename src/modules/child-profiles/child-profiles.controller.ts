import {
  Controller,
  Get,
  Patch,
  Param,
  Body,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Request } from 'express';
import { ChildProfilesService } from './child-profiles.service';
import { UpsertChildProfileDto } from './dto/upsert-child-profile.dto';
import { JwtAuthGuard } from '@/modules/users/guards/jwt-auth.guard';

interface RequestWithUser extends Request {
  user: { userId: string; openid: string };
}

@ApiTags('孩子档案')
@Controller('child-profiles')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class ChildProfilesController {
  constructor(private readonly childProfilesService: ChildProfilesService) {}

  @Get('device/:deviceId')
  async getByDevice(
    @Param('deviceId') deviceId: string,
    @Req() req: RequestWithUser,
  ) {
    return this.childProfilesService.getByDevice(req.user.userId, deviceId);
  }

  @Patch('device/:deviceId')
  async updateByDevice(
    @Param('deviceId') deviceId: string,
    @Body() dto: UpsertChildProfileDto,
    @Req() req: RequestWithUser,
  ) {
    return this.childProfilesService.upsertByDevice(
      req.user.userId,
      deviceId,
      dto,
    );
  }
}
