import { IsDefined, IsNotEmpty, IsString, MaxLength } from "class-validator";

/**
 * 智能体创建前获取本轮 TTS 配置（机芯厂《设备端接口文档》v1.4 §4.1）。
 *
 * 固件每轮创建百度实例前调用一次，且不缓存返回值；本轮配置只用于新建实例，
 * 不改正在进行的实例。请求头不带 Authorization——v1.4 明确本接口不使用三方
 * LLM API KEY 鉴权，设备身份由 `id` 承载（该 id 来自一次成功的 loginMac）。
 *
 * 两个字段都要求是最近一次成功 loginMac 响应 data 的原值。
 */
export class BotGetValueDto {
  /**
   * loginMac 响应 `data.id` 的原值。v1.4 §4.1 要求「不与 MAC 混用」，指的是
   * 固件不得自行用 MAC 拼造 id；我方 loginMac 返回的 id 就是归一化 MAC，
   * 固件原值回传即可，服务端按同一套规则归一化后定位设备。
   */
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  id: string;

  /**
   * loginMac 响应 `data.nickname` 的原值。v1.4 §4.1：仅透传，不参与固件本地
   * 业务判断。
   *
   * 刻意用 @IsDefined() 而不是 @IsNotEmpty()：v1.4 §4.1 把 nickname 列为必填，
   * 字段整个缺失按 400 拒绝是对的；但它是纯展示字段，服务端不依赖它定位设备，
   * 空串按「与派生值不一致」记 warn 而不是 400——v1.4 §4.3 下任何非 200 都会让
   * 设备停止本轮创建，为一个装饰性字段拒答等于自造故障。
   */
  @IsDefined()
  @IsString()
  @MaxLength(128)
  nickname: string;
}
