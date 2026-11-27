import { describe, expect, it } from 'vitest';

import { coalesceBubbleRegions } from '../../../packages/image-pipeline/src/pipeline/textlineMerge';
import type { Rect, TextRegion } from '../../../packages/image-pipeline/src/types';

const PAGE = { w: 720, h: 2800 };

let nextId = 0;

function region(
  sourceText: string,
  box: Rect,
  options: {
    direction?: 'h' | 'v';
    bubbleBox?: Rect;
  } = {},
): TextRegion {
  nextId += 1;
  return {
    id: `region-${nextId}`,
    box,
    direction: options.direction ?? 'h',
    sourceText,
    translatedText: '',
    originalLineCount: 1,
    prob: 0.9,
    fontSize: 24,
    ...(options.bubbleBox ? { bubbleBox: options.bubbleBox } : {}),
  };
}

describe('气泡内并段', () => {
  it('同一气泡里的碎块合成一段台词', () => {
    const bubble = { x: 300, y: 900, width: 360, height: 420 };
    const head = region('둘이 진정으로', { x: 380, y: 960, width: 200, height: 60 }, { bubbleBox: bubble });
    const body = region('화해했다는 의미로\n서로 뽀뽀해.', { x: 340, y: 1040, width: 280, height: 140 }, { bubbleBox: bubble });

    const merged = coalesceBubbleRegions([head, body], PAGE.w, PAGE.h);

    expect(merged).toHaveLength(1);
    expect(merged[0].sourceText).toBe('둘이 진정으로\n화해했다는 의미로\n서로 뽀뽀해.');
    expect(merged[0].originalLineCount).toBe(3);
    expect(merged[0].bubbleBox).toEqual(bubble);
    expect(merged[0].box).toEqual({ x: 340, y: 960, width: 280, height: 220 });
  });

  it('不同气泡各自保留，不会被并成一段', () => {
    const left = { x: 40, y: 900, width: 280, height: 300 };
    const right = { x: 400, y: 900, width: 280, height: 300 };
    const a = region('첫 번째 대사', { x: 80, y: 940, width: 200, height: 60 }, { bubbleBox: left });
    const b = region('두 번째 대사', { x: 440, y: 940, width: 200, height: 60 }, { bubbleBox: right });

    expect(coalesceBubbleRegions([a, b], PAGE.w, PAGE.h)).toHaveLength(2);
  });

  it('没匹配到气泡的旁白与拟声词保持独立', () => {
    const a = region('쿵', { x: 80, y: 400, width: 120, height: 120 });
    const b = region('쾅', { x: 300, y: 400, width: 120, height: 120 });

    expect(coalesceBubbleRegions([a, b], PAGE.w, PAGE.h)).toHaveLength(2);
  });

  it('横竖排混在一个气泡里时不合并（外框会算歪）', () => {
    const bubble = { x: 300, y: 900, width: 360, height: 420 };
    const horizontal = region('가로', { x: 340, y: 940, width: 200, height: 60 }, { bubbleBox: bubble });
    const vertical = region('세로', { x: 560, y: 940, width: 60, height: 200 }, { direction: 'v', bubbleBox: bubble });

    expect(coalesceBubbleRegions([horizontal, vertical], PAGE.w, PAGE.h)).toHaveLength(2);
  });

  it('占满整页的白底被当成气泡时不并段', () => {
    const bubble = { x: 0, y: 0, width: PAGE.w, height: PAGE.h };
    const a = region('첫 줄', { x: 100, y: 400, width: 300, height: 60 }, { bubbleBox: bubble });
    const b = region('둘째 줄', { x: 100, y: 2000, width: 300, height: 60 }, { bubbleBox: bubble });

    expect(coalesceBubbleRegions([a, b], PAGE.w, PAGE.h)).toHaveLength(2);
  });

  it('只有一个区域时原样返回', () => {
    const bubble = { x: 300, y: 900, width: 360, height: 420 };
    const only = region('혼자', { x: 380, y: 960, width: 200, height: 60 }, { bubbleBox: bubble });

    const merged = coalesceBubbleRegions([only], PAGE.w, PAGE.h);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toBe(only);
  });
});
