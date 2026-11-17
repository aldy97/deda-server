import {
  ArgumentsHost,
  BadRequestException,
  ConflictException,
  Logger,
} from "@nestjs/common";
import { HttpExceptionFilter } from "@/common/filters/http-exception.filter";
import { ContentAdminExceptionFilter } from "./content-admin-exception.filter";

/**
 * 管理台专属的异常过滤器。
 *
 * 它存在的唯一理由：领域层抛的是 `new BadRequestException({ message, code, ...附带字段 })`，
 * 而全局过滤器只取 `message`，于是 `DRAFT_CONFLICT`、`currentDraft`、
 * `expectedBundleHash` 这些前端做精确文案与冲突恢复要用的东西全部在出网那一刻被丢掉。
 *
 * 两条硬要求：
 * - **不动全局过滤器**。全站 25 处对象载荷异常全在 adventure-admin 里，
 *   所以这个修正的正确作用域就是这一个控制器（仓库已有同风格先例：
 *   llm-adapter/filters/openai-exception.filter.ts）。
 * - **不复制「未知错误」的处置**。非 HttpException 一律委托回全局过滤器，
 *   否则「5xx 不外泄 message」「裸错误保留 status」就会有两处真相。
 */
describe("ContentAdminExceptionFilter", () => {
  let filter: ContentAdminExceptionFilter;
  let response: { status: jest.Mock; json: jest.Mock };
  let host: ArgumentsHost;
  let delegate: jest.SpyInstance;

  beforeEach(() => {
    filter = new ContentAdminExceptionFilter();
    response = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    host = {
      switchToHttp: () => ({ getResponse: () => response }),
      getType: () => "http",
    } as unknown as ArgumentsHost;
    jest.spyOn(Logger.prototype, "error").mockReturnValue(undefined);
    delegate = jest.spyOn(HttpExceptionFilter.prototype, "catch");
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function body(): Record<string, unknown> {
    return response.json.mock.calls[0][0] as Record<string, unknown>;
  }

  it("把领域码放进 data.code，HTTP 状态码留在 code，信封形状不变", () => {
    filter.catch(
      new BadRequestException({
        message: "变更理由不能少于 8 个字",
        code: "REASON_REQUIRED",
      }),
      host,
    );

    expect(response.status).toHaveBeenCalledWith(400);
    expect(body()).toEqual({
      code: 400,
      message: "变更理由不能少于 8 个字",
      data: { code: "REASON_REQUIRED" },
    });
  });

  it("保留冲突恢复要用的附带字段（乐观锁的 currentDraft）", () => {
    const currentDraft = { title: "别人改过的草稿", version: 7 };
    filter.catch(
      new ConflictException({
        message: "草稿已被别人改过",
        code: "DRAFT_CONFLICT",
        currentDraft,
      }),
      host,
    );

    expect(response.status).toHaveBeenCalledWith(409);
    expect(body().data).toEqual({ code: "DRAFT_CONFLICT", currentDraft });
  });

  it("字符串载荷的行为与全局过滤器逐字一致，不给老路由添新字段", () => {
    filter.catch(new BadRequestException("字段不合法"), host);

    expect(body()).toEqual({
      code: 400,
      message: "字段不合法",
      data: null,
    });
  });

  it("只有 message 的对象载荷不会回一个空 data 对象", () => {
    filter.catch(new BadRequestException({ message: "字段不合法" }), host);

    expect(body().data).toBeNull();
  });

  it("ValidationPipe 的错误体保留 message 数组，且不把 Nest 标准字段当附带信息回传", () => {
    const exception = new BadRequestException({
      statusCode: 400,
      message: ["content must be an object"],
      error: "Bad Request",
    } as never);

    filter.catch(exception, host);

    expect(body()).toEqual({
      code: 400,
      message: ["content must be an object"],
      data: null,
    });
  });

  it("非 HttpException 委托回全局过滤器，不自己复制一套未知错误处置", () => {
    const bare = new Error("request entity too large") as Error & {
      status?: number;
    };
    bare.status = 413;

    filter.catch(bare, host);

    expect(delegate).toHaveBeenCalledWith(bare, host);
    expect(response.status).toHaveBeenCalledWith(413);
  });

  it("委托之后 5xx 仍然不外泄真实原因", () => {
    filter.catch(new Error("SELECT * FROM devices WHERE token=secret"), host);

    expect(delegate).toHaveBeenCalled();
    expect(body().message).toBe("Internal server error");
    expect(body().message).not.toContain("secret");
  });

  it("非 HTTP 上下文不碰 response，交给全局过滤器决定怎么跳过", () => {
    const wsHost = {
      switchToHttp: () => ({ getResponse: () => undefined }),
      getType: () => "ws",
    } as unknown as ArgumentsHost;

    expect(() =>
      filter.catch(new BadRequestException("x"), wsHost),
    ).not.toThrow();
    expect(response.status).not.toHaveBeenCalled();
  });
});
