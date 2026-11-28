declare module "ali-oss" {
  export interface OSSOptions {
    region?: string;
    accessKeyId?: string;
    accessKeySecret?: string;
    bucket?: string;
    endpoint?: string;
    secure?: boolean;
  }

  export interface OSSPutResult {
    name: string;
    url: string;
    res?: { status?: number };
  }

  export default class OSS {
    constructor(options: OSSOptions);
    put(
      name: string,
      body: Buffer | string,
      options?: { mime?: string; headers?: Record<string, string> },
    ): Promise<OSSPutResult>;
    get(name: string): Promise<{ content: Buffer }>;
    delete(name: string): Promise<unknown>;
    signatureUrl(
      name: string,
      options?: { expires?: number; method?: string },
    ): string;
    getBucketInfo(name?: string): Promise<unknown>;
    getBucketACL(name?: string): Promise<{ acl?: string }>;
  }
}
