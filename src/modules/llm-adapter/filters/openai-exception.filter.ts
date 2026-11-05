import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from "@nestjs/common";
import { Response } from "express";

/**
 * OpenAI 风格异常过滤器（仅作用于 llm-adapter 控制器）。
 *
 * 全局 HttpExceptionFilter 输出的是 {code,message,data} 统一响应，
 * 百度 RTC 期望的是 OpenAI 错误体，因此在控制器级覆盖，不动全局过滤器。
 */
@Catch()
export class OpenAiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    const message =
      exception instanceof HttpException
        ? exception.message
        : "Internal server error";

    res.status(status).json({
      error: {
        message,
        type: this.errorType(status),
        code: null,
      },
    });
  }

  private errorType(status: number): string {
    switch (status) {
      case HttpStatus.UNAUTHORIZED:
      case HttpStatus.FORBIDDEN:
        return "authentication_error";
      case HttpStatus.BAD_REQUEST:
        return "invalid_request_error";
      default:
        return "server_error";
    }
  }
}
