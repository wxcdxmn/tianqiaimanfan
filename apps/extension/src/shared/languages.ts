/**
 * 语言目录：源语言 / 目标语言共用一份定义。
 *
 * 存在的理由：早期版本把 `sourceLang` 写死成 `ja`、把目标语言写死成「简体/繁体中文」，
 * 设置界面也没有入口。条漫站大多是英文或韩文原文，写死的日文会让免费接口按错误语种
 * 解析、让提示词误导模型。这里把「能选哪些语言」收敛成一个地方，UI、配置归一化、
 * 提示词文案都从这里取，避免三处各写一份列表。
 */

export type LanguageOption = {
  /** 配置里持久化的语言码。 */
  value: string;
  /** 界面显示名。 */
  label: string;
  /** 中文提示词里使用的语言名。 */
  promptLabel: string;
};

/** 源语言选 `auto` 时按页面 OCR 文本实测判断。 */
export const AUTO_SOURCE_LANGUAGE = 'auto';

const LANGUAGE_CATALOG: readonly LanguageOption[] = [
  { value: 'zh-CHS', label: '简体中文', promptLabel: '简体中文' },
  { value: 'zh-CHT', label: '繁體中文', promptLabel: '繁体中文' },
  { value: 'en', label: 'English', promptLabel: '英文' },
  { value: 'ja', label: '日本語', promptLabel: '日文' },
  { value: 'ko', label: '한국어', promptLabel: '韩文' },
  { value: 'es', label: 'Español', promptLabel: '西班牙文' },
  { value: 'fr', label: 'Français', promptLabel: '法文' },
  { value: 'de', label: 'Deutsch', promptLabel: '德文' },
  { value: 'pt', label: 'Português', promptLabel: '葡萄牙文' },
  { value: 'ru', label: 'Русский', promptLabel: '俄文' },
  { value: 'it', label: 'Italiano', promptLabel: '意大利文' },
  { value: 'id', label: 'Bahasa Indonesia', promptLabel: '印尼文' },
  { value: 'vi', label: 'Tiếng Việt', promptLabel: '越南文' },
  { value: 'th', label: 'ไทย', promptLabel: '泰文' },
  { value: 'tr', label: 'Türkçe', promptLabel: '土耳其文' },
  { value: 'ar', label: 'العربية', promptLabel: '阿拉伯文' },
];

export const targetLanguageOptions: readonly LanguageOption[] = LANGUAGE_CATALOG;

export const sourceLanguageOptions: readonly LanguageOption[] = [
  { value: AUTO_SOURCE_LANGUAGE, label: '自动检测', promptLabel: '原文语言' },
  ...LANGUAGE_CATALOG,
];

const CATALOG_BY_VALUE = new Map<string, LanguageOption>(
  LANGUAGE_CATALOG.map((option) => [option.value.toLowerCase(), option]),
);

/** 常见别名（浏览器语言标签、旧配置、用户手写值）到规范语言码。 */
const LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
  zh: 'zh-CHS',
  'zh-cn': 'zh-CHS',
  'zh-chs': 'zh-CHS',
  'zh-hans': 'zh-CHS',
  'zh-sg': 'zh-CHS',
  'zh-tw': 'zh-CHT',
  'zh-cht': 'zh-CHT',
  'zh-hant': 'zh-CHT',
  'zh-hk': 'zh-CHT',
  'zh-mo': 'zh-CHT',
  jp: 'ja',
  'ja-jp': 'ja',
  kr: 'ko',
  'ko-kr': 'ko',
  'en-us': 'en',
  'en-gb': 'en',
  'pt-br': 'pt',
  'es-419': 'es',
};

export function canonicalizeLanguageCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  // 浏览器标签与旧配置里 `zh_Hant`、`ZH_tw` 这类下划线写法很常见，统一成连字符。
  const normalized = value.trim().toLowerCase().replace(/_/g, '-');
  if (!normalized) return null;
  const aliased = LANGUAGE_ALIASES[normalized];
  if (aliased) return aliased;
  const direct = CATALOG_BY_VALUE.get(normalized);
  return direct ? direct.value : null;
}

/** 目标语言：非法值回落到简体中文。 */
export function normalizeTargetLanguage(value: unknown, fallback = 'zh-CHS'): string {
  return canonicalizeLanguageCode(value) ?? fallback;
}

/** 源语言：允许 `auto`。 */
export function normalizeSourceLanguage(value: unknown, fallback = AUTO_SOURCE_LANGUAGE): string {
  if (typeof value === 'string' && value.trim().toLowerCase() === AUTO_SOURCE_LANGUAGE) {
    return AUTO_SOURCE_LANGUAGE;
  }
  return canonicalizeLanguageCode(value) ?? fallback;
}

/** 目标语言的中文名，用于图像模型提示词与调试日志。 */
export function targetLanguageLabel(targetLang: string): string {
  const canonical = canonicalizeLanguageCode(targetLang);
  if (!canonical) return '简体中文';
  return CATALOG_BY_VALUE.get(canonical.toLowerCase())?.promptLabel ?? '简体中文';
}

/** 界面显示名。 */
export function languageLabel(language: string): string {
  if (language.trim().toLowerCase() === AUTO_SOURCE_LANGUAGE) return '自动检测';
  const canonical = canonicalizeLanguageCode(language);
  if (!canonical) return language;
  return CATALOG_BY_VALUE.get(canonical.toLowerCase())?.label ?? canonical;
}

/** 排版字体族：繁体走 TW 字形，其余（含日/韩/拉丁）走 CN 字形。 */
export function fontVariantForTarget(targetLang: string): 'TW' | 'CN' {
  return canonicalizeLanguageCode(targetLang) === 'zh-CHT' ? 'TW' : 'CN';
}

/** 目标语言是否从右向左书写。 */
export function isRightToLeftLanguage(targetLang: string): boolean {
  return canonicalizeLanguageCode(targetLang) === 'ar';
}
