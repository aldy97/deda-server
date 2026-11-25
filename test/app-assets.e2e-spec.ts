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
const KEY = "diagnostics/remote-probe";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/**
 * 展示型素材 e2e：真实 AppModule + 真实 DB + 真实鉴权 + 真实静态文件。
 * 覆盖 HTTP multipart → Guard → 服务 → Prisma → 本地存储 → manifest → 静态回读。
 */
describe("App assets (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let superToken: string;

  function envelope(res: request.Response) {
    expect(res.body.code).toBe(0);
    return res.body.data;
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
    await prisma.appAsset.deleteMany({ where: { key: KEY } });

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
    await prisma.appAsset.deleteMany({ where: { key: KEY } });
    await app.close();
    rmSync(ASSET_DIR, { recursive: true, force: true });
  });

  it("上传 → 发布 → manifest → 静态文件 → 下架", async () => {
    const keys = await request(app.getHttpServer())
      .get("/analytics/app-assets/keys")
      .set("Authorization", `Bearer ${superToken}`)
      .expect(200);
    expect(envelope(keys)).toEqual([
      { key: KEY, label: "远程素材探针", page: "asset-selftest" },
    ]);

    const upload = await request(app.getHttpServer())
      .post("/analytics/app-assets/upload")
      .set("Authorization", `Bearer ${superToken}`)
      .field("key", KEY)
      .field("width", "1")
      .field("height", "1")
      .field("note", "e2e probe")
      .attach("file", PNG, { filename: "probe.png", contentType: "image/png" })
      .expect(201);
    const draft = envelope(upload);
    expect(draft).toMatchObject({
      key: KEY,
      status: "draft",
      width: 1,
      height: 1,
      mimeType: "image/png",
    });
    expect(draft.url.startsWith(`${PUBLIC_BASE_URL}/`)).toBe(true);

    const published = await request(app.getHttpServer())
      .post(`/analytics/app-assets/${draft.id}/publish`)
      .set("Authorization", `Bearer ${superToken}`)
      .expect(201);
    expect(envelope(published).status).toBe("published");

    const manifest = await request(app.getHttpServer())
      .get("/app-assets/manifest")
      .expect(200);
    const data = envelope(manifest);
    expect(data.assets[KEY]).toMatchObject({ width: 1, height: 1 });
    expect(data.assets[KEY].url).toBe(draft.url);

    const pathname = new URL(draft.url).pathname;
    const file = await request(app.getHttpServer()).get(pathname).expect(200);
    expect(file.headers["content-type"]).toContain("image/png");
    expect(file.body.equals(PNG)).toBe(true);

    await request(app.getHttpServer())
      .post(`/analytics/app-assets/${draft.id}/archive`)
      .set("Authorization", `Bearer ${superToken}`)
      .expect(201);

    const empty = await request(app.getHttpServer())
      .get("/app-assets/manifest")
      .expect(200);
    expect(envelope(empty).assets[KEY]).toBeUndefined();
  });

  it("拒绝 SVG 与未注册 key", async () => {
    await request(app.getHttpServer())
      .post("/analytics/app-assets/upload")
      .set("Authorization", `Bearer ${superToken}`)
      .field("key", KEY)
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
  });
});
