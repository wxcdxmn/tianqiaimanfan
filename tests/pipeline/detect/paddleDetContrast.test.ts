import { describe, expect, it } from 'vitest';
import {
  blurRgbaForDetection,
  computeMidtoneShare,
  mergeDetBoxes,
  PADDLE_DET_DEHALFTONE_MIDTONE_SHARE,
} from '../../../packages/image-pipeline/src/pipeline/detect/paddleDetRecall';

function fillSolid(
  width: number,
  height: number,
  r: number,
  g: number,
  b: number,
): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = 255;
  }
  return data;
}

/** 左侧纯白、右侧纯黑：白底黑字页，中灰占比应接近 0。 */
function highContrastPage(width: number, height: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = x < width / 2 ? 255 : 0;
      const offset = (y * width + x) * 4;
      data[offset] = value;
      data[offset + 1] = value;
      data[offset + 2] = value;
      data[offset + 3] = 255;
    }
  }
  return data;
}

/** 逐像素明暗交替，模拟网点那种高频纹理。 */
function checkerboard(width: number, height: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = (x + y) % 2 === 0 ? 154 : 240;
      const offset = (y * width + x) * 4;
      data[offset] = value;
      data[offset + 1] = value;
      data[offset + 2] = value;
      data[offset + 3] = 255;
    }
  }
  return data;
}

function meanChannel(data: Uint8ClampedArray, channel: number): number {
  let sum = 0;
  let count = 0;
  for (let i = channel; i < data.length; i += 4) {
    sum += data[i];
    count += 1;
  }
  return count > 0 ? sum / count : 0;
}

describe('PaddleOCR 召回：网点去噪补检', () => {
  it('纯白/纯黑页的中灰占比接近 0，网点灰调页明显更高', () => {
    const contrast = computeMidtoneShare(highContrastPage(64, 64), 64, 64);
    expect(contrast).toBeLessThan(0.01);

    const halftone = computeMidtoneShare(fillSolid(64, 64, 154, 154, 154), 64, 64);
    expect(halftone).toBeGreaterThan(PADDLE_DET_DEHALFTONE_MIDTONE_SHARE);
  });

  it('模糊压掉网点的高频起伏，同时保留整体亮度', () => {
    const width = 32;
    const height = 32;
    const source = checkerboard(width, height);
    const blurred = blurRgbaForDetection(source, width, height);

    // 相邻像素差：原图 86，模糊后应显著收窄
    const sourceDelta = Math.abs(source[0] - source[4]);
    const blurredDelta = Math.abs(blurred[0] - blurred[4]);
    expect(sourceDelta).toBeGreaterThan(50);
    expect(blurredDelta).toBeLessThan(6);
    // 均值不变，说明没有整体变亮/变暗
    expect(Math.abs(meanChannel(blurred, 0) - meanChannel(source, 0))).toBeLessThan(1.5);
    // 不就地修改入参，第一轮检测还要用它
    expect(source[0]).toBe(154);
    expect(blurred[3]).toBe(255);
  });

  it('半径 0 时原样返回一份拷贝', () => {
    const source = checkerboard(8, 8);
    const untouched = blurRgbaForDetection(source, 8, 8, 0);
    expect(Array.from(untouched)).toEqual(Array.from(source));
    expect(untouched).not.toBe(source);
  });

  it('两轮检测的框取并集，重叠的只保留一个', () => {
    const base = [
      { box: { x: 10, y: 10, width: 100, height: 30 }, score: 0.9 },
      { box: { x: 200, y: 10, width: 80, height: 24 }, score: 0.8 },
    ];
    const extra = [
      // 与第一个框几乎重合
      { box: { x: 12, y: 11, width: 98, height: 29 }, score: 0.7 },
      // 中心落在第二个框内
      { box: { x: 220, y: 14, width: 10, height: 10 }, score: 0.5 },
      // 新框，应被追加
      { box: { x: 400, y: 200, width: 60, height: 20 }, score: 0.6 },
    ];
    const merged = mergeDetBoxes(base, extra);
    expect(merged).toHaveLength(3);
    expect(merged[2].box.x).toBe(400);
    // 保留第一轮的分数，不被低分的重复框覆盖
    expect(merged[0].score).toBe(0.9);
  });
});
