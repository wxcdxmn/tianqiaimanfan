import type { Rect } from "../../types";

/**
 * 气泡分割掩码（源图像素坐标）。
 */
export type BubbleInkMask = {
  x: number;
  y: number;
  width: number;
  height: number;
  data: Uint8Array;
};

export type BubbleInkOptions = {
  /** 与背景判定为「笔画」的灰度差。 */
  inkDelta?: number;
  /** 气泡内部允许的最大非平坦比例。超过说明底板是渐变/画面，别在这里上墨。 */
  minFlatShare?: number;
  minInkShare?: number;
  maxInkShare?: number;
  /** 沿气泡边界收缩的源像素数，用来避开气泡描边本身。 */
  borderMarginSourcePx?: number;
  /** 连通域包围盒占气泡内部的比例上限，更大的块视为描边/装饰而不擦。 */
  maxComponentShare?: number;
};

export type BubbleInkResult = {
  mask: Uint8Array;
  rect: Rect;
  flatShare: number;
  inkShare: number;
};

/**
 * 把「气泡内部但不在文字框里」的残留笔画也纳入遮罩。
 *
 * 文字框是检测器的输出，往往只包住它认出来的那几行；同一气泡里检测器漏掉的
 * 行、行末被框切断的字、以及上一次擦除没去的笔画，都在框外，于是译文旁边
 * 会留着半截原文。气泡分割掩码给出整个气泡的内边界，用它做一次「平坦底板上的
 * 上墨」，就能把气泡里所有不像背景的笔画一起擦掉。
 *
 * 只处理底板足够平坦的气泡（纯色/近纯色），渐变、网点和透出画面的气泡一律放弃，
 * 交给原有的检测遮罩 + inpaint 处理，避免把画面糊掉。
 */
export function fillInkInBubbleInterior(
  gray: Uint8Array,
  width: number,
  height: number,
  bubble: BubbleInkMask,
  scale: number,
  options: BubbleInkOptions = {},
): BubbleInkResult | null {
  if (!(scale > 0) || bubble.width <= 0 || bubble.height <= 0) return null;
  if (bubble.data.length < bubble.width * bubble.height) return null;

  const x0 = Math.max(0, Math.floor(bubble.x * scale));
  const y0 = Math.max(0, Math.floor(bubble.y * scale));
  const x1 = Math.min(width, Math.ceil((bubble.x + bubble.width) * scale));
  const y1 = Math.min(height, Math.ceil((bubble.y + bubble.height) * scale));
  const rw = x1 - x0;
  const rh = y1 - y0;
  if (rw <= 0 || rh <= 0) return null;

  const insideBubble = (sourceX: number, sourceY: number): boolean => {
    const localX = Math.floor(sourceX - bubble.x);
    const localY = Math.floor(sourceY - bubble.y);
    if (localX < 0 || localY < 0 || localX >= bubble.width || localY >= bubble.height) {
      return false;
    }
    return bubble.data[localY * bubble.width + localX] !== 0;
  };

  const margin = Math.max(1, Math.round(options.borderMarginSourcePx ?? 2));
  const interior = new Uint8Array(rw * rh);
  const histogram = new Uint32Array(256);
  let interiorCount = 0;
  let interiorMinX = rw;
  let interiorMinY = rh;
  let interiorMaxX = -1;
  let interiorMaxY = -1;
  for (let y = 0; y < rh; y += 1) {
    const sourceY = bubble.y + (y0 + y + 0.5) / scale;
    const row = (y0 + y) * width;
    for (let x = 0; x < rw; x += 1) {
      const sourceX = bubble.x + (x0 + x + 0.5) / scale;
      if (!insideBubble(sourceX, sourceY)) continue;
      // 收缩一圈：气泡描边本身也是深色笔画，不该被当成文字擦掉。
      if (
        !insideBubble(sourceX - margin, sourceY)
        || !insideBubble(sourceX + margin, sourceY)
        || !insideBubble(sourceX, sourceY - margin)
        || !insideBubble(sourceX, sourceY + margin)
      ) {
        continue;
      }
      interior[y * rw + x] = 1;
      interiorCount += 1;
      if (x < interiorMinX) interiorMinX = x;
      if (x > interiorMaxX) interiorMaxX = x;
      if (y < interiorMinY) interiorMinY = y;
      if (y > interiorMaxY) interiorMaxY = y;
      histogram[gray[row + x0 + x]] += 1;
    }
  }
  if (interiorCount < 64) return null;

  // 中位灰度当背景：笔画无论深浅都只占少数。
  const half = interiorCount >> 1;
  let cumulative = 0;
  let median = 0;
  for (let value = 0; value < 256; value += 1) {
    cumulative += histogram[value];
    if (cumulative > half) {
      median = value;
      break;
    }
  }
  let sum = 0;
  let count = 0;
  for (let value = Math.max(0, median - 12); value <= Math.min(255, median + 12); value += 1) {
    sum += value * histogram[value];
    count += histogram[value];
  }
  const background = count > 0 ? sum / count : median;

  const inkDelta = options.inkDelta ?? 30;
  const flatTolerance = Math.max(10, inkDelta * 0.4);
  const ink = new Uint8Array(rw * rh);
  let flatCount = 0;
  let inkCount = 0;
  for (let y = 1; y < rh - 1; y += 1) {
    const row = (y0 + y) * width;
    for (let x = 1; x < rw - 1; x += 1) {
      const index = y * rw + x;
      if (!interior[index]) continue;
      const delta = Math.abs(gray[row + x0 + x] - background);
      if (delta <= flatTolerance) {
        flatCount += 1;
      } else if (delta > inkDelta) {
        ink[index] = 1;
        inkCount += 1;
      }
    }
  }

  const flatShare = flatCount / interiorCount;
  const inkShare = inkCount / interiorCount;
  if (flatShare < (options.minFlatShare ?? 0.5)) return null;
  if (inkShare < (options.minInkShare ?? 0.004) || inkShare > (options.maxInkShare ?? 0.5)) {
    return null;
  }

  const kept = keepGlyphComponents(
    ink,
    rw,
    rh,
    { minX: interiorMinX, minY: interiorMinY, maxX: interiorMaxX, maxY: interiorMaxY },
    options.maxComponentShare ?? 0.85,
  );
  if (kept === null) return null;
  return {
    mask: kept.mask,
    rect: { x: x0, y: y0, width: rw, height: rh },
    flatShare,
    inkShare: kept.pixelCount / interiorCount,
  };
}

/**
 * 丢掉贴着气泡内边界或大得不像字的连通域：这两类都是描边、网点或画面元素。
 * 保留的才是文字笔画。
 */
function keepGlyphComponents(
  ink: Uint8Array,
  width: number,
  height: number,
  interiorBounds: { minX: number; minY: number; maxX: number; maxY: number },
  maxComponentShare: number,
): { mask: Uint8Array; pixelCount: number } | null {
  const visited = new Uint8Array(width * height);
  const stack: number[] = [];
  const mask = new Uint8Array(width * height);
  let pixelCount = 0;
  for (let index = 0; index < ink.length; index += 1) {
    if (!ink[index] || visited[index]) continue;
    visited[index] = 1;
    stack.length = 0;
    stack.push(index);
    const pixels: number[] = [];
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    while (stack.length > 0) {
      const current = stack.pop() as number;
      const cx = current % width;
      const cy = (current - cx) / width;
      pixels.push(current);
      if (cx < minX) minX = cx;
      if (cy < minY) minY = cy;
      if (cx > maxX) maxX = cx;
      if (cy > maxY) maxY = cy;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const next = ny * width + nx;
          if (!ink[next] || visited[next]) continue;
          visited[next] = 1;
          stack.push(next);
        }
      }
    }
    // 贴着气泡内边界的块（描边、网点、画面元素）一律不擦。
    const touchesEdge = minX <= interiorBounds.minX
      || minY <= interiorBounds.minY
      || maxX >= interiorBounds.maxX
      || maxY >= interiorBounds.maxY;
    if (touchesEdge) continue;
    if ((maxX - minX + 1) > width * maxComponentShare) continue;
    if ((maxY - minY + 1) > height * maxComponentShare) continue;
    for (const pixel of pixels) mask[pixel] = 1;
    pixelCount += pixels.length;
  }
  return pixelCount > 0 ? { mask, pixelCount } : null;
}
