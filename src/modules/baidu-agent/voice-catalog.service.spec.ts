import { Test, TestingModule } from "@nestjs/testing";
import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { VoiceCatalogService } from "./voice-catalog.service";

describe("VoiceCatalogService", () => {
  let service: VoiceCatalogService;
  let configValues: Record<string, string | undefined>;

  const createService = async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VoiceCatalogService,
        {
          provide: ConfigService,
          useValue: { get: (key: string) => configValues[key] },
        },
      ],
    }).compile();
    return module.get(VoiceCatalogService);
  };

  const validEntry = {
    timbreId: "1000063",
    name: "度小熊",
    status: "TRAINED",
    language: "chinese",
  };

  const untrainedEntry = {
    timbreId: "1000064",
    name: "度小猫",
    status: "UNTRAINED",
    language: "chinese",
  };

  const englishEntry = {
    timbreId: "2000001",
    name: "Bella",
    status: "TRAINED",
    language: "english",
  };

  const japaneseEntry = {
    timbreId: "3000001",
    name: "さくら",
    status: "TRAINED",
    language: "japanese",
  };

  describe("when VOICE_CATALOG_JSON is not configured", () => {
    beforeEach(async () => {
      configValues = {};
      service = await createService();
    });

    it("should return empty catalog", () => {
      expect(service.listAll()).toEqual([]);
    });

    it("should report available=false", () => {
      expect(service.available).toBe(false);
    });

    it("listUsable should return empty", () => {
      expect(service.listUsable()).toEqual([]);
    });

    it("listForLang should return empty array for any lang", () => {
      expect(service.listForLang("zh")).toEqual([]);
      expect(service.listForLang(undefined)).toEqual([]);
      expect(service.listForLang("en")).toEqual([]);
    });

    it("find should return null", () => {
      expect(service.find("1000063")).toBeNull();
    });
  });

  describe("when VOICE_CATALOG_JSON is empty string", () => {
    beforeEach(async () => {
      configValues = { VOICE_CATALOG_JSON: "" };
      service = await createService();
    });

    it("should return empty catalog", () => {
      expect(service.listAll()).toEqual([]);
    });

    it("available should be false", () => {
      expect(service.available).toBe(false);
    });
  });

  describe("when VOICE_CATALOG_JSON is malformed JSON", () => {
    beforeEach(async () => {
      jest.spyOn(Logger.prototype, "warn").mockImplementation();
      configValues = { VOICE_CATALOG_JSON: "not valid json" };
      service = await createService();
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it("should return empty catalog without throwing", () => {
      expect(service.listAll()).toEqual([]);
    });

    it("should log a warning once", () => {
      expect(Logger.prototype.warn).toHaveBeenCalledTimes(1);
    });

    it("available should be false", () => {
      expect(service.available).toBe(false);
    });
  });

  describe("when VOICE_CATALOG_JSON is not an array", () => {
    beforeEach(async () => {
      jest.spyOn(Logger.prototype, "warn").mockImplementation();
      configValues = { VOICE_CATALOG_JSON: '{"timbreId":"1000063"}' };
      service = await createService();
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it("should return empty catalog", () => {
      expect(service.listAll()).toEqual([]);
    });

    it("should log a warning", () => {
      expect(Logger.prototype.warn).toHaveBeenCalledTimes(1);
    });
  });

  describe("with valid entries", () => {
    beforeEach(async () => {
      configValues = {
        VOICE_CATALOG_JSON: JSON.stringify([
          validEntry,
          untrainedEntry,
          englishEntry,
          japaneseEntry,
        ]),
      };
      service = await createService();
    });

    it("listAll should return all structurally valid entries including UNTRAINED", () => {
      const all = service.listAll();
      expect(all).toHaveLength(4);
      expect(all.map((e) => e.timbreId)).toEqual([
        "1000063",
        "1000064",
        "2000001",
        "3000001",
      ]);
    });

    it("listUsable should return only TRAINED entries", () => {
      const usable = service.listUsable();
      expect(usable).toHaveLength(3);
      expect(usable.every((e) => e.status === "TRAINED")).toBe(true);
    });

    it("available should be true when usable entries exist", () => {
      expect(service.available).toBe(true);
    });

    it("listForLang('zh') should return chinese entries", () => {
      const result = service.listForLang("zh");
      expect(result).toHaveLength(1);
      expect(result[0].timbreId).toBe("1000063");
    });

    it("listForLang('en') should return english entries", () => {
      const result = service.listForLang("en");
      expect(result).toHaveLength(1);
      expect(result[0].timbreId).toBe("2000001");
    });

    it("listForLang('ja') should return japanese entries", () => {
      const result = service.listForLang("ja");
      expect(result).toHaveLength(1);
      expect(result[0].timbreId).toBe("3000001");
    });

    it("listForLang(undefined) should return empty array (fail-closed)", () => {
      expect(service.listForLang(undefined)).toEqual([]);
    });

    it("listForLang with unknown lang should return empty array (fail-closed)", () => {
      expect(service.listForLang("fr")).toEqual([]);
    });

    it("find(timbreId) should return matching usable entry", () => {
      expect(service.find("1000063")!.timbreId).toBe("1000063");
    });

    it("find(timbreId) should return null for UNTRAINED entry", () => {
      expect(service.find("1000064")).toBeNull();
    });

    it("find(timbreId) should return null for non-existent entry", () => {
      expect(service.find("9999999")).toBeNull();
    });

    it("find(timbreId, lang) should match both id and language", () => {
      expect(service.find("2000001", "en")).not.toBeNull();
    });

    it("find(timbreId, lang) should return null when lang does not match", () => {
      expect(service.find("2000001", "zh")).toBeNull();
    });
  });

  describe("entry validation edge cases", () => {
    it("should discard entries with non-string timbreId", () => {
      configValues = {
        VOICE_CATALOG_JSON: JSON.stringify([
          {
            timbreId: 1000063,
            name: "度小熊",
            status: "TRAINED",
            language: "chinese",
          },
        ]),
      };
      service = createServiceSync(configValues);
      // timbreId as number should be accepted and converted to string
      expect(service.listAll()).toHaveLength(1);
      expect(service.listAll()[0].timbreId).toBe("1000063");
    });

    it("should discard entries with empty timbreId", () => {
      jest.spyOn(Logger.prototype, "warn").mockImplementation();
      configValues = {
        VOICE_CATALOG_JSON: JSON.stringify([
          { timbreId: "", name: "bad", status: "TRAINED", language: "chinese" },
          validEntry,
        ]),
      };
      service = createServiceSync(configValues);
      expect(service.listAll()).toHaveLength(1);
      expect(service.listAll()[0].timbreId).toBe("1000063");
      jest.restoreAllMocks();
    });

    it("should discard entries with non-string name", () => {
      configValues = {
        VOICE_CATALOG_JSON: JSON.stringify([
          { timbreId: "1", name: 123, status: "TRAINED", language: "chinese" },
          validEntry,
        ]),
      };
      service = createServiceSync(configValues);
      expect(service.listAll()).toHaveLength(1);
      expect(service.listAll()[0].timbreId).toBe("1000063");
    });

    it("should discard entries with non-string status", () => {
      configValues = {
        VOICE_CATALOG_JSON: JSON.stringify([
          { timbreId: "1", name: "x", status: null, language: "chinese" },
          validEntry,
        ]),
      };
      service = createServiceSync(configValues);
      expect(service.listAll()).toHaveLength(1);
    });

    it("should discard entries with non-string language", () => {
      configValues = {
        VOICE_CATALOG_JSON: JSON.stringify([
          { timbreId: "1", name: "x", status: "TRAINED", language: 123 },
          validEntry,
        ]),
      };
      service = createServiceSync(configValues);
      expect(service.listAll()).toHaveLength(1);
    });

    it("should discard entries missing timbreId field", () => {
      configValues = {
        VOICE_CATALOG_JSON: JSON.stringify([
          { name: "x", status: "TRAINED", language: "chinese" },
          validEntry,
        ]),
      };
      service = createServiceSync(configValues);
      expect(service.listAll()).toHaveLength(1);
    });
  });

  describe("when only UNTRAINED entries exist", () => {
    beforeEach(async () => {
      configValues = {
        VOICE_CATALOG_JSON: JSON.stringify([untrainedEntry]),
      };
      service = await createService();
    });

    it("listUsable should return empty", () => {
      expect(service.listUsable()).toEqual([]);
    });

    it("available should be false", () => {
      expect(service.available).toBe(false);
    });

    it("listAll should still return the entry", () => {
      expect(service.listAll()).toHaveLength(1);
    });
  });

  /**
   * Synchronous helper for edge-case tests that don't need async setup.
   * ConfigService is instantiated once; Logger mock is set per-test.
   */
  function createServiceSync(
    configValues: Record<string, string | undefined>,
  ): VoiceCatalogService {
    return new VoiceCatalogService({
      get: (key: string) => configValues[key],
    } as ConfigService);
  }
});
