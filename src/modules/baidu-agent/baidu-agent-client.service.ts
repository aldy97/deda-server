import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import axios, { AxiosError } from "axios";
import { randomUUID } from "crypto";
import {
  BAIDU_AGENT_HOSTS,
  DEFAULT_BAIDU_AGENT_TIMEOUT_MS,
  INSTANCE_ID_PATTERN,
  INTERRUPT_PATH,
  SWITCH_SCENE_ROLE_PATH,
  SWITCH_SCENE_ROLE_QUERY,
} from "./baidu-agent.types";
import type {
  BaiduAgentCallResult,
  InterruptParams,
  SwitchSceneRoleParams,
  BaiduAgentClientPort,
} from "./baidu-agent.types";
import {
  parseBceAuthString,
  isBceAuthExpired,
  hasRequiredSignedHeaders,
} from "./bce-auth-string.util";

/**
 * 百度云「大模型实时互动」控制面 HTTP 客户端。
 *
 * 负责签名解析、校验守卫、请求组装与上游调用。
 * 所有出站调用前先走 fail-closed 守卫链，任一层失败直接返回 {ok:false, reason}
 * 且绝不发起 HTTP 请求。
 *
 * @see https://cloud.baidu.com/doc/RTC/s/hm8zjic1q （服务端 API）
 * @see https://cloud.baidu.com/doc/RTC/s/em8y48zz6 （接口鉴权）
 * @see https://cloud.baidu.com/doc/Reference/s/njwvz1yfu （认证字符串）
 */
@Injectable()
export class BaiduAgentClient implements BaiduAgentClientPort {
  private readonly logger = new Logger(BaiduAgentClient.name);
  private readonly timeoutMs: number;

  constructor(private readonly configService: ConfigService) {
    const raw = this.configService.get<string>("BAIDU_AGENT_TIMEOUT_MS");
    const parsed = Number(raw);
    this.timeoutMs =
      Number.isFinite(parsed) && parsed > 0
        ? parsed
        : DEFAULT_BAIDU_AGENT_TIMEOUT_MS;
  }

  /** BAIDU_AGENT_ENABLED 是否为 "true"（默认 false，暗启动） */
  get enabled(): boolean {
    return this.configService.get<string>("BAIDU_AGENT_ENABLED") === "true";
  }

  /**
   * 切换音色（角色）：PUT /api/v1/aiagent/instances/operation?switchSceneRole=
   */
  async switchSceneRole(
    params: SwitchSceneRoleParams,
  ): Promise<BaiduAgentCallResult> {
    const guard = this.runGuards(
      params.authString,
      params.cloudNode,
      params.appId,
      params.instanceId,
    );
    if (guard) return guard;

    const host = BAIDU_AGENT_HOSTS[params.cloudNode];
    const parsedAuth = parseBceAuthString(params.authString)!;
    const requestId = randomUUID();

    const url = `https://${host}${SWITCH_SCENE_ROLE_PATH}?${SWITCH_SCENE_ROLE_QUERY}`;

    const body = this.buildSwitchSceneRoleBody(params);

    return this.execute(
      "PUT",
      url,
      params.authString,
      parsedAuth.timestamp,
      host,
      requestId,
      body,
      params.instanceId,
    );
  }

  /**
   * 打断当前 TTS 播报：POST /api/v1/aiagent/interrupt
   */
  async interrupt(params: InterruptParams): Promise<BaiduAgentCallResult> {
    const guard = this.runGuards(
      params.authString,
      params.cloudNode,
      params.appId,
      params.instanceId,
    );
    if (guard) return guard;

    const host = BAIDU_AGENT_HOSTS[params.cloudNode];
    const parsedAuth = parseBceAuthString(params.authString)!;
    const requestId = randomUUID();

    const url = `https://${host}${INTERRUPT_PATH}`;

    const body = this.buildInterruptBody(params);

    return this.execute(
      "POST",
      url,
      params.authString,
      parsedAuth.timestamp,
      host,
      requestId,
      body,
      params.instanceId,
    );
  }

  // ---- 私有方法 ------------------------------------------------------------

  /**
   * 守卫链：enabled → parseBceAuthString → hasRequiredSignedHeaders →
   * isBceAuthExpired → BAIDU_AGENT_HOSTS → instanceId/appId 格式校验。
   * 任一层失败返回 {ok:false, reason}，全通过返回 null（放行）。
   */
  private runGuards(
    authString: string,
    cloudNode: string,
    appId: string,
    instanceId: string,
  ): BaiduAgentCallResult | null {
    if (!this.enabled) {
      this.logger.warn("BaiduAgentClient disabled, call blocked");
      return { ok: false, reason: "disabled" };
    }

    const parsed = parseBceAuthString(authString);
    if (!parsed) {
      this.logger.warn("signature_unparsable, call blocked");
      return { ok: false, reason: "signature_unparsable" };
    }

    if (!hasRequiredSignedHeaders(parsed)) {
      this.logger.warn("signed_headers_unexpected, call blocked");
      return { ok: false, reason: "signed_headers_unexpected" };
    }

    if (isBceAuthExpired(parsed)) {
      this.logger.warn("signature_expired, call blocked");
      return { ok: false, reason: "signature_expired" };
    }

    if (!BAIDU_AGENT_HOSTS[cloudNode]) {
      this.logger.warn(`unsupported_cloud_node=${cloudNode}, call blocked`);
      return { ok: false, reason: "unsupported_cloud_node" };
    }

    if (
      typeof appId !== "string" ||
      appId.length === 0 ||
      !INSTANCE_ID_PATTERN.test(instanceId)
    ) {
      this.logger.warn("invalid_request, call blocked");
      return { ok: false, reason: "invalid_request" };
    }

    return null;
  }

  /**
   * 手工拼装 switchSceneRole 请求体 JSON 字符串。
   * ai_agent_instance_id 原样嵌入为裸数字（不经过 JSON.stringify），
   * 其余字符串值使用 JSON.stringify 做转义。
   */
  private buildSwitchSceneRoleBody(params: SwitchSceneRoleParams): string {
    const parts: string[] = [];
    parts.push(`"app_id":${JSON.stringify(params.appId)}`);
    // ai_agent_instance_id 必须是裸数字，手工嵌入
    parts.push(`"ai_agent_instance_id":${params.instanceId}`);
    parts.push(`"tts":${JSON.stringify(params.tts)}`);

    if (params.lang && params.lang.length > 0) {
      parts.push(`"lang":${JSON.stringify(params.lang)}`);
    }

    return `{${parts.join(",")}}`;
  }

  /**
   * 手工拼装 interrupt 请求体 JSON 字符串。
   */
  private buildInterruptBody(params: InterruptParams): string {
    const parts: string[] = [];
    parts.push(`"app_id":${JSON.stringify(params.appId)}`);
    parts.push(`"ai_agent_instance_id":${params.instanceId}`);

    if (params.extraMsg && params.extraMsg.length > 0) {
      parts.push(`"extra_msg":${JSON.stringify(params.extraMsg)}`);
    }

    return `{${parts.join(",")}}`;
  }

  /**
   * 执行 HTTP 请求并处理响应。
   * 2xx → {ok:true}；非 2xx / 网络异常 → {ok:false, reason:"upstream_error", detail}。
   */
  private async execute(
    method: "PUT" | "POST",
    url: string,
    authorization: string,
    xBceDate: string,
    host: string,
    requestId: string,
    body: string,
    instanceId: string,
  ): Promise<BaiduAgentCallResult> {
    try {
      await axios.request({
        method,
        url,
        headers: {
          host,
          "content-type": "application/json",
          authorization,
          "x-bce-date": xBceDate,
          "x-bce-request-id": requestId,
        },
        data: body,
        timeout: this.timeoutMs,
        // data 已经是字符串，防止 axios 二次序列化
        transformRequest: [(d: string) => d],
      });

      this.logger.log(
        `BaiduAgentClient ${method} ok: cloudNode=${host}, instanceId=${instanceId}, requestId=${requestId}`,
      );

      return { ok: true };
    } catch (error) {
      const axiosError = error as AxiosError;
      const detail = this.buildFailureDetail(axiosError);

      this.logger.warn(
        `BaiduAgentClient ${method} failed: reason=upstream_error, detail=${detail}, instanceId=${instanceId}`,
      );

      return { ok: false, reason: "upstream_error", detail };
    }
  }

  /**
   * 构建失败详情：HTTP 状态码 + 百度返回体里的 code（或 message），
   * 网络异常则用 AxiosError.code。
   * 绝不包含 authorization / accessKeyId / signature。
   */
  private buildFailureDetail(error: AxiosError): string {
    const status = error?.response?.status;
    const data = error?.response?.data as Record<string, unknown> | undefined;
    const baiduCode =
      typeof data?.code === "string" && data.code.length > 0 ? data.code : null;

    if (status) {
      const suffix =
        baiduCode ??
        (typeof data?.message === "string" ? data.message : undefined);
      return suffix ? `${status} ${suffix}` : `${status}`;
    }

    return error?.code ?? "UNKNOWN";
  }
}
