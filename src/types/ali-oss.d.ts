declare module "ali-oss" {
  namespace OSS {
    interface OSSOptions {
      region?: string;
      accessKeyId?: string;
      accessKeySecret?: string;
      bucket?: string;
      endpoint?: string;
      secure?: boolean;
    }

    interface OSSPutResult {
      name: string;
      url: string;
      res?: { status?: number };
    }
  }

  class OSS {
    constructor(options: OSS.OSSOptions);
    put(
      name: string,
      body: Buffer | string,
      options?: { mime?: string; headers?: Record<string, string> },
    ): Promise<OSS.OSSPutResult>;
    get(name: string): Promise<{ content: Buffer }>;
    delete(name: string): Promise<unknown>;
    list(query: { prefix?: string; "max-keys"?: number }): Promise<unknown>;
    signatureUrl(
      name: string,
      options?: {
        expires?: number;
        method?: string;
        response?: Record<string, string>;
      },
    ): string;
    getBucketInfo(
      name?: string,
    ): Promise<{ bucket?: { Location?: string }; res?: unknown }>;
    getBucketACL(name?: string): Promise<{ acl?: string }>;
  }

  // ali-oss 是 CommonJS 包：module.exports = 构造函数，没有 .default。
  // 本仓库 tsconfig 未开 esModuleInterop，必须用 export= + import= 配对，
  // 否则编译产物取 .default 会在运行时抛 "not a constructor"。
  export = OSS;
}
