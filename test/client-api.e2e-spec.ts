import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { createHash, randomUUID } from "crypto";
import * as request from "supertest";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/common/prisma/prisma.service";
import { ResponseInterceptor } from "../src/common/interceptors/response.interceptor";
import { HttpExceptionFilter } from "../src/common/filters/http-exception.filter";

/**
 * client-api（机芯厂设备侧 HTTP）+ 配网认领链路 e2e。
 * 使用隔离测试库（TEST_DATABASE_URL，库名含 test）；Redis 走内存模式
 * （e2e-database.setup.ts 置空 REDIS_URL）；不触达真实机芯厂/百度网络。
 */

const E2E_MAC_KEY = "e2e-mac-key";
const E2E_LLM_API_KEY = "e2e-llm-api-key";

// 必须在 AppModule 编译前就位：ClientApiService 构造时读取
process.env.DEVICE_LOGIN_MAC_KEY = E2E_MAC_KEY;
process.env.LLM_ADAPTER_API_KEY = E2E_LLM_API_KEY;

/** 与协议 3.1 节一致：md5_ascii(md5_utf8(macKey + mac).hexdigest()).hexdigest() */
const loginPassword = (mac: string): string =>
  createHash("md5")
    .update(
      createHash("md5")
        .update(E2E_MAC_KEY + mac, "utf8")
        .digest("hex"),
      "ascii",
    )
    .digest("hex");

describe("client-api + provision claim (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let userId: string;
  let token: string;
  let mac: string;

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
    jwtService = moduleFixture.get(JwtService);
  });

  beforeEach(async () => {
    const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
    // 合法 MAC 形态（12 位 hex），各用例独立避免污染
    mac = suffix.replace(/[^0-9a-f]/g, "a").slice(0, 12);
    const user = await prisma.user.create({
      data: { openid: `client-api-e2e-${suffix}` },
    });
    userId = user.id;
    token = jwtService.sign({ sub: userId, openid: user.openid });
  });

  afterEach(async () => {
    await prisma.userDeviceBinding.deleteMany({ where: { userId } });
    await prisma.device.deleteMany({ where: { deviceId: mac } });
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  afterAll(async () => {
    await app.close();
  });

  const loginMac = (overMac = mac, password = loginPassword(overMac)) =>
    request(app.getHttpServer())
      .post("/client/user/user/loginMac")
      .send({ mac: overMac, password });

  const botStart = (overMac = mac, instanceid = "9223372036854775806") =>
    request(app.getHttpServer()).post("/client/bot/bot/start").send({
      mac: overMac,
      appid: "baidu-app-e2e",
      instanceid,
      authorization: "e2e-baidu-control-auth",
      cloud_node: "cn",
      lang: "zh",
    });

  const botStop = (overMac = mac, instanceid = "9223372036854775806") =>
    request(app.getHttpServer())
      .post("/client/bot/bot/stop")
      .send({ mac: overMac, instanceid });

  const candidates = (authToken = token) =>
    request(app.getHttpServer())
      .get("/devices/provision-candidates")
      .set("Authorization", `Bearer ${authToken}`);

  it("loginMac success: 200 + Authorization header + device created", async () => {
    const response = await loginMac().expect(200);

    expect(response.headers.authorization).toBe(E2E_LLM_API_KEY);
    expect(response.body).toEqual({
      code: 200,
      data: { id: mac, nickname: `设备 ${mac.slice(-6)}`, lang: "zh" },
      msg: "success",
    });
    const device = await prisma.device.findUnique({
      where: { deviceId: mac },
    });
    expect(device).not.toBeNull();
    expect(device?.macAddress).toBe(mac);
  });

  it("loginMac normalizes uppercase mac with separators", async () => {
    const withSeparators =
      `${mac.slice(0, 2)}:${mac.slice(2, 4)}:${mac.slice(4, 6)}:${mac.slice(6, 8)}:${mac.slice(8, 10)}:${mac.slice(10, 12)}`.toUpperCase();
    const response = await loginMac(withSeparators, loginPassword(mac)).expect(
      200,
    );
    expect(response.body.data.id).toBe(mac);
  });

  it("loginMac rejects wrong password with 401 and creates nothing", async () => {
    await loginMac(mac, "0".repeat(32)).expect(401);
    expect(
      await prisma.device.findUnique({ where: { deviceId: mac } }),
    ).toBeNull();
  });

  it("loginMac rejects malformed mac with 400", async () => {
    await loginMac("not-a-mac", loginPassword("not-a-mac")).expect(400);
  });

  it("loginMac is idempotent for repeated online reports", async () => {
    await loginMac().expect(200);
    await loginMac().expect(200);
    expect(await prisma.device.count({ where: { deviceId: mac } })).toBe(1);
  });

  it("bot start/stop lifecycle with idempotency and conflict rules", async () => {
    // 未上线设备：401
    await botStart().expect(401);
    await botStop().expect(401);

    await loginMac().expect(200);

    // start → 200；同实例重复 start 幂等
    await botStart().expect(200);
    await botStart().expect(200);

    // stop → 200；重复 stop 幂等
    await botStop().expect(200);
    await botStop().expect(200);

    // 已结束实例被延迟 start 复活 → 409
    await botStart().expect(409);

    // 未知实例 stop → 404
    await botStop(mac, "12345").expect(404);

    // 新一轮实例正常登记与结束
    await botStart(mac, "111").expect(200);
    await botStop(mac, "111").expect(200);
  });

  it("provision candidates: visible after loginMac, gone after bind, requires JWT", async () => {
    await request(app.getHttpServer())
      .get("/devices/provision-candidates")
      .expect(401);

    await loginMac().expect(200);

    const before = await candidates().expect(200);
    expect(before.body.code).toBe(0);
    const found = before.body.data.devices.find(
      (d: { deviceId: string }) => d.deviceId === mac,
    );
    expect(found).toBeDefined();
    expect(found.macTail).toBe(mac.slice(-6));
    expect(typeof found.lastSeenAt).toBe("string");

    // 绑定后从候选消失
    await request(app.getHttpServer())
      .post("/devices/bind")
      .set("Authorization", `Bearer ${token}`)
      .send({ deviceId: mac })
      .expect(201);

    const after = await candidates().expect(200);
    expect(
      after.body.data.devices.find(
        (d: { deviceId: string }) => d.deviceId === mac,
      ),
    ).toBeUndefined();
  });
});
