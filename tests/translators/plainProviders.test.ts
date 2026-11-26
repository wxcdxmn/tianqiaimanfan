import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getPlainTranslateDiagnostics,
  resetPlainTranslateState,
  translatePlainText,
} from '../../packages/text-translation/src/translators/plainTranslate';
import { resetBingWebState } from '../../packages/text-translation/src/translators/bingWeb';

const BING_PAGE = `
<html><body><script>
var _G = { IG:"ABC123IG" };
params_AbusePreventionHelper = [1795723729173,"TOKENVALUE",3600000];
</script></body></html>`;

type Route = (url: string, init?: RequestInit) => Response | Promise<Response>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function html(body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });
}

function mockFetch(route: Route) {
  const calls: string[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push(url);
    return route(url, init);
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

beforeEach(() => {
  resetPlainTranslateState();
  resetBingWebState();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('免费通道自动降级', () => {
  it('Google 429 后自动切到 Bing，并把 Google 排到后面', async () => {
    const calls = mockFetch((url) => {
      if (url.includes('translate.googleapis.com')) {
        return new Response('', { status: 429 });
      }
      if (url.includes('/translator')) {
        return html(BING_PAGE);
      }
      if (url.includes('ttranslatev3')) {
        return json([{ translations: [{ text: '你好，世界', to: 'zh-Hans' }] }]);
      }
      throw new Error(`未预期的请求: ${url}`);
    });

    await expect(translatePlainText('hello world', 'en', 'zh-CN')).resolves.toBe('你好，世界');
    expect(calls.some((url) => url.includes('ttranslatev3'))).toBe(true);

    // 第二条请求不应再先撞一次 Google（冷却中直接跳过）。
    const googleCallsBefore = calls.filter((url) => url.includes('translate.googleapis.com')).length;
    await expect(translatePlainText('second line', 'en', 'zh-CN')).resolves.toBe('你好，世界');
    const googleCallsAfter = calls.filter((url) => url.includes('translate.googleapis.com')).length;
    expect(googleCallsAfter).toBe(googleCallsBefore);
  });

  it('Google 与 Bing 都不可用时兜底 MyMemory', async () => {
    mockFetch((url) => {
      if (url.includes('translate.googleapis.com')) {
        return new Response('', { status: 429 });
      }
      if (url.includes('/translator')) {
        return html(BING_PAGE);
      }
      if (url.includes('ttranslatev3')) {
        return new Response('', { status: 500 });
      }
      if (url.includes('mymemory.translated.net')) {
        return json({
          responseStatus: 200,
          responseData: { translatedText: '你好' },
        });
      }
      throw new Error(`未预期的请求: ${url}`);
    });

    await expect(translatePlainText('hello', 'en', 'zh-CN')).resolves.toBe('你好');
    const states = getPlainTranslateDiagnostics();
    expect(states.find((state) => state.provider === 'google')?.strikes).toBeGreaterThan(0);
    expect(states.find((state) => state.provider === 'bing')?.strikes).toBeGreaterThan(0);
  });

  it('全部通道失败时抛错并标记为限流', async () => {
    mockFetch((url) => {
      if (url.includes('translate.googleapis.com')) return new Response('', { status: 429 });
      if (url.includes('/translator')) {
        return html(BING_PAGE);
      }
      throw new Error(`未预期的请求: ${url}`);
    });

    await expect(translatePlainText('hello', 'en', 'zh-CN')).rejects.toMatchObject({
      code: 'plain_throttled',
    });
  }, 20000);

  it('多行合并请求只发一次，返回条数与输入一致', async () => {
    const calls = mockFetch((url) => {
      if (url.includes('translate.googleapis.com')) {
        const q = new URL(url).searchParams.get('q') ?? '';
        // Google 的真实响应里，每个分段末尾带着源文的换行符。
        const lines = q.split('\n').map((line) => [line.toUpperCase() + '\n']);
        return json([lines, null, 'en']);
      }
      throw new Error(`未预期的请求: ${url}`);
    });

    const output = await import('../../packages/text-translation/src/translators/plainTranslate')
      .then((mod) => mod.translatePlainBatch(['one', 'two', 'three'], 'en', 'zh-CN'));

    expect(output).toEqual(['ONE', 'TWO', 'THREE']);
    expect(calls).toHaveLength(1);
  });
});
