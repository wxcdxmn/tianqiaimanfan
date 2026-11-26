import type {
  PipelineFontDescriptors,
  PlatformProvider,
} from '../../runtime/platform';

export const TYPESET_FONT_WEIGHT = 700;

const variableFontDescriptors = {
  style: 'normal',
  weight: '200 900',
} satisfies PipelineFontDescriptors;

const typesetFontAssets = [
  {
    path: 'fonts/SourceHanSansCN-VF.ttf.woff2',
    family: 'MTX-SourceHanSans-CN',
  },
  {
    path: 'fonts/SourceHanSansTW-VF.ttf.woff2',
    family: 'MTX-SourceHanSans-TW',
  },
] as const;

export function resolveTypesetFontFamily(targetLang?: string): string {
  // 繁体中文用 TW 字形，其余（简中/日/韩/拉丁/泰/阿）走 CN 字形，
  // Source Han Sans 本身含假名与谚文字形，缺字时浏览器会回落到系统字体。
  const normalized = (targetLang ?? '').trim().toLowerCase().replace(/_/g, '-');
  const traditional = normalized === 'zh-cht' || normalized === 'zh-tw' || normalized === 'zh-hant' || normalized === 'zh-hk';
  return traditional
    ? '"MTX-SourceHanSans-TW", "Noto Sans CJK TC", "PingFang TC", sans-serif'
    : '"MTX-SourceHanSans-CN", "Noto Sans CJK SC", "PingFang SC", sans-serif';
}

export function registerTypesetFonts(
  platform: PlatformProvider,
  resolveAssetUrl: (path: string) => string,
  targetLang?: string,
): void {
  const fontFamily = targetLang === undefined ? undefined : resolveTypesetFontFamily(targetLang);
  for (const font of typesetFontAssets) {
    if (fontFamily && !fontFamily.includes(`"${font.family}"`)) continue;
    platform.registerFont(
      resolveAssetUrl(font.path),
      font.family,
      variableFontDescriptors,
    );
  }
}

export function formatTypesetFont(
  fontSize: number,
  fontFamily: string,
): string {
  return `${TYPESET_FONT_WEIGHT} ${fontSize}px ${fontFamily}`;
}
