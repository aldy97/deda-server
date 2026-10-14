import { ApiProperty } from "@nestjs/swagger";
import {
  IsString,
  IsNotEmpty,
  IsNumber,
  IsBoolean,
  IsIn,
} from "class-validator";

/**
 * 流式回复 chunk（WS 事件 vendor:text:chunk）
 * 一轮对话内 seq 全局递增：先发完小模型 filler（首响打哈哈），
 * 再发大模型 answer；机芯厂按 seq 顺序喂 TTS 即可保证顺序对齐。
 * 每个阶段以 isFinal=true 的空 delta chunk 收尾。
 */
export class VendorTextChunkDto {
  @ApiProperty({ description: "设备唯一标识" })
  @IsString()
  @IsNotEmpty()
  deviceId: string;

  @ApiProperty({ description: "本轮对话 ID，与同轮 vendor:text:out 一致" })
  @IsString()
  @IsNotEmpty()
  turnId: string;

  @ApiProperty({ description: "轮内全局递增序号，从 0 开始" })
  @IsNumber()
  seq: number;

  @ApiProperty({
    description: "chunk 来源：filler=小模型首响，answer=大模型正式回答",
    enum: ["filler", "answer"],
  })
  @IsIn(["filler", "answer"])
  source: "filler" | "answer";

  @ApiProperty({ description: "增量文字；isFinal=true 时为空串" })
  @IsString()
  delta: string;

  @ApiProperty({ description: "该来源（filler/answer）是否已结束" })
  @IsBoolean()
  isFinal: boolean;
}
