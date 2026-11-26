import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import {
  AddTestDeviceDto,
  ListTestDevicesQueryDto,
  RevokeTestDeviceDto,
} from "./test-device-access.dto";

/**
 * DTO 层只钉「HTTP 入参怎么被翻译成服务层可用的值」：
 * query 的 "false" 不能变成 true、空串不能当成关键词、写入字段先 trim。
 * 业务阈值（理由 8 字）在 DTO 与服务层各有一道，这里验第一道。
 */
describe("测试设备白名单 DTO", () => {
  it("query 把空串当未提供，把 'true'/'false' 翻译成布尔", async () => {
    const dto = plainToInstance(ListTestDevicesQueryDto, {
      keyword: "  CN-001  ",
      includeRevoked: "false",
      page: "2",
      pageSize: "20",
    });

    expect(dto).toMatchObject({
      keyword: "CN-001",
      includeRevoked: false,
      page: 2,
      pageSize: 20,
    });
    await expect(validate(dto)).resolves.toHaveLength(0);

    const empty = plainToInstance(ListTestDevicesQueryDto, {
      keyword: "",
      includeRevoked: "",
    });
    expect(empty.keyword).toBeUndefined();
    expect(empty.includeRevoked).toBeUndefined();
  });

  it("query 的非法布尔 / 超上限 pageSize 会被 class-validator 拒绝", async () => {
    const badBoolean = plainToInstance(ListTestDevicesQueryDto, {
      includeRevoked: "yes",
    });
    await expect(validate(badBoolean)).resolves.not.toHaveLength(0);

    const hugePage = plainToInstance(ListTestDevicesQueryDto, {
      pageSize: 201,
    });
    await expect(validate(hugePage)).resolves.not.toHaveLength(0);
  });

  it("添加 DTO trim 三个字段，并拦住不足 8 字的理由", async () => {
    const dto = plainToInstance(AddTestDeviceDto, {
      deviceId: "  CN-001  ",
      note: "  3 号样机  ",
      reason: "  需要验证新一集内容  ",
    });

    expect(dto).toMatchObject({
      deviceId: "CN-001",
      note: "3 号样机",
      reason: "需要验证新一集内容",
    });
    await expect(validate(dto)).resolves.toHaveLength(0);

    const shortReason = plainToInstance(AddTestDeviceDto, {
      deviceId: "CN-001",
      reason: "太短",
    });
    await expect(validate(shortReason)).resolves.not.toHaveLength(0);

    const emptyDevice = plainToInstance(AddTestDeviceDto, {
      deviceId: "   ",
      reason: "需要验证新一集内容",
    });
    await expect(validate(emptyDevice)).resolves.not.toHaveLength(0);
  });

  it("撤销 DTO trim 理由并拒绝空值", async () => {
    const dto = plainToInstance(RevokeTestDeviceDto, {
      reason: "  验证结束，收回资格  ",
    });
    expect(dto.reason).toBe("验证结束，收回资格");
    await expect(validate(dto)).resolves.toHaveLength(0);

    const empty = plainToInstance(RevokeTestDeviceDto, { reason: "" });
    await expect(validate(empty)).resolves.not.toHaveLength(0);
  });
});
