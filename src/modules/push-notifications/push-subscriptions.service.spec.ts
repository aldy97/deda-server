import { BadRequestException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PushSubscriptionsService } from "./push-subscriptions.service";
import { PrismaService } from "@/common/prisma/prisma.service";

const TMPL = "tmpl-sleep-reminder";

describe("PushSubscriptionsService", () => {
  let service: PushSubscriptionsService;
  let prisma: { pushSubscription: { upsert: jest.Mock } };
  let configService: { get: jest.Mock };

  beforeEach(() => {
    prisma = { pushSubscription: { upsert: jest.fn() } };
    configService = { get: jest.fn().mockReturnValue(TMPL) };
    service = new PushSubscriptionsService(
      prisma as unknown as PrismaService,
      configService as unknown as ConfigService,
    );
  });

  it("accept 不传 count 时额度 +1、状态 active", async () => {
    prisma.pushSubscription.upsert.mockResolvedValue({
      templateId: TMPL,
      quota: 1,
      status: "active",
    });

    const res = await service.report("u1", {
      templateId: TMPL,
      result: "accept",
    });

    expect(prisma.pushSubscription.upsert).toHaveBeenCalledWith({
      where: { userId_templateId: { userId: "u1", templateId: TMPL } },
      update: { quota: { increment: 1 }, status: "active" },
      create: { userId: "u1", templateId: TMPL, quota: 1, status: "active" },
    });
    expect(res).toEqual({ templateId: TMPL, quota: 1, status: "active" });
  });

  it("accept count=5 时额度 +5", async () => {
    prisma.pushSubscription.upsert.mockResolvedValue({
      templateId: TMPL,
      quota: 6,
      status: "active",
    });

    await service.report("u1", {
      templateId: TMPL,
      result: "accept",
      count: 5,
    });

    expect(prisma.pushSubscription.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: { quota: { increment: 5 }, status: "active" },
        create: expect.objectContaining({ quota: 5 }),
      }),
    );
  });

  it("accept count 超过 30 时按 30 封顶", async () => {
    prisma.pushSubscription.upsert.mockResolvedValue({
      templateId: TMPL,
      quota: 30,
      status: "active",
    });

    await service.report("u1", {
      templateId: TMPL,
      result: "accept",
      count: 100,
    });

    expect(prisma.pushSubscription.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: { quota: { increment: 30 }, status: "active" },
      }),
    );
  });

  it("reject 时额度清零、状态 rejected", async () => {
    prisma.pushSubscription.upsert.mockResolvedValue({
      templateId: TMPL,
      quota: 0,
      status: "rejected",
    });

    const res = await service.report("u1", {
      templateId: TMPL,
      result: "reject",
    });

    expect(prisma.pushSubscription.upsert).toHaveBeenCalledWith({
      where: { userId_templateId: { userId: "u1", templateId: TMPL } },
      update: { quota: 0, status: "rejected" },
      create: { userId: "u1", templateId: TMPL, quota: 0, status: "rejected" },
    });
    expect(res.status).toBe("rejected");
  });

  it("templateId 不在白名单时抛 400 且不触库", async () => {
    await expect(
      service.report("u1", { templateId: "evil-template", result: "accept" }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.pushSubscription.upsert).not.toHaveBeenCalled();
  });

  it("未配置模板白名单时任何 templateId 都 400", async () => {
    configService.get.mockReturnValue(undefined);

    await expect(
      service.report("u1", { templateId: TMPL, result: "accept" }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.pushSubscription.upsert).not.toHaveBeenCalled();
  });
});
