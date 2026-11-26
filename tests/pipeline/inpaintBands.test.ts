import { describe, expect, it } from 'vitest';
import { planInpaintBands, INPAINT_TILE_TRIGGER_ASPECT } from '../../packages/image-pipeline/src/pipeline/inpaint';

describe('planInpaintBands', () => {
  it('covers the full height with overlapping bands', () => {
    const bands = planInpaintBands(720, 8439, 720);
    let cursor = 0;
    for (const band of bands) {
      expect(band.x).toBe(0);
      expect(band.width).toBe(720);
      expect(band.y).toBeLessThanOrEqual(cursor);
      cursor = Math.max(cursor, band.y + band.height);
      expect(band.height).toBeGreaterThan(0);
    }
    expect(cursor).toBe(8439);
  });

  it('overlaps neighbours so erased text never straddles a seam', () => {
    const bands = planInpaintBands(720, 5000, 720);
    for (let i = 1; i < bands.length; i += 1) {
      const previous = bands[i - 1];
      expect(bands[i].y).toBeLessThan(previous.y + previous.height);
      const overlap = previous.y + previous.height - bands[i].y;
      expect(overlap).toBeGreaterThan(50);
    }
  });

  it('keeps a square band so the model scale stays uniform', () => {
    const bands = planInpaintBands(720, 4000, 720);
    expect(bands[0].width).toBe(bands[0].height);
  });

  it('emits a single band for a page shorter than one band', () => {
    const bands = planInpaintBands(720, 400, 720);
    expect(bands).toHaveLength(1);
    expect(bands[0]).toEqual({ x: 0, y: 0, width: 720, height: 400 });
  });

  it('clamps a degenerate overlap', () => {
    const bands = planInpaintBands(720, 2000, 720, 0.9);
    expect(bands.length).toBeGreaterThan(1);
    expect(bands.every((band) => band.height > 0)).toBe(true);
  });
});

describe('INPAINT_TILE_TRIGGER_ASPECT', () => {
  it('leaves normal manga pages on the single-pass path', () => {
    expect(1200 / 800).toBeLessThan(INPAINT_TILE_TRIGGER_ASPECT);
    expect(1600 / 1000).toBeLessThan(INPAINT_TILE_TRIGGER_ASPECT);
  });

  it('bands webtoon strips', () => {
    expect(8439 / 720).toBeGreaterThan(INPAINT_TILE_TRIGGER_ASPECT);
    expect(7500 / 720).toBeGreaterThan(INPAINT_TILE_TRIGGER_ASPECT);
  });
});
