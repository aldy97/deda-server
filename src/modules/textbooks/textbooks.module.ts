import { Module } from '@nestjs/common';
import { TextbooksController } from './textbooks.controller';
import { TextbooksService } from './textbooks.service';

@Module({
  controllers: [TextbooksController],
  providers: [TextbooksService],
  exports: [TextbooksService],
})
export class TextbooksModule {}
