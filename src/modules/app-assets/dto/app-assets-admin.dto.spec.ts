import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import {
  CreateAppAssetSlotDto,
  UpdateAppAssetSlotDto,
  UploadAppAssetDto,
} from "./app-assets-admin.dto";

/**
 * DTO 转换与校验口径：这些 @Transform 是线上唯一入口，
 * 单测直接走 class-transformer / class-validator，避免只靠 e2e 覆盖。
 */
describe("app-assets admin DTO", () => {
  it("CreateAppAssetSlotDto trim 字段并把空备注转 null", async () => {
    const dto = plainToInstance(CreateAppAssetSlotDto, {
      page: " device-home ",
      suffix: " hero ",
      label: " 首页主视觉 ",
      note: "   ",
    });

    expect(dto).toMatchObject({
      page: "device-home",
      suffix: "hero",
      label: "首页主视觉",
      note: null,
    });
    await expect(validate(dto)).resolves.toHaveLength(0);
  });

  it("CreateAppAssetSlotDto 拒绝非法 page / suffix / 空标签", async () => {
    const dto = plainToInstance(CreateAppAssetSlotDto, {
      page: "Device",
      suffix: "hero/",
      label: "",
    });

    const errors = await validate(dto);
    expect(errors.map((error) => error.property).sort()).toEqual([
      "label",
      "page",
      "suffix",
    ]);
  });

  it("UpdateAppAssetSlotDto trim key、空备注转 null、保留 enabled", async () => {
    const dto = plainToInstance(UpdateAppAssetSlotDto, {
      key: " device-home/hero ",
      note: "  ",
      enabled: false,
    });

    expect(dto).toMatchObject({
      key: "device-home/hero",
      note: null,
      enabled: false,
    });
    await expect(validate(dto)).resolves.toHaveLength(0);
  });

  it("UpdateAppAssetSlotDto 拒绝非法 key", async () => {
    const dto = plainToInstance(UpdateAppAssetSlotDto, { key: "Device/hero" });

    await expect(validate(dto)).resolves.toHaveLength(1);
  });

  it("UploadAppAssetDto note 空串转 undefined，宽高转 number", async () => {
    const dto = plainToInstance(UploadAppAssetDto, {
      key: " diagnostics/remote-probe ",
      width: "512",
      height: "256",
      note: "",
    });

    expect(dto).toMatchObject({
      key: "diagnostics/remote-probe",
      width: 512,
      height: 256,
    });
    expect(dto.note).toBeUndefined();
    await expect(validate(dto)).resolves.toHaveLength(0);
  });

  it("UploadAppAssetDto 无 note 时保持 undefined", () => {
    const dto = plainToInstance(UploadAppAssetDto, {
      key: "diagnostics/remote-probe",
      width: 1,
      height: 1,
    });

    expect(dto.note).toBeUndefined();
  });

  it("UploadAppAssetDto trim 非空备注", () => {
    const dto = plainToInstance(UploadAppAssetDto, {
      key: "diagnostics/remote-probe",
      width: 1,
      height: 1,
      note: "  探针占位图  ",
    });

    expect(dto.note).toBe("探针占位图");
  });
});
