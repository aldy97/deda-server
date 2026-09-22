import { Module } from '@nestjs/common';
import { TextbooksController } from './textbooks.controller';
import { AdminTextbooksController } from './admin-textbooks.controller';
import { TextbooksService } from './textbooks.service';
import { TextbookImportService } from './textbook-import.service';

@Module({
  controllers: [TextbooksController, AdminTextbooksController],
  providers: [TextbooksService, TextbookImportService],
  exports: [TextbooksService, TextbookImportService],
})
export class TextbooksModule {}
