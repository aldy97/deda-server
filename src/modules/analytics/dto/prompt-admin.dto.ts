import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from "class-validator";
import { PROMPT_CONTENT_MAX_CHARS } from "@/modules/prompt-registry/prompt-defaults";

/** 变更说明长度上限：够写清「为什么改」，不至于变成正文 */
export const CHANGE_NOTE_MAX_CHARS = 500;

/**
 * 保存草稿。
 *
 * expectedRevision 是乐观锁：客户端读取详情时拿到的 draftRevision（无草稿时为 0），
 * 与服务端当前 draftRevision 不一致即 409——防止两个 admin 同时编辑互相覆盖。
 */
export class SavePromptDraftDto {
  @ApiProperty({
    description: "模板正文（未渲染，含 {{变量}} 占位符）",
    maxLength: PROMPT_CONTENT_MAX_CHARS,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(PROMPT_CONTENT_MAX_CHARS)
  content: string;

  @ApiProperty({
    description: "当前草稿版本号；无草稿时传 0。与服务端不一致返回 409",
    minimum: 0,
  })
  @IsInt()
  @Min(0)
  expectedRevision: number;

  @ApiPropertyOptional({
    description: "改动说明",
    maxLength: CHANGE_NOTE_MAX_CHARS,
  })
  @IsOptional()
  @IsString()
  @MaxLength(CHANGE_NOTE_MAX_CHARS)
  changeNote?: string;
}

/**
 * 发布草稿。
 *
 * confirmCode 在服务端用 timingSafeEqual 校验，绝不只靠前端拦截：
 * 前端可被绕过，而发布直接改变线上所有设备的模型行为。
 */
export class PublishPromptDto {
  @ApiProperty({
    description: "要发布的草稿版本号，必须等于当前 draftRevision",
  })
  @IsInt()
  @Min(1)
  revision: number;

  @ApiProperty({ description: "发布说明（写入版本审计链，必填）" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(CHANGE_NOTE_MAX_CHARS)
  changeNote: string;

  @ApiProperty({ description: "确认码，服务端校验" })
  @IsString()
  @IsNotEmpty()
  confirmCode: string;
}

/**
 * 回滚到历史版本。
 *
 * 语义等同 git revert：以目标版本的正文**新建一个 revision** 并直接发布，
 * 历史版本号永不复用、永不删除，审计链保持单调递增。
 */
export class RollbackPromptDto {
  @ApiProperty({ description: "目标历史版本号" })
  @IsInt()
  @Min(1)
  targetRevision: number;

  @ApiProperty({ description: "回滚原因（写入版本审计链，必填）" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(CHANGE_NOTE_MAX_CHARS)
  changeNote: string;

  @ApiProperty({ description: "确认码，服务端校验" })
  @IsString()
  @IsNotEmpty()
  confirmCode: string;
}

/**
 * 恢复代码默认值。
 *
 * 不是「删掉 DB 行」：key 被代码引用，删行只会静默回落默认值，
 * 制造「以为改了其实没改」的错觉。这里以代码默认正文新建 revision 并发布，
 * 审计链上留下明确的「谁在什么时候把它恢复成了默认」。
 */
export class ResetPromptToDefaultDto {
  @ApiProperty({ description: "恢复原因（写入版本审计链，必填）" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(CHANGE_NOTE_MAX_CHARS)
  changeNote: string;

  @ApiProperty({ description: "确认码，服务端校验" })
  @IsString()
  @IsNotEmpty()
  confirmCode: string;
}
