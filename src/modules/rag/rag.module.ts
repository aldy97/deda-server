import { Module } from '@nestjs/common';
import { RagService } from './rag.service';
import { PrismaModule } from '@/common/prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  providers: [RagService],
  exports: [RagService],
})
export class RagModule {}
