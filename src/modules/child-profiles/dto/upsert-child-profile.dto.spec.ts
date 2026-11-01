import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { UpsertChildProfileDto } from "./upsert-child-profile.dto";

describe("UpsertChildProfileDto", () => {
  function validateInput(input: Record<string, unknown>) {
    return validate(plainToInstance(UpsertChildProfileDto, input));
  }

  it.each([undefined, null, "male", "female"])(
    "should accept gender=%s",
    async (gender) => {
      const errors = await validateInput({ name: "Alice", gender });
      expect(errors).toHaveLength(0);
    },
  );

  it("should accept legacy payloads without gender", async () => {
    const errors = await validateInput({ name: "Alice" });
    expect(errors).toHaveLength(0);
  });

  it.each(["", "unknown", "MALE", 1, true])(
    "should reject invalid gender=%s",
    async (gender) => {
      const errors = await validateInput({ gender });
      expect(errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ property: "gender" }),
        ]),
      );
    },
  );
});
