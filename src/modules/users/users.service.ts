import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import axios from "axios";
import { PrismaService } from "@/common/prisma/prisma.service";
import { UpdateProfileDto } from "./dto/update-profile.dto";

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
    const appid = this.configService.get<string>("WECHAT_APPID") || "";
    const secret = this.configService.get<string>("WECHAT_SECRET") || "";

    let openid: string;

    if (appid && secret && !secret.includes("dev-") && secret.length >= 16) {
      // 真实微信登录
      try {
        const res = await axios.get(
          "https://api.weixin.qq.com/sns/jscode2session",
          {
            params: {
              appid,
              secret,
              js_code: dto.code,
              grant_type: "authorization_code",
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
        throw new Error("WeChat login failed");
      }
    } else {
      // 开发环境模拟微信 jscode2session：同一开发者工具用户返回同一 openid
      // 注意：这不是生产微信登录，仅用于本地联调时保持用户-设备关系稳定
      this.logger.warn(
        "WECHAT_APPID/SECRET not configured, simulating WeChat jscode2session with stable openid",
      );
      openid = "dev-openid-stable";
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
    return { phone: "mock-phone" };
  }

  /**
   * 家长手机品牌上报：只更新 users.phoneBrand / phoneBrandReportedAt 两列。
   * 空品牌不写库，避免客户端读取失败时覆盖旧值；用户不存在时 updateMany 返回 0。
   */
  async reportClientInfo(
    userId: string,
    dto: { brand?: string },
  ): Promise<{ success: boolean; skipped: boolean }> {
    const brand = (dto.brand ?? "").trim();
    if (!brand) {
      return { success: true, skipped: true };
    }
    const result = await this.prisma.user.updateMany({
      where: { id: userId },
      data: { phoneBrand: brand, phoneBrandReportedAt: new Date() },
    });
    return { success: true, skipped: result.count === 0 };
  }

  /**
   * 当前登录家长的档案（小程序「我的」页）。
   * 不下发 openid；deviceCount 为绑定设备数，childCount 为绑定设备上的孩子档案数
   * （共享设备下以设备归属为准，不按 childProfile.userId）。
   */
  async getProfile(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        nickname: true,
        phone: true,
        gender: true,
        birthday: true,
        createdAt: true,
      },
    });
    if (!user) {
      return null;
    }

    const [deviceCount, childCount] = await Promise.all([
      this.prisma.userDeviceBinding.count({ where: { userId } }),
      this.prisma.childProfile.count({
        where: { device: { bindings: { some: { userId } } } },
      }),
    ]);

    return {
      id: user.id,
      nickname: user.nickname ?? null,
      phone: user.phone ?? null,
      gender: user.gender ?? null,
      birthday: user.birthday ?? null,
      createdAt: user.createdAt,
      deviceCount,
      childCount,
    };
  }

  /**
   * 更新家长档案：nickname / gender / birthday 均为可选字段，未传保持原值，
   * gender / birthday 传 null 表示清空。空请求直接 400，避免静默无操作。
   */
  async updateProfile(userId: string, dto: UpdateProfileDto) {
    if (
      dto.nickname === undefined &&
      dto.gender === undefined &&
      dto.birthday === undefined
    ) {
      throw new BadRequestException("至少提供一个要更新的档案字段");
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        nickname: dto.nickname,
        gender: dto.gender,
        birthday: dto.birthday,
      },
    });
    return this.getProfile(userId);
  }
}
