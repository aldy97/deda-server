import { Global, Module } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "@/common/prisma/prisma.service";
import { RedisService } from "@/common/redis/redis.service";
import { BaiduAgentModule } from "./baidu-agent.module";
import { BaiduAgentClient } from "./baidu-agent-client.service";
import { VoiceCatalogService } from "./voice-catalog.service";
import { VoiceReconcileService } from "./voice-reconcile.service";
import {
  BAIDU_AGENT_CLIENT_PORT,
  BaiduAgentClientPort,
  VOICE_CATALOG_PORT,
  VoiceCatalogPort,
  VOICE_RECONCILE_PORT,
  VoiceReconcilePort,
} from "./baidu-agent.types";

/** 消费方探针：三个 token 若未被 BaiduAgentModule exports，这里就会 DI 失败。 */
const CONSUMER_PROBE = "CONSUMER_PROBE";

interface ConsumerProbe {
  catalog: VoiceCatalogPort;
  reconcile: VoiceReconcilePort;
  client: BaiduAgentClientPort;
}

let envValues: Record<string, string | undefined> = {};

/**
 * 替身基础设施模块。
 * 生产环境里 PrismaModule / RedisModule / ConfigModule 都是全局模块，
 * 这里用 @Global 复刻同样的可见性，避免单测连真实 DB / Redis / env。
 */
@Global()
@Module({
  providers: [
    {
      provide: PrismaService,
      useValue: {
        device: { findUnique: jest.fn() },
        deviceConfig: { findFirst: jest.fn() },
      },
    },
    { provide: RedisService, useValue: { getValue: jest.fn() } },
    { provide: ConfigService, useValue: { get: (k: string) => envValues[k] } },
  ],
  exports: [PrismaService, RedisService, ConfigService],
})
class TestInfraModule {}

describe("BaiduAgentModule", () => {
  let module: TestingModule;

  const compile = () =>
    Test.createTestingModule({
      imports: [TestInfraModule, BaiduAgentModule],
      providers: [
        {
          provide: CONSUMER_PROBE,
          useFactory: (
            catalog: VoiceCatalogPort,
            reconcile: VoiceReconcilePort,
            client: BaiduAgentClientPort,
          ): ConsumerProbe => ({ catalog, reconcile, client }),
          inject: [
            VOICE_CATALOG_PORT,
            VOICE_RECONCILE_PORT,
            BAIDU_AGENT_CLIENT_PORT,
          ],
        },
      ],
    }).compile();

  beforeEach(async () => {
    envValues = {};
    module = await compile();
  });

  afterEach(async () => {
    await module.close();
  });

  it("exports the three port tokens to consumer modules", () => {
    const probe = module.get<ConsumerProbe>(CONSUMER_PROBE);

    expect(probe.catalog).toBeInstanceOf(VoiceCatalogService);
    expect(probe.reconcile).toBeInstanceOf(VoiceReconcileService);
    expect(probe.client).toBeInstanceOf(BaiduAgentClient);
  });

  it("binds each token to the same singleton instance as its class", () => {
    expect(module.get(VOICE_CATALOG_PORT)).toBe(
      module.get(VoiceCatalogService),
    );
    expect(module.get(VOICE_RECONCILE_PORT)).toBe(
      module.get(VoiceReconcileService),
    );
    expect(module.get(BAIDU_AGENT_CLIENT_PORT)).toBe(
      module.get(BaiduAgentClient),
    );
  });

  it("stays dark-launched with no env configured: client disabled, catalog empty", () => {
    const probe = module.get<ConsumerProbe>(CONSUMER_PROBE);

    expect(probe.client.enabled).toBe(false);
    expect(probe.catalog.available).toBe(false);
    expect(probe.catalog.listUsable()).toEqual([]);
  });

  it("enables the client only when BAIDU_AGENT_ENABLED is exactly true", async () => {
    envValues = { BAIDU_AGENT_ENABLED: "TRUE" };
    const uppercaseModule = await compile();
    expect(
      uppercaseModule.get<BaiduAgentClientPort>(BAIDU_AGENT_CLIENT_PORT)
        .enabled,
    ).toBe(false);
    await uppercaseModule.close();

    envValues = { BAIDU_AGENT_ENABLED: "true" };
    const enabledModule = await compile();
    expect(
      enabledModule.get<BaiduAgentClientPort>(BAIDU_AGENT_CLIENT_PORT).enabled,
    ).toBe(true);
    await enabledModule.close();
  });

  it("loads VOICE_CATALOG_JSON into the catalog at construction time", async () => {
    envValues = {
      VOICE_CATALOG_JSON: JSON.stringify([
        {
          timbreId: "1000063",
          name: "度小熊",
          status: "TRAINED",
          language: "chinese",
        },
      ]),
    };
    const catalogModule = await compile();
    const catalog = catalogModule.get<VoiceCatalogPort>(VOICE_CATALOG_PORT);

    expect(catalog.available).toBe(true);
    expect(catalog.find("1000063", "zh")).not.toBeNull();
    await catalogModule.close();
  });
});
