import { VoiceTimbreAdminController } from "./voice-timbre-admin.controller";
import { VoiceTimbreAdminService } from "./voice-timbre-admin.service";

describe("VoiceTimbreAdminController", () => {
  let controller: VoiceTimbreAdminController;
  let service: {
    list: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    remove: jest.Mock;
  };

  beforeEach(() => {
    service = {
      list: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    controller = new VoiceTimbreAdminController(
      service as unknown as VoiceTimbreAdminService,
    );
  });

  it("delegates list", async () => {
    await controller.list();
    expect(service.list).toHaveBeenCalled();
  });

  it("delegates create", async () => {
    await controller.create({ characterKey: "nemo", timbreId: "1009999" });
    expect(service.create).toHaveBeenCalledWith({
      characterKey: "nemo",
      timbreId: "1009999",
    });
  });

  it("normalises the path key before updating", async () => {
    await controller.update("  Elly ", { timbreId: "1000958" });
    expect(service.update).toHaveBeenCalledWith("elly", {
      timbreId: "1000958",
    });
  });

  it("normalises the path key and only honours force=true", async () => {
    await controller.remove(" Polly ", "true");
    await controller.remove("polly", "false");

    expect(service.remove).toHaveBeenNthCalledWith(1, "polly", true);
    expect(service.remove).toHaveBeenNthCalledWith(2, "polly", false);
  });
});
