import { PromptRegistryService } from "./prompt-registry.service";

/**
 * 测试支持：构造一个「DB 恒空」的 PromptRegistryService。
 *
 * 全部 prompt 因此回落 PROMPT_DEFAULTS 代码默认值，与 prompt 聚合重构前
 * 各 service 内硬编码字面量的行为逐字节一致（由 prompt-golden.spec.ts 锁定）。
 * 既有用例无需为「admin 发布了新版本」这一维度改动。
 *
 * 需要验证已发布覆盖行为时，直接用真实 PromptRegistryService + 自定义 prisma 替身
 * （见 prompt-registry.service.spec.ts 的 makePrismaStub）。
 */
export function makePromptRegistry(): PromptRegistryService {
  return new PromptRegistryService({
    promptTemplate: { findMany: async () => [] },
    promptTemplateVersion: { findMany: async () => [] },
  } as unknown as ConstructorParameters<typeof PromptRegistryService>[0]);
}

/** 可直接放进 Test.createTestingModule({ providers: [...] }) 的 provider */
export const PROMPT_REGISTRY_PROVIDER = {
  provide: PromptRegistryService,
  useValue: makePromptRegistry(),
};
