import { Controller, Get, Post, Body, Patch } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { UsersService } from './users.service';

@ApiTags('用户账号')
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Post('login')
  async wechatLogin(@Body() dto: any) {
    // TODO: 微信小程序登录
    return this.usersService.wechatLogin(dto);
  }

  @Post('phone')
  async bindPhone(@Body() dto: any) {
    // TODO: 绑定手机号
    return this.usersService.bindPhone(dto);
  }

  @Get('profile')
  async getProfile() {
    // TODO: 获取当前用户信息
    return this.usersService.getProfile();
  }

  @Patch('profile')
  async updateProfile(@Body() dto: any) {
    // TODO: 更新用户信息
    return this.usersService.updateProfile(dto);
  }
}
