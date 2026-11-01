import {
  ArgumentsHost,
  BadRequestException,
  Body,
  CanActivate,
  Catch,
  Controller,
  ExceptionFilter,
  ExecutionContext,
  HttpCode,
  Injectable,
  PayloadTooLargeException,
  Post,
  Req,
  UnsupportedMediaTypeException,
  UseFilters,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { Request, Response } from "express";
import { JwtAuthGuard } from "@/modules/users/guards/jwt-auth.guard";
import { CreateFeedbackDto } from "./dto/create-feedback.dto";
import { FeedbacksService } from "./feedbacks.service";

const MAX_BODY_BYTES = 16 * 1024;

interface RequestWithUser extends Request {
  user: { userId: string; openid: string };
}

@Injectable()
class JsonContentTypeGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (!req.is("application/json")) {
      throw new UnsupportedMediaTypeException(
        "请求格式必须为 application/json",
      );
    }
    return true;
  }
}

@Catch(BadRequestException)
class FeedbackValidationFilter implements ExceptionFilter<BadRequestException> {
  catch(exception: BadRequestException, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    const exceptionResponse = exception.getResponse();
    let message = exception.message;

    if (typeof exceptionResponse === "string") {
      message = exceptionResponse;
    } else if (
      typeof exceptionResponse === "object" &&
      "message" in exceptionResponse
    ) {
      const responseMessage = exceptionResponse.message;
      if (Array.isArray(responseMessage)) {
        message = String(responseMessage[0]);
      } else if (responseMessage) {
        message = String(responseMessage);
      }
    }

    response.status(400).json({ code: 40001, message, data: null });
  }
}

@ApiTags("用户反馈")
@Controller("feedbacks")
@UseGuards(JwtAuthGuard, JsonContentTypeGuard)
@UseFilters(FeedbackValidationFilter)
@ApiBearerAuth()
export class FeedbacksController {
  constructor(private readonly feedbacksService: FeedbacksService) {}

  @Post()
  @HttpCode(200)
  @ApiOperation({ summary: "提交问题或建议" })
  @ApiResponse({ status: 200, description: "提交成功" })
  @ApiResponse({ status: 400, description: "参数校验失败" })
  @ApiResponse({ status: 401, description: "未登录或 token 无效" })
  @ApiResponse({ status: 429, description: "提交过于频繁" })
  async create(@Body() dto: CreateFeedbackDto, @Req() req: RequestWithUser) {
    const contentLength = Number(req.headers["content-length"] || 0);
    const serializedBodyBytes = Buffer.byteLength(JSON.stringify(dto), "utf8");
    if (
      (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) ||
      serializedBodyBytes > MAX_BODY_BYTES
    ) {
      throw new PayloadTooLargeException("请求体最多 16 KB");
    }

    return this.feedbacksService.create(
      req.user.userId,
      req.ip || "unknown",
      dto,
    );
  }
}
