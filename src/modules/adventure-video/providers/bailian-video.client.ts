import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { VideoStudioConfig } from "@/config/video.config";
import {
  BAILIAN_REGION,
  HTTP_TRANSPORT,
  ProviderError,
  type HttpTransport,
  type VideoSubmitInput,
  type VideoTaskState,
} from "./provider.types";

/**
 * 万相 3.0 视频客户端（异步任务）。
 *
 * 两个硬事实决定了接口形状：
 * - 单次 2–30 秒，超过 30 秒必须由 worker 切段；
 * - 结果 URL 只有 24 小时，调用方必须立刻下载转存，绝不能把 URL 存库。
 *
 * 这里只管「提交/查询」，下载与存储是 AssetStore 的职责。
 */
@Injectable()
export class BailianVideoClient {
  constructor(
    @Inject(HTTP_TRANSPORT) private readonly http: HttpTransport,
    private readonly configService: ConfigService,
  ) {}

  async submit(input: VideoSubmitInput): Promise<string> {
    if (input.durationSec < 2 || input.durationSec > 30) {
      throw new ProviderError(
        "bailian-video",
        "BAD_DURATION",
        `wan3.0 单次时长必须在 2–30 秒，收到 ${input.durationSec}`,
        false,
      );
    }
    if (input.referenceImageUrls.length > 10) {
      throw new ProviderError(
        "bailian-video",
        "TOO_MANY_REFERENCES",
        "wan3.0 参考图最多 10 张",
        false,
      );
    }

    const body = {
      model: input.model,
      input: {
        prompt: input.prompt,
        ...(input.referenceImageUrls.length > 0
          ? {
              media: input.referenceImageUrls.map((url) => ({
                type: "reference_image",
                url,
              })),
            }
          : {}),
      },
      parameters: {
        resolution: input.resolution,
        ratio: input.ratio,
        duration: input.durationSec,
        audio: input.audio,
        watermark: false,
        seed: input.seed,
      },
    };

    const response = (await this.http.post(
      `${this.baseUrl()}/api/v1/services/aigc/video-generation/video-synthesis`,
      body,
      {
        Authorization: `Bearer ${this.apiKey()}`,
        "Content-Type": "application/json",
        "X-DashScope-Async": "enable",
      },
    )) as { output?: { task_id?: unknown }; request_id?: string };

    const taskId = response?.output?.task_id;
    if (typeof taskId !== "string" || !taskId) {
      throw new ProviderError(
        "bailian-video",
        "NO_TASK_ID",
        `提交视频任务未返回 task_id（request_id=${response?.request_id ?? "-"}）`,
        true,
      );
    }
    return taskId;
  }

  async poll(taskId: string): Promise<VideoTaskState> {
    const response = (await this.http.get(
      `${this.baseUrl()}/api/v1/tasks/${encodeURIComponent(taskId)}`,
    )) as {
      output?: {
        task_status?: unknown;
        video_url?: unknown;
        code?: unknown;
        message?: unknown;
      };
    };

    const status = response?.output?.task_status;
    switch (status) {
      case "PENDING":
        return { status: "pending" };
      case "RUNNING":
        return { status: "running" };
      case "SUCCEEDED": {
        const videoUrl = response?.output?.video_url;
        if (typeof videoUrl !== "string" || !videoUrl) {
          return {
            status: "failed",
            errorCode: "NO_VIDEO_URL",
            errorMessage: "任务成功但未返回 video_url",
          };
        }
        return { status: "succeeded", videoUrl };
      }
      case "FAILED":
      case "CANCELED":
      case "UNKNOWN":
        return {
          status: "failed",
          errorCode: String(response?.output?.code ?? status),
          errorMessage: String(response?.output?.message ?? status),
        };
      default:
        return {
          status: "failed",
          errorCode: "UNKNOWN_STATUS",
          errorMessage: `未知任务状态：${String(status)}`,
        };
    }
  }

  private baseUrl(): string {
    const workspaceId = this.videoConfig().bailian.workspaceId;
    if (!workspaceId) {
      throw new ProviderError(
        "bailian-video",
        "WORKSPACE_MISSING",
        "BAILIAN_WORKSPACE_ID 未配置",
        false,
      );
    }
    return `https://${workspaceId}.${BAILIAN_REGION}.maas.aliyuncs.com`;
  }

  private apiKey(): string {
    const apiKey = this.videoConfig().bailian.apiKey;
    if (!apiKey) {
      throw new ProviderError(
        "bailian-video",
        "API_KEY_MISSING",
        "BAILIAN_API_KEY 未配置",
        false,
      );
    }
    return apiKey;
  }

  private videoConfig(): VideoStudioConfig {
    const config = this.configService.get<VideoStudioConfig>("video");
    if (!config) {
      throw new ProviderError(
        "bailian-video",
        "CONFIG_MISSING",
        "video 配置未加载",
        false,
      );
    }
    return config;
  }
}
