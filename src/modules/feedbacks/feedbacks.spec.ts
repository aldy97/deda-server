import {
  ExecutionContext,
  INestApplication,
  UnauthorizedException,
  ValidationPipe,
} from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { json, urlencoded, Request } from "express";
import * as request from "supertest";
import { ResponseInterceptor } from "@/common/interceptors/response.interceptor";
import { HttpExceptionFilter } from "@/common/filters/http-exception.filter";
import { PrismaService } from "@/common/prisma/prisma.service";
import { RedisService } from "@/common/redis/redis.service";
import { JwtAuthGuard } from "@/modules/users/guards/jwt-auth.guard";
import { FeedbacksController } from "./feedbacks.controller";
import { FeedbacksService } from "./feedbacks.service";
import { FeedbacksModule } from "./feedbacks.module";

const CREATED_AT = new Date("2026-11-01T03:00:00.000Z");
const VALID_TOKEN = "Bearer valid-token";

type AuthenticatedRequest = Request & {
  user?: { userId: string; openid: string };
};

type CreateFeedbackArguments = {
  data: {
    id: string;
    userId: string;
    content: string;
    contact: string | null;
  };
};

describe("Feedbacks", () => {
  let app: INestApplication;
  let service: FeedbacksService;
  let prismaCreate: jest.Mock;
  let redisGetClient: jest.Mock;

  beforeEach(async () => {
    prismaCreate = jest.fn();
    redisGetClient = jest.fn().mockReturnValue(undefined);
    prismaCreate.mockImplementation((args: CreateFeedbackArguments) =>
      Promise.resolve({ ...args.data, createdAt: CREATED_AT }),
    );

    const module: TestingModule = await Test.createTestingModule({
      controllers: [FeedbacksController],
      providers: [
        FeedbacksService,
        {
          provide: PrismaService,
          useValue: { feedback: { create: prismaCreate } },
        },
        {
          provide: RedisService,
          useValue: { getClient: redisGetClient },
        },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (context: ExecutionContext) => {
          const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
          if (req.headers.authorization !== VALID_TOKEN) {
            throw new UnauthorizedException("Unauthorized");
          }
          req.user = { userId: "user-001", openid: "openid-001" };
          return true;
        },
      })
      .compile();

    service = module.get(FeedbacksService);
    app = module.createNestApplication({ bodyParser: false });
    app.use("/feedbacks", json({ limit: "16kb", type: "application/json" }));
    app.use(json({ limit: "100kb" }));
    app.use(urlencoded({ extended: true, limit: "100kb" }));
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
      }),
    );
    app.useGlobalInterceptors(new ResponseInterceptor());
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it("creates feedback from the JWT user and trims content", async () => {
    const response = await request(app.getHttpServer())
      .post("/feedbacks")
      .set("Authorization", VALID_TOKEN)
      .send({ content: "  建议增加夜间模式  ", contact: "13800138000" })
      .expect(200);

    expect(response.body).toEqual({
      code: 0,
      message: "success",
      data: {
        feedbackId: expect.stringMatching(/^fb_[0-9a-f-]{36}$/),
        createdAt: "2026-11-01T03:00:00.000Z",
      },
    });
    expect(prismaCreate).toHaveBeenCalledWith({
      data: {
        id: expect.stringMatching(/^fb_[0-9a-f-]{36}$/),
        userId: "user-001",
        content: "建议增加夜间模式",
        contact: "13800138000",
      },
    });
  });

  it("stores NULL when contact is omitted or blank", async () => {
    await request(app.getHttpServer())
      .post("/feedbacks")
      .set("Authorization", VALID_TOKEN)
      .send({ content: "没有联系方式" })
      .expect(200);
    await request(app.getHttpServer())
      .post("/feedbacks")
      .set("Authorization", VALID_TOKEN)
      .send({ content: "空白联系方式", contact: "   " })
      .expect(200);

    expect(prismaCreate.mock.calls[0][0].data.contact).toBeNull();
    expect(prismaCreate.mock.calls[1][0].data.contact).toBeNull();
  });

  it("inserts separate rows when the same contact is reused", async () => {
    for (const content of ["第一条反馈", "第二条反馈"]) {
      await request(app.getHttpServer())
        .post("/feedbacks")
        .set("Authorization", VALID_TOKEN)
        .send({ content, contact: "13800138000" })
        .expect(200);
    }

    expect(prismaCreate).toHaveBeenCalledTimes(2);
    expect(prismaCreate.mock.calls[0][0].data.id).not.toBe(
      prismaCreate.mock.calls[1][0].data.id,
    );
  });

  it("accepts exactly 200 Unicode characters", async () => {
    await request(app.getHttpServer())
      .post("/feedbacks")
      .set("Authorization", VALID_TOKEN)
      .send({ content: "😀".repeat(200) })
      .expect(200);

    expect(prismaCreate.mock.calls[0][0].data.content).toBe("😀".repeat(200));
  });

  it.each([
    [{ content: "   " }, "问题或建议不能为空"],
    [{ content: "😀".repeat(201) }, "问题或建议最多 200 字"],
    [{ content: "有效反馈", contact: "12800138000" }, "联系手机号格式不正确"],
  ])("rejects invalid input with code 40001", async (body, message) => {
    const response = await request(app.getHttpServer())
      .post("/feedbacks")
      .set("Authorization", VALID_TOKEN)
      .send(body)
      .expect(400);

    expect(response.body).toEqual({ code: 40001, message, data: null });
    expect(prismaCreate).not.toHaveBeenCalled();
  });

  it("does not trust client userId or openid", async () => {
    const response = await request(app.getHttpServer())
      .post("/feedbacks")
      .set("Authorization", VALID_TOKEN)
      .send({ content: "有效反馈", userId: "forged-user", openid: "forged" })
      .expect(400);

    expect(response.body.code).toBe(40001);
    expect(prismaCreate).not.toHaveBeenCalled();
  });

  it("ignores a client supplied createdAt", async () => {
    await request(app.getHttpServer())
      .post("/feedbacks")
      .set("Authorization", VALID_TOKEN)
      .send({ content: "有效反馈", createdAt: "1999-01-01T00:00:00.000Z" })
      .expect(200);

    expect(prismaCreate.mock.calls[0][0].data).not.toHaveProperty("createdAt");
  });

  it.each(["", "Bearer invalid-token"])(
    "rejects missing or invalid JWT",
    async (authorization) => {
      const req = request(app.getHttpServer()).post("/feedbacks");
      if (authorization) req.set("Authorization", authorization);
      const response = await req.send({ content: "有效反馈" }).expect(401);

      expect(response.body).toEqual({
        code: 401,
        message: "Unauthorized",
        data: null,
      });
      expect(prismaCreate).not.toHaveBeenCalled();
    },
  );

  it("limits each user and IP to five submissions per minute", async () => {
    for (let index = 0; index < 5; index += 1) {
      await request(app.getHttpServer())
        .post("/feedbacks")
        .set("Authorization", VALID_TOKEN)
        .send({ content: `第 ${index + 1} 条反馈` })
        .expect(200);
    }

    const response = await request(app.getHttpServer())
      .post("/feedbacks")
      .set("Authorization", VALID_TOKEN)
      .send({ content: "第六条反馈" })
      .expect(429);

    expect(response.body).toEqual({
      code: 429,
      message: "提交过于频繁，请稍后再试",
      data: null,
    });
    expect(prismaCreate).toHaveBeenCalledTimes(5);
  });

  it("only accepts application/json", async () => {
    const response = await request(app.getHttpServer())
      .post("/feedbacks")
      .set("Authorization", VALID_TOKEN)
      .set("Content-Type", "text/plain")
      .send("content=有效反馈")
      .expect(415);

    expect(response.body).toEqual({
      code: 415,
      message: "请求格式必须为 application/json",
      data: null,
    });
    expect(prismaCreate).not.toHaveBeenCalled();
  });

  it("rejects request bodies larger than 16 KB", async () => {
    await request(app.getHttpServer())
      .post("/feedbacks")
      .set("Authorization", VALID_TOKEN)
      .send({ content: "a".repeat(17 * 1024) })
      .expect(413);

    expect(prismaCreate).not.toHaveBeenCalled();
  });

  it("registers the independent FeedbacksModule", () => {
    expect(FeedbacksModule).toBeDefined();
  });

  it("rechecks contact format in the service layer", async () => {
    await expect(
      service.create("user-001", "127.0.0.1", {
        content: "有效反馈",
        contact: "123",
      }),
    ).rejects.toThrow("联系手机号格式不正确");
    expect(prismaCreate).not.toHaveBeenCalled();
  });

  it("sets a Redis expiry on the first request in a window", async () => {
    const incr = jest.fn().mockResolvedValue(1);
    const expire = jest.fn().mockResolvedValue(1);
    redisGetClient.mockReturnValue({ incr, expire });

    await request(app.getHttpServer())
      .post("/feedbacks")
      .set("Authorization", VALID_TOKEN)
      .send({ content: "有效反馈" })
      .expect(200);

    expect(incr).toHaveBeenCalledTimes(1);
    expect(expire).toHaveBeenCalledWith(expect.any(String), 70);
  });

  it("uses the shared Redis counter for rate limiting", async () => {
    const incr = jest.fn().mockResolvedValue(6);
    const expire = jest.fn();
    redisGetClient.mockReturnValue({ incr, expire });

    await request(app.getHttpServer())
      .post("/feedbacks")
      .set("Authorization", VALID_TOKEN)
      .send({ content: "第六条反馈" })
      .expect(429);

    expect(expire).not.toHaveBeenCalled();
    expect(prismaCreate).not.toHaveBeenCalled();
  });
});
