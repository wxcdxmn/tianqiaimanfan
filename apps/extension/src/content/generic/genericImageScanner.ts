/**
 * Finds manga-sized <img> elements on an arbitrary page and orders them by how
 * close they are to the current viewport, so the first pages a reader sees are
 * translated first (RuneManga's scrolling window, without server involvement).
 */

export type GenericImageCandidate = {
  key: string;
  element: HTMLImageElement;
  url: string;
  /** 0 for images intersecting the viewport, otherwise distance from its center. */
  viewportPriority: number;
};

export type ViewportSize = {
  width: number;
  height: number;
};

export type ScanOptions = {
  root?: Document;
  viewport?: ViewportSize;
  minNaturalSize?: number;
  minRenderedArea?: number;
};

export const genericImageKeyAttr = 'data-mt-generic-key';
export const genericOriginalSrcAttr = 'data-mt-original-src';
export const genericAnchorAttr = 'data-mt-generic-anchor';

const EXTENSION_UI_SELECTOR = [
  '.mt-x-overlay-inline',
  '.mt-x-reading-bar',
  '.mt-x-screenshot-select',
  '.mt-x-screenshot-result',
  `.mt-x-shortcut-toast`,
  `[${genericAnchorAttr}]`,
].join(', ');

export const defaultMinNaturalSize = 200;
export const defaultMinRenderedArea = 60_000;

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function isHttpUrl(value: string): boolean {
  return value.startsWith('http://') || value.startsWith('https://');
}

/** Prefer the untranslated source so the stable key never follows a blob: URL. */
function resolveSourceUrl(image: HTMLImageElement): string {
  const original = image.getAttribute(genericOriginalSrcAttr)?.trim();
  if (original && isHttpUrl(original)) return original;
  const current = image.currentSrc || image.src;
  return current.trim();
}

function toViewportPriority(rect: DOMRect, viewport: ViewportSize): number {
  const intersects = rect.bottom > 0
    && rect.top < viewport.height
    && rect.right > 0
    && rect.left < viewport.width;
  if (intersects) return 0;

  const centerX = viewport.width / 2;
  const centerY = viewport.height / 2;
  const nearestX = Math.max(rect.left, Math.min(centerX, rect.right));
  const nearestY = Math.max(rect.top, Math.min(centerY, rect.bottom));
  return Math.hypot(nearestX - centerX, nearestY - centerY);
}

function stableKey(image: HTMLImageElement, url: string, seen: Map<string, number>): string {
  const existing = image.getAttribute(genericImageKeyAttr);
  if (existing) return existing;

  const occurrence = seen.get(url) ?? 0;
  seen.set(url, occurrence + 1);
  const key = `${fnv1a(url)}:${occurrence}`;
  image.setAttribute(genericImageKeyAttr, key);
  return key;
}

export function scanGenericImages(options: ScanOptions = {}): GenericImageCandidate[] {
  const root = options.root ?? document;
  const viewport = options.viewport ?? { width: window.innerWidth, height: window.innerHeight };
  const minNaturalSize = options.minNaturalSize ?? defaultMinNaturalSize;
  const minRenderedArea = options.minRenderedArea ?? defaultMinRenderedArea;

  const seen = new Map<string, number>();
  const candidates: GenericImageCandidate[] = [];

  for (const image of root.querySelectorAll<HTMLImageElement>('img')) {
    if (image.closest(EXTENSION_UI_SELECTOR)) continue;
    if (!image.complete) continue;
    if (image.naturalWidth < minNaturalSize || image.naturalHeight < minNaturalSize) continue;

    const url = resolveSourceUrl(image);
    if (!url || !isHttpUrl(url)) continue;

    const rect = image.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    if (rect.width * rect.height < minRenderedArea) continue;

    candidates.push({
      key: stableKey(image, url, seen),
      element: image,
      url,
      viewportPriority: toViewportPriority(rect, viewport),
    });
  }

  candidates.sort((left, right) => left.viewportPriority - right.viewportPriority);
  return candidates;
}
