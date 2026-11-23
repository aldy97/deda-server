import { readdirSync, readFileSync } from "fs";
import { join } from "path";

const SAFETY_DIR = join(__dirname);
const BUSINESS_MODULES = [
  "@/modules/adventure",
  "@/modules/sleep-configs",
  "@/modules/llm-adapter",
  "@/modules/vendor/vendor.service",
];

function productionFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) {
      return productionFiles(join(dir, entry.name));
    }
    if (!entry.name.endsWith(".ts") || entry.name.endsWith(".spec.ts")) {
      return [];
    }
    return [join(dir, entry.name)];
  });
}

describe("safety import 守卫（方向一）", () => {
  it("safety/ 不反向依赖任何业务模式模块", () => {
    const violations: string[] = [];
    for (const file of productionFiles(SAFETY_DIR)) {
      const source = readFileSync(file, "utf8");
      for (const forbidden of BUSINESS_MODULES) {
        if (
          source.includes(`from "${forbidden}`) ||
          source.includes(`from '${forbidden}`)
        ) {
          violations.push(`${file} → ${forbidden}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
