import type { Rect, TextRegion } from "../../types";
import type { PlatformProvider, PipelineImage, PipelineCanvas } from "../../runtime/platform";
import type { ModelRuntime, RuntimeProvider } from '@shinobu/model-runtime';
import { connectedComponents, makeRegion } from "./onnxDetect";

/**
 * PP-OCRv6_medium_det 的 DB 检测后处理参数，取自官方 inference.yml：
 * box_thresh 0.45 / thresh 0.2 / unclip_ratio 1.4。
 * 这里的角色是「召回兜底」：漫画检测器（comic-text-detector）对气泡台词很准，
 * 但对贴在网点、画面纹理上的小字/拟声词容易整块漏掉，PaddleOCR 的通用 DB
 * 检测器能把这类文字捞回来，再与主检测结果取并集。
 */
export const PADDLE_DET_PIXEL_THRESH = 0.2;
export const PADDLE_DET_BOX_THRESH = 0.45;
export const PADDLE_DET_UNCLIP_RATIO = 1.4;
export const PADDLE_DET_MAX_SIDE = 960;
const PADDLE_DET_SIZE_ALIGN = 32;
const PADDLE_DET_MIN_SIDE = 6;
/** 兜底框相对整页面积上限，超过基本是整块画面纹理被误检。 */
const PADDLE_DET_MAX_AREA_RATIO = 0.35;
/** 兜底框最多追加数量，防止误检刷屏。 */
const PADDLE_DET_MAX_RECALL_BOXES = 60;
/** 与新框重叠达到该比例的旧框视为「已覆盖」，不再重复添加。 */
const PADDLE_DET_COVERED_RATIO = 0.35;

const IMAGENET_MEAN = [0.485, 0.456, 0.406] as const;
const IMAGENET_STD = [0.229, 0.224, 0.225] as const;

export type PaddleDetGeometry = {
  /** 送入模型的画布宽（对齐到 32 的倍数）。 */
  inputWidth: number;
  /** 送入模型的画布高。 */
  inputHeight: number;
  /** 画布坐标 = 原图坐标 * scale。 */
  scale: number;
};

export type PaddleDetBox = {
  box: Rect;
  score: number;
};

export type PaddleDetRecallResult = {
  regions: TextRegion[];
  provider?: RuntimeProvider;
  geometry?: PaddleDetGeometry;
  rawBoxCount: number;
  rejectedByScore: number;
  durationMs: number;
};

/** 按官方 DetResizeForTest 的规则算目标尺寸：等比缩到 maxSide，宽高对齐到 32。 */
export function planPaddleDetInput(
  width: number,
  height: number,
  maxSide: number = PADDLE_DET_MAX_SIDE,
): PaddleDetGeometry {
  const safeWidth = Math.max(1, Math.floor(width));
  const safeHeight = Math.max(1, Math.floor(height));
  const limit = Math.max(PADDLE_DET_SIZE_ALIGN, Math.floor(maxSide));
  const scale = Math.min(1, limit / Math.max(safeWidth, safeHeight));
  const align = (value: number): number => Math.max(
    PADDLE_DET_SIZE_ALIGN,
    Math.min(limit, Math.round(value / PADDLE_DET_SIZE_ALIGN) * PADDLE_DET_SIZE_ALIGN),
  );
  return {
    inputWidth: align(safeWidth * scale),
    inputHeight: align(safeHeight * scale),
    scale,
  };
}

/** BGR + ImageNet 均值方差，和官方 NormalizeImage 一致。 */
export function buildPaddleDetInput(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
): Float32Array {
  const plane = width * height;
  const input = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i += 1) {
    const offset = i * 4;
    const r = rgba[offset] / 255;
    const g = rgba[offset + 1] / 255;
    const b = rgba[offset + 2] / 255;
    input[i] = (b - IMAGENET_MEAN[0]) / IMAGENET_STD[0];
    input[plane + i] = (g - IMAGENET_MEAN[1]) / IMAGENET_STD[1];
    input[2 * plane + i] = (r - IMAGENET_MEAN[2]) / IMAGENET_STD[2];
  }
  return input;
}

function clampRect(rect: Rect, width: number, height: number): Rect | null {
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(width, Math.ceil(rect.x + rect.width));
  const y1 = Math.min(height, Math.ceil(rect.y + rect.height));
  if (x1 - x0 < 1 || y1 - y0 < 1) {
    return null;
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** DB 的 unclip：按面积/周长比例向外扩，等价于 pyclipper 的 offset 距离。 */
export function unclipDetRect(rect: Rect, ratio: number = PADDLE_DET_UNCLIP_RATIO): Rect {
  const perimeter = 2 * (rect.width + rect.height);
  const distance = perimeter > 0 ? (rect.width * rect.height * ratio) / perimeter : 0;
  return {
    x: rect.x - distance,
    y: rect.y - distance,
    width: rect.width + 2 * distance,
    height: rect.height + 2 * distance,
  };
}

function meanProbability(
  prob: Float32Array,
  width: number,
  rect: Rect,
): number {
  const x0 = Math.max(0, rect.x);
  const y0 = Math.max(0, rect.y);
  const x1 = Math.min(width, rect.x + rect.width);
  const step = Math.max(1, Math.floor(Math.max(rect.width, rect.height) / 24));
  let sum = 0;
  let count = 0;
  for (let y = y0; y < Math.min(prob.length / width, rect.y + rect.height); y += step) {
    const row = y * width;
    for (let x = x0; x < x1; x += step) {
      sum += prob[row + x];
      count += 1;
    }
  }
  return count > 0 ? sum / count : 0;
}

/**
 * prob map → 文本框。先按 thresh 二值化取连通域，再用连通域内的平均概率
 * 过 box_thresh，最后 unclip 还原行框外沿。
 */
export function postProcessDbProbMap(
  prob: Float32Array,
  mapWidth: number,
  mapHeight: number,
  options: {
    pixelThresh?: number;
    boxThresh?: number;
    unclipRatio?: number;
    minSide?: number;
  } = {},
): { boxes: PaddleDetBox[]; rejectedByScore: number } {
  const pixelThresh = options.pixelThresh ?? PADDLE_DET_PIXEL_THRESH;
  const boxThresh = options.boxThresh ?? PADDLE_DET_BOX_THRESH;
  const unclipRatio = options.unclipRatio ?? PADDLE_DET_UNCLIP_RATIO;
  const minSide = options.minSide ?? PADDLE_DET_MIN_SIDE;
  const total = mapWidth * mapHeight;
  if (total <= 0 || prob.length < total) {
    return { boxes: [], rejectedByScore: 0 };
  }

  const binary = new Uint8Array(total);
  for (let i = 0; i < total; i += 1) {
    binary[i] = prob[i] > pixelThresh ? 1 : 0;
  }

  const boxes: PaddleDetBox[] = [];
  let rejectedByScore = 0;
  for (const component of connectedComponents(binary, mapWidth, mapHeight)) {
    const score = meanProbability(prob, mapWidth, component);
    if (score < boxThresh) {
      rejectedByScore += 1;
      continue;
    }
    const expanded = clampRect(unclipDetRect(component, unclipRatio), mapWidth, mapHeight);
    if (!expanded) {
      continue;
    }
    if (expanded.width < minSide || expanded.height < minSide) {
      continue;
    }
    boxes.push({ box: expanded, score });
  }
  return { boxes, rejectedByScore };
}

function area(rect: Rect): number {
  return Math.max(0, rect.width) * Math.max(0, rect.height);
}

function intersectionArea(left: Rect, right: Rect): number {
  const x0 = Math.max(left.x, right.x);
  const y0 = Math.max(left.y, right.y);
  const x1 = Math.min(left.x + left.width, right.x + right.width);
  const y1 = Math.min(left.y + left.height, right.y + right.height);
  if (x1 <= x0 || y1 <= y0) {
    return 0;
  }
  return (x1 - x0) * (y1 - y0);
}

function centerInside(point: { x: number; y: number }, rect: Rect): boolean {
  return (
    point.x >= rect.x
    && point.x <= rect.x + rect.width
    && point.y >= rect.y
    && point.y <= rect.y + rect.height
  );
}

/**
 * 把兜底检测的框并进主检测结果：
 * - 已经被主检测框覆盖（覆盖比 ≥ 0.35 或中心点落在框内）的丢弃，避免重复翻译；
 * - 与已追加的兜底框高度重叠的丢弃；
 * - 面积超过整页 35%、或长宽比过大的丢弃（基本是画面纹理）。
 */
export function mergeRecallRegions(
  base: TextRegion[],
  extra: TextRegion[],
  imageSize?: { width: number; height: number },
): TextRegion[] {
  const imageArea = imageSize ? Math.max(1, imageSize.width * imageSize.height) : 0;
  const accepted: TextRegion[] = [];
  for (const candidate of extra) {
    const candidateArea = area(candidate.box);
    if (candidateArea <= 0) {
      continue;
    }
    if (imageArea > 0 && candidateArea / imageArea > PADDLE_DET_MAX_AREA_RATIO) {
      continue;
    }
    const longSide = Math.max(candidate.box.width, candidate.box.height);
    const shortSide = Math.max(1, Math.min(candidate.box.width, candidate.box.height));
    if (longSide / shortSide > 20) {
      continue;
    }
    const center = {
      x: candidate.box.x + candidate.box.width / 2,
      y: candidate.box.y + candidate.box.height / 2,
    };
    const coveredByBase = base.some((region) => (
      centerInside(center, region.box)
      || intersectionArea(region.box, candidate.box) / candidateArea >= PADDLE_DET_COVERED_RATIO
    ));
    if (coveredByBase) {
      continue;
    }
    const duplicatesAccepted = accepted.some((region) => (
      intersectionArea(region.box, candidate.box) / candidateArea >= 0.6
    ));
    if (duplicatesAccepted) {
      continue;
    }
    accepted.push(candidate);
    if (accepted.length >= PADDLE_DET_MAX_RECALL_BOXES) {
      break;
    }
  }
  return [...base, ...accepted];
}

function resolveRuntimeProviders(modelRuntime?: RuntimeProvider[]): RuntimeProvider[] {
  return modelRuntime && modelRuntime.length > 0 ? modelRuntime : ['webgpu', 'webnn', 'wasm'];
}

export function isPaddleDetRecallEnabled(override?: boolean): boolean {
  if (override === false) {
    return false;
  }
  const flag = (globalThis as { __shinobuPaddleDetRecall?: boolean }).__shinobuPaddleDetRecall;
  return flag !== false;
}

function drawScaledImage(
  image: PipelineImage,
  platform: PlatformProvider,
  geometry: PaddleDetGeometry,
): PipelineCanvas {
  const canvas = platform.createCanvas(geometry.inputWidth, geometry.inputHeight);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    throw new Error('PaddleOCR 检测召回：无法创建画布');
  }
  ctx.fillStyle = 'black';
  ctx.fillRect(0, 0, geometry.inputWidth, geometry.inputHeight);
  ctx.drawImage(image, 0, 0, geometry.inputWidth, geometry.inputHeight);
  return canvas;
}

/**
 * 用 PP-OCRv6_medium_det 跑一遍检测，返回原图坐标下的文本区域。
 * 失败不抛给上层：召回是可选增强，主检测结果仍然可用。
 */
export async function detectWithPaddleDetRecall(
  image: PipelineImage,
  platform: PlatformProvider,
  modelRuntime: ModelRuntime,
): Promise<PaddleDetRecallResult> {
  const startedAt = performance.now();
  const model = await modelRuntime.readModel('paddleocr_v6_medium_det');
  const session = await modelRuntime.getSession(
    'paddleocr_v6_medium_det',
    resolveRuntimeProviders(model.runtime),
  );
  const geometry = planPaddleDetInput(image.naturalWidth, image.naturalHeight, model.input[0]);
  const canvas = drawScaledImage(image, platform, geometry);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    throw new Error('PaddleOCR 检测召回：无法读取画布像素');
  }
  const rgba = ctx.getImageData(0, 0, geometry.inputWidth, geometry.inputHeight).data;
  const inputData = buildPaddleDetInput(rgba, geometry.inputWidth, geometry.inputHeight);
  const inputName = session.inputNames[0];
  if (!inputName) {
    throw new Error('PaddleOCR 检测召回：模型缺少输入名称');
  }
  const result = await modelRuntime.run(session.sessionId, {
    [inputName]: {
      data: inputData,
      dims: [1, 3, geometry.inputHeight, geometry.inputWidth],
      type: 'float32' as const,
    },
  });
  if (result.error) {
    throw new Error(result.error);
  }
  const output = result.outputs[session.outputNames[0]] ?? Object.values(result.outputs)[0];
  if (!output || !(output.data instanceof Float32Array) || output.dims.length < 3) {
    throw new Error('PaddleOCR 检测召回：输出不是概率图');
  }
  const mapHeight = output.dims[output.dims.length - 2] ?? geometry.inputHeight;
  const mapWidth = output.dims[output.dims.length - 1] ?? geometry.inputWidth;
  const { boxes, rejectedByScore } = postProcessDbProbMap(output.data, mapWidth, mapHeight);
  const mapScaleX = geometry.inputWidth / Math.max(1, mapWidth);
  const mapScaleY = geometry.inputHeight / Math.max(1, mapHeight);
  const toImage = (value: number, mapScale: number, offsetScale: number): number => (
    (value * mapScale) / Math.max(1e-6, offsetScale)
  );

  const regions: TextRegion[] = [];
  for (const { box, score } of boxes) {
    const scaled = clampRect({
      x: toImage(box.x, mapScaleX, geometry.scale),
      y: toImage(box.y, mapScaleY, geometry.scale),
      width: toImage(box.width, mapScaleX, geometry.scale),
      height: toImage(box.height, mapScaleY, geometry.scale),
    }, image.naturalWidth, image.naturalHeight);
    if (!scaled) {
      continue;
    }
    const region = makeRegion(scaled);
    region.prob = score;
    regions.push(region);
  }

  return {
    regions,
    provider: session.provider,
    geometry,
    rawBoxCount: boxes.length,
    rejectedByScore,
    durationMs: performance.now() - startedAt,
  };
}
