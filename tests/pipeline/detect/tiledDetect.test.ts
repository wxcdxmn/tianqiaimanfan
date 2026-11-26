import { describe, expect, it } from 'vitest';
import {
  dedupeTiledRegions,
  offsetRegions,
  planImageTiles,
  TILE_TRIGGER_ASPECT,
} from '../../../packages/image-pipeline/src/pipeline/detect/onnxDetect';
import type { TextRegion } from '../../../packages/image-pipeline/src/types';

function region(y: number, height = 40, prob = 0.9): TextRegion {
  return {
    id: `r-${y}-${height}-${prob}`,
    box: { x: 10, y, width: 200, height },
    quad: [
      { x: 10, y },
      { x: 210, y },
      { x: 210, y: y + height },
      { x: 10, y: y + height },
    ],
    direction: 'h',
    prob,
    sourceText: '',
    translatedText: '',
  };
}

describe('planImageTiles', () => {
  it('keeps ordinary manga pages as a single frame', () => {
    const plan = planImageTiles(800, 1200);
    expect(plan.tiled).toBe(false);
    expect(plan.tiles).toHaveLength(1);
    expect(plan.tiles[0]).toEqual({ x: 0, y: 0, width: 800, height: 1200 });
  });

  it('leaves square-ish pages untouched', () => {
    expect(planImageTiles(1200, 1200).tiled).toBe(false);
    expect(planImageTiles(1200, 1200 * TILE_TRIGGER_ASPECT - 10).tiled).toBe(false);
  });

  it('slices a 720x8439 webtoon strip into overlapping bands', () => {
    const plan = planImageTiles(720, 8439);
    expect(plan.tiled).toBe(true);
    expect(plan.tiles.length).toBeGreaterThan(3);
    expect(plan.tiles.length).toBeLessThanOrEqual(11);

    for (const tile of plan.tiles) {
      expect(tile.width).toBe(720);
      expect(tile.x).toBe(0);
      expect(tile.y).toBeGreaterThanOrEqual(0);
      expect(tile.y + tile.height).toBeLessThanOrEqual(8439);
    }
  });

  it('covers the full height with no gaps', () => {
    for (const height of [2000, 5000, 8439, 12000, 20000]) {
      const plan = planImageTiles(720, height);
      let cursor = 0;
      for (const tile of plan.tiles) {
        expect(tile.y).toBeLessThanOrEqual(cursor);
        cursor = Math.max(cursor, tile.y + tile.height);
      }
      expect(cursor).toBe(height);
    }
  });

  it('overlaps neighbouring bands so text lines are never cut in half', () => {
    const plan = planImageTiles(720, 8439);
    for (let i = 1; i < plan.tiles.length; i += 1) {
      const previous = plan.tiles[i - 1];
      const tile = plan.tiles[i];
      expect(tile.y).toBeLessThan(previous.y + previous.height);
    }
  });

  it('keeps the letterboxed tile far wider than a whole-strip fit', () => {
    const width = 720;
    const height = 8439;
    const wholeWidth = Math.round(width * Math.min(1024 / height, 1024 / width));
    const plan = planImageTiles(width, height);
    const tileWidths = plan.tiles.map((tile) =>
      Math.round(tile.width * Math.min(1024 / tile.height, 1024 / tile.width))
    );
    expect(wholeWidth).toBeLessThan(120);
    for (const scaled of tileWidths) {
      expect(scaled).toBeGreaterThan(wholeWidth * 3);
    }
  });

  it('respects the tile cap on extremely tall images', () => {
    const plan = planImageTiles(1000, 40000);
    expect(plan.tiles.length).toBeLessThanOrEqual(14);
    const last = plan.tiles[plan.tiles.length - 1];
    expect(last.y + last.height).toBe(40000);
  });

  it('honours a custom aspect ratio', () => {
    const loose = planImageTiles(720, 8439, { maxTileAspect: 3.2 });
    const tight = planImageTiles(720, 8439, { maxTileAspect: 1.2 });
    expect(tight.tiles.length).toBeGreaterThan(loose.tiles.length);
  });
});

describe('offsetRegions', () => {
  it('shifts boxes and quads into whole-image coordinates', () => {
    const shifted = offsetRegions([region(100)], 500);
    expect(shifted[0].box.y).toBe(600);
    expect(shifted[0].quad?.[0].y).toBe(600);
    expect(shifted[0].box.x).toBe(10);
  });

  it('is a no-op for zero offset', () => {
    const input = [region(10)];
    expect(offsetRegions(input, 0)).toBe(input);
  });
});

describe('dedupeTiledRegions', () => {
  it('removes the duplicate produced in the overlap band', () => {
    const regions = [region(100, 40, 0.92), region(104, 42, 0.7), region(400, 40, 0.95)];
    const deduped = dedupeTiledRegions(regions);
    expect(deduped).toHaveLength(2);
    expect(deduped[0].prob).toBe(0.92);
    expect(deduped[1].box.y).toBe(400);
  });

  it('keeps distinct nearby lines', () => {
    const regions = [region(100, 40), region(160, 40)];
    expect(dedupeTiledRegions(regions)).toHaveLength(2);
  });

  it('sorts by reading order', () => {
    const regions = [region(500), region(100), region(300)];
    expect(dedupeTiledRegions(regions).map((r) => r.box.y)).toEqual([100, 300, 500]);
  });
});
