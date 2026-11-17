import { BadRequestException } from "@nestjs/common";
import {
  TTS_SPD_MAX,
  TTS_SPD_MIN,
  TTS_TYPE_DEFAULT,
} from "./baidu-agent.types";

/**
 * 组装百度云 TTS 配置串。
 *
 * 格式：`{TTS_TYPE_DEFAULT}{JSON字符串}`，例 `DEFAULT{"vcn":"1000063","spd":0.8}`。
 * 只用 vcn 与 spd，不带 vol（音量已有 MQTT volume 通道，两个通道会打架）。
 *
 * @param input.vcn 发音人 id，必填，非空字符串
 * @param input.spd 音速倍数，可选，必须在 [TTS_SPD_MIN, TTS_SPD_MAX] 闭区间内
 * @returns 组装好的 TTS 配置串
 * @throws BadRequestException vcn 为空或 spd 越界
 *
 * @see https://cloud.baidu.com/doc/RTC/s/hm8zjic1q
 */
export function buildTtsConfig(input: { vcn: string; spd?: number }): string {
  const vcn = input.vcn.trim();
  if (vcn.length === 0) {
    throw new BadRequestException("vcn must be a non-empty string");
  }

  if (input.spd !== undefined) {
    if (!Number.isFinite(input.spd)) {
      throw new BadRequestException(
        `spd must be a finite number in [${TTS_SPD_MIN}, ${TTS_SPD_MAX}]`,
      );
    }
    if (input.spd < TTS_SPD_MIN || input.spd > TTS_SPD_MAX) {
      throw new BadRequestException(
        `spd must be in [${TTS_SPD_MIN}, ${TTS_SPD_MAX}], got ${input.spd}`,
      );
    }
  }

  const inner: { vcn: string; spd?: number } = { vcn };
  if (input.spd !== undefined) {
    inner.spd = input.spd;
  }

  return `${TTS_TYPE_DEFAULT}${JSON.stringify(inner)}`;
}
