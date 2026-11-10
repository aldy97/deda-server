import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from "class-validator";

/**
 * 智能体实例登记（机芯厂《设备端接口文档》4.1 节）。
 * authorization 为设备为本轮百度实例准备的控制鉴权信息，
 * 服务端保存后用于调用百度控制接口；不回显、不落日志。
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

  /** 本轮百度实例控制鉴权信息（ASCII，最多 8192 字节） */
  @IsString()
  @MaxLength(8192)
  authorization: string;

  /** 云节点：cn（默认）/ overseas / euUs */
  @IsOptional()
  @IsIn(["cn", "overseas", "euUs"])
  cloud_node?: string;

  /** 创建实例时实际语种，默认 zh */
  @IsOptional()
  @IsString()
  lang?: string;
}
