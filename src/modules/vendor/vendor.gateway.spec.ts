import { Test, TestingModule } from "@nestjs/testing";
import { validate } from "class-validator";
import { VendorGateway } from "./vendor.gateway";
import { VendorService } from "./vendor.service";
import { VendorTextInDto } from "./dto/vendor-text-in.dto";
import { VendorTextChunkDto } from "./dto/vendor-text-chunk.dto";
import { VendorTrafficRecorder } from "./traffic-recorder";

describe("VendorGateway", () => {
  let gateway: VendorGateway;
  let vendorService: jest.Mocked<VendorService>;
  let trafficRecorder: { record: jest.Mock };

  const mockEmit = jest.fn();
  const mockTo = jest.fn().mockReturnValue({ emit: mockEmit });
  const mockServer = {
    emit: mockEmit,
    to: mockTo,
  } as any;

  const createMockClient = (id = "socket-001") =>
    ({
      id,
      emit: jest.fn(),
      join: jest.fn(),
      leave: jest.fn(),
      disconnect: jest.fn(),
      handshake: { query: {} },
    }) as any;

  beforeEach(async () => {
    mockEmit.mockClear();
    mockTo.mockClear();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VendorGateway,
        {
          provide: VendorService,
          useValue: {
            handleTextIn: jest.fn(),
            handleStatusReport: jest.fn(),
            handleBindCallback: jest.fn(),
            handleConversationBackup: jest.fn(),
            getHealth: jest.fn(),
            sendDegradedReply: jest.fn(),
          },
        },
        {
          provide: VendorTrafficRecorder,
          useValue: { record: jest.fn() },
        },
      ],
    }).compile();

    gateway = module.get<VendorGateway>(VendorGateway);
    vendorService = module.get(VendorService);
    trafficRecorder = module.get(VendorTrafficRecorder) as any;

    gateway.server = mockServer;
  });

  it("should be defined", () => {
    expect(gateway).toBeDefined();
  });

  describe("handleConnection", () => {
    it("should accept a vendor client connection", () => {
      const client = createMockClient("socket-001");
      gateway.handleConnection(client);
      expect(gateway["deviceSocketMap"].has("socket-001")).toBe(false);
    });
  });

  describe("handleDisconnect", () => {
    it("should clean up device mapping on disconnect", () => {
      const client = createMockClient("socket-002");
      gateway["deviceSocketMap"].set("dev-002", "socket-002");

      gateway.handleDisconnect(client);

      expect(gateway["deviceSocketMap"].has("dev-002")).toBe(false);
    });
  });

  describe("handlePing", () => {
    it("should reply vendor:pong with timestamp", () => {
      const client = createMockClient();
      const before = Date.now();

      gateway.handlePing(client);

      const after = Date.now();
      expect(client.emit).toHaveBeenCalledTimes(1);
      expect(client.emit).toHaveBeenCalledWith(
        "vendor:pong",
        expect.objectContaining({
          timestamp: expect.any(Number),
        }),
      );

      const [, payload] = client.emit.mock.calls[0];
      expect(payload.timestamp).toBeGreaterThanOrEqual(before);
      expect(payload.timestamp).toBeLessThanOrEqual(after);
    });
  });

  describe("handleTextIn", () => {
    it("should process text and emit vendor:text:out to the same client", async () => {
      const client = createMockClient("socket-003");
      const dto: VendorTextInDto = {
        deviceId: "dev-003",
        asrText: "你好",
      };
      const reply = {
        deviceId: "dev-003",
        responseText: "收到：你好",
        context: {},
        ttsOptions: {},
      };

      vendorService.handleTextIn.mockResolvedValue(reply);

      const result = await gateway.handleTextIn(client, dto);

      expect(vendorService.handleTextIn).toHaveBeenCalledWith(dto);
      expect(client.emit).toHaveBeenCalledWith("vendor:text:out", reply);
      expect(result).toEqual(reply);
      expect(gateway["deviceSocketMap"].get("dev-003")).toBe("socket-003");
    });

    it("should record in/out traffic for a successful turn", async () => {
      const client = createMockClient("socket-003b");
      const dto: VendorTextInDto = { deviceId: "dev-003", asrText: "你好" };
      const reply = {
        deviceId: "dev-003",
        responseText: "收到：你好",
        context: {},
        ttsOptions: {},
      };
      vendorService.handleTextIn.mockResolvedValue(reply);

      await gateway.handleTextIn(client, dto);

      expect(trafficRecorder.record).toHaveBeenCalledWith(
        "in",
        dto,
        expect.objectContaining({
          event: "vendor:text:in",
          deviceId: "dev-003",
        }),
      );
      expect(trafficRecorder.record).toHaveBeenCalledWith(
        "out",
        reply,
        expect.objectContaining({
          event: "vendor:text:out",
          deviceId: "dev-003",
        }),
      );
    });

    it("should record the raw payload even when validation fails", async () => {
      const client = createMockClient("socket-005b");
      const invalidPayload = { deviceId: "", asrText: "" } as VendorTextInDto;

      await gateway.handleTextIn(client, invalidPayload);

      expect(trafficRecorder.record).toHaveBeenCalledWith(
        "in",
        invalidPayload,
        expect.objectContaining({ event: "vendor:text:in" }),
      );
    });

    it("should emit vendor:error when service throws", async () => {
      const client = createMockClient("socket-004");
      const dto: VendorTextInDto = {
        deviceId: "dev-004",
        asrText: "你好",
      };

      vendorService.handleTextIn.mockRejectedValue(new Error("LLM timeout"));

      const result = await gateway.handleTextIn(client, dto);

      expect(client.emit).toHaveBeenCalledWith(
        "vendor:error",
        expect.objectContaining({
          event: "vendor:text:in",
          message: "LLM timeout",
        }),
      );
      expect(result).toBeNull();
    });

    it("should emit vendor:error for invalid payload", async () => {
      const client = createMockClient("socket-005");
      const invalidPayload = { deviceId: "", asrText: "" } as VendorTextInDto;

      const result = await gateway.handleTextIn(client, invalidPayload);

      expect(client.emit).toHaveBeenCalledWith(
        "vendor:error",
        expect.objectContaining({
          event: "vendor:text:in",
          message: expect.stringContaining("deviceId"),
        }),
      );
      expect(vendorService.handleTextIn).not.toHaveBeenCalled();
      expect(result).toBeNull();
    });
  });

  describe("VendorTextChunkDto", () => {
    const buildChunk = () =>
      Object.assign(new VendorTextChunkDto(), {
        deviceId: "dev-001",
        turnId: "turn-1",
        seq: 0,
        source: "filler",
        delta: "嗯",
        isFinal: false,
      });

    it("should pass validation for a valid chunk", async () => {
      const errors = await validate(buildChunk());
      expect(errors).toHaveLength(0);
    });

    it("should reject a source outside filler/answer", async () => {
      const chunk = buildChunk();
      (chunk as any).source = "other";
      const errors = await validate(chunk);
      expect(errors.length).toBeGreaterThan(0);
    });

    it("should reject negative-seq-like non-number values", async () => {
      const chunk = buildChunk();
      (chunk as any).seq = "0";
      const errors = await validate(chunk);
      expect(errors.length).toBeGreaterThan(0);
    });
  });

  /**
   * 「永不沉默」的最后一道闸。
   *
   * gateway 原先在 catch 里只 emitError：设备端收到 vendor:error 后无话可播，
   * 孩子听到的就是静音。现在先尽力下行一句 L0 兜底话术，再发错误通知
   * （错误通知仍要发，机芯厂要靠它判活）。兜底话术自己也失败时，
   * 至少不能让 handleTextIn 抛出未捕获拒绝。
   */
  describe("L0 兜底话术下行", () => {
    const dto: VendorTextInDto = { deviceId: "dev-l0", asrText: "你好" };
    const degraded = {
      deviceId: "dev-l0",
      responseText: "我在这儿呢，我们等一会儿再玩好不好？",
      context: { degraded: true },
      ttsOptions: {},
    };

    it("服务抛错时先下行兜底话术，再发 vendor:error", async () => {
      const client = createMockClient("socket-l0");
      vendorService.handleTextIn.mockRejectedValue(new Error("pipeline down"));
      vendorService.sendDegradedReply.mockResolvedValue(degraded);

      const result = await gateway.handleTextIn(client, dto);

      expect(vendorService.sendDegradedReply).toHaveBeenCalledWith("dev-l0");
      expect(client.emit).toHaveBeenCalledWith("vendor:text:out", degraded);
      expect(client.emit).toHaveBeenCalledWith(
        "vendor:error",
        expect.objectContaining({ message: "pipeline down" }),
      );
      expect(result).toBeNull();
      // 兜底话术同样要进流量录制，事后才能证明孩子到底听到了什么
      expect(trafficRecorder.record).toHaveBeenCalledWith(
        "out",
        degraded,
        expect.objectContaining({ deviceId: "dev-l0" }),
      );
    });

    it("兜底话术在错误通知之前发出（顺序错了孩子就先听到报错提示音）", async () => {
      const client = createMockClient("socket-l0-order");
      vendorService.handleTextIn.mockRejectedValue(new Error("pipeline down"));
      vendorService.sendDegradedReply.mockResolvedValue(degraded);

      await gateway.handleTextIn(client, dto);

      const events = client.emit.mock.calls.map((call) => call[0]);
      expect(events.indexOf("vendor:text:out")).toBeLessThan(
        events.indexOf("vendor:error"),
      );
    });

    it("兜底话术自己也失败时仍然发 vendor:error，且不抛未捕获拒绝", async () => {
      const client = createMockClient("socket-l0-fail");
      vendorService.handleTextIn.mockRejectedValue(new Error("pipeline down"));
      vendorService.sendDegradedReply.mockRejectedValue(new Error("ws down"));

      const result = await gateway.handleTextIn(client, dto);

      expect(client.emit).toHaveBeenCalledWith(
        "vendor:error",
        expect.objectContaining({ message: "pipeline down" }),
      );
      expect(result).toBeNull();
    });

    it("payload 非法时不下行兜底话术：没有可信 deviceId，发出去也是发给空气", async () => {
      const client = createMockClient("socket-l0-invalid");

      await gateway.handleTextIn(client, {
        deviceId: "",
        asrText: "",
      } as VendorTextInDto);

      expect(vendorService.sendDegradedReply).not.toHaveBeenCalled();
    });
  });
});
