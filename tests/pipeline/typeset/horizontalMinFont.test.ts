import { describe, expect, it } from 'vitest';
import {
  computeFullHorizontalTypeset,
  horizontalMinReadableFontSize,
} from '../../../packages/image-pipeline/src/pipeline/typeset/horizontalLayout';
import type {
  PipelineRenderingContext,
} from '../../../packages/image-pipeline/src/runtime/platform';
import type { TextRegion } from '../../../packages/image-pipeline/src/types';

function parseCanvasFontSize(font: string, fallback: number): number {
  return Number.parseFloat(font.match(/([\d.]+)px/u)?.[1] ?? '') || fallback;
}

function createMeasureContext(): PipelineRenderingContext {
  const context = {
    font: '16px sans-serif',
    drawImage: () => {},
    measureText(text: string) {
      const fontSize = parseCanvasFontSize(context.font, 16);
      const width = [...text].length * fontSize * 0.6;
      return {
        width,
        actualBoundingBoxLeft: 0,
        actualBoundingBoxRight: width,
        actualBoundingBoxAscent: fontSize * 0.8,
        actualBoundingBoxDescent: fontSize * 0.2,
      };
    },
  };
  return context as unknown as PipelineRenderingContext;
}

/** lineBoxes 的坐标含 strokePadding 偏移，换算回内容坐标后必须完整落在内容区内。 */
function expectLinesWithinContent(layout: NonNullable<ReturnType<typeof computeFullHorizontalTypeset>>) {
  for (const line of layout.lineBoxes) {
    expect(line.topY - layout.strokePadding).toBeGreaterThanOrEqual(-0.5);
    expect(line.topY + line.visualHeight - layout.strokePadding)
      .toBeLessThanOrEqual(layout.contentHeight + 0.5);
    expect(line.width).toBeLessThanOrEqual(line.maxWidth + 0.5);
  }
  expect(layout.offscreenHeight).toBeGreaterThanOrEqual(layout.contentHeight);
}

describe('horizontalLayout minimum readable font size', () => {
  it('keeps small boxes at the readable floor and lets text overflow into blank space', () => {
    // 小检测框（高 14px）+ 明显更长的译文：旧行为会缩到 8px 左右的「蚂蚁字」。
    const region: TextRegion = {
      id: 'small-box-long-text',
      box: { x: 100, y: 100, width: 80, height: 14 },
      direction: 'h',
      sourceText: '짧은말',
      translatedText: '这是一段比原文本得多的译文',
      originalLineCount: 1,
      fontSize: 14,
    };

    const layout = computeFullHorizontalTypeset({
      region,
      fontFamily: 'Test Sans',
      measureCtx: createMeasureContext(),
    });

    expect(layout).not.toBeNull();
    // 字号不低于最小可读下限（受框高截断：min(12, 14) = 12）。
    expect(layout!.fittedFontSize).toBeGreaterThanOrEqual(
      Math.min(horizontalMinReadableFontSize, 14),
    );
    // 行数多于原检测框可容纳行数：内容高度按实际行高扩展，行完整可见。
    expect(layout!.contentHeight).toBeGreaterThanOrEqual(region.box.height);
    expectLinesWithinContent(layout!);
  });

  it('does not shrink below the floor when the initial estimate is small', () => {
    const region: TextRegion = {
      id: 'tiny-estimate',
      box: { x: 0, y: 0, width: 200, height: 40 },
      direction: 'h',
      sourceText: '테스트',
      translatedText: '译文内容',
      originalLineCount: 1,
      fontSize: 10,
    };

    const layout = computeFullHorizontalTypeset({
      region,
      fontFamily: 'Test Sans',
      measureCtx: createMeasureContext(),
    });

    expect(layout).not.toBeNull();
    expect(layout!.fittedFontSize).toBeGreaterThanOrEqual(
      Math.min(horizontalMinReadableFontSize, 40),
    );
    expectLinesWithinContent(layout!);
  });

  it('expands content height instead of clipping when many lines overflow a small box', () => {
    // 窄小框 + 长译文：三行行高总和远超框高，必须扩展内容高度而不是截断首行。
    const region: TextRegion = {
      id: 'multi-line-overflow',
      box: { x: 10, y: 10, width: 60, height: 30 },
      direction: 'h',
      sourceText: '짧은말',
      translatedText: '这是一段非常长的译文内容需要换行很多次',
      originalLineCount: 1,
      fontSize: 14,
    };

    const layout = computeFullHorizontalTypeset({
      region,
      fontFamily: 'Test Sans',
      measureCtx: createMeasureContext(),
    });

    expect(layout).not.toBeNull();
    expect(layout!.lineBoxes.length).toBeGreaterThan(1);
    const linesExtent = layout!.lineBoxes.reduce((sum, line) => sum + line.visualHeight, 0);
    expect(layout!.contentHeight).toBeGreaterThanOrEqual(linesExtent - 0.5);
    expectLinesWithinContent(layout!);
  });

  it('leaves roomy layouts untouched (no overflow needed)', () => {
    const region: TextRegion = {
      id: 'roomy',
      box: { x: 50, y: 50, width: 300, height: 120 },
      direction: 'h',
      sourceText: '原文一行',
      translatedText: '宽敞区域',
      originalLineCount: 1,
      fontSize: 24,
    };

    const layout = computeFullHorizontalTypeset({
      region,
      fontFamily: 'Test Sans',
      measureCtx: createMeasureContext(),
    });

    expect(layout).not.toBeNull();
    expect(layout!.fittedFontSize).toBeGreaterThanOrEqual(24);
    expectLinesWithinContent(layout!);
  });
});
