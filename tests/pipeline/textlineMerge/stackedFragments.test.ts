import { describe, it, expect } from "vitest";
import { mergeStackedTextFragments } from "../../../packages/image-pipeline/src/pipeline/textlineMerge";
import type { TextRegion } from "../../../packages/image-pipeline/src/types";

function region(
  id: string,
  box: [number, number, number, number],
  text: string,
  overrides: Partial<TextRegion> = {},
): TextRegion {
  return {
    id,
    box: { x: box[0], y: box[1], width: box[2], height: box[3] },
    direction: "h",
    sourceText: text,
    translatedText: "",
    ...overrides,
  };
}

describe("mergeStackedTextFragments", () => {
  it("把居中的短首行与下方多行块合回一段", () => {
    // 真实样本：韩漫里「아무튼」单独成框，余下三行是另一个更宽的块。
    const head = region("a", [402, 243, 107, 47], "아무튼");
    const body = region("b", [358, 273, 197, 182], "그 힘은 좀\n조심하는 게\n좋겠어..");

    const merged = mergeStackedTextFragments([head, body]);

    expect(merged).toHaveLength(1);
    expect(merged[0].sourceText).toBe("아무튼\n그 힘은 좀\n조심하는 게\n좋겠어..");
    expect(merged[0].box).toEqual({ x: 358, y: 243, width: 197, height: 212 });
    expect(merged[0].originalLineCount).toBe(2);
  });

  it("首行宽度接近、间距为零的多行块一并合并", () => {
    const a = region("a", [333, 93, 266, 65], "여러분들의방도");
    const b = region("b", [326, 123, 280, 93], "준비되어있으니");
    const c = region("c", [368, 192, 197, 61], "편히쉬세요");

    const merged = mergeStackedTextFragments([a, b, c]);

    expect(merged).toHaveLength(1);
    expect(merged[0].sourceText.split("\n")).toEqual(["여러분들의방도", "준비되어있으니", "편히쉬세요"]);
  });

  it("保留阅读顺序：按 top 排序拼接文本", () => {
    const lower = region("low", [100, 400, 200, 60], "第二行");
    const upper = region("up", [110, 350, 180, 50], "第一行");

    const merged = mergeStackedTextFragments([lower, upper]);

    expect(merged).toHaveLength(1);
    expect(merged[0].sourceText).toBe("第一行\n第二行");
  });

  it("横向错开的两个气泡不会被误合并", () => {
    const left = region("a", [100, 200, 150, 80], "左侧气泡");
    const right = region("b", [600, 200, 150, 80], "右侧气泡");

    expect(mergeStackedTextFragments([left, right])).toHaveLength(2);
  });

  it("竖直间距过大的两段不会被误合并", () => {
    const a = region("a", [100, 200, 200, 60], "上一段");
    const b = region("b", [100, 400, 200, 60], "下一段");

    expect(mergeStackedTextFragments([a, b])).toHaveLength(2);
  });

  it("宽度相差过大的两段不会被误合并", () => {
    const narrow = region("a", [100, 200, 30, 40], "！");
    const wide = region("b", [100, 236, 400, 120], "一整段很长的叙述文字");

    expect(mergeStackedTextFragments([narrow, wide])).toHaveLength(2);
  });

  it("竖排区域不参与合并", () => {
    const a = region("a", [400, 100, 60, 120], "縦書き", { direction: "v" });
    const b = region("b", [400, 210, 60, 120], "続き", { direction: "v" });

    expect(mergeStackedTextFragments([a, b])).toHaveLength(2);
  });

  it("单个区域原样返回", () => {
    const only = region("a", [10, 10, 100, 40], "だけ");
    expect(mergeStackedTextFragments([only])).toEqual([only]);
  });
});
