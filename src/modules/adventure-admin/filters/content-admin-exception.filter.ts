import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
} from "@nestjs/common";
import { Response } from "express";
import { HttpExceptionFilter } from "@/common/filters/http-exception.filter";

/** Nest 标准错误体的字段名：它们不是业务附带信息，不该被当成 data 回传。 */
const STANDARD_PAYLOAD_KEYS = ["message", "statusCode", "error"];

/**
 * 冒险内容管理台的异常过滤器（仅作用于 AdventureAdminController）。
 *
 * 领域层抛的是 `new BadRequestException({ message, code, ...附带字段 })`，
 * 而全局过滤器只取 `message`，于是 `DRAFT_CONFLICT`、`currentDraft`、
 * `expectedBundleHash`、`lint` 这些前端做精确文案与冲突恢复要用的东西，
 * 全都在出网那一刻被丢掉，前端只能去匹配中文 message 字符串——那是脆的。
 *
 * 两条设计约束：
 * - **不改全局过滤器**。全站 25 处对象载荷异常都在 adventure-admin 里，
 *   所以修正的正确作用域就是这一个控制器；仓库已有同风格先例
 *   （llm-adapter/filters/openai-exception.filter.ts）。
 *   信封形状一字不改：`code` 仍然是 HTTP 状态码，领域码放在 `data.code`。
 * - **不复制「未知错误」的处置**。非 HttpException 一律委托回全局过滤器，
 *   否则「5xx 绝不外泄 message」「裸错误保留 status」就会有两处真相，
 *   而这两条恰恰是最容易在后续修改中被其中一处悄悄破坏的。
 */
@Catch()
export class ContentAdminExceptionFilter implements ExceptionFilter {
  private readonly globalFallback = new HttpExceptionFilter();

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== "http" || !(exception instanceof HttpException)) {
      this.globalFallback.catch(exception, host);
      return;
    }

    const response = host.switchToHttp().getResponse<Response>();
    if (!response) {
      this.globalFallback.catch(exception, host);
      return;
    }

    const status = exception.getStatus();
    const payload = this.split(exception.getResponse());
    response.status(status).json({
      code: status,
      message: payload.message,
      data: payload.data,
    });
  }

  /**
   * 把异常载荷拆成「给人看的 message」与「给代码看的 data」。
   * data 为空对象时回 null：没有附带信息就别造一个空壳，
   * 这样老路由（字符串载荷）的响应体与加过滤器之前逐字一致。
   */
  private split(payload: unknown): {
    message: string | unknown[];
    data: Record<string, unknown> | null;
  } {
    if (typeof payload === "string") {
      return { message: payload, data: null };
    }
    if (!payload || typeof payload !== "object") {
      return { message: "Internal server error", data: null };
    }

    const record = payload as Record<string, unknown>;
    const extras: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      if (STANDARD_PAYLOAD_KEYS.includes(key) || value === undefined) {
        continue;
      }
      extras[key] = value;
    }

    const raw = record.message;
    let message: string | unknown[];
    if (Array.isArray(raw)) {
      // ValidationPipe 的错误体是字符串数组，原样保留
      message = raw;
    } else if (typeof raw === "string" && raw.trim()) {
      message = raw;
    } else {
      message = "Internal server error";
    }

    return {
      message,
      data: Object.keys(extras).length > 0 ? extras : null,
    };
  }
}
