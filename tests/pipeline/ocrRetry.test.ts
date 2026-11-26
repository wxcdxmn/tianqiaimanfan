import { describe, expect, it } from 'vitest';
import {
  expandOcrRetryBox,
  isUsableOcrRetry,
  MAX_OCR_RETRIES,
  OCR_RETRY_PAD_X,
  OCR_RETRY_PAD_Y,
} from '../../packages/image-pipeline/src/pipeline/ocr/retry';

describe('ocr retry box', () => {
  it('grows a single line box on both axes', () => {
    const box = { x: 100, y: 200, width: 200, height: 40 };
    const expanded = expandOcrRetryBox(box, 720, 8000);
    expect(expanded.width).toBeGreaterThan(box.width);
    expect(expanded.height).toBeGreaterThan(box.height);
    // 横向按比例扩，纵向给得更多，覆盖上伸部/下伸部。
    expect(expanded.x).toBeLessThan(box.x);
    expect(expanded.y).toBeLessThan(box.y);
    expect(expanded.width).toBe(box.width + 2 * Math.round(box.width * OCR_RETRY_PAD_X));
  });

  it('gives less vertical padding to tall merged blocks', () => {
    const line = expandOcrRetryBox({ x: 0, y: 1000, width: 200, height: 40 }, 720, 8000);
    const block = expandOcrRetryBox({ x: 0, y: 1000, width: 200, height: 300 }, 720, 8000);
    expect(line.height - 40).toBe(2 * Math.round(40 * OCR_RETRY_PAD_Y));
    // 高块只多给 10%，避免把相邻对白吃进来。
    expect(block.height - 300).toBe(2 * Math.round(300 * 0.1));
  });

  it('clamps to the image bounds', () => {
    const expanded = expandOcrRetryBox({ x: 2, y: 1, width: 50, height: 20 }, 720, 8000);
    expect(expanded.x).toBe(0);
    expect(expanded.y).toBe(0);

    const bottom = expandOcrRetryBox({ x: 600, y: 7980, width: 100, height: 20 }, 720, 8000);
    expect(bottom.x + bottom.width).toBeLessThanOrEqual(720);
    expect(bottom.y + bottom.height).toBeLessThanOrEqual(8000);
  });

  it('keeps a sane minimum padding for tiny boxes', () => {
    const expanded = expandOcrRetryBox({ x: 10, y: 10, width: 4, height: 4 }, 720, 8000);
    expect(expanded.width).toBeGreaterThanOrEqual(4 + 4);
    expect(expanded.height).toBeGreaterThanOrEqual(4 + 4);
  });
});

describe('ocr retry acceptance', () => {
  it('rejects empty text', () => {
    expect(isUsableOcrRetry('   ', 0.9)).toBe(false);
  });

  it('accepts multi-character text with modest confidence', () => {
    expect(isUsableOcrRetry('Wait!', 0.35)).toBe(true);
    expect(isUsableOcrRetry('等等', 0.31)).toBe(true);
  });

  it('rejects multi-character text with no confidence', () => {
    expect(isUsableOcrRetry('Wait!', 0.12)).toBe(false);
    expect(isUsableOcrRetry('Wait!', undefined)).toBe(false);
  });

  it('only accepts single characters when very confident', () => {
    expect(isUsableOcrRetry('啊', 0.9)).toBe(true);
    expect(isUsableOcrRetry('啊', 0.5)).toBe(false);
  });

  it('caps the retry batch size', () => {
    expect(MAX_OCR_RETRIES).toBeGreaterThan(0);
    expect(MAX_OCR_RETRIES).toBeLessThanOrEqual(16);
  });
});
