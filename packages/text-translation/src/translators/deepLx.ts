/**
 * DeepLX：社区维护的免费 DeepL 代理（OwO-Network/DeepLX 的公开兼容实现）。
 *
 * 不需要 API Key，POST JSON 拿译文。公开实例会挂，所以这里按顺序试几个，
 * 全部失败才抛错——调用方（plainTranslate）会把这次失败算到 DeepLX 这个通道头上。
 */

export type DeepLxTranslateRequest = {
  texts: readonly string[];
  from: string;
  to: string;
  signal?: AbortSignal;
};

/** 单个请求的正文上限：DeepL 官方 5000，公开代理普遍压得更低。 */
export const DEEPLX_MAX_CHARS = 1200;

/** 依次尝试的公开端点；自建 DeepLX 时可以用 globalThis.__shinobuDeepLxEndpoint 覆盖。 */
export const DEEPLX_ENDPOINTS: readonly string[] = [
  'https://api.deeplx.org/translate',
  'https://deeplx.vercel.app/translate',
];

function endpointList(): string[] {
  const override = (globalThis as { __shinobuDeepLxEndpoint?: unknown }).__shinobuDeepLxEndpoint;
  if (typeof override === 'string' && override.trim()) {
    return [override.trim()];
  }
  return [...DEEPLX_ENDPOINTS];
}

function mapLang(code: string, target: boolean): string {
  const lower = code.trim().toLowerCase();
  if (!lower || lower === 'auto') {
    return target ? 'ZH' : 'auto';
  }
  if (lower === 'zh' || lower === 'zh-chs' || lower === 'zh-hans' || lower === 'zh_cn') return 'ZH';
  if (lower === 'zh-tw' || lower === 'zh-cht' || lower === 'zh-hant' || lower === 'zh_cht') return 'ZH-HANT';
  if (lower === 'jp' || lower === 'ja' || lower === 'ja-jp') return 'JA';
  if (lower === 'ko' || lower === 'ko-kr') return 'KO';
  if (lower === 'en' || lower === 'en-us') return target ? 'EN-US' : 'EN';
  if (lower === 'en-gb') return 'EN-GB';
  return lower.toUpperCase();
}

function splitByLength(text: string, limit: number): string[] {
  if (text.length <= limit) {
    return [text];
  }
  const sentences = text.split(/(?<=[.!?…。！？])\s*/u).filter(Boolean);
  const chunks: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    if (current && current.length + sentence.length > limit) {
      chunks.push(current);
      current = '';
    }
    if (sentence.length > limit) {
      for (let index = 0; index < sentence.length; index += limit) {
        chunks.push(sentence.slice(index, index + limit));
      }
      continue;
    }
    current += sentence;
  }
  if (current) {
    chunks.push(current);
  }
  return chunks.length > 0 ? chunks : [text.slice(0, limit)];
}

type DeepLxPayload = {
  code?: number;
  message?: string;
  data?: unknown;
  // 有些代理直接返回 DeepL 原始结构
  translations?: Array<{ text?: string }>;
};

async function requestOne(
  text: string,
  from: string,
  to: string,
  signal?: AbortSignal,
): Promise<string> {
  const body = JSON.stringify({
    text,
    source_lang: mapLang(from, false),
    target_lang: mapLang(to, true),
  });
  let lastError: unknown = null;
  for (const endpoint of endpointList()) {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        cache: 'no-store',
        credentials: 'omit',
        signal,
      });
      if (!response.ok) {
        const error = new Error(`DeepLX 翻译请求失败: ${response.status}`) as Error & { status?: number };
        error.status = response.status;
        lastError = error;
        continue;
      }
      const payload = (await response.json()) as DeepLxPayload;
      const translated = typeof payload.data === 'string'
        ? payload.data
        : payload.translations?.[0]?.text;
      if (typeof translated === 'string' && translated.trim()) {
        return translated.trim();
      }
      if (typeof payload.code === 'number' && payload.code !== 200) {
        const error = new Error(`DeepLX 翻译请求失败: ${payload.code} ${payload.message ?? ''}`.trim()) as Error & { status?: number };
        // 官方约定 429 是限流，其余算参数/服务错误
        error.status = payload.code;
        lastError = error;
        continue;
      }
      lastError = new Error('DeepLX 翻译响应为空');
    } catch (error) {
      if (signal?.aborted) throw error;
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('DeepLX 翻译请求失败');
}

export async function deepLxTranslateMany(
  request: DeepLxTranslateRequest,
): Promise<string[]> {
  const { texts, from, to, signal } = request;
  if (texts.length === 0) {
    return [];
  }
  const output: string[] = [];
  for (const text of texts) {
    const chunks = splitByLength(text, DEEPLX_MAX_CHARS);
    const translated: string[] = [];
    for (const chunk of chunks) {
      translated.push(await requestOne(chunk, from, to, signal));
    }
    output.push(translated.join(''));
  }
  return output;
}
