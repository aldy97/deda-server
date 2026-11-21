import { Test, TestingModule } from "@nestjs/testing";
import { ConfigModule } from "@nestjs/config";
import * as mqtt from "mqtt";
import { MqttModule } from "./mqtt.module";
import { MqttService } from "./mqtt.service";
import { PrismaModule } from "@/common/prisma/prisma.module";
import { PrismaService } from "@/common/prisma/prisma.service";
import { RedisService } from "@/common/redis/redis.service";
import { DeviceLinkModule } from "@/modules/device-link/device-link.module";
import { DeviceLinkService } from "@/modules/device-link/device-link.service";
import { DeviceStatusModule } from "@/modules/device-status/device-status.module";
import { DeviceStatusService } from "@/modules/device-status/device-status.service";

jest.mock("mqtt");

/**
 * MQTT 订阅 wiring 回归：编译真实模块图（MqttModule + DeviceLinkModule +
 * DeviceStatusModule，MqttService 不做 mock），只把叶子依赖 Redis/Prisma 换成
 * stub、把 mqtt 库 mock 掉，验证「订阅方 onModuleInit 先于 MqttService 执行」
 * 的时序竞态下，订阅仍会补订，不会再被静默丢弃。
 */
describe("MqttService 订阅 wiring 回归（真实模块图）", () => {
  const EXPECTED_TOPICS = ["loginMac", "device/up/+", "zhianxin/event/report"];

  let moduleRef: TestingModule;
  let mockClient: {
    on: jest.Mock;
    end: jest.Mock;
    subscribe: jest.Mock;
    publish: jest.Mock;
  };

  beforeEach(async () => {
    mockClient = {
      on: jest.fn(),
      end: jest.fn((_force: boolean, _opts: object, cb?: () => void) => cb?.()),
      subscribe: jest.fn(
        (_topic: string, _opts: object, cb?: (err?: Error) => void) => cb?.(),
      ),
      publish: jest.fn(),
    };
    (mqtt.connect as jest.Mock).mockReturnValue(mockClient);

    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [() => ({ MQTT_URL: "mqtt://localhost:1883" })],
          ignoreEnvFile: true,
        }),
        MqttModule,
        PrismaModule,
        DeviceLinkModule,
        DeviceStatusModule,
      ],
    })
      .overrideProvider(RedisService)
      .useValue({
        getValue: jest.fn().mockResolvedValue(null),
        setValue: jest.fn().mockResolvedValue(undefined),
        mGetValue: jest.fn().mockResolvedValue([]),
      })
      .overrideProvider(PrismaService)
      .useValue({
        device: {
          upsert: jest.fn().mockResolvedValue({}),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
      })
      .compile();
  });

  afterEach(async () => {
    await moduleRef?.close();
  });

  const fireConnect = () => {
    const connectHandler = mockClient.on.mock.calls.find(
      (call: unknown[]) => call[0] === "connect",
    )?.[1] as (() => void) | undefined;
    expect(connectHandler).toBeDefined();
    connectHandler!();
  };

  const subscribedTopics = () =>
    mockClient.subscribe.mock.calls.map((call: unknown[]) => call[0]);

  it("订阅方 onModuleInit 先于 MqttService 执行时，connect 后仍补订全部主题", () => {
    const mqttService = moduleRef.get(MqttService);
    const deviceLink = moduleRef.get(DeviceLinkService);
    const deviceStatus = moduleRef.get(DeviceStatusService);

    // 复现 2026-11-20 事故时序：DeviceLinkService / DeviceStatusService 先订阅，
    // MqttService 后 connect（client 尚未建立）。
    deviceLink.onModuleInit();
    deviceStatus.onModuleInit();
    mqttService.onModuleInit();

    fireConnect();

    expect(subscribedTopics()).toEqual(expect.arrayContaining(EXPECTED_TOPICS));
  });

  it("Nest 真实生命周期（module.init）驱动下，全部主题最终被订阅", async () => {
    await moduleRef.init();

    fireConnect();

    expect(subscribedTopics()).toEqual(expect.arrayContaining(EXPECTED_TOPICS));
  });
});
