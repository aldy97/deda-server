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

/** 家长画像聚合 e2e：真实 DB + dashboard JWT，用前后差值抵消库里既有数据。 */
describe("Analytics parent demographics (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;
  const createdUserIds: string[] = [];

  const suffix = randomUUID().slice(0, 8);

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
    adminToken = await new JwtService({ secret: ANALYTICS_SECRET }).signAsync({
      sub: "admin",
      username: "admin",
      displayName: "管理员",
      scope: "analytics",
    });
  });

  afterAll(async () => {
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    await app.close();
  });

  const authedGet = () =>
    request(app.getHttpServer())
      .get("/analytics/users/parent-demographics")
      .set("Authorization", `Bearer ${adminToken}`);

  type Distribution = {
    totalUsers: number;
    genderSplit: { male: number; female: number; unset: number };
    ageDistribution: Array<{ range: string; users: number }>;
  };

  const byRange = (data: Distribution) =>
    new Map(data.ageDistribution.map((item) => [item.range, item.users]));

  it("鉴权：无 token / 小程序 scope → 401/403", async () => {
    await request(app.getHttpServer())
      .get("/analytics/users/parent-demographics")
      .expect(401);

    const wechatToken = await new JwtService({
      secret: ANALYTICS_SECRET,
    }).signAsync({ sub: "user-001", username: "user-001", scope: "wechat" });
    await request(app.getHttpServer())
      .get("/analytics/users/parent-demographics")
      .set("Authorization", `Bearer ${wechatToken}`)
      .expect(401);
  });

  it("按家长账号统计性别与年龄段，且不泄露个体字段", async () => {
    const before = (await authedGet().expect(200)).body.data as Distribution;
    const beforeRanges = byRange(before);

    const year = new Date().getFullYear();
    const rows = [
      { gender: "male", birthday: `${year - 30}-01-01`, ageRange: "25-34" },
      { gender: "female", birthday: `${year - 40}-01-01`, ageRange: "35-44" },
      { gender: null, birthday: null, ageRange: "unknown" },
    ];

    for (const row of rows) {
      const user = await prisma.user.create({
        data: {
          openid: `parent-demographics-e2e-${suffix}-${createdUserIds.length}`,
          gender: row.gender,
          birthday: row.birthday,
        },
      });
      createdUserIds.push(user.id);
    }

    const response = await authedGet().expect(200);
    const after = response.body.data as Distribution;
    const afterRanges = byRange(after);

    expect(after.totalUsers - before.totalUsers).toBe(3);
    expect(after.genderSplit.male - before.genderSplit.male).toBe(1);
    expect(after.genderSplit.female - before.genderSplit.female).toBe(1);
    expect(after.genderSplit.unset - before.genderSplit.unset).toBe(1);
    for (const row of rows) {
      expect(
        (afterRanges.get(row.ageRange) ?? 0) -
          (beforeRanges.get(row.ageRange) ?? 0),
      ).toBe(1);
    }

    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain("openid");
    expect(serialized).not.toContain("phone");
    expect(serialized).not.toContain(createdUserIds[0]);
  });
});
