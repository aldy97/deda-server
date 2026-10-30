import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { io } from "socket.io-client";
import { VendorReplyUploader } from "./vendor-reply.uploader";
import { VendorTrafficRecorder } from "./traffic-recorder";

jest.mock("socket.io-client");
const mockedIo = io as jest.MockedFunction<typeof io>;

describe("VendorReplyUploader", () => {
  const createMockSocket = () => {
    const socket: any = {
      connected: false,
      handlers: {} as Record<string, (...args: any[]) => void>,
      on: jest.fn((event: string, cb: (...args: any[]) => void) => {
        socket.handlers[event] = cb;
        return socket;
      }),
      timeout: jest.fn(),
      emit: jest.fn(),
      disconnect: jest.fn(),
    };
    socket.timeout.mockReturnValue(socket);
    return socket;
  };

  const buildModule = async (env: Record<string, string>) => {
    const recordMock = jest.fn();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VendorReplyUploader,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => env[key]),
          },
        },
        {
          provide: VendorTrafficRecorder,
          useValue: { record: recordMock },
        },
      ],
    }).compile();
    return {
      uploader: module.get<VendorReplyUploader>(VendorReplyUploader),
      recordMock,
    };
  };

  const chunk = {
    deviceId: "dev-001",
    turnId: "turn-1",
    seq: 0,
    source: "filler" as const,
    delta: "嗯",
    isFinal: false,
  };

  afterEach(() => {
    jest.clearAllMocks();
  });

  it("should skip sending when VENDOR_WS_UPLOAD_URL is not configured", async () => {
    const { uploader } = await buildModule({});

    await uploader.sendChunk(chunk);
    await uploader.sendFullReply({
      deviceId: "dev-001",
      responseText: "Hi!",
    });

    expect(mockedIo).not.toHaveBeenCalled();
  });

  it("should record outbound traffic even when uploader is not configured", async () => {
    const { uploader, recordMock } = await buildModule({});

    await uploader.sendChunk(chunk);

    expect(recordMock).toHaveBeenCalledWith(
      "out",
      chunk,
      expect.objectContaining({
        event: "vendor:text:chunk",
        deviceId: "dev-001",
      }),
    );
  });

  it("should connect lazily and emit chunk with ack", async () => {
    const socket = createMockSocket();
    socket.emit.mockImplementation(
      (_event: string, _data: unknown, ack: (err: Error | null) => void) =>
        ack(null),
    );
    mockedIo.mockReturnValue(socket);

    const { uploader } = await buildModule({
      VENDOR_WS_UPLOAD_URL: "http://vendor-cloud/ws",
    });
    const sendPromise = uploader.sendChunk(chunk);

    expect(mockedIo).toHaveBeenCalledWith(
      "http://vendor-cloud/ws",
      expect.objectContaining({ transports: ["websocket"] }),
    );
    // 模拟对端连接成功
    socket.connected = true;
    socket.handlers["connect"]();
    await sendPromise;

    expect(socket.emit).toHaveBeenCalledWith(
      "vendor:text:chunk",
      chunk,
      expect.any(Function),
    );
  });

  it("should reuse the connected socket for subsequent sends", async () => {
    const socket = createMockSocket();
    socket.emit.mockImplementation(
      (_event: string, _data: unknown, ack: (err: Error | null) => void) =>
        ack(null),
    );
    mockedIo.mockReturnValue(socket);

    const { uploader } = await buildModule({
      VENDOR_WS_UPLOAD_URL: "http://vendor-cloud/ws",
    });
    const first = uploader.sendChunk(chunk);
    socket.connected = true;
    socket.handlers["connect"]();
    await first;

    await uploader.sendChunk({ ...chunk, seq: 1 });
    await uploader.sendFullReply({
      deviceId: "dev-001",
      responseText: "Hi!",
    });

    expect(mockedIo).toHaveBeenCalledTimes(1);
    expect(socket.emit).toHaveBeenCalledTimes(3);
    expect(socket.emit.mock.calls[2][0]).toBe("vendor:text:out");
  });

  it("should reject when the ack reports an error", async () => {
    const socket = createMockSocket();
    socket.emit.mockImplementation(
      (_event: string, _data: unknown, ack: (err: Error | null) => void) =>
        ack(new Error("ack timeout")),
    );
    mockedIo.mockReturnValue(socket);

    const { uploader } = await buildModule({
      VENDOR_WS_UPLOAD_URL: "http://vendor-cloud/ws",
    });
    const sendPromise = uploader.sendChunk(chunk);
    socket.connected = true;
    socket.handlers["connect"]();
    // emit 在 connect 之后的微任务里触发，先让出事件循环
    await expect(sendPromise).rejects.toThrow("ack timeout");
  });

  it("should disconnect on module destroy", async () => {
    const socket = createMockSocket();
    mockedIo.mockReturnValue(socket);

    const { uploader } = await buildModule({
      VENDOR_WS_UPLOAD_URL: "http://vendor-cloud/ws",
    });
    socket.emit.mockImplementation(
      (_event: string, _data: unknown, ack: (err: Error | null) => void) =>
        ack(null),
    );
    const sendPromise = uploader.sendChunk(chunk);
    socket.connected = true;
    socket.handlers["connect"]();
    await sendPromise;

    uploader.onModuleDestroy();

    expect(socket.disconnect).toHaveBeenCalled();
  });
});
