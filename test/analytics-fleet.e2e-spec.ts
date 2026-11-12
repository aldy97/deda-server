import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { randomUUID } from "crypto";
import * as dotenv from "dotenv";
import * as request from "supertest";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/common/prisma/prisma.service";
import { DeviceLinkService } from "../src/modules/device-link/device-link.service";
import { ResponseInterceptor } from "../src/common/interceptors/response.interceptor";
import { HttpExceptionFilter } from "../src/common/filters/http-exception.filter";

dotenv.config();

const ANALYTICS_SECRET =
  process.env.ANALYTICS_JWT_SECRET || "dev-analytics-jwt-secret";

/**
 * Fleet 分析接口 e2e：真实 DB（TEST_DATABASE_URL 隔离库）+ 真实鉴权 + mock Redis。
 *
 * 覆盖 6 个端点：summary / presence-trend / firmware-distribution / churn-risk /
 * devices（分页+keyword+分页 clamp）/ devices/:deviceId（含 404）。
 * 日期区间 2026-07-11 ~ 2026-07-13（避开其他 e2e 套件用的 2026-10/11）。
 */
describe("Analytics fleet (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;

  const suffix = randomUUID().slice(0, 8);
  const macPrefix = `fe0000000${parseInt(suffix.slice(0, 2), 16) % 10}`;
  const d1Id = `${macPrefix}01`;
  const d2Id = `${macPrefix}02`;
  let d1Uuid: string;
  let d2Uuid: string;
  let testUserId: string;

  // mock Redis status data
  const mockGetStatusBatch = jest.fn();

  beforeAll(async () => {
    process.env.REDIS_URL = "";

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(DeviceLinkService)
      .useValue({ getStatusBatch: mockGetStatusBatch })
      .compile();

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

    // Create a test user for bindings
    const user = await prisma.user.create({
      data: { openid: `fleet-e2e-${suffix}` },
    });
    testUserId = user.id;

    // Create devices
    const d1 = await prisma.device.create({
      data: {
        deviceId: d1Id,
        characterKey: "elly",
        macAddress: d1Id.toUpperCase(),
        firmwareVersion: "1.2.3",
        deviceCode: "EL-D01",
        wifiName: "HomeWiFi",
        createdAt: new Date("2026-07-10T12:00:00Z"),
      },
    });
    d1Uuid = d1.id;

    const d2 = await prisma.device.create({
      data: {
        deviceId: d2Id,
        characterKey: "pony",
        firmwareVersion: null,
        createdAt: new Date("2026-07-12T00:00:00Z"),
      },
    });
    d2Uuid = d2.id;

    // Create bindings (activated devices)
    await prisma.userDeviceBinding.create({
      data: {
        deviceId: d1Uuid,
        userId: testUserId,
        isOwner: true,
        createdAt: new Date("2026-07-10T12:00:00Z"),
      },
    });

    // Create messages
    const turn1 = randomUUID();
    const turn2 = randomUUID();
    await prisma.message.createMany({
      data: [
        {
          deviceId: d1Uuid,
          turnId: turn1,
          role: "user",
          content: "hello",
          status: "completed",
          spokeAt: new Date("2026-07-11T03:00:00Z"), // Asia/Shanghai 2026-07-11 11:00
        },
        {
          deviceId: d1Uuid,
          turnId: turn2,
          role: "user",
          content: "hello again",
          status: "completed",
          spokeAt: new Date("2026-07-11T05:00:00Z"), // Asia/Shanghai 2026-07-11 13:00
        },
        {
          deviceId: d1Uuid,
          turnId: turn1,
          role: "assistant",
          content: "hi",
          status: "completed",
          spokeAt: new Date("2026-07-11T03:00:01Z"),
        },
      ],
    });

    // Create presence records
    await prisma.devicePresenceDaily.createMany({
      data: [
        {
          deviceId: d1Uuid,
          date: "2026-07-11",
          reportCount: 5,
          firstSeenAt: new Date("2026-07-11T00:05:00Z"),
          lastSeenAt: new Date("2026-07-11T23:55:00Z"),
        },
        {
          deviceId: d1Uuid,
          date: "2026-07-12",
          reportCount: 3,
          firstSeenAt: new Date("2026-07-12T00:02:00Z"),
          lastSeenAt: new Date("2026-07-12T12:00:00Z"),
        },
      ],
    });
  });

  afterAll(async () => {
    // Cleanup in reverse order
    await prisma.message.deleteMany({
      where: { deviceId: { in: [d1Uuid, d2Uuid] } },
    });
    await prisma.devicePresenceDaily.deleteMany({
      where: { deviceId: { in: [d1Uuid, d2Uuid] } },
    });
    await prisma.userDeviceBinding.deleteMany({
      where: { deviceId: { in: [d1Uuid, d2Uuid] } },
    });
    await prisma.device.deleteMany({
      where: { deviceId: { in: [d1Id, d2Id] } },
    });
    await prisma.user.deleteMany({ where: { id: testUserId } });
    await app.close();
  });

  // ── helpers ──────────────────────────────────────────────────────────

  function get(path: string) {
    return request(app.getHttpServer())
      .get(path)
      .set("Authorization", `Bearer ${adminToken}`);
  }

  // ── 1. Summary ───────────────────────────────────────────────────────

  describe("GET /analytics/fleet/summary", () => {
    it("returns envelope with code=0 and summary data", async () => {
      // Set mock Redis: device 1 online with battery 80
      mockGetStatusBatch.mockResolvedValue(
        new Map([
          [
            d1Id.toUpperCase(),
            {
              mac: d1Id.toUpperCase(),
              battery: 80,
              volume: 50,
              version: "1.2.3",
              charging: false,
              lastSeenAt: Date.now() - 5_000,
              online: true,
            },
          ],
        ]),
      );

      const res = await get("/analytics/fleet/summary?date=2026-07-11");

      expect(res.status).toBe(200);
      expect(res.body.code).toBe(0);
      const data = res.body.data;
      expect(data.date).toBe("2026-07-11");
      expect(data.totalDevices).toBe(1); // d2 created 2026-07-12, after query date
      expect(data.activatedDevices).toBeGreaterThanOrEqual(1);
      expect(data.devicesPoweredOn).toBe(1);
      expect(data.powerOnRate).toBeGreaterThan(0);
      expect(data.onlineNow).toBe(1);
      expect(data.lowBatteryThreshold).toBe(20);
    });

    it("returns onlineNow=null when Redis fails", async () => {
      mockGetStatusBatch.mockRejectedValue(
        new Error("Redis connection refused"),
      );

      const res = await get("/analytics/fleet/summary?date=2026-07-11");

      expect(res.status).toBe(200);
      expect(res.body.data.onlineNow).toBeNull();
      expect(res.body.data.lowBatteryNow).toBeNull();
    });

    it("returns 400 for invalid date", async () => {
      const res = await get("/analytics/fleet/summary?date=invalid");

      expect(res.status).toBe(400);
    });
  });

  // ── 2. Presence Trend ─────────────────────────────────────────────────

  describe("GET /analytics/fleet/presence-trend", () => {
    it("returns daily series for the requested range", async () => {
      const res = await get(
        "/analytics/fleet/presence-trend?startDate=2026-07-11&endDate=2026-07-13",
      );

      expect(res.status).toBe(200);
      expect(res.body.code).toBe(0);
      const data = res.body.data;
      expect(data.startDate).toBe("2026-07-11");
      expect(data.endDate).toBe("2026-07-13");
      expect(data.series).toHaveLength(3);
      // 2026-07-11 has presence data
      expect(data.series[0]).toMatchObject({
        date: "2026-07-11",
        devicesPoweredOn: 1,
      });
      // 2026-07-12 has presence data
      expect(data.series[1]).toMatchObject({
        date: "2026-07-12",
        devicesPoweredOn: 1,
      });
      // 2026-07-13 has no presence data
      expect(data.series[2].date).toBe("2026-07-13");
    });

    it("returns 400 when startDate > endDate", async () => {
      const res = await get(
        "/analytics/fleet/presence-trend?startDate=2026-07-13&endDate=2026-07-11",
      );

      expect(res.status).toBe(400);
    });

    it("returns 400 when range exceeds 62 days", async () => {
      const res = await get(
        "/analytics/fleet/presence-trend?startDate=2026-07-01&endDate=2026-09-30",
      );

      expect(res.status).toBe(400);
    });
  });

  // ── 3. Firmware Distribution ─────────────────────────────────────────

  describe("GET /analytics/fleet/firmware-distribution", () => {
    it("returns firmware buckets with unknown fallback", async () => {
      const res = await get("/analytics/fleet/firmware-distribution");

      expect(res.status).toBe(200);
      expect(res.body.code).toBe(0);
      const data = res.body.data;
      expect(data.total).toBeGreaterThanOrEqual(2);

      const versions = data.buckets.map(
        (b: { firmwareVersion: string }) => b.firmwareVersion,
      );
      expect(versions).toContain("1.2.3");
      expect(versions).toContain("unknown");

      // "unknown" should be last
      expect(versions[versions.length - 1]).toBe("unknown");
    });
  });

  // ── 4. Churn Risk ────────────────────────────────────────────────────

  describe("GET /analytics/fleet/churn-risk", () => {
    it("returns devices with daysInactive >= threshold", async () => {
      const res = await get("/analytics/fleet/churn-risk?days=1");

      expect(res.status).toBe(200);
      expect(res.body.code).toBe(0);
      const data = res.body.data;
      expect(data.days).toBe(1);
      expect(typeof data.asOf).toBe("string");
      expect(Array.isArray(data.devices)).toBe(true);
      expect(data.count).toBe(data.devices.length);

      // d2 (created 2026-07-12) has no messages/presence → daysInactive should be based on createdAt
      const d2risk = data.devices.find(
        (d: { deviceId: string }) => d.deviceId === d2Id,
      );
      expect(d2risk).toBeDefined();
      expect(d2risk.basis).toBe("createdAt");
    });

    it("returns 400 for days=0", async () => {
      const res = await get("/analytics/fleet/churn-risk?days=0");

      expect(res.status).toBe(400);
    });
  });

  // ── 5. Devices List ──────────────────────────────────────────────────

  describe("GET /analytics/fleet/devices", () => {
    it("returns paginated device list", async () => {
      mockGetStatusBatch.mockResolvedValue(new Map());

      const res = await get("/analytics/fleet/devices?page=1&pageSize=10");

      expect(res.status).toBe(200);
      expect(res.body.code).toBe(0);
      const data = res.body.data;
      expect(data.page).toBe(1);
      expect(data.pageSize).toBe(10);
      expect(data.total).toBeGreaterThanOrEqual(2);
      expect(Array.isArray(data.items)).toBe(true);
      // createdAt desc → d2 before d1
      expect(data.items[0].deviceId).toBe(d2Id);
      // Each item has required fields
      const item = data.items[0];
      expect(item).toHaveProperty("deviceId");
      expect(item).toHaveProperty("deviceUuid");
      expect(item).toHaveProperty("characterKey");
      expect(item).toHaveProperty("presenceDays7d");
      expect(item).toHaveProperty("turns7d");
    });

    it("maps realtime by normalized uppercase MAC key", async () => {
      // d2 无 macAddress → 回落用小写 deviceId 查；getStatusBatch 的 key 是归一化大写
      mockGetStatusBatch.mockResolvedValue(
        new Map([
          [
            d2Id.toUpperCase(),
            {
              mac: d2Id.toUpperCase(),
              battery: 15,
              volume: null,
              version: null,
              charging: null,
              lastSeenAt: Date.now() - 5_000,
              online: true,
            },
          ],
        ]),
      );

      const res = await get("/analytics/fleet/devices?page=1&pageSize=10");

      expect(res.status).toBe(200);
      const d2 = res.body.data.items.find(
        (item: { deviceId: string }) => item.deviceId === d2Id,
      );
      expect(d2.realtime).toEqual({
        online: true,
        battery: 15,
        volume: null,
        version: null,
        charging: null,
        lastSeenAt: expect.any(Number),
      });
    });

    it("filters by keyword (case-insensitive)", async () => {
      mockGetStatusBatch.mockResolvedValue(new Map());

      const res = await get(
        `/analytics/fleet/devices?keyword=${encodeURIComponent("el-d")}&page=1&pageSize=20`,
      );

      expect(res.status).toBe(200);
      const data = res.body.data;
      expect(data.total).toBe(1);
      expect(data.items[0].deviceId).toBe(d1Id);
    });

    it("clamps pageSize > 100 silently", async () => {
      mockGetStatusBatch.mockResolvedValue(new Map());

      const res = await get("/analytics/fleet/devices?page=1&pageSize=999");

      expect(res.status).toBe(200);
      expect(res.body.data.pageSize).toBe(100);
    });

    it("returns 401 without auth", async () => {
      const res = await request(app.getHttpServer()).get(
        "/analytics/fleet/devices",
      );

      expect(res.status).toBe(401);
    });
  });

  // ── 6. Device Detail ─────────────────────────────────────────────────

  describe("GET /analytics/fleet/devices/:deviceId", () => {
    it("returns full device detail", async () => {
      mockGetStatusBatch.mockResolvedValue(new Map());

      const res = await get(`/analytics/fleet/devices/${d1Id}?days=30`);

      expect(res.status).toBe(200);
      expect(res.body.code).toBe(0);
      const data = res.body.data;
      expect(data.deviceId).toBe(d1Id);
      expect(data.firmwareVersion).toBe("1.2.3");
      expect(data.wifiName).toBe("HomeWiFi");
      expect(Array.isArray(data.boundUsers)).toBe(true);
      expect(data.boundUsers.length).toBe(1);
      // boundUsers 只暴露 userId + isOwner + boundAt，不得夹带任何 PII
      expect(Object.keys(data.boundUsers[0]).sort()).toEqual([
        "boundAt",
        "isOwner",
        "userId",
      ]);
      expect(Array.isArray(data.presence)).toBe(true);
      expect(Array.isArray(data.dailyTurns)).toBe(true);
      expect(data.dailyTurns.length).toBe(30); // 30 days filled
      expect(data.totals).toHaveProperty("presenceDays");
      expect(data.totals).toHaveProperty("turns");
    });

    it("returns 404 for nonexistent device", async () => {
      const res = await get("/analytics/fleet/devices/zz0000000099?days=30");

      expect(res.status).toBe(404);
    });

    it("returns 400 for days=0", async () => {
      const res = await get(`/analytics/fleet/devices/${d1Id}?days=0`);

      expect(res.status).toBe(400);
    });
  });
});
