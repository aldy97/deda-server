import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/common/prisma/prisma.service';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async wechatLogin(dto: any) {
    // TODO: 调用微信 jscode2session，创建或更新用户，返回 JWT
    return { token: 'mock-token' };
  }

  async bindPhone(dto: any) {
    // TODO: 解密微信手机号并绑定
    return { phone: 'mock-phone' };
  }

  async getProfile() {
    // TODO: 查询当前登录用户信息
    return null;
  }

  async updateProfile(dto: any) {
    // TODO: 更新用户信息
    return null;
  }
}
