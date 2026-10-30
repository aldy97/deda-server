import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

/** Elly 专属首集：只写故事内容，不修改任何设备配置。 */
async function main() {
  const episode = await prisma.$transaction(async (tx) => {
    const episodeKey = {
      characterKey: "elly",
      season: 1,
      episodeNumber: 1,
    };
    const existing = await tx.adventureEpisode.findUnique({
      where: { characterKey_season_episodeNumber: episodeKey },
    });
    if (existing) {
      throw new Error(
        `Refusing to overwrite existing episode: ${existing.title} (${existing.id})`,
      );
    }

    const episode = await tx.adventureEpisode.create({
      data: {
        ...episodeKey,
        title: "Elly 与叫醒风铃树的秘密",
        recap:
          "小象 Elly 住在听风原野。它温暖又好奇，只是有时太想独自完成任务，不好意思请朋友帮忙。",
        published: true,
        segments: {
          create: [
            {
              order: 0,
              kind: "narration",
              text: "清晨，风铃树没有唱起往日的歌。Elly 悄悄背上小布包，想独自修好它，给朋友们一个大大的惊喜。",
            },
            {
              order: 1,
              kind: "interaction",
              interactionType: "two_choice",
              text: "前面有两条路。你想让 Elly 走开满鲜花的小路，还是沿着闪闪发光的小河走？",
              options: {
                choices: [
                  {
                    key: "flowers",
                    text: "鲜花",
                    reply: "好呀，我们沿着鲜花小路出发，闻闻风里的香味！",
                  },
                  {
                    key: "river",
                    text: "河边",
                    reply: "好呀，我们沿着小河出发，听听水花唱歌！",
                  },
                ],
              },
              fallbackText:
                "没关系，那我们先沿着鲜花小路走吧，也许能在路口遇见朋友。",
              exitText: "好呀，我们先休息，等你准备好再陪 Elly 出发。",
            },
            {
              order: 2,
              kind: "narration",
              text: "两条路在老石桥旁汇到了一起。Elly 发现，一根枯枝挡住了风铃树的风口。它用力推了推，枯枝却一动不动。小松鼠就在旁边，可 Elly 有点不好意思开口。",
            },
            {
              order: 3,
              kind: "interaction",
              interactionType: "open_question",
              text: "Elly 搬不动枯枝，又有点不好意思求助。你觉得它可以对小松鼠说什么呢？",
              fallbackText:
                "有时候开口并不容易。没关系，我们陪 Elly 一起鼓起勇气。",
              exitText: "好呀，我们先陪 Elly 休息一下，下次再想办法。",
            },
            {
              order: 4,
              kind: "narration",
              text: "Elly 轻轻吸了一口气，终于对小松鼠说：我一个人推不动，你可以帮我一下吗？小松鼠笑着点点头。",
            },
            {
              order: 5,
              kind: "interaction",
              interactionType: "repeat_after_me",
              text: "我们也来练习这句勇敢的话，跟 Elly 一起说：请帮我一下，好吗？",
              options: {
                praise: "说得真好呀！请朋友帮忙，也是一件勇敢的事。",
              },
              fallbackText:
                "没关系，这次 Elly 替你大声说：请帮我一下，好吗？下次我们再一起试试。",
              exitText: "好呀，我们先休息，下次再陪 Elly 练习。",
            },
            {
              order: 6,
              kind: "narration",
              text: "Elly 和小松鼠一起数：一、二、三！枯枝终于移开了。清风穿过风口，风铃树叮叮当当地唱起了歌。",
            },
            {
              order: 7,
              kind: "interaction",
              interactionType: "reward",
              text: "因为你陪 Elly 学会了开口求助，一颗闪亮的求助星光飞进了你的小布包！",
              rewardStar: true,
            },
            {
              order: 8,
              kind: "narration",
              text: "Elly 明白啦，请朋友帮忙不是添麻烦，也可以让大家一起开心。它和小松鼠坐在风铃树下，听完了清晨的第一首歌。",
            },
          ],
        },
      },
      include: { segments: true },
    });

    return episode;
  });

  console.log(
    `Seeded ${episode.title}: ${episode.segments.length} segments for elly`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
