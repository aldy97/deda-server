import { Logger } from "@nestjs/common";
import { PrismaService } from "@/common/prisma/prisma.service";
import type { SafetyVerdict } from "@/modules/vendor/child-safety.service";
import { TurnDecisionRecorder } from "./turn-decision-recorder.service";

/**
 * 判定审计落库单测：全程 mock prisma，不出网不写库。
 *
 * 三条硬约束（对应看板可信度）：
 * 1. fire-and-forget——落库失败绝不能冒泡到对话链路，也绝不能 await 阻塞首音；
 * 2. asrText 是儿童语音转写，只在「拦了」或「判成非 safe 类别」时落库，且绝不进日志；
 * 3. upsert on turnId 幂等——主模型重试同一轮不能产生第二行，否则拦截率分母被灌水。
 */

const l2 = (overrides: Partial<SafetyVerdict> = {}): SafetyVerdict => ({
  blocked: false,
  category: "safe",
  layer: "L2",
  source: "l2_model",
  ...overrides,
});

function setup() {
  const upsert = jest.fn().mockResolvedValue({ id: "row-1" });
  const prisma = { turnDecisionLog: { upsert } } as unknown as PrismaService;
  const service = new TurnDecisionRecorder(prisma);
  return { service, upsert, prisma };
}

/** 取出 upsert 的 create 载荷，断言都基于它 */
function createData(upsert: jest.Mock) {
  return upsert.mock.calls[0][0].create;
}

describe("TurnDecisionRecorder", () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    warnSpy = jest.spyOn(Logger.prototype, "warn").mockReturnValue(undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("落库完整判定字段：L1 拦截轮", () => {
    const { service, upsert } = setup();

    service.record({
      turnId: "turn-1",
      deviceId: "dev-uuid-1",
      safety: {
        blocked: true,
        category: "sexual",
        layer: "L1",
        source: "l1_regex",
        matched: "色情",
      },
      intent: null,
      intentSource: "not_routed",
      asrText: "假数据-敏感表达",
    });

    expect(upsert).toHaveBeenCalledTimes(1);
    const data = createData(upsert);
    expect(data).toMatchObject({
      turnId: "turn-1",
      deviceId: "dev-uuid-1",
      channel: "baidu-rtc",
      safetyLayer: "L1",
      safetyCategory: "sexual",
      safetyBlocked: true,
      safetySource: "l1_regex",
      safetyMatched: "色情",
      intent: null,
      intentSource: "not_routed",
      asrText: "假数据-敏感表达",
    });
    expect(upsert.mock.calls[0][0].where).toEqual({ turnId: "turn-1" });
  });

  it("update 分支与 create 同源：同轮重试不产生第二行", () => {
    const { service, upsert } = setup();

    service.record({
      turnId: "turn-retry",
      safety: l2(),
      intent: "free_chat",
      intentSource: "model",
      asrText: "假数据-重试轮",
    });

    const arg = upsert.mock.calls[0][0];
    expect(arg.where).toEqual({ turnId: "turn-retry" });
    // update 不能把 turnId 改掉（会破坏幂等键），其余判定字段允许覆写为最后一次结论
    expect(arg.update.turnId).toBeUndefined();
    expect(arg.update.safetySource).toBe("l2_model");
    expect(arg.update.intent).toBe("free_chat");
    expect(arg.update.intentSource).toBe("model");
  });

  it.each([
    [
      "blocked 轮",
      l2({ blocked: true, category: "violence", source: "l2_model" }),
      "假数据-被拦",
    ],
    [
      "emotional_harm 轮（不拦但改行为）",
      l2({ category: "emotional_harm" }),
      "假数据-气话",
    ],
  ])("写入 asrText：%s", (_name, safety, asrText) => {
    const { service, upsert } = setup();
    service.record({ turnId: "t", safety, asrText });
    expect(createData(upsert).asrText).toBe(asrText);
  });

  it.each([
    ["模型判 safe", l2()],
    ["标签非法放行", l2({ category: null, source: "l2_invalid_label" })],
    [
      "模型异常放行",
      l2({ category: null, layer: null, source: "l2_fail_open" }),
    ],
    ["冒险接管未评估", null],
  ])("不写入 asrText：%s", (_name, safety) => {
    const { service, upsert } = setup();
    service.record({ turnId: "t", safety, asrText: "假数据-不该落库" });
    expect(createData(upsert).asrText).toBeNull();
  });

  it("asrText 超过 200 字截断（列宽 VARCHAR(200)）", () => {
    const { service, upsert } = setup();
    service.record({
      turnId: "t",
      safety: l2({ blocked: true, category: "self_harm" }),
      asrText: "假".repeat(350),
    });
    expect(createData(upsert).asrText).toHaveLength(200);
  });

  it("safety 为 null 时默认 not_evaluated，不伪装成模型判 safe", () => {
    const { service, upsert } = setup();
    service.record({ turnId: "t", safety: null });
    expect(createData(upsert)).toMatchObject({
      safetyLayer: null,
      safetyCategory: null,
      safetyBlocked: false,
      safetySource: "not_evaluated",
      safetyMatched: null,
    });
  });

  it("safety 为 null 但显式给了 safetySource 时以显式值为准", () => {
    const { service, upsert } = setup();
    service.record({ turnId: "t", safety: null, safetySource: "l2_fail_open" });
    expect(createData(upsert).safetySource).toBe("l2_fail_open");
  });

  it("safety 省略时同样按未评估处理", () => {
    const { service, upsert } = setup();
    service.record({ turnId: "t" });
    expect(createData(upsert).safetySource).toBe("not_evaluated");
  });

  it("匿名链路 deviceId 缺省落 null（安全审计最需要匿名流量）", () => {
    const { service, upsert } = setup();
    service.record({ turnId: "t", safety: l2() });
    expect(createData(upsert).deviceId).toBeNull();
  });

  it("channel 可覆盖", () => {
    const { service, upsert } = setup();
    service.record({ turnId: "t", channel: "vendor-ws", safety: l2() });
    expect(createData(upsert).channel).toBe("vendor-ws");
  });

  it("turnId 缺失时直接丢弃，不写库", () => {
    const { service, upsert } = setup();
    service.record({ turnId: "", safety: l2() });
    expect(upsert).not.toHaveBeenCalled();
  });

  it("fire-and-forget：record() 同步返回，不等待落库", () => {
    const { service } = setup();
    let settled = false;
    const deferred = new Promise((resolve) => {
      setTimeout(() => {
        settled = true;
        resolve({ id: "row-2" });
      }, 10);
    });
    (
      service as unknown as {
        prisma: { turnDecisionLog: { upsert: jest.Mock } };
      }
    ).prisma.turnDecisionLog.upsert.mockReturnValue(deferred);

    const returned = service.record({ turnId: "t", safety: l2() });

    expect(returned).toBeUndefined();
    expect(settled).toBe(false);
  });

  it("落库失败只 warn，不向对话链路抛异常", async () => {
    const upsert = jest
      .fn()
      .mockRejectedValue(new Error("connection terminated"));
    const prisma = { turnDecisionLog: { upsert } } as unknown as PrismaService;
    const service = new TurnDecisionRecorder(prisma);

    expect(() => service.record({ turnId: "t", safety: l2() })).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("connection terminated"),
    );
  });

  it("PII 纪律：warn 日志绝不携带 asrText", async () => {
    const upsert = jest.fn().mockRejectedValue(new Error("db down"));
    const prisma = { turnDecisionLog: { upsert } } as unknown as PrismaService;
    const service = new TurnDecisionRecorder(prisma);
    const secret = "假数据-孩子说的原话";

    service.record({
      turnId: "t",
      safety: l2({ blocked: true, category: "sexual" }),
      asrText: secret,
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(warnSpy).toHaveBeenCalled();
    for (const call of warnSpy.mock.calls) {
      expect(String(call[0])).not.toContain(secret);
    }
  });
});
