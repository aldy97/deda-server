import { ConfigService } from "@nestjs/config";
import { RedisService } from "./redis.service";

const mockQuit = jest.fn();
const mockDisconnect = jest.fn();
const mockGet = jest.fn();
const mockSet = jest.fn();
const mockSetex = jest.fn();
const mockDel = jest.fn();
const mockZadd = jest.fn();
const mockZrangebyscore = jest.fn();
const mockZremrangebyscore = jest.fn();

jest.mock("ioredis", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    quit: mockQuit,
    disconnect: mockDisconnect,
    get: mockGet,
    set: mockSet,
    setex: mockSetex,
    del: mockDel,
    zadd: mockZadd,
    zrangebyscore: mockZrangebyscore,
    zremrangebyscore: mockZremrangebyscore,
  })),
}));

function createService(redisUrl = "redis://localhost:6379") {
  const configService = {
    get: jest.fn().mockReturnValue(redisUrl),
  } as unknown as ConfigService;
  return new RedisService(configService);
}

describe("RedisService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQuit.mockResolvedValue("OK");
    mockGet.mockResolvedValue("cached");
    mockSet.mockResolvedValue("OK");
    mockSetex.mockResolvedValue("OK");
    mockDel.mockResolvedValue(1);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("closes the Redis client on module destroy", async () => {
    const service = createService();

    await service.onModuleDestroy();

    expect(mockQuit).toHaveBeenCalledTimes(1);
    expect(mockDisconnect).not.toHaveBeenCalled();
  });

  it("forces disconnect when graceful Redis shutdown fails", async () => {
    mockQuit.mockRejectedValue(new Error("connection unavailable"));
    const service = createService();

    await expect(service.onModuleDestroy()).resolves.toBeUndefined();

    expect(mockDisconnect).toHaveBeenCalledTimes(1);
  });

  it("delegates reads, writes, TTL writes and deletes to Redis", async () => {
    const service = createService();

    await expect(service.getValue("key")).resolves.toBe("cached");
    await service.setValue("plain", "value");
    await service.setValue("expiring", "value", 60);
    await service.deleteValue("key");

    expect(mockGet).toHaveBeenCalledWith("key");
    expect(mockSet).toHaveBeenCalledWith("plain", "value");
    expect(mockSetex).toHaveBeenCalledWith("expiring", 60, "value");
    expect(mockDel).toHaveBeenCalledWith("key");
    expect(service.getClient()).toBeDefined();
  });

  it("uses the in-memory cache when Redis is not configured", async () => {
    const service = createService("");

    await service.setValue("key", "value");
    await expect(service.getValue("key")).resolves.toBe("value");
    await service.deleteValue("key");
    await expect(service.getValue("key")).resolves.toBeNull();

    expect(service.getClient()).toBeUndefined();
    expect(mockSet).not.toHaveBeenCalled();
  });

  it("expires in-memory entries and preserves entries without TTL", async () => {
    const now = jest.spyOn(Date, "now").mockReturnValue(1_000);
    const service = createService("");
    await service.setValue("expiring", "value", 1);
    await service.setValue("permanent", "value");

    now.mockReturnValue(2_001);
    await expect(service.getValue("expiring")).resolves.toBeNull();
    await expect(service.getValue("permanent")).resolves.toBe("value");
  });

  it("delegates sorted set operations to Redis", async () => {
    mockZadd.mockResolvedValue(1);
    mockZrangebyscore.mockResolvedValue(["dev-b", "200", "dev-a", "100"]);
    mockZremrangebyscore.mockResolvedValue(1);
    const service = createService();

    await service.zAdd("zkey", 100, "dev-a");
    const entries = await service.zRangeByScoreWithScores("zkey", 0, 300);
    await service.zRemRangeByScore("zkey", 0, 50);

    expect(mockZadd).toHaveBeenCalledWith("zkey", 100, "dev-a");
    expect(mockZrangebyscore).toHaveBeenCalledWith(
      "zkey",
      0,
      300,
      "WITHSCORES",
    );
    expect(entries).toEqual([
      { member: "dev-b", score: 200 },
      { member: "dev-a", score: 100 },
    ]);
    expect(mockZremrangebyscore).toHaveBeenCalledWith("zkey", 0, 50);
  });

  it("supports sorted sets in in-memory mode", async () => {
    const service = createService("");

    await service.zAdd("zkey", 100, "dev-a");
    await service.zAdd("zkey", 200, "dev-b");
    await service.zAdd("zkey", 150, "dev-a"); // 同 member 覆盖 score

    expect(await service.zRangeByScoreWithScores("zkey", 0, 300)).toEqual([
      { member: "dev-a", score: 150 },
      { member: "dev-b", score: 200 },
    ]);
    expect(await service.zRangeByScoreWithScores("zkey", 0, 100)).toEqual([]);

    await service.zRemRangeByScore("zkey", 0, 160);
    expect(await service.zRangeByScoreWithScores("zkey", 0, 300)).toEqual([
      { member: "dev-b", score: 200 },
    ]);

    await service.zRemRangeByScore("missing-key", 0, 300);
    expect(
      await service.zRangeByScoreWithScores("missing-key", 0, 300),
    ).toEqual([]);
    expect(mockZadd).not.toHaveBeenCalled();
  });
});
