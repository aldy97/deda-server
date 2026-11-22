/**
 * 音色/语速动态切换 e2e（HTTP 契约层）。
 *
 * 覆盖：JWT 鉴权（401/403）、DTO 校验（400）、统一响应信封、GET/POST 返回体形状、
 * 期望值落库与失效旧配置、以及「目录为空 fail-closed」与「目录已填充」两种形态。
 *
 * 与 test/device-configs.e2e-spec.ts 同一做法：PrismaService 用内存替身，
 * 只验证 HTTP 契约，不验证真实 SQL。
 *
 * 三个百度侧端口（catalog / reconcile / client）全部 override，
 * 且全程不设置 BAIDU_AGENT_ENABLED 与真实音色目录，因此本文件绝不会出网。
 */

import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import * as request from "supertest";
import { JwtService } from "@nestjs/jwt";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/common/prisma/prisma.service";
import { ResponseInterceptor } from "../src/common/interceptors/response.interceptor";
import { HttpExceptionFilter } from "../src/common/filters/http-exception.filter";
import {
  BAIDU_AGENT_CLIENT_PORT,
  VOICE_CATALOG_PORT,
  VOICE_RECONCILE_PORT,
  VoiceApplyBlockReason,
  VoiceApplyOutcome,
  VoiceCatalogEntry,
} from "../src/modules/baidu-agent/baidu-agent.types";

const OWNED_DEVICE_ID = "dev-001";
const OTHER_DEVICE_ID = "dev-002";
const DEVICE_INTERNAL_ID = "device-uuid-001";
const DEVICE_MAC = "aabbccddeeff";

interface FakeConfig {
  id: string;
  deviceId: string;
  mode: string;
  cefrLevel: string | null;
  language: string | null;
  speechRate: string | null;
  isActive: boolean;
  payload: unknown;
  createdAt: Date;
}

interface ConfigWhere {
  deviceId?: string;
  isActive?: boolean;
  device?: { deviceId?: string };
}

interface FindFirstArgs {
  where?: ConfigWhere;
  orderBy?: { createdAt?: "asc" | "desc" };
}

describe("VoiceConfigs (e2e)", () => {
  let app: INestApplication;
  let jwtToken: string;

  // ---- 可变替身状态：目录 / 语速映射 / 下发结果 / 配置行 ----
  let catalogEntries: VoiceCatalogEntry[] = [];
  let normalSpd = 0.7;
  let applyOutcome: VoiceApplyOutcome = {
    applied: "deferred",
    reason: "empty_catalog" as VoiceApplyBlockReason,
  };
  let configStore: FakeConfig[] = [];
  let createdArgs: Array<{ data: Omit<FakeConfig, "id" | "createdAt"> }> = [];
  let configSeq = 0;

  const resolveInternalId = (where?: ConfigWhere): string | null => {
    if (!where) return null;
    if (where.deviceId) return where.deviceId;
    const businessId = where.device?.deviceId;
    if (!businessId) return null;
    return businessId === OWNED_DEVICE_ID ? DEVICE_INTERNAL_ID : null;
  };

  const mockBinding = {
    id: "binding-001",
    device: {
      id: DEVICE_INTERNAL_ID,
      deviceId: OWNED_DEVICE_ID,
      macAddress: DEVICE_MAC,
    },
  };

  const deviceConfigUpdateMany = jest.fn(
    (args: { where?: ConfigWhere; data?: { isActive?: boolean } }) => {
      const internalId = resolveInternalId(args.where);
      let count = 0;
      for (const config of configStore) {
        if (config.deviceId !== internalId) continue;
        if (args.where?.isActive !== undefined) {
          if (config.isActive !== args.where.isActive) continue;
        }
        config.isActive = args.data?.isActive ?? config.isActive;
        count += 1;
      }
      return Promise.resolve({ count });
    },
  );

  const mockPrismaService = {
    $connect: jest.fn().mockResolvedValue(undefined),
    $disconnect: jest.fn().mockResolvedValue(undefined),
    $transaction: jest.fn(
      (
        cb: (tx: {
          deviceConfig: { updateMany: typeof deviceConfigUpdateMany };
        }) => unknown,
      ) => cb({ deviceConfig: { updateMany: deviceConfigUpdateMany } }),
    ),
    userDeviceBinding: {
      findFirst: jest.fn(
        (args: { where?: { device?: { deviceId?: string } } }) =>
          Promise.resolve(
            args?.where?.device?.deviceId === OWNED_DEVICE_ID
              ? mockBinding
              : null,
          ),
      ),
    },
    deviceConfig: {
      findFirst: jest.fn((args: FindFirstArgs) => {
        const internalId = resolveInternalId(args?.where);
        const rows = configStore.filter((config) => {
          if (config.deviceId !== internalId) return false;
          if (args?.where?.isActive !== undefined) {
            return config.isActive === args.where.isActive;
          }
          return true;
        });
        if (rows.length === 0) return Promise.resolve(null);
        const desc = args?.orderBy?.createdAt !== "asc";
        const sorted = [...rows].sort((a, b) =>
          desc
            ? b.createdAt.getTime() - a.createdAt.getTime()
            : a.createdAt.getTime() - b.createdAt.getTime(),
        );
        return Promise.resolve({ ...sorted[0] });
      }),
      updateMany: deviceConfigUpdateMany,
      create: jest.fn(
        (args: { data: Omit<FakeConfig, "id" | "createdAt"> }) => {
          createdArgs.push(args);
          const record: FakeConfig = {
            ...args.data,
            id: `config-${++configSeq}`,
            createdAt: new Date(Date.now() + configSeq),
          };
          configStore.push(record);
          return Promise.resolve({ ...record });
        },
      ),
    },
  };

  const mockVoiceCatalog = {
    listUsable: (): VoiceCatalogEntry[] =>
      catalogEntries.filter((entry) => entry.status === "TRAINED"),
    listForLang: (): VoiceCatalogEntry[] => [],
    find: (timbreId: string): VoiceCatalogEntry | null =>
      catalogEntries.find(
        (entry) => entry.timbreId === timbreId && entry.status === "TRAINED",
      ) ?? null,
    get available(): boolean {
      return catalogEntries.some((entry) => entry.status === "TRAINED");
    },
  };

  const mockVoiceReconcile = {
    applyToActiveInstance: jest.fn(
      async (): Promise<VoiceApplyOutcome> => applyOutcome,
    ),
    onInstanceRegistered: jest.fn(async (): Promise<VoiceApplyOutcome> => ({
      applied: "noop",
    })),
    resolveNormalSpd: jest.fn(async (): Promise<number> => normalSpd),
    resolveSleepSpd: jest.fn(async (): Promise<number> => 0.5),
    resolveActiveSpd: jest.fn(async (): Promise<number> => normalSpd),
    noteApplied: jest.fn(async (): Promise<void> => undefined),
  };

  const mockBaiduAgentClient = {
    enabled: false,
    switchSceneRole: jest.fn(),
    interrupt: jest.fn(),
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue(mockPrismaService)
      .overrideProvider(VOICE_CATALOG_PORT)
      .useValue(mockVoiceCatalog)
      .overrideProvider(VOICE_RECONCILE_PORT)
      .useValue(mockVoiceReconcile)
      .overrideProvider(BAIDU_AGENT_CLIENT_PORT)
      .useValue(mockBaiduAgentClient)
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
      }),
    );
    app.useGlobalInterceptors(new ResponseInterceptor());
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();

    jwtToken = moduleFixture
      .get(JwtService)
      .sign({ sub: "user-001", openid: "dev-openid-stable" });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    catalogEntries = [];
    normalSpd = 0.7;
    configStore = [];
    createdArgs = [];
    applyOutcome = { applied: "deferred", reason: "empty_catalog" };
    jest.clearAllMocks();
  });

  const authedGet = (url: string) =>
    request(app.getHttpServer())
      .get(url)
      .set("Authorization", `Bearer ${jwtToken}`);

  const authedPost = (url: string) =>
    request(app.getHttpServer())
      .post(url)
      .set("Authorization", `Bearer ${jwtToken}`);

  const voiceUrl = (deviceId: string) => `/device-configs/${deviceId}/voice`;

  // ================================================================
  // 鉴权
  // ================================================================
  describe("authentication", () => {
    it("rejects GET without JWT with 401", () =>
      request(app.getHttpServer()).get(voiceUrl(OWNED_DEVICE_ID)).expect(401));

    it("rejects POST without JWT with 401", () =>
      request(app.getHttpServer())
        .post(voiceUrl(OWNED_DEVICE_ID))
        .send({ speechRate: "slow" })
        .expect(401));

    it("rejects GET on a device not bound to the caller with 403", () =>
      authedGet(voiceUrl(OTHER_DEVICE_ID)).expect(403));

    it("rejects POST on a device not bound to the caller with 403", () =>
      authedPost(voiceUrl(OTHER_DEVICE_ID))
        .send({ speechRate: "slow" })
        .expect(403));
  });

  // ================================================================
  // GET — 目录为空（placeholder 未填充）
  // ================================================================
  describe("GET /device-configs/:deviceId/voice with an empty catalog", () => {
    it("reports available=false, empty catalog and reason=empty_catalog", () =>
      authedGet(voiceUrl(OWNED_DEVICE_ID))
        .expect(200)
        .expect((res) => {
          expect(res.body.code).toBe(0);
          expect(res.body.data.deviceId).toBe(OWNED_DEVICE_ID);
          expect(res.body.data.available).toBe(false);
          expect(res.body.data.catalog).toEqual([]);
          expect(res.body.data.canApplyLive).toBe(false);
          expect(res.body.data.reason).toBe("empty_catalog");
        }));

    it("returns null vcn/speechRate and the global normal spd when nothing was configured", () =>
      authedGet(voiceUrl(OWNED_DEVICE_ID))
        .expect(200)
        .expect((res) => {
          expect(res.body.data.vcn).toBeNull();
          expect(res.body.data.speechRate).toBeNull();
          expect(res.body.data.spd).toBe(0.7);
        }));

    it("never queries Redis for liveness: no reconcile side effect on read", () =>
      authedGet(voiceUrl(OWNED_DEVICE_ID))
        .expect(200)
        .then(() => {
          expect(
            mockVoiceReconcile.applyToActiveInstance,
          ).not.toHaveBeenCalled();
          expect(
            mockVoiceReconcile.onInstanceRegistered,
          ).not.toHaveBeenCalled();
        }));
  });

  // ================================================================
  // POST — 参数校验
  // ================================================================
  describe("POST /device-configs/:deviceId/voice validation", () => {
    it("rejects an empty body with 400", () =>
      authedPost(voiceUrl(OWNED_DEVICE_ID)).send({}).expect(400));

    it("rejects an unknown vcn while the catalog is empty with 400", () =>
      authedPost(voiceUrl(OWNED_DEVICE_ID))
        .send({ vcn: "9999999" })
        .expect(400));

    it("rejects a speechRate outside slow/normal/fast with 400", () =>
      authedPost(voiceUrl(OWNED_DEVICE_ID))
        .send({ speechRate: "ultra_fast" })
        .expect(400));

    it("rejects an unknown field with 400 (forbidNonWhitelisted)", () =>
      authedPost(voiceUrl(OWNED_DEVICE_ID))
        .send({ speechRate: "slow", volume: 80 })
        .expect(400));

    it("does not persist anything when validation fails", () =>
      authedPost(voiceUrl(OWNED_DEVICE_ID))
        .send({ vcn: "9999999" })
        .expect(400)
        .then(() => {
          expect(createdArgs).toHaveLength(0);
          expect(
            mockVoiceReconcile.applyToActiveInstance,
          ).not.toHaveBeenCalled();
        }));
  });

  // ================================================================
  // POST — 目录为空时的 deferred 落库
  // ================================================================
  describe("POST /device-configs/:deviceId/voice with an empty catalog", () => {
    it("accepts speechRate only, persists it and reports deferred", () =>
      authedPost(voiceUrl(OWNED_DEVICE_ID))
        .send({ speechRate: "slow" })
        .expect(201)
        .expect((res) => {
          expect(res.body.code).toBe(0);
          expect(res.body.data.deviceId).toBe(OWNED_DEVICE_ID);
          expect(res.body.data.speechRate).toBe("slow");
          expect(res.body.data.vcn).toBeNull();
          expect(res.body.data.spd).toBe(0.7);
          expect(res.body.data.applied).toBe("deferred");
          expect(res.body.data.reason).toBe("empty_catalog");
        })
        .then(() => {
          expect(createdArgs).toHaveLength(1);
          expect(createdArgs[0].data).toMatchObject({
            deviceId: DEVICE_INTERNAL_ID,
            speechRate: "slow",
            isActive: true,
          });
          expect(mockVoiceReconcile.applyToActiveInstance).toHaveBeenCalledWith(
            DEVICE_MAC,
            { vcn: null },
            DEVICE_INTERNAL_ID,
          );
        }));

    it("keeps baseline mode/language and writes no voice payload key", () => {
      configStore.push({
        id: "config-baseline",
        deviceId: DEVICE_INTERNAL_ID,
        mode: "english_chat",
        cefrLevel: "A2",
        language: "en",
        speechRate: "normal",
        isActive: true,
        payload: { keep: true },
        createdAt: new Date(Date.now() - 1000),
      });

      return authedPost(voiceUrl(OWNED_DEVICE_ID))
        .send({ speechRate: "fast" })
        .expect(201)
        .then(() => {
          expect(createdArgs[0].data).toMatchObject({
            mode: "english_chat",
            cefrLevel: "A2",
            language: "en",
            speechRate: "fast",
          });
          expect(createdArgs[0].data.payload).toEqual({ keep: true });
          expect(
            configStore.find((c) => c.id === "config-baseline")?.isActive,
          ).toBe(false);
        });
    });
  });

  // ================================================================
  // 目录已填充（机芯公司导出音色后的形态）
  // ================================================================
  describe("with a populated catalog", () => {
    beforeEach(() => {
      catalogEntries = [
        {
          timbreId: "1000063",
          name: "度小熊",
          status: "TRAINED",
          language: "chinese",
        },
        {
          timbreId: "2000001",
          name: "未训练音色",
          status: "UNTRAINED",
          language: "chinese",
        },
      ];
      normalSpd = 0.7;
      applyOutcome = { applied: "live" };
    });

    it("exposes only TRAINED voices and never the 1-hour audition url", () =>
      authedGet(voiceUrl(OWNED_DEVICE_ID))
        .expect(200)
        .expect((res) => {
          expect(res.body.data.available).toBe(true);
          expect(res.body.data.catalog).toEqual([
            { timbreId: "1000063", name: "度小熊", language: "chinese" },
          ]);
        }));

    it("rejects an UNTRAINED timbreId with 400", () =>
      authedPost(voiceUrl(OWNED_DEVICE_ID))
        .send({ vcn: "2000001" })
        .expect(400));

    it("accepts vcn+speechRate, persists payload.voice and reports live", () =>
      authedPost(voiceUrl(OWNED_DEVICE_ID))
        .send({ vcn: "1000063", speechRate: "fast" })
        .expect(201)
        .expect((res) => {
          expect(res.body.data.vcn).toBe("1000063");
          expect(res.body.data.speechRate).toBe("fast");
          expect(res.body.data.spd).toBe(0.7);
          expect(res.body.data.applied).toBe("live");
          expect(res.body.data.reason).toBeNull();
        })
        .then(() => {
          const payload = createdArgs[0].data.payload as {
            voice?: { vcn?: string };
          };
          expect(payload.voice?.vcn).toBe("1000063");
        }));

    it("reads back the persisted expectation with canApplyLive=true", async () => {
      await authedPost(voiceUrl(OWNED_DEVICE_ID))
        .send({ vcn: "1000063", speechRate: "slow" })
        .expect(201);

      await authedGet(voiceUrl(OWNED_DEVICE_ID))
        .expect(200)
        .expect((res) => {
          expect(res.body.data.vcn).toBe("1000063");
          expect(res.body.data.speechRate).toBe("slow");
          expect(res.body.data.spd).toBe(0.7);
          expect(res.body.data.canApplyLive).toBe(true);
          expect(res.body.data.reason).toBeNull();
        });
    });

    it("merges a vcn-only update onto the persisted speechRate", async () => {
      await authedPost(voiceUrl(OWNED_DEVICE_ID))
        .send({ speechRate: "slow" })
        .expect(201);

      await authedPost(voiceUrl(OWNED_DEVICE_ID))
        .send({ vcn: "1000063" })
        .expect(201)
        .expect((res) => {
          expect(res.body.data.vcn).toBe("1000063");
          expect(res.body.data.speechRate).toBe("slow");
          expect(res.body.data.spd).toBe(0.7);
        });
    });
  });

  // ================================================================
  // 下发失败的降级
  // ================================================================
  describe("degraded apply paths", () => {
    beforeEach(() => {
      catalogEntries = [
        {
          timbreId: "1000063",
          name: "度小熊",
          status: "TRAINED",
          language: "chinese",
        },
      ];
      normalSpd = 0.7;
    });

    it("reports deferred with the upstream reason but still 201", () => {
      applyOutcome = {
        applied: "deferred",
        reason: "no_active_instance" as VoiceApplyBlockReason,
      };

      return authedPost(voiceUrl(OWNED_DEVICE_ID))
        .send({ vcn: "1000063", speechRate: "normal" })
        .expect(201)
        .expect((res) => {
          expect(res.body.data.applied).toBe("deferred");
          expect(res.body.data.reason).toBe("no_active_instance");
        })
        .then(() => {
          expect(createdArgs).toHaveLength(1);
        });
    });

    it("returns 201 with internal_error when reconcile throws", () => {
      mockVoiceReconcile.applyToActiveInstance.mockRejectedValueOnce(
        new Error("redis down"),
      );

      return authedPost(voiceUrl(OWNED_DEVICE_ID))
        .send({ vcn: "1000063", speechRate: "normal" })
        .expect(201)
        .expect((res) => {
          expect(res.body.data.applied).toBe("deferred");
          expect(res.body.data.reason).toBe("internal_error");
        })
        .then(() => {
          expect(createdArgs).toHaveLength(1);
        });
    });
  });
});
