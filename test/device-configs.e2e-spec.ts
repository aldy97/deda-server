import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import * as request from "supertest";
import { AppModule } from "./../src/app.module";
import { PrismaService } from "./../src/common/prisma/prisma.service";
import { JwtService } from "@nestjs/jwt";
import { ResponseInterceptor } from "../src/common/interceptors/response.interceptor";
import { HttpExceptionFilter } from "../src/common/filters/http-exception.filter";

describe("DeviceConfigs validation (e2e)", () => {
  let app: INestApplication;
  let jwtToken: string;

  const mockBinding = {
    id: "binding-001",
    device: { id: "device-uuid-001", deviceId: "dev-001" },
  };

  const mockPrismaService = {
    $connect: jest.fn().mockResolvedValue(undefined),
    $disconnect: jest.fn().mockResolvedValue(undefined),
    $transaction: jest.fn((cb: any) => cb(mockPrismaService)),
    userDeviceBinding: {
      findFirst: jest.fn().mockResolvedValue(mockBinding),
    },
    deviceConfig: {
      findFirst: jest.fn().mockResolvedValue(null),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      create: jest.fn(({ data }: any) =>
        Promise.resolve({ id: "config-new", ...data }),
      ),
    },
    textbook: {
      upsert: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(({ where }: any) =>
        where.textbookId === "not-exist"
          ? Promise.resolve(null)
          : Promise.resolve({
              id: "textbook-uuid-001",
              textbookId: where.textbookId ?? "unlock-l1-speaking-listening",
              name: "Unlock L1 Speaking & Listening",
            }),
      ),
    },
    unit: {
      upsert: jest.fn().mockResolvedValue({}),
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(({ where }: any) =>
        where.textbookId_unitId?.unitId === "unit-999"
          ? Promise.resolve(null)
          : Promise.resolve({
              id: "unit-uuid-001",
              unitId: where.textbookId_unitId?.unitId ?? "unit-1",
              name: "Unit 1",
            }),
      ),
    },
    conversationModeCategory: {
      upsert: jest.fn().mockResolvedValue({}),
      findUnique: jest.fn().mockResolvedValue({ id: "cat-uuid-001" }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    conversationMode: {
      upsert: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn(({ where }: any) => {
        if (where.key === "free_chat_casual") {
          return Promise.resolve({
            id: "mode-uuid-001",
            key: "free_chat_casual",
            isActive: true,
            category: { key: "free_chat" },
          });
        }
        if (where.key === "textbook_follow") {
          return Promise.resolve({
            id: "mode-uuid-002",
            key: "textbook_follow",
            isActive: true,
            category: { key: "textbook_learning" },
          });
        }
        return Promise.resolve(null);
      }),
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
    // 镜像 src/main.ts 的全局装配，使 DTO @IsIn 在 HTTP 层生效
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

    const jwtService = moduleFixture.get(JwtService);
    jwtToken = jwtService.sign({
      sub: "user-001",
      openid: "dev-openid-stable",
    });
  });

  afterAll(async () => {
    await app.close();
  });

  const authedPost = (url: string) =>
    request(app.getHttpServer())
      .post(url)
      .set("Authorization", `Bearer ${jwtToken}`);

  describe("POST /device-configs/:deviceId/mode", () => {
    it("should reject an invalid mode with 400", () => {
      return authedPost("/device-configs/dev-001/mode")
        .send({ mode: "invalid_mode" })
        .expect(400);
    });

    it("should reject free_chat without conversationModeKey with 400", () => {
      return authedPost("/device-configs/dev-001/mode")
        .send({ mode: "free_chat" })
        .expect(400);
    });

    it("should reject free_chat with textbookId with 400", () => {
      return authedPost("/device-configs/dev-001/mode")
        .send({
          mode: "free_chat",
          conversationModeKey: "free_chat_casual",
          textbookId: "unlock-l1-speaking-listening",
        })
        .expect(400);
    });

    it("should reject an unknown conversationModeKey with 400", () => {
      return authedPost("/device-configs/dev-001/mode")
        .send({ mode: "free_chat", conversationModeKey: "not_a_mode" })
        .expect(400);
    });

    it("should reject a conversationModeKey from the wrong category with 400", () => {
      return authedPost("/device-configs/dev-001/mode")
        .send({ mode: "free_chat", conversationModeKey: "textbook_follow" })
        .expect(400);
    });

    it("should reject textbook_learning without textbookId with 400", () => {
      return authedPost("/device-configs/dev-001/mode")
        .send({ mode: "textbook_learning" })
        .expect(400);
    });

    it("should reject locked_unit without unitId with 400", () => {
      return authedPost("/device-configs/dev-001/mode")
        .send({
          mode: "locked_unit",
          textbookId: "unlock-l1-speaking-listening",
        })
        .expect(400);
    });

    it("should reject free_textbook with unitId with 400", () => {
      return authedPost("/device-configs/dev-001/mode")
        .send({
          mode: "free_textbook",
          textbookId: "unlock-l1-speaking-listening",
          unitId: "unit-1",
        })
        .expect(400);
    });

    it("should return 404 when the textbook does not exist", () => {
      return authedPost("/device-configs/dev-001/mode")
        .send({ mode: "textbook_learning", textbookId: "not-exist" })
        .expect(404);
    });

    it("should accept a valid free_chat payload with 201", () => {
      return authedPost("/device-configs/dev-001/mode")
        .send({ mode: "free_chat", conversationModeKey: "free_chat_casual" })
        .expect(201)
        .expect((res) => {
          expect(res.body.code).toBe(0);
          expect(res.body.data.mode).toBe("free_chat");
          expect(res.body.data.conversationModeKey).toBe("free_chat_casual");
        });
    });
  });

  describe("POST /device-configs/:deviceId/apply", () => {
    it("should reject free_chat without conversationModeKey with 400", () => {
      return authedPost("/device-configs/dev-001/apply")
        .send({ mode: "free_chat" })
        .expect(400);
    });

    it("should return 404 when the unit does not exist", () => {
      return authedPost("/device-configs/dev-001/apply")
        .send({
          mode: "locked_unit",
          textbookId: "unlock-l1-speaking-listening",
          unitId: "unit-999",
        })
        .expect(404);
    });

    it("should accept a valid locked_unit payload with 201", () => {
      return authedPost("/device-configs/dev-001/apply")
        .send({
          mode: "locked_unit",
          textbookId: "unlock-l1-speaking-listening",
          unitId: "unit-1",
        })
        .expect(201)
        .expect((res) => {
          expect(res.body.code).toBe(0);
          expect(res.body.data.textbookId).toBe("unlock-l1-speaking-listening");
          expect(res.body.data.unitId).toBe("unit-1");
        });
    });
  });

  describe("authentication", () => {
    it("should reject requests without a token with 401", () => {
      return request(app.getHttpServer())
        .post("/device-configs/dev-001/mode")
        .send({ mode: "free_chat", conversationModeKey: "free_chat_casual" })
        .expect(401);
    });
  });
});
