import { Test, TestingModule } from "@nestjs/testing";
import { Logger } from "@nestjs/common";
import {
  DevicePresenceService,
  PRESENCE_FLUSH_INTERVAL_MS,
  NEGATIVE_CACHE_TTL_MS,
} from "./device-presence.service";
import { PrismaService } from "@/common/prisma/prisma.service";
import {
  reportDateInTimezone,
  DEFAULT_REPORT_TIMEZONE,
} from "@/modules/learning-stats/parent-report-date.util";

describe("DevicePresenceService", () => {
  let service: DevicePresenceService;
  let prisma: {
    device: { findFirst: jest.Mock };
    devicePresenceDaily: { upsert: jest.Mock; update: jest.Mock };
  };
  let errorSpy: jest.SpyInstance;

  const knownUuid = "550e8400-e29b-41d4-a716-446655440000";
  const unknownMac = "000000000000";

  beforeEach(async () => {
    prisma = {
      device: { findFirst: jest.fn() },
      devicePresenceDaily: {
        upsert: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DevicePresenceService,
        {
          provide: PrismaService,
          useValue: prisma,
        },
      ],
    }).compile();

    service = module.get<DevicePresenceService>(DevicePresenceService);

    errorSpy = jest
      .spyOn(Logger.prototype, "error")
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.clearAllTimers?.();
    errorSpy.mockRestore();
    jest.restoreAllMocks();
  });

  describe("record", () => {
    it("should resolve UUID via lowercase MAC query and create a bucket", async () => {
      prisma.device.findFirst.mockResolvedValue({ id: knownUuid });

      await service.record("AABBCCDDEEFF", new Date("2026-11-12T10:00:00Z"));

      expect(prisma.device.findFirst).toHaveBeenCalledWith({
        where: {
          OR: [{ deviceId: "aabbccddeeff" }, { macAddress: "aabbccddeeff" }],
        },
        select: { id: true },
      });
    });

    it("should return without throwing when device is not found", async () => {
      prisma.device.findFirst.mockResolvedValue(null);

      await expect(
        service.record(unknownMac, new Date()),
      ).resolves.toBeUndefined();

      expect(errorSpy).not.toHaveBeenCalled();
    });

    it("should not throw when record encounters an internal error", async () => {
      prisma.device.findFirst.mockRejectedValue(new Error("DB down"));

      await expect(
        service.record("AABBCCDDEEFF", new Date()),
      ).resolves.toBeUndefined();

      expect(errorSpy).toHaveBeenCalled();
    });

    it("should cache null UUID result for NEGATIVE_CACHE_TTL_MS", async () => {
      prisma.device.findFirst.mockResolvedValue(null);

      await service.record(unknownMac, new Date());
      await service.record(unknownMac, new Date());

      // findFirst should only be called once (second call uses cache)
      expect(prisma.device.findFirst).toHaveBeenCalledTimes(1);
    });

    it("should cache positive UUID result indefinitely", async () => {
      prisma.device.findFirst.mockResolvedValue({ id: knownUuid });

      await service.record("AABBCCDDEEFF", new Date());
      await service.record("AABBCCDDEEFF", new Date());
      await service.record("AABBCCDDEEFF", new Date());

      expect(prisma.device.findFirst).toHaveBeenCalledTimes(1);
    });
  });

  describe("flush", () => {
    const uuid = knownUuid;

    function seenAt(hours: number, minutes = 0, seconds = 0): Date {
      const d = new Date("2026-11-12T00:00:00Z");
      d.setHours(hours, minutes, seconds, 0);
      return d;
    }

    const today = reportDateInTimezone(
      new Date("2026-11-12T10:00:00Z"),
      DEFAULT_REPORT_TIMEZONE,
    );

    it("should upsert with create payload on first flush of a bucket", async () => {
      prisma.device.findFirst.mockResolvedValue({ id: uuid });

      const t1 = seenAt(10, 0, 0);
      await service.record("AABBCCDDEEFF", t1);
      await service.flush();

      expect(prisma.devicePresenceDaily.upsert).toHaveBeenCalledTimes(1);
      const call = prisma.devicePresenceDaily.upsert.mock.calls[0][0];
      expect(call.where).toEqual({
        deviceId_date: { deviceId: uuid, date: today },
      });
      expect(call.create).toEqual({
        deviceId: uuid,
        date: today,
        reportCount: 1,
        firstSeenAt: t1,
        lastSeenAt: t1,
      });
      // update should only set reportCount.increment and lastSeenAt
      expect(call.update.reportCount).toEqual({ increment: 1 });
      expect(call.update.lastSeenAt).toEqual(t1);
      expect(call.update).not.toHaveProperty("firstSeenAt");
    });

    it("should only flush delta (not cumulative) on second flush", async () => {
      prisma.device.findFirst.mockResolvedValue({ id: uuid });

      await service.record("AABBCCDDEEFF", seenAt(10, 0, 0));
      await service.record("AABBCCDDEEFF", seenAt(10, 1, 0));
      await service.record("AABBCCDDEEFF", seenAt(10, 2, 0));
      await service.flush();

      expect(prisma.devicePresenceDaily.upsert).toHaveBeenCalledTimes(1);
      expect(
        prisma.devicePresenceDaily.upsert.mock.calls[0][0].update.reportCount,
      ).toEqual({ increment: 3 });

      // add 2 more records since last flush
      await service.record("AABBCCDDEEFF", seenAt(10, 3, 0));
      await service.record("AABBCCDDEEFF", seenAt(10, 4, 0));
      await service.flush();

      expect(prisma.devicePresenceDaily.upsert).toHaveBeenCalledTimes(2);
      expect(
        prisma.devicePresenceDaily.upsert.mock.calls[1][0].update.reportCount,
      ).toEqual({ increment: 2 });
    });

    it("should use min/max for firstSeenAt and lastSeenAt with out-of-order timestamps", async () => {
      prisma.device.findFirst.mockResolvedValue({ id: uuid });

      const earliest = seenAt(9, 0, 0);
      const latest = seenAt(11, 0, 0);
      const middle = seenAt(10, 0, 0);

      // record in non-chronological order
      await service.record("AABBCCDDEEFF", middle);
      await service.record("AABBCCDDEEFF", latest);
      await service.record("AABBCCDDEEFF", earliest);
      await service.flush();

      const call = prisma.devicePresenceDaily.upsert.mock.calls[0][0];
      expect(call.create.firstSeenAt).toEqual(earliest);
      expect(call.create.lastSeenAt).toEqual(latest);
    });

    it("should create two separate buckets for cross-day timestamps", async () => {
      prisma.device.findFirst.mockResolvedValue({ id: uuid });

      const date1 = reportDateInTimezone(
        new Date("2026-11-12T10:00:00Z"),
        DEFAULT_REPORT_TIMEZONE,
      );
      const date2 = reportDateInTimezone(
        new Date("2026-11-13T10:00:00Z"),
        DEFAULT_REPORT_TIMEZONE,
      );

      const t1 = new Date("2026-11-12T15:59:58Z"); // Asia/Shanghai = 23:59:58
      const t2 = new Date("2026-11-12T16:00:01Z"); // Asia/Shanghai = 00:00:01 next day

      await service.record("AABBCCDDEEFF", t1);
      await service.record("AABBCCDDEEFF", t2);
      await service.flush();

      expect(prisma.devicePresenceDaily.upsert).toHaveBeenCalledTimes(2);

      const callDates = prisma.devicePresenceDaily.upsert.mock.calls.map(
        (c: [{ where: { deviceId_date: { date: string } } }]) =>
          c[0].where.deviceId_date.date,
      );
      expect(callDates).toContain(date1);
      expect(callDates).toContain(date2);
      expect(callDates[0]).not.toBe(callDates[1]);
    });

    it("should be idempotent: flush with no new records does not call upsert", async () => {
      prisma.device.findFirst.mockResolvedValue({ id: uuid });

      await service.record("AABBCCDDEEFF", seenAt(10, 0, 0));
      await service.flush();
      expect(prisma.devicePresenceDaily.upsert).toHaveBeenCalledTimes(1);

      await service.flush();
      // second flush should have no new upserts since count === flushedCount
      expect(prisma.devicePresenceDaily.upsert).toHaveBeenCalledTimes(1);
    });

    it("should not throw and should log error when upsert fails, and not advance flushedCount", async () => {
      prisma.device.findFirst.mockResolvedValue({ id: uuid });
      prisma.devicePresenceDaily.upsert.mockRejectedValue(
        new Error("DB connection lost"),
      );

      await service.record("AABBCCDDEEFF", seenAt(10, 0, 0));

      // flush should not throw
      await expect(service.flush()).resolves.toBeUndefined();

      expect(errorSpy).toHaveBeenCalled();
      // flushedCount should not have advanced; next flush should retry
      const preErrorCount = prisma.devicePresenceDaily.upsert.mock.calls.length;

      prisma.devicePresenceDaily.upsert.mockResolvedValue({});
      await service.flush();

      // should have been called again with the same delta
      expect(
        prisma.devicePresenceDaily.upsert.mock.calls.length,
      ).toBeGreaterThan(preErrorCount);
      expect(
        prisma.devicePresenceDaily.upsert.mock.calls[preErrorCount][0].update
          .reportCount,
      ).toEqual({ increment: 1 });
    });

    it("should retry with plain update on P2002 unique constraint error", async () => {
      prisma.device.findFirst.mockResolvedValue({ id: uuid });

      // First call fails with P2002
      const p2002Error = Object.assign(new Error("Unique constraint"), {
        code: "P2002",
      });
      prisma.devicePresenceDaily.upsert.mockRejectedValueOnce(p2002Error);

      await service.record("AABBCCDDEEFF", seenAt(10, 0, 0));
      await service.flush();

      // Should have called upsert (failed), then update
      expect(prisma.devicePresenceDaily.upsert).toHaveBeenCalledTimes(1);
      expect(prisma.devicePresenceDaily.update).toHaveBeenCalledTimes(1);
      expect(prisma.devicePresenceDaily.update.mock.calls[0][0].data).toEqual({
        reportCount: { increment: 1 },
        lastSeenAt: expect.any(Date),
      });
    });

    it("should log error and retain delta when both upsert and update fail", async () => {
      prisma.device.findFirst.mockResolvedValue({ id: uuid });

      const p2002Error = Object.assign(new Error("Unique constraint"), {
        code: "P2002",
      });
      prisma.devicePresenceDaily.upsert.mockRejectedValueOnce(p2002Error);
      prisma.devicePresenceDaily.update.mockRejectedValue(
        new Error("Update also failed"),
      );

      await service.record("AABBCCDDEEFF", seenAt(10, 0, 0));
      await expect(service.flush()).resolves.toBeUndefined();

      // error logged
      expect(errorSpy).toHaveBeenCalled();
    });
  });

  describe("constants", () => {
    it("should export PRESENCE_FLUSH_INTERVAL_MS as 5 minutes", () => {
      expect(PRESENCE_FLUSH_INTERVAL_MS).toBe(5 * 60 * 1000);
    });

    it("should export NEGATIVE_CACHE_TTL_MS as 60 seconds", () => {
      expect(NEGATIVE_CACHE_TTL_MS).toBe(60 * 1000);
    });
  });

  describe("lifecycle", () => {
    afterEach(() => {
      jest.useRealTimers();
    });

    function bucketsOf(svc: DevicePresenceService): Map<string, unknown> {
      return (svc as unknown as { buckets: Map<string, unknown> }).buckets;
    }

    it("onModuleInit 按 PRESENCE_FLUSH_INTERVAL_MS 周期性 flush", () => {
      jest.useFakeTimers();
      const flushSpy = jest
        .spyOn(service, "flush")
        .mockResolvedValue(undefined);

      service.onModuleInit();
      expect(flushSpy).not.toHaveBeenCalled();

      jest.advanceTimersByTime(PRESENCE_FLUSH_INTERVAL_MS);
      expect(flushSpy).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(PRESENCE_FLUSH_INTERVAL_MS);
      expect(flushSpy).toHaveBeenCalledTimes(2);

      service.onModuleDestroy();
    });

    it("onModuleDestroy 清理定时器并做最后一次 flush", async () => {
      jest.useFakeTimers();
      const flushSpy = jest
        .spyOn(service, "flush")
        .mockResolvedValue(undefined);

      service.onModuleInit();
      await service.onModuleDestroy();
      expect(flushSpy).toHaveBeenCalledTimes(1);

      // 定时器已清理：再推进时间不应触发新的 flush
      jest.advanceTimersByTime(PRESENCE_FLUSH_INTERVAL_MS * 3);
      expect(flushSpy).toHaveBeenCalledTimes(1);
    });

    it("onModuleDestroy 吞掉 flush 异常并记 error", async () => {
      jest
        .spyOn(service, "flush")
        .mockRejectedValue(new Error("shutdown flush boom"));

      await expect(service.onModuleDestroy()).resolves.toBeUndefined();
      expect(errorSpy).toHaveBeenCalled();
    });

    it("flush 回收早于昨日的 bucket，不产生 upsert", async () => {
      prisma.device.findFirst.mockResolvedValue({ id: knownUuid });
      const stale = new Date();
      stale.setDate(stale.getDate() - 3);

      await service.record("AABBCCDDEEFF", stale);
      expect(bucketsOf(service).size).toBe(1);

      await service.flush();

      expect(prisma.devicePresenceDaily.upsert).not.toHaveBeenCalled();
      expect(bucketsOf(service).size).toBe(0);
    });
  });

  describe("非 Error 抛出物", () => {
    const mac = "AABBCCDDEEFF";

    it("record 吞掉非 Error 抛出并记 error", async () => {
      prisma.device.findFirst.mockRejectedValue("string failure");

      await expect(service.record(mac, new Date())).resolves.toBeUndefined();
      expect(errorSpy).toHaveBeenCalled();
    });

    it("flush 遇非 P2002 的非 Error 失败：记 error 且不推进 flushedCount", async () => {
      prisma.device.findFirst.mockResolvedValue({ id: knownUuid });
      await service.record(mac, new Date());
      prisma.devicePresenceDaily.upsert.mockRejectedValue("db gone");

      await expect(service.flush()).resolves.toBeUndefined();
      expect(errorSpy).toHaveBeenCalled();

      // delta 未被推进，恢复后同一笔计数仍会重试
      prisma.devicePresenceDaily.upsert.mockResolvedValue({});
      await service.flush();
      expect(prisma.devicePresenceDaily.upsert).toHaveBeenCalledTimes(2);
    });

    it("P2002 重试再失败时，非 Error 的 retryErr 也被记录", async () => {
      prisma.device.findFirst.mockResolvedValue({ id: knownUuid });
      await service.record(mac, new Date());
      prisma.devicePresenceDaily.upsert.mockRejectedValueOnce({
        code: "P2002",
      });
      prisma.devicePresenceDaily.update.mockRejectedValueOnce("update gone");

      await expect(service.flush()).resolves.toBeUndefined();
      expect(errorSpy).toHaveBeenCalled();
    });

    it("onModuleDestroy 处理非 Error 的 flush 失败", async () => {
      jest.spyOn(service, "flush").mockRejectedValue("boom");

      await expect(service.onModuleDestroy()).resolves.toBeUndefined();
      expect(errorSpy).toHaveBeenCalled();
    });
  });
});
