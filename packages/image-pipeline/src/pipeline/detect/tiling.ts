import type { ImageCrop } from "../../runtime/platform";
import type { Rect, TextRegion } from "../../types";
import { clamp } from "../utils";

/**
 * Vertical banding for webtoon / long-strip pages.
 *
 * Both local models letterbox their input into a square (detector 1024²,
 * bubble 640²). Feeding a 720×8439 strip whole leaves a 87px / 55px wide
 * image, so nothing is detectable. Slicing into overlapping bands keeps the
 * scale factor near 1 while still covering the full page.
 */

export type TilePlanOptions = {
  /** Longest allowed tile height relative to tile width. */
  maxTileAspect?: number;
  /** Fraction of tile height shared with the next tile so lines are never cut. */
  overlapRatio?: number;
  /** Hard cap on tiles per image; larger strips get taller (coarser) tiles. */
  maxTiles?: number;
  /** Height/width ratio below which the page is processed as a single frame. */
  triggerAspect?: number;
};

export type TilePlan = {
  tiles: ImageCrop[];
  /** True when the image is a long strip that had to be sliced. */
  tiled: boolean;
};

export const DEFAULT_TILE_MAX_ASPECT = 1.8;
export const DEFAULT_TILE_OVERLAP = 0.12;
export const DEFAULT_MAX_TILES = 10;
/** Below this height/width ratio a page fits a square model input cleanly. */
export const TILE_TRIGGER_ASPECT = 2.6;

export function planImageTiles(
  width: number,
  height: number,
  options: TilePlanOptions = {}
): TilePlan {
  const maxAspect = Math.max(1.1, options.maxTileAspect ?? DEFAULT_TILE_MAX_ASPECT);
  const overlapRatio = clamp(options.overlapRatio ?? DEFAULT_TILE_OVERLAP, 0, 0.4);
  const maxTiles = Math.max(1, Math.floor(options.maxTiles ?? DEFAULT_MAX_TILES));
  const triggerAspect = Math.max(1, options.triggerAspect ?? TILE_TRIGGER_ASPECT);

  const safeWidth = Math.max(1, Math.round(width));
  const safeHeight = Math.max(1, Math.round(height));
  if (safeHeight / safeWidth <= triggerAspect) {
    return { tiles: [{ x: 0, y: 0, width: safeWidth, height: safeHeight }], tiled: false };
  }

  let tileHeight = Math.round(safeWidth * maxAspect);
  // Grow the tile instead of exceeding the cap: fewer, larger frames.
  while (tileHeight < safeHeight && Math.ceil(safeHeight / tileHeight) > maxTiles) {
    tileHeight = Math.round(tileHeight * 1.15);
  }
  tileHeight = Math.min(Math.max(1, tileHeight), safeHeight);

  const stride = Math.max(1, Math.round(tileHeight * (1 - overlapRatio)));
  const tiles: ImageCrop[] = [];
  for (let y = 0; y < safeHeight; y += stride) {
    const previous = tiles[tiles.length - 1];
    const coveredByPrevious = previous ? previous.y + previous.height - y : 0;
    if (previous && safeHeight - y <= coveredByPrevious) {
      // The overlap already reaches the bottom edge; no extra sliver needed.
      break;
    }
    tiles.push({ x: 0, y, width: safeWidth, height: Math.min(tileHeight, safeHeight - y) });
    if (y + tileHeight >= safeHeight) break;
  }

  return { tiles, tiled: tiles.length > 1 };
}

/** Shift frame-local text regions into whole-image coordinates. */
export function offsetRegions(regions: TextRegion[], offsetY: number): TextRegion[] {
  if (offsetY === 0) return regions;
  return regions.map((region) => ({
    ...region,
    box: { ...region.box, y: region.box.y + offsetY },
    quad: region.quad
      ? (region.quad.map((point) => ({ x: point.x, y: point.y + offsetY })) as TextRegion["quad"])
      : region.quad,
  }));
}

/** Intersection over the smaller of the two areas. */
export function boxOverlapRatio(a: Rect, b: Rect): number {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= left || bottom <= top) return 0;
  const intersection = (right - left) * (bottom - top);
  const minArea = Math.min(a.width * a.height, b.width * b.height);
  return minArea > 0 ? intersection / minArea : 0;
}

/**
 * Drop duplicate detections produced where neighbouring tiles overlap.
 * Higher confidence wins; ties keep the earlier (top-most) box.
 */
export function dedupeTiledRegions(regions: TextRegion[], threshold = 0.55): TextRegion[] {
  const ranked = [...regions].sort((a, b) => (b.prob ?? 0) - (a.prob ?? 0));
  const kept: TextRegion[] = [];
  for (const region of ranked) {
    if (kept.some((existing) => boxOverlapRatio(existing.box, region.box) > threshold)) {
      continue;
    }
    kept.push(region);
  }
  return kept.sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
}

/** Same idea for scored boxes (bubble detections). */
export function dedupeTiledBoxes<T extends { box: Rect; score: number }>(
  items: T[],
  threshold = 0.55
): T[] {
  const ranked = [...items].sort((a, b) => b.score - a.score);
  const kept: T[] = [];
  for (const item of ranked) {
    if (kept.some((existing) => boxOverlapRatio(existing.box, item.box) > threshold)) {
      continue;
    }
    kept.push(item);
  }
  return kept.sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
}
