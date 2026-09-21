import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Request } from 'express';
import { UsersService, WechatLoginDto } from './users.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';

interface RequestWithUser extends Request {
  user: { userId: string; openid: string };
}

@ApiTags('用户账号')
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Post('login')
  async wechatLogin(@Body() dto: WechatLoginDto) {
    return this.usersService.wechatLogin(dto);
  }

  @Post('phone')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  async bindPhone(@Body() dto: any, @Req() req: RequestWithUser) {
    return this.usersService.bindPhone({ ...dto, userId: req.user.userId });
  }

  @Get('profile')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  async getProfile(@Req() req: RequestWithUser) {
    return this.usersService.getProfile(req.user.userId);
  }

  @Patch('profile')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  async updateProfile(@Body() dto: any, @Req() req: RequestWithUser) {
    return this.usersService.updateProfile(req.user.userId, dto);
  }
}
