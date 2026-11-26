/**
 * OCR 空结果补识别。
 *
 * 存在的理由：文本检测出的框往往贴得很紧，遇到上伸部/下伸部（如 b、y、g）、
 * 描边字或轻微倾斜时，PP-OCR 会整条读空——这条对白就"检测到了但没翻"。
 * 这里把空框向外扩一点再识别一次，比重新跑检测便宜得多，也不会扩大擦除范围
 * （擦除仍用原框），是提升对白覆盖率性价比最高的一步。
 */

import type { Rect } from "../../types";

/** 单页最多补识别多少个空框，避免异常页把 OCR 跑很多遍。 */
export const MAX_OCR_RETRIES = 12;

/** 向外扩张比例：横向保守，纵向多给一点，覆盖上伸部/下伸部。 */
export const OCR_RETRY_PAD_X = 0.12;
export const OCR_RETRY_PAD_Y = 0.22;

export type OcrRetryBox = Rect;

/**
 * 计算补识别用的扩张框。
 *
 * 只在框本身太小时才会大幅扩张：已经很高的框（多行合并块）纵向少给，
 * 避免把相邻对白吃进来导致串行。
 */
export function expandOcrRetryBox(
  box: Rect,
  imageWidth: number,
  imageHeight: number,
): Rect {
  const padX = Math.max(2, Math.round(box.width * OCR_RETRY_PAD_X));
  const verticalScale = box.height >= box.width ? 0.1 : OCR_RETRY_PAD_Y;
  const padY = Math.max(2, Math.round(box.height * verticalScale));

  const x = Math.max(0, Math.round(box.x - padX));
  const y = Math.max(0, Math.round(box.y - padY));
  const right = Math.min(imageWidth, Math.round(box.x + box.width + padX));
  const bottom = Math.min(imageHeight, Math.round(box.y + box.height + padY));

  return {
    x,
    y,
    width: Math.max(1, right - x),
    height: Math.max(1, bottom - y),
  };
}

/** 空识别结果是否值得写回：太短又没置信度的多半是噪点。 */
export function isUsableOcrRetry(text: string, prob: number | undefined): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  const confidence = prob ?? 0;
  if (trimmed.length >= 2) return confidence >= 0.3;
  // 单字符：必须够自信，否则会往气泡里塞误识别的噪点。
  return confidence >= 0.75;
}
