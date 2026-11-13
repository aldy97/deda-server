import {
  ConflictException,
  ExecutionContext,
  ForbiddenException,
  INestApplication,
  NotFoundException,
  ValidationPipe,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test, TestingModule } from "@nestjs/testing";
import * as request from "supertest";
import { HttpExceptionFilter } from "@/common/filters/http-exception.filter";
import { ResponseInterceptor } from "@/common/interceptors/response.interceptor";
import { PROMPT_CONTENT_MAX_CHARS } from "@/modules/prompt-registry/prompt-defaults";
import { AnalyticsMetaController } from "./analytics-meta.controller";
import { AnalyticsAuthGuard } from "./guards/analytics-auth.guard";
import { PromptAdminController } from "./prompt-admin.controller";
import {
  DEFAULT_PUBLISH_CONFIRM_CODE,
  PromptAdminService,
  type PromptCatalogItem,
  type PromptDetail,
  type PromptVersionItem,
} from "./prompt-admin.service";

/** 与 analytics-jwt 策略挂在 req.user 上的载荷同口径 */
const ADMIN_USER = { username: "admin", displayName: "管理员" };
const AUTHOR = { username: "admin", displayName: "管理员" };
const KEY = "safety_l2_system";

const CATALOG_ITEM: PromptCatalogItem = {
  key: KEY,
  category: "small_model",
  scene: "safety_l2",
  name: "L2 安全分类 system prompt",
  description: "判定儿童对话是否触发 L2 安全流程",
  variables: [],
  maxChars: PROMPT_CONTENT_MAX_CHARS,
  defaultContent: "code-default-body",
  effectiveContent: "code-default-body",
  source: "default",
  publishedRevision: null,
  draftRevision: null,
  publishedAt: null,
  publishedBy: null,
  deviatesFromDefault: false,
};

const DETAIL: PromptDetail = {
  ...CATALOG_ITEM,
  draftContent: null,
  draftChangeNote: null,
  publishedContent: null,
  discardedDraftRevision: null,
};

const VERSION: PromptVersionItem = {
  revision: 1,
  content: "code-default-body",
  changeNote: "首次发布",
  authorUsername: "admin",
  authorDisplayName: "管理员",
  createdAt: "2026-11-13T06:00:00.000Z",
  publishedAt: "2026-11-13T06:00:00.000Z",
  isPublished: true,
  isDraft: false,
};

const WRITE_POLICY = {
  promptWriteEnabled: true,
  publishConfirmCode: DEFAULT_PUBLISH_CONFIRM_CODE,
};

function buildServiceMock() {
  return {
    list: jest.fn(),
    get: jest.fn(),
    listVersions: jest.fn(),
    saveDraft: jest.fn(),
    publish: jest.fn(),
    rollback: jest.fn(),
    resetToDefault: jest.fn(),
    getWritePolicy: jest.fn().mockReturnValue({ ...WRITE_POLICY }),
    isWriteEnabled: jest.fn().mockReturnValue(true),
  };
}

type ServiceMock = ReturnType<typeof buildServiceMock>;

describe("PromptAdminController", () => {
  let app: INestApplication | undefined;
  let service: ServiceMock;
  /** false = 模拟非管理员 / token scope 不对，守卫直接拒绝 */
  let guardAllows: boolean;

  // 注意：这里用 null 而不是 undefined 表示「NODE_ENV 没配」。
  // 传 undefined 会触发默认参数值，测不到回落分支。
  async function bootstrap(nodeEnv: string | null = "staging") {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [PromptAdminController, AnalyticsMetaController],
      providers: [
        { provide: PromptAdminService, useValue: service },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) =>
              key === "NODE_ENV" ? (nodeEnv ?? undefined) : undefined,
          },
        },
      ],
    })
      .overrideGuard(AnalyticsAuthGuard)
      .useValue({
        canActivate: (context: ExecutionContext) => {
          if (!guardAllows) return false;
          context.switchToHttp().getRequest().user = { ...ADMIN_USER };
          return true;
        },
      })
      .compile();

    // 与 src/main.ts 保持一致：校验管道 + 统一响应信封 + 统一异常信封
    app = module.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
      }),
    );
    app.useGlobalInterceptors(new ResponseInterceptor());
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
  }

  /**
   * 发请求的统一入口。
   * 刻意不用仓库里常见的 `app!`：漏调 bootstrap 时给出可读错误，
   * 而不是一个 "Cannot read properties of undefined" 的 TypeError。
   */
  function http() {
    if (!app) throw new Error("call bootstrap() before making requests");
    return request(app.getHttpServer());
  }

  beforeEach(() => {
    service = buildServiceMock();
    guardAllows = true;
  });

  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
  });

  it("两个 controller 都挂在 AnalyticsAuthGuard 之下", () => {
    for (const target of [PromptAdminController, AnalyticsMetaController]) {
      const guards = Reflect.getMetadata("__guards__", target);
      expect(guards).toContain(AnalyticsAuthGuard);
    }
  });

  describe("鉴权", () => {
    beforeEach(async () => {
      guardAllows = false;
      await bootstrap();
    });

    it("守卫拒绝时 GET catalog 返回 403 且不打到 service", async () => {
      const res = await http().get("/analytics/prompts");

      expect(res.status).toBe(403);
      expect(res.body.code).toBe(403);
      expect(service.list).not.toHaveBeenCalled();
    });

    it("守卫拒绝时 publish 返回 403 且不打到 service", async () => {
      const res = await http()
        .post(`/analytics/prompts/${KEY}/publish`)
        .send({ revision: 1, changeNote: "x", confirmCode: "DEDA2025" });

      expect(res.status).toBe(403);
      expect(service.publish).not.toHaveBeenCalled();
    });

    it("守卫拒绝时 GET meta 返回 403（环境标签拿不到 → 前端须 fail-closed）", async () => {
      const res = await http().get("/analytics/meta");

      expect(res.status).toBe(403);
    });
  });

  describe("读取", () => {
    beforeEach(async () => {
      await bootstrap();
    });

    it("GET /analytics/prompts 返回 catalog", async () => {
      service.list.mockResolvedValue([CATALOG_ITEM]);

      const res = await http().get("/analytics/prompts");

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        code: 0,
        message: "success",
        data: [CATALOG_ITEM],
      });
      expect(service.list).toHaveBeenCalledTimes(1);
    });

    it("GET /analytics/prompts/:key 返回详情", async () => {
      service.get.mockResolvedValue(DETAIL);

      const res = await http().get(`/analytics/prompts/${KEY}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual(DETAIL);
      expect(service.get).toHaveBeenCalledWith(KEY);
    });

    it("GET /analytics/prompts/:key/versions 返回版本历史", async () => {
      service.listVersions.mockResolvedValue([VERSION]);

      const res = await http().get(`/analytics/prompts/${KEY}/versions`);

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([VERSION]);
      expect(service.listVersions).toHaveBeenCalledWith(KEY);
    });

    it("未知 key 的 404 由 service 抛出并原样透传", async () => {
      service.get.mockRejectedValue(
        new NotFoundException("Unknown prompt key"),
      );

      const res = await http().get("/analytics/prompts/not_a_key");

      expect(res.status).toBe(404);
      expect(res.body.code).toBe(404);
      expect(res.body.data).toBeNull();
    });
  });

  describe("PATCH :key/draft", () => {
    beforeEach(async () => {
      await bootstrap();
    });

    it("成功保存草稿，author 取自 req.user", async () => {
      service.saveDraft.mockResolvedValue({ ...DETAIL, draftRevision: 1 });

      const res = await http()
        .patch(`/analytics/prompts/${KEY}/draft`)
        .send({ content: "new body", expectedRevision: 0 });

      expect(res.status).toBe(200);
      expect(res.body.data.draftRevision).toBe(1);
      expect(service.saveDraft).toHaveBeenCalledWith(
        KEY,
        { content: "new body", expectedRevision: 0 },
        AUTHOR,
      );
    });

    it("content 为空串返回 400 且不打到 service", async () => {
      const res = await http()
        .patch(`/analytics/prompts/${KEY}/draft`)
        .send({ content: "", expectedRevision: 0 });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe(400);
      expect(service.saveDraft).not.toHaveBeenCalled();
    });

    it("缺 expectedRevision 返回 400（乐观锁不可省）", async () => {
      const res = await http()
        .patch(`/analytics/prompts/${KEY}/draft`)
        .send({ content: "new body" });

      expect(res.status).toBe(400);
      expect(service.saveDraft).not.toHaveBeenCalled();
    });

    it("expectedRevision 为负数返回 400", async () => {
      const res = await http()
        .patch(`/analytics/prompts/${KEY}/draft`)
        .send({ content: "new body", expectedRevision: -1 });

      expect(res.status).toBe(400);
      expect(service.saveDraft).not.toHaveBeenCalled();
    });

    it("超长正文返回 400", async () => {
      const res = await http()
        .patch(`/analytics/prompts/${KEY}/draft`)
        .send({
          content: "x".repeat(PROMPT_CONTENT_MAX_CHARS + 1),
          expectedRevision: 0,
        });

      expect(res.status).toBe(400);
      expect(service.saveDraft).not.toHaveBeenCalled();
    });

    it("白名单外字段返回 400（forbidNonWhitelisted）", async () => {
      const res = await http()
        .patch(`/analytics/prompts/${KEY}/draft`)
        .send({ content: "new body", expectedRevision: 0, revision: 9 });

      expect(res.status).toBe(400);
      expect(service.saveDraft).not.toHaveBeenCalled();
    });

    it("并发编辑冲突的 409 原样透传", async () => {
      service.saveDraft.mockRejectedValue(
        new ConflictException("Draft was modified by someone else"),
      );

      const res = await http()
        .patch(`/analytics/prompts/${KEY}/draft`)
        .send({ content: "new body", expectedRevision: 0 });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe(409);
    });
  });

  describe("POST :key/publish", () => {
    beforeEach(async () => {
      await bootstrap();
    });

    it("成功发布，author 取自 req.user", async () => {
      service.publish.mockResolvedValue({
        ...DETAIL,
        publishedRevision: 1,
        source: "db",
      });

      const res = await http().post(`/analytics/prompts/${KEY}/publish`).send({
        revision: 1,
        changeNote: "收紧判定口径",
        confirmCode: DEFAULT_PUBLISH_CONFIRM_CODE,
      });

      expect(res.status).toBe(200);
      expect(res.body.data.publishedRevision).toBe(1);
      expect(service.publish).toHaveBeenCalledWith(
        KEY,
        {
          revision: 1,
          changeNote: "收紧判定口径",
          confirmCode: DEFAULT_PUBLISH_CONFIRM_CODE,
        },
        AUTHOR,
      );
    });

    it("缺 confirmCode 返回 400 且不打到 service", async () => {
      const res = await http()
        .post(`/analytics/prompts/${KEY}/publish`)
        .send({ revision: 1, changeNote: "收紧判定口径" });

      expect(res.status).toBe(400);
      expect(service.publish).not.toHaveBeenCalled();
    });

    it("confirmCode 为空串返回 400 且不打到 service", async () => {
      const res = await http()
        .post(`/analytics/prompts/${KEY}/publish`)
        .send({ revision: 1, changeNote: "x", confirmCode: "" });

      expect(res.status).toBe(400);
      expect(service.publish).not.toHaveBeenCalled();
    });

    it("缺 changeNote 返回 400（审计链不允许空说明）", async () => {
      const res = await http()
        .post(`/analytics/prompts/${KEY}/publish`)
        .send({ revision: 1, confirmCode: DEFAULT_PUBLISH_CONFIRM_CODE });

      expect(res.status).toBe(400);
      expect(service.publish).not.toHaveBeenCalled();
    });

    it("revision 为 0 返回 400", async () => {
      const res = await http()
        .post(`/analytics/prompts/${KEY}/publish`)
        .send({ revision: 0, changeNote: "x", confirmCode: "DEDA2025" });

      expect(res.status).toBe(400);
      expect(service.publish).not.toHaveBeenCalled();
    });

    it("确认码错误由 service 判 403 并原样透传", async () => {
      service.publish.mockRejectedValue(
        new ForbiddenException("Wrong confirm code"),
      );

      const res = await http()
        .post(`/analytics/prompts/${KEY}/publish`)
        .send({ revision: 1, changeNote: "x", confirmCode: "WRONG" });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe(403);
    });

    it("写开关关闭时 service 的 403 原样透传", async () => {
      service.publish.mockRejectedValue(
        new ForbiddenException("Prompt write is disabled"),
      );

      const res = await http().post(`/analytics/prompts/${KEY}/publish`).send({
        revision: 1,
        changeNote: "x",
        confirmCode: DEFAULT_PUBLISH_CONFIRM_CODE,
      });

      expect(res.status).toBe(403);
    });
  });

  describe("POST :key/rollback", () => {
    beforeEach(async () => {
      await bootstrap();
    });

    it("成功回滚，author 取自 req.user", async () => {
      service.rollback.mockResolvedValue({
        ...DETAIL,
        publishedRevision: 3,
        source: "db",
      });

      const res = await http().post(`/analytics/prompts/${KEY}/rollback`).send({
        targetRevision: 1,
        changeNote: "回滚到 v1",
        confirmCode: DEFAULT_PUBLISH_CONFIRM_CODE,
      });

      expect(res.status).toBe(200);
      expect(res.body.data.publishedRevision).toBe(3);
      expect(service.rollback).toHaveBeenCalledWith(
        KEY,
        {
          targetRevision: 1,
          changeNote: "回滚到 v1",
          confirmCode: DEFAULT_PUBLISH_CONFIRM_CODE,
        },
        AUTHOR,
      );
    });

    it("targetRevision 为 0 返回 400", async () => {
      const res = await http()
        .post(`/analytics/prompts/${KEY}/rollback`)
        .send({ targetRevision: 0, changeNote: "x", confirmCode: "DEDA2025" });

      expect(res.status).toBe(400);
      expect(service.rollback).not.toHaveBeenCalled();
    });

    it("缺 confirmCode 返回 400", async () => {
      const res = await http()
        .post(`/analytics/prompts/${KEY}/rollback`)
        .send({ targetRevision: 1, changeNote: "x" });

      expect(res.status).toBe(400);
      expect(service.rollback).not.toHaveBeenCalled();
    });
  });

  describe("POST :key/reset-to-default", () => {
    beforeEach(async () => {
      await bootstrap();
    });

    it("成功恢复默认值，author 取自 req.user", async () => {
      service.resetToDefault.mockResolvedValue({
        ...DETAIL,
        publishedRevision: 4,
        source: "db",
        deviatesFromDefault: false,
      });

      const res = await http()
        .post(`/analytics/prompts/${KEY}/reset-to-default`)
        .send({
          changeNote: "恢复到代码默认值",
          confirmCode: DEFAULT_PUBLISH_CONFIRM_CODE,
        });

      expect(res.status).toBe(200);
      expect(service.resetToDefault).toHaveBeenCalledWith(
        KEY,
        {
          changeNote: "恢复到代码默认值",
          confirmCode: DEFAULT_PUBLISH_CONFIRM_CODE,
        },
        AUTHOR,
      );
    });

    it("缺 changeNote 返回 400", async () => {
      const res = await http()
        .post(`/analytics/prompts/${KEY}/reset-to-default`)
        .send({ confirmCode: DEFAULT_PUBLISH_CONFIRM_CODE });

      expect(res.status).toBe(400);
      expect(service.resetToDefault).not.toHaveBeenCalled();
    });

    it("缺 confirmCode 返回 400", async () => {
      const res = await http()
        .post(`/analytics/prompts/${KEY}/reset-to-default`)
        .send({ changeNote: "x" });

      expect(res.status).toBe(400);
      expect(service.resetToDefault).not.toHaveBeenCalled();
    });
  });

  describe("GET /analytics/meta", () => {
    it("返回 nodeEnv 与 prompt 写策略", async () => {
      await bootstrap("staging");

      const res = await http().get("/analytics/meta");

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        code: 0,
        message: "success",
        data: {
          nodeEnv: "staging",
          promptWriteEnabled: true,
          publishConfirmCode: DEFAULT_PUBLISH_CONFIRM_CODE,
        },
      });
      expect(service.getWritePolicy).toHaveBeenCalledTimes(1);
    });

    it("生产环境标识原样下发（前端据此加最重的一档确认）", async () => {
      await bootstrap("production");

      const res = await http().get("/analytics/meta");

      expect(res.body.data.nodeEnv).toBe("production");
    });

    it("NODE_ENV 缺失时回落 development，不返回空串", async () => {
      await bootstrap(null);

      const res = await http().get("/analytics/meta");

      expect(res.body.data.nodeEnv).toBe("development");
    });
  });
});
