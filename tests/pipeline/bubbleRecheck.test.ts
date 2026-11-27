import { describe, expect, it } from "vitest";
import type { BubbleMask, Rect, TextRegion } from "../../packages/image-pipeline/src/types";
import {
  findBubblesWithoutRegions,
  planBubbleRecheckCrops,
  mergeRecheckedRegions,
  MAX_BUBBLE_RECHECKS,
} from "../../packages/image-pipeline/src/pipeline/bubbleRecheck";

function makeMask(x: number, y: number, width: number, height: number): BubbleMask {
  const data = new Uint8Array(width * height).fill(1);
  return { x, y, width, height, data };
}

function bubble(box: Rect, score = 0.9) {
  return {
    box,
    score,
    mask: makeMask(Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)),
  };
}

function region(id: string, box: Rect): TextRegion {
  return {
    id,
    box,
    quad: [
      { x: box.x, y: box.y },
      { x: box.x + box.width, y: box.y },
      { x: box.x + box.width, y: box.y + box.height },
      { x: box.x, y: box.y + box.height },
    ],
    direction: "h",
    sourceText: "texto",
    translatedText: "",
  };
}

describe("findBubblesWithoutRegions", () => {
  it("中心落在气泡掩码内的区域使该气泡视为已匹配", () => {
    const bubbles = [bubble({ x: 100, y: 200, width: 120, height: 80 })];
    const regions = [region("r1", { x: 120, y: 230, width: 60, height: 20 })];
    expect(findBubblesWithoutRegions(bubbles, regions)).toHaveLength(0);
  });

  it("没有任何区域落进掩码的气泡返回为待补检", () => {
    const bubbles = [
      bubble({ x: 100, y: 200, width: 120, height: 80 }),
      bubble({ x: 100, y: 400, width: 120, height: 80 }),
    ];
    const regions = [region("r1", { x: 120, y: 230, width: 60, height: 20 })];
    const unmatched = findBubblesWithoutRegions(bubbles, regions);
    expect(unmatched).toHaveLength(1);
    expect(unmatched[0].box.y).toBe(400);
  });
});

describe("planBubbleRecheckCrops", () => {
  it("过滤过小的气泡,裁剪带外扩并夹紧到图片边界", () => {
    const bubbles = [
      bubble({ x: 300, y: 16300, width: 120, height: 60 }), // 贴近图片底边
      bubble({ x: 50, y: 500, width: 20, height: 12 }), // 过小,跳过
    ];
    const plan = planBubbleRecheckCrops(bubbles, [], 444, 16383);
    expect(plan).toHaveLength(1);
    const { crop } = plan[0];
    // 外扩 18%:约 21.6/10.8,夹紧后不越界
    expect(crop.x).toBeGreaterThanOrEqual(0);
    expect(crop.y + crop.height).toBeLessThanOrEqual(16383);
    expect(crop.width).toBeGreaterThan(120);
    expect(crop.height).toBeGreaterThan(60);
  });

  it("按置信度排序并限制单页补检数量", () => {
    const bubbles = Array.from({ length: MAX_BUBBLE_RECHECKS + 5 }, (_, i) => (
      bubble({ x: 10, y: 100 + i * 200, width: 100, height: 50 }, 0.9 - i * 0.01)
    ));
    const plan = planBubbleRecheckCrops(bubbles, [], 444, 16383);
    expect(plan).toHaveLength(MAX_BUBBLE_RECHECKS);
    // 高置信度在前
    for (let i = 1; i < plan.length; i += 1) {
      expect(plan[i - 1].bubble.score).toBeGreaterThanOrEqual(plan[i].bubble.score);
    }
  });
});

describe("mergeRecheckedRegions", () => {
  it("区域平移回整图坐标并绑定气泡几何", () => {
    const bubbleDetect = bubble({ x: 100, y: 200, width: 120, height: 80 });
    const crop = { x: 90, y: 190, width: 140, height: 100 };
    // 裁剪本地坐标:中心 (70, 50) → 整图 (160, 240),落在气泡内
    const frameRegion = region("r", { x: 50, y: 40, width: 40, height: 16 });
    const added = mergeRecheckedRegions([], [frameRegion], crop, bubbleDetect);

    expect(added).toHaveLength(1);
    expect(added[0].box).toEqual({ x: 140, y: 230, width: 40, height: 16 });
    expect(added[0].quad?.[0]).toEqual({ x: 140, y: 230 });
    expect(added[0].bubbleBox).toEqual(bubbleDetect.box);
    expect(added[0].bubbleMask).toBe(bubbleDetect.mask);
  });

  it("中心不在气泡掩码内的候选被丢弃", () => {
    const bubbleDetect = bubble({ x: 100, y: 200, width: 120, height: 80 });
    const crop = { x: 90, y: 190, width: 140, height: 100 };
    // 裁剪本地坐标 (2,2,10,8) → 整图 (92,192),中心 (97,196) 在掩码外(掩码从 100,200 起)
    const outside = region("r", { x: 2, y: 2, width: 10, height: 8 });
    expect(mergeRecheckedRegions([], [outside], crop, bubbleDetect)).toHaveLength(0);
  });

  it("与已有区域重叠过半的候选去重丢弃", () => {
    const bubbleDetect = bubble({ x: 100, y: 200, width: 120, height: 80 });
    const crop = { x: 90, y: 190, width: 140, height: 100 };
    const frameRegion = region("r", { x: 50, y: 40, width: 40, height: 16 });
    const existing = [region("old", { x: 145, y: 233, width: 34, height: 14 })];
    expect(mergeRecheckedRegions(existing, [frameRegion], crop, bubbleDetect)).toHaveLength(0);
  });
});
