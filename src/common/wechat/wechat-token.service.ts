import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import axios from "axios";
import { RedisService } from "@/common/redis/redis.service";

const ACCESS_TOKEN_CACHE_KEY = "wechat:access_token";
/** 微信 token 有效期 7200s，提前 200s 过期 */
const ACCESS_TOKEN_CACHE_TTL_SEC = 7000;

/**
 * 微信服务端 access_token 管理：
 * Redis 缓存复用 + 进程内 single-flight（staging/prod 均为单容器部署）。
 * 未配置 WECHAT_APPID/SECRET 时降级返回 null（与 users.service 的
 * 开发环境模拟惯例一致），推送等调用方据此 no-op。
 */
@Injectable()
export class WechatTokenService {
  private readonly logger = new Logger(WechatTokenService.name);
  private pending: Promise<string> | null = null;

  constructor(
    private readonly redis: RedisService,
    private readonly configService: ConfigService,
  ) {}

  async getAccessToken(options?: {
    forceRefresh?: boolean;
  }): Promise<string | null> {
    const appid = this.configService.get<string>("WECHAT_APPID") || "";
    const secret = this.configService.get<string>("WECHAT_SECRET") || "";
    if (!appid || !secret) {
      this.logger.warn(
        "WECHAT_APPID/SECRET not configured, WeChat API calls disabled",
      );
      return null;
    }

    if (options?.forceRefresh) {
      await this.redis.deleteValue(ACCESS_TOKEN_CACHE_KEY);
    } else {
      const cached = await this.redis.getValue(ACCESS_TOKEN_CACHE_KEY);
      if (cached) return cached;
    }

    if (this.pending) return this.pending;

    const request = (async () => {
      const res = await axios.get("https://api.weixin.qq.com/cgi-bin/token", {
        params: {
          grant_type: "client_credential",
          appid,
          secret,
        },
        timeout: 10000,
      });
      const data = res.data as {
        access_token?: string;
        expires_in?: number;
        errcode?: number;
        errmsg?: string;
      };
      if (data.errcode || !data.access_token) {
        throw new Error(
          `WeChat access_token failed: ${data.errcode} ${data.errmsg || ""}`,
        );
      }
      await this.redis.setValue(
        ACCESS_TOKEN_CACHE_KEY,
        data.access_token,
        ACCESS_TOKEN_CACHE_TTL_SEC,
      );
      return data.access_token;
    })();

    const clear = () => {
      this.pending = null;
    };
    request.then(clear, clear);
    this.pending = request;
    return request;
  }
}
