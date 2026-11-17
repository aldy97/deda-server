import {
  BadRequestException,
  Controller,
  Logger,
  Post,
  Req,
  Res,
  UseFilters,
} from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import { randomUUID } from "crypto";
import { Request, Response } from "express";
import { ADVENTURE_DEGRADED_REPLIES } from "@/modules/adventure/adventure.constants";
import { LlmAdapterService } from "./llm-adapter.service";
import { parseChatCompletionRequest } from "./dto/chat-completion.dto";
import { OpenAiExceptionFilter } from "./filters/openai-exception.filter";

/**
 * 百度 RTC 第三方 LLM 接入端点（OpenAI 兼容）。
 *
 * 刻意不走 DTO + 全局 ValidationPipe（forbidNonWhitelisted 会拒绝
 * llm_eb 注入的扩展字段），也不进 Swagger（面向百度而非小程序）。
 * 用 @Res() 透传手写响应，绕过全局 ResponseInterceptor 的统一包装。
 */
@ApiExcludeController()
@Controller()
@UseFilters(OpenAiExceptionFilter)
export class LlmAdapterController {
  private readonly logger = new Logger(LlmAdapterController.name);

  constructor(private readonly adapter: LlmAdapterService) {}

  @Post("v1/chat/completions")
  async chatCompletions(
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    this.adapter.assertToken(req.headers.authorization);

    const parsed = parseChatCompletionRequest(req.body);
    if (parsed.ok === false) {
      throw new BadRequestException(parsed.message);
    }
    const request = parsed.value;
    // 显式设备标识 header 优先；service 内部 fallback 到请求体 user 字段
    const deviceHeader = req.headers["x-deda-device-id"];
    const deviceHint =
      typeof deviceHeader === "string" && deviceHeader.trim().length > 0
        ? deviceHeader.trim()
        : undefined;

    const id = `chatcmpl-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);

    if (!request.stream) {
      let content = "";
      try {
        content = await this.adapter.completeReply(request, deviceHint);
      } catch (error) {
        this.logger.error(
          `Non-stream completion failed for device=${deviceHint ?? request.user ?? "anonymous"}: ${describeError(error)}`,
        );
      }
      // 空文本对孩子等同于沉默，与抛错同等处置
      if (!content || !content.trim()) {
        content = ADVENTURE_DEGRADED_REPLIES.lastResort;
      }
      res.json({
        id,
        object: "chat.completion",
        created,
        model: request.model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content },
            finish_reason: "stop",
          },
        ],
      });
      return;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const writeChunk = (chunk: object) => {
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    };

    writeChunk({
      id,
      object: "chat.completion.chunk",
      created,
      model: request.model,
      choices: [
        { index: 0, delta: { role: "assistant" }, finish_reason: null },
      ],
    });

    /**
     * 「永不沉默」的最后一道闸：对百度侧永远交出成功的流式响应。
     *
     * 一旦这里让异常冒出去，OpenAiExceptionFilter 会在响应已开始后试图
     * res.status(500).json(...)（headers 已发，直接失效），设备端收到的
     * 就是半截流 + 静音。所以：
     * - 一个字都还没播 → 补一句 L0 兜底话术；
     * - 已经播了半句 → 只做优雅收尾，不再插入兜底话术，
     *   否则孩子会听到「前半句 + 一段无关的安抚」这种自相矛盾的内容；
     * - 正常结束但零 chunk → 同样补兜底话术，空流对孩子就是沉默。
     */
    let spokeContent = false;
    try {
      for await (const text of this.adapter.streamReply(request, deviceHint)) {
        spokeContent = true;
        writeChunk({
          id,
          object: "chat.completion.chunk",
          created,
          model: request.model,
          choices: [
            { index: 0, delta: { content: text }, finish_reason: null },
          ],
        });
      }
    } catch (error) {
      this.logger.error(
        `Stream completion failed for device=${deviceHint ?? request.user ?? "anonymous"} spokeContent=${spokeContent}: ${describeError(error)}`,
      );
    }
    if (!spokeContent) {
      writeChunk({
        id,
        object: "chat.completion.chunk",
        created,
        model: request.model,
        choices: [
          {
            index: 0,
            delta: { content: ADVENTURE_DEGRADED_REPLIES.lastResort },
            finish_reason: null,
          },
        ],
      });
    }

    writeChunk({
      id,
      object: "chat.completion.chunk",
      created,
      model: request.model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    });
    res.write("data: [DONE]\n\n");
    res.end();
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
