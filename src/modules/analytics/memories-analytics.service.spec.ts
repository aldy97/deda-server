import { NotFoundException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { PrismaService } from "@/common/prisma/prisma.service";
import {
  MEMORY_SLOT_KEYS,
  MemoriesAnalyticsService,
} from "./memories-analytics.service";

type Row = Record<string, any>;

/** 支持 status/key 等值过滤与 deviceId.in */
function applyWhere(rows: Row[], where: Row | undefined): Row[] {
  if (!where) return rows;
  return rows.filter((r) => {
    if (where.status !== undefined && r.status !== where.status) return false;
    if (where.key !== undefined && r.key !== where.key) return false;
    if (where.deviceId !== undefined) {
      if (typeof where.deviceId === "string" && r.deviceId !== where.deviceId) {
        return false;
      }
      if (where.deviceId.in && !where.deviceId.in.includes(r.deviceId)) {
        return false;
      }
    }
    return true;
  });
}

function groupByImpl(rows: Row[]) {
  return jest.fn(({ by, where }: any) => {
    const filtered = applyWhere(rows, where);
    const map = new Map<string, Row[]>();
    for (const r of filtered) {
      const k = by.map((b: string) => String(r[b])).join("|");
      const list = map.get(k) ?? [];
      list.push(r);
      map.set(k, list);
    }
    return [...map.entries()].map(([k, list]) => {
      const parts = k.split("|");
      const out: Row = {};
      by.forEach((b: string, i: number) => {
        out[b] = parts[i];
      });
      out._count = { _all: list.length };
      out._max = {
        createdAt: new Date(
          Math.max(...list.map((r) => +new Date(r.createdAt))),
        ),
      };
      return out;
    });
  });
}

function buildPrisma(data: {
  devices?: Row[];
  messages?: Row[];
  memories?: Row[];
}) {
  const devices = data.devices ?? [];
  const messages = data.messages ?? [];
  const memories = data.memories ?? [];
  return {
    device: {
      findUnique: jest.fn(
        ({ where }: any) =>
          devices.find((d) => d.deviceId === where.deviceId) ?? null,
      ),
      findMany: jest.fn(({ where }: any) => {
        if (where?.id?.in) {
          return devices.filter((d) => where.id.in.includes(d.id));
        }
        if (where?.OR) {
          const kw = String(where.OR[0].deviceId.contains).toLowerCase();
          return devices.filter(
            (d) =>
              String(d.deviceId ?? "")
                .toLowerCase()
                .includes(kw) ||
              String(d.deviceCode ?? "")
                .toLowerCase()
                .includes(kw),
          );
        }
        return devices;
      }),
    },
    message: { groupBy: groupByImpl(messages) },
    childMemory: {
      groupBy: groupByImpl(memories),
      count: jest.fn((args?: any) => applyWhere(memories, args?.where).length),
      findMany: jest.fn(({ where, orderBy, select }: any) => {
        let rows = applyWhere(memories, where);
        if (orderBy?.version) {
          rows = [...rows].sort((a, b) => a.version - b.version);
        } else if (orderBy?.key) {
          rows = [...rows].sort((a, b) =>
            String(a.key).localeCompare(String(b.key)),
          );
        }
        if (select) {
          const keys = Object.keys(select).filter((k) => select[k]);
          rows = rows.map((r) =>
            Object.fromEntries(
              keys.filter((k) => k in r).map((k) => [k, r[k]]),
            ),
          );
        }
        return rows;
      }),
    },
  };
}

async function buildService(prisma: unknown) {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      MemoriesAnalyticsService,
      { provide: PrismaService, useValue: prisma },
    ],
  }).compile();
  return module.get(MemoriesAnalyticsService);
}

const DEVICES = [
  { id: "uuid-1", deviceId: "DEDA-001", deviceCode: "小熊001" },
  { id: "uuid-2", deviceId: "DEDA-002", deviceCode: "小兔002" },
  { id: "uuid-3", deviceId: "DEDA-003", deviceCode: null },
];

describe("MemoriesAnalyticsService", () => {
  describe("getOverview", () => {
    it("分母为有消息的设备数；coverage 四位小数；slotCoverage 固定 5 项按 key 字典序", async () => {
      const prisma = buildPrisma({
        // uuid-1、uuid-2 有消息；uuid-3 无消息（不计入分母）
        messages: [{ deviceId: "uuid-1" }, { deviceId: "uuid-2" }],
        memories: [
          // uuid-1：两个槽位 active + 一条 superseded 旧版本
          {
            deviceId: "uuid-1",
            key: "favorite_color",
            status: "active",
            createdAt: "2026-11-06T09:20:00Z",
          },
          {
            deviceId: "uuid-1",
            key: "favorite_color",
            status: "superseded",
            createdAt: "2026-11-03T08:00:00Z",
          },
          {
            deviceId: "uuid-1",
            key: "favorite_animal",
            status: "active",
            createdAt: "2026-11-05T08:00:00Z",
          },
          // uuid-2：一个槽位 active
          {
            deviceId: "uuid-2",
            key: "favorite_color",
            status: "active",
            createdAt: "2026-11-04T08:00:00Z",
          },
        ],
      });
      const service = await buildService(prisma);

      const result = await service.getOverview();

      expect(result.deviceTotal).toBe(2);
      expect(result.deviceWithMemories).toBe(2);
      expect(result.deviceCoverage).toBe(1);
      expect(result.totalActiveMemories).toBe(3);
      expect(result.totalVersions).toBe(4);
      expect(result.slotCoverage.map((s) => s.key)).toEqual([
        "favorite_animal",
        "favorite_color",
        "favorite_story_type",
        "interest_topic",
        "preferred_interaction",
      ]);
      const color = result.slotCoverage.find(
        (s) => s.key === "favorite_color",
      )!;
      expect(color.deviceCount).toBe(2);
      expect(color.coverage).toBe(1);
      const animal = result.slotCoverage.find(
        (s) => s.key === "favorite_animal",
      )!;
      expect(animal.deviceCount).toBe(1);
      expect(animal.coverage).toBe(0.5);
      const storyType = result.slotCoverage.find(
        (s) => s.key === "favorite_story_type",
      )!;
      expect(storyType.deviceCount).toBe(0);
      expect(storyType.coverage).toBe(0);
    });

    it("四舍五入到 4 位小数（12/42 ≈ 0.2857 口径）", async () => {
      const messages = Array.from({ length: 42 }, (_, i) => ({
        deviceId: `uuid-${i}`,
      }));
      const memories = Array.from({ length: 12 }, (_, i) => ({
        deviceId: `uuid-${i}`,
        key: "favorite_color",
        status: "active",
        createdAt: "2026-11-01T00:00:00Z",
      }));
      const service = await buildService(buildPrisma({ messages, memories }));

      const result = await service.getOverview();

      expect(result.deviceCoverage).toBe(0.2857);
      expect(
        result.slotCoverage.find((s) => s.key === "favorite_color")!.coverage,
      ).toBe(0.2857);
    });

    it("无任何消息时 deviceTotal=0，coverage 为 0 不除零", async () => {
      const service = await buildService(buildPrisma({}));

      const result = await service.getOverview();

      expect(result.deviceTotal).toBe(0);
      expect(result.deviceCoverage).toBe(0);
      expect(result.slotCoverage).toHaveLength(5);
      expect(result.slotCoverage.every((s) => s.coverage === 0)).toBe(true);
    });

    it("slotCoverage 的 key 白名单与导出常量一致", () => {
      expect([...MEMORY_SLOT_KEYS]).toEqual([
        "favorite_animal",
        "favorite_color",
        "favorite_story_type",
        "interest_topic",
        "preferred_interaction",
      ]);
    });
  });

  describe("listDevices", () => {
    const memories = [
      // uuid-1：3 active / 共 4 版本，最近变更 11-09
      {
        deviceId: "uuid-1",
        key: "favorite_color",
        status: "active",
        createdAt: "2026-11-09T06:12:33Z",
      },
      {
        deviceId: "uuid-1",
        key: "favorite_color",
        status: "superseded",
        createdAt: "2026-11-03T08:00:00Z",
      },
      {
        deviceId: "uuid-1",
        key: "favorite_animal",
        status: "active",
        createdAt: "2026-11-05T08:00:00Z",
      },
      {
        deviceId: "uuid-1",
        key: "interest_topic",
        status: "active",
        createdAt: "2026-11-06T08:00:00Z",
      },
      // uuid-2：1 active / 共 1 版本，最近变更 11-02（更早，排后）
      {
        deviceId: "uuid-2",
        key: "favorite_color",
        status: "active",
        createdAt: "2026-11-02T08:00:00Z",
      },
    ];

    it("只返回有记忆版本行的设备，按 lastChangeAt 倒序，字段含业务 deviceId/deviceCode", async () => {
      const service = await buildService(
        buildPrisma({ devices: DEVICES, memories }),
      );

      const result = await service.listDevices({});

      expect(result.total).toBe(2);
      expect(result.page).toBe(1);
      expect(result.pageSize).toBe(20);
      expect(result.items.map((i) => i.deviceId)).toEqual([
        "DEDA-001",
        "DEDA-002",
      ]);
      const first = result.items[0]!;
      expect(first.deviceCode).toBe("小熊001");
      expect(first.activeCount).toBe(3);
      expect(first.totalVersions).toBe(4);
      expect(first.lastChangeAt).toEqual(new Date("2026-11-09T06:12:33Z"));
      // uuid-3 无任何记忆行，不出现
      expect(result.items.some((i) => i.deviceId === "DEDA-003")).toBe(false);
    });

    it("keyword 模糊匹配业务 deviceId / deviceCode", async () => {
      const service = await buildService(
        buildPrisma({ devices: DEVICES, memories }),
      );

      const byDeviceId = await service.listDevices({ keyword: "deda-002" });
      expect(byDeviceId.items.map((i) => i.deviceId)).toEqual(["DEDA-002"]);

      const byCode = await service.listDevices({ keyword: "小熊" });
      expect(byCode.items.map((i) => i.deviceId)).toEqual(["DEDA-001"]);
    });

    it("keyword 无匹配设备时返回空页", async () => {
      const prisma = buildPrisma({ devices: DEVICES, memories });
      const service = await buildService(prisma);

      const result = await service.listDevices({ keyword: "不存在" });

      expect(result).toEqual({ total: 0, page: 1, pageSize: 20, items: [] });
    });

    it("分页：total 为全量组数，items 按页切片", async () => {
      const manyDevices = Array.from({ length: 25 }, (_, i) => ({
        id: `uuid-${i}`,
        deviceId: `DEDA-${String(i).padStart(3, "0")}`,
        deviceCode: null,
      }));
      const manyMemories = manyDevices.map((d, i) => ({
        deviceId: d.id,
        key: "favorite_color",
        status: "active",
        createdAt: new Date(Date.UTC(2026, 10, 1, i)).toISOString(),
      }));
      const service = await buildService(
        buildPrisma({ devices: manyDevices, memories: manyMemories }),
      );

      const page2 = await service.listDevices({ page: 2, pageSize: 20 });

      expect(page2.total).toBe(25);
      expect(page2.page).toBe(2);
      expect(page2.items).toHaveLength(5);
    });
  });

  describe("getCurrentMemories", () => {
    it("业务 deviceId resolve 成内部 UUID，只回 status=active 并映射契约字段", async () => {
      const prisma = buildPrisma({
        devices: DEVICES,
        memories: [
          {
            deviceId: "uuid-1",
            key: "favorite_color",
            status: "active",
            valueText: "蓝色",
            version: 2,
            confidence: 0.91,
            injectionCount: 14,
            lastInjectedAt: "2026-11-09T05:40:11Z",
            lastConfirmedAt: "2026-11-08T13:02:00Z",
            validFrom: "2026-11-06T09:20:00Z",
          },
          {
            deviceId: "uuid-1",
            key: "favorite_color",
            status: "superseded",
            valueText: "红色",
            version: 1,
          },
        ],
      });
      const service = await buildService(prisma);

      const result = await service.getCurrentMemories("DEDA-001");

      expect(prisma.device.findUnique).toHaveBeenCalledWith({
        where: { deviceId: "DEDA-001" },
        select: { id: true, deviceId: true },
      });
      expect(result.deviceId).toBe("DEDA-001");
      expect(result.memories).toHaveLength(1);
      expect(result.memories[0]).toEqual({
        key: "favorite_color",
        valueText: "蓝色",
        version: 2,
        confidence: 0.91,
        injectionCount: 14,
        lastInjectedAt: "2026-11-09T05:40:11Z",
        lastConfirmedAt: "2026-11-08T13:02:00Z",
        validFrom: "2026-11-06T09:20:00Z",
      });
    });

    it("设备不存在返回 404", async () => {
      const service = await buildService(buildPrisma({ devices: [] }));

      await expect(service.getCurrentMemories("ghost")).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("getMemoryHistory", () => {
    it("按 version 升序返回全部版本（含 retract 墓碑行字段）", async () => {
      const prisma = buildPrisma({
        devices: DEVICES,
        memories: [
          {
            id: "m2",
            deviceId: "uuid-1",
            key: "favorite_color",
            version: 2,
            changeType: "retract",
            status: "retracted",
            valueText: null,
            confidence: 0.9,
            sourceTurnId: "turn-2",
            validFrom: "2026-11-06T09:20:00Z",
            validTo: null,
            createdAt: "2026-11-06T09:20:01Z",
          },
          {
            id: "m1",
            deviceId: "uuid-1",
            key: "favorite_color",
            version: 1,
            changeType: "initial",
            status: "superseded",
            valueText: "红色",
            confidence: 0.88,
            sourceTurnId: "turn-1",
            validFrom: "2026-11-03T08:00:00Z",
            validTo: "2026-11-06T09:20:00Z",
            createdAt: "2026-11-03T08:00:01Z",
          },
          // 其他槽位不应混入
          {
            id: "m9",
            deviceId: "uuid-1",
            key: "favorite_animal",
            version: 1,
            status: "active",
          },
        ],
      });
      const service = await buildService(prisma);

      const result = await service.getMemoryHistory(
        "DEDA-001",
        "favorite_color",
      );

      expect(result.deviceId).toBe("DEDA-001");
      expect(result.key).toBe("favorite_color");
      expect(result.versions.map((v) => v.version)).toEqual([1, 2]);
      const [v1, v2] = result.versions;
      expect(v1).toEqual({
        id: "m1",
        version: 1,
        changeType: "initial",
        status: "superseded",
        valueText: "红色",
        confidence: 0.88,
        sourceTurnId: "turn-1",
        validFrom: "2026-11-03T08:00:00Z",
        validTo: "2026-11-06T09:20:00Z",
        createdAt: "2026-11-03T08:00:01Z",
      });
      expect(v2!.valueText).toBeNull();
      expect(v2!.changeType).toBe("retract");
    });

    it("设备不存在返回 404", async () => {
      const service = await buildService(buildPrisma({ devices: [] }));

      await expect(
        service.getMemoryHistory("ghost", "favorite_color"),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
