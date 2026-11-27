import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEEPLX_MAX_CHARS,
  deepLxTranslateMany,
} from '../../packages/text-translation/src/translators/deepLx';

function mockFetch(route: (url: string, init?: RequestInit) => Response) {
  const calls: Array<{ url: string; body: string }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, body: String(init?.body ?? '') });
    return route(url, init);
  }));
  return calls;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete (globalThis as { __shinobuDeepLxEndpoint?: string }).__shinobuDeepLxEndpoint;
});

describe('deepLxTranslateMany', () => {
  it('按 DeepLX 约定提交语言码，返回 data 字段', async () => {
    const calls = mockFetch(() => json({ code: 200, data: '你好' }));
    const output = await deepLxTranslateMany({ texts: ['hello'], from: 'auto', to: 'zh-CHS' });
    expect(output).toEqual(['你好']);
    expect(calls[0].url).toBe('https://api.deeplx.org/translate');
    const body = JSON.parse(calls[0].body) as Record<string, string>;
    expect(body).toEqual({ text: 'hello', source_lang: 'auto', target_lang: 'ZH' });
  });

  it('繁体目标走 ZH-HANT，日文源走 JA', async () => {
    const calls = mockFetch(() => json({ code: 200, data: '哈囉' }));
    await deepLxTranslateMany({ texts: ['こんにちは'], from: 'ja', to: 'zh-CHT' });
    const body = JSON.parse(calls[0].body) as Record<string, string>;
    expect(body.source_lang).toBe('JA');
    expect(body.target_lang).toBe('ZH-HANT');
  });

  it('第一个端点 5xx 时换下一个端点', async () => {
    const calls = mockFetch((url) =>
      url.includes('deeplx.org')
        ? json({ message: 'down' }, 502)
        : json({ code: 200, data: '译文' }));
    const output = await deepLxTranslateMany({ texts: ['hello'], from: 'en', to: 'zh' });
    expect(output).toEqual(['译文']);
    expect(calls.length).toBe(2);
  });

  it('全部端点失败时抛错并带上状态码', async () => {
    mockFetch(() => json({ message: 'rate limited' }, 429));
    await expect(
      deepLxTranslateMany({ texts: ['hello'], from: 'en', to: 'zh' }),
    ).rejects.toMatchObject({ status: 429 });
  });

  it('支持 code 非 200 的业务错误', async () => {
    mockFetch(() => json({ code: 429, message: 'too many requests' }));
    await expect(
      deepLxTranslateMany({ texts: ['hello'], from: 'en', to: 'zh' }),
    ).rejects.toMatchObject({ status: 429 });
  });

  it('超长正文按句切成多段再拼回', async () => {
    const long = `${'あ'.repeat(DEEPLX_MAX_CHARS)}。${'い'.repeat(10)}。`;
    const calls = mockFetch(() => json({ code: 200, data: 'X' }));
    const output = await deepLxTranslateMany({ texts: [long], from: 'ja', to: 'zh' });
    expect(calls.length).toBeGreaterThan(1);
    expect(output).toEqual(['X'.repeat(calls.length)]);
  });

  it('可用 globalThis.__shinobuDeepLxEndpoint 指向自建实例', async () => {
    (globalThis as { __shinobuDeepLxEndpoint?: string }).__shinobuDeepLxEndpoint = 'http://127.0.0.1:1188/translate';
    const calls = mockFetch(() => json({ code: 200, data: '好' }));
    await deepLxTranslateMany({ texts: ['hello'], from: 'en', to: 'zh' });
    expect(calls[0].url).toBe('http://127.0.0.1:1188/translate');
  });
});
