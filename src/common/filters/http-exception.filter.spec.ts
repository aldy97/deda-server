import { ArgumentsHost, BadRequestException, Logger } from "@nestjs/common";
import { HttpExceptionFilter } from "./http-exception.filter";

/**
 * 全局异常过滤器。
 *
 * 放宽到 @Catch() 之后，非 HttpException（Prisma 错误、TypeError、上游 SDK 抛错）
 * 也走同一个 {code,message,data} 信封，而不是 Nest 默认的 {statusCode,...}。
 * 三条硬要求：裸错误自带的数字状态码原样保留（否则 body-parser 的 413 会被
 * 伪装成 500）；5xx 的真实错误只进日志、绝不外泄给客户端（SQL 片段与内部
 * 路径都算敏感信息）；缺失或伪造的状态码回落 500，不能把故障伪装成客户端错误。
 */
describe("HttpExceptionFilter", () => {
  let filter: HttpExceptionFilter;
  let response: {
    status: jest.Mock;
    json: jest.Mock;
  };
  let host: ArgumentsHost;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    filter = new HttpExceptionFilter();
    response = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    host = {
      switchToHttp: () => ({ getResponse: () => response }),
      getType: () => "http",
    } as unknown as ArgumentsHost;
    errorSpy = jest.spyOn(Logger.prototype, "error").mockReturnValue(undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("HttpException 行为不变：原状态码 + 统一信封", () => {
    filter.catch(new BadRequestException("字段不合法"), host);

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith({
      code: 400,
      message: "字段不合法",
      data: null,
    });
  });

  it("HttpException 的字符串响应体也能取到 message", () => {
    const exception = new BadRequestException();
    jest.spyOn(exception, "getResponse").mockReturnValue("plain message");

    filter.catch(exception, host);

    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: "plain message" }),
    );
  });

  it("非 HttpException 返回 500 与统一信封，而不是 Nest 默认的 statusCode 形状", () => {
    filter.catch(new Error("boom"), host);

    expect(response.status).toHaveBeenCalledWith(500);
    expect(response.json).toHaveBeenCalledWith({
      code: 500,
      message: "Internal server error",
      data: null,
    });
  });

  it("非 HttpException 的真实原因只进日志，不外泄给客户端", () => {
    filter.catch(new Error("SELECT * FROM devices WHERE token=secret"), host);

    const body = response.json.mock.calls[0][0] as { message: string };
    expect(body.message).toBe("Internal server error");
    expect(body.message).not.toContain("secret");
    expect(errorSpy).toHaveBeenCalled();
    expect(String(errorSpy.mock.calls[0][0])).toContain("token=secret");
  });

  it("非 Error 抛出物（字符串/对象）同样兜住", () => {
    filter.catch("raw string failure", host);

    expect(response.status).toHaveBeenCalledWith(500);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 500 }),
    );
  });

  /**
   * body-parser / multer 这类中间件抛的是裸 Error + err.status，
   * 不是 HttpException。Nest 内置的 BaseExceptionFilter 会读 status 回原码，
   * 放宽到 @Catch() 之后本过滤器抢先接手，必须保留同样的状态码，
   * 否则 413/415 这类调用方错误会被伪装成 500（见 feedbacks.spec.ts）。
   */
  it("带 status 的裸 Error 保留原状态码（body-parser 的 413）", () => {
    const exception = new Error("request entity too large") as Error & {
      status?: number;
      type?: string;
    };
    exception.status = 413;
    exception.type = "entity.too.large";

    filter.catch(exception, host);

    expect(response.status).toHaveBeenCalledWith(413);
    expect(response.json).toHaveBeenCalledWith({
      code: 413,
      message: "request entity too large",
      data: null,
    });
  });

  it("statusCode 字段与非 Error 抛出物上的状态码同样被识别", () => {
    filter.catch({ statusCode: 422, message: "字段不合法" }, host);

    expect(response.status).toHaveBeenCalledWith(422);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 422, message: "字段不合法" }),
    );
  });

  it("带 5xx status 的裸错误保留状态码，但 message 一律不外泄", () => {
    const exception = new Error(
      "Prisma pool timeout at /app/src/modules/devices",
    ) as Error & { status?: number };
    exception.status = 503;

    filter.catch(exception, host);

    expect(response.status).toHaveBeenCalledWith(503);
    expect(response.json).toHaveBeenCalledWith({
      code: 503,
      message: "Internal server error",
      data: null,
    });
    expect(errorSpy).toHaveBeenCalled();
  });

  it("越界或非数字的 status 回落 500，不能被伪造的状态码带偏", () => {
    const outOfRange = new Error("nope") as Error & { status?: number };
    outOfRange.status = 999;
    filter.catch(outOfRange, host);
    expect(response.status).toHaveBeenLastCalledWith(500);

    const notAnError = new Error("nope") as Error & { status?: number };
    notAnError.status = 200;
    filter.catch(notAnError, host);
    expect(response.status).toHaveBeenLastCalledWith(500);

    const garbage = new Error("nope") as Error & { status?: unknown };
    garbage.status = Number.NaN;
    filter.catch(garbage, host);
    expect(response.status).toHaveBeenLastCalledWith(500);
  });

  it("带 status 但 message 为空/非字符串时回落通用文案", () => {
    filter.catch({ status: 400 }, host);

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 400, message: "Bad request" }),
    );
  });

  it("日志本身抛错也不影响响应（最后一道闸不能再抛）", () => {
    errorSpy.mockImplementation(() => {
      throw new Error("logger down");
    });

    expect(() => filter.catch(new Error("boom"), host)).not.toThrow();
    expect(response.status).toHaveBeenCalledWith(500);
  });

  it("非 HTTP 上下文（WS/RPC）不碰 response，避免 getResponse 返回 undefined 时崩在过滤器里", () => {
    const wsHost = {
      switchToHttp: () => ({ getResponse: () => undefined }),
      getType: () => "ws",
    } as unknown as ArgumentsHost;

    expect(() => filter.catch(new Error("boom"), wsHost)).not.toThrow();
    expect(response.status).not.toHaveBeenCalled();
  });
});
