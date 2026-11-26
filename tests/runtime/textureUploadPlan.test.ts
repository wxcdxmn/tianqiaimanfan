import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_TEXTURE_DIMENSION,
  planTextureUpload,
} from '../../packages/model-runtime/src/workers/textureUploadPlan';

describe('planTextureUpload', () => {
  it('uploads pages that already fit without touching them', () => {
    expect(planTextureUpload(720, 4000, 8192)).toEqual({
      width: 720,
      height: 4000,
      scaled: false,
    });
  });

  it('shrinks a tall manga page to the height limit', () => {
    // The shape reported by WebGPU validation failures in the wild.
    const plan = planTextureUpload(720, 10300, 8192);
    expect(plan.scaled).toBe(true);
    expect(plan.height).toBe(8192);
    expect(plan.width).toBeLessThan(720);
  });

  it('keeps the aspect ratio while shrinking', () => {
    const plan = planTextureUpload(720, 10300, 8192);
    expect(plan.width / plan.height).toBeCloseTo(720 / 10300, 2);
  });

  it('never exceeds the limit on either axis', () => {
    const limit = 8192;
    const samples: Array<[number, number]> = [
      [720, 10300], [10300, 720], [20000, 20000], [8193, 100], [100, 65535],
    ];
    for (const [w, h] of samples) {
      const plan = planTextureUpload(w, h, limit);
      expect(plan.width).toBeLessThanOrEqual(limit);
      expect(plan.height).toBeLessThanOrEqual(limit);
      expect(plan.width).toBeGreaterThan(0);
      expect(plan.height).toBeGreaterThan(0);
    }
  });

  it('handles a 20000px webtoon strip', () => {
    const plan = planTextureUpload(720, 20000, 16384);
    expect(plan).toMatchObject({ width: 589, height: 16384, scaled: true });
  });

  it('keeps tiny images at their own size', () => {
    expect(planTextureUpload(1, 1, 8192)).toEqual({ width: 1, height: 1, scaled: false });
  });

  it('falls back to the default limit when the device reports none', () => {
    expect(planTextureUpload(720, 10300, 0).height).toBe(DEFAULT_MAX_TEXTURE_DIMENSION);
    expect(planTextureUpload(720, 10300, Number.NaN).height).toBe(DEFAULT_MAX_TEXTURE_DIMENSION);
  });
});
