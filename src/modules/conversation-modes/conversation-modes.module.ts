import { Module } from '@nestjs/common';
import { ConversationModesService } from './conversation-modes.service';
import { ConversationModesController } from './conversation-modes.controller';
import { PrismaModule } from '@/common/prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [ConversationModesController],
  providers: [ConversationModesService],
  exports: [ConversationModesService],
})
export class ConversationModesModule {}
