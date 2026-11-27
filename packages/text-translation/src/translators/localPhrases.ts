/**
 * 免费翻译通道「原样回吐」的短文本兜底。
 *
 * Google 网页接口对漫画里的拟声词、语气词（¿MMPH?、LEH?、…BLE.）经常原样
 * 返回——这些词在词典里没有对应词条，但读者需要的是中文的语气/声音，不是
 * 留在气泡里的西文字母。这里只做一个很小的固定映射表，命中即替换，不命中
 * 照常走原通道，不给正文台词引入机器翻译。
 *
 * 同样处理「OCR 噪声」：G:JNDZHSZ 这类把网点/线条认成字母的框，送去翻译
 * 只会原样回吐并占掉补翻名额，直接判失败（保留原文、不擦除）更合适。
 */

export type LocalPhraseMatch =
  | { kind: 'translate'; text: string }
  | { kind: 'untranslatable' };

/** 西语/葡语漫画里最常见的短拟声词、语气词；键统一小写去空白。 */
const INTERJECTIONS: Readonly<Record<string, string>> = {
  // 呻吟、闷哼
  mmph: '唔……',
  '¿mmph?': '唔？',
  mmpf: '唔……',
  mmm: '唔……',
  mhm: '嗯……',
  // 惊呼、疑问
  leh: '欸',
  'leh?': '欸？',
  '¿leh?': '欸？',
  eh: '嗯？',
  'eh?': '嗯？',
  '¿eh?': '嗯？',
  ehh: '诶……',
  ay: '哎呀',
  '¡ay!': '哎呀！',
  'ay!': '哎呀！',
  aah: '啊——',
  'aah!': '啊——！',
  ooh: '哦——',
  oof: '呃……',
  // 气声、停顿
  ble: '……',
  '...ble.': '……',
  'ble.': '……',
  hah: '哈',
  'hah!': '哈！',
  heh: '嘿',
  'heh.': '嘿。',
  sigh: '唉……',
  // 截尾的语气残片（OCR 常把拟声词切掉大半）
  '…n.': '……',
  '...n.': '……',
  '…m.': '……',
  '...m.': '……',
};

/**
 * OCR 噪声：一个字母 + 冒号 + 一串无意义大写字母/数字，或纯编码样式。
 * 要求至少 5 个尾部字符，避免误伤「A:OK」这类短台词。
 */
const OCR_NOISE_PATTERN = /^[A-Za-z]:[A-Z0-9]{5,}$/u;

export function matchLocalPhrase(source: string): LocalPhraseMatch | null {
  const trimmed = source.trim();
  if (!trimmed) return null;
  if (OCR_NOISE_PATTERN.test(trimmed)) return { kind: 'untranslatable' };
  const key = trimmed.toLowerCase().replace(/\s+/gu, '');
  const translated = INTERJECTIONS[key];
  return translated === undefined ? null : { kind: 'translate', text: translated };
}
