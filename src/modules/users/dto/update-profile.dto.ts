import { ApiProperty } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import { IsString, Length } from "class-validator";

export class UpdateProfileDto {
  @ApiProperty({ description: "家长昵称，1-20 字（先 trim 再校验）" })
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @Length(1, 20)
  nickname: string;
}
