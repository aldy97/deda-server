import "reflect-metadata";
import { ExecutionContext, ForbiddenException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import { AnalyticsAuthGuard } from "@/modules/analytics/guards/analytics-auth.guard";
import { ContentAdminGuard, ContentReadOnly } from "./content-admin.guard";
import { CONTENT_ADMIN_SCOPE } from "../content-admin-profile";

/**
 * 两道闸必须正交：账号有 scope 不等于环境允许写，环境允许写不等于账号有 scope。
 * 所以每个用例都在 authoring / readonly 两个 profile 下各跑一遍，
 * 断言「读」的行为一致、「写」的行为按 profile 分叉。
 */

const PROFILE_VALUES = ["authoring", "readonly"] as const;

class SampleController {
  list() {
    return "list";
  }

  @ContentReadOnly()
  simulate() {
    return "simulate";
  }

  publish() {
    return "publish";
  }
}

function makeContext(options: {
  method: string;
  user?: Record<string, unknown> | null;
  handler?: () => void;
}): ExecutionContext {
  const request = { method: options.method, user: options.user };
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({}),
    }),
    getHandler: () => options.handler ?? SampleController.prototype.list,
    getClass: () => SampleController,
  } as unknown as ExecutionContext;
}

function scopedUser(extra: Record<string, unknown> = {}) {
  return {
    adminId: "alice",
    username: "alice",
    displayName: "Alice",
    scope: "analytics",
    scopes: ["analytics", CONTENT_ADMIN_SCOPE],
    ...extra,
  };
}

describe("ContentAdminGuard", () => {
  let baseSpy: jest.SpyInstance;

  beforeEach(() => {
    // 顶掉 passport 那一段：单测里没有真实的 HTTP 请求与 JWT。
    // 父类的 handleRequest（scope==="analytics" 校验）由它自己的 spec 覆盖，
    // 这里只负责把 user 挂到 request 上，模拟校验通过后的状态。
    baseSpy = jest
      .spyOn(AnalyticsAuthGuard.prototype, "canActivate")
      .mockImplementation(async function (this: unknown, context) {
        const request = (context as ExecutionContext)
          .switchToHttp()
          .getRequest();
        if (!request.user) {
          throw new ForbiddenException("Analytics scope required");
        }
        return true;
      });
  });

  afterEach(() => {
    baseSpy.mockRestore();
  });

  function buildGuard(profile: string | undefined) {
    const configService = {
      get: (key: string) =>
        key === "CONTENT_ADMIN_PROFILE" ? profile : undefined,
    } as unknown as ConfigService;
    return new ContentAdminGuard(new Reflector(), configService);
  }

  describe.each(PROFILE_VALUES)("profile=%s", (profile) => {
    it("lets a scoped admin read regardless of profile", async () => {
      const guard = buildGuard(profile);

      await expect(
        guard.canActivate(makeContext({ method: "GET", user: scopedUser() })),
      ).resolves.toBe(true);
    });

    it("rejects a dashboard admin who has no adventure-content scope", async () => {
      const guard = buildGuard(profile);

      await expect(
        guard.canActivate(
          makeContext({
            method: "GET",
            user: scopedUser({ scopes: ["analytics"] }),
          }),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("rejects a token issued before scopes existed", async () => {
      const guard = buildGuard(profile);

      await expect(
        guard.canActivate(
          makeContext({
            method: "GET",
            user: { adminId: "alice", scope: "analytics" },
          }),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("rejects a malformed scopes claim instead of treating it as permissive", async () => {
      const guard = buildGuard(profile);

      await expect(
        guard.canActivate(
          makeContext({
            method: "POST",
            user: scopedUser({ scopes: CONTENT_ADMIN_SCOPE }),
          }),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("still delegates the base analytics check to the parent guard", async () => {
      const guard = buildGuard(profile);

      await expect(
        guard.canActivate(makeContext({ method: "GET", user: null })),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(baseSpy).toHaveBeenCalled();
    });
  });

  describe("write gating", () => {
    it.each(["POST", "PUT", "PATCH", "DELETE"])(
      "blocks %s in a readonly environment even for a scoped admin",
      async (method) => {
        const guard = buildGuard("readonly");

        const error = await guard
          .canActivate(
            makeContext({
              method,
              user: scopedUser(),
              handler: SampleController.prototype.publish,
            }),
          )
          .catch((e) => e);

        expect(error).toBeInstanceOf(ForbiddenException);
        expect(error.message).toContain("CONTENT_ADMIN_PROFILE");
      },
    );

    it.each(["POST", "PUT", "PATCH", "DELETE"])(
      "allows %s in an authoring environment",
      async (method) => {
        const guard = buildGuard("authoring");

        await expect(
          guard.canActivate(
            makeContext({
              method,
              user: scopedUser(),
              handler: SampleController.prototype.publish,
            }),
          ),
        ).resolves.toBe(true);
      },
    );

    it("defaults to readonly when the variable is missing or misspelled", async () => {
      for (const value of [undefined, "", "Authoring", "AUTHORING", "yes"]) {
        const guard = buildGuard(value);

        await expect(
          guard.canActivate(
            makeContext({
              method: "POST",
              user: scopedUser(),
              handler: SampleController.prototype.publish,
            }),
          ),
        ).rejects.toBeInstanceOf(ForbiddenException);
      }
    });

    it("honours @ContentReadOnly so non-mutating POSTs stay usable in prod", async () => {
      const guard = buildGuard("readonly");

      await expect(
        guard.canActivate(
          makeContext({
            method: "POST",
            user: scopedUser(),
            handler: SampleController.prototype.simulate,
          }),
        ),
      ).resolves.toBe(true);
    });

    it("does not let @ContentReadOnly leak onto a sibling route", async () => {
      const guard = buildGuard("readonly");

      await expect(
        guard.canActivate(
          makeContext({
            method: "POST",
            user: scopedUser(),
            handler: SampleController.prototype.publish,
          }),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("treats a request with no method as a write rather than waving it through", async () => {
      const guard = buildGuard("readonly");

      await expect(
        guard.canActivate(
          makeContext({
            method: "",
            user: scopedUser(),
            handler: SampleController.prototype.publish,
          }),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});
