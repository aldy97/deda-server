import { resolveFillerAct } from "./filler-act";

const base = {
  asrText: "我碰到了你最好的朋友",
  intent: "free_chat",
};

describe("resolveFillerAct", () => {
  it("停止类语句落 stop，拒绝语句没有明确情绪词时情绪归 neutral", () => {
    expect(
      resolveFillerAct({ ...base, asrText: "我不要听了", emotion: "sad" }),
    ).toEqual({ act: "stop", emotion: "neutral" });
    expect(resolveFillerAct({ ...base, asrText: "别讲了" }).act).toBe("stop");
    expect(resolveFillerAct({ ...base, asrText: "停一下" }).act).toBe("stop");
    expect(resolveFillerAct({ ...base, asrText: "结束" }).act).toBe("stop");
    expect(resolveFillerAct({ ...base, asrText: "我不想玩了" }).act).toBe(
      "stop",
    );
    expect(resolveFillerAct({ ...base, asrText: "我不要听儿歌了" }).act).toBe(
      "stop",
    );
    expect(
      resolveFillerAct({
        ...base,
        asrText: "I don't want to listen",
        emotion: "sad",
      }),
    ).toEqual({ act: "stop", emotion: "neutral" });
  });

  it("“换一个”类语句优先于 stop，按产品口径判 story_tell", () => {
    expect(
      resolveFillerAct({
        ...base,
        asrText: "我不想听了，换一个",
      }).act,
    ).toBe("story_tell");
    expect(
      resolveFillerAct({
        ...base,
        asrText: "我不想听这个故事，换一个",
      }).act,
    ).toBe("story_tell");
    expect(
      resolveFillerAct({
        ...base,
        asrText: "我不要听儿歌，我要听故事",
      }).act,
    ).toBe("story_tell");
    expect(resolveFillerAct({ ...base, asrText: "再讲一个" }).act).toBe(
      "story_tell",
    );
    expect(resolveFillerAct({ ...base, asrText: "换个故事吧" }).act).toBe(
      "story_tell",
    );
  });

  it("歌曲切换与无关的“换一个”不误判成故事", () => {
    expect(
      resolveFillerAct({ ...base, asrText: "我不要听儿歌，换一个" }).act,
    ).toBe("neutral");
    expect(resolveFillerAct({ ...base, asrText: "换一个玩具" }).act).toBe(
      "neutral",
    );
  });

  it("“不要听写作业”不误判 stop", () => {
    expect(resolveFillerAct({ ...base, asrText: "我不要听写作业" }).act).toBe(
      "neutral",
    );
  });

  it("继续类语句落 continue，且晚于“再讲一个”", () => {
    expect(
      resolveFillerAct({
        ...base,
        asrText: "继续",
        intent: "sleep_story",
        intentSource: "continuation",
      }).act,
    ).toBe("continue");
    expect(
      resolveFillerAct({
        ...base,
        asrText: "接着讲",
        intent: "free_story",
      }).act,
    ).toBe("continue");
    expect(
      resolveFillerAct({
        ...base,
        asrText: "然后呢",
        intent: "free_story",
      }).act,
    ).toBe("continue");
    expect(
      resolveFillerAct({
        ...base,
        asrText: "再讲一个",
        intent: "free_story",
        intentSource: "continuation",
      }).act,
    ).toBe("story_tell");
  });

  it("故事与哄睡意图分桶，哄睡时段关闭落 deferred", () => {
    expect(
      resolveFillerAct({
        ...base,
        asrText: "给我讲个故事",
        intent: "free_story",
      }).act,
    ).toBe("story_tell");
    expect(
      resolveFillerAct({ ...base, asrText: "我困了", intent: "sleep_story" })
        .act,
    ).toBe("sleep");
    expect(
      resolveFillerAct({
        ...base,
        asrText: "我困了",
        intent: "sleep_story",
        intentSource: "sleep_window_closed",
      }).act,
    ).toBe("deferred");
  });

  it("强制哄睡优先于 stop", () => {
    expect(
      resolveFillerAct({
        ...base,
        asrText: "我不要听了",
        intent: "sleep_story",
        intentSource: "force_sleep",
      }).act,
    ).toBe("sleep");
    expect(
      resolveFillerAct({
        ...base,
        asrText: "我困了",
        intent: "sleep_story",
        intentSource: "test_sleep",
      }).act,
    ).toBe("sleep");
  });

  it("explicit_exit 直接落 stop，不依赖文本正则", () => {
    expect(
      resolveFillerAct({
        ...base,
        asrText: "我玩够了",
        intent: "free_chat",
        intentSource: "explicit_exit",
      }).act,
    ).toBe("stop");
  });

  it("冒险已婉拒时落 deferred", () => {
    expect(
      resolveFillerAct({
        ...base,
        intent: "adventure_story",
        adventureDeclined: true,
      }).act,
    ).toBe("deferred");
    expect(
      resolveFillerAct({
        ...base,
        asrText: "给我讲个故事",
        intent: "free_story",
        adventureDeclined: true,
      }).act,
    ).toBe("deferred");
  });

  it("明确情绪词保留模型情绪；拒绝类语句无情绪词则归 neutral", () => {
    expect(
      resolveFillerAct({
        ...base,
        asrText: "我很难过，不想听了",
        emotion: "sad",
      }),
    ).toEqual({ act: "stop", emotion: "sad" });
    expect(
      resolveFillerAct({
        ...base,
        asrText: "我不喜欢这个",
        emotion: "sad",
      }),
    ).toEqual({ act: "neutral", emotion: "neutral" });
    expect(
      resolveFillerAct({
        ...base,
        asrText: "I don't like this",
        emotion: "sad",
      }),
    ).toEqual({ act: "neutral", emotion: "neutral" });
  });

  it("情绪桶与身份/偏好/问句互斥", () => {
    expect(resolveFillerAct({ ...base, asrText: "我好难过" }).act).toBe(
      "comfort",
    );
    expect(resolveFillerAct({ ...base, asrText: "我好开心" }).act).toBe(
      "celebrate",
    );
    expect(resolveFillerAct({ ...base, asrText: "我害怕打雷" }).act).toBe(
      "comfort",
    );
    expect(resolveFillerAct({ ...base, asrText: "你叫什么名字？" }).act).toBe(
      "identity",
    );
    expect(resolveFillerAct({ ...base, asrText: "你喜欢吃什么？" }).act).toBe(
      "preference",
    );
    expect(resolveFillerAct({ ...base, asrText: "为什么天是蓝的？" }).act).toBe(
      "question",
    );
  });

  it("普通陈述落 neutral", () => {
    expect(resolveFillerAct({ ...base }).act).toBe("neutral");
  });

  it("关键词情绪兜底覆盖生气分支；缺省 intent 走 neutral", () => {
    expect(resolveFillerAct({ ...base, asrText: "我生气了" }).act).toBe(
      "comfort",
    );
    expect(resolveFillerAct({ asrText: "我碰到了你最好的朋友" }).act).toBe(
      "neutral",
    );
  });
});
