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
import {
  DEFAULT_REPORT_TIMEZONE,
  reportDateInTimezone,
  shiftReportDate,
} from "../src/modules/learning-stats/parent-report-date.util";

dotenv.config();

const ANALYTICS_SECRET =
  process.env.ANALYTICS_JWT_SECRET || "dev-analytics-jwt-secret";

/**
 * LLM 费用接口 e2e：真实 DB（TEST_DATABASE_URL 隔离库）+ 真实鉴权 + 真实 $queryRaw。
 *
 * 单测里两条聚合 SQL 是 mock 的，这里用真库守住 SQL 语法/类型与时区分桶（createdAt 存 UTC，
 * 按 Asia/Shanghai 取自然日）。账单日期刻意选 2026-06（其他 e2e 套件只用 2026-10/11），
 * 保证并行跑时金额断言不受污染。
 */
describe("Analytics llm cost (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;

  const suffix = randomUUID().slice(0, 8);
  const businessDeviceId = `llm-cost-e2e-${suffix}`;
  let deviceInternalId: string;
  const dedupeKeys = [
    `cost-e2e-${suffix}-a`,
    `cost-e2e-${suffix}-b`,
    `cost-e2e-${suffix}-refund`,
  ];

  beforeAll(async () => {
    // 明确不接阿里云凭证：sync 应回 unconfigured，费用接口应回 unconfigured 而不是 ¥0
    process.env.ALIYUN_BSS_ACCESS_KEY_ID = "";
    process.env.ALIYUN_BSS_ACCESS_KEY_SECRET = "";
    process.env.ALIYUN_BSS_USE_RAM_ROLE = "";

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
    adminToken = await new JwtService({ secret: ANALYTICS_SECRET }).signAsync({
      sub: "admin",
      username: "admin",
      scope: "analytics",
    });

    const device = await prisma.device.create({
      data: { deviceId: businessDeviceId, characterKey: "elly" },
    });
    deviceInternalId = device.id;

    const base = { deviceId: deviceInternalId, success: true };
    await prisma.llmUsageLog.createMany({
      data: [
        // 2026-06-15 主模型：一行有缓存命中、一行没有 → mainAccuracy=mixed
        {
          ...base,
          scene: "chat_main",
          tier: "main",
          model: "deepseek-flash",
          promptTokens: 1000,
          completionTokens: 100,
          totalTokens: 1100,
          cacheHitInputTokens: 800,
          costMicroCny: 123456,
          latencyMs: 1000,
          createdAt: new Date("2026-06-15T02:00:00Z"), // 北京 10:00
        },
        {
          ...base,
          scene: "chat_main",
          tier: "main",
          model: "deepseek-flash",
          promptTokens: 500,
          completionTokens: 50,
          totalTokens: 550,
          cacheHitInputTokens: null,
          costMicroCny: 1000,
          latencyMs: 900,
          createdAt: new Date("2026-06-15T06:00:00Z"),
        },
        // 2026-06-15 小模型埋点（金额以账单为准，这里的 costMicroCny 只用于对账）
        {
          ...base,
          scene: "filler",
          tier: "small",
          model: "qwen-flash",
          promptTokens: 2000,
          completionTokens: 200,
          totalTokens: 2200,
          cacheHitInputTokens: 0,
          costMicroCny: 5000,
          latencyMs: 300,
          createdAt: new Date("2026-06-15T03:00:00Z"),
        },
        // 2026-06-16 只有主模型，无账单行 → smallCny=null（不补 0）
        {
          ...base,
          scene: "chat_main",
          tier: "main",
          model: "deepseek-flash",
          promptTokens: 300,
          completionTokens: 20,
          totalTokens: 320,
          cacheHitInputTokens: 300,
          costMicroCny: 200000,
          latencyMs: 1200,
          createdAt: new Date("2026-06-16T01:30:00Z"),
        },
      ],
    });

    // 账单真值：0.4 元正常 + (-0.1) 元退款 → 当日应付 0.3 元（负数不取绝对值）
    await prisma.llmCostDaily.createMany({
      data: [
        {
          billDate: "2026-06-15",
          billingCycle: "2026-06",
          productCode: "bailian",
          productName: "阿里云百炼",
          billingItem: "qwen-flash 输入",
          billingItemCode: "input",
          instanceId: "llm-cost-e2e",
          model: "qwen-flash",
          tier: "small",
          itemKind: "PayAsYouGoBill",
          usage: 2200,
          usageUnit: "Token",
          grossMicroCny: 400000,
          payableMicroCny: 400000,
          settled: true,
          dedupeKey: dedupeKeys[0],
        },
        {
          billDate: "2026-06-15",
          billingCycle: "2026-06",
          productCode: "bailian",
          productName: "阿里云百炼",
          billingItem: "qwen-flash 退款",
          billingItemCode: "refund",
          instanceId: "llm-cost-e2e",
          model: "qwen-flash",
          tier: "small",
          itemKind: "Refund",
          grossMicroCny: -100000,
          payableMicroCny: -100000,
          settled: true,
          dedupeKey: dedupeKeys[1],
        },
        // 未终账的另一天：对账时必须被排除
        {
          billDate: "2026-06-17",
          billingCycle: "2026-06",
          productCode: "bailian",
          productName: "阿里云百炼",
          billingItem: "qwen-flash 输入",
          billingItemCode: "input",
          instanceId: "llm-cost-e2e",
          model: "qwen-flash",
          tier: "small",
          itemKind: "PayAsYouGoBill",
          grossMicroCny: 900000,
          payableMicroCny: 900000,
          settled: false,
          dedupeKey: dedupeKeys[2],
        },
      ],
    });
  });

  afterAll(async () => {
    await prisma.llmCostDaily.deleteMany({
      where: { dedupeKey: { in: dedupeKeys } },
    });
    await prisma.llmUsageLog.deleteMany({
      where: { deviceId: deviceInternalId },
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
      "/analytics/llm/cost-daily?startDate=2026-06-15&endDate=2026-06-17",
    );
    expect(res.status).toBe(401);
  });

  it("非法日期 / 范围倒置 / 超长区间返回 400", async () => {
    for (const url of [
      "/analytics/llm/cost-daily?startDate=2026-06-15&endDate=2026-6-17",
      "/analytics/llm/cost-daily?startDate=2026-06-18&endDate=2026-06-15",
      "/analytics/llm/cost-daily?startDate=2024-01-01&endDate=2026-06-15",
    ]) {
      const res = await authed(url);
      expect(res.status).toBe(400);
    }
  });

  it("endDate 传今日被钳到昨日，series 不含今日", async () => {
    const now = new Date();
    const today = reportDateInTimezone(now, DEFAULT_REPORT_TIMEZONE);
    const yesterday = shiftReportDate(today, -1);
    const res = await authed(
      `/analytics/llm/cost-daily?startDate=${yesterday}&endDate=${today}`,
    );
    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data.range.endDate).toBe(yesterday);
    expect(data.range.clamped).toBe(true);
    expect(data.range.days).toBe(1);
    for (const item of data.series) {
      expect(item.date <= yesterday).toBe(true);
    }
  });

  it("cost-daily：小模型走账单真值（含负数退款）、主模型走快照估算", async () => {
    const res = await authed(
      "/analytics/llm/cost-daily?startDate=2026-06-15&endDate=2026-06-17",
    );
    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
    const data = res.body.data;

    expect(data.currency).toBe("CNY");
    expect(data.range).toMatchObject({
      startDate: "2026-06-15",
      endDate: "2026-06-17",
      clamped: false,
      days: 3,
    });

    const [day15, day16, day17] = data.series;
    // 0.4 - 0.1 = 0.3 元账单；主模型 (123456 + 1000) micro = 0.124456 元
    expect(day15).toMatchObject({
      date: "2026-06-15",
      smallCny: 0.3,
      mainCny: 0.124456,
      otherCny: 0,
      totalCny: 0.424456,
      smallTokens: 2200,
      mainTokens: 1650,
      smallSource: "bill",
      mainSource: "estimated",
      mainAccuracy: "mixed",
      settled: true,
    });
    expect(day15.smallCnyPerMillionTokens).toBe(136.3636);
    expect(day15.mainCnyPerMillionTokens).toBe(75.4279);

    // 无账单日：smallCny 为 null 而不是 0
    expect(day16).toMatchObject({
      date: "2026-06-16",
      smallCny: null,
      mainCny: 0.2,
      totalCny: 0.2,
      settled: null,
      mainAccuracy: "exact",
    });

    // 未终账日：账单在，settled=false（前端据此标「暂估」）
    expect(day17).toMatchObject({
      date: "2026-06-17",
      smallCny: 0.9,
      mainCny: null,
      totalCny: 0.9,
      settled: false,
    });

    expect(data.totals).toMatchObject({
      smallCny: 1.2,
      mainCny: 0.324456,
      totalCny: 1.524456,
      partial: false,
      days: 3,
      unpricedRows: 0,
      noTokenRows: 0,
    });

    // 未配置凭证：如实报 unconfigured，但账单表里有数据 → 金额仍来自库
    expect(data.sources.aliyun).toMatchObject({
      status: "ok",
      kind: "bill",
      modelSplit: true,
      daysWithData: 2,
      message: null,
    });
    // 3 行 deepseek（其中 1 行无缓存命中数）+ 1 行 qwen-flash，deepseek 源只统计主模型
    expect(data.sources.deepseek).toMatchObject({
      status: "ok",
      kind: "estimated",
      rows: 3,
      pricedRows: 3,
      cacheHitRows: 2,
      upperBoundRows: 1,
      cacheTokenAvailable: true,
    });
    expect(data.pricing.lines.length).toBeGreaterThan(0);

    const byModel = Object.fromEntries(
      data.unitEconomics.map((row: { model: string }) => [row.model, row]),
    );
    // 单位经济性按整个请求区间算（含未终账的 06-17）：0.4 - 0.1 + 0.9 = 1.2 元
    expect(byModel["qwen-flash"]).toMatchObject({
      tier: "small",
      source: "bill",
      cny: 1.2,
      tokens: 2200,
      tokenActiveDevices: 1,
      daysWithData: 1,
      cnyPerDevicePerDay: 1.2,
    });
    expect(byModel["qwen-flash"].cnyPerMillionTokens).toBe(545.4545);
    expect(byModel["deepseek-flash"]).toMatchObject({
      tier: "main",
      source: "estimated",
      cny: 0.324456,
      tokenActiveDevices: 1,
      daysWithData: 2,
    });
    // 324456 micro / 1970 已计价 token = 164.6985 元每百万 token
    expect(byModel["deepseek-flash"].cnyPerMillionTokens).toBe(164.6985);

    // 对账只比已终账日（06-15）：估算 0.005 元 vs 账单 0.3 元
    expect(data.reconciliation).toMatchObject({
      status: "ok",
      days: 1,
      smallEstimatedCny: 0.005,
      smallBilledCny: 0.3,
    });
    expect(data.reconciliation.deltaPct).toBe(-98.3333);

    // 本月块跟随「昨日所在账期」，与请求区间解耦；e2e 库里该账期没有已计价数据
    // → 金额一律 null（拿不到数据 ≠ ¥0），partial=true
    expect(data.month.cycle).toMatch(/^\d{4}-\d{2}$/);
    expect(data.month.daysInCycle).toBeGreaterThanOrEqual(28);
    expect(data.month.toDateCny).toBeNull();
    expect(data.month.projectedEndCny).toBeNull();
    expect(data.month.partial).toBe(true);
  });

  it("cost/sync：未配置阿里云凭证时返回 unconfigured，不写库", async () => {
    const before = await prisma.llmCostDaily.count();
    const res = await request(app.getHttpServer())
      .post("/analytics/llm/cost/sync")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(201);
    expect(res.body.code).toBe(0);
    expect(res.body.data).toMatchObject({
      status: "unconfigured",
      latestBillDate: null,
      days: [],
    });
    expect(res.body.data.message).toMatch(/未配置/);
    expect(await prisma.llmCostDaily.count()).toBe(before);
  });
});
