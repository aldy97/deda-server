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
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue(mockPrismaService)
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

    it("should accept free_chat with 201", () => {
      return authedPost("/device-configs/dev-001/mode")
        .send({ mode: "free_chat" })
        .expect(201)
        .expect((res) => {
          expect(res.body.code).toBe(0);
          expect(res.body.data.mode).toBe("free_chat");
        });
    });

    it("should accept english_chat with 201", () => {
      return authedPost("/device-configs/dev-001/mode")
        .send({ mode: "english_chat" })
        .expect(201)
        .expect((res) => {
          expect(res.body.code).toBe(0);
          expect(res.body.data.mode).toBe("english_chat");
        });
    });
  });

  describe("POST /device-configs/:deviceId/apply", () => {
    it("should accept free_chat with 201", () => {
      return authedPost("/device-configs/dev-001/apply")
        .send({ mode: "free_chat" })
        .expect(201)
        .expect((res) => {
          expect(res.body.code).toBe(0);
          expect(res.body.data.mode).toBe("free_chat");
        });
    });

    it("should accept english_chat with 201", () => {
      return authedPost("/device-configs/dev-001/apply")
        .send({ mode: "english_chat" })
        .expect(201)
        .expect((res) => {
          expect(res.body.code).toBe(0);
          expect(res.body.data.mode).toBe("english_chat");
        });
    });
  });

  describe("authentication", () => {
    it("should reject requests without a token with 401", () => {
      return request(app.getHttpServer())
        .post("/device-configs/dev-001/mode")
        .send({ mode: "free_chat" })
        .expect(401);
    });
  });
});
