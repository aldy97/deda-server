import axios from "axios";
import { ProviderError, type HttpTransport } from "./provider.types";

/**
 * 唯一的 HTTP 出口。所有错误统一包成 ProviderError，并**只保留状态码与
 * 上游 message**——绝不把 Authorization 或完整响应体写进日志。
 */
export class AxiosTransport implements HttpTransport {
  constructor(private readonly timeoutMs = 60_000) {}

  async post(
    url: string,
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<unknown> {
    try {
      const response = await axios.post(url, body, {
        headers,
        timeout: this.timeoutMs,
      });
      return response.data;
    } catch (error) {
      throw toProviderError("bailian", error);
    }
  }

  async get(url: string): Promise<unknown> {
    try {
      const response = await axios.get(url, { timeout: this.timeoutMs });
      return response.data;
    } catch (error) {
      throw toProviderError("bailian", error);
    }
  }

  async getBuffer(url: string): Promise<Buffer> {
    try {
      const response = await axios.get<ArrayBuffer>(url, {
        responseType: "arraybuffer",
        timeout: this.timeoutMs,
      });
      return Buffer.from(response.data);
    } catch (error) {
      throw toProviderError("bailian", error);
    }
  }
}

function toProviderError(provider: string, error: unknown): ProviderError {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    const data = error.response?.data as
      | { message?: string; code?: string; error?: { message?: string } }
      | undefined;
    const message =
      data?.message ??
      data?.error?.message ??
      error.message ??
      "upstream error";
    const code = data?.code ?? (status ? `HTTP_${status}` : "NETWORK_ERROR");
    const retryable = !status || status >= 500 || status === 429;
    return new ProviderError(
      provider,
      String(code),
      String(message),
      retryable,
    );
  }
  return new ProviderError(
    provider,
    "UNKNOWN",
    error instanceof Error ? error.message : String(error),
    true,
  );
}
