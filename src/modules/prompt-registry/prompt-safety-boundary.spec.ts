import {
  ADVENTURE_SAFETY_CAUTION,
  ADVENTURE_UNSAFE_LINE,
} from "../adventure/adventure.constants";
import { PROMPT_DEFAULTS } from "./prompt-defaults";

/**
 * 儿童安全话术的边界契约。
 *
 * 安全判定与自然生成分离后：
 * - 固定安全话术是代码常量，由 AdventureService 直接返回，不再交给模型生成；
 * - 任何 prompt 默认值都不得包含这句话，避免模型在普通跑题时误用；
 * - L2 不可用时的谨慎指令必须写清“不适宜内容”的边界，并明确孩子对角色
 *   行为的道德评价（如“你不应该偷拿别人的东西”）不算不适宜内容。
 */
const CANNED_SAFETY_LINE = "我们先回到故事里，好吗？";

describe("儿童不适宜内容话术的边界契约", () => {
  it("固定安全话术是代码常量，不再出现在任何 prompt 默认值里", () => {
    expect(ADVENTURE_UNSAFE_LINE).toBe(CANNED_SAFETY_LINE);
    const promptsWithCannedLine = Object.values(PROMPT_DEFAULTS).filter(
      (prompt) => prompt.template.includes(CANNED_SAFETY_LINE),
    );
    expect(promptsWithCannedLine.map((prompt) => prompt.key)).toEqual([]);
  });

  it("L2 不可用时的谨慎指令定义了边界与道德评价例外", () => {
    expect(ADVENTURE_SAFETY_CAUTION).toContain(CANNED_SAFETY_LINE);
    expect(ADVENTURE_SAFETY_CAUTION).toContain("不属于不适宜内容");
    expect(ADVENTURE_SAFETY_CAUTION).toMatch(/道德(评价|判断)/);
    for (const category of ["性", "暴力", "自伤", "辱骂"]) {
      expect(ADVENTURE_SAFETY_CAUTION).toContain(category);
    }
  });

  it("接话层与二选一 prompt 不再承担安全判定", () => {
    expect(PROMPT_DEFAULTS.adventure_interaction_system.template).not.toContain(
      "不适宜内容",
    );
    expect(
      PROMPT_DEFAULTS.adventure_choice_match_system.template,
    ).not.toContain("不适宜内容");
  });

  it("二选一 prompt 仍保留按道德判断推断相反选项的判定要领", () => {
    const template = PROMPT_DEFAULTS.adventure_choice_match_system.template;
    expect(template).toContain("道德判断");
    expect(template).toMatch(/相反选项/);
  });
});
