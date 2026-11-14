import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import {
  MessagesAnalyticsController,
  MessagesQueryDto,
  MessagesStatsQueryDto,
} from "./messages-analytics.controller";
import { MessagesAnalyticsService } from "./messages-analytics.service";

describe("MessagesAnalyticsController", () => {
  it("列表与详情透传给 service", async () => {
    const service = {
      listMessages: jest.fn().mockResolvedValue({ total: 0 }),
      getMessage: jest.fn().mockResolvedValue({ id: "m1" }),
    } as unknown as MessagesAnalyticsService;
    const controller = new MessagesAnalyticsController(service);

    const query = new MessagesQueryDto();
    await controller.listMessages(query);
    expect(service.listMessages).toHaveBeenCalledWith(query);

    await controller.getMessage("m1");
    expect(service.getMessage).toHaveBeenCalledWith("m1");
  });

  it("modes 与 interruption-rate 透传给 service", async () => {
    const service = {
      listMessages: jest.fn(),
      getMessage: jest.fn(),
      getModes: jest.fn().mockResolvedValue({ modes: [] }),
      getInterruptionRate: jest
        .fn()
        .mockResolvedValue({ interruptionRate: null }),
    } as unknown as MessagesAnalyticsService;
    const controller = new MessagesAnalyticsController(service);

    const query = new MessagesStatsQueryDto();
    query.startDate = "2026-11-01";
    await controller.getModes(query);
    expect(service.getModes).toHaveBeenCalledWith(query);

    await controller.getInterruptionRate(query);
    expect(service.getInterruptionRate).toHaveBeenCalledWith(query);
  });

  describe("MessagesStatsQueryDto 校验", () => {
    it("非法日期格式被拒绝，空串容忍", async () => {
      const bad = plainToInstance(MessagesStatsQueryDto, {
        startDate: "2026/11/01",
      });
      expect(
        (await validate(bad)).some((e) => e.property === "startDate"),
      ).toBe(true);

      const ok = plainToInstance(MessagesStatsQueryDto, { startDate: "" });
      expect(await validate(ok)).toHaveLength(0);
      expect(ok.startDate).toBeUndefined();
    });
  });

  describe("MessagesQueryDto 校验", () => {
    async function validateQuery(query: Record<string, string>) {
      const dto = plainToInstance(MessagesQueryDto, query);
      const errors = await validate(dto);
      return { dto, errors };
    }

    it("空串日期容忍，缺省分页 1/20", async () => {
      const { dto, errors } = await validateQuery({
        startDate: "",
        endDate: "",
      });
      expect(errors).toHaveLength(0);
      expect(dto.startDate).toBeUndefined();
      expect(dto.page).toBe(1);
      expect(dto.pageSize).toBe(20);
    });

    it("非法枚举值 400：role=admin / status=garbage / sort 非白名单", async () => {
      for (const [key, value] of [
        ["role", "admin"],
        ["status", "garbage"],
        ["sort", "createdAt_desc"],
      ]) {
        const { errors } = await validateQuery({ [key]: value });
        expect(errors.some((e) => e.property === key)).toBe(true);
      }
    });

    it("合法枚举值通过（含新增 interrupted）", async () => {
      const { dto, errors } = await validateQuery({
        role: "assistant",
        status: "failed",
        sort: "spokeAt_asc",
      });
      expect(errors).toHaveLength(0);
      expect(dto.role).toBe("assistant");
      expect(dto.sort).toBe("spokeAt_asc");

      const interrupted = await validateQuery({ status: "interrupted" });
      expect(interrupted.errors).toHaveLength(0);
      expect(interrupted.dto.status).toBe("interrupted");
    });

    it("keyword 超 50 字被拒绝", async () => {
      const { errors } = await validateQuery({ keyword: "长".repeat(51) });
      expect(errors.some((e) => e.property === "keyword")).toBe(true);
    });

    it("page/pageSize 越界被拒绝", async () => {
      for (const query of [
        { page: "0" },
        { pageSize: "0" },
        { pageSize: "101" },
      ]) {
        const { errors } = await validateQuery(query);
        expect(errors.length).toBeGreaterThan(0);
      }
    });

    it("非法日期格式被拒绝", async () => {
      const { errors } = await validateQuery({ startDate: "2026/11/01" });
      expect(errors.some((e) => e.property === "startDate")).toBe(true);
    });
  });
});
