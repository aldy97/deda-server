import { Transform } from "class-transformer";
import { IsOptional, IsString, Matches, ValidateIf } from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class CreateFeedbackDto {
  @ApiProperty({ description: "问题或建议", maxLength: 200 })
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString({ message: "问题或建议不能为空" })
  content!: string;

  @ApiPropertyOptional({ description: "联系手机号", pattern: "^1[3-9]\\d{9}$" })
  @Transform(({ value }) => {
    if (value === null || value === undefined) return null;
    if (typeof value === "string" && value.trim() === "") return null;
    return typeof value === "string" ? value.trim() : value;
  })
  @ValidateIf((_object, value) => value !== null && value !== undefined)
  @IsString({ message: "联系手机号格式不正确" })
  @Matches(/^1[3-9]\d{9}$/, { message: "联系手机号格式不正确" })
  contact?: string | null;

  // 仅用于兼容并忽略客户端时间；不会传入 Prisma 或 Swagger 请求契约。
  @IsOptional()
  createdAt?: unknown;
}
