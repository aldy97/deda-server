import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
} from "class-validator";

export class ReportPushSubscriptionDto {
  @ApiProperty({ description: "微信订阅消息模板 ID" })
  @IsString()
  @IsNotEmpty()
  templateId: string;

  @ApiProperty({
    description: "用户授权结果：accept=同意，reject=拒绝",
    enum: ["accept", "reject"],
  })
  @IsIn(["accept", "reject"])
  result: "accept" | "reject";

  @ApiPropertyOptional({
    description: "本次新增的推送额度（accept 时有效，默认 1，上限 30）",
    minimum: 1,
    maximum: 30,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(30)
  count?: number;
}
