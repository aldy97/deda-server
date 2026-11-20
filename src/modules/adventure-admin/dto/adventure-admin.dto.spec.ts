import { validate } from "class-validator";
import { DeviceTestArmDto, DeviceTestMutationDto } from "./adventure-admin.dto";

/**
 * 试播入参外壳的校验单测：只验「类型与外壳」（deviceId/title 非空），
 * 理由字数等业务规则由服务层 assertReason 负责——与 DTO 文件头部的
 * 「刻意只做类型与外壳校验」口径一致。
 */
describe("device test DTOs", () => {
  it("accepts a well-formed arm payload", async () => {
    const dto = new DeviceTestArmDto();
    dto.deviceId = "dev-1001";
    dto.title = "听风原野第一天";
    dto.reason = "测试环境验收这一集";

    await expect(validate(dto)).resolves.toEqual([]);
  });

  it("rejects an arm payload with an empty deviceId or title", async () => {
    const blankDevice = new DeviceTestArmDto();
    blankDevice.deviceId = "";
    blankDevice.title = "听风原野第一天";
    const blankTitle = new DeviceTestArmDto();
    blankTitle.deviceId = "dev-1001";
    blankTitle.title = "";

    const [deviceErrors, titleErrors] = await Promise.all([
      validate(blankDevice),
      validate(blankTitle),
    ]);
    expect(deviceErrors.length).toBeGreaterThan(0);
    expect(titleErrors.length).toBeGreaterThan(0);
  });

  it("accepts an empty mutation payload (reason is enforced by the service layer)", async () => {
    const dto = new DeviceTestMutationDto();

    await expect(validate(dto)).resolves.toEqual([]);
  });
});
