import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ConversationModeCategoryDto {
  @ApiProperty({ description: '分类 ID' })
  id: string;

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
}
