import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import {
  CreateVoiceTimbreDto,
  UpdateVoiceTimbreDto,
} from "./voice-timbre-admin.dto";

describe("voice-timbre admin DTOs", () => {
  it("normalises characterKey to trimmed lower case", () => {
    const dto = plainToInstance(CreateVoiceTimbreDto, {
      characterKey: "  NeMo ",
      timbreId: " 1009999 ",
    });

    expect(dto.characterKey).toBe("nemo");
    expect(dto.timbreId).toBe("1009999");
  });

  it("accepts a valid create payload", async () => {
    const dto = plainToInstance(CreateVoiceTimbreDto, {
      characterKey: "nemo",
      timbreId: "1009999",
    });

    await expect(validate(dto)).resolves.toHaveLength(0);
  });

  it("rejects an illegal characterKey", async () => {
    const dto = plainToInstance(CreateVoiceTimbreDto, {
      characterKey: "Ne mo!",
      timbreId: "1009999",
    });

    const errors = await validate(dto);
    expect(errors.map((e) => e.property)).toContain("characterKey");
  });

  it("rejects a non-numeric timbreId on both DTOs", async () => {
    const created = await validate(
      plainToInstance(CreateVoiceTimbreDto, {
        characterKey: "nemo",
        timbreId: "abc",
      }),
    );
    const updated = await validate(
      plainToInstance(UpdateVoiceTimbreDto, { timbreId: "1001022x" }),
    );

    expect(created.map((e) => e.property)).toContain("timbreId");
    expect(updated.map((e) => e.property)).toContain("timbreId");
  });

  it("keeps non-string values untouched so @IsString can reject them", async () => {
    const dto = plainToInstance(CreateVoiceTimbreDto, {
      characterKey: 42,
      timbreId: null,
    });

    const errors = await validate(dto);
    expect(errors.map((e) => e.property).sort()).toEqual([
      "characterKey",
      "timbreId",
    ]);
  });
});
