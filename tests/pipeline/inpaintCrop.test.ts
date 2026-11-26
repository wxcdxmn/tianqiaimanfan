import { describe, expect, it } from 'vitest';

import { cropCoversSource } from '../../packages/image-pipeline/src/pipeline/inpaint';

/**
 * 回归用例：crop 用源坐标描述，整图判定必须比较源尺寸。
 *
 * 曾经的实现把 crop 与「目标画布尺寸」比较，于是 720×8439 长条图的第一带
 * （crop = 0,0,720,720，且目标尺寸也是 720×720）被误判成「覆盖全图」，
 * 结果整页被压进一条带再回贴，画面出现横向拉扁与重复堆叠。
 */
describe('cropCoversSource', () => {
  const strip = { width: 720, height: 8439 };

  it('首带与目标尺寸相同，但不覆盖整页源图', () => {
    expect(cropCoversSource({ x: 0, y: 0, width: 720, height: 720 }, strip)).toBe(false);
  });

  it('中间带即便宽高相等也不算覆盖全图', () => {
    expect(cropCoversSource({ x: 0, y: 3672, width: 720, height: 720 }, strip)).toBe(false);
  });

  it('尾部较矮的带同样需要裁剪', () => {
    expect(cropCoversSource({ x: 0, y: 7956, width: 720, height: 483 }, strip)).toBe(false);
  });

  it('与源图尺寸完全一致时才视为整图', () => {
    expect(cropCoversSource({ x: 0, y: 0, width: 720, height: 8439 }, strip)).toBe(true);
  });

  it('没有 crop 视为整图', () => {
    expect(cropCoversSource(undefined, strip)).toBe(true);
  });

  it('尺寸相同但带偏移时不视为整图', () => {
    const square = { width: 720, height: 720 };
    expect(cropCoversSource({ x: 0, y: 0, width: 720, height: 720 }, square)).toBe(true);
    expect(cropCoversSource({ x: 0, y: 360, width: 720, height: 720 }, square)).toBe(false);
  });

  it('普通单页（宽高相等）走整图分支，不受影响', () => {
    const page = { width: 900, height: 1200 };
    expect(cropCoversSource({ x: 0, y: 0, width: 900, height: 1200 }, page)).toBe(true);
  });
});
