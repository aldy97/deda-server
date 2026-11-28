import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from "class-validator";

/**
 * 入参只做外壳校验。理由长度、版本归属、预算这些**领域规则**一律在
 * adventure-video.service 里判，错误带 code，前端才能给出可操作提示；
 * 若在 DTO 再钉一遍，就会出现两套阈值与两句不同的错误文案。
 */

export const VIDEO_RESOLUTIONS = ["480P", "720P", "1080P"] as const;
export type VideoResolution = (typeof VIDEO_RESOLUTIONS)[number];

export const VIDEO_ASPECTS = ["9:16"] as const;
export type VideoAspect = (typeof VIDEO_ASPECTS)[number];

export class CreateVideoJobDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  episodeId!: string;

  @ApiProperty({ description: "必须等于该集当前发布版本 id" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  episodeVersionId!: string;

  @ApiProperty({
    description:
      "前端打开确认弹窗时生成的幂等键；重复点击返回同一 job，主动重新生成请换新值",
  })
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{8,64}$/, {
    message: "requestId 只能是 8–64 位字母、数字、下划线或短横线",
  })
  requestId!: string;

  @ApiPropertyOptional({ enum: VIDEO_RESOLUTIONS })
  @IsOptional()
  @IsIn(VIDEO_RESOLUTIONS)
  resolution?: VideoResolution;

  @ApiPropertyOptional({ enum: VIDEO_ASPECTS })
  @IsOptional()
  @IsIn(VIDEO_ASPECTS)
  aspect?: VideoAspect;

  @ApiPropertyOptional({
    description: "变更理由，至少 8 个字；与内容管理台同一口径",
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class VideoJobQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  episodeId?: string;

  @ApiPropertyOptional({
    description: "queued / running / succeeded / failed / canceled",
  })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  status?: string;

  @ApiPropertyOptional({ default: 20, maximum: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}

export class VideoJobActionDto {
  @ApiPropertyOptional({ description: "变更理由，至少 8 个字" })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

/** 分镜编辑稿：只收可编辑字段，结构锁定由 service 校验并回填。 */
export class StoryboardValidateDto {
  @ApiProperty({
    description:
      "分镜编辑稿：stylePrompt + beats（文案/画面/情绪/optional 可改）",
    type: Object,
  })
  @IsObject()
  storyboard!: Record<string, unknown>;
}

export class StoryboardDraftDto extends StoryboardValidateDto {
  @ApiProperty({ description: "客户端读到的 storyboardRevision，乐观锁" })
  @IsInt()
  @Min(0)
  expectedRevision!: number;

  @ApiPropertyOptional({ description: "编辑理由，可写进内容审计" })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class StoryboardRevoiceDto {
  @ApiProperty({ description: "客户端读到的 storyboardRevision，乐观锁" })
  @IsInt()
  @Min(0)
  expectedRevision!: number;

  @ApiProperty({ description: "变更理由，至少 8 个字" })
  @IsString()
  @MaxLength(500)
  reason!: string;
}

export class ApproveStoryboardDto extends StoryboardRevoiceDto {}
