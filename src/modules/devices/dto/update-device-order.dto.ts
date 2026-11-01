import { ApiProperty } from "@nestjs/swagger";
import {
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsNotEmpty,
  IsString,
  Matches,
} from "class-validator";

export class UpdateDeviceOrderDto {
  @ApiProperty({
    type: [String],
    minItems: 1,
    uniqueItems: true,
    description: "当前用户全部设备的业务 deviceId，按期望显示顺序排列",
    example: ["dev-002", "dev-001"],
  })
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  @Matches(/\S/, { each: true })
  @ArrayUnique()
  orderedDeviceIds: string[];
}
