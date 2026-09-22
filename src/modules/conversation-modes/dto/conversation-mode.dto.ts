import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ConversationModeDto {
  @ApiProperty({ description: '模式 ID' })
  id: string;

  @ApiProperty({ description: '所属分类 ID' })
  categoryId: string;

  @ApiProperty({ description: '业务键' })
  key: string;

  @ApiProperty({ description: '展示名称' })
  name: string;

  @ApiPropertyOptional({ description: '描述' })
  description?: string | null;

  @ApiProperty({ description: '排序' })
  sortOrder: number;

  @ApiProperty({ description: '是否启用' })
  isActive: boolean;

  @ApiPropertyOptional({ description: '前端配置 schema' })
  configSchema?: Record<string, unknown> | null;

  @ApiPropertyOptional({ description: '提示词模板' })
  promptTemplate?: string | null;
}
