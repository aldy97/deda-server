import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "@/common/prisma/prisma.service";
import {
  AppAssetSlotsService,
  toAppAssetSlotView,
} from "./app-asset-slots.service";

interface FakeSlot {
  key: string;
  label: string;
  page: string;
  note: string | null;
  enabled: boolean;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function makeRow(overrides: Partial<FakeSlot> = {}): FakeSlot {
  return {
    key: "diagnostics/remote-probe",
    label: "远程素材探针",
    page: "diagnostics",
    note: null,
    enabled: true,
    createdBy: null,
    updatedBy: null,
    createdAt: new Date("2026-11-25T00:00:00.000Z"),
    updatedAt: new Date("2026-11-25T00:00:00.000Z"),
    ...overrides,
  };
}

function makeService(overrides: { prisma?: Record<string, unknown> } = {}) {
  const prisma = {
    appAssetSlot: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    appAsset: {
      count: jest.fn(),
    },
    ...(overrides.prisma ?? {}),
  };
  const service = new AppAssetSlotsService(prisma as unknown as PrismaService);
  return { service, prisma };
}

describe("AppAssetSlotsService", () => {
  it("listAll 按 page/key 排序并序列化时间", async () => {
    const { service, prisma } = makeService({});
    prisma.appAssetSlot.findMany.mockResolvedValue([
      makeRow(),
      makeRow({ key: "device-home/hero", page: "device-home" }),
    ]);

    const rows = await service.listAll();

    expect(prisma.appAssetSlot.findMany).toHaveBeenCalledWith({
      orderBy: [{ page: "asc" }, { key: "asc" }],
    });
    expect(rows.map((row) => row.key)).toEqual([
      "diagnostics/remote-probe",
      "device-home/hero",
    ]);
    expect(rows[0].createdAt).toBe("2026-11-25T00:00:00.000Z");
  });

  it("listEnabled 只查启用项", async () => {
    const { service, prisma } = makeService({});
    prisma.appAssetSlot.findMany.mockResolvedValue([makeRow()]);

    await service.listEnabled();

    expect(prisma.appAssetSlot.findMany).toHaveBeenCalledWith({
      where: { enabled: true },
      orderBy: [{ page: "asc" }, { key: "asc" }],
    });
  });

  it("enabledKeySet 返回启用 key 集合", async () => {
    const { service, prisma } = makeService({});
    prisma.appAssetSlot.findMany.mockResolvedValue([
      { key: "diagnostics/remote-probe" },
      { key: "device-home/hero" },
    ]);

    const keys = await service.enabledKeySet();

    expect(prisma.appAssetSlot.findMany).toHaveBeenCalledWith({
      where: { enabled: true },
      select: { key: true },
    });
    expect([...keys]).toEqual(["diagnostics/remote-probe", "device-home/hero"]);
  });

  it("find 不存在返回 null", async () => {
    const { service, prisma } = makeService({});
    prisma.appAssetSlot.findUnique.mockResolvedValue(null);

    expect(await service.find("missing/key")).toBeNull();
  });

  it("assertEnabled：未注册与已停用都拒绝", async () => {
    const { service, prisma } = makeService({});
    prisma.appAssetSlot.findUnique.mockResolvedValueOnce(null);
    await expect(service.assertEnabled("missing/key")).rejects.toThrow(
      BadRequestException,
    );

    prisma.appAssetSlot.findUnique.mockResolvedValueOnce(
      makeRow({ enabled: false }),
    );
    await expect(
      service.assertEnabled("diagnostics/remote-probe"),
    ).rejects.toThrow(/停用/);

    prisma.appAssetSlot.findUnique.mockResolvedValueOnce(makeRow());
    await expect(
      service.assertEnabled("diagnostics/remote-probe"),
    ).resolves.toMatchObject({ key: "diagnostics/remote-probe" });
  });

  it("create 由 page + suffix 拼 key，并记录操作人", async () => {
    const { service, prisma } = makeService({});
    prisma.appAssetSlot.create.mockResolvedValue(
      makeRow({
        key: "device-home/section-hero",
        page: "device-home",
        label: "首页主视觉",
        note: "设计稿 A",
        createdBy: "alice",
        updatedBy: "alice",
      }),
    );

    const view = await service.create(
      {
        page: "device-home",
        suffix: "section-hero",
        label: "  首页主视觉  ",
        note: "  设计稿 A  ",
      },
      "alice",
    );

    expect(prisma.appAssetSlot.create).toHaveBeenCalledWith({
      data: {
        key: "device-home/section-hero",
        page: "device-home",
        label: "首页主视觉",
        note: "设计稿 A",
        createdBy: "alice",
        updatedBy: "alice",
      },
    });
    expect(view.key).toBe("device-home/section-hero");
  });

  it("create 允许 note 为空", async () => {
    const { service, prisma } = makeService({});
    prisma.appAssetSlot.create.mockResolvedValue(makeRow());

    await service.create(
      { page: "diagnostics", suffix: "remote-probe", label: "探针" },
      null,
    );

    expect(prisma.appAssetSlot.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ note: null, createdBy: null }),
    });
  });

  it("create 重复 key 映射为 409", async () => {
    const { service, prisma } = makeService({});
    prisma.appAssetSlot.create.mockRejectedValue(
      Object.assign(new Error("unique"), { code: "P2002" }),
    );

    await expect(
      service.create(
        { page: "device-home", suffix: "hero", label: "首页主视觉" },
        null,
      ),
    ).rejects.toThrow(ConflictException);
  });

  it("create 校验 page / suffix / label / note / 总长度", async () => {
    const { service } = makeService({});

    await expect(
      service.create({ page: "Device-Home", suffix: "hero", label: "x" }, null),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.create(
        { page: "device-home", suffix: "hero/", label: "x" },
        null,
      ),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.create(
        { page: "device-home", suffix: "hero", label: "   " },
        null,
      ),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.create(
        {
          page: "device-home",
          suffix: "hero",
          label: "x",
          note: "n".repeat(201),
        },
        null,
      ),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.create(
        {
          page: "p".repeat(32),
          suffix: "s".repeat(32),
          label: "x",
        },
        null,
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it("update 不存在返回 404", async () => {
    const { service, prisma } = makeService({});
    prisma.appAssetSlot.findUnique.mockResolvedValue(null);

    await expect(
      service.update({ key: "missing/key", label: "x" }, null),
    ).rejects.toThrow(NotFoundException);
  });

  it("update 可改标签 / 备注 / 启停", async () => {
    const { service, prisma } = makeService({});
    prisma.appAssetSlot.findUnique.mockResolvedValue(makeRow());
    prisma.appAsset.count.mockResolvedValue(0);
    prisma.appAssetSlot.update.mockResolvedValue(
      makeRow({ label: "新标签", note: null, enabled: false }),
    );

    const view = await service.update(
      {
        key: "diagnostics/remote-probe",
        label: "  新标签 ",
        note: null,
        enabled: false,
      },
      "bob",
    );

    expect(prisma.appAsset.count).toHaveBeenCalledWith({
      where: { key: "diagnostics/remote-probe", status: "published" },
    });
    expect(prisma.appAssetSlot.update).toHaveBeenCalledWith({
      where: { key: "diagnostics/remote-probe" },
      data: {
        label: "新标签",
        note: null,
        enabled: false,
        updatedBy: "bob",
      },
    });
    expect(view.enabled).toBe(false);
  });

  it("update 停用仍有 published 的展示位返回 409", async () => {
    const { service, prisma } = makeService({});
    prisma.appAssetSlot.findUnique.mockResolvedValue(makeRow());
    prisma.appAsset.count.mockResolvedValue(1);

    await expect(
      service.update({ key: "diagnostics/remote-probe", enabled: false }, null),
    ).rejects.toThrow(ConflictException);
    expect(prisma.appAssetSlot.update).not.toHaveBeenCalled();
  });

  it("update 已停用时再停用不再查 published", async () => {
    const { service, prisma } = makeService({});
    prisma.appAssetSlot.findUnique.mockResolvedValue(
      makeRow({ enabled: false }),
    );
    prisma.appAssetSlot.update.mockResolvedValue(makeRow({ enabled: false }));

    await service.update(
      { key: "diagnostics/remote-probe", enabled: false },
      null,
    );

    expect(prisma.appAsset.count).not.toHaveBeenCalled();
  });

  it("update 拒绝空 key 与空更新", async () => {
    const { service, prisma } = makeService({});
    await expect(service.update({ key: "   " }, null)).rejects.toThrow(
      /缺少展示位 key/,
    );

    prisma.appAssetSlot.findUnique.mockResolvedValue(makeRow());
    await expect(
      service.update({ key: "diagnostics/remote-probe" }, null),
    ).rejects.toThrow(/没有需要更新的字段/);
  });

  it("toAppAssetSlotView 输出字段完整", () => {
    expect(toAppAssetSlotView(makeRow())).toEqual({
      key: "diagnostics/remote-probe",
      label: "远程素材探针",
      page: "diagnostics",
      note: null,
      enabled: true,
      createdBy: null,
      updatedBy: null,
      createdAt: "2026-11-25T00:00:00.000Z",
      updatedAt: "2026-11-25T00:00:00.000Z",
    });
  });
});
