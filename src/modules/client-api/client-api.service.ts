import {
  BadRequestException,
  ConflictException,
  Inject,
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
  DEVICE_DEFAULT_LANG,
  VOICE_RECONCILE_PORT,
  VoiceReconcilePort,
} from "@/modules/baidu-agent/baidu-agent.types";
import {
  BOT_INSTANCE_TTL_SECONDS,
  PROVISION_RECENT_KEY,
  botCurrentKey,
  botInstanceKey,
  deviceNickname,
  resolveProvisionWindowMs,
  resolveTtsDefaultVol,
} from "./client-api.constants";
import { LoginMacDto } from "./dto/login-mac.dto";
import { BotGetValueDto } from "./dto/bot-getvalue.dto";
import { BotStartDto } from "./dto/bot-start.dto";
import { BotStopDto } from "./dto/bot-stop.dto";

/** 归一化后的 MAC 形态：十二位小写十六进制，无分隔符（机芯厂协议 1.4 节） */
const NORMALIZED_MAC_PATTERN = /^[0-9a-f]{12}$/;

/** 百度实例登记记录（Redis JSON 序列化存储） */
interface BotInstanceRecord {
  instanceid: string;
  appid: string;
  /** v1.1 兼容：百度实例控制鉴权信息；stop 时清除，不落日志、不回显 */
  authorization?: string;
  /** 切换角色/人设/音色 BCE 签名；stop 时清除，不落日志、不回显 */
  authorization_Role?: string;
  /** interrupt 打断播报 BCE 签名；stop 时清除，不落日志、不回显 */
  authorization_TTS?: string;
  /** authorization_Role 签名时间（ISO 8601），协议要求记录有效期 1800s */
  roleSignedAt?: string;
  /** authorization_TTS 签名时间（ISO 8601），协议要求记录有效期 1800s */
  ttsSignedAt?: string;
  cloudNode: string;
  lang: string;
  status: "active" | "ended";
  startedAt: string;
  endedAt?: string;
}

/**
 * 机芯厂设备侧 HTTP 接口（《设备端接口文档》v1.4）。
 *
 * - loginMac：设备联网后上报 MAC + 校验密码，服务端建档并在响应头返回
 *   三方 LLM API KEY；成功上线写入认领窗口（Redis sorted set），
 *   供小程序 GET /devices/provision-candidates 轮询认领。
 * - bot/getvalue：每轮创建百度实例前下发本轮 TTS 配置（vcn/vol/spd），
 *   固件不缓存，是平台侧音色配置到达设备的唯一通道。
 * - bot/start、bot/stop：每轮百度智能体实例的登记与结束，
 *   登记存 Redis（带 TTL），不建数据库表；登记状态丢失时设备按 401
 *   重新 loginMac 后重试，协议自恢复（v1.4 §7.2）。
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
  /**
   * getvalue 响应体 `vol` 的唯一来源（全局配置，不做每设备可调）。
   * null 表示配置缺失或越界，此时 getvalue 一律 500。
   */
  private readonly ttsDefaultVol: number | null;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    @Inject(VOICE_RECONCILE_PORT)
    private readonly voiceReconcile: VoiceReconcilePort,
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
    this.ttsDefaultVol = resolveTtsDefaultVol(
      this.configService.get<string>("TTS_DEFAULT_VOL"),
    );
    if (this.ttsDefaultVol === null) {
      // 启动自检：v1.4 §4.3 下 vol 非法会让设备每轮对话都创建失败，
      // 且固件不会自动重新 loginMac，只能在服务端日志里看见原因。
      this.logger.error(
        "TTS_DEFAULT_VOL is not a number within [0.5, 2.0]; bot/getvalue will fail with 500 and devices cannot create agent instances",
      );
    }
  }

  /**
   * 设备上线：校验密码 → upsert Device（幂等，重复上线仅更新登记）→
   * 写入认领窗口。
   * 返回归一化 MAC 与三方 LLM API KEY 供 controller 组装响应。
   */
  async loginMac(dto: LoginMacDto): Promise<{ mac: string; apiKey: string }> {
    const mac = this.normalizeMac(dto.mac);

    if (!this.macKey || !this.verifyPassword(mac, dto.password)) {
      // 安全日志只带 mac，不落 password / macKey
      this.logger.warn(`loginMac rejected: bad credential, mac=${mac}`);
      throw new UnauthorizedException("invalid password");
    }
    if (!this.llmApiKey) {
      // 服务端配置缺失；v1.4 §7.1：设备对 500 保留原参数退避重试
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
   * 每轮创建百度实例前下发本轮 TTS 配置（《设备端接口文档》v1.4 §4）。
   *
   * 三个字段都是必填且必须落在 v1.4 §4.2 的取值域内，任一不满足固件就停止
   * 本轮创建、不发 start 也不发 stop（§4.3），且不会自动重新 loginMac——
   * 所以这里宁可抛 500 也不返回编造的兜底值：一个假的 vcn 会让设备用错音色
   * 且无人察觉，一个 500 至少在服务端日志里留下可归因的原因。
   *
   * vcn 只取 `CHARACTER_TIMBRE_JSON`（IP → timbreId）：产品定义是一个机芯一个
   * IP、一个 IP 一个专属音色，家长端不选音色。运维经
   * `/device-configs/:deviceId/voice` 写入的 `desired.vcn` 在这里**刻意不采信**，
   * 否则同一个设备会出现「本轮实例用运维值、下一轮实例用角色值」的漂移；
   * 该端点的定位是实时修正与可观测归因，见 docs/voice-switching.md §2.1。
   */
  async botGetValue(
    dto: BotGetValueDto,
  ): Promise<{ vcn: string; vol: number; spd: number }> {
    // id 是 loginMac 返回的原值；我方 loginMac 的 id 就是归一化 MAC，
    // 因此复用同一套归一化规则，非法形态同样按 400 拒绝。
    const mac = this.normalizeMac(dto.id);
    const device = await this.assertDeviceRegistered(mac);

    const expectedNickname = deviceNickname(mac);
    if (dto.nickname !== expectedNickname) {
      // v1.4 §4.1 要求原值回传；不一致只 warn——nickname 不参与定位设备，
      // 拒答会让设备整轮无法对话（§4.3），代价远大于一个展示名不符。
      this.logger.warn(`getvalue nickname mismatch, mac=${mac}`);
    }

    if (this.ttsDefaultVol === null) {
      this.logger.error(`getvalue cannot resolve vol, mac=${mac}`);
      throw new InternalServerErrorException("tts volume not configured");
    }

    const vcn = this.voiceReconcile.getTimbreForCharacter(device.characterKey);
    if (!vcn) {
      // TODO(Q1): timbreId 取值已定（熊总 2026-11-19：两个 IP 暂统一用 1000957），
      // 但 staging/prod 的 env 都还没填；CHARACTER_TIMBRE_JSON 填上即恢复，
      // 代码无需改动。这是 v1.4 落地的发布闸口——固件升级到 v1.4 前必须填好。
      this.logger.error(
        `getvalue cannot resolve vcn: CHARACTER_TIMBRE_JSON has no timbreId for characterKey=${device.characterKey}, mac=${mac}`,
      );
      throw new InternalServerErrorException("timbre not configured");
    }

    // 哄睡会话内返回哄睡语速，否则返回非哄睡语速（都来自 DB 全局 voice_speed_config）。
    // getvalue 每轮建实例前拉取，定时进入（设备空闲无实例）时下次建实例即生效。
    const session = await this.prisma.conversationSession.findUnique({
      where: { deviceId: device.id },
    });
    const inSleepMode =
      session?.currentMode === "sleep_story" &&
      (!session.expiresAt || session.expiresAt.getTime() > Date.now());

    const spd = inSleepMode
      ? await this.voiceReconcile.resolveSleepSpd()
      : await this.voiceReconcile.resolveNormalSpd();

    return { vcn, vol: this.ttsDefaultVol, spd };
  }

  /**
   * 登记本轮百度智能体实例（幂等）：
   * - 设备未上线（无 Device 记录）→ 401，设备先 loginMac 再以原实例重试；
   * - 同实例重复 start → 更新控制鉴权信息，仍 200；
   * - 已结束实例被延迟 start 复活 → 409；
   * - 新实例登记为当前实例（旧实例不再当前，但不自动停止云端实例）。
   * - 登记成功后追平音色/语速期望值，追平结果不影响本接口的 200 响应。
   */
  async botStart(dto: BotStartDto): Promise<void> {
    const mac = this.normalizeMac(dto.mac);
    const device = await this.assertDeviceRegistered(mac);

    const now = new Date().toISOString();
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
        authorization_Role: dto.authorization_Role,
        authorization_TTS: dto.authorization_TTS,
        roleSignedAt: now,
        ttsSignedAt: now,
        cloudNode: dto.cloud_node ?? "cn",
        lang: dto.lang ?? DEVICE_DEFAULT_LANG,
      };
      await this.redis.setValue(
        key,
        JSON.stringify(updated),
        BOT_INSTANCE_TTL_SECONDS,
      );
    } else {
      const record: BotInstanceRecord = {
        instanceid: dto.instanceid,
        appid: dto.appid,
        authorization: dto.authorization,
        authorization_Role: dto.authorization_Role,
        authorization_TTS: dto.authorization_TTS,
        roleSignedAt: now,
        ttsSignedAt: now,
        cloudNode: dto.cloud_node ?? "cn",
        lang: dto.lang ?? DEVICE_DEFAULT_LANG,
        status: "active",
        startedAt: now,
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

    // 不 await：出站调用百度云最长可阻塞 BAIDU_AGENT_TIMEOUT_MS（默认 5000ms），
    // 而 v1.4 §5.2 要求本接口幂等快速返回 {"code":200}。等追平完成再响应会把
    // 一次慢调用放大成设备的多轮重试（v1.4 §7.2）。
    void this.reconcileVoice(mac, dto.instanceid, device.id);
  }

  /**
   * start 登记完成后追平音色/语速期望值。
   *
   * 重复 start 也要追平：那是签名续签的唯一时机，此前 deferred 的期望值
   * 只有在这里才可能变成 live。
   *
   * 本方法由 botStart 以 fire-and-forget 方式触发，因此绝不允许未捕获的
   * rejection 冒泡：v1.4 §5.2 要求 start 幂等返回 {"code":200}，追平失败也不能
   * 影响该响应。onInstanceRegistered 自身已保证不抛，这里的 try/catch 是对
   * 该响应契约的第二层保险。
   *
   * 代价：追平结果无法再从 HTTP 响应观察，只能看日志或
   * GET /device-configs/:deviceId/voice 的 applied/reason 字段。
   */
  private async reconcileVoice(
    mac: string,
    instanceId: string,
    deviceInternalId: string,
  ): Promise<void> {
    try {
      await this.voiceReconcile.onInstanceRegistered(
        mac,
        instanceId,
        deviceInternalId,
      );
    } catch (error) {
      this.logger.warn(
        `voice reconcile hook failed, mac=${mac}, instanceId=${instanceId}, error=${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
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
    delete ended.authorization_Role;
    delete ended.authorization_TTS;
    await this.redis.setValue(
      key,
      JSON.stringify(ended),
      BOT_INSTANCE_TTL_SECONDS,
    );
  }

  /**
   * MAC 归一化：删除 `:`、`-` 分隔符并转小写（v1.4 §1.4 通用约定），
   * 非法形态按 400 拒绝（v1.4 §7.1：参数/MAC 错误「修正请求，不自动重复」）。
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

  /**
   * 校验设备已上线登记（v1.4 §7.1：设备尚未上线登记 → 401）。
   * 返回查到的 Device 投影，供调用方复用——追平钩子需要内部 id，
   * getvalue 需要 characterKey，否则每轮都要为同一台设备多查一次库。
   */
  private async assertDeviceRegistered(
    mac: string,
  ): Promise<{ id: string; characterKey: string }> {
    const device = await this.prisma.device.findUnique({
      where: { deviceId: mac },
      select: { id: true, characterKey: true },
    });
    if (!device) {
      throw new UnauthorizedException("device not registered");
    }
    return device;
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
