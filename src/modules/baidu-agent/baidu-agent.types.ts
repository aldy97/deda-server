/**
 * 百度云「大模型实时互动」控制面共享契约。
 *
 * 本文件是音色/语速动态切换链路的唯一口径来源，所有实现与测试都以此为准。
 * 出处（逐条对应，便于回溯）：
 * - 服务端 API（switchSceneRole / interrupt / timbres 的请求语法、请求体、错误码）：
 *   https://cloud.baidu.com/doc/RTC/s/hm8zjic1q
 * - 接口鉴权（host 固定值、公共请求头必须性）：
 *   https://cloud.baidu.com/doc/RTC/s/em8y48zz6
 * - 认证字符串格式（bce-auth-v1 各段含义、timestamp 格式、有效期起算点）：
 *   https://cloud.baidu.com/doc/Reference/s/njwvz1yfu
 * - 机芯厂《设备端接口文档》v1.2 2.2 节：两份签名分别对应 switchSceneRole 与
 *   interrupt，签名头为 content-type;host;x-bce-date，有效期 1800 秒。
 *
 * 零假设原则：凡是文档未定义、或依赖他方答复的取值（具体音色 id、语速倍数、
 * 海外节点域名、音色目录内容），一律不在代码里写死，改为配置注入 + fail-closed。
 */

/**
 * 云节点 → 服务域名。
 *
 * 只有 cn 有官方出处：《接口鉴权》写明「host 服务域名，目前固定为
 * rtc-aiagent.baidubce.com」。机芯厂文档 2.2 节同时写明「Host 与所选百度云
 * 节点一致」，即 host 被签进了签名，猜域名必然导致签名校验失败。
 *
 * TODO(Q2): cloud_node=overseas / euUs 的域名未确认，确认前不加入本表；
 * 不在表内的节点一律 fail-closed（见 VoiceApplyBlockReason.unsupported_cloud_node），
 * 拿到域名后补进映射并补对应单测。
 */
export const BAIDU_AGENT_HOSTS: Readonly<Record<string, string>> = {
  cn: "rtc-aiagent.baidubce.com",
};

/** 切换角色（音色）：PUT {path}?{query} */
export const SWITCH_SCENE_ROLE_PATH = "/api/v1/aiagent/instances/operation";

/**
 * 规范化查询串取 `switchSceneRole=`（与机芯厂文档 2.2 节一致）。
 * 百度《生成认证字符串》规定「只有 key 没有 value 时规范化为 UriEncode(key)+"="」，
 * 因此 `?switchSceneRole` 与 `?switchSceneRole=` 等价，两种写法都能对上设备签名。
 */
export const SWITCH_SCENE_ROLE_QUERY = "switchSceneRole=";

/** 打断当前 TTS 播报并播报 extra_msg：POST */
export const INTERRUPT_PATH = "/api/v1/aiagent/interrupt";

/** 业务错误码（服务端 API 文档「错误响应码」表） */
export const BAIDU_ERROR_INSTANCE_NOT_EXIST =
  "AIProxyInstanceNotExistException";
export const BAIDU_ERROR_NO_SUCH_SCENE_ROLE = "NoSuchSceneRole";

/** 出站请求默认超时（毫秒），可由 BAIDU_AGENT_TIMEOUT_MS 覆盖 */
export const DEFAULT_BAIDU_AGENT_TIMEOUT_MS = 5000;

/**
 * tts 配置串的类型前缀。
 * 文档口径：`tts` 取值等价于创建实例接口的 `tts_url`，格式为
 * 「tts 类型前缀 + 详细配置 JSON 序列化字符串」，前缀必须与类型完全一致。
 */
export const TTS_TYPE_DEFAULT = "DEFAULT";

/**
 * 内置 tts（DEFAULT）的音速倍数范围，文档明确为 [0.5 ~ 2.0]。
 * 越界一律拒绝，不做裁剪——裁剪等于替产品做决定。
 */
export const TTS_SPD_MIN = 0.5;
export const TTS_SPD_MAX = 2;

/**
 * 百度 ai_agent_instance_id 是 Long，请求体里必须是裸数字。
 * 我方按机芯厂协议 4.1 以十进制字符串保存（避免 JS Number 精度丢失），
 * 拼请求体时原样嵌入，禁止经过 Number()。
 */
export const INSTANCE_ID_PATTERN = /^\d{1,19}$/;

/** 认证字符串前缀与 timestamp 形态（《生成认证字符串》：yyyy-mm-ddThh:mm:ssZ） */
export const BCE_AUTH_PREFIX = "bce-auth-v1";
export const BCE_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/**
 * 签名必须包含的签名头。机芯厂文档 2.2 节写明两份签名都使用
 * `content-type;host;x-bce-date`；缺任一都意味着固件改了签名方式，
 * 我方按同一口径回填请求头就会失效，因此 fail-closed 而不是继续尝试。
 */
export const REQUIRED_SIGNED_HEADERS = ["host", "x-bce-date"] as const;

/**
 * 无法实时下发的原因分类。同时用于 telemetry 与 App 接口的 reason 字段，
 * 让「为什么没生效」可观测、可归因，而不是静默失败。
 */
export type VoiceApplyBlockReason =
  /** BAIDU_AGENT_ENABLED 未开启（默认关闭，暗启动） */
  | "disabled"
  /** 设备当前没有活跃实例，或实例已 stop（签名已被清除） */
  | "no_active_instance"
  /** 签名串形态不符（段数、前缀、timestamp、有效期任一项非法） */
  | "signature_unparsable"
  /** 签名已过期：timestamp + expirationPeriodInSeconds < now */
  | "signature_expired"
  /** signedHeaders 缺少 host 或 x-bce-date */
  | "signed_headers_unexpected"
  /** cloud_node 不在 BAIDU_AGENT_HOSTS 内 */
  | "unsupported_cloud_node"
  /** 我方入参非法（如 instanceid 不是十进制整数串） */
  | "invalid_request"
  /** 编排过程抛出未预期异常（DB/Redis 故障等），已吞掉以保住主流程响应 */
  | "internal_error"
  /** 音色目录为空（placeholder 未填充） */
  | "empty_catalog"
  /** 期望音色不在目录内，或与实例语种不匹配 */
  | "voice_not_in_catalog"
  /** 语速档位 → spd 倍数的映射未配置 */
  | "speech_rate_map_missing"
  /** 只有音色或只有语速，不足以组装完整 tts 串 */
  | "incomplete_tts_target"
  /** 百度返回非 2xx */
  | "upstream_error";

/**
 * 解析后的认证字符串。
 *
 * 刻意不暴露 accessKeyId 与 signature：这两个值属于凭据，
 * 与机芯厂文档 2.2 节「不得将签名原值写入普通日志、管理页面和响应体」一致。
 * raw 仅供原样回填 authorization 请求头使用。
 */
export interface ParsedBceAuthString {
  /** 签名生成时的 UTC 时间，即请求头 x-bce-date 必须原样回填的值 */
  timestamp: string;
  /** 有效期秒数，从 timestamp 起算（不硬编码 1800，随固件变化自动跟随） */
  expiresInSeconds: number;
  /** 签名头列表，已转小写 */
  signedHeaders: string[];
  /** 设备上报的签名原值 */
  raw: string;
}

/** 出站调用结果：失败一定带可归因的 reason */
export type BaiduAgentCallResult =
  { ok: true } | { ok: false; reason: VoiceApplyBlockReason; detail?: string };

export interface SwitchSceneRoleParams {
  /** 百度互动应用 ID（来自设备 start 上报的 appid） */
  appId: string;
  /** 实例 ID，十进制字符串 */
  instanceId: string;
  /** 已组装好的 tts 配置串 */
  tts: string;
  /** 实例语种，透传设备 start 上报的 lang */
  lang?: string;
  /** 设备上报的 authorization_Role 原值 */
  authString: string;
  /** 设备上报的 cloud_node */
  cloudNode: string;
}

export interface InterruptParams {
  appId: string;
  instanceId: string;
  /** 打断后要播报的文本 */
  extraMsg: string;
  /** 设备上报的 authorization_TTS 原值 */
  authString: string;
  cloudNode: string;
}

/**
 * 控制面客户端端口。
 *
 * 用端口而非具体类做依赖，是为了让 device-configs（App 接口）与 client-api
 * （start 追平）都只依赖契约、不依赖实现，避免模块间循环引用。
 */
export const BAIDU_AGENT_CLIENT_PORT = "BAIDU_AGENT_CLIENT";

export interface BaiduAgentClientPort {
  /** BAIDU_AGENT_ENABLED 是否为 true */
  readonly enabled: boolean;
  switchSceneRole(params: SwitchSceneRoleParams): Promise<BaiduAgentCallResult>;
  interrupt(params: InterruptParams): Promise<BaiduAgentCallResult>;
}

/** 音色目录条目，字段照抄 GET /api/v1/timbres 的响应参数 */
export interface VoiceCatalogEntry {
  /** 百度 timbreId（Long），以字符串保存避免精度问题；即 tts 串里的 vcn */
  timbreId: string;
  name: string;
  /** TRAINED / UNTRAINED，只有 TRAINED 可用 */
  status: string;
  /** chinese / english / japanese */
  language: string;
}

export const VOICE_CATALOG_PORT = "VOICE_CATALOG";

export interface VoiceCatalogPort {
  /** 全部可用音色（已过滤 status !== TRAINED） */
  listUsable(): VoiceCatalogEntry[];
  /** 按实例语种过滤后的可用音色 */
  listForLang(lang: string | undefined): VoiceCatalogEntry[];
  find(timbreId: string, lang?: string): VoiceCatalogEntry | null;
  readonly available: boolean;
}

/** 设备当前期望的音色/语速（App 落库值） */
export interface DesiredVoiceState {
  vcn: string | null;
  /** 档位键，取值见 SPEECH_RATES */
  speechRate: string | null;
}

export type VoiceApplyStatus = "live" | "deferred" | "noop";

export interface VoiceApplyOutcome {
  /** live=已对活跃实例生效；deferred=已落库待下一轮追平；noop=无期望值 */
  applied: VoiceApplyStatus;
  reason?: VoiceApplyBlockReason;
}

export const VOICE_RECONCILE_PORT = "VOICE_RECONCILE";

export interface VoiceReconcilePort {
  /** 读取设备当前生效配置里的音色/语速期望值 */
  readDesired(deviceInternalId: string): Promise<DesiredVoiceState>;
  /** 对设备当前活跃实例下发期望值；永不抛错 */
  applyToActiveInstance(
    mac: string,
    desired: DesiredVoiceState,
  ): Promise<VoiceApplyOutcome>;
  /**
   * 设备 start 登记成功后的追平入口；永不抛错。
   * 协议 4.2 要求 start 幂等返回 {"code":200}，追平失败绝不能影响该响应，
   * 否则设备会按协议 6.2 做无意义重试。
   *
   * @param deviceInternalId 可选。调用方（bot/start）已经查过 Device，
   *   传入即免去本方法内的重复查询；不传则自行按 mac 查。
   */
  onInstanceRegistered(
    mac: string,
    instanceId: string,
    deviceInternalId?: string,
  ): Promise<VoiceApplyOutcome>;
  /**
   * IP/角色 → timbreId 权威映射查表；纯读配置，不出网、不查库、永不抛错。
   *
   * 用途是让服务端知道「某个 IP 对应哪个音色」，两个消费方：
   * 1. 设备端协议 v1.4（2026-11-18）新增的 POST /client/bot/bot/getvalue——固件每轮
   *    创建百度实例前拉取 vcn/vol/spd 且不缓存，vcn 即取自本映射
   *    （实现见 ClientApiService.botGetValue；返回 null 时该接口按 v1.4 §4.3 抛 500）；
   * 2. 剧情内按角色切换音色：冒险故事里非本机芯 IP 的角色说话时用该角色
   *    自己的音色，故事结束后再切回本 IP 的音色。
   *
   * @param characterKey Device.characterKey（elly / polly）；null 或空串返回 null
   * @returns 配置的 timbreId（字符串），或 null（未配置 / 未命中 / 配置非法）
   */
  getTimbreForCharacter(characterKey: string | null): string | null;
  /** 语速档位 → spd 倍数；映射未配置时返回 null */
  resolveSpd(speechRate: string | null): number | null;
}

/**
 * 语速档位键。与 DeviceConfig.speechRate 现有注释口径一致（slow/normal/fast）。
 * 档位 → spd 倍数的具体数值是产品决策，走配置注入，代码里不出现魔法数字。
 */
export const SPEECH_RATES = ["slow", "normal", "fast"] as const;
export type SpeechRate = (typeof SPEECH_RATES)[number];

/**
 * 设备默认语种。
 *
 * 机芯厂 2026-11-17 书面确认：固件 bot/start 上报的 lang 取值就是 `zh`，
 * 与《设备端接口文档》4.1 节「默认 zh」一致。loginMac 响应体的 lang 与
 * bot/start 缺省回填两处共用此常量，避免口径漂移。
 */
export const DEVICE_DEFAULT_LANG = "zh";

/**
 * 实例语种（机芯厂文档 4.1 的 lang，如 zh）→ 音色 language（timbres 接口枚举）。
 *
 * 依据：timbres 响应参数 language 取值为 chinese/english/japanese，
 * 且 switchSceneRole 明确「不可跨语言互切角色」，因此必须按语种过滤音色。
 * `zh` 一侧已由机芯厂 2026-11-17 确认；`en`/`ja` 仍是由两页文档取值域推得。
 *
 * TODO(Q1): en/ja 映射未经确认；映射不到的语种一律返回空目录（fail-closed）。
 */
export const TIMBRE_LANGUAGE_BY_LANG: Readonly<Record<string, string>> = {
  zh: "chinese",
  en: "english",
  ja: "japanese",
};

/**
 * DeviceConfig.payload 中保存音色期望值的键。
 *
 * 复用已有的 payload Json 列而不是新增列，是为了不引入 migration：
 * 同一仓库同一时段只允许一个 worktree 改迁移文件，且音色目录本身还是
 * placeholder，等目录确定后再决定是否规范化成独立列。
 */
export const VOICE_PAYLOAD_KEY = "voice";

export interface VoicePayload {
  vcn: string;
  updatedAt?: string;
}

/**
 * 从 DeviceConfig.payload 里安全取出音色期望值。
 * 结构不符（缺 vcn、vcn 非字符串、空串）一律视为未设置，返回 null。
 */
export function parseVoicePayload(payload: unknown): VoicePayload | null {
  if (typeof payload !== "object" || payload === null) return null;
  const nested = (payload as Record<string, unknown>)[VOICE_PAYLOAD_KEY];
  if (typeof nested !== "object" || nested === null) return null;
  const vcn = (nested as Record<string, unknown>).vcn;
  if (typeof vcn !== "string" || vcn.length === 0) return null;
  const updatedAt = (nested as Record<string, unknown>).updatedAt;
  return {
    vcn,
    ...(typeof updatedAt === "string" ? { updatedAt } : {}),
  };
}
