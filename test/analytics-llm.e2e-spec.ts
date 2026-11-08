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
 * LLM 监控 e2e：真实 DB（TEST_DATABASE_URL 隔离库）+ 真实鉴权。
 * 覆盖：401 鉴权、信封格式、summary 聚合口径、trend 补零与 scene 过滤、
 * recent-failures 分页与业务 deviceId、400（非法 scene / 非法日期 / pageSize 越界）、
 * 501 老接口已下线（404）。
 */
describe("Analytics llm (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;

  const suffix = randomUUID().slice(0, 8);
  const businessDeviceId = `llm-e2e-${suffix}`;
  let deviceInternalId: string;

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

    const base = { model: "deepseek-flash", deviceId: deviceInternalId };
    // 2026-11-07（北京时间）：chat_main 两成一败 + filler 一败
    await prisma.llmUsageLog.createMany({
      data: [
        {
          ...base,
          scene: "chat_main",
          tier: "main",
          success: true,
          latencyMs: 1000,
          firstTokenMs: 300,
          promptTokens: 10,
          completionTokens: 5,
          totalTokens: 15,
          createdAt: new Date("2026-11-07T02:00:00Z"), // 北京 10:00
        },
        {
          ...base,
          scene: "chat_main",
          tier: "main",
          success: true,
          latencyMs: 3000,
          firstTokenMs: 500,
          totalTokens: 25,
          createdAt: new Date("2026-11-07T03:00:00Z"),
        },
        {
          ...base,
          scene: "chat_main",
          tier: "main",
          success: false,
          failureReason: "timeout",
          latencyMs: 30000,
          createdAt: new Date("2026-11-07T04:00:00Z"),
        },
        {
          ...base,
          scene: "filler",
          tier: "small",
          model: "qwen-flash",
          success: false,
          failureReason: "rate_limit",
          latencyMs: 2000,
          createdAt: new Date("2026-11-07T05:00:00Z"),
        },
        // 匿名调用（无设备上下文）+ 区间外的一行
        {
          scene: "parent_report",
          tier: "main",
          model: "deepseek-flash",
          success: false,
          failureReason: "empty_response",
          latencyMs: 800,
          createdAt: new Date("2026-11-06T02:00:00Z"),
        },
      ],
    });
  });

  afterAll(async () => {
    await prisma.llmUsageLog.deleteMany({
      where: {
        OR: [
          { deviceId: deviceInternalId },
          { scene: "parent_report", failureReason: "empty_response" },
        ],
      },
    });
    await prisma.device.delete({ where: { id: deviceInternalId } });
    await app.close();
  });

  function authed(url: string) {
    return request(app.getHttpServer())
      .get(url)
      .set("Authorization", `Bearer ${adminToken}`);
  }

  it("无 token 返回 401", async () => {
    const res = await request(app.getHttpServer()).get(
      "/analytics/llm/summary?startDate=2026-11-07&endDate=2026-11-07",
    );
    expect(res.status).toBe(401);
  });

  it("老 501 占位接口已下线", async () => {
    const res = await authed("/analytics/quality/llm-usage");
    expect(res.status).toBe(404);
  });

  it("summary：分场景聚合口径（成功率/分位数/token/失败分布）", async () => {
    const res = await authed(
      "/analytics/llm/summary?startDate=2026-11-07&endDate=2026-11-07",
    );
    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);

    const scenes = res.body.data.scenes;
    const chatMain = scenes.find((s: any) => s.scene === "chat_main");
    expect(chatMain).toMatchObject({
      tier: "main",
      calls: 3,
      successRate: 0.6667,
      p50LatencyMs: 3000,
      totalTokens: 40,
      failureBreakdown: [{ reason: "timeout", count: 1 }],
    });
    expect(chatMain.p50FirstTokenMs).toBe(400);

    const filler = scenes.find((s: any) => s.scene === "filler");
    expect(filler).toMatchObject({
      tier: "small",
      calls: 1,
      successRate: 0,
      failureBreakdown: [{ reason: "rate_limit", count: 1 }],
    });
    // 区间外的 parent_report 不出现
    expect(
      scenes.find((s: any) => s.scene === "parent_report"),
    ).toBeUndefined();
  });

  it("trend：按日补零 + scene 过滤", async () => {
    const res = await authed(
      "/analytics/llm/trend?startDate=2026-11-06&endDate=2026-11-08&granularity=day&scene=chat_main",
    );
    expect(res.status).toBe(200);
    const series = res.body.data.series;
    expect(series).toHaveLength(3);
    expect(series[0]).toMatchObject({ date: "2026-11-06", calls: 0 });
    expect(series[1]).toMatchObject({
      date: "2026-11-07",
      calls: 3,
      successRate: 0.6667,
      avgFirstTokenMs: 400,
      totalTokens: 40,
    });
    expect(series[2]).toMatchObject({ date: "2026-11-08", calls: 0 });
  });

  it("recent-failures：倒序 + 业务 deviceId + 匿名行为 null", async () => {
    const res = await authed(
      "/analytics/llm/recent-failures?page=1&pageSize=20",
    );
    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(3);
    const items = res.body.data.items;
    // createdAt 倒序：filler(05:00) > chat_main(04:00) > parent_report(前一日)
    expect(items[0].scene).toBe("filler");
    expect(items[0].deviceId).toBe(businessDeviceId);
    expect(items[2].scene).toBe("parent_report");
    expect(items[2].deviceId).toBeNull();
  });

  it("recent-failures：scene 过滤 + 分页越界 400", async () => {
    const filtered = await authed(
      "/analytics/llm/recent-failures?scene=chat_main",
    );
    expect(filtered.body.data.total).toBe(1);
    expect(filtered.body.data.items[0].failureReason).toBe("timeout");

    const res = await authed("/analytics/llm/recent-failures?pageSize=101");
    expect(res.status).toBe(400);
  });

  it("非法 scene / 非法日期 / 范围倒置返回 400", async () => {
    for (const url of [
      "/analytics/llm/trend?startDate=2026-11-07&endDate=2026-11-07&scene=bogus",
      "/analytics/llm/recent-failures?scene=bogus",
      "/analytics/llm/summary?startDate=2026-13-01&endDate=2026-11-07",
      "/analytics/llm/summary?startDate=2026-11-08&endDate=2026-11-01",
    ]) {
      const res = await authed(url);
      expect(res.status).toBe(400);
    }
  });
});
