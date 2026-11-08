import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { randomUUID } from "crypto";
import * as dotenv from "dotenv";
import * as request from "supertest";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/common/prisma/prisma.service";
import { ResponseInterceptor } from "../src/common/interceptors/response.interceptor";
import { HttpExceptionFilter } from "../src/common/filters/http-exception.filter";

dotenv.config();

const ANALYTICS_SECRET =
  process.env.ANALYTICS_JWT_SECRET || "dev-analytics-jwt-secret";

/**
 * 消息明细浏览 e2e：真实 DB（TEST_DATABASE_URL 隔离库）+ 真实鉴权。
 * 覆盖：401 鉴权、信封格式、业务 deviceId 过滤、turnId 同轮、keyword 大小写、
 * 400（非法枚举 / pageSize 越界 / 范围倒置）、详情含 rawPayload、详情 404。
 */
describe("Analytics messages (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;

  const suffix = randomUUID().slice(0, 8);
  const businessDeviceId = `msg-e2e-${suffix}`;
  const turnId = `turn-${suffix}`;
  let deviceInternalId: string;
  let messageId: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
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

    prisma = moduleFixture.get(PrismaService);
    adminToken = await new JwtService({
      secret: ANALYTICS_SECRET,
    }).signAsync({ sub: "admin", username: "admin", scope: "analytics" });

    const device = await prisma.device.create({
      data: { deviceId: businessDeviceId, characterKey: "elly" },
    });
    deviceInternalId = device.id;

    const base = {
      deviceId: deviceInternalId,
      status: "completed",
      mode: "free_chat",
    };
    const userMsg = await prisma.message.create({
      data: {
        ...base,
        turnId,
        role: "user",
        content: "给我讲一个Rabbit故事",
        spokeAt: new Date("2026-11-07T03:00:00Z"), // 北京 11:00
      },
    });
    messageId = userMsg.id;
    await prisma.message.create({
      data: {
        ...base,
        turnId,
        role: "assistant",
        content: "好的，小 Rabbit 来啦",
        rawPayload: { filler: "好呀", answer: "好的，小 Rabbit 来啦" },
        spokeAt: new Date("2026-11-07T03:00:02Z"),
      },
    });
    await prisma.message.create({
      data: {
        ...base,
        turnId: `turn-other-${suffix}`,
        role: "user",
        content: " unrelated 内容 ",
        mode: "sleep_story",
        spokeAt: new Date("2026-11-06T03:00:00Z"),
      },
    });
  });

  afterAll(async () => {
    await prisma.message.deleteMany({ where: { deviceId: deviceInternalId } });
    await prisma.device.delete({ where: { id: deviceInternalId } });
    await app.close();
  });

  function authed(url: string) {
    return request(app.getHttpServer())
      .get(url)
      .set("Authorization", `Bearer ${adminToken}`);
  }

  it("无 token 返回 401", async () => {
    const res = await request(app.getHttpServer()).get("/analytics/messages");
    expect(res.status).toBe(401);
  });

  it("scope 非 analytics 的 token 返回 401", async () => {
    const wrongScope = await new JwtService({
      secret: ANALYTICS_SECRET,
    }).signAsync({ sub: "admin", scope: "wechat" });
    const res = await request(app.getHttpServer())
      .get("/analytics/messages")
      .set("Authorization", `Bearer ${wrongScope}`);
    expect(res.status).toBe(401);
  });

  it("列表：信封 + 业务 deviceId 过滤 + 不含 rawPayload", async () => {
    const res = await authed(
      `/analytics/messages?deviceId=${businessDeviceId}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
    expect(res.body.data.total).toBe(3);
    expect(res.body.data.items).toHaveLength(3);
    expect(res.body.data.items[0]).not.toHaveProperty("rawPayload");
    expect(res.body.data.items[0].device.deviceId).toBe(businessDeviceId);
    // 默认 spokeAt 倒序：最新的在最前
    expect(res.body.data.items[0].role).toBe("assistant");
  });

  it("turnId 精确匹配返回同一轮问答两条", async () => {
    const res = await authed(
      `/analytics/messages?turnId=${turnId}&sort=spokeAt_asc`,
    );
    expect(res.body.data.total).toBe(2);
    expect(res.body.data.items.map((m: any) => m.role)).toEqual([
      "user",
      "assistant",
    ]);
  });

  it("keyword 大小写不敏感", async () => {
    const res = await authed(
      `/analytics/messages?deviceId=${businessDeviceId}&keyword=rabbit`,
    );
    expect(res.body.data.total).toBe(2);
  });

  it("spokeAt 日期闭区间（Asia/Shanghai 边界）", async () => {
    const res = await authed(
      `/analytics/messages?deviceId=${businessDeviceId}&startDate=2026-11-07&endDate=2026-11-07`,
    );
    expect(res.body.data.total).toBe(2);
  });

  it("非法枚举 / pageSize 越界 / 范围倒置返回 400", async () => {
    for (const url of [
      "/analytics/messages?role=admin",
      "/analytics/messages?pageSize=101",
      "/analytics/messages?startDate=2026-11-08&endDate=2026-11-01",
    ]) {
      const res = await authed(url);
      expect(res.status).toBe(400);
    }
  });

  it("详情返回整行含 rawPayload；id 不存在返回 404", async () => {
    const found = await authed(`/analytics/messages/${messageId}`);
    expect(found.status).toBe(200);
    expect(found.body.data.id).toBe(messageId);
    expect(found.body.data.device.deviceId).toBe(businessDeviceId);

    const assistant = await prisma.message.findFirst({
      where: { turnId, role: "assistant" },
    });
    const withPayload = await authed(`/analytics/messages/${assistant!.id}`);
    expect(withPayload.body.data.rawPayload).toEqual({
      filler: "好呀",
      answer: "好的，小 Rabbit 来啦",
    });

    const missing = await authed(`/analytics/messages/${randomUUID()}`);
    expect(missing.status).toBe(404);
  });
});
