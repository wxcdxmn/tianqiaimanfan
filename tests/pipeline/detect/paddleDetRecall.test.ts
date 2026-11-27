import { describe, expect, it } from 'vitest';
import {
  buildPaddleDetInput,
  mergeRecallRegions,
  planPaddleDetInput,
  postProcessDbProbMap,
  unclipDetRect,
} from '../../../packages/image-pipeline/src/pipeline/detect/paddleDetRecall';
import { makeRegion } from '../../../packages/image-pipeline/src/pipeline/detect/onnxDetect';
import type { TextRegion } from '../../../packages/image-pipeline/src/types';

function regionAt(x: number, y: number, width: number, height: number): TextRegion {
  return makeRegion({ x, y, width, height });
}

function probMap(width: number, height: number, blobs: Array<{ x: number; y: number; w: number; h: number; value: number }>): Float32Array {
  const map = new Float32Array(width * height);
  for (const blob of blobs) {
    for (let y = blob.y; y < blob.y + blob.h; y += 1) {
      for (let x = blob.x; x < blob.x + blob.w; x += 1) {
        map[y * width + x] = blob.value;
      }
    }
  }
  return map;
}

describe('PaddleOCR v6 检测召回', () => {
  it('把长条图等比缩到 maxSide 并对齐 32', () => {
    const geometry = planPaddleDetInput(1000, 8000, 960);
    expect(geometry.inputHeight).toBe(960);
    expect(geometry.inputWidth % 32).toBe(0);
    expect(geometry.inputWidth).toBeLessThanOrEqual(960);
    expect(geometry.scale).toBeCloseTo(960 / 8000, 5);
  });

  it('小图不放大，仍对齐到 32 的倍数', () => {
    const geometry = planPaddleDetInput(700, 300, 960);
    expect(geometry.scale).toBe(1);
    expect(geometry.inputWidth % 32).toBe(0);
    expect(geometry.inputHeight % 32).toBe(0);
  });

  it('按官方配置做 BGR + ImageNet 归一化', () => {
    // 单个纯红像素：BGR 顺序下通道顺序应为 (b,g,r)
    const rgba = new Uint8ClampedArray([255, 0, 0, 255]);
    const input = buildPaddleDetInput(rgba, 1, 1);
    const mean = [0.485, 0.456, 0.406];
    const std = [0.229, 0.224, 0.225];
    expect(input[0]).toBeCloseTo((0 - mean[0]) / std[0], 4);
    expect(input[1]).toBeCloseTo((0 - mean[1]) / std[1], 4);
    expect(input[2]).toBeCloseTo((1 - mean[2]) / std[2], 4);
  });

  it('unclip 按面积周长比向外扩', () => {
    const expanded = unclipDetRect({ x: 10, y: 10, width: 20, height: 40 }, 1.4);
    const distance = (20 * 40 * 1.4) / (2 * (20 + 40));
    expect(expanded.x).toBeCloseTo(10 - distance, 5);
    expect(expanded.width).toBeCloseTo(20 + 2 * distance, 5);
  });

  it('低于 box_thresh 的连通域不产出文本框', () => {
    const strong = probMap(64, 64, [{ x: 8, y: 8, w: 20, h: 8, value: 0.9 }]);
    const weak = probMap(64, 64, [{ x: 8, y: 8, w: 20, h: 8, value: 0.3 }]);
    expect(postProcessDbProbMap(strong, 64, 64).boxes).toHaveLength(1);
    const weakResult = postProcessDbProbMap(weak, 64, 64);
    expect(weakResult.boxes).toHaveLength(0);
    expect(weakResult.rejectedByScore).toBe(1);
  });

  it('合并时丢弃已被主检测覆盖的框，只保留新增文字', () => {
    const base = [regionAt(100, 100, 80, 200)];
    const covered = regionAt(105, 120, 70, 150);
    const duplicateOfBase = regionAt(100, 100, 80, 200);
    const fresh = regionAt(400, 300, 60, 90);
    const merged = mergeRecallRegions(base, [covered, duplicateOfBase, fresh], { width: 800, height: 1200 });
    expect(merged).toHaveLength(2);
    expect(merged[0]).toBe(base[0]);
    expect(merged[1].box).toEqual(fresh.box);
  });

  it('过滤整块画面纹理与极端长宽比', () => {
    const base: TextRegion[] = [];
    const huge = regionAt(0, 0, 700, 1000);
    const sliver = regionAt(10, 10, 300, 4);
    const ok = regionAt(200, 200, 40, 120);
    const merged = mergeRecallRegions(base, [huge, sliver, ok], { width: 800, height: 1200 });
    expect(merged).toHaveLength(1);
    expect(merged[0].box).toEqual(ok.box);
  });

  it('兜底框数量有上限，避免误检刷屏', () => {
    const extras = Array.from({ length: 100 }, (_, index) => (
      regionAt(10 + (index % 10) * 60, 10 + Math.floor(index / 10) * 60, 40, 40)
    ));
    const merged = mergeRecallRegions([], extras, { width: 2000, height: 2000 });
    expect(merged.length).toBeLessThanOrEqual(60);
  });
});
