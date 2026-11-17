import { Body, Controller, Post, Res } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import { Response } from "express";
import { DEVICE_DEFAULT_LANG } from "@/modules/baidu-agent/baidu-agent.types";
import { ClientApiService } from "./client-api.service";
import { LoginMacDto } from "./dto/login-mac.dto";
import { BotStartDto } from "./dto/bot-start.dto";
import { BotStopDto } from "./dto/bot-stop.dto";

/**
 * 机芯厂设备侧 HTTP 接口（《设备端接口文档》v1.1）。
 *
 * 设备固件直连调用，无 JWT（loginMac 以 macKey 派生密码鉴权；
 * start/stop 以「设备已上线登记」鉴权）。
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
   * 响应体 data 内可能多出一个音色字段（仅在解析成功时出现），供固件在创建
   * 百度实例时拼进 tts 配置——本轮第一句话即为目标音色，且不依赖设备签名有效期。
   */
  @Post("user/user/loginMac")
  async loginMac(
    @Body() dto: LoginMacDto,
    @Res() res: Response,
  ): Promise<void> {
    const { mac, apiKey, loginVoice } = await this.clientApi.loginMac(dto);
    res.setHeader("Authorization", apiKey);
    res.status(200).json({
      code: 200,
      data: {
        id: mac,
        nickname: `设备 ${mac.slice(-6)}`,
        lang: DEVICE_DEFAULT_LANG,
        // TODO(Q11): 字段名待机芯厂书面确认；TODO(Q14): 老固件对 data 内未知
        // 字段的容忍度待确认。因此只在解析成功时展开，默认配置下（音色目录为空、
        // 无 IP 默认音色）响应体与《设备端接口文档》3.2 节完全一致。
        ...(loginVoice ? { [loginVoice.key]: loginVoice.value } : {}),
      },
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
