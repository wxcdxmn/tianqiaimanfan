import type { Rect, TextRegion } from "../../types";
import type { PlatformProvider, PipelineCanvas } from "../../runtime/platform";
import { clamp, polygonArea } from "../utils";
import { tryNativeOpaqueMaskThreshold } from "../image";

export type Point = {
  x: number;
  y: number;
};

export type MaskRefinementMethod = "fit_text";

export type MaskRefinementOptions = {
  method?: MaskRefinementMethod;
  dilationOffset?: number;
  kernelSize?: number;
  keepThreshold?: number;
};

export type RegionMaskInfo = {
  box: Rect;
  polygon: Point[];
  area: number;
  textSize: number;
};

export type Component = {
  pixels: Int32Array;
  rect: Rect;
  area: number;
  center: Point;
};

export type AssignedExtent = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

export function makeCanvas(width: number, height: number, platform: PlatformProvider): PipelineCanvas {
  const canvas = platform.createCanvas(width, height);
  return canvas;
}

export function readBinaryMask(canvas: PipelineCanvas, width: number, height: number, platform: PlatformProvider): Uint8Array {
  const resized = makeCanvas(width, height, platform);
  const ctx = resized.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    throw new Error("Mask refinement 读取遮罩失败：无法创建画布上下文");
  }
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(canvas, 0, 0, width, height);
  const data = ctx.getImageData(0, 0, width, height).data;
  const out = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < out.length; i += 1, p += 4) {
    out[i] = data[p] > 0 ? 1 : 0;
  }
  return out;
}

export function readGrayImage(canvas: PipelineCanvas, width: number, height: number, platform: PlatformProvider): Uint8Array {
  const resized = makeCanvas(width, height, platform);
  const ctx = resized.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    throw new Error("Mask refinement 读取图像失败：无法创建画布上下文");
  }
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(canvas, 0, 0, width, height);
  const data = ctx.getImageData(0, 0, width, height).data;
  const out = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < out.length; i += 1, p += 4) {
    out[i] = Math.round(data[p] * 0.299 + data[p + 1] * 0.587 + data[p + 2] * 0.114);
  }
  return out;
}

export function drawRectOutline(mask: Uint8Array, width: number, height: number, rect: Rect): void {
  const x0 = clamp(Math.floor(rect.x), 0, width - 1);
  const y0 = clamp(Math.floor(rect.y), 0, height - 1);
  const x1 = clamp(Math.floor(rect.x + rect.width), x0, width - 1);
  const y1 = clamp(Math.floor(rect.y + rect.height), y0, height - 1);

  for (let x = x0; x <= x1; x += 1) {
    mask[y0 * width + x] = 0;
    mask[y1 * width + x] = 0;
  }
  for (let y = y0; y <= y1; y += 1) {
    mask[y * width + x0] = 0;
    mask[y * width + x1] = 0;
  }
}

export function pointInPolygon(point: Point, polygon: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const pi = polygon[i];
    const pj = polygon[j];
    const intersect =
      pi.y > point.y !== pj.y > point.y &&
      point.x < ((pj.x - pi.x) * (point.y - pi.y)) / (pj.y - pi.y + 1e-12) + pi.x;
    if (intersect) {
      inside = !inside;
    }
  }
  return inside;
}

function distancePointToSegment(p: Point, a: Point, b: Point): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const apx = p.x - a.x;
  const apy = p.y - a.y;
  const abLen2 = abx * abx + aby * aby;
  if (abLen2 <= 1e-12) {
    return Math.hypot(apx, apy);
  }
  const t = clamp((apx * abx + apy * aby) / abLen2, 0, 1);
  const cx = a.x + abx * t;
  const cy = a.y + aby * t;
  return Math.hypot(p.x - cx, p.y - cy);
}

export function polygonDistanceToPoint(polygon: Point[], point: Point): number {
  if (polygon.length < 2) {
    return Number.POSITIVE_INFINITY;
  }
  if (pointInPolygon(point, polygon)) {
    return 0;
  }
  let minDist = Number.POSITIVE_INFINITY;
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    minDist = Math.min(minDist, distancePointToSegment(point, a, b));
  }
  return minDist;
}

function clipEdge(
  polygon: Point[],
  inside: (p: Point) => boolean,
  intersect: (a: Point, b: Point) => Point
): Point[] {
  if (polygon.length === 0) {
    return [];
  }
  const out: Point[] = [];
  for (let i = 0; i < polygon.length; i += 1) {
    const current = polygon[i];
    const prev = polygon[(i + polygon.length - 1) % polygon.length];
    const currentInside = inside(current);
    const prevInside = inside(prev);
    if (currentInside) {
      if (!prevInside) {
        out.push(intersect(prev, current));
      }
      out.push(current);
    } else if (prevInside) {
      out.push(intersect(prev, current));
    }
  }
  return out;
}

export function clipPolygonToRect(polygon: Point[], rect: Rect): Point[] {
  const xMin = rect.x;
  const yMin = rect.y;
  const xMax = rect.x + rect.width;
  const yMax = rect.y + rect.height;

  let clipped = [...polygon];
  clipped = clipEdge(
    clipped,
    (p) => p.x >= xMin,
    (a, b) => {
      const t = (xMin - a.x) / (b.x - a.x + 1e-12);
      return { x: xMin, y: a.y + (b.y - a.y) * t };
    }
  );
  clipped = clipEdge(
    clipped,
    (p) => p.x <= xMax,
    (a, b) => {
      const t = (xMax - a.x) / (b.x - a.x + 1e-12);
      return { x: xMax, y: a.y + (b.y - a.y) * t };
    }
  );
  clipped = clipEdge(
    clipped,
    (p) => p.y >= yMin,
    (a, b) => {
      const t = (yMin - a.y) / (b.y - a.y + 1e-12);
      return { x: a.x + (b.x - a.x) * t, y: yMin };
    }
  );
  clipped = clipEdge(
    clipped,
    (p) => p.y <= yMax,
    (a, b) => {
      const t = (yMax - a.y) / (b.y - a.y + 1e-12);
      return { x: a.x + (b.x - a.x) * t, y: yMax };
    }
  );
  return clipped;
}

export function polygonRectIntersectionArea(polygon: Point[], rect: Rect): number {
  const clipped = clipPolygonToRect(polygon, rect);
  return polygonArea(clipped);
}

export function scaleRegionPolygon(region: TextRegion, scale: number): Point[] {
  if (region.quad && region.quad.length === 4) {
    return region.quad.map((p) => ({ x: p.x * scale, y: p.y * scale }));
  }
  const x0 = region.box.x * scale;
  const y0 = region.box.y * scale;
  const x1 = (region.box.x + region.box.width) * scale;
  const y1 = (region.box.y + region.box.height) * scale;
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 }
  ];
}

export function polygonToBox(points: Point[], maxW: number, maxH: number): Rect {
  const minX = clamp(Math.floor(Math.min(...points.map((p) => p.x))), 0, maxW - 1);
  const minY = clamp(Math.floor(Math.min(...points.map((p) => p.y))), 0, maxH - 1);
  const maxX = clamp(Math.ceil(Math.max(...points.map((p) => p.x))), minX + 1, maxW);
  const maxY = clamp(Math.ceil(Math.max(...points.map((p) => p.y))), minY + 1, maxH);
  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY
  };
}

export function scaleRegions(regions: TextRegion[], scale: number, maxW: number, maxH: number): RegionMaskInfo[] {
  return regions.map((region) => {
    const scaledPolygon = scaleRegionPolygon(region, scale).map((p) => ({
      x: clamp(p.x, 0, maxW),
      y: clamp(p.y, 0, maxH)
    }));
    const box = polygonToBox(scaledPolygon, maxW, maxH);
    const area = Math.max(1, polygonArea(scaledPolygon));
    const textSize = region.fontSize && region.fontSize > 0
      ? Math.max(1, Math.round(region.fontSize * scale))
      : Math.max(1, Math.min(box.width, box.height));
    return {
      box,
      polygon: scaledPolygon,
      area,
      textSize
    };
  });
}

export function connectedComponents(mask: Uint8Array, width: number, height: number): Component[] {
  const pixelFastPath = (globalThis as typeof globalThis & {
    __shinobuColdStartPixelFastPath?: boolean;
  }).__shinobuColdStartPixelFastPath === true;
  const total = width * height;
  const visited = new Uint8Array(total);
  const queue = new Int32Array(total);
  const out: Component[] = [];

  for (let i = 0; i < total; i += 1) {
    if (mask[i] === 0 || visited[i] === 1) {
      continue;
    }

    let head = 0;
    let tail = 0;
    queue[tail] = i;
    tail += 1;
    visited[i] = 1;

    const pixels: number[] = [];
    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;

    while (head < tail) {
      const current = queue[head];
      head += 1;
      if (!pixelFastPath) pixels.push(current);

      const x = current % width;
      const y = Math.floor(current / width);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);

      const xStart = Math.max(0, x - 1);
      const xEnd = Math.min(width - 1, x + 1);
      const yStart = Math.max(0, y - 1);
      const yEnd = Math.min(height - 1, y + 1);
      for (let ny = yStart; ny <= yEnd; ny += 1) {
        for (let nx = xStart; nx <= xEnd; nx += 1) {
          if (nx === x && ny === y) {
            continue;
          }
          const next = ny * width + nx;
          if (visited[next] === 1 || mask[next] === 0) {
            continue;
          }
          visited[next] = 1;
          queue[tail] = next;
          tail += 1;
        }
      }
    }

    const compWidth = maxX - minX + 1;
    const compHeight = maxY - minY + 1;
    const area = tail;
    if (area <= 9 || compWidth <= 0 || compHeight <= 0) {
      continue;
    }

    out.push({
      pixels: pixelFastPath ? queue.slice(0, tail) : Int32Array.from(pixels),
      rect: {
        x: minX,
        y: minY,
        width: compWidth,
        height: compHeight
      },
      area,
      center: {
        x: minX + compWidth * 0.5,
        y: minY + compHeight * 0.5
      }
    });
  }

  return out;
}

export function dilate(mask: Uint8Array, width: number, height: number, kernelSize: number): Uint8Array {
  if (kernelSize <= 1) {
    return mask.slice();
  }
  const out = new Uint8Array(mask.length);
  const radius = Math.floor(kernelSize / 2);
  const radiusSquared = radius * radius + 0.25;
  // ponytail: row runs × radius; use a distance transform if fragmented large kernels become slow.
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    const runs: number[] = [];
    for (let x = 0; x < width;) {
      if (mask[row + x] === 0) { x += 1; continue; }
      const start = x++;
      while (x < width && mask[row + x] !== 0) x += 1;
      runs.push(start, x - 1);
    }
    if (runs.length === 0) continue;
    for (let dy = Math.max(-radius, -y); dy <= Math.min(radius, height - 1 - y); dy += 1) {
      const halfWidth = Math.floor(Math.sqrt(radiusSquared - dy * dy));
      const destinationRow = (y + dy) * width;
      let start = Math.max(0, runs[0] - halfWidth);
      let end = Math.min(width - 1, runs[1] + halfWidth);
      for (let i = 2; i < runs.length; i += 2) {
        const nextStart = Math.max(0, runs[i] - halfWidth);
        const nextEnd = Math.min(width - 1, runs[i + 1] + halfWidth);
        if (nextStart <= end + 1) end = Math.max(end, nextEnd);
        else {
          out.fill(1, destinationRow + start, destinationRow + end + 1);
          start = nextStart;
          end = nextEnd;
        }
      }
      out.fill(1, destinationRow + start, destinationRow + end + 1);
    }
  }
  return out;
}

export function computeScaleFactor(rawMaskHeight: number, imageHeight: number): number {
  if (rawMaskHeight <= 0 || imageHeight <= 0) {
    return 1;
  }
  return Math.max(Math.min((rawMaskHeight - imageHeight / 3) / rawMaskHeight, 1), 0.5);
}

export function toMaskCanvas(mask: Uint8Array, width: number, height: number, outW: number, outH: number, platform: PlatformProvider): PipelineCanvas {
  const pixelFastPath = (globalThis as typeof globalThis & {
    __shinobuColdStartPixelFastPath?: boolean;
  }).__shinobuColdStartPixelFastPath === true;
  const opaqueBlack = new Uint32Array(new Uint8Array([0, 0, 0, 255]).buffer)[0];
  const src = makeCanvas(width, height, platform);
  const srcCtx = src.getContext("2d");
  if (!srcCtx) {
    throw new Error("Mask refinement 输出失败：无法创建源画布上下文");
  }
  const imageData = srcCtx.createImageData(width, height);
  if (pixelFastPath && imageData.data.byteOffset % 4 === 0) {
    const pixels = new Uint32Array(imageData.data.buffer, imageData.data.byteOffset, mask.length);
    for (let i = 0; i < mask.length; i += 1) {
      pixels[i] = mask[i] > 0 ? 0xffffffff : opaqueBlack;
    }
  } else for (let i = 0, p = 0; i < mask.length; i += 1, p += 4) {
    const v = mask[i] > 0 ? 255 : 0;
    imageData.data[p] = v;
    imageData.data[p + 1] = v;
    imageData.data[p + 2] = v;
    imageData.data[p + 3] = 255;
  }
  srcCtx.putImageData(imageData, 0, 0);

  const out = makeCanvas(outW, outH, platform);
  const outCtx = out.getContext("2d", { willReadFrequently: true });
  if (!outCtx) {
    throw new Error("Mask refinement 输出失败：无法创建目标画布上下文");
  }
  outCtx.imageSmoothingEnabled = true;
  outCtx.drawImage(src, 0, 0, outW, outH);
  const nativeThreshold = tryNativeOpaqueMaskThreshold(out, platform);
  if (nativeThreshold) return nativeThreshold;
  const outData = outCtx.getImageData(0, 0, outW, outH);
  if (pixelFastPath && outData.data.byteOffset % 4 === 0) {
    const pixels = new Uint32Array(outData.data.buffer, outData.data.byteOffset, outW * outH);
    for (let i = 0; i < pixels.length; i += 1) {
      pixels[i] = outData.data[i * 4] > 127 ? 0xffffffff : opaqueBlack;
    }
  } else for (let p = 0; p < outData.data.length; p += 4) {
    const v = outData.data[p] > 127 ? 255 : 0;
    outData.data[p] = v;
    outData.data[p + 1] = v;
    outData.data[p + 2] = v;
    outData.data[p + 3] = 255;
  }
  outCtx.putImageData(outData, 0, 0);
  return out;
}

export function hasForeground(mask: Uint8Array): boolean {
  for (let i = 0; i < mask.length; i += 1) {
    if (mask[i] > 0) {
      return true;
    }
  }
  return false;
}

export function extractSubMask(mask: Uint8Array, width: number, rect: Rect): Uint8Array {
  const out = new Uint8Array(rect.width * rect.height);
  for (let y = 0; y < rect.height; y += 1) {
    const srcRow = (rect.y + y) * width + rect.x;
    const dstRow = y * rect.width;
    out.set(mask.subarray(srcRow, srcRow + rect.width), dstRow);
  }
  return out;
}

export function replaceSubMask(mask: Uint8Array, width: number, rect: Rect, sub: Uint8Array): void {
  for (let y = 0; y < rect.height; y += 1) {
    const dstRow = (rect.y + y) * width + rect.x;
    const srcRow = y * rect.width;
    mask.set(sub.subarray(srcRow, srcRow + rect.width), dstRow);
  }
}

export function orSubMask(mask: Uint8Array, width: number, rect: Rect, sub: Uint8Array): void {
  for (let y = 0; y < rect.height; y += 1) {
    const dstRow = (rect.y + y) * width + rect.x;
    const srcRow = y * rect.width;
    for (let x = 0; x < rect.width; x += 1) {
      if (sub[srcRow + x] > 0) {
        mask[dstRow + x] = 1;
      }
    }
  }
}

export function extractSubGray(gray: Uint8Array, width: number, rect: Rect): Uint8Array {
  const out = new Uint8Array(rect.width * rect.height);
  for (let y = 0; y < rect.height; y += 1) {
    const srcRow = (rect.y + y) * width + rect.x;
    const dstRow = y * rect.width;
    out.set(gray.subarray(srcRow, srcRow + rect.width), dstRow);
  }
  return out;
}

export function otsuThreshold(gray: Uint8Array): number {
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i += 1) {
    hist[gray[i]] += 1;
  }
  const total = gray.length;
  let sumAll = 0;
  for (let i = 0; i < 256; i += 1) {
    sumAll += i * hist[i];
  }

  let sumB = 0;
  let wB = 0;
  let maxVar = -1;
  let threshold = 127;
  for (let t = 0; t < 256; t += 1) {
    wB += hist[t];
    if (wB === 0) {
      continue;
    }
    const wF = total - wB;
    if (wF === 0) {
      break;
    }
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > maxVar) {
      maxVar = between;
      threshold = t;
    }
  }
  return threshold;
}

export function xorCost(a: Uint8Array, b: Uint8Array): number {
  let cost = 0;
  for (let i = 0; i < a.length; i += 1) {
    if ((a[i] > 0) !== (b[i] > 0)) {
      cost += 1;
    }
  }
  return cost;
}

export function refineRegionMask(gray: Uint8Array, seedMask: Uint8Array): Uint8Array {
  if (!hasForeground(seedMask)) {
    return seedMask.slice();
  }
  const threshold = otsuThreshold(gray);
  const candidate = new Uint8Array(gray.length);
  const inverse = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i += 1) {
    const isDark = gray[i] <= threshold ? 1 : 0;
    candidate[i] = isDark;
    inverse[i] = isDark === 1 ? 0 : 1;
  }
  const costCandidate = xorCost(candidate, seedMask);
  const costInverse = xorCost(inverse, seedMask);
  const chosen = costCandidate <= costInverse ? candidate : inverse;
  if (!hasForeground(chosen)) {
    return seedMask.slice();
  }
  return chosen;
}

export type FlatBoxInkOptions = {
  /** 框内「接近背景色」的像素至少占多少比例，才认为这是气泡/纯色底板。 */
  minFlatShare?: number;
  /** 与背景灰度的差超过这个值就算笔画像素。 */
  inkDelta?: number;
  /** 笔画像素占比的上下限：太低说明没字，太高说明这是画面而不是文字框。 */
  minInkShare?: number;
  maxInkShare?: number;
};

export type FlatBoxInkResult = {
  /** 与 `rect` 同尺寸的笔画掩码，1 表示需要擦除。 */
  mask: Uint8Array;
  rect: Rect;
  /** 框内接近背景色的像素占比。 */
  flatShare: number;
  /** 笔画像素占比。 */
  inkShare: number;
};

/**
 * 兜底上墨：把「背景基本平坦」的文字框里所有与背景色不同的像素（也就是笔画）标成 1。
 *
 * 检测模型给出的连通域偶尔会漏掉笔画——尤其是行末一个窄字（例如韩文「고」）、
 * 带描边的粗体边缘、以及被检测框切断的字。漏掉的笔画不会被擦除，排版后译文就压在
 * 原文上，看起来像「翻译了但没去字」。
 *
 * 只在气泡这类「背景是一整块浅色」的框里启用：先用灰度直方图求背景色，要求框内
 * 大半像素都贴近背景色；再按与背景的差值取笔画。背景是画面/网点时直接放弃，
 * 避免把画稿当成字擦掉。
 */
export function fillInkInFlatBox(
  gray: Uint8Array,
  width: number,
  height: number,
  rect: Rect,
  options: FlatBoxInkOptions = {},
): FlatBoxInkResult | null {
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(width, Math.ceil(rect.x + rect.width));
  const y1 = Math.min(height, Math.ceil(rect.y + rect.height));
  const boxWidth = x1 - x0;
  const boxHeight = y1 - y0;
  if (boxWidth <= 0 || boxHeight <= 0) {
    return null;
  }

  const histogram = new Uint32Array(256);
  const total = boxWidth * boxHeight;
  for (let y = y0; y < y1; y += 1) {
    const row = y * width;
    for (let x = x0; x < x1; x += 1) {
      histogram[gray[row + x]] += 1;
    }
  }

  // 中位灰度当背景：文字笔画无论黑白都只占少数，中位数不会落在笔画上。
  const half = total >> 1;
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
  let flatCount = 0;
  let inkCount = 0;
  const mask = new Uint8Array(total);
  for (let y = 0; y < boxHeight; y += 1) {
    const row = (y0 + y) * width + x0;
    for (let x = 0; x < boxWidth; x += 1) {
      const delta = Math.abs(gray[row + x] - background);
      if (delta <= flatTolerance) {
        flatCount += 1;
      } else if (delta > inkDelta) {
        mask[y * boxWidth + x] = 1;
        inkCount += 1;
      }
    }
  }

  const flatShare = flatCount / total;
  const inkShare = inkCount / total;
  // 阈值与 residualInk.shouldRepairResidual 对齐（flatShare>=0.5、inkShare<=0.42）：
  // 那边是"残留修复"的护栏，这里如果放得更宽，同一块深色网点/贴图（inkShare
  // 0.42~0.6）会被残留修复拒绝、却被这里的兜底上墨整块标成待擦、涂成底色——
  // 正是护栏要防的事。上面的 mask 仍会返回给调用方做诊断展示。
  if (flatShare < (options.minFlatShare ?? 0.5)) {
    return null;
  }
  if (inkShare < (options.minInkShare ?? 0.01) || inkShare > (options.maxInkShare ?? 0.42)) {
    return null;
  }
  return {
    mask,
    rect: { x: x0, y: y0, width: boxWidth, height: boxHeight },
    flatShare,
    inkShare,
  };
}

const BRIGHT_THRESHOLD = 40;
const OUTLINE_RATIO_THRESHOLD = 0.5;

function outsideGrayQuarterHistogram(
  gray: Uint8Array,
  mask: Uint8Array,
  width: number,
  rx0: number,
  ry0: number,
  rx1: number,
  ry1: number,
): number | undefined {
  const histogram = new Uint32Array(256);
  let count = 0;
  for (let y = ry0; y <= ry1; y += 1) {
    for (let x = rx0; x <= rx1; x += 1) {
      const index = y * width + x;
      if (mask[index] === 0) {
        histogram[gray[index]] += 1;
        count += 1;
      }
    }
  }
  if (count === 0) return undefined;
  const targetIndex = Math.floor(count * 0.25);
  let cumulative = 0;
  for (let value = 0; value < histogram.length; value += 1) {
    cumulative += histogram[value];
    if (cumulative > targetIndex) return value;
  }
  return undefined;
}

export function detectOutlineWidth(
  gray: Uint8Array,
  mask: Uint8Array,
  width: number,
  height: number,
  regionRect: Rect,
  textSize: number
): number {
  const rx0 = Math.max(0, Math.floor(regionRect.x));
  const ry0 = Math.max(0, Math.floor(regionRect.y));
  const rx1 = Math.min(width - 1, Math.floor(regionRect.x + regionRect.width));
  const ry1 = Math.min(height - 1, Math.floor(regionRect.y + regionRect.height));

  // 1. 计算背景亮度（使用 Q1 避免描边像素抬高背景估计）
  let bgMedian: number;
  if ((globalThis as { __shinobuColdStartMaskHistogram?: boolean }).__shinobuColdStartMaskHistogram === true) {
    const quarter = outsideGrayQuarterHistogram(gray, mask, width, rx0, ry0, rx1, ry1);
    if (quarter === undefined) return 0;
    bgMedian = quarter;
  } else {
    const outsideGray: number[] = [];
    for (let y = ry0; y <= ry1; y += 1) {
      for (let x = rx0; x <= rx1; x += 1) {
        if (mask[y * width + x] === 0) {
          outsideGray.push(gray[y * width + x]);
        }
      }
    }
    if (outsideGray.length === 0) {
      return 0;
    }
    outsideGray.sort((a, b) => a - b);
    bgMedian = outsideGray[Math.floor(outsideGray.length * 0.25)];
  }

  // 2. 找 mask 边界像素
  const boundaryPixels: Array<{ x: number; y: number }> = [];
  for (let y = ry0; y <= ry1; y += 1) {
    for (let x = rx0; x <= rx1; x += 1) {
      if (mask[y * width + x] === 0) {
        continue;
      }
      const hasOutsideNeighbor =
        (x > 0 && mask[y * width + x - 1] === 0) ||
        (x < width - 1 && mask[y * width + x + 1] === 0) ||
        (y > 0 && mask[(y - 1) * width + x] === 0) ||
        (y < height - 1 && mask[(y + 1) * width + x] === 0) ||
        (x > 0 && y > 0 && mask[(y - 1) * width + x - 1] === 0) ||
        (x < width - 1 && y > 0 && mask[(y - 1) * width + x + 1] === 0) ||
        (x > 0 && y < height - 1 && mask[(y + 1) * width + x - 1] === 0) ||
        (x < width - 1 && y < height - 1 && mask[(y + 1) * width + x + 1] === 0);
      if (hasOutsideNeighbor) {
        boundaryPixels.push({ x, y });
      }
    }
  }
  if (boundaryPixels.length === 0) {
    return 0;
  }

  // 3. 向外扫描描边宽度（允许穿过抗锯齿过渡区）
  const maxScanDist = Math.max(4, Math.floor(textSize * 0.3));
  const directions: Array<{ dx: number; dy: number }> = [
    { dx: -1, dy: 0 },
    { dx: 1, dy: 0 },
    { dx: 0, dy: -1 },
    { dx: 0, dy: 1 },
  ];
  const outlineDists: number[] = [];

  for (const bp of boundaryPixels) {
    let maxDist = 0;
    for (const dir of directions) {
      let dist = 0;
      let reachedBright = false;
      let cx = bp.x + dir.dx;
      let cy = bp.y + dir.dy;
      while (dist < maxScanDist) {
        if (cx < 0 || cx >= width || cy < 0 || cy >= height) {
          break;
        }
        const idx = cy * width + cx;
        if (mask[idx] !== 0) {
          break;
        }
        if (gray[idx] > bgMedian + BRIGHT_THRESHOLD) {
          reachedBright = true;
        } else if (gray[idx] <= bgMedian) {
          break;
        }
        dist += 1;
        cx += dir.dx;
        cy += dir.dy;
      }
      if (reachedBright) {
        maxDist = Math.max(maxDist, dist);
      }
    }
    if (maxDist > 0) {
      outlineDists.push(maxDist);
    }
  }

  // 4. 判定描边存在
  const outlineRatio = outlineDists.length / boundaryPixels.length;
  if (outlineRatio < OUTLINE_RATIO_THRESHOLD) {
    return 0;
  }

  // 5. 测量描边宽度（中位数）
  outlineDists.sort((a, b) => a - b);
  return outlineDists[Math.floor(outlineDists.length / 2)];
}

export function extendRect(rect: Rect, maxX: number, maxY: number, extendSize: number): Rect {
  const x = Math.max(Math.floor(rect.x - extendSize), 0);
  const y = Math.max(Math.floor(rect.y - extendSize), 0);
  const width = Math.min(Math.floor(rect.width + extendSize * 2), maxX - x - 1);
  const height = Math.min(Math.floor(rect.height + extendSize * 2), maxY - y - 1);
  return {
    x,
    y,
    width: Math.max(1, width),
    height: Math.max(1, height)
  };
}
