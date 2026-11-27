import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resetPlainTranslateState,
  translatePlainText,
} from '../../packages/text-translation/src/translators/plainTranslate';
import { resetBingWebState } from '../../packages/text-translation/src/translators/bingWeb';
import { createTextTranslator } from '../../packages/text-translation/src/translator';
import type { TextTranslationConfig } from '../../packages/text-translation/src/contracts';

const BING_PAGE = `
<html><body><script>
var _G = { IG:"ABC123IG" };
params_AbusePreventionHelper = [1795723729173,"TOKENVALUE",3600000];
</script></body></html>`;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function html(body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });
}

function mockFetch(route: (url: string) => Response | Promise<Response>) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push(url);
    return route(url);
  }));
  return calls;
}

beforeEach(() => {
  resetPlainTranslateState();
  resetBingWebState();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('指定引擎时只走该引擎', () => {
  it('选中必应时完全不碰谷歌', async () => {
    const calls = mockFetch((url) => {
      if (url.includes('/translator')) return html(BING_PAGE);
      if (url.includes('ttranslatev3')) {
        return json([{ translations: [{ text: '你好，世界', to: 'zh-Hans' }] }]);
      }
      if (url.includes('translate.googleapis.com')) {
        return new Response('', { status: 429 });
      }
      throw new Error(`未预期的请求: ${url}`);
    });

    await expect(
      translatePlainText('hello world', 'en', 'zh-CN', undefined, 'bing'),
    ).resolves.toBe('你好，世界');

    expect(calls.some((url) => url.includes('translate.googleapis.com'))).toBe(false);
    expect(calls.some((url) => url.includes('ttranslatev3'))).toBe(true);
  });

  it('选中谷歌时不会被限流推去必应，而是直接报限流', async () => {
    const calls = mockFetch((url) => {
      if (url.includes('translate.googleapis.com')) return new Response('', { status: 429 });
      if (url.includes('/translator')) return html(BING_PAGE);
      if (url.includes('ttranslatev3')) {
        return json([{ translations: [{ text: '不该出现的必应译文', to: 'zh-Hans' }] }]);
      }
      throw new Error(`未预期的请求: ${url}`);
    });

    await expect(
      translatePlainText('hello world', 'en', 'zh-CN', undefined, 'google'),
    ).rejects.toMatchObject({ code: 'plain_throttled' });

    expect(calls.some((url) => url.includes('ttranslatev3'))).toBe(false);
  }, 20000);

  it('未知通道直接报错', async () => {
    mockFetch(() => new Response('', { status: 500 }));
    await expect(
      translatePlainText('hi', 'en', 'zh-CN', undefined, 'deepl' as never),
    ).rejects.toThrow('未知的翻译通道: deepl');
  });
});

describe('翻译服务设置映射到通道', () => {
  function createConfig(translator: TextTranslationConfig['translator']): TextTranslationConfig {
    return {
      sourceLang: 'en',
      targetLang: 'zh-CHS',
      translator,
      llmProvider: 'deepseek',
      llmAuthMode: 'api_key',
      llmBaseUrl: 'https://example.invalid',
      llmModel: 'test-model',
    };
  }

  function createTransport() {
    const seen: Array<string | undefined> = [];
    return {
      seen,
      transport: {
        requestChatCompletion: async () => {
          throw new Error('不该走 LLM 通道');
        },
        translatePlain: async (request: { text: string; provider?: string }) => {
          seen.push(request.provider);
          return '译文';
        },
        translatePlainBatch: async (request: { texts: readonly string[]; provider?: string }) => {
          seen.push(request.provider);
          return request.texts.map(() => '译文');
        },
      },
    };
  }

  it('bing_web / mymemory_web / google_web 各自映射到对应通道', async () => {
    for (const [translator, provider] of [
      ['google_web', 'google'],
      ['bing_web', 'bing'],
      ['mymemory_web', 'mymemory'],
    ] as const) {
      const { transport, seen } = createTransport();
      const translatorImpl = createTextTranslator({ transport });
      await translatorImpl.translateRegions({
        regions: [{ id: 'r0', sourceText: 'hello', translatedText: '' }],
        config: createConfig(translator),
      });
      expect(seen).toEqual([provider]);
    }
  });

  it('合并通道也带上同一个通道 id', async () => {
    const { transport, seen } = createTransport();
    const translatorImpl = createTextTranslator({ transport });
    await translatorImpl.translateRegions({
      regions: [
        { id: 'r0', sourceText: 'hello', translatedText: '' },
        { id: 'r1', sourceText: 'world', translatedText: '' },
      ],
      config: createConfig('mymemory_web'),
    });
    expect(seen.every((provider) => provider === 'mymemory')).toBe(true);
    expect(seen.length).toBeGreaterThan(0);
  });
});
