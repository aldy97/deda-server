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
 * 反馈手机号回写 e2e：真实 DB + 真实用户 JWT。
 * 覆盖「最新手机号写入 users.phone」「无联系方式不动旧值」「重复手机号可共存」。
 */
describe("Feedback phone sync (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;
  let userId: string;

  const suffix = randomUUID().slice(0, 8);
  const openid = `feedback-phone-e2e-${suffix}`;

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
    await prisma.feedback.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await app.close();
  });

  const submit = (contact?: string) =>
    request(app.getHttpServer())
      .post("/feedbacks")
      .set("Authorization", `Bearer ${token}`)
      .send({ content: "反馈手机号回写", ...(contact ? { contact } : {}) });

  it("填写手机号后回写到 users.phone", async () => {
    await submit("13800138000").expect(200);

    const stored = await prisma.user.findUnique({ where: { id: userId } });
    expect(stored?.phone).toBe("13800138000");
  });

  it("再次反馈时最新手机号覆盖旧值", async () => {
    await submit("13900139000").expect(200);

    const stored = await prisma.user.findUnique({ where: { id: userId } });
    expect(stored?.phone).toBe("13900139000");
  });

  it("不带联系方式时保留已有手机号", async () => {
    await submit().expect(200);

    const stored = await prisma.user.findUnique({ where: { id: userId } });
    expect(stored?.phone).toBe("13900139000");
  });

  it("同一手机号可以被多个账号写入（允许重复）", async () => {
    const otherOpenid = `feedback-phone-e2e-other-${suffix}`;
    const other = await prisma.user.create({
      data: { openid: otherOpenid, phone: "13900139000" },
    });

    try {
      const count = await prisma.user.count({
        where: { phone: "13900139000" },
      });
      expect(count).toBeGreaterThanOrEqual(2);
    } finally {
      await prisma.user.delete({ where: { id: other.id } });
    }
  });
});
