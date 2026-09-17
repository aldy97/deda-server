import { Controller, Get, Post, Body, Query } from "@nestjs/common";
import { ApiTags, ApiOperation } from "@nestjs/swagger";
import { MusicService } from "./music.service";
import { MusicControlDto } from "./dto/music-control.dto";
import { NeteaseBindDto } from "./dto/netease-bind.dto";

@ApiTags("音乐播放")
@Controller("music")
export class MusicController {
  constructor(private readonly musicService: MusicService) {}

  @Get("status")
  @ApiOperation({ summary: "获取当前设备正在播放的歌曲信息" })
  async status(@Query("deviceId") deviceId: string) {
    return this.musicService.getStatus(deviceId);
  }

  @Post("control")
  @ApiOperation({ summary: "开启/关闭/暂停/切换音乐、调节音量" })
  async control(@Body() dto: MusicControlDto) {
    return this.musicService.control(dto);
  }

  @Post("netease/bind")
  @ApiOperation({ summary: "绑定网易云音乐账号" })
  async bindNetease(@Body() dto: NeteaseBindDto) {
    return this.musicService.bindNetease(dto);
  }
}
