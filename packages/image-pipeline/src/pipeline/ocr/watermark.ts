import type { TextRegion } from '../../types';

/**
 * 通用顶级域白名单：水印里常见「MANGA18FX.COM」「OMEGASCANS.ORG」这类站点名。
 * 正文对白极少包含裸域名，命中即视为水印。
 */
const DOMAIN_PATTERN = /\b[A-Z0-9][A-Z0-9-]{0,40}\.(?:COM|NET|ORG|IO|XYZ|TO|ME|CC|TV|CO|INFO|ONLINE|SITE|APP|BIZ|US|RU|EU|VIP)\b/i;

/**
 * 站点水印的兜底特征：位于页面顶部一条细带内、又细又长的单行小字，
 * 例如「Read Manga Online in English Free」。
 *
 * 阈值刻意保守：
 * - 顶带不超过页高 4% 且至多 400px——条漫首页顶部通常是水印/标题区；
 * - 高度不超过页高 0.8% 且至多 40px——正文对白字高很少低到这个量级；
 * - 宽高比 ≥ 5——水印是横贯整页的细条，对白框很少这么扁。
 */
export function isSiteWatermarkRegion(
  region: Pick<TextRegion, 'sourceText' | 'box'>,
  pageWidth: number,
  pageHeight: number,
): boolean {
  const text = region.sourceText.trim();
  if (!text) return false;
  if (DOMAIN_PATTERN.test(text)) return true;

  const pageH = Math.max(1, pageHeight);
  const pageW = Math.max(1, pageWidth);
  const box = region.box;
  const topBand = Math.min(pageH * 0.04, 400);
  const thinHeight = Math.min(pageH * 0.008, 40);
  if (box.height <= 0 || box.width <= 0) return false;
  const aspect = box.width / box.height;
  return box.y <= topBand
    && box.height <= thinHeight
    && aspect >= 5
    && box.width <= pageW * 0.98;
}
