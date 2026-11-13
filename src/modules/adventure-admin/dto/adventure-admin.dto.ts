import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsDefined,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";
import {
  ADVENTURE_CHARACTER_KEYS,
  ADVENTURE_SEASON,
  AdventureCharacterKey,
  EpisodeContentDraft,
} from "../adventure-content.types";

/**
 * 冒险内容管理台的入参外壳。
 *
 * 刻意只做「类型与外壳」校验，不校验内容本身：
 * - 内容的真相在 adventure-linter（阈值可被环境变量调整、错误带 code、报告可回显到编辑器），
 *   理由与确认文本的真相在 adventure-content.service 的 assertReason / assertConfirmText。
 * - 这里若再用 class-validator 钉一遍长度与取值，就会出现两套阈值；而且全局
 *   ValidationPipe 的通用 400 会把领域层那句「第 3 段的选择题缺少兜底话术」挤掉，
 *   管理员只能看到 "content must be an object"。
 * - 所以 content / bundle 一律 @IsObject() 原样透传，由领域层给出可执行的错误。
 *
 * 唯一在这里硬校验的是**身份**：characterKey / season / episodeNumber 决定业务键，
 * 业务键是破坏性操作 confirmText 的比对目标，拼错了就等于确认文本失效，必须早挡。
 */

/**
 * query string 的两个老坑，沿用 analytics 既有写法：
 * - `?published=` 空串视为未提供，否则 @IsBoolean() 会 400；
 * - query 里只有字符串，"false" 经 Boolean() 会变成 true，必须显式映射。
 */
function emptyToUndefined(value: unknown): unknown {
  return value === "" ? undefined : value;
}

function queryBoolean({ value }: { value: unknown }): unknown {
  const normalized = emptyToUndefined(value);
  if (normalized === undefined) return undefined;
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return normalized;
}

export class EpisodeIdentityDto {
  @ApiProperty({
    description: "IP 标识，本期只有 elly / polly",
    enum: ADVENTURE_CHARACTER_KEYS,
  })
  @IsIn(ADVENTURE_CHARACTER_KEYS as readonly string[])
  characterKey: AdventureCharacterKey;

  @ApiPropertyOptional({
    description: "季号，本期固定为 1",
    default: ADVENTURE_SEASON,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(99)
  season?: number = ADVENTURE_SEASON;

  @ApiProperty({ description: "集号，从 1 开始连续" })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(9999)
  episodeNumber: number;
}

export class EpisodeListQueryDto {
  @ApiPropertyOptional({ description: "按 IP 过滤" })
  @IsOptional()
  @Transform(({ value }) => emptyToUndefined(value))
  @IsString()
  @MaxLength(32)
  characterKey?: string;

  @ApiPropertyOptional({ description: "只看已发布 / 未发布" })
  @IsOptional()
  @Transform(queryBoolean)
  @IsBoolean()
  published?: boolean;

  @ApiPropertyOptional({ description: "是否包含已 retire 的集，缺省 false" })
  @IsOptional()
  @Transform(queryBoolean)
  @IsBoolean()
  includeRetired?: boolean;

  @ApiPropertyOptional({ description: "按标题 / 业务键搜索" })
  @IsOptional()
  @Transform(({ value }) => emptyToUndefined(value))
  @IsString()
  @MaxLength(50)
  search?: string;

  @ApiPropertyOptional({ description: "页码，缺省 1" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ description: "每页条数，缺省 50，最大 200" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  pageSize?: number;
}

export class VersionDiffQueryDto {
  @ApiProperty({ description: "左侧（旧）版本 id" })
  @Transform(({ value }) => emptyToUndefined(value))
  @IsString()
  @MaxLength(64)
  left: string;

  @ApiProperty({ description: "右侧（新）版本 id" })
  @Transform(({ value }) => emptyToUndefined(value))
  @IsString()
  @MaxLength(64)
  right: string;
}

export class AuditListQueryDto {
  @ApiPropertyOptional({ description: "只看某一集" })
  @IsOptional()
  @Transform(({ value }) => emptyToUndefined(value))
  @IsString()
  @MaxLength(64)
  episodeId?: string;

  @ApiPropertyOptional({ description: "只看某个管理员（username）" })
  @IsOptional()
  @Transform(({ value }) => emptyToUndefined(value))
  @IsString()
  @MaxLength(64)
  actorUsername?: string;

  @ApiPropertyOptional({
    description: "只看某个动作，如 publish / retire / import",
  })
  @IsOptional()
  @Transform(({ value }) => emptyToUndefined(value))
  @IsString()
  @MaxLength(32)
  action?: string;

  @ApiPropertyOptional({ description: "起始时间（含），ISO 字符串" })
  @IsOptional()
  @Transform(({ value }) => emptyToUndefined(value))
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ description: "结束时间（含），ISO 字符串" })
  @IsOptional()
  @Transform(({ value }) => emptyToUndefined(value))
  @IsDateString()
  to?: string;

  @ApiPropertyOptional({ description: "页码，缺省 1" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ description: "每页条数，缺省 50，最大 200" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  pageSize?: number;
}

/** 破坏性操作共用的三件套：理由 + 确认文本。二者都由领域层给出可执行的报错。 */
export class MutationDto {
  @ApiProperty({
    description:
      "变更理由，至少 8 个字。半年后别人（包括你自己）只能靠审计看懂当时为什么这么改。",
  })
  @IsOptional()
  @IsString()
  reason?: string;

  @ApiPropertyOptional({
    description:
      "确认文本。破坏性操作要求原样输入业务键（如 elly/1/3）或导入确认码。",
  })
  @IsOptional()
  @IsString()
  confirmText?: string;
}

export class CreateEpisodeDto {
  @ApiProperty({
    description: "身份三元组，决定业务键",
    type: EpisodeIdentityDto,
  })
  @IsDefined()
  @ValidateNested()
  @Type(() => EpisodeIdentityDto)
  identity: EpisodeIdentityDto;

  @ApiProperty({
    description:
      "内容草稿 {title, recap?, segments[]}；segments 每段 " +
      "{order, kind: narration|interaction, text, interactionType?, options?, fallbackText?, exitText?, rewardStar?}",
  })
  @IsDefined()
  @IsObject()
  content: EpisodeContentDraft;

  @ApiProperty({ description: "创建理由，至少 8 个字" })
  @IsOptional()
  @IsString()
  reason?: string;
}

export class SaveDraftDto {
  @ApiProperty({ description: "内容草稿，形状同创建" })
  @IsDefined()
  @IsObject()
  content: EpisodeContentDraft;

  @ApiProperty({ description: "改动理由，至少 8 个字" })
  @IsOptional()
  @IsString()
  reason?: string;

  @ApiPropertyOptional({
    description:
      "乐观锁基线：把 GET /episodes/:id 返回的 baseVersionId 原样带回来。" +
      "别人已经改过草稿时会返回 409 DRAFT_CONFLICT，而不是静默覆盖。",
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  baseVersionId?: string;

  @ApiPropertyOptional({
    description: "明知有人在改也要覆盖（UI 上是单独的红色按钮）",
  })
  @IsOptional()
  @IsBoolean()
  force?: boolean;
}

export class PublishDto {
  @ApiProperty({ description: "发布理由，至少 8 个字" })
  @IsOptional()
  @IsString()
  reason?: string;
}

export class RevertDto {
  @ApiProperty({
    description: "要回到的目标版本 id，必须是 published / superseded 快照",
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  targetVersionId?: string;

  @ApiProperty({ description: "回滚理由，至少 8 个字" })
  @IsOptional()
  @IsString()
  reason?: string;

  @ApiProperty({ description: "确认文本，原样输入业务键（如 elly/1/3）" })
  @IsOptional()
  @IsString()
  confirmText?: string;
}

export class LintDto {
  @ApiPropertyOptional({ description: "已有集的 id；新建时留空" })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  episodeId?: string;

  @ApiPropertyOptional({
    description: "身份三元组。编辑已有集时可省略（服务端用库里的身份）",
    type: EpisodeIdentityDto,
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => EpisodeIdentityDto)
  identity?: EpisodeIdentityDto;

  @ApiProperty({ description: "待校验的内容草稿" })
  @IsDefined()
  @IsObject()
  content: EpisodeContentDraft;

  @ApiPropertyOptional({
    description: "按「即将发布」的标准校验（额外要求前置集都已发布）",
  })
  @IsOptional()
  @IsBoolean()
  forPublish?: boolean;
}

export class SimulateDto {
  @ApiProperty({ description: "身份三元组", type: EpisodeIdentityDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => EpisodeIdentityDto)
  identity: EpisodeIdentityDto;

  @ApiProperty({ description: "待试播的内容草稿" })
  @IsDefined()
  @IsObject()
  content: EpisodeContentDraft;
}

export class ExportDto {
  @ApiPropertyOptional({
    description: "指定要导出的集；给了就只导这些",
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  episodeIds?: string[];

  @ApiPropertyOptional({ description: "不指定 id 时按 IP 全导" })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  characterKey?: string;

  @ApiPropertyOptional({ description: "是否包含已 retire 的集，缺省 false" })
  @IsOptional()
  @IsBoolean()
  includeRetired?: boolean;
}

export class ImportPreviewDto {
  @ApiProperty({
    description:
      "导出的 bundle 原文 {bundleSchemaVersion, exportedAt?, sourceProfile?, episodes[]}。" +
      "预览只算差异，不写库。",
  })
  @IsDefined()
  @IsObject()
  bundle: Record<string, unknown>;
}

export class ImportApplyDto {
  @ApiProperty({ description: "要导入的 bundle 原文" })
  @IsDefined()
  @IsObject()
  bundle: Record<string, unknown>;

  @ApiProperty({ description: "导入理由，至少 8 个字" })
  @IsOptional()
  @IsString()
  reason?: string;

  @ApiProperty({ description: "确认码，原样输入预览返回的 confirmToken" })
  @IsOptional()
  @IsString()
  confirmText?: string;

  @ApiPropertyOptional({
    description:
      "预览时拿到的 bundleHash。给了就必须与服务端重新算出的一致，" +
      "防止「预览的是 A、提交的是 B」。",
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  expectedBundleHash?: string;
}
