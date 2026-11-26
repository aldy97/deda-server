import type { Readable } from "stream";

export interface MemoryStorageFile {
  stream: Readable;
  fieldname?: string;
  originalname?: string;
  encoding?: string;
  mimetype?: string;
}

export interface MemoryStorageInfo {
  buffer: Buffer;
  size: number;
}

export type MemoryStorageCallback = (
  err: Error | null,
  info?: MemoryStorageInfo,
) => void;

/**
 * multer 兼容的内存存储引擎。
 * 项目未安装 @types/multer，无法 `import { memoryStorage } from "multer"`，
 * 这里按 multer 的 storage engine 契约（_handleFile / _removeFile）实现等价物。
 */
export function createMemoryStorage() {
  return {
    _handleFile(
      _req: unknown,
      file: MemoryStorageFile,
      cb: MemoryStorageCallback,
    ): void {
      const chunks: Buffer[] = [];
      let size = 0;
      file.stream.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        chunks.push(buffer);
        size += buffer.length;
      });
      file.stream.on("error", (err: Error) => cb(err));
      file.stream.on("end", () =>
        cb(null, { buffer: Buffer.concat(chunks), size }),
      );
    },
    _removeFile(
      _req: unknown,
      _file: unknown,
      cb: (err: Error | null) => void,
    ): void {
      cb(null);
    },
  };
}
