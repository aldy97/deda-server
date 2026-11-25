import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "@/common/prisma/prisma.service";
import { AssetStorage } from "./storage/asset-storage";
import {
  AppAssetsAdminService,
  toAppAssetView,
} from "./app-assets-admin.service";
import { AppAssetSlotsService } from "./app-asset-slots.service";

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);

interface FakeAppAsset {
  id: string;
  key: string;
  version: number;
  url: string;
  width: number;
  height: number;
  mimeType: string;
  bytes: number;
  note: string | null;
  status: string;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  publishedAt: Date | null;
}

function makeRow(overrides: Partial<FakeAppAsset> = {}): FakeAppAsset {
  return {
    id: "id-1",
    key: "diagnostics/remote-probe",
    version: 1,
    url: "https://staging.valleyletters.com/app-assets/files/diagnostics/remote-probe/v1-a.png",
    width: 512,
    height: 512,
    mimeType: "image/png",
    bytes: 10,
    note: null,
    status: "draft",
    createdBy: "superadmin",
    createdAt: new Date("2026-11-25T00:00:00.000Z"),
    updatedAt: new Date("2026-11-25T00:00:00.000Z"),
    publishedAt: null,
    ...overrides,
  };
}

const SLOT_VIEW = {
  key: "diagnostics/remote-probe",
  label: "远程素材探针",
  page: "diagnostics",
  note: null,
  enabled: true,
  createdBy: null,
  updatedBy: null,
  createdAt: "2026-11-25T00:00:00.000Z",
  updatedAt: "2026-11-25T00:00:00.000Z",
};

function makeService(overrides: {
  prisma?: Record<string, unknown>;
  storage?: Record<string, unknown>;
  config?: Record<string, string | undefined>;
  slots?: Record<string, unknown>;
}) {
  const prisma = {
    appAsset: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    $transaction: jest.fn(),
    ...(overrides.prisma ?? {}),
  };
  const storage = {
    save: jest.fn(),
    buildPublicUrl: jest.fn(),
    assertValidPublicUrl: jest.fn(),
    ...(overrides.storage ?? {}),
  };
  const config = {
    get: jest.fn((key: string) => (overrides.config ?? {})[key]),
  };
  const slots = {
    listAll: jest.fn().mockResolvedValue([]),
    find: jest.fn().mockResolvedValue(null),
    assertEnabled: jest.fn().mockResolvedValue(SLOT_VIEW),
    ...(overrides.slots ?? {}),
  };

  const service = new AppAssetsAdminService(
    prisma as unknown as PrismaService,
    storage as unknown as AssetStorage,
    config as unknown as ConfigService,
    slots as unknown as AppAssetSlotsService,
  );
  return { service, prisma, storage, config, slots };
}

describe("AppAssetsAdminService", () => {
  it("list 按 key 聚合并降序，带 enabled", async () => {
    const { service, prisma, slots } = makeService({});
    slots.listAll.mockResolvedValue([SLOT_VIEW]);
    prisma.appAsset.findMany.mockResolvedValue([
      makeRow({ version: 2, status: "draft" }),
      makeRow({
        version: 1,
        status: "published",
        publishedAt: new Date("2026-11-25T00:00:00.000Z"),
      }),
    ]);

    const list = await service.list();
    expect(list).toHaveLength(1);
    expect(list[0].key).toBe("diagnostics/remote-probe");
    expect(list[0].enabled).toBe(true);
    expect(list[0].orphan).toBeUndefined();
    expect(list[0].versions.map((v) => v.version)).toEqual([2, 1]);
    expect(list[0].published?.version).toBe(1);
    expect(list[0].latestDraft?.version).toBe(2);
  });

  it("list 把注册表外但库里有版本的 key 作为 orphan 追加", async () => {
    const { service, prisma } = makeService({});
    prisma.appAsset.findMany.mockResolvedValue([
      makeRow({ key: "legacy/old", version: 3, status: "published" }),
    ]);

    const list = await service.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      key: "legacy/old",
      label: "legacy/old",
      page: "",
      enabled: false,
      orphan: true,
    });
    expect(list[0].versions[0].version).toBe(3);
  });

  it("versions 降序；注册表外但仍有版本时放行，均无则 400", async () => {
    const { service, prisma, slots } = makeService({});
    prisma.appAsset.findMany.mockResolvedValueOnce([]);

    await expect(service.versions("diagnostics/unknown")).rejects.toThrow(
      BadRequestException,
    );

    prisma.appAsset.findMany.mockResolvedValueOnce([
      makeRow({ key: "legacy/old", version: 2 }),
      makeRow({ key: "legacy/old", version: 1 }),
    ]);
    const orphan = await service.versions("legacy/old");
    expect(orphan.map((r) => r.version)).toEqual([2, 1]);

    slots.find.mockResolvedValue(SLOT_VIEW);
    prisma.appAsset.findMany.mockResolvedValueOnce([
      makeRow({ version: 2 }),
      makeRow({ version: 1 }),
    ]);
    const rows = await service.versions("diagnostics/remote-probe");
    expect(prisma.appAsset.findMany).toHaveBeenLastCalledWith({
      where: { key: "diagnostics/remote-probe" },
      orderBy: { version: "desc" },
    });
    expect(rows.map((r) => r.version)).toEqual([2, 1]);
  });

  it("upload 创建 draft 并返回 AppAsset 视图", async () => {
    const { service, prisma, storage, slots } = makeService({});
    prisma.appAsset.findFirst.mockResolvedValue({ version: 3 });
    storage.save.mockResolvedValue({
      url: "https://staging.valleyletters.com/app-assets/files/diagnostics/remote-probe/v4-a.png",
      relativePath: "diagnostics/remote-probe/v4-a.png",
    });
    prisma.appAsset.create.mockResolvedValue(
      makeRow({ version: 4, status: "draft", bytes: png.length }),
    );

    const view = await service.upload(
      {
        key: "diagnostics/remote-probe",
        width: 512,
        height: 512,
        note: "note",
      },
      { buffer: png },
      "superadmin",
    );

    expect(slots.assertEnabled).toHaveBeenCalledWith(
      "diagnostics/remote-probe",
    );
    expect(storage.save).toHaveBeenCalledWith({
      key: "diagnostics/remote-probe",
      version: 4,
      mimeType: "image/png",
      buffer: png,
    });
    expect(prisma.appAsset.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        key: "diagnostics/remote-probe",
        version: 4,
        status: "draft",
        mimeType: "image/png",
        bytes: png.length,
        createdBy: "superadmin",
        note: "note",
      }),
    });
    expect(view.status).toBe("draft");
    expect(view.createdAt).toBe("2026-11-25T00:00:00.000Z");
  });

  it("upload 拒绝非 PNG/JPEG/WebP", async () => {
    const { service } = makeService({});
    await expect(
      service.upload(
        { key: "diagnostics/remote-probe", width: 1, height: 1 },
        { buffer: Buffer.from("<svg/>") },
        null,
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it("upload 拒绝超大文件", async () => {
    const { service } = makeService({
      config: { APP_ASSET_MAX_BYTES: "3" },
    });
    await expect(
      service.upload(
        { key: "diagnostics/remote-probe", width: 1, height: 1 },
        { buffer: png },
        null,
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it("upload 拒绝越界尺寸", async () => {
    const { service } = makeService({});
    await expect(
      service.upload(
        { key: "diagnostics/remote-probe", width: 0, height: 512 },
        { buffer: png },
        null,
      ),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.upload(
        { key: "diagnostics/remote-probe", width: 512, height: 8001 },
        { buffer: png },
        null,
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it("upload 拒绝未注册/停用 key 与缺失文件", async () => {
    const { service, slots } = makeService({});
    slots.assertEnabled.mockRejectedValueOnce(
      new BadRequestException("未知的素材 key：unknown/key"),
    );
    await expect(
      service.upload(
        { key: "unknown/key", width: 512, height: 512 },
        { buffer: png },
        null,
      ),
    ).rejects.toThrow(BadRequestException);

    slots.assertEnabled.mockRejectedValueOnce(
      new BadRequestException("展示位已停用"),
    );
    await expect(
      service.upload(
        { key: "diagnostics/remote-probe", width: 512, height: 512 },
        { buffer: png },
        null,
      ),
    ).rejects.toThrow(/停用/);

    await expect(
      service.upload(
        { key: "diagnostics/remote-probe", width: 512, height: 512 },
        undefined,
        null,
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it("publish 事务内归档旧 published 并发布目标", async () => {
    const { service, prisma, storage } = makeService({});
    const target = makeRow({ status: "draft" });
    const publishedRow = makeRow({
      status: "published",
      publishedAt: new Date("2026-11-25T10:00:00.000Z"),
    });

    const tx = {
      appAsset: {
        findUnique: jest.fn().mockResolvedValue(target),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockResolvedValue(publishedRow),
      },
    };
    prisma.$transaction.mockImplementation((cb) => cb(tx));

    const view = await service.publish("id-1");

    expect(storage.assertValidPublicUrl).toHaveBeenCalledWith(target.url);
    expect(tx.appAsset.updateMany).toHaveBeenCalledWith({
      where: {
        key: "diagnostics/remote-probe",
        status: "published",
        id: { not: "id-1" },
      },
      data: { status: "archived" },
    });
    expect(tx.appAsset.update).toHaveBeenCalledWith({
      where: { id: "id-1" },
      data: { status: "published", publishedAt: expect.any(Date) },
    });
    expect(view.status).toBe("published");
    expect(view.publishedAt).toBe("2026-11-25T10:00:00.000Z");
  });

  it("publish 并发冲突（P2002）映射为 409", async () => {
    const { service, prisma } = makeService({});
    const conflict = Object.assign(new Error("unique"), { code: "P2002" });
    prisma.$transaction.mockRejectedValue(conflict);

    await expect(service.publish("id-1")).rejects.toThrow(ConflictException);
  });

  it("publish 目标不存在返回 404", async () => {
    const { service, prisma } = makeService({});
    const tx = {
      appAsset: {
        findUnique: jest.fn().mockResolvedValue(null),
        updateMany: jest.fn(),
        update: jest.fn(),
      },
    };
    prisma.$transaction.mockImplementation((cb) => cb(tx));

    await expect(service.publish("missing")).rejects.toThrow(NotFoundException);
  });

  it("archive 置为 archived 并返回视图", async () => {
    const { service, prisma } = makeService({});
    prisma.appAsset.findUnique.mockResolvedValue(
      makeRow({ status: "published" }),
    );
    prisma.appAsset.update.mockResolvedValue(makeRow({ status: "archived" }));

    const view = await service.archive("id-1");
    expect(prisma.appAsset.update).toHaveBeenCalledWith({
      where: { id: "id-1" },
      data: { status: "archived" },
    });
    expect(view.status).toBe("archived");
  });

  it("archive 目标不存在返回 404", async () => {
    const { service, prisma } = makeService({});
    prisma.appAsset.findUnique.mockResolvedValue(null);
    await expect(service.archive("missing")).rejects.toThrow(NotFoundException);
  });

  it("upload 并发版本冲突（P2002）映射为 409", async () => {
    const { service, prisma, storage } = makeService({});
    prisma.appAsset.findFirst.mockResolvedValue(null);
    storage.save.mockResolvedValue({
      url: "https://staging.valleyletters.com/app-assets/files/diagnostics/remote-probe/v1-a.png",
      relativePath: "diagnostics/remote-probe/v1-a.png",
    });
    prisma.appAsset.create.mockRejectedValue(
      Object.assign(new Error("unique"), { code: "P2002" }),
    );

    await expect(
      service.upload(
        { key: "diagnostics/remote-probe", width: 512, height: 512 },
        { buffer: png },
        null,
      ),
    ).rejects.toThrow(ConflictException);
  });

  it("upload 非唯一冲突错误原样抛出", async () => {
    const { service, prisma, storage } = makeService({});
    prisma.appAsset.findFirst.mockResolvedValue(null);
    storage.save.mockResolvedValue({
      url: "https://staging.valleyletters.com/app-assets/files/diagnostics/remote-probe/v1-a.png",
      relativePath: "diagnostics/remote-probe/v1-a.png",
    });
    prisma.appAsset.create.mockRejectedValue(new Error("db down"));

    await expect(
      service.upload(
        { key: "diagnostics/remote-probe", width: 512, height: 512 },
        { buffer: png },
        null,
      ),
    ).rejects.toThrow("db down");
  });

  it("publish 已发布版本直接返回，不再归档或更新", async () => {
    const { service, prisma } = makeService({});
    const target = makeRow({ status: "published" });
    const tx = {
      appAsset: {
        findUnique: jest.fn().mockResolvedValue(target),
        updateMany: jest.fn(),
        update: jest.fn(),
      },
    };
    prisma.$transaction.mockImplementation((cb) => cb(tx));

    const view = await service.publish("id-1");

    expect(tx.appAsset.updateMany).not.toHaveBeenCalled();
    expect(tx.appAsset.update).not.toHaveBeenCalled();
    expect(view.status).toBe("published");
  });

  it("toAppAssetView 序列化时间字段", () => {
    expect(toAppAssetView(makeRow({}))).toMatchObject({
      id: "id-1",
      status: "draft",
      createdAt: "2026-11-25T00:00:00.000Z",
      publishedAt: null,
    });
  });
});
