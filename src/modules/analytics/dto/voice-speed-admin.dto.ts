import { ApiProperty } from "@nestjs/swagger";
import { IsNumber, Max, Min } from "class-validator";
import {
  TTS_SPD_MAX,
  TTS_SPD_MIN,
} from "@/modules/baidu-agent/baidu-agent.types";

export class UpdateVoiceSpeedDto {
  @ApiProperty({
    description: "非哄睡语速倍数，合法范围 [0.5, 2.0]（设备端协议 v1.4 §4.2）",
    minimum: TTS_SPD_MIN,
    maximum: TTS_SPD_MAX,
    example: 0.7,
  })
  @IsNumber()
  @Min(TTS_SPD_MIN)
  @Max(TTS_SPD_MAX)
  normalSpd!: number;

  @ApiProperty({
    description: "哄睡语速倍数，合法范围 [0.5, 2.0]（设备端协议 v1.4 §4.2）",
    minimum: TTS_SPD_MIN,
    maximum: TTS_SPD_MAX,
    example: 0.5,
  })
  @IsNumber()
  @Min(TTS_SPD_MIN)
  @Max(TTS_SPD_MAX)
  sleepSpd!: number;
}
