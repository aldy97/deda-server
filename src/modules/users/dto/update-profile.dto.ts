import { ApiPropertyOptional } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import { IsIn, IsOptional, IsString, Length } from "class-validator";
import { IsBirthday } from "./is-birthday.validator";

export class UpdateProfileDto {
  @ApiPropertyOptional({ description: "家长昵称，1-20 字（先 trim 再校验）" })
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsOptional()
  @IsString()
  @Length(1, 20)
  nickname?: string;

  @ApiPropertyOptional({
    description: "家长性别；null 表示清空",
    enum: ["male", "female"],
    nullable: true,
  })
  @IsOptional()
  @IsIn(["male", "female"])
  gender?: "male" | "female" | null;

  @ApiPropertyOptional({
    description: "家长生日 YYYY-MM-DD；null 表示清空",
    nullable: true,
  })
  @IsOptional()
  @IsBirthday()
  birthday?: string | null;
}
