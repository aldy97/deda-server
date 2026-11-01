import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { randomUUID } from "crypto";
import * as request from "supertest";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/common/prisma/prisma.service";
import { ResponseInterceptor } from "../src/common/interceptors/response.interceptor";
import { HttpExceptionFilter } from "../src/common/filters/http-exception.filter";

describe("Devices ordering (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let userAId: string;
  let userBId: string;
  let deviceAInternalId: string;
  let deviceBInternalId: string;
  let deviceAId: string;
  let deviceBId: string;
  let tokenA: string;
  let tokenB: string;

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
    const suffix = randomUUID();
    const [userA, userB] = await Promise.all([
      prisma.user.create({ data: { openid: `device-order-a-${suffix}` } }),
      prisma.user.create({ data: { openid: `device-order-b-${suffix}` } }),
    ]);
    userAId = userA.id;
    userBId = userB.id;
    deviceAId = `order-a-${suffix}`;
    deviceBId = `order-b-${suffix}`;
    const [deviceA, deviceB] = await Promise.all([
      prisma.device.create({ data: { deviceId: deviceAId } }),
      prisma.device.create({ data: { deviceId: deviceBId } }),
    ]);
    deviceAInternalId = deviceA.id;
    deviceBInternalId = deviceB.id;
    await prisma.userDeviceBinding.createMany({
      data: [
        { userId: userAId, deviceId: deviceAInternalId, sortOrder: 0 },
        { userId: userAId, deviceId: deviceBInternalId, sortOrder: 1 },
        { userId: userBId, deviceId: deviceAInternalId, sortOrder: 0 },
        { userId: userBId, deviceId: deviceBInternalId, sortOrder: 1 },
      ],
    });
    tokenA = jwtService.sign({ sub: userAId, openid: userA.openid });
    tokenB = jwtService.sign({ sub: userBId, openid: userB.openid });
  });

  afterEach(async () => {
    await prisma.userDeviceBinding.deleteMany({
      where: { userId: { in: [userAId, userBId] } },
    });
    await prisma.device.deleteMany({
      where: { id: { in: [deviceAInternalId, deviceBInternalId] } },
    });
    await prisma.user.deleteMany({ where: { id: { in: [userAId, userBId] } } });
  });

  afterAll(async () => {
    await app.close();
  });

  const authedPut = (token = tokenA) =>
    request(app.getHttpServer())
      .put("/devices/order")
      .set("Authorization", `Bearer ${token}`);

  const listOrder = async (token = tokenA): Promise<string[]> => {
    const response = await request(app.getHttpServer())
      .get("/devices")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    return response.body.data.map(
      (device: { deviceId: string }) => device.deviceId,
    );
  };

  it("persists a complete order and accepts an idempotent retry", async () => {
    const orderedDeviceIds = [deviceBId, deviceAId];
    const response = await authedPut().send({ orderedDeviceIds }).expect(200);

    expect(response.body).toMatchObject({
      code: 0,
      data: { orderedDeviceIds },
    });
    expect(await listOrder()).toEqual(orderedDeviceIds);

    await authedPut().send({ orderedDeviceIds }).expect(200);
    expect(await listOrder()).toEqual(orderedDeviceIds);
  });

  it("rejects empty and duplicate device IDs with 400", async () => {
    await authedPut().send({ orderedDeviceIds: [] }).expect(400);
    await authedPut()
      .send({ orderedDeviceIds: [deviceAId, deviceAId] })
      .expect(400);
    expect(await listOrder()).toEqual([deviceAId, deviceBId]);
  });

  it("rejects missing and unknown IDs with 409 without partial updates", async () => {
    await authedPut()
      .send({ orderedDeviceIds: [deviceAId] })
      .expect(409);
    await authedPut()
      .send({ orderedDeviceIds: [deviceBId, deviceAId, "unknown-device"] })
      .expect(409);
    expect(await listOrder()).toEqual([deviceAId, deviceBId]);
  });

  it("rejects another user's device with 403", async () => {
    const other = await prisma.device.create({
      data: { deviceId: `order-other-${randomUUID()}` },
    });
    try {
      await authedPut()
        .send({ orderedDeviceIds: [deviceBId, deviceAId, other.deviceId] })
        .expect(403);
      expect(await listOrder()).toEqual([deviceAId, deviceBId]);
    } finally {
      await prisma.device.delete({ where: { id: other.id } });
    }
  });

  it("returns 409 when the bound set changed before submission", async () => {
    const added = await prisma.device.create({
      data: { deviceId: `order-added-${randomUUID()}` },
    });
    try {
      await prisma.userDeviceBinding.create({
        data: { userId: userAId, deviceId: added.id, sortOrder: 2 },
      });
      await authedPut()
        .send({ orderedDeviceIds: [deviceBId, deviceAId] })
        .expect(409);
      expect(await listOrder()).toEqual([deviceAId, deviceBId, added.deviceId]);
    } finally {
      await prisma.device.delete({ where: { id: added.id } });
    }
  });

  it("does not change another user's order for the same devices", async () => {
    await authedPut()
      .send({ orderedDeviceIds: [deviceBId, deviceAId] })
      .expect(200);

    expect(await listOrder()).toEqual([deviceBId, deviceAId]);
    expect(await listOrder(tokenB)).toEqual([deviceAId, deviceBId]);
  });

  it("requires authentication", async () => {
    await request(app.getHttpServer())
      .put("/devices/order")
      .send({ orderedDeviceIds: [deviceAId, deviceBId] })
      .expect(401);
  });
});
