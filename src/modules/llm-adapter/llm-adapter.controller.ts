import {
  BadRequestException,
  Controller,
  Post,
  Req,
  Res,
  UseFilters,
} from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import { randomUUID } from "crypto";
import { Request, Response } from "express";
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
      const content = await this.adapter.completeReply(request, deviceHint);
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

    for await (const text of this.adapter.streamReply(request, deviceHint)) {
      writeChunk({
        id,
        object: "chat.completion.chunk",
        created,
        model: request.model,
        choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
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
