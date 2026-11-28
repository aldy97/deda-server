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

const USER_SECRET = process.env.JWT_SECRET || "dev-jwt-secret";

/**
 * 家长档案读写 e2e：真实 DB + 真实用户 JWT。
 * 覆盖 GET 默认空档案与计数、PATCH 成功、PATCH 校验失败（400）、PATCH 后 GET 可读回。
 */
describe("Users profile (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;

  const suffix = randomUUID().slice(0, 8);
  const openid = `users-profile-e2e-${suffix}`;
  let userId: string;

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
    const user = await prisma.user.create({ data: { openid } });
    userId = user.id;
    token = await new JwtService({ secret: USER_SECRET }).signAsync({
      sub: user.id,
      openid,
    });
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: userId } });
    await app.close();
  });

  const authedGet = () =>
    request(app.getHttpServer())
      .get("/users/profile")
      .set("Authorization", `Bearer ${token}`);

  const authedPatch = (body: Record<string, unknown>) =>
    request(app.getHttpServer())
      .patch("/users/profile")
      .set("Authorization", `Bearer ${token}`)
      .send(body);

  it("无 token 返回 401", async () => {
    await request(app.getHttpServer()).get("/users/profile").expect(401);
  });

  it("GET 默认档案：昵称/手机号/性别/生日为空、计数为 0、不含 openid", async () => {
    const res = await authedGet().expect(200);

    expect(res.body.code).toBe(0);
    expect(res.body.data).toEqual({
      id: userId,
      nickname: null,
      phone: null,
      gender: null,
      birthday: null,
      createdAt: expect.any(String),
      deviceCount: 0,
      childCount: 0,
    });
    expect(Object.keys(res.body.data).sort()).toEqual([
      "birthday",
      "childCount",
      "createdAt",
      "deviceCount",
      "gender",
      "id",
      "nickname",
      "phone",
    ]);
    expect(JSON.stringify(res.body)).not.toContain(openid);
  });

  it("PATCH 成功：先 trim 再落库，响应与 GET 同形状", async () => {
    const res = await authedPatch({ nickname: "  熊熊妈妈  " }).expect(200);

    expect(res.body.code).toBe(0);
    expect(res.body.data).toMatchObject({
      id: userId,
      nickname: "熊熊妈妈",
      deviceCount: 0,
      childCount: 0,
    });
    expect(res.body.data).not.toHaveProperty("openid");

    const stored = await prisma.user.findUnique({ where: { id: userId } });
    expect(stored?.nickname).toBe("熊熊妈妈");
  });

  it("PATCH 后再 GET 能读到新昵称", async () => {
    const res = await authedGet().expect(200);
    expect(res.body.data.nickname).toBe("熊熊妈妈");
  });

  it("PATCH 只更新性别/生日，昵称保持不变", async () => {
    const res = await authedPatch({
      gender: "female",
      birthday: "1990-05-20",
    }).expect(200);

    expect(res.body.data).toMatchObject({
      nickname: "熊熊妈妈",
      gender: "female",
      birthday: "1990-05-20",
    });

    const stored = await prisma.user.findUnique({ where: { id: userId } });
    expect(stored?.gender).toBe("female");
    expect(stored?.birthday).toBe("1990-05-20");
    expect(stored?.nickname).toBe("熊熊妈妈");
  });

  it("PATCH null 清空性别与生日", async () => {
    const res = await authedPatch({
      gender: null,
      birthday: null,
    }).expect(200);

    expect(res.body.data.gender).toBeNull();
    expect(res.body.data.birthday).toBeNull();
  });

  it.each([
    ["不存在的日期", { birthday: "2026-02-29" }],
    ["未来日期", { birthday: "2999-01-01" }],
    ["过早日期", { birthday: "1899-12-31" }],
    ["非法性别", { gender: "other" }],
  ])("PATCH %s → 400", async (_label, body) => {
    await authedPatch(body as Record<string, unknown>).expect(400);
  });

  it("PATCH 空对象 → 400", async () => {
    const res = await authedPatch({}).expect(400);
    expect(res.body.code).toBe(400);
  });

  it.each([
    ["空串", { nickname: "" }],
    ["纯空白", { nickname: "   " }],
    ["超 20 字", { nickname: "熊".repeat(21) }],
    ["未知字段（含 avatarUrl）", { nickname: "小熊", avatarUrl: "https://x" }],
  ])("PATCH %s → 400", async (_label, body) => {
    const res = await authedPatch(body as Record<string, unknown>).expect(400);
    expect(res.body.code).toBe(400);
  });

  it("PATCH 失败不会改动已存昵称", async () => {
    const stored = await prisma.user.findUnique({ where: { id: userId } });
    expect(stored?.nickname).toBe("熊熊妈妈");
    expect(stored?.avatarUrl).toBeNull();
  });
});
