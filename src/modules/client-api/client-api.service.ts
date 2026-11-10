import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash, timingSafeEqual } from "crypto";
import { PrismaService } from "@/common/prisma/prisma.service";
import { RedisService } from "@/common/redis/redis.service";
import {
  BOT_INSTANCE_TTL_SECONDS,
  PROVISION_RECENT_KEY,
  botCurrentKey,
  botInstanceKey,
  resolveProvisionWindowMs,
} from "./client-api.constants";
import { LoginMacDto } from "./dto/login-mac.dto";
import { BotStartDto } from "./dto/bot-start.dto";
import { BotStopDto } from "./dto/bot-stop.dto";

/** 归一化后的 MAC 形态：十二位小写十六进制，无分隔符（机芯厂协议 1.4 节） */
const NORMALIZED_MAC_PATTERN = /^[0-9a-f]{12}$/;

/** 百度实例登记记录（Redis JSON 序列化存储） */
interface BotInstanceRecord {
  instanceid: string;
  appid: string;
  /** 百度实例控制鉴权信息；stop 时清除，不落日志、不回显 */
  authorization?: string;
  cloudNode: string;
  lang: string;
  status: "active" | "ended";
  startedAt: string;
  endedAt?: string;
}

/**
 * 机芯厂设备侧 HTTP 接口（《设备端接口文档》v1.1）。
 *
 * - loginMac：设备联网后上报 MAC + 校验密码，服务端建档并在响应头返回
 *   三方 LLM API KEY；成功上线写入认领窗口（Redis sorted set），
 *   供小程序 GET /devices/provision-candidates 轮询认领。
 * - bot/start、bot/stop：每轮百度智能体实例的登记与结束，
 *   登记存 Redis（带 TTL），不建数据库表；登记状态丢失时设备按 401
 *   重新 loginMac 后重试，协议自恢复（文档 6.2 节）。
 *
 * MAC 口径：本模块一律小写（协议约定）。注意 DeviceLinkService 的 MQTT
 * 旧链路归一化为大写，仅影响其自有 Redis key，不与此处冲突；新固件
 * 不再发布 MQTT loginMac 公共主题，Device 建档以本接口为唯一入口。
 */
@Injectable()
export class ClientApiService {
  private readonly logger = new Logger(ClientApiService.name);
  private readonly macKey?: string;
  private readonly llmApiKey?: string;
  private readonly provisionWindowMs: number;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {
    this.macKey = this.configService.get<string>("DEVICE_LOGIN_MAC_KEY");
    if (!this.macKey) {
      this.logger.warn(
        "DEVICE_LOGIN_MAC_KEY is not configured; all loginMac requests will be rejected",
      );
    }
    this.llmApiKey = this.configService.get<string>("LLM_ADAPTER_API_KEY");
    if (!this.llmApiKey) {
      this.logger.warn(
        "LLM_ADAPTER_API_KEY is not configured; loginMac cannot return an api key",
      );
    }
    this.provisionWindowMs = resolveProvisionWindowMs(
      this.configService.get<string>("PROVISION_CLAIM_WINDOW_SEC"),
    );
  }

  /**
   * 设备上线：校验密码 → upsert Device（幂等，重复上线仅更新登记）→
   * 写入认领窗口。返回归一化 MAC 与三方 LLM API KEY 供 controller 组装响应。
   */
  async loginMac(dto: LoginMacDto): Promise<{ mac: string; apiKey: string }> {
    const mac = this.normalizeMac(dto.mac);

    if (!this.macKey || !this.verifyPassword(mac, dto.password)) {
      // 安全日志只带 mac，不落 password / macKey
      this.logger.warn(`loginMac rejected: bad credential, mac=${mac}`);
      throw new UnauthorizedException("invalid password");
    }
    if (!this.llmApiKey) {
      // 服务端配置缺失；文档 6.2：设备对 500 退避重试
      this.logger.error("LLM_ADAPTER_API_KEY is not configured");
      throw new InternalServerErrorException("llm api key not configured");
    }

    await this.prisma.device.upsert({
      where: { deviceId: mac },
      create: { deviceId: mac, macAddress: mac },
      update: { macAddress: mac },
    });

    const now = Date.now();
    await this.redis.zAdd(PROVISION_RECENT_KEY, now, mac);
    await this.redis.zRemRangeByScore(
      PROVISION_RECENT_KEY,
      0,
      now - this.provisionWindowMs,
    );

    this.logger.log(`loginMac ok, mac=${mac}`);
    return { mac, apiKey: this.llmApiKey };
  }

  /**
   * 登记本轮百度智能体实例（幂等）：
   * - 设备未上线（无 Device 记录）→ 401，设备先 loginMac 再以原实例重试；
   * - 同实例重复 start → 更新控制鉴权信息，仍 200；
   * - 已结束实例被延迟 start 复活 → 409；
   * - 新实例登记为当前实例（旧实例不再当前，但不自动停止云端实例）。
   */
  async botStart(dto: BotStartDto): Promise<void> {
    const mac = this.normalizeMac(dto.mac);
    await this.assertDeviceRegistered(mac);

    const key = botInstanceKey(mac, dto.instanceid);
    const existing = await this.readInstance(key);
    if (existing) {
      if (existing.status === "ended") {
        throw new ConflictException("instance already ended");
      }
      const updated: BotInstanceRecord = {
        ...existing,
        appid: dto.appid,
        authorization: dto.authorization,
        cloudNode: dto.cloud_node ?? "cn",
        lang: dto.lang ?? "zh",
      };
      await this.redis.setValue(
        key,
        JSON.stringify(updated),
        BOT_INSTANCE_TTL_SECONDS,
      );
      return;
    }

    const record: BotInstanceRecord = {
      instanceid: dto.instanceid,
      appid: dto.appid,
      authorization: dto.authorization,
      cloudNode: dto.cloud_node ?? "cn",
      lang: dto.lang ?? "zh",
      status: "active",
      startedAt: new Date().toISOString(),
    };
    await this.redis.setValue(
      key,
      JSON.stringify(record),
      BOT_INSTANCE_TTL_SECONDS,
    );
    await this.redis.setValue(
      botCurrentKey(mac),
      dto.instanceid,
      BOT_INSTANCE_TTL_SECONDS,
    );
  }

  /**
   * 结束本轮实例登记（幂等）：按 mac + instanceid 精确定位，
   * 旧实例的延迟 stop 不会清理新实例；stop 时清除控制鉴权信息。
   */
  async botStop(dto: BotStopDto): Promise<void> {
    const mac = this.normalizeMac(dto.mac);
    await this.assertDeviceRegistered(mac);

    const key = botInstanceKey(mac, dto.instanceid);
    const existing = await this.readInstance(key);
    if (!existing) {
      throw new NotFoundException("instance not found");
    }
    if (existing.status === "ended") {
      return; // 重复退下幂等
    }
    const ended: BotInstanceRecord = {
      ...existing,
      status: "ended",
      endedAt: new Date().toISOString(),
    };
    delete ended.authorization;
    await this.redis.setValue(
      key,
      JSON.stringify(ended),
      BOT_INSTANCE_TTL_SECONDS,
    );
  }

  /**
   * MAC 归一化：删除 `:`、`-` 分隔符并转小写（协议 3.1 节规则），
   * 非法形态按 400 拒绝（文档 6.1：参数/MAC 错误不自动重试）。
   */
  private normalizeMac(raw: string): string {
    const normalized = raw.replace(/[:-]/g, "").toLowerCase();
    if (!NORMALIZED_MAC_PATTERN.test(normalized)) {
      throw new BadRequestException("invalid mac");
    }
    return normalized;
  }

  /**
   * 密码校验：md5_ascii(md5_utf8(macKey + mac).hexdigest()).hexdigest()，
   * 第二层对第一层的 32 字符小写 hex 文本计算（协议 3.1 节）。
   * 时序安全比较，两侧均为 32 字符小写 hex。
   */
  private verifyPassword(mac: string, password: string): boolean {
    const first = createHash("md5")
      .update(this.macKey + mac, "utf8")
      .digest("hex");
    const expected = createHash("md5").update(first, "ascii").digest("hex");
    const expectedBuf = Buffer.from(expected, "utf8");
    const givenBuf = Buffer.from(password, "utf8");
    return (
      expectedBuf.length === givenBuf.length &&
      timingSafeEqual(expectedBuf, givenBuf)
    );
  }

  private async assertDeviceRegistered(mac: string): Promise<void> {
    const device = await this.prisma.device.findUnique({
      where: { deviceId: mac },
      select: { id: true },
    });
    if (!device) {
      throw new UnauthorizedException("device not registered");
    }
  }

  private async readInstance(key: string): Promise<BotInstanceRecord | null> {
    const raw = await this.redis.getValue(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as BotInstanceRecord;
    } catch {
      this.logger.warn("corrupted bot instance record, treating as missing");
      return null;
    }
  }
}
