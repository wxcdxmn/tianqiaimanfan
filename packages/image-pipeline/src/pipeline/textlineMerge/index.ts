/**
 * Textline merge module — groups individual OCR text lines into logical text blocks.
 *
 * Algorithm fully aligned with zyddnys/manga-image-translator textline_merge:
 * 1. Build a graph where nodes are text lines, edges connect mergeable pairs.
 * 2. Find connected components as initial region candidates.
 * 3. Recursively split over-connected regions using MST edge analysis.
 * 4. Post-process: majority-vote direction, sort lines, average colors, merge text.
 */

import type { SourceTextLineGeometry, TextRegion, TextDirection, QuadPoint, Rect } from "../../types";
import { minAreaRect, type Quad } from "../typeset/geometry";
import type { InternalQuad, MergedGroup } from "./mergePredicates";
import { buildInternalQuad, mergeTextRegions } from "./mergePredicates";

type Axis = { x: number; y: number };

const axisEpsilon = 1e-6;

function normalizeAxis(axis: Axis): Axis | null {
  const norm = Math.hypot(axis.x, axis.y);
  if (!Number.isFinite(norm) || norm <= axisEpsilon) {
    return null;
  }
  return { x: axis.x / norm, y: axis.y / norm };
}

function axisDot(a: Axis, b: Axis): number {
  return a.x * b.x + a.y * b.y;
}

function resolveReferenceWidthAxis(quads: InternalQuad[], direction: TextDirection): Axis | null {
  const candidates = quads.flatMap((quad) => {
    if (quad.direction !== direction) {
      return [];
    }
    const axis = normalizeAxis({
      x: quad.pts[1].x - quad.pts[0].x,
      y: quad.pts[1].y - quad.pts[0].y,
    });
    if (!axis) {
      return [];
    }
    const weight = Number.isFinite(quad.area) && quad.area > 0 ? quad.area : 0;
    return [{ axis, weight }];
  });
  if (candidates.length === 0) {
    return null;
  }

  const anchor = candidates.reduce((best, candidate) => (
    candidate.weight > best.weight ? candidate : best
  ));
  let sumX = 0;
  let sumY = 0;
  let totalWeight = 0;
  for (const candidate of candidates) {
    const sign = axisDot(candidate.axis, anchor.axis) < 0 ? -1 : 1;
    const weight = candidate.weight > 0 ? candidate.weight : 1;
    sumX += candidate.axis.x * sign * weight;
    sumY += candidate.axis.y * sign * weight;
    totalWeight += weight;
  }
  if (totalWeight <= axisEpsilon) {
    return anchor.axis;
  }
  return normalizeAxis({ x: sumX / totalWeight, y: sumY / totalWeight }) ?? anchor.axis;
}

function rotateQuadStart(quad: Quad, offset: number): Quad {
  return [
    quad[offset % 4],
    quad[(offset + 1) % 4],
    quad[(offset + 2) % 4],
    quad[(offset + 3) % 4],
  ];
}

function alignQuadToReferenceWidthAxis(quad: Quad, referenceAxis: Axis | null): Quad {
  if (!referenceAxis) {
    return quad;
  }

  let best = quad;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (let offset = 0; offset < 4; offset += 1) {
    const candidate = rotateQuadStart(quad, offset);
    const widthAxis = normalizeAxis({
      x: candidate[1].x - candidate[0].x,
      y: candidate[1].y - candidate[0].y,
    });
    if (!widthAxis) {
      continue;
    }
    const score = axisDot(widthAxis, referenceAxis);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Build merged TextRegion from a group of InternalQuads
// ---------------------------------------------------------------------------

function internalQuadToSourceGeometry(q: InternalQuad): SourceTextLineGeometry {
  const xs = q.pts.map((p) => p.x);
  const ys = q.pts.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);
  const topW = Math.hypot(q.pts[1].x - q.pts[0].x, q.pts[1].y - q.pts[0].y);
  const bottomW = Math.hypot(q.pts[2].x - q.pts[3].x, q.pts[2].y - q.pts[3].y);
  const leftH = Math.hypot(q.pts[3].x - q.pts[0].x, q.pts[3].y - q.pts[0].y);
  const rightH = Math.hypot(q.pts[2].x - q.pts[1].x, q.pts[2].y - q.pts[1].y);

  return {
    text: q.text,
    direction: q.direction,
    box: {
      x: Math.round(minX),
      y: Math.round(minY),
      width: Math.round(maxX - minX),
      height: Math.round(maxY - minY),
    },
    quad: q.pts.map((p) => ({ x: p.x, y: p.y })) as [QuadPoint, QuadPoint, QuadPoint, QuadPoint],
    centerX: q.centroid.x,
    centerY: q.centroid.y,
    width: (topW + bottomW) / 2,
    height: (leftH + rightH) / 2,
    fontSize: q.fontSize,
  };
}

function buildMergedRegion(group: MergedGroup): TextRegion {
  const { quads: txtlns, fgColor, bgColor } = group;

  // Concatenate texts in reading order
  const sourceText = txtlns.map((q) => q.text).join("\n");

  // Direction: majority already computed
  let hCount = 0;
  let vCount = 0;
  for (const q of txtlns) {
    if (q.direction === "h") {
      hCount++;
    } else {
      vCount++;
    }
  }
  let majorityDir: TextDirection;
  if (hCount !== vCount) {
    majorityDir = hCount > vCount ? "h" : "v";
  } else {
    // Tie-break: use the direction of the quad with highest aspect ratio
    let maxAR = -Infinity;
    majorityDir = "h";
    for (const q of txtlns) {
      if (q.aspectRatio > maxAR) {
        maxAR = q.aspectRatio;
        majorityDir = q.direction;
      }
      if (1 / q.aspectRatio > maxAR) {
        maxAR = 1 / q.aspectRatio;
        majorityDir = q.direction;
      }
    }
  }

  // Compute weighted log-probability
  const totalArea = txtlns.reduce((s, q) => s + q.area, 0);
  let totalLogProbs = 0;
  for (const q of txtlns) {
    totalLogProbs += Math.log(Math.max(1e-10, q.prob)) * q.area;
  }
  const prob = totalArea > 0 ? Math.exp(totalLogProbs / totalArea) : 0;

  // Average fontSize from component textlines
  const fontSize = txtlns.reduce((s, q) => s + q.fontSize, 0) / txtlns.length;

  // Union bounding box
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const q of txtlns) {
    for (const p of q.pts) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
  }
  const box: Rect = {
    x: Math.round(minX),
    y: Math.round(minY),
    width: Math.round(maxX - minX),
    height: Math.round(maxY - minY),
  };

  // Use minAreaRect to preserve rotation angle from detected text lines
  const allPoints: InternalQuad["pts"][number][] = [];
  for (const q of txtlns) {
    allPoints.push(...q.pts);
  }

  let quad: [QuadPoint, QuadPoint, QuadPoint, QuadPoint];
  const mar = minAreaRect(allPoints);
  if (mar) {
    quad = alignQuadToReferenceWidthAxis(
      mar.box,
      resolveReferenceWidthAxis(txtlns, majorityDir),
    );
  } else {
    quad = [
      { x: box.x, y: box.y },
      { x: box.x + box.width, y: box.y },
      { x: box.x + box.width, y: box.y + box.height },
      { x: box.x, y: box.y + box.height },
    ];
  }

  return {
    id: crypto.randomUUID(),
    box,
    quad,
    direction: majorityDir,
    prob,
    fontSize,
    fgColor,
    bgColor,
    originalLineCount: txtlns.length,
    sourceText,
    translatedText: "",
    sourceLineGeometries: txtlns.map(internalQuadToSourceGeometry),
  };
}

// ---------------------------------------------------------------------------
// Public API — aligned with dispatch()
// ---------------------------------------------------------------------------

/**
 * Merge individual OCR text lines into logical text blocks.
 *
 * Insert this stage between OCR and Translation in the pipeline.
 * Input: per-line TextRegion[] (from OCR).
 * Output: merged TextRegion[] (fewer items, concatenated sourceText).
 */
export function mergeTextLines(regions: TextRegion[], width: number, height: number): TextRegion[] {
  if (regions.length === 0) {
    return [];
  }

  // Convert TextRegion[] to InternalQuad[]
  const quads = regions.map((r, i) => buildInternalQuad(r, i));

  // Run merge
  const groups = mergeTextRegions(quads, width, height);

  // Build output TextRegion[]
  return attachBubbleGeometry(groups.map((group) => buildMergedRegion(group)), regions);
}

/**
 * 合并后的区域要继承气泡几何。
 *
 * 行合并会把多个 TextRegion 拼成新的对象，气泡框/气泡掩码在中途丢失。而下游
 * 「按气泡内部补擦残留笔画」和「把译文塞进气泡」都以它为前提，丢了这两条都会
 * 静默退化成只能处理文字框内部。这里按合并框的中心归属把气泡接回去。
 */
function attachBubbleGeometry(merged: TextRegion[], sources: TextRegion[]): TextRegion[] {
  const hosts = sources.filter((region) => region.bubbleMask);
  if (hosts.length === 0) return merged;
  return merged.map((region) => {
    const centerX = region.box.x + region.box.width / 2;
    const centerY = region.box.y + region.box.height / 2;
    const host = hosts.find((candidate) => {
      const mask = candidate.bubbleMask;
      if (!mask) return false;
      return centerX >= mask.x && centerX <= mask.x + mask.width
        && centerY >= mask.y && centerY <= mask.y + mask.height;
    });
    const mask = host?.bubbleMask;
    if (!mask) return region;
    return {
      ...region,
      bubbleBox: host?.bubbleBox
        ? { ...host.bubbleBox }
        : { x: mask.x, y: mask.y, width: mask.width, height: mask.height },
      bubbleMask: mask,
    };
  });
}

// ---------------------------------------------------------------------------
// 竖直堆叠碎片兜底合并
// ---------------------------------------------------------------------------

/** 横向投影重叠至少占较窄框宽度的比例。 */
const STACK_MERGE_MIN_HORIZONTAL_OVERLAP = 0.5;
/** 竖直间距上限（相对较矮框的高度）。 */
const STACK_MERGE_MAX_VERTICAL_GAP_RATIO = 0.5;
/** 两框宽度最多相差的倍数。 */
const STACK_MERGE_MAX_WIDTH_RATIO = 2.9;

function rectHorizontalOverlap(a: Rect, b: Rect): number {
  return Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
}

function rectVerticalGap(a: Rect, b: Rect): number {
  const aBottom = a.y + a.height;
  const bBottom = b.y + b.height;
  if (aBottom < b.y) return b.y - aBottom;
  if (bBottom < a.y) return a.y - bBottom;
  return 0;
}

function shouldMergeStackedFragments(a: TextRegion, b: TextRegion): boolean {
  const ra = a.box;
  const rb = b.box;
  if (ra.width <= 0 || rb.width <= 0 || ra.height <= 0 || rb.height <= 0) {
    return false;
  }
  const minWidth = Math.min(ra.width, rb.width);
  const minHeight = Math.min(ra.height, rb.height);
  if (rectHorizontalOverlap(ra, rb) / minWidth < STACK_MERGE_MIN_HORIZONTAL_OVERLAP) {
    return false;
  }
  if (rectVerticalGap(ra, rb) > minHeight * STACK_MERGE_MAX_VERTICAL_GAP_RATIO) {
    return false;
  }
  if (Math.max(ra.width, rb.width) / minWidth > STACK_MERGE_MAX_WIDTH_RATIO) {
    return false;
  }
  // 竖排文字的“堆叠”是横向排列的，AABB 规则不适用，交给上游合并处理。
  const direction = a.direction ?? b.direction;
  if (direction === "v") {
    return false;
  }
  return true;
}

function regionSortPoint(region: TextRegion): { x: number; y: number } {
  return { x: region.box.x, y: region.box.y };
}

function sortStackMembers(members: TextRegion[]): TextRegion[] {
  const vertical = members.filter((m) => m.direction === "v").length > members.length / 2;
  return [...members].sort((a, b) => {
    const pa = regionSortPoint(a);
    const pb = regionSortPoint(b);
    if (vertical) {
      return pb.x - pa.x || pa.y - pb.y;
    }
    return pa.y - pb.y || pa.x - pb.x;
  });
}

function buildStackMergedRegion(members: TextRegion[]): TextRegion {
  const ordered = sortStackMembers(members);
  const points: QuadPoint[] = [];
  for (const member of ordered) {
    if (member.quad) {
      points.push(...member.quad);
    } else {
      const { x, y, width, height } = member.box;
      points.push({ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height });
    }
  }
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const box: Rect = {
    x: Math.round(Math.min(...xs)),
    y: Math.round(Math.min(...ys)),
    width: Math.round(Math.max(...xs) - Math.min(...xs)),
    height: Math.round(Math.max(...ys) - Math.min(...ys)),
  };

  const mar = minAreaRect(points);
  const vertical = ordered.filter((m) => m.direction === "v").length > ordered.length / 2;
  const quad = (mar ? alignQuadToReferenceWidthAxis(mar.box, null) : null) ?? ([
    { x: box.x, y: box.y },
    { x: box.x + box.width, y: box.y },
    { x: box.x + box.width, y: box.y + box.height },
    { x: box.x, y: box.y + box.height },
  ] as [QuadPoint, QuadPoint, QuadPoint, QuadPoint]);

  const totalArea = ordered.reduce((sum, m) => sum + m.box.width * m.box.height, 0);
  const weightOf = (region: TextRegion) => {
    const area = region.box.width * region.box.height;
    return totalArea > 0 ? area / totalArea : 1 / ordered.length;
  };
  let prob = 0;
  let fontSize = 0;
  let fontSizeWeight = 0;
  let originalLineCount = 0;
  const geometries: SourceTextLineGeometry[] = [];
  for (const member of ordered) {
    const weight = weightOf(member);
    prob += (member.prob ?? 0) * weight;
    if (typeof member.fontSize === "number" && member.fontSize > 0) {
      fontSize += member.fontSize * weight;
      fontSizeWeight += weight;
    }
    originalLineCount += member.originalLineCount ?? 1;
    if (member.sourceLineGeometries?.length) {
      geometries.push(...member.sourceLineGeometries);
    }
  }
  const dominant = ordered.reduce((best, m) => (
    (m.box.width * m.box.height) > (best.box.width * best.box.height) ? m : best
  ), ordered[0]);

  return {
    id: crypto.randomUUID(),
    box,
    quad,
    direction: vertical ? "v" : "h",
    prob,
    fontSize: fontSizeWeight > 0 ? fontSize / fontSizeWeight : dominant.fontSize,
    fgColor: dominant.fgColor,
    bgColor: dominant.bgColor,
    originalLineCount,
    sourceText: ordered.map((m) => m.sourceText).join("\n"),
    translatedText: "",
    sourceLineGeometries: geometries.length > 0 ? geometries : undefined,
  };
}

/**
 * 竖直堆叠碎片的兜底合并。
 *
 * 检测器偶尔把一个气泡的首行单独切成一个窄框（例如「그나저나」），其余文字是另一个
 * 更宽的多行块。上游行合并按“左右边缘对齐”判定同段，居中排版的短首行两边都对不上，
 * 于是被拆成两个区域：各自独立翻译，排版时两组译文又叠回同一个气泡，读者看到的就是
 * 重叠或重复的译文。
 *
 * 这里用保守的几何规则把这类碎片合回一段：横向投影基本重叠（同栏）、竖直间距不超过
 * 较矮框的一半、宽度量级相近。同时满足三条的相邻文字在漫画里几乎不可能属于两个
 * 独立气泡，而误合的最坏结果也只是把两句话当成一段翻译，仍能读。
 */
export function mergeStackedTextFragments(regions: TextRegion[]): TextRegion[] {
  if (regions.length < 2) {
    return regions;
  }

  const parent = regions.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) {
      root = parent[root];
    }
    while (parent[index] !== root) {
      const next = parent[index];
      parent[index] = root;
      index = next;
    }
    return root;
  };
  for (let i = 0; i < regions.length; i += 1) {
    for (let j = i + 1; j < regions.length; j += 1) {
      if (find(i) === find(j)) continue;
      if (shouldMergeStackedFragments(regions[i], regions[j])) {
        parent[find(i)] = find(j);
      }
    }
  }

  const groups = new Map<number, TextRegion[]>();
  const order: number[] = [];
  for (let i = 0; i < regions.length; i += 1) {
    const root = find(i);
    const bucket = groups.get(root);
    if (bucket) {
      bucket.push(regions[i]);
    } else {
      groups.set(root, [regions[i]]);
      order.push(root);
    }
  }

  const result: TextRegion[] = [];
  for (const root of order) {
    const members = groups.get(root)!;
    result.push(
      members.length === 1
        ? members[0]
        : attachBubbleGeometry([buildStackMergedRegion(members)], members)[0],
    );
  }
  return result;
}

// ---------------------------------------------------------------------------
// 气泡内并段：同一气泡里的零散文字块合成一整段台词
// ---------------------------------------------------------------------------

/** 气泡占整页面积超过这个比例时视为无框白底/整页框，不再按它并段。 */
const BUBBLE_COALESCE_MAX_PAGE_SHARE = 0.5;
/** 组内主导方向至少占这个比例才合并：横排与竖排混烧会算坏外框。 */
const BUBBLE_COALESCE_MIN_DIRECTION_SHARE = 0.6;

function bubbleIdentity(region: TextRegion): string | null {
  const bubble = region.bubbleBox;
  if (!bubble) return null;
  return `${bubble.x}:${bubble.y}:${bubble.width}:${bubble.height}`;
}

function dominantDirectionShare(members: readonly TextRegion[]): number {
  const horizontal = members.filter((member) => (member.direction ?? "h") === "h").length;
  return Math.max(horizontal, members.length - horizontal) / Math.max(1, members.length);
}

function coalescedBubbleRegion(members: TextRegion[]): TextRegion {
  const merged = buildStackMergedRegion(members);
  const host = members.find((member) => member.bubbleMask) ?? members[0];
  const bubbleBox = host.bubbleBox
    ?? (host.bubbleMask
      ? {
        x: host.bubbleMask.x,
        y: host.bubbleMask.y,
        width: host.bubbleMask.width,
        height: host.bubbleMask.height,
      }
      : undefined);
  // 行数按「声明的行数」与「实际换行数」取大：上游若漏标，排版会按偏少的行数
  // 撑大字号，译文反而溢出气泡。
  const lineCount = members.reduce((sum, member) => {
    const actualLines = member.sourceText.split("\n").filter((line) => line.trim()).length;
    return sum + Math.max(1, member.originalLineCount ?? 1, actualLines);
  }, 0);
  return {
    ...merged,
    originalLineCount: lineCount,
    bubbleBox: bubbleBox ? { ...bubbleBox } : undefined,
    bubbleMask: host.bubbleMask,
  };
}

/**
 * 气泡内并段。
 *
 * 行合并是按几何做判定的：气泡里居中排版的短句（「둘이 진정으로」这种首行）
 * 左右边缘都和下一行对不上，容易被切成两个区域；两个区域各自翻译，
 * 排版时又叠回同一个气泡，读者看到的就是断句、重复甚至互相压字。
 * 气泡归属（matchRegionsToBubbles）是比几何更强的证据：同一个气泡里只有
 * 一段连续的台词，因此按气泡框分组直接合成一段，交给翻译层整句处理。
 *
 * 保守设定：
 * - 只处理「中心落在气泡内」的区域（气泡归属已在上游算好）；
 * - 气泡占整页一半以上时跳过，避免把满屏白底当成一个大气泡吃掉整页文字；
 * - 组内方向必须一致，横竖排混在一起时外框会算歪，宁可不动。
 */
export function coalesceBubbleRegions(
  regions: TextRegion[],
  pageWidth: number,
  pageHeight: number,
): TextRegion[] {
  if (regions.length < 2) {
    return regions;
  }
  const pageArea = Math.max(1, pageWidth * pageHeight);
  const groups = new Map<string, TextRegion[]>();
  const order: Array<string | number> = [];
  regions.forEach((region, index) => {
    const key = bubbleIdentity(region) ?? index;
    const bucket = groups.get(String(key));
    if (bucket) {
      bucket.push(region);
    } else {
      groups.set(String(key), [region]);
      order.push(key);
    }
  });

  const result: TextRegion[] = [];
  for (const key of order) {
    const members = groups.get(String(key))!;
    if (members.length < 2) {
      result.push(...members);
      continue;
    }
    const bubble = members[0].bubbleBox;
    const bubbleShare = bubble
      ? (bubble.width * bubble.height) / pageArea
      : 0;
    if (bubbleShare > BUBBLE_COALESCE_MAX_PAGE_SHARE
      || dominantDirectionShare(members) < BUBBLE_COALESCE_MIN_DIRECTION_SHARE) {
      result.push(...members);
      continue;
    }
    result.push(coalescedBubbleRegion(members));
  }
  return result;
}
