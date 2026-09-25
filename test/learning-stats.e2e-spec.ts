import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import * as request from "supertest";
import { AppModule } from "./../src/app.module";
import { PrismaService } from "./../src/common/prisma/prisma.service";
import { JwtService } from "@nestjs/jwt";
import { TransformInterceptor } from "../src/common/interceptors/transform.interceptor";

describe("LearningStats (e2e)", () => {
  let app: INestApplication;
  let jwtToken: string;

  const mockPrismaService = {
    $connect: jest.fn().mockResolvedValue(undefined),
    $disconnect: jest.fn().mockResolvedValue(undefined),
    userDeviceBinding: {
      findMany: jest.fn().mockResolvedValue([
        {
          device: {
            id: "device-uuid-001",
            deviceId: "dev-001",
            name: "DEV001",
          },
        },
      ]),
    },
    deviceConfig: {
      findMany: jest.fn().mockResolvedValue([
        {
          deviceId: "device-uuid-001",
          mode: "free_chat",
          textbookId: null,
          unitId: null,
          conversationModeKey: "free_chat_casual",
          isActive: true,
        },
      ]),
    },
    conversation: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: "conv-001",
          deviceId: "device-uuid-001",
          mode: "free_chat",
          textbookId: null,
          unitId: null,
          asrText: "Hello",
          aiReply: "Hi there",
          spokeAt: new Date(),
        },
      ]),
      count: jest.fn().mockResolvedValue(1),
    },
    conversationModeCategory: {
      upsert: jest.fn().mockResolvedValue({}),
      findUnique: jest.fn().mockResolvedValue(null),
    },
    conversationMode: {
      upsert: jest.fn().mockResolvedValue({}),
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
    },
    textbook: {
      upsert: jest.fn().mockResolvedValue({}),
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
    },
    unit: {
      upsert: jest.fn().mockResolvedValue({}),
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
    },
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue(mockPrismaService)
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalInterceptors(new TransformInterceptor());
    await app.init();

    const jwtService = moduleFixture.get(JwtService);
    jwtToken = jwtService.sign({
      sub: "user-001",
      openid: "dev-openid-stable",
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it("GET /learning-stats/dashboard should return dashboard", () => {
    return request(app.getHttpServer())
      .get("/learning-stats/dashboard")
      .set("Authorization", `Bearer ${jwtToken}`)
      .expect(200)
      .expect((res) => {
        expect(res.body.code).toBe(0);
        expect(res.body.data.boundDeviceCount).toBe(1);
        expect(res.body.data.devices).toHaveLength(1);
      });
  });

  it("GET /learning-stats/daily should return trend", () => {
    return request(app.getHttpServer())
      .get("/learning-stats/daily?days=7")
      .set("Authorization", `Bearer ${jwtToken}`)
      .expect(200)
      .expect((res) => {
        expect(res.body.code).toBe(0);
        expect(res.body.data).toHaveLength(7);
      });
  });

  it("GET /learning-stats/topics should return topic breakdown", () => {
    return request(app.getHttpServer())
      .get("/learning-stats/topics")
      .set("Authorization", `Bearer ${jwtToken}`)
      .expect(200)
      .expect((res) => {
        expect(res.body.code).toBe(0);
        expect(res.body.data[0].mode).toBe("free_chat");
      });
  });

  it("GET /learning-stats/timeline should return paginated timeline", () => {
    return request(app.getHttpServer())
      .get("/learning-stats/timeline?page=1&pageSize=10")
      .set("Authorization", `Bearer ${jwtToken}`)
      .expect(200)
      .expect((res) => {
        expect(res.body.code).toBe(0);
        expect(res.body.data.items).toHaveLength(1);
        expect(res.body.data.total).toBe(1);
      });
  });
});
