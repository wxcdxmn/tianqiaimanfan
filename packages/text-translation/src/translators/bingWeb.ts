import { TranslationBatchShapeError } from './errors';

type BingAuth = {
  host: string;
  ig: string;
  key: string;
  token: string;
  expiresAt: number;
};

export type BingTranslateRequest = {
  texts: readonly string[];
  from: string;
  to: string;
  signal?: AbortSignal;
};

/** 多行合并翻译的正文上限，Bing 对单次 text 长度较宽松，但仍给个保险值。 */
export const BING_MAX_BATCH_CHARS = 1800;

const AUTH_TTL_MS = 20 * 60 * 1000;

let cachedAuth: BingAuth | null = null;
let inflightAuth: Promise<BingAuth> | null = null;

function mapSourceLang(code: string): string {
  const normalized = code.trim().toLowerCase();
  if (!normalized || normalized === 'auto') {
    return 'auto-detect';
  }
  if (normalized === 'jp') return 'ja';
  if (normalized === 'zh-cn' || normalized === 'zh-chs' || normalized === 'zh' || normalized === 'zh-hans') return 'zh-Hans';
  if (normalized === 'zh-tw' || normalized === 'zh-cht' || normalized === 'zh-hant') return 'zh-Hant';
  return normalized;
}

function mapTargetLang(code: string): string {
  const normalized = mapSourceLang(code);
  return normalized === 'auto-detect' ? 'en' : normalized;
}

function parseAuth(html: string, host: string): BingAuth {
  const ig = /IG:"([^"]+)"/u.exec(html)?.[1];
  const params = /params_AbusePreventionHelper\s*=\s*\[(\d+),"([^"]+)",(\d+)\]/u.exec(html);
  if (!ig || !params) {
    throw new Error('Bing 翻译鉴权参数缺失');
  }
  return {
    host,
    ig,
    key: params[1],
    token: params[2],
    expiresAt: Date.now() + Math.min(Number(params[3]) || AUTH_TTL_MS, AUTH_TTL_MS) - 60_000,
  };
}

async function fetchBingAuth(signal?: AbortSignal): Promise<BingAuth> {
  const response = await fetch('https://www.bing.com/translator?setlang=en', {
    method: 'GET',
    cache: 'no-store',
    credentials: 'omit',
    signal,
  });
  if (!response.ok) {
    throw new Error(`Bing 翻译鉴权失败: ${response.status}`);
  }
  const host = new URL(response.url || 'https://www.bing.com').origin;
  const html = await response.text();
  return parseAuth(html, host);
}

async function getBingAuth(signal?: AbortSignal, forceRefresh = false): Promise<BingAuth> {
  if (!forceRefresh && cachedAuth && cachedAuth.expiresAt > Date.now()) {
    return cachedAuth;
  }
  if (!forceRefresh && inflightAuth) {
    return inflightAuth;
  }
  const task = fetchBingAuth(signal)
    .then((auth) => {
      cachedAuth = auth;
      return auth;
    })
    .finally(() => {
      if (inflightAuth === task) {
        inflightAuth = null;
      }
    });
  inflightAuth = task;
  return task;
}

async function requestBing(
  auth: BingAuth,
  text: string,
  from: string,
  to: string,
  signal?: AbortSignal,
): Promise<string> {
  const body = new URLSearchParams({
    fromLang: mapSourceLang(from),
    to: mapTargetLang(to),
    text,
    token: auth.token,
    key: auth.key,
  });
  const endpoint = `${auth.host}/ttranslatev3?isVertical=1&IG=${encodeURIComponent(auth.ig)}&IID=translator.5028.1`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    cache: 'no-store',
    credentials: 'omit',
    signal,
  });
  if (!response.ok) {
    const error = new Error(`Bing 翻译请求失败: ${response.status}`) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  const payload = (await response.json()) as unknown;
  const translated = Array.isArray(payload)
    ? (payload[0] as { translations?: Array<{ text?: unknown }> } | undefined)?.translations?.[0]?.text
    : undefined;
  if (typeof translated !== 'string' || !translated.trim()) {
    throw new Error('Bing 翻译响应为空');
  }
  return translated.trim();
}

export async function bingWebTranslateMany(request: BingTranslateRequest): Promise<string[]> {
  const { texts, from, to, signal } = request;
  if (texts.length === 0) {
    return [];
  }

  const translateAll = async (forceRefresh: boolean): Promise<string[]> => {
    const auth = await getBingAuth(signal, forceRefresh);
    const joined = texts.length === 1 ? texts[0] : texts.join('\n');
    const translated = await requestBing(auth, joined, from, to, signal);
    if (texts.length === 1) {
      return [translated];
    }
    const lines = translated.split('\n').map((line) => line.trim());
    while (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop();
    }
    if (lines.length !== texts.length) {
      throw new TranslationBatchShapeError(
        `Bing 合并翻译返回 ${lines.length} 行，期望 ${texts.length} 行`,
      );
    }
    return lines;
  };

  try {
    return await translateAll(false);
  } catch (error) {
    // 鉴权 token 失效时换一份重新来一次；其它错误直接上抛给上层换通道。
    const status = (error as { status?: number } | null)?.status;
    if (status === 400 || status === 401 || status === 403) {
      cachedAuth = null;
      return translateAll(true);
    }
    throw error;
  }
}

export async function bingWebTranslate(
  text: string,
  from: string,
  to: string,
  signal?: AbortSignal,
): Promise<string> {
  const [translated] = await bingWebTranslateMany({ texts: [text], from, to, signal });
  return translated;
}

/** 仅用于测试：清掉缓存的鉴权信息。 */
export function resetBingWebState(): void {
  cachedAuth = null;
  inflightAuth = null;
}
