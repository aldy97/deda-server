import { Module } from "@nestjs/common";
import { MusicController } from "./music.controller";
import { MusicService } from "./music.service";

@Module({
  controllers: [MusicController],
  providers: [MusicService],
  exports: [MusicService],
})
export class MusicModule {}
