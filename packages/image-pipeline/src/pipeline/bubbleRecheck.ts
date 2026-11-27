import type { BubbleMask, QuadPoint, Rect, TextRegion } from "../types";
import type { ImageCrop } from "../runtime/platform";
import { hasBubbleMaskPixel } from "./bubbleMask";
import { boxOverlapRatio } from "./detect/tiling";

/**
 * 气泡引导的二次检测。
 *
 * 为什么需要它：长条图切片检测会把正文缩到 ~0.55×（16383px 高的条漫切 10 片、
 * 每片 1848px 塞进检测器 1024² 输入），小字号对话经常漏检。而气泡是大目标，
 * 分割模型在同样的缩放下依然很稳——「有气泡却没配到任何文本区域中心」
 * 基本就是漏检的对话。漏检的文本既不会被翻译（用户看到的「无法翻译」），
 * 也不会被擦除（用户看到的「原文残留」），所以这里对两个症状都是直接修复。
 *
 * 做法：把这些气泡逐个裁剪（带少量外扩）、放大到检测器输入尺寸重扫一遍，
 * 返回的候选区域已平移回整图坐标、并预绑定了气泡几何。
 */

/** 太小的气泡装不下可读对话，重扫是浪费推理。 */
export const MIN_RECHECK_BUBBLE_WIDTH = 36;
export const MIN_RECHECK_BUBBLE_HEIGHT = 28;
/** 单页补检上限：罕见页可能检出几十个空气泡，超出部分宁可放过也不拖慢整页。 */
export const MAX_BUBBLE_RECHECKS = 20;
/** 裁剪外扩比例：给检测器留一点气泡边缘的上下文，也覆盖贴边文字。 */
export const RECHECK_PAD_RATIO = 0.18;

export type BubbleDetectionLike = {
  box: Rect;
  score: number;
  mask: BubbleMask;
};

/**
 * 找出「内部没有任何文字区域中心」的气泡。
 *
 * 与 matchRegionsToBubbles 的方向相反：那边问「这个区域属于哪个气泡」，
 * 这里问「哪个气泡里一个区域都没有」。
 */
export function findBubblesWithoutRegions(
  bubbles: readonly BubbleDetectionLike[],
  regions: readonly TextRegion[],
): BubbleDetectionLike[] {
  return bubbles.filter((bubble) => {
    for (const region of regions) {
      const cx = Math.round(region.box.x + region.box.width / 2);
      const cy = Math.round(region.box.y + region.box.height / 2);
      if (hasBubbleMaskPixel(bubble.mask, cx, cy)) return false;
    }
    return true;
  });
}

function clampRect(rect: Rect, width: number, height: number): Rect {
  const x = Math.max(0, Math.floor(rect.x));
  const y = Math.max(0, Math.floor(rect.y));
  const x2 = Math.min(width, Math.ceil(rect.x + rect.width));
  const y2 = Math.min(height, Math.ceil(rect.y + rect.height));
  return { x, y, width: Math.max(0, x2 - x), height: Math.max(0, y2 - y) };
}

/**
 * 筛选值得重扫的气泡并生成裁剪框（整图坐标、已外扩并夹紧到图片边界）。
 * 按气泡置信度降序，超过 MAX_BUBBLE_RECHECKS 的丢弃。
 */
export function planBubbleRecheckCrops(
  bubbles: readonly BubbleDetectionLike[],
  regions: readonly TextRegion[],
  imageWidth: number,
  imageHeight: number,
): Array<{ bubble: BubbleDetectionLike; crop: ImageCrop }> {
  const candidates = findBubblesWithoutRegions(bubbles, regions)
    .filter((bubble) => (
      bubble.box.width >= MIN_RECHECK_BUBBLE_WIDTH
      && bubble.box.height >= MIN_RECHECK_BUBBLE_HEIGHT
    ))
    .sort((left, right) => right.score - left.score)
    .slice(0, MAX_BUBBLE_RECHECKS);

  return candidates.map((bubble) => {
    const padX = bubble.box.width * RECHECK_PAD_RATIO;
    const padY = bubble.box.height * RECHECK_PAD_RATIO;
    const crop = clampRect(
      {
        x: bubble.box.x - padX,
        y: bubble.box.y - padY,
        width: bubble.box.width + padX * 2,
        height: bubble.box.height + padY * 2,
      },
      imageWidth,
      imageHeight,
    );
    return { bubble, crop };
  });
}

/**
 * 把一次裁剪检测的区域平移回整图坐标，过滤掉明显噪声，并与已有区域去重。
 *
 * - 中心不在该气泡掩码内的候选直接丢弃（外扩区域可能扫进邻框或画面文字）；
 * - 与已有区域重叠 >50% 的候选丢弃（已有区域经过完整管线，优先保留）；
 * - 通过的候选预绑定 bubbleBox/bubbleMask，让擦除和排版直接可用。
 */
export function mergeRecheckedRegions(
  existing: TextRegion[],
  frameRegions: readonly TextRegion[],
  crop: ImageCrop,
  bubble: BubbleDetectionLike,
): TextRegion[] {
  const added: TextRegion[] = [];
  for (const region of frameRegions) {
    if (region.box.width < 8 || region.box.height < 8) continue;
    const box: Rect = {
      x: region.box.x + crop.x,
      y: region.box.y + crop.y,
      width: region.box.width,
      height: region.box.height,
    };
    const cx = Math.round(box.x + box.width / 2);
    const cy = Math.round(box.y + box.height / 2);
    if (!hasBubbleMaskPixel(bubble.mask, cx, cy)) continue;
    if (existing.some((candidate) => boxOverlapRatio(candidate.box, box) > 0.5)) continue;
    if (added.some((candidate) => boxOverlapRatio(candidate.box, box) > 0.5)) continue;

    const quad: [QuadPoint, QuadPoint, QuadPoint, QuadPoint] | undefined = region.quad
      ?.map((point) => ({ x: point.x + crop.x, y: point.y + crop.y })) as
      [QuadPoint, QuadPoint, QuadPoint, QuadPoint] | undefined;
    added.push({
      ...region,
      box,
      quad,
      bubbleBox: { ...bubble.box },
      bubbleMask: bubble.mask,
    });
  }
  return added;
}
