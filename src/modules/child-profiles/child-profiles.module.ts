import { Module } from '@nestjs/common';
import { ChildProfilesController } from './child-profiles.controller';
import { ChildProfilesService } from './child-profiles.service';

@Module({
  controllers: [ChildProfilesController],
  providers: [ChildProfilesService],
  exports: [ChildProfilesService],
})
export class ChildProfilesModule {}
