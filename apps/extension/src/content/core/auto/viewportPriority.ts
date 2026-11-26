export type ViewportSize = {
  width: number;
  height: number;
};

export type RectLike = {
  top: number;
  bottom: number;
  left: number;
  right: number;
};

/**
 * Ranking used by the RuneManga-style scrolling window.
 *
 * Images intersecting the viewport score 0 (what the reader is looking at
 * right now); everything else scores its distance to the viewport center, so
 * the next page about to scroll in beats the one 20 pages away.
 */
export function viewportPriority(rect: RectLike, viewport: ViewportSize): number {
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

export function currentViewport(): ViewportSize {
  if (typeof window === 'undefined') return { width: 0, height: 0 };
  const width = window.innerWidth;
  const height = window.innerHeight;
  return {
    width: Number.isFinite(width) ? width : 0,
    height: Number.isFinite(height) ? height : 0,
  };
}
