import { ConfigService } from "@nestjs/config";
import { BailianVideoClient } from "./bailian-video.client";
import { ProviderError } from "./provider.types";
import { resolveVideoStudioConfig } from "@/config/video.config";

function makeClient(overrides: { apiKey?: string; workspaceId?: string } = {}) {
  const base = resolveVideoStudioConfig(() => undefined);
  const config = {
    get: jest.fn(() => ({
      ...base,
      bailian: {
        apiKey: overrides.apiKey ?? "sk-test",
        workspaceId: overrides.workspaceId ?? "ws-test",
      },
    })),
  } as unknown as ConfigService;
  const http = {
    post: jest.fn(),
    get: jest.fn(),
    getBuffer: jest.fn(),
  };
  return {
    client: new BailianVideoClient(http as never, config),
    http,
  };
}

const INPUT = {
  model: "wan3.0-video",
  prompt: "多镜头：小象在湖边",
  referenceImageUrls: ["https://oss/elly.jpg", "https://oss/polly.jpg"],
  resolution: "720P",
  ratio: "9:16",
  durationSec: 30,
  seed: 42,
  audio: false,
};

describe("BailianVideoClient", () => {
  it("提交：URL/鉴权/异步头/参数逐项正确", async () => {
    const { client, http } = makeClient();
    http.post.mockResolvedValue({ output: { task_id: "task-1" } });

    const taskId = await client.submit(INPUT);

    expect(taskId).toBe("task-1");
    const [url, body, headers] = http.post.mock.calls[0];
    expect(url).toBe(
      "https://ws-test.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis",
    );
    expect(headers).toEqual({
      Authorization: "Bearer sk-test",
      "Content-Type": "application/json",
      "X-DashScope-Async": "enable",
    });
    expect(body).toEqual({
      model: "wan3.0-video",
      input: {
        prompt: "多镜头：小象在湖边",
        media: [
          { type: "reference_image", url: "https://oss/elly.jpg" },
          { type: "reference_image", url: "https://oss/polly.jpg" },
        ],
      },
      parameters: {
        resolution: "720P",
        ratio: "9:16",
        duration: 30,
        audio: false,
        watermark: false,
        seed: 42,
      },
    });
  });

  it("无参考图时不传 media 字段", async () => {
    const { client, http } = makeClient();
    http.post.mockResolvedValue({ output: { task_id: "t" } });
    await client.submit({ ...INPUT, referenceImageUrls: [] });
    expect(http.post.mock.calls[0][1].input).toEqual({
      prompt: "多镜头：小象在湖边",
    });
  });

  it("时长/参考图越界在本地就挡住，不打上游", async () => {
    const { client, http } = makeClient();
    await expect(
      client.submit({ ...INPUT, durationSec: 31 }),
    ).rejects.toBeInstanceOf(ProviderError);
    await expect(
      client.submit({
        ...INPUT,
        referenceImageUrls: Array.from({ length: 11 }, (_, i) => `u${i}`),
      }),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(http.post).not.toHaveBeenCalled();
  });

  it("缺 workspace / api key 时明确报配置错", async () => {
    const missingWorkspace = makeClient({ workspaceId: "" });
    await expect(missingWorkspace.client.submit(INPUT)).rejects.toMatchObject({
      code: "WORKSPACE_MISSING",
    });
    const missingKey = makeClient({ apiKey: "" });
    await expect(missingKey.client.submit(INPUT)).rejects.toMatchObject({
      code: "API_KEY_MISSING",
    });
  });

  it("查询：状态映射完整，成功必须带 URL", async () => {
    const { client, http } = makeClient();
    http.get.mockResolvedValueOnce({ output: { task_status: "PENDING" } });
    await expect(client.poll("t1")).resolves.toEqual({ status: "pending" });
    http.get.mockResolvedValueOnce({ output: { task_status: "RUNNING" } });
    await expect(client.poll("t1")).resolves.toEqual({ status: "running" });
    http.get.mockResolvedValueOnce({
      output: { task_status: "SUCCEEDED", video_url: "https://oss/v.mp4" },
    });
    await expect(client.poll("t1")).resolves.toEqual({
      status: "succeeded",
      videoUrl: "https://oss/v.mp4",
    });
    http.get.mockResolvedValueOnce({
      output: { task_status: "FAILED", code: "E1", message: "boom" },
    });
    await expect(client.poll("t1")).resolves.toEqual({
      status: "failed",
      errorCode: "E1",
      errorMessage: "boom",
    });
    http.get.mockResolvedValueOnce({ output: { task_status: "WHATEVER" } });
    await expect(client.poll("t1")).resolves.toMatchObject({
      status: "failed",
      errorCode: "UNKNOWN_STATUS",
    });
  });

  it("任务成功但没有 video_url 视为失败，避免下游拿到 undefined", async () => {
    const { client, http } = makeClient();
    http.get.mockResolvedValueOnce({ output: { task_status: "SUCCEEDED" } });
    await expect(client.poll("t1")).resolves.toMatchObject({
      status: "failed",
      errorCode: "NO_VIDEO_URL",
    });
  });
});
