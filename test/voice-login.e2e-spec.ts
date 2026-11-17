import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import { createHash, randomUUID } from "crypto";
import * as request from "supertest";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/common/prisma/prisma.service";
import { ResponseInterceptor } from "../src/common/interceptors/response.interceptor";
import { HttpExceptionFilter } from "../src/common/filters/http-exception.filter";

/**
 * 设备上线（loginMac）下发初始音色的 e2e。
 *
 * 验证的是真实装配链路：AppModule → VoiceCatalogService（VOICE_CATALOG_JSON）→
 * VoiceReconcileService（CHARACTER_DEFAULT_TIMBRE_JSON / SPEECH_RATE_MAP_JSON）→
 * ClientApiController 响应体。这条链路是给固件用的契约，值得端到端锁一次。
 *
 * 本文件**只调 loginMac，绝不调 bot/start**：BAIDU_AGENT_ENABLED 在这里是打开的，
 * 而 start 追平会拿设备签名去调百度云控制面（AGENTS.md 禁止 e2e 出网）。
 *
 * 使用隔离测试库（TEST_DATABASE_URL，库名含 test）；Redis 走内存模式。
 */

const E2E_MAC_KEY = "e2e-mac-key";
const E2E_LLM_API_KEY = "e2e-llm-api-key";

// 必须在 AppModule 编译前就位：下列服务都在构造函数里读配置
process.env.DEVICE_LOGIN_MAC_KEY = E2E_MAC_KEY;
process.env.LLM_ADAPTER_API_KEY = E2E_LLM_API_KEY;
process.env.BAIDU_AGENT_ENABLED = "true";
process.env.VOICE_CATALOG_JSON =
  '[{"timbreId":"1000063","name":"度小熊","status":"TRAINED","language":"chinese"},' +
  '{"timbreId":"1000064","name":"小象","status":"TRAINED","language":"chinese"}]';
process.env.CHARACTER_DEFAULT_TIMBRE_JSON = '{"elly":"1000063"}';
process.env.SPEECH_RATE_MAP_JSON = '{"slow":0.8,"normal":1,"fast":1.25}';

/** 本文件独占的环境变量，afterAll 还原，避免泄漏给同一进程里的其他 e2e */
const OWN_ENV_KEYS = [
  "BAIDU_AGENT_ENABLED",
  "VOICE_CATALOG_JSON",
  "CHARACTER_DEFAULT_TIMBRE_JSON",
  "SPEECH_RATE_MAP_JSON",
] as const;
const savedEnv = OWN_ENV_KEYS.map((key) => [key, process.env[key]] as const);

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

describe("loginMac initial voice dispatch (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let mac: string;

  const loginMac = () =>
    request(app.getHttpServer())
      .post("/client/user/user/loginMac")
      .send({ mac, password: loginPassword(mac) });

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
  });

  beforeEach(() => {
    const suffix = randomUUID().replace(/-/g, "");
    mac = suffix.replace(/[^0-9a-f]/g, "a").slice(0, 12);
  });

  afterEach(async () => {
    const device = await prisma.device.findUnique({ where: { deviceId: mac } });
    if (device) {
      await prisma.deviceConfig.deleteMany({ where: { deviceId: device.id } });
      await prisma.device.deleteMany({ where: { id: device.id } });
    }
  });

  afterAll(async () => {
    await app.close();
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("dispatches the IP default timbre for a brand new device", async () => {
    const response = await loginMac().expect(200);

    // 协议 3.2 的原有字段一个不少，只多出音色字段
    expect(response.body).toEqual({
      code: 200,
      data: {
        id: mac,
        nickname: `设备 ${mac.slice(-6)}`,
        lang: "zh",
        timbreId: "1000063",
      },
      msg: "success",
    });
  });

  it("prefers an explicit device voice over the IP default", async () => {
    const device = await prisma.device.create({
      data: { deviceId: mac, macAddress: mac, characterKey: "elly" },
    });
    await prisma.deviceConfig.create({
      data: {
        deviceId: device.id,
        mode: "free_chat",
        speechRate: "fast",
        isActive: true,
        payload: { voice: { vcn: "1000064" } },
      },
    });

    const response = await loginMac().expect(200);

    expect(response.body.data.timbreId).toBe("1000064");
  });

  it("omits the field entirely when the desired timbre is not in the catalog", async () => {
    const device = await prisma.device.create({
      data: { deviceId: mac, macAddress: mac, characterKey: "elly" },
    });
    await prisma.deviceConfig.create({
      data: {
        deviceId: device.id,
        mode: "free_chat",
        speechRate: null,
        isActive: true,
        payload: { voice: { vcn: "9999999" } },
      },
    });

    const response = await loginMac().expect(200);

    // fail-closed：不猜、不回落，响应体退回协议 3.2 的原样
    expect(response.body).toEqual({
      code: 200,
      data: { id: mac, nickname: `设备 ${mac.slice(-6)}`, lang: "zh" },
      msg: "success",
    });
  });

  it("keeps onboarding working when the character default is not configured", async () => {
    // polly 在 CHARACTER_DEFAULT_TIMBRE_JSON 里没有条目
    await prisma.device.create({
      data: { deviceId: mac, macAddress: mac, characterKey: "polly" },
    });

    const response = await loginMac().expect(200);

    expect(response.body.data).not.toHaveProperty("timbreId");
    expect(response.headers.authorization).toBe(E2E_LLM_API_KEY);
  });
});
