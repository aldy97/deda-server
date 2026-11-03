import { IsBoolean, IsIn, IsInt, IsOptional, Matches } from "class-validator";
import { ApiPropertyOptional } from "@nestjs/swagger";

export class UpdateSleepConfigDto {
  @ApiPropertyOptional({ description: "哄睡总开关" })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({
    description: "哄睡时长模式：default=默认（后端决定时长），custom=手动设置",
    enum: ["default", "custom"],
  })
  @IsOptional()
  @IsIn(["default", "custom"])
  durationMode?: "default" | "custom";

  @ApiPropertyOptional({
    description:
      "手动设置的哄睡时长（分钟）。durationMode=custom 时必填，取值 10/15/20/25/30；default 时忽略",
    enum: [10, 15, 20, 25, 30],
    nullable: true,
  })
  @IsOptional()
  @IsInt()
  @IsIn([10, 15, 20, 25, 30])
  durationMinutes?: number | null;

  @ApiPropertyOptional({
    description: "哄睡内容类型",
    enum: ["story", "song", "mixed"],
  })
  @IsOptional()
  @IsIn(["story", "song", "mixed"])
  contentType?: "story" | "song" | "mixed";

  @ApiPropertyOptional({
    description: '每晚定时进入时间，24h 制 "HH:mm"，如 "21:30"',
    pattern: "^([01]\\d|2[0-3]):[0-5]\\d$",
  })
  @IsOptional()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, {
    message: "sleepTime must be in HH:mm format (00:00-23:59)",
  })
  sleepTime?: string;

  @ApiPropertyOptional({ description: "强制哄睡开关" })
  @IsOptional()
  @IsBoolean()
  forceSleep?: boolean;
}
