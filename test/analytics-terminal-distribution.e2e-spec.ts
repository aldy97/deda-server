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
const USER_SECRET = process.env.JWT_SECRET || "dev-jwt-secret";
const START = "2099-01-01";
const END = "2099-01-02";

/**
 * 对话网络 / 家长手机厂商 e2e：真实 DB + 真实鉴权。
 * 关键断言：删除全部 messages 后，两个接口结果不变（聚合表与 users 独立于消息）。
 */
describe("Analytics terminal distribution (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;

  const suffix = randomUUID().slice(0, 8);
  const deviceAId = `net-e2e-a-${suffix}`;
  const deviceBId = `net-e2e-b-${suffix}`;
  const openidPrefix = `net-e2e-${suffix}`;
  let deviceAInternalId: string;
  let deviceBInternalId: string;
  let userIds: string[] = [];

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

    const deviceA = await prisma.device.create({
      data: { deviceId: deviceAId, characterKey: "elly" },
    });
    const deviceB = await prisma.device.create({
      data: { deviceId: deviceBId, characterKey: "elly" },
    });
    deviceAInternalId = deviceA.id;
    deviceBInternalId = deviceB.id;

    await prisma.conversationNetworkDaily.createMany({
      data: [
        {
          date: START,
          deviceId: deviceAId,
          wifiTurns: 2,
          fourGTurns: 1,
          unknownTurns: 0,
          firstSeenAt: new Date("2099-01-01T02:00:00Z"),
          lastSeenAt: new Date("2099-01-01T03:00:00Z"),
        },
        {
          date: END,
          deviceId: deviceBId,
          wifiTurns: 0,
          fourGTurns: 1,
          unknownTurns: 2,
          firstSeenAt: new Date("2099-01-02T02:00:00Z"),
          lastSeenAt: new Date("2099-01-02T03:00:00Z"),
        },
      ],
    });

    const users = await Promise.all([
      prisma.user.create({
        data: { openid: `${openidPrefix}-apple`, phoneBrand: "Apple" },
      }),
      prisma.user.create({
        data: { openid: `${openidPrefix}-redmi`, phoneBrand: "Redmi" },
      }),
      prisma.user.create({
        data: { openid: `${openidPrefix}-huawei`, phoneBrand: "HUAWEI" },
      }),
      prisma.user.create({ data: { openid: `${openidPrefix}-unknown` } }),
    ]);
    userIds = users.map((u) => u.id);

    // 仅用于验证「删光 messages 不影响聚合」的消息行
    await prisma.message.createMany({
      data: [
        {
          deviceId: deviceAInternalId,
          turnId: `turn-${suffix}-1`,
          role: "user",
          content: "你好",
          spokeAt: new Date("2099-01-01T02:00:00Z"),
        },
        {
          deviceId: deviceAInternalId,
          turnId: `turn-${suffix}-2`,
          role: "user",
          content: "再见",
          spokeAt: new Date("2099-01-01T03:00:00Z"),
        },
        {
          deviceId: deviceBInternalId,
          turnId: `turn-${suffix}-3`,
          role: "user",
          content: "晚安",
          spokeAt: new Date("2099-01-02T02:00:00Z"),
        },
      ],
    });
  });

  afterAll(async () => {
    await prisma.message.deleteMany({
      where: { deviceId: { in: [deviceAInternalId, deviceBInternalId] } },
    });
    await prisma.conversationNetworkDaily.deleteMany({
      where: { deviceId: { in: [deviceAId, deviceBId] } },
    });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.device.deleteMany({
      where: { id: { in: [deviceAInternalId, deviceBInternalId] } },
    });
    await app.close();
  });

  const authedGet = (url: string) =>
    request(app.getHttpServer())
      .get(url)
      .set("Authorization", `Bearer ${adminToken}`);

  it("无 token 返回 401", async () => {
    const res = await request(app.getHttpServer()).get(
      `/analytics/engagement/network-usage?startDate=${START}&endDate=${END}`,
    );
    expect(res.status).toBe(401);
  });

  it("网络分布返回聚合计数；删光 messages 后结果不变", async () => {
    const url = `/analytics/engagement/network-usage?startDate=${START}&endDate=${END}`;
    const before = await authedGet(url);
    expect(before.status).toBe(200);
    expect(before.body.code).toBe(0);
    expect(before.body.data).toMatchObject({
      totalTurns: 6,
      knownTurns: 4,
      unknownTurns: 2,
      coverage: 0.6667,
      deviceCount: 2,
      firstTrackedDate: START,
      wifi: { turns: 2, devices: 1, shareOfKnown: 0.5, shareOfTotal: 0.3333 },
      fourG: { turns: 2, devices: 2, shareOfKnown: 0.5, shareOfTotal: 0.3333 },
      unknown: { turns: 2, devices: 1, shareOfTotal: 0.3333 },
    });
    expect(before.body.data.series).toHaveLength(2);

    await prisma.message.deleteMany({
      where: { deviceId: { in: [deviceAInternalId, deviceBInternalId] } },
    });

    const after = await authedGet(url);
    expect(after.body.data).toEqual(before.body.data);
  });

  it("手机厂商分布读 users 当前快照；删光 messages 后结果不变", async () => {
    const before = await authedGet("/analytics/users/phone-brands");
    expect(before.status).toBe(200);
    expect(before.body.code).toBe(0);

    const apple = before.body.data.brands.find(
      (b: any) => b.makerKey === "apple",
    );
    const xiaomi = before.body.data.brands.find(
      (b: any) => b.makerKey === "xiaomi",
    );
    const huawei = before.body.data.brands.find(
      (b: any) => b.makerKey === "huawei",
    );
    expect(apple.users).toBeGreaterThanOrEqual(1);
    expect(xiaomi.users).toBeGreaterThanOrEqual(1);
    expect(huawei.users).toBeGreaterThanOrEqual(1);
    expect(before.body.data.totalUsers).toBeGreaterThanOrEqual(4);
    expect(before.body.data.unknownUsers).toBeGreaterThanOrEqual(1);

    await prisma.message.deleteMany({
      where: { deviceId: { in: [deviceAInternalId, deviceBInternalId] } },
    });

    const after = await authedGet("/analytics/users/phone-brands");
    expect(after.body.data).toEqual(before.body.data);
  });

  it("POST /users/client-info 更新品牌；空品牌 skipped 不覆盖", async () => {
    const userId = userIds[0];
    const token = await new JwtService({ secret: USER_SECRET }).signAsync({
      sub: userId,
      openid: `${openidPrefix}-apple`,
    });

    const res = await request(app.getHttpServer())
      .post("/users/client-info")
      .set("Authorization", `Bearer ${token}`)
      .send({ brand: "HONOR" });
    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({ success: true, skipped: false });

    const updated = await prisma.user.findUnique({ where: { id: userId } });
    expect(updated?.phoneBrand).toBe("HONOR");

    const empty = await request(app.getHttpServer())
      .post("/users/client-info")
      .set("Authorization", `Bearer ${token}`)
      .send({ brand: "   " });
    expect(empty.body.data).toEqual({ success: true, skipped: true });

    const unchanged = await prisma.user.findUnique({ where: { id: userId } });
    expect(unchanged?.phoneBrand).toBe("HONOR");
  });

  it("消息详情返回 networkMode 审计字段", async () => {
    const message = await prisma.message.findFirst({
      where: { deviceId: deviceAInternalId },
      orderBy: { spokeAt: "asc" },
    });
    // 前面用例已删除该设备消息，这里补一条带网络快照的行再查详情
    const created = await prisma.message.create({
      data: {
        deviceId: deviceAInternalId,
        turnId: `turn-detail-${suffix}`,
        role: "user",
        content: "详情网络",
        networkMode: "wifi",
        spokeAt: new Date("2099-01-03T02:00:00Z"),
      },
    });
    const res = await authedGet(`/analytics/messages/${created.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.networkMode).toBe("wifi");
    expect(message).toBeNull();
  });
});
