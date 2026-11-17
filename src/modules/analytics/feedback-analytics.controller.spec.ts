import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import {
  FeedbackAnalyticsController,
  ParentReportFeedbacksQueryDto,
  UserFeedbacksQueryDto,
} from "./feedback-analytics.controller";
import { FeedbackAnalyticsService } from "./feedback-analytics.service";

describe("FeedbackAnalyticsController", () => {
  it("两个端点透传 query 给 service", async () => {
    const service = {
      listParentReportFeedbacks: jest.fn().mockResolvedValue({ total: 0 }),
      listUserFeedbacks: jest.fn().mockResolvedValue({ total: 0 }),
    } as unknown as FeedbackAnalyticsService;
    const controller = new FeedbackAnalyticsController(service);

    const parentQuery = new ParentReportFeedbacksQueryDto();
    await controller.listParentReportFeedbacks(parentQuery);
    expect(service.listParentReportFeedbacks).toHaveBeenCalledWith(parentQuery);

    const userQuery = new UserFeedbacksQueryDto();
    await controller.listUserFeedbacks(userQuery);
    expect(service.listUserFeedbacks).toHaveBeenCalledWith(userQuery);
  });

  describe("ParentReportFeedbacksQueryDto 校验", () => {
    async function validateQuery(query: Record<string, string>) {
      const dto = plainToInstance(ParentReportFeedbacksQueryDto, query);
      const errors = await validate(dto);
      return { dto, errors };
    }

    it("空串 startDate/endDate 视为未提供（前端 URL 会带 startDate=）", async () => {
      const { dto, errors } = await validateQuery({
        startDate: "",
        endDate: "",
        page: "1",
        pageSize: "20",
      });
      expect(errors).toHaveLength(0);
      expect(dto.startDate).toBeUndefined();
      expect(dto.endDate).toBeUndefined();
      expect(dto.page).toBe(1);
      expect(dto.pageSize).toBe(20);
    });

    it('isUseful 字符串转布尔："true"→true，"false"→false', async () => {
      const { dto: t } = await validateQuery({ isUseful: "true" });
      expect(t.isUseful).toBe(true);
      const { dto: f } = await validateQuery({ isUseful: "false" });
      expect(f.isUseful).toBe(false);
    });

    it("非法日期格式被拒绝", async () => {
      const { errors } = await validateQuery({ startDate: "2026-1-1" });
      expect(errors.some((e) => e.property === "startDate")).toBe(true);
    });

    it("非法 isUseful 被拒绝", async () => {
      const { errors } = await validateQuery({ isUseful: "yes" });
      expect(errors.some((e) => e.property === "isUseful")).toBe(true);
    });

    it("pageSize 超 100 被拒绝", async () => {
      const { errors } = await validateQuery({ pageSize: "200" });
      expect(errors.some((e) => e.property === "pageSize")).toBe(true);
    });
  });

  describe("UserFeedbacksQueryDto 校验", () => {
    it("hasContact 字符串转布尔，空串日期容忍", async () => {
      const dto = plainToInstance(UserFeedbacksQueryDto, {
        hasContact: "true",
        startDate: "",
      });
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
      expect(dto.hasContact).toBe(true);
      expect(dto.startDate).toBeUndefined();
    });
  });
});
