import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { PROMPT_CONTENT_MAX_CHARS } from "@/modules/prompt-registry/prompt-defaults";
import {
  CHANGE_NOTE_MAX_CHARS,
  PublishPromptDto,
  ResetPromptToDefaultDto,
  RollbackPromptDto,
  SavePromptDraftDto,
} from "./prompt-admin.dto";

/**
 * DTO 是接口的第一道闸：确认码/变更说明缺失必须在进 service 之前就被 400 掉，
 * 不能依赖 service 再判一次（service 只负责「码对不对」，不负责「有没有传」）。
 */
async function errorsOf<T extends object>(
  target: new () => T,
  input: Record<string, unknown>,
) {
  return validate(plainToInstance(target, input), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
}

function props(errors: Awaited<ReturnType<typeof errorsOf>>): string[] {
  return errors.map((error) => error.property);
}

describe("SavePromptDraftDto", () => {
  it("接受正文 + expectedRevision（0 表示当前无草稿）", async () => {
    await expect(
      errorsOf(SavePromptDraftDto, {
        content: "新 prompt",
        expectedRevision: 0,
      }),
    ).resolves.toHaveLength(0);
  });

  it("changeNote 可选", async () => {
    await expect(
      errorsOf(SavePromptDraftDto, {
        content: "新 prompt",
        expectedRevision: 1,
        changeNote: "调整语气",
      }),
    ).resolves.toHaveLength(0);
  });

  it("正文为空/缺失 → 校验失败（空 prompt 会把模型带偏，必须挡住）", async () => {
    await expect(
      props(
        await errorsOf(SavePromptDraftDto, {
          content: "",
          expectedRevision: 0,
        }),
      ),
    ).toContain("content");
    await expect(
      props(await errorsOf(SavePromptDraftDto, { expectedRevision: 0 })),
    ).toContain("content");
  });

  it("正文超过上限 → 校验失败", async () => {
    const tooLong = "a".repeat(PROMPT_CONTENT_MAX_CHARS + 1);
    await expect(
      props(
        await errorsOf(SavePromptDraftDto, {
          content: tooLong,
          expectedRevision: 0,
        }),
      ),
    ).toContain("content");
  });

  it.each([-1, 1.5, "x", null])("expectedRevision=%p 非法", async (value) => {
    await expect(
      props(
        await errorsOf(SavePromptDraftDto, {
          content: "x",
          expectedRevision: value,
        }),
      ),
    ).toContain("expectedRevision");
  });

  it("expectedRevision 缺失 → 校验失败（缺了就等于放弃乐观锁，不允许）", async () => {
    await expect(
      props(await errorsOf(SavePromptDraftDto, { content: "x" })),
    ).toContain("expectedRevision");
  });

  it("changeNote 过长 → 校验失败", async () => {
    await expect(
      props(
        await errorsOf(SavePromptDraftDto, {
          content: "x",
          expectedRevision: 0,
          changeNote: "n".repeat(CHANGE_NOTE_MAX_CHARS + 1),
        }),
      ),
    ).toContain("changeNote");
  });
});

describe("PublishPromptDto", () => {
  const valid = {
    revision: 3,
    changeNote: "上线新人设",
    confirmCode: "DEDA2025",
  };

  it("三要素齐全时通过", async () => {
    await expect(errorsOf(PublishPromptDto, valid)).resolves.toHaveLength(0);
  });

  it.each([
    ["confirmCode 缺失", { revision: 3, changeNote: "x" }],
    ["confirmCode 为空串", { ...valid, confirmCode: "" }],
    ["changeNote 缺失", { revision: 3, confirmCode: "DEDA2025" }],
    ["changeNote 为空串", { ...valid, changeNote: "" }],
    ["revision 缺失", { changeNote: "x", confirmCode: "DEDA2025" }],
    ["revision 为 0", { ...valid, revision: 0 }],
  ])("%s → 400", async (_label, input) => {
    await expect(errorsOf(PublishPromptDto, input)).resolves.not.toHaveLength(
      0,
    );
  });
});

describe("RollbackPromptDto", () => {
  const valid = {
    targetRevision: 1,
    changeNote: "新版出问题",
    confirmCode: "DEDA2025",
  };

  it("三要素齐全时通过", async () => {
    await expect(errorsOf(RollbackPromptDto, valid)).resolves.toHaveLength(0);
  });

  it.each([
    ["confirmCode 缺失", { targetRevision: 1, changeNote: "x" }],
    ["changeNote 为空串", { ...valid, changeNote: "" }],
    ["targetRevision 为 0", { ...valid, targetRevision: 0 }],
  ])("%s → 400", async (_label, input) => {
    await expect(errorsOf(RollbackPromptDto, input)).resolves.not.toHaveLength(
      0,
    );
  });
});

describe("ResetPromptToDefaultDto", () => {
  it("changeNote + confirmCode 齐全时通过", async () => {
    await expect(
      errorsOf(ResetPromptToDefaultDto, {
        changeNote: "改坏了先回默认",
        confirmCode: "DEDA2025",
      }),
    ).resolves.toHaveLength(0);
  });

  it.each([
    ["confirmCode 缺失", { changeNote: "x" }],
    ["changeNote 缺失", { confirmCode: "DEDA2025" }],
  ])("%s → 400", async (_label, input) => {
    await expect(
      errorsOf(ResetPromptToDefaultDto, input),
    ).resolves.not.toHaveLength(0);
  });
});
