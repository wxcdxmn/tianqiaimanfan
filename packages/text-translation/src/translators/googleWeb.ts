import { TranslationBatchShapeError, readRetryAfterMs } from './errors';

type GoogleTranslateSegment = [string?, string?, unknown?, unknown?];

export type GoogleTranslateRequest = {
  texts: readonly string[];
  from: string;
  to: string;
  signal?: AbortSignal;
};

/** 免费接口里单条请求的文本上限，过长会被截断或直接 400。 */
export const GOOGLE_MAX_QUERY_CHARS = 4500;
/** 多行合并翻译时给正文留的余量。 */
export const GOOGLE_MAX_BATCH_CHARS = 1200;

function normalizeLangCode(code: string): string {
  const normalized = code.trim().toLowerCase();
  if (!normalized) {
    return 'auto';
  }
  if (normalized === 'jp') {
    return 'ja';
  }
  if (normalized === 'zh' || normalized === 'zh-chs' || normalized === 'zh_cn' || normalized === 'zh-cn' || normalized === 'zh-hans') {
    return 'zh-CN';
  }
  if (normalized === 'zh-cht' || normalized === 'zh_tw' || normalized === 'zh-tw' || normalized === 'zh-hant' || normalized === 'zh-hk') {
    return 'zh-TW';
  }
  if (normalized === 'en-us') {
    return 'en';
  }
  if (normalized === 'pt-br' || normalized === 'pt-pt') {
    return 'pt';
  }
  if (normalized === 'ko-kr') {
    return 'ko';
  }
  if (normalized === 'ja-jp') {
    return 'ja';
  }
  return normalized;
}

function parseGoogleTranslateResponse(data: unknown): string {
  if (!Array.isArray(data) || !Array.isArray(data[0])) {
    throw new Error('Google 翻译响应格式异常');
  }
  const segments = data[0] as GoogleTranslateSegment[];
  const translated = segments
    .map((segment) => (Array.isArray(segment) && typeof segment[0] === 'string' ? segment[0] : ''))
    .join('')
    .trim();
  if (!translated) {
    throw new Error('Google 翻译响应为空');
  }
  return translated;
}

async function requestGoogle(
  text: string,
  from: string,
  to: string,
  signal?: AbortSignal,
): Promise<string> {
  const params = new URLSearchParams({
    client: 'gtx',
    sl: normalizeLangCode(from),
    tl: normalizeLangCode(to),
    dt: 't',
    q: text,
  });
  const endpoint = `https://translate.googleapis.com/translate_a/single?${params.toString()}`;

  const response = await fetch(endpoint, {
    method: 'GET',
    cache: 'no-store',
    signal,
  });
  if (!response.ok) {
    const error = new Error(`Google 翻译请求失败: ${response.status}`) as Error & {
      status?: number;
      retryAfterMs?: number;
    };
    error.status = response.status;
    error.retryAfterMs = readRetryAfterMs(response.headers.get('retry-after'));
    throw error;
  }

  const payload = (await response.json()) as unknown;
  return parseGoogleTranslateResponse(payload);
}

/**
 * 一次请求翻多条：把多行文本用换行拼成一个 q，Google 会按行返回多段译文。
 * 条数对不上时抛 TranslationBatchShapeError，调用方退回逐条翻译。
 */
export async function googleWebTranslateMany(
  request: GoogleTranslateRequest,
): Promise<string[]> {
  const { texts, from, to, signal } = request;
  if (texts.length === 0) {
    return [];
  }
  if (texts.length === 1) {
    return [await requestGoogle(texts[0], from, to, signal)];
  }

  const joined = texts.join('\n');
  const translated = await requestGoogle(joined, from, to, signal);
  const lines = translated.split('\n').map((line) => line.trim());
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  if (lines.length !== texts.length) {
    throw new TranslationBatchShapeError(
      `Google 合并翻译返回 ${lines.length} 行，期望 ${texts.length} 行`,
    );
  }
  return lines;
}

export async function googleWebTranslate(
  text: string,
  from: string,
  to: string,
  signal?: AbortSignal,
): Promise<string> {
  const [translated] = await googleWebTranslateMany({ texts: [text], from, to, signal });
  return translated;
}
