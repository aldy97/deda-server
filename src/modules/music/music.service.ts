import { Injectable } from "@nestjs/common";
import { MusicControlDto } from "./dto/music-control.dto";
import { NeteaseBindDto } from "./dto/netease-bind.dto";

/**
 * 音乐播放与网易云绑定服务
 * 实际播放由机芯厂设备执行，我方负责状态同步与账号绑定。
 */
@Injectable()
export class MusicService {
  async getStatus(deviceId: string) {
    // TODO: 查询厂商当前播放状态并缓存
    return {
      deviceId,
      playing: false,
      song: null,
      volume: 50,
      source: "netease",
    };
  }

  async control(dto: MusicControlDto) {
    // TODO: 调用 manufacturer service 转发音乐控制指令
    return { success: true, deviceId: dto.deviceId, action: dto.action };
  }

  async bindNetease(dto: NeteaseBindDto) {
    // TODO: 换取网易云长期 Token 并加密存储
    return {
      success: true,
      deviceId: dto.deviceId,
      bound: true,
      neteaseUserId: dto.neteaseUserId || null,
    };
  }
}
