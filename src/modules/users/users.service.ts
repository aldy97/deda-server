import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import axios from 'axios';
import { PrismaService } from '@/common/prisma/prisma.service';

export interface WechatLoginDto {
  code: string;
}

export interface WechatLoginResult {
  token: string;
  userInfo: {
    id: string;
    openid: string;
    phone: string | null;
  };
}

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly jwtService: JwtService,
  ) {}

  /**
   * 微信小程序登录
   * 1. 用 code 调微信 jscode2session 换 openid
   * 2. 本地开发若未配置 AppSecret，则模拟 jscode2session 返回稳定 openid
   * 3. 创建或更新用户，签发 JWT
   */
  async wechatLogin(dto: WechatLoginDto): Promise<WechatLoginResult> {
    const appid = this.configService.get<string>('WECHAT_APPID') || '';
    const secret = this.configService.get<string>('WECHAT_SECRET') || '';

    let openid: string;

    if (appid && secret && !secret.includes('dev-') && secret.length >= 16) {
      // 真实微信登录
      try {
        const res = await axios.get(
          'https://api.weixin.qq.com/sns/jscode2session',
          {
            params: {
              appid,
              secret,
              js_code: dto.code,
              grant_type: 'authorization_code',
            },
            timeout: 10000,
          },
        );

        if (res.data.errcode) {
          throw new Error(`WeChat login failed: ${res.data.errmsg}`);
        }
        openid = res.data.openid;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`WeChat jscode2session failed: ${message}`);
        throw new Error('WeChat login failed');
      }
    } else {
      // 开发环境模拟微信 jscode2session：同一开发者工具用户返回同一 openid
      // 注意：这不是生产微信登录，仅用于本地联调时保持用户-设备关系稳定
      this.logger.warn(
        'WECHAT_APPID/SECRET not configured, simulating WeChat jscode2session with stable openid',
      );
      openid = 'dev-openid-stable';
    }

    const user = await this.prisma.user.upsert({
      where: { openid },
      update: { updatedAt: new Date() },
      create: { openid },
    });

    const token = this.jwtService.sign({ sub: user.id, openid: user.openid });

    return {
      token,
      userInfo: {
        id: user.id,
        openid: user.openid,
        phone: user.phone || null,
      },
    };
  }

  async bindPhone(dto: any) {
    // TODO: 解密微信手机号并绑定
    return { phone: 'mock-phone' };
  }

  async getProfile(userId: string) {
    return this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, openid: true, phone: true, createdAt: true },
    });
  }

  async updateProfile(userId: string, dto: any) {
    // TODO: 更新当前登录用户信息
    return { userId, dto };
  }
}
