import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import * as dotenv from "dotenv";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import * as request from "supertest";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/common/prisma/prisma.service";
import { ResponseInterceptor } from "../src/common/interceptors/response.interceptor";
import { HttpExceptionFilter } from "../src/common/filters/http-exception.filter";

dotenv.config();

const ASSET_DIR = mkdtempSync(join(tmpdir(), "deda-app-assets-e2e-"));
const PUBLIC_BASE_URL = "http://127.0.0.1/app-assets/files";
process.env.APP_ASSET_STORAGE_DRIVER = "local";
process.env.APP_ASSET_LOCAL_DIR = ASSET_DIR;
process.env.APP_ASSET_PUBLIC_BASE_URL = PUBLIC_BASE_URL;
process.env.APP_ASSET_HOSTS = "127.0.0.1";
process.env.APP_ASSET_MAX_BYTES = "2097152";
process.env.APP_ASSET_MAX_DIMENSION = "8000";

const ANALYTICS_SECRET =
  process.env.ANALYTICS_JWT_SECRET || "dev-analytics-jwt-secret";
const PROBE_KEY = "diagnostics/remote-probe";
const SLOT_KEY = "e2e-assets/hero";
const DISABLE_KEY = "e2e-assets/disable-me";
const CREATED_KEY = "e2e-assets/created";
const ALL_KEYS = [PROBE_KEY, SLOT_KEY, DISABLE_KEY, CREATED_KEY];
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/**
 * 展示型素材 e2e：真实 AppModule + 真实 DB + 真实鉴权 + 真实静态文件。
 * 覆盖 HTTP multipart → Guard → 服务 → Prisma → 本地存储 → manifest → 静态回读，
 * 以及展示位注册表的创建 / 停用闸口 / 多版本保留。
 */
describe("App assets (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let superToken: string;

  function envelope(res: request.Response) {
    expect(res.body.code).toBe(0);
    return res.body.data;
  }

  function upload(key: string) {
    return request(app.getHttpServer())
      .post("/analytics/app-assets/upload")
      .set("Authorization", `Bearer ${superToken}`)
      .field("key", key)
      .field("width", "1")
      .field("height", "1")
      .attach("file", PNG, { filename: "probe.png", contentType: "image/png" });
  }

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
    await prisma.appAsset.deleteMany({ where: { key: { in: ALL_KEYS } } });
    await prisma.appAssetSlot.deleteMany({
      where: { key: { in: [SLOT_KEY, DISABLE_KEY, CREATED_KEY] } },
    });
    await prisma.appAssetSlot.createMany({
      data: [
        { key: SLOT_KEY, label: "E2E 展示位", page: "e2e-assets" },
        { key: DISABLE_KEY, label: "E2E 停用位", page: "e2e-assets" },
      ],
    });

    const jwt = new JwtService({ secret: ANALYTICS_SECRET });
    superToken = await jwt.signAsync({
      sub: "e2e-assets",
      username: "e2e-assets",
      displayName: "E2E Assets",
      scope: "analytics",
      role: "superadmin",
    });
  });

  afterAll(async () => {
    await prisma.appAsset.deleteMany({ where: { key: { in: ALL_KEYS } } });
    // seed 探针要保留；只清测试自建的展示位。
    await prisma.appAssetSlot.deleteMany({
      where: { key: { in: [SLOT_KEY, DISABLE_KEY, CREATED_KEY] } },
    });
    await app.close();
    rmSync(ASSET_DIR, { recursive: true, force: true });
  });

  it("keys 含 seed 探针；新建展示位、重复与非法输入", async () => {
    const keys = await request(app.getHttpServer())
      .get("/analytics/app-assets/keys")
      .set("Authorization", `Bearer ${superToken}`)
      .expect(200);
    const list = envelope(keys);
    expect(list).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: PROBE_KEY,
          page: "diagnostics",
          enabled: true,
        }),
      ]),
    );

    const created = await request(app.getHttpServer())
      .post("/analytics/app-assets/keys")
      .set("Authorization", `Bearer ${superToken}`)
      .send({ page: "e2e-assets", suffix: "created", label: "E2E 新建" })
      .expect(201);
    expect(envelope(created)).toMatchObject({
      key: CREATED_KEY,
      page: "e2e-assets",
      label: "E2E 新建",
      enabled: true,
      createdBy: "e2e-assets",
    });

    await request(app.getHttpServer())
      .post("/analytics/app-assets/keys")
      .set("Authorization", `Bearer ${superToken}`)
      .send({ page: "e2e-assets", suffix: "created", label: "重复" })
      .expect(409);

    await request(app.getHttpServer())
      .post("/analytics/app-assets/keys")
      .set("Authorization", `Bearer ${superToken}`)
      .send({ page: "E2E-Assets", suffix: "bad", label: "非法" })
      .expect(400);

    const after = await request(app.getHttpServer())
      .get("/analytics/app-assets/keys")
      .set("Authorization", `Bearer ${superToken}`)
      .expect(200);
    expect(
      envelope(after).some((slot: { key: string }) => slot.key === CREATED_KEY),
    ).toBe(true);
  });

  it("上传 → 发布 → manifest → 静态文件；v2 不发布时线上仍是 v1", async () => {
    const upload1 = await upload(SLOT_KEY).expect(201);
    const draft1 = envelope(upload1);
    expect(draft1).toMatchObject({
      key: SLOT_KEY,
      status: "draft",
      width: 1,
      height: 1,
      mimeType: "image/png",
    });
    expect(draft1.url.startsWith(`${PUBLIC_BASE_URL}/`)).toBe(true);

    await request(app.getHttpServer())
      .post(`/analytics/app-assets/${draft1.id}/publish`)
      .set("Authorization", `Bearer ${superToken}`)
      .expect(201);

    const upload2 = await upload(SLOT_KEY).expect(201);
    const draft2 = envelope(upload2);
    expect(draft2.version).toBe(2);
    expect(draft2.status).toBe("draft");

    // 只上传不发布：manifest 仍指向 v1
    const manifest1 = envelope(
      await request(app.getHttpServer())
        .get("/app-assets/manifest")
        .expect(200),
    );
    expect(manifest1.assets[SLOT_KEY]).toMatchObject({
      version: 1,
      url: draft1.url,
    });

    // 版本历史两条都在，v1 仍 published
    const versions1 = envelope(
      await request(app.getHttpServer())
        .get("/analytics/app-assets/versions")
        .query({ key: SLOT_KEY })
        .set("Authorization", `Bearer ${superToken}`)
        .expect(200),
    );
    expect(versions1.map((v: { version: number }) => v.version)).toEqual([
      2, 1,
    ]);
    expect(versions1[1].status).toBe("published");

    // 发布 v2：v1 归档，manifest 指向 v2
    await request(app.getHttpServer())
      .post(`/analytics/app-assets/${draft2.id}/publish`)
      .set("Authorization", `Bearer ${superToken}`)
      .expect(201);

    const manifest2 = envelope(
      await request(app.getHttpServer())
        .get("/app-assets/manifest")
        .expect(200),
    );
    expect(manifest2.assets[SLOT_KEY]).toMatchObject({
      version: 2,
      url: draft2.url,
    });

    const versions2 = envelope(
      await request(app.getHttpServer())
        .get("/analytics/app-assets/versions")
        .query({ key: SLOT_KEY })
        .set("Authorization", `Bearer ${superToken}`)
        .expect(200),
    );
    expect(
      versions2.find((v: { version: number }) => v.version === 1).status,
    ).toBe("archived");

    const pathname = new URL(draft2.url).pathname;
    const file = await request(app.getHttpServer()).get(pathname).expect(200);
    expect(file.headers["content-type"]).toContain("image/png");
    expect(file.body.equals(PNG)).toBe(true);
  });

  it("有 published 时禁止停用；下架后可停用，停用后拒绝上传", async () => {
    const uploaded = await upload(DISABLE_KEY).expect(201);
    const draft = envelope(uploaded);
    await request(app.getHttpServer())
      .post(`/analytics/app-assets/${draft.id}/publish`)
      .set("Authorization", `Bearer ${superToken}`)
      .expect(201);

    await request(app.getHttpServer())
      .patch("/analytics/app-assets/keys")
      .set("Authorization", `Bearer ${superToken}`)
      .send({ key: DISABLE_KEY, enabled: false })
      .expect(409);

    await request(app.getHttpServer())
      .post(`/analytics/app-assets/${draft.id}/archive`)
      .set("Authorization", `Bearer ${superToken}`)
      .expect(201);

    const disabled = await request(app.getHttpServer())
      .patch("/analytics/app-assets/keys")
      .set("Authorization", `Bearer ${superToken}`)
      .send({ key: DISABLE_KEY, enabled: false })
      .expect(200);
    expect(envelope(disabled).enabled).toBe(false);

    const manifest = envelope(
      await request(app.getHttpServer())
        .get("/app-assets/manifest")
        .expect(200),
    );
    expect(manifest.assets[DISABLE_KEY]).toBeUndefined();

    await upload(DISABLE_KEY).expect(400);

    const enabled = await request(app.getHttpServer())
      .patch("/analytics/app-assets/keys")
      .set("Authorization", `Bearer ${superToken}`)
      .send({ key: DISABLE_KEY, enabled: true })
      .expect(200);
    expect(envelope(enabled).enabled).toBe(true);
  });

  it("拒绝 SVG 与未注册 key", async () => {
    await request(app.getHttpServer())
      .post("/analytics/app-assets/upload")
      .set("Authorization", `Bearer ${superToken}`)
      .field("key", SLOT_KEY)
      .field("width", "1")
      .field("height", "1")
      .attach("file", Buffer.from("<svg/>"), {
        filename: "bad.svg",
        contentType: "image/svg+xml",
      })
      .expect(400);

    await request(app.getHttpServer())
      .post("/analytics/app-assets/upload")
      .set("Authorization", `Bearer ${superToken}`)
      .field("key", "unknown/key")
      .field("width", "1")
      .field("height", "1")
      .attach("file", PNG, { filename: "probe.png", contentType: "image/png" })
      .expect(400);
  });

  it("普通 admin 访问管理接口返回 403", async () => {
    const jwt = new JwtService({ secret: ANALYTICS_SECRET });
    const plain = await jwt.signAsync({
      sub: "e2e-plain",
      username: "e2e-plain",
      scope: "analytics",
      role: "admin",
    });
    await request(app.getHttpServer())
      .get("/analytics/app-assets")
      .set("Authorization", `Bearer ${plain}`)
      .expect(403);
    await request(app.getHttpServer())
      .post("/analytics/app-assets/keys")
      .set("Authorization", `Bearer ${plain}`)
      .send({ page: "e2e-assets", suffix: "nope", label: "nope" })
      .expect(403);
  });
});
