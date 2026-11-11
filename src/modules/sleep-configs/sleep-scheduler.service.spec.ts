import { Test, TestingModule } from "@nestjs/testing";
import { SleepSchedulerService } from "./sleep-scheduler.service";
import { PrismaService } from "@/common/prisma/prisma.service";
import { LlmService } from "@/modules/llm/llm.service";
import { ConfigService } from "@nestjs/config";
import { VendorGateway } from "@/modules/vendor/vendor.gateway";
import { ConversationSessionService } from "@/modules/vendor/conversation-session.service";
import { PushSenderService } from "@/modules/push-notifications/push-sender.service";

describe("SleepSchedulerService", () => {
  let service: SleepSchedulerService;
  let prisma: any;
  let llm: any;
  let gateway: any;
  let session: any;
  let pushSender: { sendSleepReminder: jest.Mock };
  let configGet: jest.Mock;

  // 2026-11-03T12:30:00Z = 北京时间 2026-11-03 20:30
  const NOW = new Date("2026-11-03T12:30:00.000Z");
  const BEIJING_DATE_KEY = "2026-11-03";

  const makeConfig = (overrides: Record<string, unknown> = {}) => ({
    id: "sleep-001",
    deviceId: "device-uuid-001",
    enabled: true,
    durationMode: "default",
    durationMinutes: null,
    contentType: "story",
    sleepTime: "20:30",
    forceSleep: false,
    lastTriggeredDate: null,
    device: { id: "device-uuid-001", deviceId: "dev-001" },
    ...overrides,
  });

  beforeEach(async () => {
    configGet = jest.fn().mockReturnValue("true");
    pushSender = {
      sendSleepReminder: jest.fn().mockResolvedValue({ sent: 1, skipped: 0 }),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SleepSchedulerService,
        {
          provide: PrismaService,
          useValue: {
            sleepConfig: {
              findMany: jest.fn(),
              updateMany: jest.fn(),
            },
            childProfile: {
              findUnique: jest.fn().mockResolvedValue(null),
            },
          },
        },
        {
          provide: LlmService,
          useValue: { complete: jest.fn() },
        },
        { provide: ConfigService, useValue: { get: configGet } },
        { provide: VendorGateway, useValue: { pushSleepEntry: jest.fn() } },
        {
          provide: ConversationSessionService,
          useValue: { activateSleepMode: jest.fn() },
        },
        { provide: PushSenderService, useValue: pushSender },
      ],
    }).compile();

    service = module.get<SleepSchedulerService>(SleepSchedulerService);
    prisma = module.get(PrismaService);
    llm = module.get(LlmService);
    gateway = module.get(VendorGateway);
    session = module.get(ConversationSessionService);
  });

  afterEach(() => {
    service.onModuleDestroy();
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  describe("onModuleInit", () => {
    it("should start timer when SLEEP_SCHEDULER_ENABLED=true", async () => {
      prisma.sleepConfig.findMany.mockResolvedValue([]);
      service.onModuleInit();
      expect((service as any).timer).not.toBeNull();
      // 等待启动时的首轮扫描完成，避免跨用例泄漏异步任务
      await new Promise((resolve) => setImmediate(resolve));
    });

    it("should not start timer when disabled", () => {
      configGet.mockReturnValue("false");
      service.onModuleInit();
      expect((service as any).timer).toBeNull();
    });
  });

  describe("triggerDueSleepEntries", () => {
    it("should only query enabled configs", async () => {
      prisma.sleepConfig.findMany.mockResolvedValue([]);

      await service.triggerDueSleepEntries(NOW);

      expect(prisma.sleepConfig.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { enabled: true } }),
      );
    });

    it("should trigger full flow when sleepTime matches Beijing time", async () => {
      prisma.sleepConfig.findMany.mockResolvedValue([makeConfig()]);
      prisma.sleepConfig.updateMany.mockResolvedValue({ count: 1 });
      llm.complete.mockResolvedValue({ text: "月亮晚安故事。" });
      gateway.pushSleepEntry.mockReturnValue(true);

      await service.triggerDueSleepEntries(NOW);

      expect(prisma.sleepConfig.updateMany).toHaveBeenCalledWith({
        where: {
          id: "sleep-001",
          OR: [
            { lastTriggeredDate: null },
            { lastTriggeredDate: { not: BEIJING_DATE_KEY } },
          ],
        },
        data: { lastTriggeredDate: BEIJING_DATE_KEY },
      });
      expect(gateway.pushSleepEntry).toHaveBeenCalledWith(
        "dev-001",
        expect.objectContaining({
          deviceId: "dev-001",
          responseText: expect.stringContaining("月亮晚安故事。"),
        }),
      );
      expect(session.activateSleepMode).toHaveBeenCalledWith("device-uuid-001");
    });

    it("should skip when sleepTime does not match current Beijing HH:mm", async () => {
      prisma.sleepConfig.findMany.mockResolvedValue([
        makeConfig({ sleepTime: "21:30" }),
      ]);

      await service.triggerDueSleepEntries(NOW);

      expect(prisma.sleepConfig.updateMany).not.toHaveBeenCalled();
      expect(llm.complete).not.toHaveBeenCalled();
    });

    it("should skip when already triggered today", async () => {
      prisma.sleepConfig.findMany.mockResolvedValue([
        makeConfig({ lastTriggeredDate: BEIJING_DATE_KEY }),
      ]);

      await service.triggerDueSleepEntries(NOW);

      expect(prisma.sleepConfig.updateMany).not.toHaveBeenCalled();
    });

    it("should skip when claim fails (another instance claimed first)", async () => {
      prisma.sleepConfig.findMany.mockResolvedValue([makeConfig()]);
      prisma.sleepConfig.updateMany.mockResolvedValue({ count: 0 });

      await service.triggerDueSleepEntries(NOW);

      expect(llm.complete).not.toHaveBeenCalled();
      expect(gateway.pushSleepEntry).not.toHaveBeenCalled();
    });

    it("should not activate session when device is offline, and consume the daily marker", async () => {
      prisma.sleepConfig.findMany.mockResolvedValue([makeConfig()]);
      prisma.sleepConfig.updateMany.mockResolvedValue({ count: 1 });
      llm.complete.mockResolvedValue({ text: "月亮晚安故事。" });
      gateway.pushSleepEntry.mockReturnValue(false);

      await service.triggerDueSleepEntries(NOW);

      // 离线跳过当天：标记已消耗（claim 先于推送）
      expect(prisma.sleepConfig.updateMany).toHaveBeenCalled();
      expect(session.activateSleepMode).not.toHaveBeenCalled();
    });

    it("should fall back to story for song/mixed content types", async () => {
      prisma.sleepConfig.findMany.mockResolvedValue([
        makeConfig({ contentType: "song" }),
      ]);
      prisma.sleepConfig.updateMany.mockResolvedValue({ count: 1 });
      llm.complete.mockResolvedValue({ text: "月亮晚安故事。" });
      gateway.pushSleepEntry.mockReturnValue(true);

      await service.triggerDueSleepEntries(NOW);

      expect(gateway.pushSleepEntry).toHaveBeenCalledWith(
        "dev-001",
        expect.objectContaining({
          responseText: expect.stringContaining("月亮晚安故事。"),
        }),
      );
    });

    it("should swallow LLM failure and keep the daily marker consumed", async () => {
      prisma.sleepConfig.findMany.mockResolvedValue([makeConfig()]);
      prisma.sleepConfig.updateMany.mockResolvedValue({ count: 1 });
      llm.complete.mockRejectedValue(new Error("llm down"));

      await expect(
        service.triggerDueSleepEntries(NOW),
      ).resolves.toBeUndefined();

      expect(gateway.pushSleepEntry).not.toHaveBeenCalled();
      expect(session.activateSleepMode).not.toHaveBeenCalled();
    });

    it("should match Beijing midnight correctly across UTC date boundary", async () => {
      // 2026-11-02T16:00:00Z = 北京时间 2026-11-03 00:00
      const midnightUtc = new Date("2026-11-02T16:00:00.000Z");
      prisma.sleepConfig.findMany.mockResolvedValue([
        makeConfig({ sleepTime: "00:00" }),
      ]);
      prisma.sleepConfig.updateMany.mockResolvedValue({ count: 1 });
      llm.complete.mockResolvedValue({ text: "故事。" });
      gateway.pushSleepEntry.mockReturnValue(true);

      await service.triggerDueSleepEntries(midnightUtc);

      expect(prisma.sleepConfig.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { lastTriggeredDate: BEIJING_DATE_KEY },
        }),
      );
    });

    it("should include child name in prompt when profile exists", async () => {
      prisma.sleepConfig.findMany.mockResolvedValue([makeConfig()]);
      prisma.sleepConfig.updateMany.mockResolvedValue({ count: 1 });
      prisma.childProfile.findUnique.mockResolvedValue({ name: "朵朵" });
      llm.complete.mockResolvedValue({ text: "故事。" });
      gateway.pushSleepEntry.mockReturnValue(true);

      await service.triggerDueSleepEntries(NOW);

      expect(llm.complete).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: expect.arrayContaining([
            expect.objectContaining({
              content: expect.stringContaining("朵朵"),
            }),
          ]),
        }),
      );
    });

    describe("sleep push notification", () => {
      it("claim 成功后向所有绑定家长推送服务通知", async () => {
        prisma.sleepConfig.findMany.mockResolvedValue([makeConfig()]);
        prisma.sleepConfig.updateMany.mockResolvedValue({ count: 1 });
        llm.complete.mockResolvedValue({ text: "故事。" });
        gateway.pushSleepEntry.mockReturnValue(true);

        await service.triggerDueSleepEntries(NOW);

        expect(pushSender.sendSleepReminder).toHaveBeenCalledWith({
          deviceInternalId: "device-uuid-001",
          deviceId: "dev-001",
          sleepTime: "20:30",
        });
      });

      it("设备离线（WS 下行失败）时仍推送服务通知", async () => {
        prisma.sleepConfig.findMany.mockResolvedValue([makeConfig()]);
        prisma.sleepConfig.updateMany.mockResolvedValue({ count: 1 });
        llm.complete.mockResolvedValue({ text: "故事。" });
        gateway.pushSleepEntry.mockReturnValue(false);

        await service.triggerDueSleepEntries(NOW);

        expect(pushSender.sendSleepReminder).toHaveBeenCalled();
      });

      it("sleepTime 不匹配时不推送", async () => {
        prisma.sleepConfig.findMany.mockResolvedValue([
          makeConfig({ sleepTime: "21:30" }),
        ]);

        await service.triggerDueSleepEntries(NOW);

        expect(pushSender.sendSleepReminder).not.toHaveBeenCalled();
      });

      it("当天已触发（claim 失败）时不重复推送", async () => {
        prisma.sleepConfig.findMany.mockResolvedValue([makeConfig()]);
        prisma.sleepConfig.updateMany.mockResolvedValue({ count: 0 });

        await service.triggerDueSleepEntries(NOW);

        expect(pushSender.sendSleepReminder).not.toHaveBeenCalled();
      });

      it("推送失败不影响哄睡内容下发、不抛出", async () => {
        prisma.sleepConfig.findMany.mockResolvedValue([makeConfig()]);
        prisma.sleepConfig.updateMany.mockResolvedValue({ count: 1 });
        pushSender.sendSleepReminder.mockRejectedValue(new Error("push down"));
        llm.complete.mockResolvedValue({ text: "故事。" });
        gateway.pushSleepEntry.mockReturnValue(true);

        await expect(
          service.triggerDueSleepEntries(NOW),
        ).resolves.toBeUndefined();
        expect(gateway.pushSleepEntry).toHaveBeenCalled();
      });
    });
  });
});
