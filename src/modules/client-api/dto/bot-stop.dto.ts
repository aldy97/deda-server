import { IsNotEmpty, IsString, Matches } from "class-validator";

/** 智能体退下通知（机芯厂《设备端接口文档》5.1 节） */
export class BotStopDto {
  /** 设备 MAC */
  @IsString()
  @IsNotEmpty()
  mac: string;

  /** 要结束的本轮实例 ID，与 start 登记一致，十进制字符串 */
  @IsString()
  @Matches(/^\d{1,19}$/, {
    message: "instanceid must be a positive int64 decimal string",
  })
  instanceid: string;
}
