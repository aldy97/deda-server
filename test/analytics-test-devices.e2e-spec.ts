import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import * as dotenv from "dotenv";
import * as request from "supertest";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/common/prisma/prisma.service";
import { ResponseInterceptor } from "../src/common/interceptors/response.interceptor";
import { HttpExceptionFilter } from "../src/common/filters/http-exception.filter";

dotenv.config();

// 三个开关必须在 AppModule 初始化前写进 process.env：ConfigService 读的是进程环境。
process.env.ADVENTURE_TEST_MODE_ENABLED = "true";
process.env.SLEEP_TEST_MODE_ENABLED = "true";
process.env.CONTENT_ADMIN_PROFILE = "authoring";

const ANALYTICS_SECRET =
  process.env.ANALYTICS_JWT_SECRET || "dev-analytics-jwt-secret";

/**
 * 测试设备白名单 e2e：真实 AppModule + 真实 DB（TEST_DATABASE_URL 隔离库）+ 真实鉴权。
 *
 * 单测证明的是服务语义；这里补唯一无法在单测证明的那一段：
 * HTTP → ValidationPipe → SuperAdminGuard → 服务 → Prisma → Postgres，
 * 以及「下发前必须过白名单」这条跨模块约束确实在真实请求里生效。
 */
describe("Analytics test-devices (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let superToken: string;
  let plainToken: string;

  const suffix = `${Date.now()}`;
  const deviceId = `e2e:aa:bb:cc:dd:${suffix.slice(-4)}`;
  const deviceCode = `E2E-TD-${suffix}`;
  const macAddress = `EE:EE:EE:EE:${suffix.slice(-4)}`;
  const episodeNumber = Number(suffix.slice(-6));
  const reason = "端到端验证测试设备白名单";

  let deviceInternalId = "";
  let episodeId = "";

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

    const device = await prisma.device.create({
      data: {
        deviceId,
        deviceCode,
        macAddress,
        characterKey: "elly",
      },
    });
    deviceInternalId = device.id;

    const episode = await prisma.adventureEpisode.create({
      data: {
        characterKey: "elly",
        season: 1,
        episodeNumber,
        title: `E2E 白名单验证集 ${suffix}`,
        published: true,
      },
    });
    episodeId = episode.id;

    const jwt = new JwtService({ secret: ANALYTICS_SECRET });
    superToken = await jwt.signAsync({
      sub: "e2e-super",
      username: "e2e-super",
      displayName: "E2E Super",
      scope: "analytics",
      role: "superadmin",
    });
    plainToken = await jwt.signAsync({
      sub: "e2e-ops",
      username: "e2e-ops",
      displayName: "E2E Ops",
      scope: "analytics",
      role: "admin",
    });
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.adventureContentAuditLog.deleteMany({
        where: { businessKey: deviceId },
      });
      await prisma.device.deleteMany({ where: { id: deviceInternalId } });
      await prisma.adventureEpisode.deleteMany({ where: { id: episodeId } });
    }
    await app?.close();
  });

  function get(url: string, token?: string) {
    const req = request(app.getHttpServer()).get(url);
    return token ? req.set("Authorization", `Bearer ${token}`) : req;
  }

  function post(url: string, body: object, token?: string) {
    const req = request(app.getHttpServer()).post(url).send(body);
    return token ? req.set("Authorization", `Bearer ${token}`) : req;
  }

  it("未登录 → 401", async () => {
    const res = await get("/analytics/test-devices");
    expect(res.status).toBe(401);
  });

  it("普通 admin → 403，读写都进不来", async () => {
    const list = await get("/analytics/test-devices", plainToken);
    expect(list.status).toBe(403);

    const add = await post(
      "/analytics/test-devices",
      { deviceId: deviceCode, reason },
      plainToken,
    );
    expect(add.status).toBe(403);
  });

  it("superadmin 可读列表，enabled 如实反映两个测试开关", async () => {
    const res = await get("/analytics/test-devices", superToken);

    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
    expect(res.body.data.enabled).toEqual({ adventure: true, sleep: true });
    expect(res.body.data.items).toEqual([]);
  });

  it("添加设备编码 → 在册；重复添加 → 409", async () => {
    const created = await post(
      "/analytics/test-devices",
      { deviceId: deviceCode, note: "e2e 样机", reason },
      superToken,
    );
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({
      reactivated: false,
      item: {
        active: true,
        addedBy: "e2e-super",
        note: "e2e 样机",
        device: { deviceId, deviceCode },
      },
    });

    const duplicate = await post(
      "/analytics/test-devices",
      { deviceId: deviceCode, reason },
      superToken,
    );
    expect(duplicate.status).toBe(409);
  });

  it("关键字搜索能按设备编码命中", async () => {
    const res = await get(
      `/analytics/test-devices?keyword=${encodeURIComponent(deviceCode)}`,
      superToken,
    );
    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(1);
  });

  it("理由不足 8 字 → 400", async () => {
    const res = await post(
      "/analytics/test-devices",
      { deviceId: deviceCode, reason: "太短" },
      superToken,
    );
    expect(res.status).toBe(400);
  });

  it("设备不存在 → 404", async () => {
    const res = await post(
      "/analytics/test-devices",
      { deviceId: "no-such-device", reason },
      superToken,
    );
    expect(res.status).toBe(404);
  });

  it("白名单设备可下发测试冒险故事；未在白名单 → 403 且不写库", async () => {
    const before = await get(
      `/analytics/adventure-admin/device-test/assignment/${deviceId}`,
      superToken,
    );
    expect(before.body.data).toMatchObject({
      enabled: true,
      whitelisted: true,
      assignment: null,
    });

    const assigned = await post(
      `/analytics/adventure-admin/episodes/${episodeId}/test-assign`,
      { deviceId, reason },
      superToken,
    );
    expect(assigned.status).toBe(201);
    expect(assigned.body.data.assignment).toMatchObject({
      episodeId,
      versionStatus: "published",
    });

    const afterAssign = await get(
      `/analytics/adventure-admin/device-test/assignment/${deviceId}`,
      superToken,
    );
    expect(afterAssign.body.data.assignment.episode.id).toBe(episodeId);

    // 撤销白名单：下发字段被清空
    const revoked = await post(
      `/analytics/test-devices/${encodeURIComponent(deviceCode)}/revoke`,
      { reason: "端到端验证结束收回" },
      superToken,
    );
    expect(revoked.status).toBe(201);
    expect(revoked.body.data).toEqual({
      ok: true,
      clearedAdventureAssignment: true,
    });

    const afterRevoke = await get(
      `/analytics/adventure-admin/device-test/assignment/${deviceId}`,
      superToken,
    );
    expect(afterRevoke.body.data).toMatchObject({
      enabled: true,
      whitelisted: false,
      assignment: null,
    });

    const blocked = await post(
      `/analytics/adventure-admin/episodes/${episodeId}/test-assign`,
      { deviceId, reason },
      superToken,
    );
    expect(blocked.status).toBe(403);
  });

  it("撤销后默认列表看不到，includeRevoked 能看到；重新添加是原地恢复", async () => {
    const activeOnly = await get("/analytics/test-devices", superToken);
    expect(activeOnly.body.data.total).toBe(0);

    const withRevoked = await get(
      "/analytics/test-devices?includeRevoked=true",
      superToken,
    );
    expect(withRevoked.body.data.total).toBe(1);
    expect(withRevoked.body.data.items[0]).toMatchObject({
      active: false,
      revokedBy: "e2e-super",
    });

    const restored = await post(
      "/analytics/test-devices",
      { deviceId: deviceMacOrCode(), reason },
      superToken,
    );
    expect(restored.status).toBe(201);
    expect(restored.body.data.reactivated).toBe(true);
    expect(restored.body.data.item.active).toBe(true);
  });

  /** 这次用 MAC 地址再验一条设备解析路径。 */
  function deviceMacOrCode() {
    return macAddress;
  }
});
