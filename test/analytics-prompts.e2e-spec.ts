import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import * as dotenv from "dotenv";
import * as request from "supertest";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/common/prisma/prisma.service";
import { ResponseInterceptor } from "../src/common/interceptors/response.interceptor";
import { HttpExceptionFilter } from "../src/common/filters/http-exception.filter";
import { PROMPT_DEFAULTS } from "../src/modules/prompt-registry/prompt-defaults";
import { PROMPT_KEYS } from "../src/modules/prompt-registry/prompt-keys";
import { PromptRegistryService } from "../src/modules/prompt-registry/prompt-registry.service";
import { renderPrompt } from "../src/modules/prompt-registry/prompt-render.util";

dotenv.config();

const ANALYTICS_SECRET =
  process.env.ANALYTICS_JWT_SECRET || "dev-analytics-jwt-secret";

/** 无变量的人设 key：跑完整生命周期 */
const KEY = "persona_polly";
/** 带可选变量的 key：验证「DB 正文 + 代码变量契约」协同 */
const VAR_KEY = "filler_system";
const WRONG_CODE = "DEFINITELY-NOT-THE-CODE";

/**
 * Prompt 后台管理 e2e：真实 AppModule + 真实 DB（TEST_DATABASE_URL 隔离库）+ 真实鉴权。
 *
 * 单测层用的是内存 prisma 替身，这里补的是**唯一无法在单测证明的那一段**：
 * HTTP → ValidationPipe → AnalyticsAuthGuard → PromptAdminService → Prisma → Postgres，
 * 以及发布后容器内 PromptRegistryService 是否真的立刻读到新正文。
 *
 * key 是固定枚举、无法按用例隔离，故 beforeAll/afterAll 各清一次，保证可重复运行。
 */
describe("Analytics prompts (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let registry: PromptRegistryService;
  let adminToken: string;
  let wechatScopeToken: string;
  let confirmCode: string;

  async function purge(key: string): Promise<void> {
    // versions 靠 onDelete: Cascade 一并删除
    await prisma.promptTemplate.deleteMany({ where: { key } });
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
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

    prisma = moduleFixture.get(PrismaService);
    registry = moduleFixture.get(PromptRegistryService);

    const jwt = new JwtService({ secret: ANALYTICS_SECRET });
    adminToken = await jwt.signAsync({
      sub: "admin",
      username: "admin",
      displayName: "管理员",
      scope: "analytics",
    });
    wechatScopeToken = await jwt.signAsync({
      sub: "user-001",
      username: "user-001",
      scope: "wechat",
    });

    await purge(KEY);
    await purge(VAR_KEY);

    // 确认码从已鉴权的 meta 接口取，不在测试里硬编码：ops 改了 env 也不会假绿
    const meta = await request(app.getHttpServer())
      .get("/analytics/meta")
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);
    confirmCode = meta.body.data.publishConfirmCode;
  });

  afterAll(async () => {
    await purge(KEY);
    await purge(VAR_KEY);
    await app.close();
  });

  const auth = (req: request.Test) =>
    req.set("Authorization", `Bearer ${adminToken}`);

  describe("鉴权", () => {
    it("无 token → 401", async () => {
      await request(app.getHttpServer()).get("/analytics/prompts").expect(401);
    });

    // 注意是 401 不是 403：AnalyticsJwtStrategy.validate 先按 scope 拒掉，
    // 守卫 handleRequest 里的 403 分支在真实 HTTP 链路上不可达
    //（单测 analytics-auth.controller.spec.ts 是直接调 handleRequest 才覆盖到）。
    it("token 非 analytics scope → 401，且不会读到任何 prompt", async () => {
      const res = await request(app.getHttpServer())
        .get("/analytics/prompts")
        .set("Authorization", `Bearer ${wechatScopeToken}`)
        .expect(401);
      expect(res.body.data).toBeNull();
    });

    it("发布接口同样受鉴权保护 → 401，写操作不会发生", async () => {
      await request(app.getHttpServer())
        .post(`/analytics/prompts/${KEY}/publish`)
        .set("Authorization", `Bearer ${wechatScopeToken}`)
        .send({ revision: 1, changeNote: "x", confirmCode })
        .expect(401);

      const detail = await auth(
        request(app.getHttpServer()).get(`/analytics/prompts/${KEY}`),
      ).expect(200);
      expect(detail.body.data.publishedRevision).toBeNull();
    });
  });

  describe("meta", () => {
    it("返回环境标识与写策略，确认码非空", async () => {
      const res = await auth(
        request(app.getHttpServer()).get("/analytics/meta"),
      ).expect(200);

      expect(res.body.code).toBe(0);
      expect(typeof res.body.data.nodeEnv).toBe("string");
      expect(res.body.data.nodeEnv.length).toBeGreaterThan(0);
      expect(res.body.data.promptWriteEnabled).toBe(true);
      expect(res.body.data.publishConfirmCode.length).toBeGreaterThan(0);
    });
  });

  describe("读取", () => {
    it("catalog 恒返回全部 key，未编辑时一律 source=default 且未偏离", async () => {
      const res = await auth(
        request(app.getHttpServer()).get("/analytics/prompts"),
      ).expect(200);

      const items = res.body.data;
      expect(items).toHaveLength(PROMPT_KEYS.length);
      expect(items.map((i: { key: string }) => i.key).sort()).toEqual(
        [...PROMPT_KEYS].sort(),
      );
      for (const item of items) {
        expect(item.source).toBe("default");
        expect(item.deviatesFromDefault).toBe(false);
        expect(item.effectiveContent).toBe(
          PROMPT_DEFAULTS[item.key as keyof typeof PROMPT_DEFAULTS].template,
        );
      }
    });

    it("未知 key → 404（而不是静默返回默认值）", async () => {
      await auth(
        request(app.getHttpServer()).get("/analytics/prompts/not_a_real_key"),
      ).expect(404);
    });
  });

  describe("生命周期：草稿 → 发布 → 回滚 → 恢复默认", () => {
    it("保存草稿不影响线上生效值", async () => {
      const res = await auth(
        request(app.getHttpServer()).patch(`/analytics/prompts/${KEY}/draft`),
      )
        .send({
          content: "草稿正文 v1",
          expectedRevision: 0,
          changeNote: "试写",
        })
        .expect(200);

      expect(res.body.data.draftRevision).toBe(1);
      expect(res.body.data.draftContent).toBe("草稿正文 v1");
      expect(res.body.data.publishedRevision).toBeNull();
      expect(res.body.data.source).toBe("default");
      expect(res.body.data.effectiveContent).toBe(
        PROMPT_DEFAULTS.persona_polly.template,
      );
      // 容器内的注册表读到的仍是代码默认值
      expect(registry.getTemplate(KEY)).toBe(
        PROMPT_DEFAULTS.persona_polly.template,
      );
    });

    it("expectedRevision 过期 → 409（乐观锁）", async () => {
      await auth(
        request(app.getHttpServer()).patch(`/analytics/prompts/${KEY}/draft`),
      )
        .send({ content: "别人的改动", expectedRevision: 0 })
        .expect(409);
    });

    it("缺确认码 → 400；确认码错误 → 403，发布均未生效", async () => {
      await auth(
        request(app.getHttpServer()).post(`/analytics/prompts/${KEY}/publish`),
      )
        .send({ revision: 1, changeNote: "上线" })
        .expect(400);

      await auth(
        request(app.getHttpServer()).post(`/analytics/prompts/${KEY}/publish`),
      )
        .send({ revision: 1, changeNote: "上线", confirmCode: WRONG_CODE })
        .expect(403);

      const detail = await auth(
        request(app.getHttpServer()).get(`/analytics/prompts/${KEY}`),
      ).expect(200);
      expect(detail.body.data.publishedRevision).toBeNull();
      expect(detail.body.data.source).toBe("default");
    });

    it("发布成功后：source=db，且容器内注册表立刻读到新正文", async () => {
      const res = await auth(
        request(app.getHttpServer()).post(`/analytics/prompts/${KEY}/publish`),
      )
        .send({ revision: 1, changeNote: "正式上线", confirmCode })
        .expect(200);

      expect(res.body.data.publishedRevision).toBe(1);
      expect(res.body.data.draftRevision).toBeNull();
      expect(res.body.data.source).toBe("db");
      expect(res.body.data.effectiveContent).toBe("草稿正文 v1");
      expect(res.body.data.deviatesFromDefault).toBe(true);
      expect(res.body.data.publishedBy).toBe("admin");

      // 关键断言：发布路径 await 了注册表原子换入，无需等 TTL
      expect(registry.getTemplate(KEY)).toBe("草稿正文 v1");
    });

    it("版本历史留下 author 与 changeNote（审计链）", async () => {
      const res = await auth(
        request(app.getHttpServer()).get(`/analytics/prompts/${KEY}/versions`),
      ).expect(200);

      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0]).toMatchObject({
        revision: 1,
        content: "草稿正文 v1",
        changeNote: "正式上线",
        authorUsername: "admin",
        isPublished: true,
        isDraft: false,
      });
      expect(res.body.data[0].publishedAt).not.toBeNull();
    });

    it("回滚 = 以目标版本正文新建 revision 并发布（历史不改写）", async () => {
      // 先做出 r2 并发布，制造一个「需要回滚」的现状
      await auth(
        request(app.getHttpServer()).patch(`/analytics/prompts/${KEY}/draft`),
      )
        .send({ content: "有问题的新版 v2", expectedRevision: 0 })
        .expect(200);
      await auth(
        request(app.getHttpServer()).post(`/analytics/prompts/${KEY}/publish`),
      )
        .send({ revision: 2, changeNote: "上线 v2", confirmCode })
        .expect(200);
      expect(registry.getTemplate(KEY)).toBe("有问题的新版 v2");

      const res = await auth(
        request(app.getHttpServer()).post(`/analytics/prompts/${KEY}/rollback`),
      )
        .send({ targetRevision: 1, changeNote: "v2 有问题，回滚", confirmCode })
        .expect(200);

      // 新建 r3 而不是把指针拨回 r1：版本号单调递增
      expect(res.body.data.publishedRevision).toBe(3);
      expect(res.body.data.effectiveContent).toBe("草稿正文 v1");
      expect(registry.getTemplate(KEY)).toBe("草稿正文 v1");

      const versions = await auth(
        request(app.getHttpServer()).get(`/analytics/prompts/${KEY}/versions`),
      ).expect(200);
      expect(
        versions.body.data.map((v: { revision: number }) => v.revision),
      ).toEqual([3, 2, 1]);
      // r1 / r2 的正文与发布说明都没被回滚改写
      expect(versions.body.data[2]).toMatchObject({
        revision: 1,
        content: "草稿正文 v1",
        changeNote: "正式上线",
      });
      expect(versions.body.data[1]).toMatchObject({
        revision: 2,
        content: "有问题的新版 v2",
        changeNote: "上线 v2",
      });
    });

    it("回滚目标不存在 → 404", async () => {
      await auth(
        request(app.getHttpServer()).post(`/analytics/prompts/${KEY}/rollback`),
      )
        .send({ targetRevision: 99, changeNote: "x", confirmCode })
        .expect(404);
    });

    it("恢复代码默认值 = 新建 revision，偏离标记归零", async () => {
      const res = await auth(
        request(app.getHttpServer()).post(
          `/analytics/prompts/${KEY}/reset-to-default`,
        ),
      )
        .send({ changeNote: "全部回默认", confirmCode })
        .expect(200);

      expect(res.body.data.publishedRevision).toBe(4);
      expect(res.body.data.effectiveContent).toBe(
        PROMPT_DEFAULTS.persona_polly.template,
      );
      expect(res.body.data.deviatesFromDefault).toBe(false);
      expect(registry.getTemplate(KEY)).toBe(
        PROMPT_DEFAULTS.persona_polly.template,
      );

      // 模板行仍在（禁止删行）：catalog 里这个 key 依旧带发布历史
      const versions = await auth(
        request(app.getHttpServer()).get(`/analytics/prompts/${KEY}/versions`),
      ).expect(200);
      expect(versions.body.data).toHaveLength(4);
    });
  });

  describe("变量契约", () => {
    it("DB 正文里的占位符仍按代码契约渲染", async () => {
      await auth(
        request(app.getHttpServer()).patch(
          `/analytics/prompts/${VAR_KEY}/draft`,
        ),
      )
        .send({
          content: "承接段：{{contextSection}}／禁播段：{{bannedSection}}",
          expectedRevision: 0,
        })
        .expect(200);
      await auth(
        request(app.getHttpServer()).post(
          `/analytics/prompts/${VAR_KEY}/publish`,
        ),
      )
        .send({ revision: 1, changeNote: "验证变量渲染", confirmCode })
        .expect(200);

      expect(
        registry.render(VAR_KEY, {
          contextSection: "CTX-A",
          bannedSection: "BAN-B",
        }),
      ).toBe("承接段：CTX-A／禁播段：BAN-B");

      // 可选变量缺省 → 渲染为空串，不报错
      expect(registry.render(VAR_KEY, {})).toBe("承接段：／禁播段：");
    });

    it("DB 正文写了未声明的占位符 → 回落代码默认值，绝不把 {{x}} 发给模型", async () => {
      await auth(
        request(app.getHttpServer()).patch(
          `/analytics/prompts/${VAR_KEY}/draft`,
        ),
      )
        .send({
          content: "危险正文 {{notDeclaredVar}}",
          expectedRevision: 0,
        })
        .expect(200);
      await auth(
        request(app.getHttpServer()).post(
          `/analytics/prompts/${VAR_KEY}/publish`,
        ),
      )
        .send({ revision: 2, changeNote: "误写未声明变量", confirmCode })
        .expect(200);

      const rendered = registry.render(VAR_KEY, {});
      // 不变量：既不漏 {{x}} 给模型，也不用那份坏掉的 DB 正文
      expect(rendered).not.toContain("{{");
      expect(rendered).not.toContain("notDeclaredVar");
      expect(rendered).not.toContain("危险正文");
      // 回落结果 = 代码默认模板按可选变量渲染（占位符→空串）
      expect(rendered).toBe(
        renderPrompt(
          PROMPT_DEFAULTS.filler_system.template,
          {},
          PROMPT_DEFAULTS.filler_system.variables,
        ),
      );
    });
  });
});
