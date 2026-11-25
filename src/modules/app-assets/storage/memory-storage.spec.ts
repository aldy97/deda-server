import { PassThrough } from "stream";
import { createMemoryStorage } from "./memory-storage";

describe("createMemoryStorage", () => {
  it("返回 multer 兼容的 storage engine", () => {
    const storage = createMemoryStorage();
    expect(typeof storage._handleFile).toBe("function");
    expect(typeof storage._removeFile).toBe("function");
  });

  it("_handleFile 把多个 chunk 合并成 buffer", async () => {
    const storage = createMemoryStorage();
    const stream = new PassThrough();
    const result: {
      err: Error | null;
      info?: { buffer: Buffer; size: number };
    } = { err: null };

    await new Promise<void>((resolve) => {
      storage._handleFile({}, { stream }, (err, info) => {
        result.err = err;
        result.info = info;
        resolve();
      });
      stream.write(Buffer.from("hello "));
      stream.write("world");
      stream.end();
    });

    expect(result.err).toBeNull();
    expect(result.info?.buffer.toString()).toBe("hello world");
    expect(result.info?.size).toBe(11);
  });

  it("_handleFile 透传 stream 错误", async () => {
    const storage = createMemoryStorage();
    const stream = new PassThrough();
    const result: { err: Error | null } = { err: null };

    await new Promise<void>((resolve) => {
      storage._handleFile({}, { stream }, (err) => {
        result.err = err;
        resolve();
      });
      stream.emit("error", new Error("boom"));
    });

    expect(result.err?.message).toBe("boom");
  });

  it("_removeFile 立即回调成功", () => {
    const storage = createMemoryStorage();
    const cb = jest.fn();
    storage._removeFile({}, {}, cb);
    expect(cb).toHaveBeenCalledWith(null);
  });
});
