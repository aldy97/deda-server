import { Test } from "@nestjs/testing";
import { VideoWorkerModule } from "./video-worker.module";
import { AdventureVideoWorkerService } from "@/modules/adventure-video/worker/adventure-video-worker.service";
import { OssAssetStore } from "@/modules/adventure-video/storage/oss-asset-store";
import { FfmpegMediaAssembler } from "@/modules/adventure-video/assembly/ffmpeg-media.assembler";
import {
  ASSET_STORE,
  MEDIA_ASSEMBLER,
} from "@/modules/adventure-video/ports/media.ports";

/**
 * 依赖装配冒烟：worker 模块最容易犯的错是「服务在 A 模块提供、token 没 export」，
 * 单元测试全绿、真起容器才炸。这里直接编译整个模块图。
 */
describe("VideoWorkerModule 依赖装配", () => {
  it("能编译出 worker 与两个端口实现", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [VideoWorkerModule],
    }).compile();

    expect(moduleRef.get(AdventureVideoWorkerService)).toBeInstanceOf(
      AdventureVideoWorkerService,
    );
    expect(moduleRef.get(ASSET_STORE)).toBeInstanceOf(OssAssetStore);
    expect(moduleRef.get(MEDIA_ASSEMBLER)).toBeInstanceOf(FfmpegMediaAssembler);

    await moduleRef.close();
  });
});
