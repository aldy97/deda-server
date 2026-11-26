import { ApiProperty } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import { IsString, Matches } from "class-validator";

/** 角色 key：小写字母开头，允许数字/下划线/短横线，2–32 位 */
export const CHARACTER_KEY_PATTERN = /^[a-z][a-z0-9_-]{1,31}$/;
/** 百度 timbreId 是 Long；按十进制字符串存，避免 JS Number 精度问题 */
export const TIMBRE_ID_PATTERN = /^\d{1,19}$/;

const trim = ({ value }: { value: unknown }) =>
  typeof value === "string" ? value.trim() : value;

const trimLower = ({ value }: { value: unknown }) =>
  typeof value === "string" ? value.trim().toLowerCase() : value;

export class CreateVoiceTimbreDto {
  @ApiProperty({
    description: "IP/角色标识（归一化为小写），如 elly / polly / 未来角色",
    example: "nemo",
  })
  @Transform(trimLower)
  @IsString()
  @Matches(CHARACTER_KEY_PATTERN, {
    message: "characterKey 必须是小写字母开头、2–32 位的 a-z0-9_-",
  })
  characterKey!: string;

  @ApiProperty({
    description: "百度 timbreId（Long 的十进制字符串）",
    example: "1000957",
  })
  @Transform(trim)
  @IsString()
  @Matches(TIMBRE_ID_PATTERN, { message: "timbreId 必须是 1–19 位数字" })
  timbreId!: string;
}

export class UpdateVoiceTimbreDto {
  @ApiProperty({
    description: "百度 timbreId（Long 的十进制字符串）",
    example: "1001022",
  })
  @Transform(trim)
  @IsString()
  @Matches(TIMBRE_ID_PATTERN, { message: "timbreId 必须是 1–19 位数字" })
  timbreId!: string;
}
