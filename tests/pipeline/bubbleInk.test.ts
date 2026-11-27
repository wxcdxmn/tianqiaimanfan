import { describe, expect, it } from 'vitest';
import { fillInkInBubbleInterior } from '../../packages/image-pipeline/src/pipeline/maskRefinement/bubbleInk';

type Bubble = { x: number; y: number; width: number; height: number; data: Uint8Array };

function makeGray(width: number, height: number, background = 240): Uint8Array {
  return new Uint8Array(width * height).fill(background);
}

function makeBubble(bubbleWidth: number, bubbleHeight: number, offsetX = 0, offsetY = 0): Bubble {
  return {
    x: offsetX,
    y: offsetY,
    width: bubbleWidth,
    height: bubbleHeight,
    data: new Uint8Array(bubbleWidth * bubbleHeight).fill(1),
  };
}

function paint(
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

describe('bubble interior ink fill', () => {
  it('masks leftover strokes anywhere inside a flat bubble, not just inside the text box', () => {
    const width = 60;
    const height = 50;
    const gray = makeGray(width, height);
    // 两行字，模拟检测框只包住上面一行、下面一行被漏掉的情形。
    paint(gray, width, { x: 14, y: 18, width: 12, height: 6 }, 30);
    paint(gray, width, { x: 14, y: 30, width: 12, height: 6 }, 30);

    const result = fillInkInBubbleInterior(gray, width, height, makeBubble(50, 40, 5, 5), 1);
    expect(result).not.toBeNull();
    const { mask, rect } = result!;
    const at = (x: number, y: number): number => mask[(y - rect.y) * rect.width + (x - rect.x)];
    expect(at(16, 20)).toBe(1);
    // 第二行在文字框外，也必须进遮罩。
    expect(at(16, 32)).toBe(1);
    expect(at(30, 25)).toBe(0);
  });

  it('drops blobs touching the bubble wall so the outline survives', () => {
    const width = 60;
    const height = 50;
    const gray = makeGray(width, height);
    // 一条横贯整个气泡的深色带：和气泡内边界相接，属于描边/画面，不该擦。
    paint(gray, width, { x: 8, y: 7, width: 44, height: 3 }, 20);

    expect(fillInkInBubbleInterior(gray, width, height, makeBubble(50, 40, 5, 5), 1)).toBeNull();
  });

  it('refuses bubbles whose plate is artwork instead of a flat color', () => {
    const width = 60;
    const height = 50;
    const gray = new Uint8Array(width * height);
    let state = 0x9e3779b9;
    for (let index = 0; index < gray.length; index += 1) {
      state = (state * 1103515245 + 12345) >>> 0;
      gray[index] = state >>> 24;
    }
    expect(fillInkInBubbleInterior(gray, width, height, makeBubble(50, 40, 5, 5), 1)).toBeNull();
  });

  it('maps source-image bubble coordinates onto the scaled gray buffer', () => {
    const width = 60;
    const height = 50;
    const gray = makeGray(width, height);
    // 源图 120x100 的气泡缩到 0.5 倍后落在 (5,5)-(55,45)。
    paint(gray, width, { x: 26, y: 22, width: 8, height: 8 }, 30);
    const bubble: Bubble = {
      x: 10,
      y: 10,
      width: 100,
      height: 80,
      data: new Uint8Array(100 * 80).fill(1),
    };
    const result = fillInkInBubbleInterior(gray, width, height, bubble, 0.5);
    expect(result).not.toBeNull();
    expect(result!.rect).toEqual({ x: 5, y: 5, width: 50, height: 40 });
    expect(result!.mask[(24 - 5) * 50 + (28 - 5)]).toBe(1);
  });
});
