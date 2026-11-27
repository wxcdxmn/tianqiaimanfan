import { describe, expect, it } from 'vitest';

import { isSiteWatermarkRegion } from '../../../packages/image-pipeline/src/pipeline/ocr/watermark';

const PAGE = { w: 720, h: 8439 };
/** 截图里那张条漫：720×2800 的一屏，水印位置按实际比例折算。 */
const SCREEN = { w: 720, h: 2800 };

function region(
  sourceText: string,
  box: { x: number; y: number; width: number; height: number },
  bubbleBox?: { x: number; y: number; width: number; height: number },
) {
  return bubbleBox ? { sourceText, box, bubbleBox } : { sourceText, box };
}

describe('站点水印判定', () => {
  it('命中域名样式的水印，无论出现在页面的哪个位置', () => {
    expect(isSiteWatermarkRegion(region('MANGA18FX.COM', { x: 180, y: 30, width: 360, height: 36 }), PAGE.w, PAGE.h)).toBe(true);
    expect(isSiteWatermarkRegion(region('OMEGASCANS.ORG', { x: 200, y: 7800, width: 320, height: 40 }), PAGE.w, PAGE.h)).toBe(true);
    expect(isSiteWatermarkRegion(region('read manga on manga18fx.com', { x: 180, y: 500, width: 360, height: 30 }), PAGE.w, PAGE.h)).toBe(true);
  });

  it('中文夹着域名的水印也要命中（OCR 把站点名和中文连成一段）', () => {
    // 汉字属于 \p{L}，用 \b 收边界会让整条规则失效——这正是之前漏掉的那批水印。
    expect(isSiteWatermarkRegion(region('漫画18FX.COM', { x: 250, y: 60, width: 220, height: 46 }), SCREEN.w, SCREEN.h)).toBe(true);
    expect(isSiteWatermarkRegion(region('免費閱讀MANNINEIN.COM', { x: 250, y: 60, width: 260, height: 40 }), SCREEN.w, SCREEN.h)).toBe(true);
    expect(isSiteWatermarkRegion(region('最新地址newxtoon5.com', { x: 250, y: 900, width: 260, height: 40 }), SCREEN.w, SCREEN.h)).toBe(true);
  });

  it('OCR 截断的站点名仍算水印', () => {
    expect(isSiteWatermarkRegion(region('MPLESCANESP.NE', { x: 60, y: 120, width: 260, height: 32 }), PAGE.w, PAGE.h)).toBe(true);
    expect(isSiteWatermarkRegion(region('TEMPLESCANESPNET', { x: 60, y: 120, width: 300, height: 32 }), PAGE.w, PAGE.h)).toBe(true);
  });

  it('裸链接、社媒账号与短链一律算水印', () => {
    expect(isSiteWatermarkRegion(region('t.me/somechannel', { x: 100, y: 600, width: 300, height: 30 }), PAGE.w, PAGE.h)).toBe(true);
    expect(isSiteWatermarkRegion(region('加入 telegram 频道', { x: 100, y: 600, width: 240, height: 30 }), PAGE.w, PAGE.h)).toBe(true);
    expect(isSiteWatermarkRegion(region('@someartist', { x: 100, y: 600, width: 160, height: 26 }), PAGE.w, PAGE.h)).toBe(true);
  });

  it('截图里的站点推广语不再当台词翻译', () => {
    expect(isSiteWatermarkRegion(region('免费阅读MannineinEnsh', { x: 350, y: 285, width: 240, height: 34 }), SCREEN.w, SCREEN.h)).toBe(true);
    expect(isSiteWatermarkRegion(region('在这里阅读最新更新', { x: 300, y: 760, width: 240, height: 40 }), SCREEN.w, SCREEN.h)).toBe(true);
    expect(isSiteWatermarkRegion(region('免费阅读 最新更新', { x: 60, y: 2400, width: 300, height: 34 }), SCREEN.w, SCREEN.h)).toBe(true);
    expect(isSiteWatermarkRegion(region('翻译：某某汉化组 嵌字：路人', { x: 60, y: 2700, width: 420, height: 32 }), SCREEN.w, SCREEN.h)).toBe(true);
  });

  it('气泡里的文字即使带推广字眼也不当水印（那是角色台词）', () => {
    const bubble = { x: 280, y: 640, width: 400, height: 340 };
    expect(isSiteWatermarkRegion(region('在这里阅读最新更新吧', { x: 330, y: 700, width: 300, height: 60 }, bubble), SCREEN.w, SCREEN.h)).toBe(false);
    expect(isSiteWatermarkRegion(region('加入我们吧', { x: 330, y: 700, width: 300, height: 60 }, bubble), SCREEN.w, SCREEN.h)).toBe(false);
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

  it('带句末标点的完整句子按台词处理', () => {
    expect(isSiteWatermarkRegion(region('我读完了。', { x: 100, y: 500, width: 200, height: 40 }), PAGE.w, PAGE.h)).toBe(false);
    expect(isSiteWatermarkRegion(region('快来看我更新的网站吧！', { x: 100, y: 500, width: 360, height: 40 }), PAGE.w, PAGE.h)).toBe(false);
    expect(isSiteWatermarkRegion(region('둘이 진정으로 화해했다는 의미로 서로 뽀뽀해.', { x: 320, y: 1960, width: 300, height: 120 }), SCREEN.w, SCREEN.h)).toBe(false);
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
