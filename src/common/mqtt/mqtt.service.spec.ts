import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { MqttService } from "./mqtt.service";
import * as mqtt from "mqtt";

jest.mock("mqtt");

describe("MqttService", () => {
  let service: MqttService;
  let config: ConfigService;
  let mockClient: any;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockClient = {
      on: jest.fn(),
      end: jest.fn(),
      subscribe: jest.fn(),
      publish: jest.fn(),
    };

    (mqtt.connect as jest.Mock).mockReturnValue(mockClient);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MqttService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<MqttService>(MqttService);
    config = module.get<ConfigService>(ConfigService);
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  describe("connect", () => {
    it("should create mqtt client and register event handlers", () => {
      service.connect("mqtt://localhost:1883");

      expect(mqtt.connect).toHaveBeenCalledWith("mqtt://localhost:1883", {
        reconnectPeriod: 5000,
        connectTimeout: 30000,
        clean: true,
      });
      expect(mockClient.on).toHaveBeenCalledWith(
        "connect",
        expect.any(Function),
      );
      expect(mockClient.on).toHaveBeenCalledWith(
        "message",
        expect.any(Function),
      );
      expect(mockClient.on).toHaveBeenCalledWith("error", expect.any(Function));
      expect(mockClient.on).toHaveBeenCalledWith("close", expect.any(Function));
      expect(mockClient.on).toHaveBeenCalledWith(
        "reconnect",
        expect.any(Function),
      );
    });
  });

  describe("subscribe", () => {
    it("should subscribe to topic with QoS 1 when connected", () => {
      service.connect("mqtt://localhost:1883");
      service.subscribe("zhianxin/event/report");

      expect(mockClient.subscribe).toHaveBeenCalledWith(
        "zhianxin/event/report",
        { qos: 1 },
        expect.any(Function),
      );
    });

    it("should warn when client is not connected", () => {
      const loggerWarnSpy = jest
        .spyOn((service as any).logger, "warn")
        .mockImplementation();
      service.subscribe("device/+/status");

      expect(mockClient.subscribe).not.toHaveBeenCalled();
      expect(loggerWarnSpy).toHaveBeenCalled();
    });
  });

  describe("publish", () => {
    it("should publish message with QoS 1 and retain false when connected", () => {
      service.connect("mqtt://localhost:1883");
      service.publish(
        "zhianxin/event/report",
        JSON.stringify({ online: true }),
      );

      expect(mockClient.publish).toHaveBeenCalledWith(
        "zhianxin/event/report",
        JSON.stringify({ online: true }),
        { qos: 1, retain: false },
        expect.any(Function),
      );
    });

    it("should warn when client is not connected", () => {
      const loggerWarnSpy = jest
        .spyOn((service as any).logger, "warn")
        .mockImplementation();
      service.publish("device/dev-001/status", "payload");

      expect(mockClient.publish).not.toHaveBeenCalled();
      expect(loggerWarnSpy).toHaveBeenCalled();
    });
  });

  describe("onMessage", () => {
    it("should register message handler and invoke it on message", () => {
      const handler = jest.fn();
      service.onMessage(handler);

      service.connect("mqtt://localhost:1883");
      const messageHandler = mockClient.on.mock.calls.find(
        (call: any[]) => call[0] === "message",
      )[1];
      const payload = Buffer.from("test");
      messageHandler("device/dev-001/status", payload);

      expect(handler).toHaveBeenCalledWith("device/dev-001/status", payload);
    });
  });

  describe("disconnect", () => {
    it("should force close the client and wait for its close callback", async () => {
      mockClient.end.mockImplementation(
        (_force: boolean, _options: object, callback: () => void) => {
          callback();
        },
      );
      service.connect("mqtt://localhost:1883");

      await service.disconnect();

      expect(mockClient.end).toHaveBeenCalledWith(
        true,
        {},
        expect.any(Function),
      );
      expect(service.getClient()).toBeUndefined();
    });
  });

  describe("connection callbacks and shutdown", () => {
    it("handles connection lifecycle events", () => {
      service.connect("mqtt://localhost:1883");
      const handlers = new Map<string, (...args: unknown[]) => void>(
        mockClient.on.mock.calls,
      );

      handlers.get("connect")?.();
      handlers.get("error")?.(new Error("connection failed"));
      handlers.get("close")?.();
      handlers.get("reconnect")?.();

      expect(mockClient.on).toHaveBeenCalledTimes(5);
    });

    it("handles subscribe and publish callbacks", () => {
      service.connect("mqtt://localhost:1883");
      service.subscribe("device/+/status");
      service.publish("device/dev-001/status", "payload");
      const subscribeCallback = mockClient.subscribe.mock.calls[0][2] as (
        error?: Error,
      ) => void;
      const publishCallback = mockClient.publish.mock.calls[0][3] as (
        error?: Error,
      ) => void;

      subscribeCallback(new Error("subscribe failed"));
      subscribeCallback();
      publishCallback(new Error("publish failed"));
      publishCallback();

      expect(mockClient.subscribe).toHaveBeenCalledTimes(1);
      expect(mockClient.publish).toHaveBeenCalledTimes(1);
    });

    it("waits for MQTT shutdown during module destruction", async () => {
      mockClient.end.mockImplementation(
        (_force: boolean, _options: object, callback: () => void) => {
          callback();
        },
      );
      service.connect("mqtt://localhost:1883");

      await service.onModuleDestroy();

      expect(mockClient.end).toHaveBeenCalledWith(
        true,
        {},
        expect.any(Function),
      );
      await expect(service.onModuleDestroy()).resolves.toBeUndefined();
    });
  });

  describe("onModuleInit", () => {
    it("should connect when MQTT_URL is configured", () => {
      (config.get as jest.Mock).mockReturnValue("mqtt://localhost:1883");
      service.onModuleInit();

      expect(mqtt.connect).toHaveBeenCalledWith("mqtt://localhost:1883", {
        reconnectPeriod: 5000,
        connectTimeout: 30000,
        clean: true,
      });
    });

    it("should warn when MQTT_URL is not configured", () => {
      (config.get as jest.Mock).mockReturnValue(undefined);
      const loggerWarnSpy = jest
        .spyOn((service as any).logger, "warn")
        .mockImplementation();
      service.onModuleInit();

      expect(mqtt.connect).not.toHaveBeenCalled();
      expect(loggerWarnSpy).toHaveBeenCalled();
    });
  });
});
