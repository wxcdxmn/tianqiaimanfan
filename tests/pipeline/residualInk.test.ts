import { describe, expect, it } from 'vitest';

import {
  assessResidualInk,
  repairResidualInk,
  shouldRepairResidual,
} from '../../packages/image-pipeline/src/pipeline/residualInk';

const W = 40;
const H = 20;

function flatCanvas(value: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i += 1) {
    data[i * 4] = value;
    data[i * 4 + 1] = value;
    data[i * 4 + 2] = value;
    data[i * 4 + 3] = 255;
  }
  return data;
}

/** 在中间画一条 6px 高的「笔画」。 */
function drawInk(data: Uint8ClampedArray, value: number, share = 0.3): void {
  const y0 = Math.floor(H * (0.5 - share / 2));
  const y1 = Math.floor(H * (0.5 + share / 2));
  for (let y = y0; y < y1; y += 1) {
    for (let x = 4; x < W - 4; x += 1) {
      const p = (y * W + x) * 4;
      data[p] = value;
      data[p + 1] = value;
      data[p + 2] = value;
    }
  }
}

const BOX = { x: 0, y: 0, width: W, height: H };

describe('assessResidualInk', () => {
  it('擦干净时残留比例接近 0', () => {
    const original = flatCanvas(240);
    drawInk(original, 20);
    const cleaned = flatCanvas(240);
    const result = assessResidualInk(original, cleaned, W, H, BOX);
    expect(result).not.toBeNull();
    expect(result!.inkCount).toBeGreaterThan(100);
    expect(result!.residualRatio).toBeLessThan(0.05);
    expect(shouldRepairResidual(result)).toBe(false);
  });

  it('原文没擦掉时残留比例接近 1，应判定需要修', () => {
    const original = flatCanvas(240);
    drawInk(original, 20);
    const cleaned = original.slice();
    const result = assessResidualInk(original, cleaned, W, H, BOX);
    expect(result!.residualRatio).toBeGreaterThan(0.9);
    expect(result!.flatShare).toBeGreaterThan(0.5);
    expect(shouldRepairResidual(result)).toBe(true);
  });

  it('底板花（插画/网点）时不做修复', () => {
    const original = flatCanvas(128);
    drawInk(original, 20);
    // 用噪点把 flatShare 压到 0.5 以下，模拟插画底。
    for (let i = 0; i < W * H; i += 1) {
      const v = (i * 37) % 255;
      original[i * 4] = v;
      original[i * 4 + 1] = v;
      original[i * 4 + 2] = v;
    }
    const result = assessResidualInk(original, original.slice(), W, H, BOX);
    expect(shouldRepairResidual(result)).toBe(false);
  });

  it('没有笔画时返回 inkCount 极小，不修', () => {
    const original = flatCanvas(240);
    const cleaned = flatCanvas(240);
    const result = assessResidualInk(original, cleaned, W, H, BOX);
    expect(result!.inkCount).toBe(0);
    expect(shouldRepairResidual(result)).toBe(false);
  });
});

describe('repairResidualInk', () => {
  it('把残留笔画填成背景色，且不碰框外像素', () => {
    const original = flatCanvas(240);
    drawInk(original, 20);
    const cleaned = original.slice();
    const outside = cleaned.slice();
    const assessment = assessResidualInk(original, cleaned, W, H, BOX)!;
    const repaired = repairResidualInk(original, cleaned, W, H, BOX, assessment);
    expect(repaired).toBeGreaterThan(0);

    // 笔画区域被填成接近背景的浅色
    const mid = ((Math.floor(H / 2)) * W + Math.floor(W / 2)) * 4;
    expect(cleaned[mid]).toBeGreaterThan(200);

    // 全图范围内只改了笔画附近：改动的像素必须是原本的深色像素或其 2px 邻居
    let changedFarFromInk = 0;
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        const p = (y * W + x) * 4;
        if (cleaned[p] === outside[p]) continue;
        if (original[p] < 60) continue;
        let nearInk = false;
        for (let dy = -2; dy <= 2 && !nearInk; dy += 1) {
          for (let dx = -2; dx <= 2; dx += 1) {
            const ny = y + dy;
            const nx = x + dx;
            if (ny < 0 || ny >= H || nx < 0 || nx >= W) continue;
            if (original[(ny * W + nx) * 4] < 60) {
              nearInk = true;
              break;
            }
          }
        }
        if (!nearInk) changedFarFromInk += 1;
      }
    }
    expect(changedFarFromInk).toBe(0);
  });
});
