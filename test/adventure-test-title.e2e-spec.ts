import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import { randomUUID } from "crypto";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/common/prisma/prisma.service";
import { AdventureService } from "../src/modules/adventure/adventure.service";

/**
 * 样机试播标题解析 e2e：真实 Prisma（TEST_DATABASE_URL 隔离库）+ 内存 Redis。
 *
 * 为什么要用真库：resolveTestTitleByVoice 里的 findMany 曾写过多字段单对象
 * orderBy（Prisma 校验错误），单测与 HTTP e2e 都 mock 了 Prisma，全绿却没拦住。
 * 这里走真实 Prisma，任何 orderBy / where / select 校验错误都会当场抛出。
 */
describe("Adventure device-test title resolution (e2e, real Prisma)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adventure: AdventureService;

  const suffix = randomUUID().slice(0, 8);
  const deviceId = `tt-${suffix}`;
  let deviceInternalId: string;
  let episodeId: string;

  beforeAll(async () => {
    process.env.REDIS_URL = "";
    process.env.ADVENTURE_TEST_MODE_ENABLED = "true";

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = moduleFixture.get(PrismaService);
    adventure = moduleFixture.get(AdventureService);

    const device = await prisma.device.create({
      data: { deviceId, characterKey: "elly" },
    });
    deviceInternalId = device.id;

    const episode = await prisma.adventureEpisode.create({
      data: {
        characterKey: "elly",
        season: 1,
        episodeNumber: 3,
        title: "Elly与三个巨人",
        published: true,
        recap: "前情回顾：Elly 住在听风原野。",
      },
    });
    episodeId = episode.id;

    await prisma.adventureSegment.createMany({
      data: [
        {
          episodeId,
          order: 0,
          kind: "narration",
          text: "今天 Elly 要去找银色铃铛。",
        },
        {
          episodeId,
          order: 1,
          kind: "narration",
          text: "森林里住着三个巨人。",
        },
      ],
    });
  });

  afterAll(async () => {
    await prisma.device.deleteMany({ where: { id: deviceInternalId } });
    await prisma.adventureEpisode.deleteMany({ where: { id: episodeId } });
    await app.close();
    delete process.env.ADVENTURE_TEST_MODE_ENABLED;
  });

  it("resolves the episode and plays it despite a trailing period in the title", async () => {
    const reply = await adventure.startByTitle(
      deviceInternalId,
      "艾丽与三个巨人。",
    );

    expect(reply).not.toBeNull();
    expect(reply?.action).toBe("completed");
    expect(reply?.texts).toEqual([
      "前情回顾：Elly 住在听风原野。",
      "今天 Elly 要去找银色铃铛。",
      "森林里住着三个巨人。",
    ]);
  });

  it("resolves the episode by its number shortcut", async () => {
    const reply = await adventure.startByTitle(deviceInternalId, "第3集");

    expect(reply).not.toBeNull();
    expect(reply?.action).toBe("completed");
  });

  it("resolves the episode when the spoken text is a substring of the title", async () => {
    const reply = await adventure.startByTitle(deviceInternalId, "三个巨人");

    expect(reply).not.toBeNull();
    expect(reply?.action).toBe("completed");
    expect(reply?.texts).toEqual([
      "前情回顾：Elly 住在听风原野。",
      "今天 Elly 要去找银色铃铛。",
      "森林里住着三个巨人。",
    ]);
  });
});
