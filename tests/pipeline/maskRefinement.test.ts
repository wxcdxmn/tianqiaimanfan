import { describe, expect, it } from 'vitest';
import { dilate, fillInkInFlatBox } from '../../packages/image-pipeline/src/pipeline/maskRefinement/algorithms';

function loopOracle(mask: Uint8Array, width: number, height: number, kernelSize: number): Uint8Array {
  if (kernelSize <= 1) return mask.slice();
  const radius = Math.floor(kernelSize / 2);
  const offsets: Array<[number, number]> = [];
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx * dx + dy * dy <= radius * radius + 0.25) offsets.push([dx, dy]);
    }
  }
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x] === 0) continue;
      for (const [dx, dy] of offsets) {
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < width && ny < height) out[ny * width + nx] = 1;
      }
    }
  }
  return out;
}

describe('mask dilation', () => {
  it('matches the pixel loop at boundaries and for large, odd, even, and fractional kernels', () => {
    for (const [width, height] of [[0, 0], [1, 1], [1, 17], [19, 1], [13, 11]]) {
      const corners = new Uint8Array(width * height);
      if (corners.length > 0) {
        for (const pixel of [0, width - 1, (height - 1) * width, width * height - 1]) corners[pixel] = 2;
      }
      for (const mask of [corners, new Uint8Array(corners.length), new Uint8Array(corners.length).fill(255)]) {
        const before = mask.slice();
        for (const kernelSize of [-2, 0, 1, 1.1, 2, 3, 4, 7, 31, 101, 201]) {
          const actual = dilate(mask, width, height, kernelSize);
          expect(actual).toEqual(loopOracle(mask, width, height, kernelSize));
          expect(actual).not.toBe(mask);
          expect(mask).toEqual(before);
        }
      }
    }
  });

  it('matches the pixel loop for fragmented and random masks without changing inputs', () => {
    let state = 0x53bf6d79;
    const random = () => {
      state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
      return state >>> 0;
    };
    for (let trial = 0; trial < 80; trial++) {
      const width = 1 + random() % 29, height = 1 + random() % 23, kernelSize = 1 + random() % 65;
      const mask = Uint8Array.from({ length: width * height }, (_, pixel) => trial % 2 === 0
        ? (pixel % width + Math.floor(pixel / width)) % 2
        : random() % 3 === 0 ? [1, 2, 255][random() % 3] : 0);
      const before = mask.slice();
      expect(dilate(mask, width, height, kernelSize)).toEqual(loopOracle(mask, width, height, kernelSize));
      expect(mask).toEqual(before);
    }
  });
});

describe('flat box ink fill', () => {
  function makeFlatImage(width: number, height: number, background = 236): Uint8Array {
    return new Uint8Array(width * height).fill(background);
  }

  function paintRect(
    gray: Uint8Array,
    width: number,
    rect: { x: number; y: number; width: number; height: number },
    value: number,
  ): void {
    for (let y = rect.y; y < rect.y + rect.height; y += 1) {
      for (let x = rect.x; x < rect.x + rect.width; x += 1) {
        gray[y * width + x] = value;
      }
    }
  }

  it('marks strokes that the detector mask missed inside a flat bubble box', () => {
    const width = 60, height = 40;
    const gray = makeFlatImage(width, height);
    // 两段笔画模拟一行文字，其中右边那一段就是检测框漏掉的窄字。
    paintRect(gray, width, { x: 8, y: 14, width: 14, height: 8 }, 40);
    paintRect(gray, width, { x: 28, y: 14, width: 4, height: 8 }, 40);

    const result = fillInkInFlatBox(gray, width, height, { x: 4, y: 10, width: 34, height: 18 });
    expect(result).not.toBeNull();
    const mask = result!.mask;
    expect(mask[4 * result!.rect.width + 8]).toBe(1);
    expect(mask[4 * result!.rect.width + 24]).toBe(1);
    expect(mask[1 * result!.rect.width + 1]).toBe(0);
    expect(result!.rect).toEqual({ x: 4, y: 10, width: 34, height: 18 });
  });

  it('refuses boxes whose background is artwork instead of a flat plate', () => {
    const width = 40, height = 40;
    const gray = new Uint8Array(width * height);
    let state = 0x1234567;
    for (let i = 0; i < gray.length; i += 1) {
      state = (state * 1103515245 + 12345) >>> 0;
      gray[i] = state >>> 24;
    }
    expect(fillInkInFlatBox(gray, width, height, { x: 2, y: 2, width: 30, height: 30 })).toBeNull();
  });

  it('refuses flat boxes with no strokes and clamps boxes to the image bounds', () => {
    const width = 30, height = 20;
    const gray = makeFlatImage(width, height);
    expect(fillInkInFlatBox(gray, width, height, { x: 2, y: 2, width: 10, height: 10 })).toBeNull();

    paintRect(gray, width, { x: 20, y: 10, width: 6, height: 6 }, 0);
    const clamped = fillInkInFlatBox(gray, width, height, { x: 16, y: 6, width: 40, height: 40 });
    expect(clamped?.rect).toEqual({ x: 16, y: 6, width: 14, height: 14 });
  });

  it('refuses boxes with an illustration patch whose ink share the old threshold (0.6) would accept', () => {
    const width = 40, height = 30;
    const gray = makeFlatImage(width, height);
    // 一整块 22×20 的深色斑:inkShare≈0.47,旧上限 0.6 会整块上墨(涂花插画),
    // 与 residualInk 对齐后的 0.42 拒绝。
    paintRect(gray, width, { x: 6, y: 4, width: 22, height: 20 }, 40);
    const result = fillInkInFlatBox(gray, width, height, { x: 2, y: 2, width: 36, height: 26 });
    expect(result).toBeNull();
  });

  it('still accepts a line of text whose strokes cover a normal share of the box', () => {
    const width = 60, height = 40;
    const gray = makeFlatImage(width, height);
    // 一行三个独立笔画块,合计 inkShare≈0.20,远低于 0.42 上限。
    paintRect(gray, width, { x: 8, y: 14, width: 14, height: 8 }, 40);
    paintRect(gray, width, { x: 24, y: 14, width: 10, height: 8 }, 40);
    paintRect(gray, width, { x: 40, y: 14, width: 4, height: 8 }, 40);
    const result = fillInkInFlatBox(gray, width, height, { x: 4, y: 10, width: 44, height: 18 });
    expect(result).not.toBeNull();
    expect(result!.mask[4 * result!.rect.width + 8]).toBe(1);
  });
});
