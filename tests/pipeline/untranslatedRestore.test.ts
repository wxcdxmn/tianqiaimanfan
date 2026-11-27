import { describe, it, expect } from "vitest";
import {
  planUntranslatedRestore,
  rectOverlapRatio,
} from "../../packages/image-pipeline/src/pipeline/untranslatedRestore";
import type { TextRegion } from "../../packages/image-pipeline/src/types";

function region(
  id: string,
  box: [number, number, number, number],
  sourceText: string,
  translatedText: string,
): TextRegion {
  return {
    id,
    box: { x: box[0], y: box[1], width: box[2], height: box[3] },
    direction: "h",
    sourceText,
    translatedText,
  };
}

describe("planUntranslatedRestore", () => {
  it("没译文的区域进入回填计划，已翻译的不动", () => {
    const ok = region("ok", [0, 0, 100, 50], "原文A", "译文A");
    const missing = region("missing", [0, 200, 100, 50], "原文B", "");

    const plan = planUntranslatedRestore([ok, missing]);

    expect(plan.restore.map((item) => item.id)).toEqual(["missing"]);
    expect(plan.skipped).toHaveLength(0);
  });

  it("译文为纯空白也算没翻译", () => {
    const missing = region("missing", [0, 0, 100, 50], "原文", "   ");
    expect(planUntranslatedRestore([missing]).restore.map((item) => item.id)).toEqual(["missing"]);
  });

  it("源文本为空的区域不参与回填", () => {
    const empty = region("empty", [0, 0, 100, 50], "  ", "");
    const plan = planUntranslatedRestore([empty]);
    expect(plan.restore).toHaveLength(0);
    expect(plan.skipped).toHaveLength(0);
  });

  it("与已翻译区域重叠过多时放弃回填，避免原文透在译文底下", () => {
    const ok = region("ok", [0, 0, 100, 100], "原文A", "译文A");
    const overlapping = region("overlap", [0, 0, 100, 60], "原文B", "");

    const plan = planUntranslatedRestore([ok, overlapping]);

    expect(plan.restore).toHaveLength(0);
    expect(plan.skipped.map((item) => item.id)).toEqual(["overlap"]);
  });

  it("译文文本不改变重叠判定：已标记失败的区域不算已翻译", () => {
    const failed = region("failed", [0, 0, 100, 100], "原文A", "译文A");
    failed.translationFailed = true;
    const missing = region("missing", [0, 0, 100, 60], "原文B", "");

    const plan = planUntranslatedRestore([failed, missing]);

    expect(plan.restore.map((item) => item.id)).toEqual(["missing"]);
  });
});

describe("rectOverlapRatio", () => {
  it("完全重合为 1，不接触为 0", () => {
    expect(rectOverlapRatio({ x: 0, y: 0, width: 10, height: 10 }, { x: 0, y: 0, width: 10, height: 10 })).toBe(1);
    expect(rectOverlapRatio({ x: 0, y: 0, width: 10, height: 10 }, { x: 20, y: 20, width: 10, height: 10 })).toBe(0);
  });

  it("以较小框面积为分母：小框被完全盖住算 1", () => {
    expect(rectOverlapRatio({ x: 0, y: 0, width: 100, height: 100 }, { x: 0, y: 0, width: 50, height: 50 })).toBe(1);
  });

  it("小框只被盖住一半时算 0.5", () => {
    // 小框 50×50 落在 y=75..124，与大框（0..99）只交叠上半部分。
    const ratio = rectOverlapRatio({ x: 0, y: 0, width: 100, height: 100 }, { x: 0, y: 75, width: 50, height: 50 });
    expect(ratio).toBeCloseTo(0.5, 5);
  });
});
