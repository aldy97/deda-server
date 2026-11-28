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
 * 家长视角聚合 e2e：真实 DB + 真实 dashboard JWT。
 * 覆盖响应形状/排序/共享设备 boundUserCount/presence max/404/鉴权/无 openid。
 */
describe("Analytics parents (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;
  let wechatScopeToken: string;

  const suffix = randomUUID().slice(0, 8);
  const parentOpenid = `parent-e2e-${suffix}`;
  const otherOpenid = `parent-e2e-other-${suffix}`;
  const deviceCodeA = `parents-e2e-a-${suffix}`;
  const deviceIdB = `parents-e2e-biz-b-${suffix}`;
  const feedbackId = `feedback-e2e-${suffix}`;

  let parentId: string;
  let otherUserId: string;
  let deviceAInternalId: string;
  let deviceBInternalId: string;

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

    const authJwt = new JwtService({ secret: ANALYTICS_SECRET });
    adminToken = await authJwt.signAsync({
      sub: "admin",
      username: "admin",
      displayName: "管理员",
      scope: "analytics",
    });
    wechatScopeToken = await authJwt.signAsync({
      sub: "user-001",
      username: "user-001",
      scope: "wechat",
    });

    const parent = await prisma.user.create({
      data: {
        openid: parentOpenid,
        nickname: "熊熊妈妈",
        phone: `139${suffix.padStart(8, "0").slice(0, 8)}`,
        phoneBrand: "iPhone15,2",
        gender: "female",
        birthday: "1990-05-20",
      },
    });
    parentId = parent.id;

    const other = await prisma.user.create({
      data: {
        openid: otherOpenid,
        // 与家长同手机号，验证「重复」标记先填后填都成立
        phone: `139${suffix.padStart(8, "0").slice(0, 8)}`,
      },
    });
    otherUserId = other.id;

    const deviceA = await prisma.device.create({
      data: {
        deviceId: deviceCodeA,
        deviceCode: `CODE-A-${suffix}`,
        characterKey: "elly",
        firmwareVersion: "1.2.3",
        networkType: "wifi",
      },
    });
    const deviceB = await prisma.device.create({
      data: { deviceId: deviceIdB, characterKey: "polly" },
    });
    deviceAInternalId = deviceA.id;
    deviceBInternalId = deviceB.id;

    // 家长两台设备：A 排序 1、B 排序 0（验证 sortOrder asc 生效）
    await prisma.userDeviceBinding.createMany({
      data: [
        {
          userId: parentId,
          deviceId: deviceAInternalId,
          isOwner: true,
          sortOrder: 1,
        },
        {
          userId: parentId,
          deviceId: deviceBInternalId,
          isOwner: false,
          sortOrder: 0,
        },
        // 共享设备：另一家长也绑了 A，boundUserCount 应为 2
        {
          userId: otherUserId,
          deviceId: deviceAInternalId,
          isOwner: false,
          sortOrder: 0,
        },
      ],
    });

    // 只有设备 A 有孩子档案
    await prisma.childProfile.create({
      data: {
        userId: parentId,
        deviceId: deviceAInternalId,
        name: "小明",
        englishName: "Ming",
        gender: "male",
        birthday: "2021-05-04",
      },
    });

    await prisma.devicePresenceDaily.createMany({
      data: [
        {
          deviceId: deviceAInternalId,
          date: "2099-01-01",
          reportCount: 3,
          firstSeenAt: new Date("2099-01-01T02:00:00Z"),
          lastSeenAt: new Date("2099-01-01T03:00:00Z"),
        },
        {
          deviceId: deviceAInternalId,
          date: "2099-01-03",
          reportCount: 2,
          firstSeenAt: new Date("2099-01-03T02:00:00Z"),
          lastSeenAt: new Date("2099-01-03T03:00:00Z"),
        },
        {
          deviceId: deviceAInternalId,
          date: "2099-01-02",
          reportCount: 1,
          firstSeenAt: new Date("2099-01-02T02:00:00Z"),
          lastSeenAt: new Date("2099-01-02T03:00:00Z"),
        },
      ],
    });

    await prisma.feedback.create({
      data: { id: feedbackId, userId: parentId, content: "家长反馈内容" },
    });
  });

  afterAll(async () => {
    await prisma.feedback.deleteMany({ where: { id: feedbackId } });
    await prisma.devicePresenceDaily.deleteMany({
      where: { deviceId: { in: [deviceAInternalId, deviceBInternalId] } },
    });
    await prisma.childProfile.deleteMany({
      where: { deviceId: { in: [deviceAInternalId, deviceBInternalId] } },
    });
    await prisma.userDeviceBinding.deleteMany({
      where: { userId: { in: [parentId, otherUserId] } },
    });
    await prisma.user.deleteMany({
      where: { id: { in: [parentId, otherUserId] } },
    });
    await prisma.device.deleteMany({
      where: { id: { in: [deviceAInternalId, deviceBInternalId] } },
    });
    await app.close();
  });

  const authedGet = (url: string) =>
    request(app.getHttpServer())
      .get(url)
      .set("Authorization", `Bearer ${adminToken}`);

  it("无 token → 401", async () => {
    await request(app.getHttpServer())
      .get(`/analytics/parents/${parentId}`)
      .expect(401);
  });

  // 与仓库既有口径一致：AnalyticsJwtStrategy.validate 先按 scope 拒掉，
  // 守卫 handleRequest 里的 403 分支在真实 HTTP 链路上不可达（单测另覆盖）。
  it("非 analytics scope token → 401", async () => {
    const res = await request(app.getHttpServer())
      .get(`/analytics/parents/${parentId}`)
      .set("Authorization", `Bearer ${wechatScopeToken}`)
      .expect(401);
    expect(res.body.data).toBeNull();
  });

  it("家长不存在 → 404", async () => {
    const res = await authedGet(`/analytics/parents/${randomUUID()}`).expect(
      404,
    );
    expect(res.body.code).toBe(404);
  });

  it("返回家长档案、小结、按 sortOrder 排序的设备列表", async () => {
    const res = await authedGet(`/analytics/parents/${parentId}`).expect(200);

    expect(res.body.code).toBe(0);
    const data = res.body.data;

    expect(Object.keys(data.user).sort()).toEqual([
      "birthday",
      "gender",
      "id",
      "nickname",
      "phone",
      "phoneDuplicate",
      "phoneMaker",
      "registeredAt",
    ]);
    expect(data.user).toMatchObject({
      id: parentId,
      nickname: "熊熊妈妈",
      phone: expect.stringMatching(/^139/),
      phoneDuplicate: true,
      gender: "female",
      birthday: "1990-05-20",
      phoneMaker: "Apple",
    });
    expect(data.user.registeredAt).toEqual(expect.any(String));

    expect(data.summary).toEqual({
      deviceCount: 2,
      childCount: 1,
      feedbackCount: 1,
    });

    // sortOrder 0 的 B 在前，A 在后
    expect(data.devices.map((d: any) => d.deviceId)).toEqual([
      deviceIdB,
      deviceCodeA,
    ]);

    const [deviceB, deviceA] = data.devices;
    expect(Object.keys(deviceA).sort()).toEqual([
      "boundAt",
      "boundUserCount",
      "characterKey",
      "childProfile",
      "deviceCode",
      "deviceId",
      "firmwareVersion",
      "isOwner",
      "lastPresenceDate",
      "networkType",
    ]);

    expect(deviceA).toMatchObject({
      deviceId: deviceCodeA,
      deviceCode: `CODE-A-${suffix}`,
      characterKey: "elly",
      firmwareVersion: "1.2.3",
      networkType: "wifi",
      isOwner: true,
      // 共享设备：两个家长都绑了
      boundUserCount: 2,
      // presence 取 max(date)
      lastPresenceDate: "2099-01-03",
      childProfile: {
        name: "小明",
        englishName: "Ming",
        gender: "male",
        birthday: "2021-05-04",
      },
    });
    expect(deviceA.boundAt).toEqual(expect.any(String));

    expect(deviceB).toMatchObject({
      deviceId: deviceIdB,
      deviceCode: null,
      characterKey: "polly",
      firmwareVersion: null,
      networkType: null,
      isOwner: false,
      boundUserCount: 1,
      lastPresenceDate: null,
      childProfile: null,
    });
  });

  it("响应 JSON 里没有 openid（家长本人与共享家长的都不出现）", async () => {
    const res = await authedGet(`/analytics/parents/${parentId}`).expect(200);
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain("openid");
    expect(raw).not.toContain(parentOpenid);
    expect(raw).not.toContain(otherOpenid);
  });

  it("summary 追加 multiDeviceFamilies：该家长计 1（不影响既有字段）", async () => {
    const res = await authedGet("/analytics/users/summary").expect(200);
    expect(res.body.data).toMatchObject({
      multiDeviceFamilies: expect.any(Number),
    });
    expect(Object.keys(res.body.data)).toEqual(
      expect.arrayContaining([
        "totalUsers",
        "newUsersInRange",
        "usersWithBoundDevice",
        "avgDevicesPerUser",
        "multiChildFamilies",
        "multiDeviceFamilies",
      ]),
    );
    expect(res.body.data.multiDeviceFamilies).toBeGreaterThanOrEqual(1);
  });
});
