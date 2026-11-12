import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException, Logger } from "@nestjs/common";
import { DeviceLinkService } from "./device-link.service";
import { DevicePresenceService } from "./device-presence.service";
import { MqttService } from "@/common/mqtt/mqtt.service";
import { RedisService } from "@/common/redis/redis.service";
import { PrismaService } from "@/common/prisma/prisma.service";

const flushPromises = async (ticks = 3) => {
  for (let i = 0; i < ticks; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

describe("DeviceLinkService", () => {
  let service: DeviceLinkService;
  let mqttService: any;
  let redisService: any;
  let prisma: any;
  let module: TestingModule;

  beforeEach(async () => {
    module = await Test.createTestingModule({
      providers: [
        DeviceLinkService,
        {
          provide: MqttService,
          useValue: {
            subscribe: jest.fn(),
            publish: jest.fn(),
            onMessage: jest.fn(),
          },
        },
        {
          provide: RedisService,
          useValue: {
            getValue: jest.fn().mockResolvedValue(null),
            setValue: jest.fn().mockResolvedValue(undefined),
            mGetValue: jest.fn().mockResolvedValue([]),
          },
        },
        {
          provide: PrismaService,
          useValue: {
            device: {
              upsert: jest.fn().mockResolvedValue({}),
              updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            },
          },
        },
        {
          provide: DevicePresenceService,
          useValue: {
            record: jest.fn().mockResolvedValue(undefined),
            flush: jest.fn().mockResolvedValue(undefined),
          },
        },
      ],
    }).compile();

    service = module.get<DeviceLinkService>(DeviceLinkService);
    mqttService = module.get(MqttService);
    redisService = module.get(RedisService);
    prisma = module.get(PrismaService);
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  describe("onModuleInit", () => {
    it("should subscribe loginMac and device/up/+ topics", () => {
      service.onModuleInit();

      expect(mqttService.subscribe).toHaveBeenCalledWith("loginMac");
      expect(mqttService.subscribe).toHaveBeenCalledWith("device/up/+");
      expect(mqttService.onMessage).toHaveBeenCalledWith(expect.any(Function));
    });
  });

  describe("loginMac 入库", () => {
    it("should upsert device by normalized mac and touch lastSeenAt", async () => {
      const payload = Buffer.from(
        JSON.stringify({ device: "aa:bb:cc:dd:ee:ff" }),
      );

      service.handleMessage("loginMac", payload);
      await flushPromises();

      expect(prisma.device.upsert).toHaveBeenCalledWith({
        where: { deviceId: "AABBCCDDEEFF" },
        create: { deviceId: "AABBCCDDEEFF", macAddress: "AABBCCDDEEFF" },
        update: { macAddress: "AABBCCDDEEFF" },
      });

      expect(redisService.setValue).toHaveBeenCalledWith(
        "device:link:AABBCCDDEEFF",
        expect.any(String),
        3600,
      );
      const cached = JSON.parse(redisService.setValue.mock.calls[0][1]);
      expect(cached.mac).toBe("AABBCCDDEEFF");
      expect(typeof cached.lastSeenAt).toBe("number");
    });

    it("should ignore loginMac without device field", async () => {
      const loggerWarnSpy = jest
        .spyOn((service as any).logger, "warn")
        .mockImplementation();

      service.handleMessage("loginMac", Buffer.from(JSON.stringify({})));
      await flushPromises();

      expect(prisma.device.upsert).not.toHaveBeenCalled();
      expect(loggerWarnSpy).toHaveBeenCalled();
    });

    it("should ignore invalid JSON payload", async () => {
      const loggerWarnSpy = jest
        .spyOn((service as any).logger, "warn")
        .mockImplementation();

      service.handleMessage("loginMac", Buffer.from("not-json"));
      await flushPromises();

      expect(prisma.device.upsert).not.toHaveBeenCalled();
      expect(loggerWarnSpy).toHaveBeenCalled();
    });
  });

  describe("device/up 状态上报", () => {
    it("should merge query report and update firmwareVersion", async () => {
      const payload = Buffer.from(
        JSON.stringify({
          cmd: "query",
          flag: "success",
          data: { battery: 80, volume: 50, version: "1.2.3" },
        }),
      );

      service.handleMessage("device/up/AABBCCDDEEFF", payload);
      await flushPromises();

      expect(redisService.setValue).toHaveBeenCalledWith(
        "device:link:AABBCCDDEEFF",
        expect.any(String),
        3600,
      );
      const cached = JSON.parse(redisService.setValue.mock.calls[0][1]);
      expect(cached.battery).toBe(80);
      expect(cached.volume).toBe(50);
      expect(cached.version).toBe("1.2.3");

      expect(prisma.device.updateMany).toHaveBeenCalledWith({
        where: {
          OR: [{ deviceId: "aabbccddeeff" }, { macAddress: "aabbccddeeff" }],
        },
        data: { firmwareVersion: "1.2.3" },
      });
    });

    it("should merge charging flag from query report (protocol extension)", async () => {
      const payload = Buffer.from(
        JSON.stringify({
          cmd: "query",
          flag: "success",
          data: { battery: 80, charging: true },
        }),
      );

      service.handleMessage("device/up/AABBCCDDEEFF", payload);
      await flushPromises();

      const cached = JSON.parse(redisService.setValue.mock.calls[0][1]);
      expect(cached.charging).toBe(true);
      expect(cached.battery).toBe(80);
    });

    it("should keep cached charging when query report omits it", async () => {
      redisService.getValue.mockResolvedValue(
        JSON.stringify({
          mac: "AABBCCDDEEFF",
          battery: 66,
          volume: 40,
          version: "1.2.3",
          charging: false,
          lastSeenAt: Date.now(),
        }),
      );
      const payload = Buffer.from(
        JSON.stringify({
          cmd: "query",
          flag: "success",
          data: { battery: 70 },
        }),
      );

      service.handleMessage("device/up/AABBCCDDEEFF", payload);
      await flushPromises();

      const cached = JSON.parse(redisService.setValue.mock.calls[0][1]);
      expect(cached.charging).toBe(false);
      expect(cached.battery).toBe(70);
    });

    it("should keep cached battery when volume reply only carries volume", async () => {
      redisService.getValue.mockResolvedValue(
        JSON.stringify({
          mac: "AABBCCDDEEFF",
          battery: 66,
          volume: 40,
          version: "1.2.3",
          lastSeenAt: Date.now(),
        }),
      );

      const payload = Buffer.from(
        JSON.stringify({
          cmd: "volume",
          flag: "success",
          data: { volume: 30 },
        }),
      );

      service.handleMessage("device/up/AABBCCDDEEFF", payload);
      await flushPromises();

      const cached = JSON.parse(redisService.setValue.mock.calls[0][1]);
      expect(cached.volume).toBe(30);
      expect(cached.battery).toBe(66);
      expect(cached.version).toBe("1.2.3");
      // volume 回执不含 version，不应触发固件版本落库
      expect(prisma.device.updateMany).not.toHaveBeenCalled();
    });

    it("should refresh lastSeenAt on unknown cmd without writing DB", async () => {
      const payload = Buffer.from(
        JSON.stringify({ cmd: "some-future-cmd", flag: "success", data: null }),
      );

      service.handleMessage("device/up/AABBCCDDEEFF", payload);
      await flushPromises();

      expect(redisService.setValue).toHaveBeenCalled();
      expect(prisma.device.updateMany).not.toHaveBeenCalled();
    });

    it("should ignore messages on unrelated topics", async () => {
      service.handleMessage("device/down/AABBCCDDEEFF", Buffer.from("{}"));
      service.handleMessage("zhianxin/event/report", Buffer.from("{}"));
      await flushPromises();

      expect(redisService.setValue).not.toHaveBeenCalled();
      expect(prisma.device.upsert).not.toHaveBeenCalled();
    });

    it("should ignore up message without cmd", async () => {
      const loggerWarnSpy = jest
        .spyOn((service as any).logger, "warn")
        .mockImplementation();

      service.handleMessage(
        "device/up/AABBCCDDEEFF",
        Buffer.from(JSON.stringify({ flag: "success" })),
      );
      await flushPromises();

      expect(redisService.setValue).not.toHaveBeenCalled();
      expect(loggerWarnSpy).toHaveBeenCalled();
    });

    it("should accept lowercase mac in topic and normalize it", async () => {
      const payload = Buffer.from(
        JSON.stringify({
          cmd: "query",
          flag: "success",
          data: { battery: 90 },
        }),
      );

      service.handleMessage("device/up/aabbccddeeff", payload);
      await flushPromises();

      expect(redisService.setValue).toHaveBeenCalledWith(
        "device:link:AABBCCDDEEFF",
        expect.any(String),
        3600,
      );
    });

    it("should persist firmwareVersion against the lowercase deviceId used by HTTP loginMac", async () => {
      // 机芯厂真实报文（2026-11-12）：topic 用小写 MAC，Device.deviceId 亦为小写；
      // Redis key 用大写口径，Prisma 查询必须用小写口径，两者不可混用。
      const payload = Buffer.from(
        JSON.stringify({
          cmd: "query",
          flag: "success",
          data: { battery: 75, volume: 80, version: "1.0.7", charging: null },
        }),
      );

      service.handleMessage("device/up/9c230cb5d3d4", payload);
      await flushPromises();

      expect(redisService.setValue).toHaveBeenCalledWith(
        "device:link:9C230CB5D3D4",
        expect.any(String),
        3600,
      );
      const cached = JSON.parse(redisService.setValue.mock.calls[0][1]);
      expect(cached.battery).toBe(75);
      expect(cached.volume).toBe(80);
      expect(cached.version).toBe("1.0.7");
      expect(cached.charging).toBeNull();

      expect(prisma.device.updateMany).toHaveBeenCalledWith({
        where: {
          OR: [{ deviceId: "9c230cb5d3d4" }, { macAddress: "9c230cb5d3d4" }],
        },
        data: { firmwareVersion: "1.0.7" },
      });
    });

    it("should warn when firmwareVersion matches no Device row", async () => {
      const warnSpy = jest
        .spyOn(Logger.prototype, "warn")
        .mockImplementation(() => undefined);
      prisma.device.updateMany.mockResolvedValue({ count: 0 });
      const payload = Buffer.from(
        JSON.stringify({
          cmd: "query",
          flag: "success",
          data: { version: "1.0.7" },
        }),
      );

      service.handleMessage("device/up/9c230cb5d3d4", payload);
      await flushPromises();

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("9c230cb5d3d4"),
      );
      warnSpy.mockRestore();
    });

    it("should keep cached charging when the report sends explicit null", async () => {
      // 机芯厂 v1.1 契约 charging 为 boolean | null；显式 null = 当前未知，
      // 与 battery / volume / version 同口径保留上一次已知值。
      redisService.getValue.mockResolvedValue(
        JSON.stringify({
          mac: "AABBCCDDEEFF",
          battery: 80,
          volume: 50,
          version: "1.2.3",
          charging: true,
          lastSeenAt: Date.now(),
        }),
      );
      const payload = Buffer.from(
        JSON.stringify({
          cmd: "query",
          flag: "success",
          data: { battery: 75, volume: 80, version: "1.0.7", charging: null },
        }),
      );

      service.handleMessage("device/up/AABBCCDDEEFF", payload);
      await flushPromises();

      const cached = JSON.parse(redisService.setValue.mock.calls[0][1]);
      expect(cached.charging).toBe(true);
      expect(cached.volume).toBe(80);
      expect(cached.battery).toBe(75);
    });
  });

  describe("getStatus 在线判定", () => {
    it("should be online when lastSeenAt within 15s window", async () => {
      redisService.getValue.mockResolvedValue(
        JSON.stringify({
          mac: "AABBCCDDEEFF",
          battery: 80,
          volume: 50,
          version: "1.2.3",
          lastSeenAt: Date.now() - 10_000,
        }),
      );

      const status = await service.getStatus("AABBCCDDEEFF");

      expect(status.online).toBe(true);
      expect(status.battery).toBe(80);
    });

    it("should be offline when lastSeenAt exceeds 15s window", async () => {
      redisService.getValue.mockResolvedValue(
        JSON.stringify({
          mac: "AABBCCDDEEFF",
          battery: 80,
          volume: 50,
          version: "1.2.3",
          lastSeenAt: Date.now() - 16_000,
        }),
      );

      const status = await service.getStatus("AABBCCDDEEFF");

      expect(status.online).toBe(false);
    });

    it("should return empty offline status on cache miss", async () => {
      const status = await service.getStatus("aa-bb-cc-dd-ee-ff");

      expect(status).toEqual({
        mac: "AABBCCDDEEFF",
        battery: null,
        volume: null,
        version: null,
        charging: null,
        lastSeenAt: null,
        online: false,
      });
    });
  });

  describe("下行指令", () => {
    it("setVolume should publish volume command to device/down/{mac}", () => {
      service.setVolume("AABBCCDDEEFF", 30);

      expect(mqttService.publish).toHaveBeenCalledWith(
        "device/down/AABBCCDDEEFF",
        JSON.stringify({
          cmd: "volume",
          flag: "success",
          data: { volume: 30 },
        }),
      );
    });

    it("setVolume should reject out-of-range values", () => {
      expect(() => service.setVolume("AABBCCDDEEFF", 101)).toThrow(
        BadRequestException,
      );
      expect(() => service.setVolume("AABBCCDDEEFF", -1)).toThrow(
        BadRequestException,
      );
      expect(() => service.setVolume("AABBCCDDEEFF", 50.5)).toThrow(
        BadRequestException,
      );
      expect(mqttService.publish).not.toHaveBeenCalled();
    });

    it("requestStatus should publish query with null data", () => {
      service.requestStatus("AABBCCDDEEFF");

      expect(mqttService.publish).toHaveBeenCalledWith(
        "device/down/AABBCCDDEEFF",
        JSON.stringify({ cmd: "query", flag: "success", data: null }),
      );
    });

    it("restartDevice / triggerUpgrade / factoryReset should publish matching commands", () => {
      service.restartDevice("AABBCCDDEEFF");
      service.triggerUpgrade("AABBCCDDEEFF");
      service.factoryReset("AABBCCDDEEFF");

      const payloads = mqttService.publish.mock.calls.map(
        (call: any[]) => JSON.parse(call[1]).cmd,
      );
      expect(payloads).toEqual(["restart", "upgrade", "recover"]);
      expect(
        mqttService.publish.mock.calls.every(
          (call: any[]) => call[0] === "device/down/AABBCCDDEEFF",
        ),
      ).toBe(true);
    });
  });

  describe("getStatusBatch", () => {
    const now = Date.now();

    it("normalises mixed-case MACs to uppercase keys", async () => {
      redisService.mGetValue.mockResolvedValue([
        JSON.stringify({
          mac: "AABBCCDDEEFF",
          battery: 80,
          volume: 50,
          version: "1.2.3",
          lastSeenAt: now - 5_000,
        }),
        JSON.stringify({
          mac: "112233445566",
          battery: 60,
          volume: null,
          version: null,
          lastSeenAt: now - 5_000,
        }),
      ]);

      const result = await service.getStatusBatch([
        "aa-bb-cc-dd-ee-ff",
        "11:22:33:44:55:66",
      ]);

      expect(result.size).toBe(2);
      expect(result.has("AABBCCDDEEFF")).toBe(true);
      expect(result.has("112233445566")).toBe(true);
      expect(result.get("AABBCCDDEEFF")?.online).toBe(true);
      expect(result.get("112233445566")?.online).toBe(true);
    });

    it("returns empty status maps with online=false on full cache miss", async () => {
      redisService.mGetValue.mockResolvedValue([null, null]);

      const result = await service.getStatusBatch([
        "AABBCCDDEEFF",
        "112233445566",
      ]);

      expect(result.size).toBe(2);
      expect(result.get("AABBCCDDEEFF")).toEqual({
        mac: "AABBCCDDEEFF",
        battery: null,
        volume: null,
        version: null,
        charging: null,
        lastSeenAt: null,
        online: false,
      });
      expect(result.get("112233445566")?.online).toBe(false);
    });

    it("marks online=false when lastSeenAt exceeds 15s window", async () => {
      redisService.mGetValue.mockResolvedValue([
        JSON.stringify({
          mac: "AABBCCDDEEFF",
          battery: 80,
          volume: 50,
          version: "1.2.3",
          lastSeenAt: now - 20_000,
        }),
      ]);

      const result = await service.getStatusBatch(["AABBCCDDEEFF"]);

      expect(result.get("AABBCCDDEEFF")?.online).toBe(false);
    });

    it("deduplicates MACs and queries Redis only once each", async () => {
      redisService.mGetValue.mockResolvedValue([
        JSON.stringify({
          mac: "AABBCCDDEEFF",
          battery: 80,
          volume: 50,
          version: "1.2.3",
          lastSeenAt: now - 5_000,
        }),
      ]);

      const result = await service.getStatusBatch([
        "aa:bb:cc:dd:ee:ff",
        "AA-BB-CC-DD-EE-FF",
        "aabbccddeeff",
      ]);

      expect(result.size).toBe(1);
      expect(redisService.mGetValue).toHaveBeenCalledWith([
        "device:link:AABBCCDDEEFF",
      ]);
    });

    it("returns empty Map without touching Redis when input is empty", async () => {
      const result = await service.getStatusBatch([]);

      expect(result.size).toBe(0);
      expect(redisService.mGetValue).not.toHaveBeenCalled();
    });
  });

  describe("device presence recording", () => {
    let presenceService: { record: jest.Mock };

    beforeEach(() => {
      presenceService = module.get(DevicePresenceService);
    });

    it("should call presence.record with uppercase MAC on valid device/up message", async () => {
      const payload = Buffer.from(
        JSON.stringify({
          cmd: "query",
          flag: "success",
          data: { battery: 80 },
        }),
      );

      service.handleMessage("device/up/aa-bb-cc-dd-ee-ff", payload);
      await flushPromises();

      expect(presenceService.record).toHaveBeenCalledWith(
        "AABBCCDDEEFF",
        expect.any(Date),
      );
    });

    it("should NOT call presence.record when payload has no cmd", async () => {
      service.handleMessage(
        "device/up/AABBCCDDEEFF",
        Buffer.from(JSON.stringify({ flag: "success" })),
      );
      await flushPromises();

      expect(presenceService.record).not.toHaveBeenCalled();
    });

    it("should still complete the main flow when presence.record throws", async () => {
      presenceService.record.mockRejectedValue(new Error("presence down"));

      const payload = Buffer.from(
        JSON.stringify({
          cmd: "query",
          flag: "success",
          data: { battery: 80 },
        }),
      );

      service.handleMessage("device/up/AABBCCDDEEFF", payload);
      await flushPromises();

      // Main flow should still work: Redis status written
      expect(redisService.setValue).toHaveBeenCalledWith(
        "device:link:AABBCCDDEEFF",
        expect.any(String),
        3600,
      );
      const cached = JSON.parse(redisService.setValue.mock.calls[0][1]);
      expect(cached.battery).toBe(80);
    });
  });
});
