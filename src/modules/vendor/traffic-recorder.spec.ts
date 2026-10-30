import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { VendorTrafficRecorder } from "./traffic-recorder";

describe("VendorTrafficRecorder", () => {
  let workDir: string;

  const buildModule = async (env: Record<string, string>) => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VendorTrafficRecorder,
        {
          provide: ConfigService,
          useValue: { get: jest.fn((key: string) => env[key]) },
        },
      ],
    }).compile();
    // TestingModule.compile() 不触发 onModuleInit（保留期清理），需显式 init
    await module.init();
    return module.get<VendorTrafficRecorder>(VendorTrafficRecorder);
  };

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "traffic-recorder-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("should be disabled by default and write nothing", async () => {
    const dir = join(workDir, "records");
    const recorder = await buildModule({ VENDOR_TRAFFIC_RECORD_DIR: dir });
    expect(recorder.isEnabled).toBe(false);

    await recorder.record("in", { asrText: "hello" });

    await expect(readdir(dir)).rejects.toThrow(); // 目录根本不会被创建
  });

  it("should write one JSON line per record when enabled", async () => {
    const dir = join(workDir, "records");
    const recorder = await buildModule({
      VENDOR_TRAFFIC_RECORD: "on",
      VENDOR_TRAFFIC_RECORD_DIR: dir,
    });

    await recorder.record(
      "in",
      { deviceId: "dev-001", asrText: "我要听故事" },
      { event: "vendor:text:in", deviceId: "dev-001", latencyMs: 120 },
    );
    await recorder.record(
      "out",
      { responseText: "好呀" },
      { deviceId: "dev-001" },
    );

    const files = await readdir(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^vendor-\d{4}-\d{2}-\d{2}\.jsonl$/);

    const lines = (await readFile(join(dir, files[0]), "utf8"))
      .trim()
      .split("\n");
    expect(lines).toHaveLength(2);

    const first = JSON.parse(lines[0]);
    expect(first.direction).toBe("in");
    expect(first.event).toBe("vendor:text:in");
    expect(first.deviceId).toBe("dev-001");
    expect(first.latencyMs).toBe(120);
    expect(first.payload.asrText).toBe("我要听故事");
    expect(typeof first.ts).toBe("string");

    const second = JSON.parse(lines[1]);
    expect(second.direction).toBe("out");
    expect(second.payload.responseText).toBe("好呀");
  });

  it("should not throw when the record directory is not writable", async () => {
    // 用一个已存在的文件当目录，强制 mkdir 失败
    const blocker = join(workDir, "blocker");
    await writeFile(blocker, "i am a file");
    const recorder = await buildModule({
      VENDOR_TRAFFIC_RECORD: "on",
      VENDOR_TRAFFIC_RECORD_DIR: join(blocker, "sub"),
    });

    await expect(
      recorder.record("in", { asrText: "x" }),
    ).resolves.toBeUndefined();
  });

  it("should sweep expired files on init but keep recent ones", async () => {
    const dir = join(workDir, "records");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "vendor-2000-01-01.jsonl"), "{}");
    await writeFile(
      join(dir, `vendor-${new Date().toISOString().slice(0, 10)}.jsonl`),
      "{}",
    );

    await buildModule({
      VENDOR_TRAFFIC_RECORD: "on",
      VENDOR_TRAFFIC_RECORD_DIR: dir,
      VENDOR_TRAFFIC_RECORD_RETENTION_DAYS: "7",
    });

    const files = await readdir(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).not.toContain("2000-01-01");
  });

  it("should honor a custom retention window", async () => {
    const dir = join(workDir, "records");
    await mkdir(dir, { recursive: true });
    const sixDaysAgo = new Date(Date.now() - 6 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    await writeFile(join(dir, `vendor-${sixDaysAgo}.jsonl`), "{}");

    await buildModule({
      VENDOR_TRAFFIC_RECORD: "on",
      VENDOR_TRAFFIC_RECORD_DIR: dir,
      VENDOR_TRAFFIC_RECORD_RETENTION_DAYS: "3",
    });

    const files = await readdir(dir);
    expect(files).toHaveLength(0);
  });
});
