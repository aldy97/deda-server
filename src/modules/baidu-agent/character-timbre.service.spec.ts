import { CharacterTimbreService } from "./character-timbre.service";
import { PrismaService } from "@/common/prisma/prisma.service";

type FindMany = jest.Mock;

const makePrisma = (findMany: FindMany) =>
  ({ characterTimbre: { findMany } }) as unknown as PrismaService;

const rows = (...entries: Array<[string, string]>) =>
  entries.map(([characterKey, timbreId]) => ({ characterKey, timbreId }));

describe("CharacterTimbreService", () => {
  let findMany: FindMany;
  let service: CharacterTimbreService;
  let now: number;

  const build = () => new CharacterTimbreService(makePrisma(findMany));

  beforeEach(() => {
    findMany = jest.fn().mockResolvedValue(rows(["elly", "1000957"]));
    now = 1_700_000_000_000;
    jest.spyOn(Date, "now").mockImplementation(() => now);
    service = build();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("loads rows at startup and serves them without further DB round-trips", async () => {
    await service.onModuleInit();

    await expect(service.get("elly")).resolves.toBe("1000957");
    await expect(service.get("elly")).resolves.toBe("1000957");

    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it("returns null for null, empty and unknown character keys", async () => {
    await service.onModuleInit();

    await expect(service.get(null)).resolves.toBeNull();
    await expect(service.get("")).resolves.toBeNull();
    await expect(service.get("   ")).resolves.toBeNull();
    await expect(service.get("polly")).resolves.toBeNull();
  });

  it("normalises keys and rows to lower case so Elly always matches", async () => {
    findMany.mockResolvedValue(rows(["Elly", "1000957"]));
    await service.onModuleInit();

    await expect(service.get("ELLY")).resolves.toBe("1000957");
    await expect(service.get("elly ")).resolves.toBe("1000957");
  });

  it("skips blank rows instead of poisoning the cache", async () => {
    findMany.mockResolvedValue([
      { characterKey: "elly", timbreId: "1000957" },
      { characterKey: "polly", timbreId: "   " },
      { characterKey: "  ", timbreId: "1001022" },
    ]);
    await service.onModuleInit();

    await expect(service.get("elly")).resolves.toBe("1000957");
    await expect(service.get("polly")).resolves.toBeNull();
  });

  it("refreshes once the 60s TTL expires", async () => {
    await service.onModuleInit();
    await service.get("elly");

    now += 60_001;
    findMany.mockResolvedValue(rows(["elly", "1000958"]));

    await expect(service.get("elly")).resolves.toBe("1000958");
    expect(findMany).toHaveBeenCalledTimes(2);
  });

  it("keeps serving the last known mapping when a refresh fails", async () => {
    await service.onModuleInit();
    now += 60_001;
    findMany.mockRejectedValue(new Error("db down"));

    await expect(service.get("elly")).resolves.toBe("1000957");
  });

  it("returns null and never throws when the very first load fails", async () => {
    findMany.mockRejectedValue(new Error("db down"));

    await expect(service.onModuleInit()).resolves.toBeUndefined();
    await expect(service.get("elly")).resolves.toBeNull();
  });

  it("dedupes concurrent refreshes into a single query", async () => {
    let release!: (value: unknown) => void;
    findMany.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );

    const first = service.get("elly");
    const second = service.get("elly");
    release(rows(["elly", "1000957"]));

    await expect(first).resolves.toBe("1000957");
    await expect(second).resolves.toBe("1000957");
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it("reloads immediately after invalidate()", async () => {
    await service.onModuleInit();
    findMany.mockResolvedValue(rows(["elly", "1000957"], ["polly", "1001022"]));

    service.invalidate();

    await expect(service.get("polly")).resolves.toBe("1001022");
    expect(findMany).toHaveBeenCalledTimes(2);
  });
});
