import { describe, expect, it } from 'vitest';

import { isSiteWatermarkRegion } from '../../../packages/image-pipeline/src/pipeline/ocr/watermark';

const PAGE = { w: 720, h: 8439 };

function region(
  sourceText: string,
  box: { x: number; y: number; width: number; height: number },
) {
  return { sourceText, box };
}

describe('站点水印判定', () => {
  it('命中域名样式的水印，无论出现在页面的哪个位置', () => {
    expect(isSiteWatermarkRegion(region('MANGA18FX.COM', { x: 180, y: 30, width: 360, height: 36 }), PAGE.w, PAGE.h)).toBe(true);
    expect(isSiteWatermarkRegion(region('OMEGASCANS.ORG', { x: 200, y: 7800, width: 320, height: 40 }), PAGE.w, PAGE.h)).toBe(true);
    expect(isSiteWatermarkRegion(region('read manga on manga18fx.com', { x: 180, y: 500, width: 360, height: 30 }), PAGE.w, PAGE.h)).toBe(true);
  });

  it('命中页顶细长的标语条', () => {
    // y=8 < 顶带(8439*4%=337)、高 30 <= 40、宽高比 16.7 >= 5
    expect(isSiteWatermarkRegion(region('Read Manga Online in English Free', { x: 110, y: 8, width: 500, height: 30 }), PAGE.w, PAGE.h)).toBe(true);
  });

  it('普通对白不会被误判为水印', () => {
    // 正文对白：字高大、或不在顶部、或不够扁
    expect(isSiteWatermarkRegion(region('Hello there!', { x: 100, y: 600, width: 300, height: 60 }), PAGE.w, PAGE.h)).toBe(false);
    expect(isSiteWatermarkRegion(region('AH, MY BAD MY BAD~', { x: 100, y: 40, width: 400, height: 70 }), PAGE.w, PAGE.h)).toBe(false);
    expect(isSiteWatermarkRegion(region('Haah..', { x: 300, y: 10, width: 140, height: 90 }), PAGE.w, PAGE.h)).toBe(false);
  });

  it('页顶但在顶带之外的小字不算水印', () => {
    expect(isSiteWatermarkRegion(region('some caption', { x: 100, y: 500, width: 400, height: 30 }), PAGE.w, PAGE.h)).toBe(false);
  });

  it('普通单页漫画不受影响', () => {
    // 900×1200 单页：顶带 = 48px，细条上限 = 9.6px
    expect(isSiteWatermarkRegion(region('dialogue text', { x: 200, y: 30, width: 400, height: 40 }), 900, 1200)).toBe(false);
  });

  it('空文本不判定为水印', () => {
    expect(isSiteWatermarkRegion(region('', { x: 100, y: 10, width: 400, height: 30 }), PAGE.w, PAGE.h)).toBe(false);
  });
});
