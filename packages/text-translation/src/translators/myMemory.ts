export type MyMemoryTranslateRequest = {
  texts: readonly string[];
  from: string;
  to: string;
  signal?: AbortSignal;
};

/** MyMemory 免费额度按字符计（匿名约 5000 字符/天），单次请求 500 字符封顶。 */
export const MYMEMORY_MAX_CHARS = 480;

function mapLang(code: string): string {
  const normalized = code.trim();
  const lower = normalized.toLowerCase();
  if (lower === 'jp') return 'ja';
  if (lower === 'zh' || lower === 'zh-chs' || lower === 'zh-hans' || lower === 'zh_cn') return 'zh-CN';
  if (lower === 'zh-tw' || lower === 'zh-hant' || lower === 'zh_cht') return 'zh-TW';
  if (lower === 'ko-kr') return 'ko';
  if (lower === 'ja-jp') return 'ja';
  return normalized;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&quot;/gu, '"')
    .replace(/&#39;/gu, "'")
    .replace(/&amp;/gu, '&')
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>');
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

async function requestMyMemory(
  text: string,
  from: string,
  to: string,
  signal?: AbortSignal,
): Promise<string> {
  const langpair = `${mapLang(from)}|${mapLang(to)}`;
  const endpoint = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${encodeURIComponent(langpair)}`;
  const response = await fetch(endpoint, {
    method: 'GET',
    cache: 'no-store',
    credentials: 'omit',
    signal,
  });
  if (!response.ok) {
    const error = new Error(`MyMemory 翻译请求失败: ${response.status}`) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  const payload = (await response.json()) as {
    responseStatus?: number | string;
    responseDetails?: string;
    responseData?: { translatedText?: string };
  };
  const status = Number(payload.responseStatus ?? 0);
  const detail = payload.responseDetails ?? '';
  if (status !== 200 || /MYMEMORY WARNING/iu.test(detail) || /MYMEMORY WARNING/iu.test(payload.responseData?.translatedText ?? '')) {
    const error = new Error(
      `MyMemory 翻译请求失败: ${status === 200 ? 429 : status}`,
    ) as Error & { status?: number };
    error.status = status === 200 ? 429 : status;
    throw error;
  }
  const translated = payload.responseData?.translatedText;
  if (typeof translated !== 'string' || !translated.trim()) {
    throw new Error('MyMemory 翻译响应为空');
  }
  return decodeEntities(translated).trim();
}

export async function myMemoryTranslateMany(
  request: MyMemoryTranslateRequest,
): Promise<string[]> {
  const { texts, from, to, signal } = request;
  if (texts.length === 0) {
    return [];
  }
  const output: string[] = [];
  for (const text of texts) {
    const chunks = splitByLength(text, MYMEMORY_MAX_CHARS);
    const translatedChunks: string[] = [];
    for (const chunk of chunks) {
      translatedChunks.push(await requestMyMemory(chunk, from, to, signal));
    }
    output.push(translatedChunks.join(''));
  }
  return output;
}
