/**
 * 源语言检测：从 OCR 文本判断这一页实际是什么语言。
 *
 * 存在的理由：设置的 sourceLang 默认是「日文」，但同一个扩展会被用在英文条漫、
 * 韩文 webtoon、中文漫上。把错误源语言交给翻译层会有两种后果：
 *   - 免费接口按 sl=ja 解析英文，容易原样返回或产生错译；
 *   - LLM 提示词里写着「从日文翻译」，模型会被误导。
 * 这里只做脚本级判定（假名 / 谚文 / 汉字 / 泰文 / 阿拉伯文 / 拉丁），不引模型、不联网，
 * 一页几十行文本的判定耗时在微秒级，且对 OCR 噪声（数字、标点、少量误识）有容错。
 * 拉丁字母内部再用特征词 / 变音符号细分常见语种，避免把西语、法语一律当英语。
 */

export type SourceScript = 'ja' | 'ko' | 'zh' | 'thai' | 'arabic' | 'latin';

export type ScriptCounts = {
  kana: number;
  hangul: number;
  han: number;
  latin: number;
  thai: number;
  arabic: number;
  other: number;
  /** 参与判定的字符数（不含空白、数字、标点）。 */
  total: number;
};

export type SourceLanguageDetection = {
  script: SourceScript | null;
  language: string | null;
  counts: ScriptCounts;
};

/** 少于这个字符数不判定，避免短标签 / 单个拟声字导致误判。 */
export const MIN_DETECT_LETTERS = 8;

const KANA_START = 0x3040;
const KANA_END = 0x30ff;
const HANGUL_START = 0xac00;
const HANGUL_END = 0xd7af;
const HANGUL_JAMO_START = 0x1100;
const HANGUL_JAMO_END = 0x11ff;
const HAN_START = 0x4e00;
const HAN_END = 0x9fff;
const THAI_START = 0x0e00;
const THAI_END = 0x0e7f;
const ARABIC_START = 0x0600;
const ARABIC_END = 0x06ff;

function isLatinLetter(code: number): boolean {
  return (
    (code >= 0x41 && code <= 0x5a)
    || (code >= 0x61 && code <= 0x7a)
    || (code >= 0xc0 && code <= 0x24f && code !== 0xd7 && code !== 0xf7)
  );
}

export function createEmptyCounts(): ScriptCounts {
  return { kana: 0, hangul: 0, han: 0, latin: 0, thai: 0, arabic: 0, other: 0, total: 0 };
}

export function countScripts(text: string): ScriptCounts {
  const counts = createEmptyCounts();
  for (const char of text) {
    const code = char.codePointAt(0);
    if (code === undefined) continue;
    if (code <= 0x40 || (code >= 0x5b && code <= 0x60) || (code >= 0x7b && code <= 0xbf)) {
      // ASCII 标点、空白、数字以及全角标点：不计入分母。
      continue;
    }
    if (code >= KANA_START && code <= KANA_END) {
      counts.kana += 1;
    } else if (
      (code >= HANGUL_START && code <= HANGUL_END)
      || (code >= HANGUL_JAMO_START && code <= HANGUL_JAMO_END)
    ) {
      counts.hangul += 1;
    } else if (code >= HAN_START && code <= HAN_END) {
      counts.han += 1;
    } else if (code >= THAI_START && code <= THAI_END) {
      counts.thai += 1;
    } else if (code >= ARABIC_START && code <= ARABIC_END) {
      counts.arabic += 1;
    } else if (isLatinLetter(code)) {
      counts.latin += 1;
    } else {
      counts.other += 1;
      continue;
    }
    counts.total += 1;
  }
  return counts;
}

function mergeCounts(target: ScriptCounts, add: ScriptCounts): void {
  target.kana += add.kana;
  target.hangul += add.hangul;
  target.han += add.han;
  target.latin += add.latin;
  target.thai += add.thai;
  target.arabic += add.arabic;
  target.other += add.other;
  target.total += add.total;
}

export function shareOf(counts: ScriptCounts, part: number): number {
  return counts.total === 0 ? 0 : part / counts.total;
}

export function detectScriptFromCounts(counts: ScriptCounts): SourceScript | null {
  if (counts.total < MIN_DETECT_LETTERS) return null;

  const kanaShare = shareOf(counts, counts.kana);
  const hangulShare = shareOf(counts, counts.hangul);
  const hanShare = shareOf(counts, counts.han);
  const latinShare = shareOf(counts, counts.latin);

  // 假名是日语独有信号：占比 5% 就足以定案，汉字再多也仍是日文。
  if (kanaShare >= 0.05) return 'ja';
  // 谚文在纯韩文里几乎 100%，阈值放宽到 20% 以抵抗 OCR 噪声与少量外来词。
  if (hangulShare >= 0.2) return 'ko';
  // 泰文、阿拉伯文自成一套字母表，出现相当比例即可定案。
  if (shareOf(counts, counts.thai) >= 0.3) return 'thai';
  if (shareOf(counts, counts.arabic) >= 0.3) return 'arabic';
  if (hanShare >= 0.6) return 'zh';
  if (latinShare >= 0.6) return 'latin';
  return null;
}

/** 拉丁字母内部的语种特征：变音符号 + 高频虚词。 */
const LATIN_LANGUAGE_MARKERS: ReadonlyArray<{
  language: string;
  /** 出现即强信号的字符（西语 ¿ ¡、法语 œ、德语 ß、葡语 ã õ 等）。 */
  chars: readonly string[];
  /** 高频虚词，按整词匹配。 */
  words: readonly string[];
}> = [
  {
    language: 'es',
    chars: ['¿', '¡', 'ñ'],
    words: ['que', 'de', 'el', 'la', 'los', 'las', 'para', 'pero', 'está', 'esto', 'muy', 'porque', 'usted', 'quiero'],
  },
  {
    language: 'fr',
    chars: ['œ', 'ç', 'à'],
    words: ['les', 'des', 'une', 'est', 'pas', 'que', 'pour', 'vous', 'nous', 'avec', 'dans', 'mais', 'cette', 'très'],
  },
  {
    language: 'de',
    chars: ['ß', 'ä', 'ö', 'ü'],
    words: ['der', 'die', 'das', 'und', 'ist', 'nicht', 'ich', 'du', 'wir', 'mit', 'aber', 'dich', 'mich', 'hier'],
  },
  {
    language: 'pt',
    chars: ['ã', 'õ'],
    words: ['não', 'que', 'uma', 'para', 'com', 'está', 'você', 'isso', 'mais', 'aqui', 'meu', 'minha'],
  },
  {
    language: 'it',
    chars: [],
    words: ['che', 'non', 'una', 'per', 'sono', 'questo', 'anche', 'cosa', 'adesso', 'perché', 'mio', 'tuo'],
  },
  {
    language: 'id',
    chars: [],
    words: ['yang', 'dan', 'tidak', 'untuk', 'aku', 'kamu', 'ini', 'itu', 'dengan', 'adalah', 'sudah'],
  },
  {
    language: 'vi',
    chars: ['ư', 'ơ', 'ạ', 'ế', 'ộ', 'ữ', 'ĩ'],
    words: ['của', 'và', 'là', 'không', 'tôi', 'bạn', 'một', 'này', 'được', 'những'],
  },
  {
    language: 'tr',
    chars: ['ğ', 'ş', 'ı', 'İ'],
    words: ['bir', 've', 'bu', 'için', 'ama', 'çok', 'sen', 'ben', 'değil'],
  },
];

/**
 * 从拉丁文本里细分语种。返回 null 表示没有足够证据（多半是英语或专有名词）。
 *
 * 只统计整词与特征字符，避免把英语里的 "de"、"la"（人名、地名）算成西语。
 */
export function detectLatinLanguage(text: string): string | null {
  const normalized = text.toLowerCase();
  if (!normalized.trim()) return null;
  const words: string[] = normalized.match(/[a-zà-öø-ÿœß]+/g) ?? [];
  if (words.length === 0) return null;

  let best: { language: string; score: number; charHits: number; distinctWords: number } | null = null;
  for (const marker of LATIN_LANGUAGE_MARKERS) {
    let charHits = 0;
    for (const char of marker.chars) {
      charHits += normalized.split(char).length - 1;
    }
    const matchedWords = new Set<string>();
    for (const word of marker.words) {
      if (words.includes(word)) matchedWords.add(word);
    }
    const distinctWords = matchedWords.size;
    const score = charHits * 3 + distinctWords;
    if (score === 0) continue;
    if (!best || score > best.score) {
      best = { language: marker.language, score, charHits, distinctWords };
    }
  }

  if (!best) return null;
  // 特征字符是最硬的证据（ñ/ß/ã/ğ 这些字母不会平白出现在英文里），
  // 但单个字符可能只是 OCR 噪声，所以要么命中两个字符，要么命中三个不同虚词。
  // 这条门槛专门防止把英文页误判成土耳其语/印尼语（它们的高频词太短、太像英语）。
  const strongCharEvidence = best.charHits >= 2;
  const strongWordEvidence = best.distinctWords >= 3 && best.score >= 5;
  if (!strongCharEvidence && !strongWordEvidence) return null;
  return best.language;
}

/** 把脚本判定结果映射成翻译接口使用的语言码。 */
export function languageForScript(script: SourceScript): string {
  switch (script) {
    case 'ja':
      return 'ja';
    case 'ko':
      return 'ko';
    case 'zh':
      return 'zh-CHS';
    case 'thai':
      return 'th';
    case 'arabic':
      return 'ar';
    default:
      return 'en';
  }
}

/** 已配置的语言码属于哪种脚本；无法判断时返回 null。 */
export function scriptOfLanguage(language: string | undefined): SourceScript | null {
  const normalized = (language ?? '').trim().toLowerCase();
  if (!normalized || normalized === 'auto') return null;
  if (normalized.startsWith('ja') || normalized === 'jp') return 'ja';
  if (normalized.startsWith('ko')) return 'ko';
  if (normalized.startsWith('zh')) return 'zh';
  if (normalized.startsWith('th')) return 'thai';
  if (normalized.startsWith('ar')) return 'arabic';
  if (
    normalized.startsWith('en')
    || normalized.startsWith('es')
    || normalized.startsWith('fr')
    || normalized.startsWith('de')
    || normalized.startsWith('pt')
    || normalized.startsWith('it')
    || normalized.startsWith('id')
    || normalized.startsWith('vi')
    || normalized.startsWith('tr')
  ) {
    return 'latin';
  }
  return null;
}

/** 用整页 OCR 文本判定源语言。 */
export function detectSourceLanguage(texts: readonly string[]): SourceLanguageDetection {
  const counts = createEmptyCounts();
  let latinSample = '';
  for (const text of texts) {
    if (!text) continue;
    mergeCounts(counts, countScripts(text));
    if (latinSample.length < 4000) {
      latinSample += ` ${text}`;
    }
  }
  const script = detectScriptFromCounts(counts);
  if (!script) {
    return { script: null, language: null, counts };
  }
  if (script === 'latin') {
    // 拉丁字母内部再细分：西语/法语/德语/葡语/意语/印尼语/越语/土语，认不出就按英语。
    return { script, language: detectLatinLanguage(latinSample) ?? 'en', counts };
  }
  return { script, language: languageForScript(script), counts };
}

/**
 * 决定本次请求真正要用的源语言。
 *
 * - `auto` 或空值：直接用检测结果；
 * - 配置语言与页面脚本一致：尊重配置（例如 zh-CHT 不会被改写成 zh-CHS）；
 * - 不一致：以页面实测脚本为准，因为 OCR 文本比设置项更可信。
 * - 拉丁语系内部（en/es/fr/de...）保留用户配置，避免特征词误判把西语改成英语。
 */
export function resolveSourceLanguage(
  configured: string | undefined,
  texts: readonly string[],
): { language: string; detection: SourceLanguageDetection; overridden: boolean } {
  const detection = detectSourceLanguage(texts);
  const fallback = (configured ?? '').trim() || 'auto';
  if (!detection.language) {
    return { language: fallback, detection, overridden: false };
  }
  const configuredScript = scriptOfLanguage(configured);
  if (configuredScript === null) {
    return { language: detection.language, detection, overridden: true };
  }
  if (configuredScript === detection.script) {
    // 同为拉丁语系但检测出更具体的语种时，若配置是 auto 才会走到这里，
    // 用户显式选定的拉丁语种一律尊重。
    return { language: fallback, detection, overridden: false };
  }
  return { language: detection.language, detection, overridden: true };
}
