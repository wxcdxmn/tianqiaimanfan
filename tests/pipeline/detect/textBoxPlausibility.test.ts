import { describe, expect, it } from 'vitest';
import { isPlausibleTextBox } from '../../../packages/image-pipeline/src/pipeline/detect/onnxDetect';

const FRAME_W = 720;
const FRAME_H = 1296;

describe('检测框合理性判定', () => {
  it('接受常见的多行文字块', () => {
    expect(isPlausibleTextBox({ width: 220, height: 160 }, FRAME_W, FRAME_H)).toBe(true);
  });

  it('接受条漫里又宽又扁的单行对白', () => {
    // 400×40 的英文单行对白：宽高比 10、宽度 55%，旧规则会直接丢掉。
    expect(isPlausibleTextBox({ width: 400, height: 40 }, FRAME_W, FRAME_H)).toBe(true);
  });

  it('接受接近整页宽的单行旁白', () => {
    expect(isPlausibleTextBox({ width: 560, height: 50 }, FRAME_W, FRAME_H)).toBe(true);
  });

  it('拒绝整块分镜', () => {
    expect(isPlausibleTextBox({ width: 700, height: 900 }, FRAME_W, FRAME_H)).toBe(false);
  });

  it('拒绝细长的横线', () => {
    // 高 2px 的线不是文字。
    expect(isPlausibleTextBox({ width: 700, height: 2 }, FRAME_W, FRAME_H)).toBe(false);
  });

  it('拒绝超宽的一行（多半是边框或整页分割线）', () => {
    expect(isPlausibleTextBox({ width: 719, height: 8 }, FRAME_W, FRAME_H)).toBe(false);
  });

  it('拒绝过高的竖条', () => {
    expect(isPlausibleTextBox({ width: 40, height: 700 }, FRAME_W, FRAME_H)).toBe(false);
  });

  it('小图里的文字依然工作', () => {
    // 单页漫画 800×1200：一个 240×80 的对话块。
    expect(isPlausibleTextBox({ width: 240, height: 80 }, 800, 1200)).toBe(true);
    // 一个 600×80 的标题行（高度 6.7%），属于单行文字。
    expect(isPlausibleTextBox({ width: 600, height: 80 }, 800, 1200)).toBe(true);
    // 一个 700×600 的整格画面。
    expect(isPlausibleTextBox({ width: 700, height: 600 }, 800, 1200)).toBe(false);
  });
});
