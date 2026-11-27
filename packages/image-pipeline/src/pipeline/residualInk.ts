import type { Rect } from "../types";
import type {
  PipelineCanvas,
  PipelineImageData,
  PlatformProvider,
} from "../runtime/platform";

/**
 * 擦除后的残留检查。
 *
 * 遮罩是按检测器输出的低分辨率 mask 细化的，长条图（16000px 高）缩到 960px 后
 * 一行字只剩一个像素高，遮挡框、连通域归属、分带擦除任何一环出偏差，结果都是
 * 「译文画上去了，原文还在底下」。这类问题在日志里看不出来（遮罩覆盖率是有值的），
 * 只能在像素层面比对：原图这里是笔画、擦除后这里还是笔画，就说明没擦掉。
 */

/** 判定「这是笔画」的灰度差：相对框内背景色。 */
export const RESIDUAL_INK_DELTA = 30;
/** 擦除后仍保持这个灰度差的像素，视为没被擦掉。 */
export const RESIDUAL_KEEP_DELTA = 22;
/** 残留占原笔画比例超过这个值才动手修（正常擦除会剩几个抗锯齿像素）。 */
export const RESIDUAL_REPAIR_RATIO = 0.35;

export type ResidualInkAssessment = {
  /** 框内背景灰度（擦除后取中位数）。 */
  background: number;
  /** 原图里属于笔画的像素数。 */
  inkCount: number;
  /** 擦除后仍然是笔画的像素数。 */
  residualCount: number;
  /** residualCount / inkCount。 */
  residualRatio: number;
  /** 擦除后「接近背景」的像素占比，太低说明这块不是干净底板，不该修。 */
  flatShare: number;
};

const luma = (r: number, g: number, b: number): number => 0.299 * r + 0.587 * g + 0.114 * b;

function clipRect(box: Rect, width: number, height: number): Rect | null {
  const x0 = Math.max(0, Math.floor(box.x));
  const y0 = Math.max(0, Math.floor(box.y));
  const x1 = Math.min(width, Math.ceil(box.x + box.width));
  const y1 = Math.min(height, Math.ceil(box.y + box.height));
  if (x1 <= x0 || y1 <= y0) {
    return null;
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/**
 * 判断某个框「原文有没有被擦掉」。
 * `original` / `cleaned` 是同一张画布的整幅 RGBA 数据（region 用 box 在内部裁）。
 */
export function assessResidualInk(
  original: Uint8ClampedArray,
  cleaned: Uint8ClampedArray,
  width: number,
  height: number,
  box: Rect,
): ResidualInkAssessment | null {
  const rect = clipRect(box, width, height);
  if (!rect) {
    return null;
  }
  const total = rect.width * rect.height;
  if (total < 64) {
    return null;
  }

  // 擦除后这块本来应该是背景，所以中位灰度就是背景色（笔画只占少数，不影响中位数）。
  const histogram = new Uint32Array(256);
  for (let y = 0; y < rect.height; y += 1) {
    const row = ((rect.y + y) * width + rect.x) * 4;
    for (let x = 0; x < rect.width; x += 1) {
      const p = row + x * 4;
      histogram[Math.round(luma(cleaned[p], cleaned[p + 1], cleaned[p + 2]))] += 1;
    }
  }
  let cumulative = 0;
  let median = 128;
  for (let value = 0; value < 256; value += 1) {
    cumulative += histogram[value];
    if (cumulative > total / 2) {
      median = value;
      break;
    }
  }

  let inkCount = 0;
  let residualCount = 0;
  let flatCount = 0;
  const flatTolerance = 12;
  for (let y = 0; y < rect.height; y += 1) {
    const row = ((rect.y + y) * width + rect.x) * 4;
    for (let x = 0; x < rect.width; x += 1) {
      const p = row + x * 4;
      const before = luma(original[p], original[p + 1], original[p + 2]);
      const after = luma(cleaned[p], cleaned[p + 1], cleaned[p + 2]);
      if (Math.abs(after - median) <= flatTolerance) {
        flatCount += 1;
      }
      if (Math.abs(before - median) <= RESIDUAL_INK_DELTA) {
        continue;
      }
      inkCount += 1;
      if (Math.abs(after - median) > RESIDUAL_KEEP_DELTA) {
        residualCount += 1;
      }
    }
  }

  return {
    background: median,
    inkCount,
    residualCount,
    residualRatio: inkCount > 0 ? residualCount / inkCount : 0,
    flatShare: flatCount / total,
  };
}

/** 这个判定结果值不值得修。 */
export function shouldRepairResidual(assessment: ResidualInkAssessment | null): boolean {
  if (!assessment) {
    return false;
  }
  if (assessment.inkCount < 20 || assessment.residualCount < 20) {
    return false;
  }
  // 底板不干净（插画、网点、渐变很重）时不要盲修，容易把画面涂花。
  if (assessment.flatShare < 0.5) {
    return false;
  }
  return assessment.residualRatio >= RESIDUAL_REPAIR_RATIO;
}

/**
 * 把残留笔画用周边背景色扩散填掉。只改 `cleaned` 里的残留像素（含 2px 外扩），
 * 返回实际改动的像素数。纯像素运算，不依赖画布实现。
 */
export function repairResidualInk(
  original: Uint8ClampedArray,
  cleaned: Uint8ClampedArray,
  width: number,
  height: number,
  box: Rect,
  assessment: ResidualInkAssessment,
): number {
  const rect = clipRect(box, width, height);
  if (!rect) {
    return 0;
  }
  const total = rect.width * rect.height;
  const background = assessment.background;
  const target = new Uint8Array(total);
  for (let y = 0; y < rect.height; y += 1) {
    const row = ((rect.y + y) * width + rect.x) * 4;
    for (let x = 0; x < rect.width; x += 1) {
      const p = row + x * 4;
      const before = luma(original[p], original[p + 1], original[p + 2]);
      const after = luma(cleaned[p], cleaned[p + 1], cleaned[p + 2]);
      if (Math.abs(before - background) > RESIDUAL_INK_DELTA
        && Math.abs(after - background) > RESIDUAL_KEEP_DELTA) {
        target[y * rect.width + x] = 1;
      }
    }
  }

  // 外扩 2px 吃掉抗锯齿描边，否则填完还留一圈灰。
  const grown = new Uint8Array(total);
  for (let y = 0; y < rect.height; y += 1) {
    for (let x = 0; x < rect.width; x += 1) {
      if (!target[y * rect.width + x]) continue;
      for (let dy = -2; dy <= 2; dy += 1) {
        const ny = y + dy;
        if (ny < 0 || ny >= rect.height) continue;
        for (let dx = -2; dx <= 2; dx += 1) {
          const nx = x + dx;
          if (nx < 0 || nx >= rect.width) continue;
          grown[ny * rect.width + nx] = 1;
        }
      }
    }
  }

  // 从「本来就没有笔画」的像素往内一层层推：每一轮只填「有已填邻居」的像素，
  // 取邻居均值。这样渐变底板能顺着接上，也不会把残留的深色重新抹开。
  const patch = new Float32Array(total * 3);
  const known = new Uint8Array(total);
  for (let y = 0; y < rect.height; y += 1) {
    const row = ((rect.y + y) * width + rect.x) * 4;
    for (let x = 0; x < rect.width; x += 1) {
      const idx = y * rect.width + x;
      const p = row + x * 4;
      const i = idx * 3;
      if (grown[idx]) {
        continue;
      }
      patch[i] = cleaned[p];
      patch[i + 1] = cleaned[p + 1];
      patch[i + 2] = cleaned[p + 2];
      known[idx] = 1;
    }
  }

  for (let pass = 0; pass < 64; pass += 1) {
    let filledThisPass = 0;
    const nextKnown = known.slice();
    const nextPatch = patch.slice();
    for (let y = 0; y < rect.height; y += 1) {
      for (let x = 0; x < rect.width; x += 1) {
        const idx = y * rect.width + x;
        if (known[idx]) continue;
        let sumR = 0;
        let sumG = 0;
        let sumB = 0;
        let count = 0;
        for (let dy = -1; dy <= 1; dy += 1) {
          const ny = y + dy;
          if (ny < 0 || ny >= rect.height) continue;
          for (let dx = -1; dx <= 1; dx += 1) {
            const nx = x + dx;
            if (nx < 0 || nx >= rect.width) continue;
            const ni = ny * rect.width + nx;
            if (!known[ni]) continue;
            const pi = ni * 3;
            sumR += patch[pi];
            sumG += patch[pi + 1];
            sumB += patch[pi + 2];
            count += 1;
          }
        }
        if (count === 0) continue;
        const i = idx * 3;
        nextPatch[i] = sumR / count;
        nextPatch[i + 1] = sumG / count;
        nextPatch[i + 2] = sumB / count;
        nextKnown[idx] = 1;
        filledThisPass += 1;
      }
    }
    for (let i = 0; i < nextPatch.length; i += 1) patch[i] = nextPatch[i];
    for (let i = 0; i < nextKnown.length; i += 1) known[i] = nextKnown[i];
    if (filledThisPass === 0) break;
  }

  let repaired = 0;
  for (let y = 0; y < rect.height; y += 1) {
    const row = ((rect.y + y) * width + rect.x) * 4;
    for (let x = 0; x < rect.width; x += 1) {
      const idx = y * rect.width + x;
      if (!grown[idx]) continue;
      const p = row + x * 4;
      const i = idx * 3;
      // 极端情况（整框都是笔画）退化成背景灰度。
      const r = known[idx] ? patch[i] : background;
      const g = known[idx] ? patch[i + 1] : background;
      const b = known[idx] ? patch[i + 2] : background;
      cleaned[p] = Math.round(r);
      cleaned[p + 1] = Math.round(g);
      cleaned[p + 2] = Math.round(b);
      repaired += 1;
    }
  }
  return repaired;
}

export type ResidualInkRepairReport = {
  regionIds: string[];
  candidateCount: number;
  repairedPixels: number;
  worstRatio: number;
};

type RegionLike = { id: string; box: Rect; sourceText: string };

/**
 * 擦除之后、排版之前的兜底：逐框比对原图与擦除图，仍有残留笔画就按背景补掉。
 * 这样即使遮罩/分带出了问题，也不会出现「中文压在原文上」。
 */
export function repairResidualRegions(
  cleaned: PipelineCanvas,
  original: PipelineCanvas,
  regions: readonly RegionLike[],
  platform: PlatformProvider,
): ResidualInkRepairReport {
  const report: ResidualInkRepairReport = {
    regionIds: [],
    candidateCount: 0,
    repairedPixels: 0,
    worstRatio: 0,
  };
  if (regions.length === 0 || cleaned.width <= 0 || cleaned.height <= 0) {
    return report;
  }
  if ((globalThis as { __shinobuResidualInkRepair?: boolean }).__shinobuResidualInkRepair === false) {
    return report;
  }
  const cleanedCtx = cleaned.getContext("2d", { willReadFrequently: true });
  const originalCtx = original.getContext("2d", { willReadFrequently: true });
  if (!cleanedCtx || !originalCtx) {
    return report;
  }
  const width = cleaned.width;
  const height = cleaned.height;

  for (const region of regions) {
    if (region.sourceText.trim() === "") continue;
    const rect = clipRect({
      x: region.box.x - 2,
      y: region.box.y - 2,
      width: region.box.width + 4,
      height: region.box.height + 4,
    }, width, height);
    if (!rect) continue;
    let before: PipelineImageData;
    let after: PipelineImageData;
    try {
      before = originalCtx.getImageData(rect.x, rect.y, rect.width, rect.height);
      after = cleanedCtx.getImageData(rect.x, rect.y, rect.width, rect.height);
    } catch {
      // 跨域画布读不到像素时保持原样，不阻断整页。
      return report;
    }
    // 上面的纯函数用整幅画布坐标，这里换成本地坐标的等效判定。
    const assessment = assessResidualInk(
      before.data,
      after.data,
      rect.width,
      rect.height,
      { x: 0, y: 0, width: rect.width, height: rect.height },
    );
    if (!shouldRepairResidual(assessment) || !assessment) {
      continue;
    }
    report.candidateCount += 1;
    report.worstRatio = Math.max(report.worstRatio, assessment.residualRatio);
    const repaired = repairResidualInk(
      before.data,
      after.data,
      rect.width,
      rect.height,
      { x: 0, y: 0, width: rect.width, height: rect.height },
      assessment,
    );
    if (repaired > 0) {
      try {
        cleanedCtx.putImageData(after, rect.x, rect.y);
      } catch {
        return report;
      }
      report.repairedPixels += repaired;
      report.regionIds.push(region.id);
    }
  }
  void platform;
  return report;
}
