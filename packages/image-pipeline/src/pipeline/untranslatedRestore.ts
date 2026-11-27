import type { TextRegion } from "../types";

/** 回填原文时，与已翻译区域重叠超过这个比例就放弃（避免把邻框原文又贴回来）。 */
export const UNTRANSLATED_RESTORE_MAX_OVERLAP = 0.2;

type Rect = { x: number; y: number; width: number; height: number };

export function rectOverlapRatio(a: Rect, b: Rect): number {
  const overlapWidth = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const overlapHeight = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const minArea = Math.min(a.width * a.height, b.width * b.height);
  return minArea > 0 ? (overlapWidth * overlapHeight) / minArea : 0;
}

export type UntranslatedRestorePlan = {
  /** 需要把原图像素贴回去的区域。 */
  restore: TextRegion[];
  /** 没译文但和已翻译区域重叠过多、放弃回填的区域。 */
  skipped: TextRegion[];
};

/**
 * 规划「没拿到译文的区域」要把原图像素贴回哪些地方。
 *
 * 去字和翻译是并行的，去字阶段无法预知哪些框最终没有译文；这些框会被擦成空白。
 * 把原图局部还原能让「没翻译」看起来是「这处没动过」。
 * 但如果该框与一个已翻译的框重叠，贴回原图会把邻框的原文也贴回来，
 * 在中文译文底下透出韩文，所以重叠过多时宁可不贴。
 */
export function planUntranslatedRestore(regions: readonly TextRegion[]): UntranslatedRestorePlan {
  const translatedBoxes = regions
    .filter((region) => region.translatedText.trim() !== '' && region.translationFailed !== true)
    .map((region) => region.box);
  const restore: TextRegion[] = [];
  const skipped: TextRegion[] = [];
  for (const region of regions) {
    if (region.sourceText.trim() === '' || region.translatedText.trim() !== '') {
      continue;
    }
    const overlapsTranslated = translatedBoxes.some(
      (box) => rectOverlapRatio(region.box, box) > UNTRANSLATED_RESTORE_MAX_OVERLAP,
    );
    if (overlapsTranslated) {
      skipped.push(region);
    } else {
      restore.push(region);
    }
  }
  return { restore, skipped };
}
