import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import { Response } from "express";

/**
 * 全局异常过滤器：所有失败都收敛成 { code, message, data } 信封。
 *
 * 从 @Catch(HttpException) 放宽到 @Catch() 的原因：非 HttpException
 * （Prisma 错误、TypeError、上游 SDK 抛错）原先落到 Nest 默认处理器，
 * 返回的是 { statusCode, message } 这个与全站不一致的形状，客户端的
 * 统一错误处理拿不到 code 字段，只能当成「未知失败」。
 *
 * 四条硬约束：
 * - 裸错误自带的数字状态码（body-parser 的 err.status、multer 的 http-errors）
 *   必须原样保留。这类中间件错误不是 HttpException，Nest 内置的
 *   BaseExceptionFilter 原本会读 err.status 回 413/415；本过滤器抢先接手后
 *   若一律判成 500，就把「客户端请求过大」伪装成了「服务端故障」。
 *   状态码只在缺失、非数字、或不在 [400,600) 时回落 500——绝不因为兜底
 *   而把故障伪装成成功，否则监控与客户端重试全部失效。
 * - 5xx 一律回 "Internal server error"，真实原因只进日志。
 *   SQL 片段、内部路径、上游密钥都可能出现在 error.message 里，不能外泄。
 *   4xx 才允许透传 message：http-errors 家族的文案本来就是给调用方看的。
 * - 完整原因始终进日志，与返回给客户端的文案无关。
 * - 非 HTTP 上下文（WS/RPC）直接跳过：那里 getResponse() 是 undefined，
 *   在过滤器里崩掉比让默认处理器接手更糟。WS 的兜底话术由 gateway 自己负责。
 *
 * 类名保留 HttpExceptionFilter：它已在 main.ts 全局注册，改名要动启动链路，
 * 与本次「让孩子永远听得到一句话」的目标无关。
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    if (host.getType() !== "http") {
      this.logUnknown(exception, "non-http context");
      return;
    }

    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    if (!response) {
      this.logUnknown(exception, "no http response object");
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const exceptionResponse = exception.getResponse();
      response.status(status).json({
        code: status,
        message:
          typeof exceptionResponse === "string"
            ? exceptionResponse
            : (exceptionResponse as { message?: string })?.message ||
              "Internal server error",
        data: null,
      });
      return;
    }

    const status = this.statusOf(exception);
    this.logUnknown(exception, host.getType());
    response.status(status).json({
      code: status,
      message: this.publicMessage(exception, status),
      data: null,
    });
  }

  /**
   * 只认 [400,600) 的整数状态码。伪造/越界/缺失一律 500，
   * 避免把内部故障包装成客户端错误后逃过告警。
   */
  private statusOf(exception: unknown): number {
    const raw = exception as { status?: unknown; statusCode?: unknown } | null;
    const candidate = Number(raw?.status ?? raw?.statusCode);
    return Number.isInteger(candidate) && candidate >= 400 && candidate < 600
      ? candidate
      : HttpStatus.INTERNAL_SERVER_ERROR;
  }

  /** 5xx 绝不外泄 message；4xx 缺文案时回落通用提示。 */
  private publicMessage(exception: unknown, status: number): string {
    if (status >= 500) {
      return "Internal server error";
    }
    const text = (exception as { message?: unknown } | null)?.message;
    if (typeof text !== "string" || text.trim().length === 0) {
      return status === HttpStatus.BAD_REQUEST
        ? "Bad request"
        : "Request failed";
    }
    return text;
  }

  /** 日志是尽力而为：最后一道闸自己抛错，就等于把响应也一起丢了。 */
  private logUnknown(exception: unknown, context: string): void {
    try {
      const detail =
        exception instanceof Error
          ? `${exception.message}\n${exception.stack ?? ""}`
          : String(exception);
      this.logger.error(`Unhandled exception in ${context}: ${detail}`);
    } catch {
      // 刻意留空：这里再抛就没人接了
    }
  }
}
