import { Test, TestingModule } from "@nestjs/testing";
import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import axios, { AxiosError } from "axios";
import { BaiduAgentClient } from "./baidu-agent-client.service";
import { DEFAULT_BAIDU_AGENT_TIMEOUT_MS } from "./baidu-agent.types";

jest.mock("axios");
const mockedAxios = axios as jest.Mocked<typeof axios>;

// 文档示例值
const VALID_ACCESS_KEY_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const VALID_SIGNATURE =
  "47724e42fb47545f86b15d3e4672a7c94a226cee4247147cc44e12ab0248d03d";
const VALID_TIMESTAMP = "2015-04-27T08:23:49Z";
const VALID_SIGNED_HEADERS = "content-type;host;x-bce-date";

const buildAuthString = (overrides?: {
  accessKeyId?: string;
  timestamp?: string;
  expires?: string;
  signedHeaders?: string;
  signature?: string;
}) => {
  const o = {
    accessKeyId: VALID_ACCESS_KEY_ID,
    timestamp: VALID_TIMESTAMP,
    expires: "1800",
    signedHeaders: VALID_SIGNED_HEADERS,
    signature: VALID_SIGNATURE,
    ...overrides,
  };
  return `bce-auth-v1/${o.accessKeyId}/${o.timestamp}/${o.expires}/${o.signedHeaders}/${o.signature}`;
};

const buildConfigService = (overrides?: Record<string, string>) => ({
  get: jest.fn((key: string) => {
    const map: Record<string, string> = {
      BAIDU_AGENT_ENABLED: "true",
      BAIDU_AGENT_TIMEOUT_MS: "5000",
      ...overrides,
    };
    return map[key] ?? undefined;
  }),
});

describe("BaiduAgentClient", () => {
  let client: BaiduAgentClient;

  const createModule = async (configOverrides?: Record<string, string>) => {
    const cfg = buildConfigService(configOverrides);
    const module: TestingModule = await Test.createTestingModule({
      providers: [BaiduAgentClient, { provide: ConfigService, useValue: cfg }],
    }).compile();
    return module.get<BaiduAgentClient>(BaiduAgentClient);
  };

  beforeEach(async () => {
    client = await createModule();
    jest.clearAllMocks();
  });

  // =========================================================
  // enabled
  // =========================================================
  describe("enabled", () => {
    it("BAIDU_AGENT_ENABLED === 'true' 时 enabled 为 true", () => {
      expect(client.enabled).toBe(true);
    });

    it("BAIDU_AGENT_ENABLED 缺失时 enabled 为 false（默认关闭）", async () => {
      const c = await createModule({ BAIDU_AGENT_ENABLED: undefined });
      expect(c.enabled).toBe(false);
    });

    it("BAIDU_AGENT_ENABLED === 'false' 时 enabled 为 false", async () => {
      const c = await createModule({ BAIDU_AGENT_ENABLED: "false" });
      expect(c.enabled).toBe(false);
    });
  });

  // =========================================================
  // fail-closed 守卫（每层断言 axios 未被调用）
  // =========================================================
  const guardParams = {
    appId: "test-app",
    instanceId: "1234567890",
    tts: 'DEFAULT{"vcn":"1000063"}',
    authString: buildAuthString(),
    cloudNode: "cn",
    lang: "zh",
  };

  describe("守卫层 1：enabled=false → disabled", () => {
    it("switchSceneRole 直接返回 disabled，不发起 HTTP 请求", async () => {
      const c = await createModule({ BAIDU_AGENT_ENABLED: "false" });
      const result = await c.switchSceneRole(guardParams);
      expect(result).toEqual({ ok: false, reason: "disabled" });
      expect(mockedAxios.request).not.toHaveBeenCalled();
    });

    it("interrupt 直接返回 disabled，不发起 HTTP 请求", async () => {
      const c = await createModule({ BAIDU_AGENT_ENABLED: "false" });
      const result = await c.interrupt({
        appId: "test-app",
        instanceId: "1234567890",
        extraMsg: "hello",
        authString: buildAuthString(),
        cloudNode: "cn",
      });
      expect(result).toEqual({ ok: false, reason: "disabled" });
      expect(mockedAxios.request).not.toHaveBeenCalled();
    });
  });

  describe("守卫层 2：parseBceAuthString 返回 null → signature_unparsable", () => {
    it("空 authString → signature_unparsable，不发起 HTTP 请求", async () => {
      const result = await client.switchSceneRole({
        ...guardParams,
        authString: "",
      });
      expect(result).toEqual({ ok: false, reason: "signature_unparsable" });
      expect(mockedAxios.request).not.toHaveBeenCalled();
    });
  });

  describe("守卫层 3：!hasRequiredSignedHeaders → signed_headers_unexpected", () => {
    it("缺少 host → signed_headers_unexpected，不发起 HTTP 请求", async () => {
      const authString = buildAuthString({
        signedHeaders: "content-type;x-bce-date",
      });
      const result = await client.switchSceneRole({
        ...guardParams,
        authString,
      });
      expect(result).toEqual({
        ok: false,
        reason: "signed_headers_unexpected",
      });
      expect(mockedAxios.request).not.toHaveBeenCalled();
    });
  });

  describe("守卫层 4：isBceAuthExpired → signature_expired", () => {
    it("过期签名 → signature_expired，不发起 HTTP 请求", async () => {
      const result = await client.switchSceneRole(guardParams);
      // 2015 年的签名必定过期
      expect(result).toEqual({ ok: false, reason: "signature_expired" });
      expect(mockedAxios.request).not.toHaveBeenCalled();
    });
  });

  describe("守卫层 5：BAIDU_AGENT_HOSTS[cloudNode] 不存在 → unsupported_cloud_node", () => {
    it("需要一条未过期的签名来测试 host 守卫", async () => {
      const now = new Date();
      const timestamp = now.toISOString().replace(/\.\d{3}Z$/, "Z");
      const freshAuth = buildAuthString({ timestamp });

      const result = await client.switchSceneRole({
        ...guardParams,
        authString: freshAuth,
        cloudNode: "overseas",
      });
      expect(result).toEqual({ ok: false, reason: "unsupported_cloud_node" });
      expect(mockedAxios.request).not.toHaveBeenCalled();
    });
  });

  describe("守卫层 6：instanceId 或 appId 非法 → invalid_request", () => {
    it("instanceId 非数字 → invalid_request", async () => {
      const now = new Date();
      const timestamp = now.toISOString().replace(/\.\d{3}Z$/, "Z");
      const freshAuth = buildAuthString({ timestamp });

      const result = await client.switchSceneRole({
        ...guardParams,
        authString: freshAuth,
        instanceId: "abc",
      });
      expect(result).toEqual({ ok: false, reason: "invalid_request" });
      expect(mockedAxios.request).not.toHaveBeenCalled();
    });

    it("appId 为空字符串 → invalid_request", async () => {
      const now = new Date();
      const timestamp = now.toISOString().replace(/\.\d{3}Z$/, "Z");
      const freshAuth = buildAuthString({ timestamp });

      const result = await client.switchSceneRole({
        ...guardParams,
        authString: freshAuth,
        appId: "",
      });
      expect(result).toEqual({ ok: false, reason: "invalid_request" });
      expect(mockedAxios.request).not.toHaveBeenCalled();
    });
  });

  // =========================================================
  // switchSceneRole 成功路径
  // =========================================================
  describe("switchSceneRole 成功", () => {
    it("2xx 响应 → {ok:true}，断言完整 URL、请求头、body", async () => {
      mockedAxios.request.mockResolvedValueOnce({
        status: 200,
        data: {},
      });

      const now = new Date();
      const timestamp = now.toISOString().replace(/\.\d{3}Z$/, "Z");
      const authString = buildAuthString({ timestamp });
      const params = {
        appId: "test-app",
        instanceId: "1234567890",
        tts: 'DEFAULT{"vcn":"1000063","spd":0.8}',
        authString,
        cloudNode: "cn",
        lang: "zh",
      };

      const result = await client.switchSceneRole(params);
      expect(result).toEqual({ ok: true });

      // 断言 axios 调用参数
      expect(mockedAxios.request).toHaveBeenCalledTimes(1);
      const callArgs = mockedAxios.request.mock.calls[0][0];

      // URL
      expect(callArgs.url).toBe(
        "https://rtc-aiagent.baidubce.com/api/v1/aiagent/instances/operation?switchSceneRole=",
      );
      expect(callArgs.method).toBe("PUT");

      // 请求头
      expect(callArgs.headers).toMatchObject({
        host: "rtc-aiagent.baidubce.com",
        "content-type": "application/json",
        authorization: authString,
        "x-bce-date": timestamp,
      });
      expect(callArgs.headers["x-bce-request-id"]).toBeDefined();
      expect(typeof callArgs.headers["x-bce-request-id"]).toBe("string");

      // body 原始字符串逐字符相等
      expect(callArgs.data).toBe(
        '{"app_id":"test-app","ai_agent_instance_id":1234567890,"tts":"DEFAULT{\\"vcn\\":\\"1000063\\",\\"spd\\":0.8}","lang":"zh"}',
      );

      // timeout
      expect(callArgs.timeout).toBe(5000);
    });

    it("不传 lang 时 body 不含 lang 字段", async () => {
      mockedAxios.request.mockResolvedValueOnce({
        status: 200,
        data: {},
      });

      const now = new Date();
      const timestamp = now.toISOString().replace(/\.\d{3}Z$/, "Z");
      const authString = buildAuthString({ timestamp });

      await client.switchSceneRole({
        appId: "test-app",
        instanceId: "1234567890",
        tts: 'DEFAULT{"vcn":"1000063"}',
        authString,
        cloudNode: "cn",
      });

      const callArgs = mockedAxios.request.mock.calls[0][0];
      expect(callArgs.data).not.toContain("lang");
    });

    it("传空字符串 lang 时 body 也不含 lang 字段", async () => {
      mockedAxios.request.mockResolvedValueOnce({
        status: 200,
        data: {},
      });

      const now = new Date();
      const timestamp = now.toISOString().replace(/\.\d{3}Z$/, "Z");
      const authString = buildAuthString({ timestamp });

      await client.switchSceneRole({
        appId: "test-app",
        instanceId: "1234567890",
        tts: 'DEFAULT{"vcn":"1000063"}',
        authString,
        cloudNode: "cn",
        lang: "",
      });

      const callArgs = mockedAxios.request.mock.calls[0][0];
      expect(callArgs.data).not.toContain("lang");
    });

    it("int64 精度：9223372036854775806 原样嵌入 body 逐字符不变", async () => {
      mockedAxios.request.mockResolvedValueOnce({
        status: 200,
        data: {},
      });

      const now = new Date();
      const timestamp = now.toISOString().replace(/\.\d{3}Z$/, "Z");
      const authString = buildAuthString({ timestamp });
      const bigInt64 = "9223372036854775806";

      await client.switchSceneRole({
        appId: "test-app",
        instanceId: bigInt64,
        tts: 'DEFAULT{"vcn":"1000063"}',
        authString,
        cloudNode: "cn",
      });

      const callArgs = mockedAxios.request.mock.calls[0][0];
      expect(callArgs.data).toContain(`"ai_agent_instance_id":${bigInt64}`);
    });

    it("成功日志包含 cloudNode、instanceId、x-bce-request-id，不含 authString", async () => {
      const logSpy = jest.spyOn(Logger.prototype, "log");

      mockedAxios.request.mockResolvedValueOnce({
        status: 200,
        data: {},
      });

      const now = new Date();
      const timestamp = now.toISOString().replace(/\.\d{3}Z$/, "Z");
      const authString = buildAuthString({ timestamp });

      await client.switchSceneRole({
        appId: "test-app",
        instanceId: "1234567890",
        tts: 'DEFAULT{"vcn":"1000063"}',
        authString,
        cloudNode: "cn",
      });

      // 至少有一行成功日志
      const logCalls = logSpy.mock.calls.flat().join(" ");
      expect(logCalls).toContain("rtc-aiagent.baidubce.com");
      expect(logCalls).toContain("1234567890");
      // 不含 authString / authorization / accessKeyId / signature
      expect(logCalls).not.toContain(authString);
      expect(logCalls).not.toContain("bce-auth-v1");

      logSpy.mockRestore();
    });
  });

  // =========================================================
  // interrupt 成功路径
  // =========================================================
  describe("interrupt 成功", () => {
    it("POST 到 interrupt 端点，body 含 app_id、ai_agent_instance_id、extra_msg", async () => {
      mockedAxios.request.mockResolvedValueOnce({
        status: 200,
        data: {},
      });

      const now = new Date();
      const timestamp = now.toISOString().replace(/\.\d{3}Z$/, "Z");
      const authString = buildAuthString({ timestamp });

      const result = await client.interrupt({
        appId: "test-app",
        instanceId: "999",
        extraMsg: "打断文本",
        authString,
        cloudNode: "cn",
      });

      expect(result).toEqual({ ok: true });

      const callArgs = mockedAxios.request.mock.calls[0][0];
      expect(callArgs.url).toBe(
        "https://rtc-aiagent.baidubce.com/api/v1/aiagent/interrupt",
      );
      expect(callArgs.method).toBe("POST");

      // body 含 extra_msg
      expect(callArgs.data).toContain('"extra_msg":');
      expect(callArgs.data).toContain('"ai_agent_instance_id":999');
    });

    it("不传 extraMsg 时 body 不含 extra_msg", async () => {
      mockedAxios.request.mockResolvedValueOnce({
        status: 200,
        data: {},
      });

      const now = new Date();
      const timestamp = now.toISOString().replace(/\.\d{3}Z$/, "Z");
      const authString = buildAuthString({ timestamp });

      await client.interrupt({
        appId: "test-app",
        instanceId: "999",
        extraMsg: "",
        authString,
        cloudNode: "cn",
      });

      const callArgs = mockedAxios.request.mock.calls[0][0];
      expect(callArgs.data).not.toContain("extra_msg");
    });
  });

  // =========================================================
  // 上游错误
  // =========================================================
  describe("上游错误处理", () => {
    it("400 NoSuchSceneRole → upstream_error，detail 含 code", async () => {
      mockedAxios.request.mockRejectedValueOnce({
        isAxiosError: true,
        response: {
          status: 400,
          data: { code: "NoSuchSceneRole", message: "scene role not found" },
        },
        message: "Request failed with status code 400",
      } as AxiosError);

      const now = new Date();
      const timestamp = now.toISOString().replace(/\.\d{3}Z$/, "Z");
      const authString = buildAuthString({ timestamp });

      const result = await client.switchSceneRole({
        appId: "test-app",
        instanceId: "1234567890",
        tts: 'DEFAULT{"vcn":"1000063"}',
        authString,
        cloudNode: "cn",
      });

      expect(result).toEqual({
        ok: false,
        reason: "upstream_error",
        detail: expect.stringContaining("400"),
      });
      expect(result).toEqual({
        ok: false,
        reason: "upstream_error",
        detail: expect.stringContaining("NoSuchSceneRole"),
      });
    });

    it("400 无 code 时 fallback 到 message", async () => {
      mockedAxios.request.mockRejectedValueOnce({
        isAxiosError: true,
        response: {
          status: 400,
          data: { message: "bad request" },
        },
        message: "Request failed",
      } as AxiosError);

      const now = new Date();
      const timestamp = now.toISOString().replace(/\.\d{3}Z$/, "Z");
      const authString = buildAuthString({ timestamp });

      const result = await client.switchSceneRole({
        appId: "test-app",
        instanceId: "1234567890",
        tts: 'DEFAULT{"vcn":"1000063"}',
        authString,
        cloudNode: "cn",
      });

      expect(result).toEqual({
        ok: false,
        reason: "upstream_error",
        detail: expect.stringContaining("bad request"),
      });
    });

    it("超时 → upstream_error，detail 含 ECONNABORTED", async () => {
      mockedAxios.request.mockRejectedValueOnce({
        isAxiosError: true,
        code: "ECONNABORTED",
        message: "timeout of 5000ms exceeded",
      } as AxiosError);

      const now = new Date();
      const timestamp = now.toISOString().replace(/\.\d{3}Z$/, "Z");
      const authString = buildAuthString({ timestamp });

      const result = await client.switchSceneRole({
        appId: "test-app",
        instanceId: "1234567890",
        tts: 'DEFAULT{"vcn":"1000063"}',
        authString,
        cloudNode: "cn",
      });

      expect(result).toEqual({
        ok: false,
        reason: "upstream_error",
        detail: expect.stringContaining("ECONNABORTED"),
      });
    });

    it("网络异常 → upstream_error，detail 不含 authorization", async () => {
      mockedAxios.request.mockRejectedValueOnce({
        isAxiosError: true,
        code: "ENOTFOUND",
        message: "getaddrinfo ENOTFOUND",
      } as AxiosError);

      const now = new Date();
      const timestamp = now.toISOString().replace(/\.\d{3}Z$/, "Z");
      const authString = buildAuthString({ timestamp });

      const result = await client.switchSceneRole({
        appId: "test-app",
        instanceId: "1234567890",
        tts: 'DEFAULT{"vcn":"1000063"}',
        authString,
        cloudNode: "cn",
      });

      expect(result.ok).toBe(false);
      // detail 不含 authString
      const { detail } = result as {
        ok: false;
        reason: string;
        detail?: string;
      };
      expect(detail).not.toContain(authString);
      expect(detail).not.toContain("bce-auth-v1");
    });
  });

  // =========================================================
  // 安全用例：authorization 不出现在日志里
  // =========================================================
  describe("安全：authorization 不泄露", () => {
    it("失败日志不含 authString / bce-auth-v1", async () => {
      const warnSpy = jest.spyOn(Logger.prototype, "warn");

      mockedAxios.request.mockRejectedValueOnce({
        isAxiosError: true,
        response: {
          status: 400,
          data: { code: "NoSuchSceneRole" },
        },
      } as AxiosError);

      const now = new Date();
      const timestamp = now.toISOString().replace(/\.\d{3}Z$/, "Z");
      const authString = buildAuthString({ timestamp });

      await client.switchSceneRole({
        appId: "test-app",
        instanceId: "1234567890",
        tts: 'DEFAULT{"vcn":"1000063"}',
        authString,
        cloudNode: "cn",
      });

      const warnCalls = warnSpy.mock.calls.flat().join(" ");
      expect(warnCalls).not.toContain(authString);
      expect(warnCalls).not.toContain("bce-auth-v1");
      expect(warnCalls).not.toContain(VALID_ACCESS_KEY_ID);
      expect(warnCalls).not.toContain(VALID_SIGNATURE);

      warnSpy.mockRestore();
    });

    it("守卫层失败日志不含 authString", async () => {
      const warnSpy = jest.spyOn(Logger.prototype, "warn");

      await client.switchSceneRole({
        ...guardParams,
        authString: "",
      });

      const warnCalls = warnSpy.mock.calls.flat().join(" ");
      expect(warnCalls).not.toContain("bce-auth-v1");
      // reason 出现在日志里
      expect(warnCalls).toContain("signature_unparsable");

      warnSpy.mockRestore();
    });
  });

  // =========================================================
  // 超时配置
  // =========================================================
  describe("超时配置", () => {
    it("BAIDU_AGENT_TIMEOUT_MS 非法值时回退到默认值", async () => {
      const c = await createModule({ BAIDU_AGENT_TIMEOUT_MS: "not-a-number" });
      mockedAxios.request.mockResolvedValueOnce({ status: 200, data: {} });

      const now = new Date();
      const timestamp = now.toISOString().replace(/\.\d{3}Z$/, "Z");
      const authString = buildAuthString({ timestamp });

      await c.switchSceneRole({
        appId: "test-app",
        instanceId: "1234567890",
        tts: 'DEFAULT{"vcn":"1000063"}',
        authString,
        cloudNode: "cn",
      });

      const callArgs = mockedAxios.request.mock.calls[0][0];
      expect(callArgs.timeout).toBe(DEFAULT_BAIDU_AGENT_TIMEOUT_MS);
    });
  });
});
