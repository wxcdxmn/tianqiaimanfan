import { describe, expect, it } from 'vitest';
import {
  genericImageKeyAttr,
  genericOriginalSrcAttr,
  scanGenericImages,
} from '../../../apps/extension/src/content/generic/genericImageScanner';

type FakeImageOptions = {
  url: string;
  naturalWidth?: number;
  naturalHeight?: number;
  rect?: { left: number; top: number; width: number; height: number };
  insideExtensionUi?: boolean;
};

function createImage(options: FakeImageOptions): HTMLImageElement {
  const attributes = new Map<string, string>();
  const rect = options.rect ?? { left: 0, top: 0, width: 800, height: 1200 };
  let sourceUrl = options.url;
  const image = {
    complete: true,
    naturalWidth: options.naturalWidth ?? 800,
    naturalHeight: options.naturalHeight ?? 1200,
    get currentSrc() { return sourceUrl; },
    get src() { return sourceUrl; },
    set src(value: string) { sourceUrl = value; },
    getAttribute: (name: string) => attributes.get(name) ?? null,
    setAttribute: (name: string, value: string) => { attributes.set(name, value); },
    hasAttribute: (name: string) => attributes.has(name),
    closest: () => (options.insideExtensionUi ? {} : null),
    getBoundingClientRect: () => ({
      ...rect,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height,
      x: rect.left,
      y: rect.top,
      toJSON: () => rect,
    }),
  };
  return image as unknown as HTMLImageElement;
}

function createRoot(images: readonly HTMLImageElement[]): Document {
  return { querySelectorAll: () => images } as unknown as Document;
}

const viewport = { width: 1000, height: 800 };

describe('scanGenericImages', () => {
  it('skips icons and images smaller than the natural-size floor', () => {
    const small = createImage({ url: 'https://cdn.test/icon.png', naturalWidth: 48, naturalHeight: 48 });
    const page = createImage({ url: 'https://cdn.test/page-1.jpg' });

    const result = scanGenericImages({ root: createRoot([small, page]), viewport });

    expect(result.map((item) => item.url)).toEqual(['https://cdn.test/page-1.jpg']);
  });

  it('skips images that belong to the extension UI', () => {
    const ownUi = createImage({ url: 'https://cdn.test/own-ui.png', insideExtensionUi: true });
    const page = createImage({ url: 'https://cdn.test/page.jpg' });

    const result = scanGenericImages({ root: createRoot([ownUi, page]), viewport });

    expect(result).toHaveLength(1);
    expect(result[0]?.url).toBe('https://cdn.test/page.jpg');
  });

  it('puts images intersecting the viewport before distant ones', () => {
    const far = createImage({
      url: 'https://cdn.test/far.jpg',
      rect: { left: 0, top: 4000, width: 800, height: 1200 },
    });
    const near = createImage({
      url: 'https://cdn.test/near.jpg',
      rect: { left: 0, top: 1200, width: 800, height: 1200 },
    });
    const visible = createImage({
      url: 'https://cdn.test/visible.jpg',
      rect: { left: 0, top: 100, width: 800, height: 1200 },
    });

    const result = scanGenericImages({ root: createRoot([far, near, visible]), viewport });

    expect(result.map((item) => item.url)).toEqual([
      'https://cdn.test/visible.jpg',
      'https://cdn.test/near.jpg',
      'https://cdn.test/far.jpg',
    ]);
  });

  it('keeps a stable key across rescans so translated blob URLs do not remount', () => {
    const page = createImage({ url: 'https://cdn.test/page.jpg' });

    const first = scanGenericImages({ root: createRoot([page]), viewport });
    page.setAttribute(genericOriginalSrcAttr, 'https://cdn.test/page.jpg');
    page.src = 'blob:https://example.test/translated';
    const second = scanGenericImages({ root: createRoot([page]), viewport });

    expect(first[0]?.key).toBe(second[0]?.key);
    expect(page.getAttribute(genericImageKeyAttr)).toBe(first[0]?.key);
  });
});
