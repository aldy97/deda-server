import { Body, Controller, Post, Res } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import { Response } from "express";
import { DEVICE_DEFAULT_LANG } from "@/modules/baidu-agent/baidu-agent.types";
import { ClientApiService } from "./client-api.service";
import { deviceNickname } from "./client-api.constants";
import { LoginMacDto } from "./dto/login-mac.dto";
import { BotGetValueDto } from "./dto/bot-getvalue.dto";
import { BotStartDto } from "./dto/bot-start.dto";
import { BotStopDto } from "./dto/bot-stop.dto";

/**
 * 机芯厂设备侧 HTTP 接口（《设备端接口文档》v1.4）。
 *
 * 设备固件直连调用，无 JWT（loginMac 以 macKey 派生密码鉴权；
 * getvalue/start/stop 以「设备已上线登记」鉴权，getvalue 按 v1.4 §4.1
 * 明确不携带 Authorization 头）。
 *
 * 与 llm-adapter 同理：用 @Res() 直写响应，绕过全局
 * ResponseInterceptor 的 {code:0,...} 信封——设备只认
 * HTTP 200 且 body code=200。失败路径抛 HttpException 走全局
 * HttpExceptionFilter，其错误体 {code: HTTP 状态,...} 与协议
 * 「HTTP 状态与 code 一致」兼容。
 *
 * 不进 Swagger（面向设备固件而非小程序），契约同步见
 * docs/vendor-http-onboarding.md。
 */
@ApiExcludeController()
@Controller("client")
export class ClientApiController {
  constructor(private readonly clientApi: ClientApiService) {}

  /**
   * 设备上线登记：校验成功后在响应头 Authorization 返回三方 LLM API KEY。
   *
   * 响应体与《设备端接口文档》v1.4 §3.2 一致，只有 {id, nickname}：v1.4 起
   * loginMac 只作登录用，语种参数移到 getvalue 响应体（罗浩 2026-11-18）。
   * id 与 nickname 都必须能被 getvalue 原值回传，派生规则见 deviceNickname。
   */
  @Post("user/user/loginMac")
  async loginMac(
    @Body() dto: LoginMacDto,
    @Res() res: Response,
  ): Promise<void> {
    const { mac, apiKey } = await this.clientApi.loginMac(dto);
    res.setHeader("Authorization", apiKey);
    res.status(200).json({
      code: 200,
      data: {
        id: mac,
        nickname: deviceNickname(mac),
      },
      msg: "success",
    });
  }

  /**
   * 每轮创建百度智能体实例前下发本轮 TTS 配置（《设备端接口文档》v1.4 §4）。
   *
   * 固件不缓存返回值，每轮重取；本轮配置只用于新建实例，不改正在进行的实例。
   * 任一字段缺失/类型错/越界，固件即停止本轮创建且不发 start/stop（§4.3），
   * 因此服务端配置不全时返回 500 而不是编兜底值。
   *
   * `lang` 是我方在 v1.4 三字段之外追加的扩展字段，承接从 loginMac 移出的语种
   * 参数（罗浩 2026-11-18：固件对 data 中未知参数持忽略态度，故追加是安全的）。
   * TODO(Q22): 固件是否会解析 lang、以及多语种时 DeviceConfig.language 的
   * `bilingual` 该如何映射百度 lang，均未经确认；在答复前一律返回
   * DEVICE_DEFAULT_LANG，不做任何猜测性映射。
   */
  @Post("bot/bot/getvalue")
  async botGetValue(
    @Body() dto: BotGetValueDto,
    @Res() res: Response,
  ): Promise<void> {
    const config = await this.clientApi.botGetValue(dto);
    res.status(200).json({
      code: 200,
      data: { ...config, lang: DEVICE_DEFAULT_LANG },
      msg: "success",
    });
  }

  /** 登记本轮百度智能体实例（实例创建且 RTC 连接成功后调用） */
  @Post("bot/bot/start")
  async botStart(
    @Body() dto: BotStartDto,
    @Res() res: Response,
  ): Promise<void> {
    await this.clientApi.botStart(dto);
    res.status(200).json({ code: 200 });
  }

  /** 本轮对话结束通知 */
  @Post("bot/bot/stop")
  async botStop(@Body() dto: BotStopDto, @Res() res: Response): Promise<void> {
    await this.clientApi.botStop(dto);
    res.status(200).json({ code: 200 });
  }
}
