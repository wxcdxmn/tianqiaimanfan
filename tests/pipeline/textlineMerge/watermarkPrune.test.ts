import { describe, expect, it } from "vitest";
import type { TextRegion } from "../../../packages/image-pipeline/src/types";
import { mergeTextLines } from "../../../packages/image-pipeline/src/pipeline/textlineMerge";

/**
 * toontop.io 实测回归:条漫水印行(汉化组站名)紧贴对白气泡,行合并把它
 * 并进对白区域,水印原文跟着台词一起翻译、嵌进气泡。修复后行级水印拦截
 * 应在建合并图之前丢弃这些行。
 */
function line(id: string, text: string, y: number): TextRegion {
  return {
    id,
    box: { x: 20, y, width: 200, height: 20 },
    quad: [
      { x: 20, y },
      { x: 220, y },
      { x: 220, y: y + 20 },
      { x: 20, y: y + 20 },
    ],
    direction: "h",
    prob: 0.9,
    fgColor: [0, 0, 0],
    bgColor: [255, 255, 255],
    sourceText: text,
    translatedText: "",
  };
}

describe("mergeTextLines 行级水印拦截", () => {
  it("水印行不再被并进对白区域", () => {
    const merged = mergeTextLines(
      [
        line("dialogue", "QUERRÁS OÍR COSAS MALAS DE ALGUIEN QUE ES TU AMIGA..", 20),
        line("watermark", "TEMPLESCANESPNET", 45),
      ],
      800,
      600,
    );

    expect(merged).toHaveLength(1);
    expect(merged[0].sourceText).toBe("QUERRÁS OÍR COSAS MALAS DE ALGUIEN QUE ES TU AMIGA..");
    expect(merged[0].sourceText).not.toContain("TEMPLESCAN");
  });

  it("普通相邻对白行照常合并(拦截不改变合并行为)", () => {
    const merged = mergeTextLines(
      [
        line("a", "SABES QUE AHORA LE TOCA", 20),
        line("b", "A JINA", 45),
      ],
      800,
      600,
    );

    expect(merged).toHaveLength(1);
    expect(merged[0].sourceText).toContain("SABES QUE");
    expect(merged[0].sourceText).toContain("A JINA");
  });
});
