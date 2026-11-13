import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from "class-validator";

/**
 * 智能体实例登记（机芯厂《设备端接口文档》4.1 节 v1.2）。
 *
 * v1.2 起设备必须同时上报两份用途不同的 BCE 签名：
 * - authorization_Role: 切换角色、人设或音色
 *   （PUT /api/v1/aiagent/instances/operation?switchSceneRole=）
 * - authorization_TTS: interrupt 打断播报
 *   （POST /api/v1/aiagent/interrupt）
 *
 * v1.1 的单 authorization 作为可选字段保留以兼容老固件；
 * 服务端不将任一签名写入日志、不回显到 HTTP 响应体。
 */
export class BotStartDto {
  /** 设备 MAC，与上线登记一致 */
  @IsString()
  @IsNotEmpty()
  mac: string;

  /** 本轮百度应用 ID（最长 100 字节） */
  @IsString()
  @MaxLength(100)
  appid: string;

  /** 百度 ai_agent_instance_id，正的有符号 64 位整数的十进制字符串 */
  @IsString()
  @Matches(/^\d{1,19}$/, {
    message: "instanceid must be a positive int64 decimal string",
  })
  instanceid: string;

  /**
   * v1.1 兼容：本轮百度实例控制鉴权信息（ASCII，最多 8192 字节）。
   * v1.2 固件不再发送此字段，仅老固件使用。
   */
  @IsOptional()
  @IsString()
  @MaxLength(8192)
  authorization?: string;

  /** 切换角色、人设或音色的 BCE 签名（ASCII，最多 8192 字节） */
  @IsString()
  @MaxLength(8192)
  authorization_Role: string;

  /** interrupt 打断播报的 BCE 签名（ASCII，最多 8192 字节） */
  @IsString()
  @MaxLength(8192)
  authorization_TTS: string;

  /** 云节点：cn（默认）/ overseas / euUs */
  @IsOptional()
  @IsIn(["cn", "overseas", "euUs"])
  cloud_node?: string;

  /** 创建实例时实际语种，默认 zh */
  @IsOptional()
  @IsString()
  lang?: string;
}
