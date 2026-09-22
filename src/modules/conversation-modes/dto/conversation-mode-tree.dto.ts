import { ApiProperty } from '@nestjs/swagger';
import { ConversationModeCategoryDto } from './conversation-mode-category.dto';
import { ConversationModeDto } from './conversation-mode.dto';

export class ConversationModeTreeDto extends ConversationModeCategoryDto {
  @ApiProperty({ description: '该分类下的子模式列表', type: [ConversationModeDto] })
  modes: ConversationModeDto[];
}
