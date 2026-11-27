import { describe, expect, it, vi } from 'vitest';
import { createTextTranslator } from '../../packages/text-translation/src/translator';
import type { TextTranslationConfig } from '../../packages/text-translation/src/contracts';

type PlainRequest = { text: string; from: string; to: string; preferredProvider?: string };

function createConfig(overrides: Partial<TextTranslationConfig> = {}): TextTranslationConfig {
  return {
    sourceLang: 'ja',
    targetLang: 'zh-CHS',
    translator: 'google_web',
    llmProvider: 'deepseek',
    llmAuthMode: 'api_key',
    llmBaseUrl: 'https://example.invalid',
    llmModel: 'test-model',
    ...overrides,
  };
}

function createTransport(handler: (request: PlainRequest) => Promise<string>) {
  const calls: PlainRequest[] = [];
  return {
    calls,
    transport: {
      requestChatCompletion: async () => {
        throw new Error('不该走 LLM 通道');
      },
      translatePlain: async (request: PlainRequest & { preferredProvider?: string }) => {
        calls.push({ text: request.text, from: request.from, to: request.to });
        return handler(request);
      },
    },
  };
}

function regionsOf(...texts: string[]) {
  return texts.map((text, index) => ({
    id: `r${index}`,
    sourceText: text,
    translatedText: '',
  }));
}

describe('免费翻译通道的健壮性', () => {
  it('按页面实测语言替换错误的 sourceLang', async () => {
    const { transport, calls } = createTransport(async () => '译文');
    const translator = createTextTranslator({ transport });

    await translator.translateRegions({
      regions: regionsOf(
        "YOU SHOULD'VE SHOWED UP THE MOMENT I REGRESSED.",
        'I told you to wait until I called for you.',
      ),
      config: createConfig({ sourceLang: 'ja' }),
    });

    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.from === 'en')).toBe(true);
  });

  it('日文页面继续沿用配置的 ja，不触发改写', async () => {
    const { transport, calls } = createTransport(async () => '译文');
    const translator = createTextTranslator({ transport });

    await translator.translateRegions({
      regions: regionsOf('お前はもう死んでいる', '何を言っているんだ'),
      config: createConfig({ sourceLang: 'ja' }),
    });

    expect(calls.every((call) => call.from === 'ja')).toBe(true);
  });

  it('5xx 会重试，成功后正常返回译文', async () => {
    let attempt = 0;
    const { transport, calls } = createTransport(async () => {
      attempt += 1;
      if (attempt === 1) {
        throw new Error('Google 翻译请求失败: 503');
      }
      return '重试后的译文';
    });
    const translator = createTextTranslator({ transport });

    const result = await translator.translateRegions({
      regions: regionsOf('One single english line here.'),
      config: createConfig(),
    });

    expect(calls).toHaveLength(2);
    expect(result.regions[0].translatedText).toBe('重试后的译文');
    expect(result.regions[0].translationFailed).toBeUndefined();
  });

  it('单条失败不拖垮整页：失败区域标记 translationFailed 并保留原文', async () => {
    const { transport } = createTransport(async (request) => {
      if (request.text.includes('BROKEN')) {
        throw new Error('Google 翻译请求失败: 400');
      }
      return `译:${request.text}`;
    });
    const translator = createTextTranslator({ transport });

    const result = await translator.translateRegions({
      regions: regionsOf('First good english line.', 'A BROKEN english line.', 'Third good english line.'),
      config: createConfig(),
    });

    expect(result.regions.map((region) => region.translatedText)).toEqual([
      '译:First good english line.',
      '',
      '译:Third good english line.',
    ]);
    expect(result.regions[1].translationFailed).toBe(true);
    expect(result.regions[0].translationFailed).toBeUndefined();
  });

  it('全部失败时抛错，避免静默产出空页面', async () => {
    const { transport } = createTransport(async () => {
      throw new Error('Google 翻译请求失败: 400');
    });
    const translator = createTextTranslator({ transport });

    await expect(
      translator.translateRegions({
        regions: regionsOf('Only one english line here.'),
        config: createConfig(),
      }),
    ).rejects.toThrow(/翻译全部失败/);
  });

  it('免费通道全部限流时不再调用 LLM，整页报错', async () => {
    const llmRequests: unknown[] = [];
    const { transport } = createTransport(async () => {
      const error = new Error('免费翻译通道全部失败: Google: 429') as Error & { code?: string };
      error.code = 'plain_throttled';
      throw error;
    });
    transport.requestChatCompletion = async (request) => {
      llmRequests.push(request);
      throw new Error('不该走 LLM 通道');
    };
    const translator = createTextTranslator({ transport });

    await expect(
      translator.translateRegions({
        regions: regionsOf('First english line.', 'Second english line.'),
        config: createConfig(),
      }),
    ).rejects.toThrow(/翻译全部失败/);
    expect(llmRequests).toHaveLength(0);
  });

  it('未配置 LLM（transport 拒绝）不影响免费通道行为：限流耗尽抛错', async () => {
    const { transport } = createTransport(async () => {
      throw new Error('Google 翻译请求失败: 429');
    });
    transport.requestChatCompletion = async () => {
      throw new Error('LLM 模式需要填写 API Key');
    };
    const translator = createTextTranslator({ transport });

    await expect(
      translator.translateRegions({
        regions: regionsOf('Only one english line here.'),
        config: createConfig(),
      }),
    ).rejects.toThrow(/翻译全部失败/);
  });

  it('部分免费失败时，失败条目按通道链轮换兜底（不调用 LLM）', async () => {
    const llmRequests: unknown[] = [];
    const { transport } = createTransport(async (request) => {
      // 谷歌（首选通道）对 BROKEN 文本报 400；其他通道都能翻。
      if (request.preferredProvider === 'google' && request.text.includes('BROKEN')) {
        throw new Error('Google 翻译请求失败: 400');
      }
      return `译(${request.preferredProvider}):${request.text}`;
    });
    transport.requestChatCompletion = async (request) => {
      llmRequests.push(request);
      throw new Error('不该走 LLM 通道');
    };
    const translator = createTextTranslator({ transport });

    const result = await translator.translateRegions({
      regions: regionsOf('A BROKEN english line.', 'Good english line.'),
      config: createConfig(),
    });

    expect(result.regions[0].translatedText).toBe('译(bing):A BROKEN english line.');
    expect(result.regions[1].translatedText).toBe('译(google):Good english line.');
    expect(result.regions.every((region) => !region.translationFailed)).toBe(true);
    expect(llmRequests).toHaveLength(0);
  });

  it('谷歌原样回吐专名时，轮换到必应翻出真译文（不调用 LLM）', async () => {
    const llmRequests: unknown[] = [];
    const { transport } = createTransport(async (request) => {
      // 谷歌对专名整行原样回吐；必应能给出真译文。
      if (request.preferredProvider === 'google') {
        return request.text;
      }
      return `译(${request.preferredProvider}):${request.text}`;
    });
    transport.requestChatCompletion = async (request) => {
      llmRequests.push(request);
      throw new Error('不该走 LLM 通道');
    };
    const translator = createTextTranslator({ transport });

    const result = await translator.translateRegions({
      regions: regionsOf('¿R-RYU ZION...?', 'WHY DID YOU COME HERE?'),
      config: createConfig(),
    });

    expect(result.regions.map((region) => region.translatedText)).toEqual([
      '译(bing):¿R-RYU ZION...?',
      '译(bing):WHY DID YOU COME HERE?',
    ]);
    expect(result.regions.every((region) => !region.translationFailed)).toBe(true);
    expect(llmRequests).toHaveLength(0);
  });

  it('空文本区域不会发起请求', async () => {
    const { transport, calls } = createTransport(async () => '译文');
    const translator = createTextTranslator({ transport });

    const result = await translator.translateRegions({
      regions: regionsOf('', '   '),
      config: createConfig(),
    });

    expect(calls).toHaveLength(0);
    expect(result.regions.every((region) => !region.translationFailed)).toBe(true);
  });

  it('排队请求之间保持节流间隔', async () => {
    const timestamps: number[] = [];
    const { transport } = createTransport(async () => {
      timestamps.push(Date.now());
      return '译文';
    });
    const translator = createTextTranslator({ transport });

    await translator.translateRegions({
      regions: regionsOf('First english line here.', 'Second english line here.', 'Third english line here.'),
      config: createConfig(),
    });

    expect(timestamps).toHaveLength(3);
    for (let i = 1; i < timestamps.length; i += 1) {
      expect(timestamps[i] - timestamps[i - 1]).toBeGreaterThanOrEqual(140);
    }
  });
});

describe('免费通道的调用顺序', () => {
  it('保持输入顺序，避免译文与气泡错位', async () => {
    const { transport } = createTransport(async (request) => `译:${request.text}`);
    const translator = createTextTranslator({ transport });

    const input = regionsOf('AAAA english text', 'BBBB english text');
    const result = await translator.translateRegions({
      regions: input,
      config: createConfig(),
    });

    expect(result.regions.map((region) => region.id)).toEqual(['r0', 'r1']);
    expect(result.regions[0].translatedText).toBe('译:AAAA english text');
  });
});

type BatchRequest = { texts: readonly string[]; from: string; to: string };

function createBatchTransport(
  onBatch: (request: BatchRequest) => Promise<string[]>,
  onSingle: (request: PlainRequest) => Promise<string>,
) {
  const batches: BatchRequest[] = [];
  const singles: PlainRequest[] = [];
  return {
    batches,
    singles,
    transport: {
      requestChatCompletion: async () => {
        throw new Error('不该走 LLM 通道');
      },
      translatePlain: async (request: PlainRequest) => {
        singles.push({ text: request.text, from: request.from, to: request.to });
        return onSingle(request);
      },
      translatePlainBatch: async (request: BatchRequest) => {
        batches.push({ texts: [...request.texts], from: request.from, to: request.to });
        return onBatch(request);
      },
    },
  };
}

describe('免费通道的合并翻译', () => {
  it('整页合并成一次请求，返回顺序与输入一致', async () => {
    const { transport, batches, singles } = createBatchTransport(
      async (request) => request.texts.map((text) => `合:${text}`),
      async (request) => `单:${request.text}`,
    );
    const translator = createTextTranslator({ transport });

    const result = await translator.translateRegions({
      regions: regionsOf(
        'First english line here.',
        'Second english line here.',
        'Third english line here.',
      ),
      config: createConfig(),
    });

    expect(batches).toHaveLength(1);
    expect(singles).toHaveLength(0);
    expect(result.regions.map((region) => region.translatedText)).toEqual([
      '合:First english line here.',
      '合:Second english line here.',
      '合:Third english line here.',
    ]);
  });

  it('合并失败时该组退回逐条，不影响整页', async () => {
    const { transport, batches, singles } = createBatchTransport(
      async () => {
        throw new Error('合并翻译返回 2 行，期望 3 行');
      },
      async (request) => `单:${request.text}`,
    );
    const translator = createTextTranslator({ transport });

    const result = await translator.translateRegions({
      regions: regionsOf('First english line.', 'Second english line.', 'Third english line.'),
      config: createConfig(),
    });

    expect(batches).toHaveLength(1);
    expect(singles).toHaveLength(3);
    expect(result.regions.every((region) => region.translatedText.startsWith('单:'))).toBe(true);
  });

  it('多行区域送进合并通道时压成单行，避免译文按行错位', async () => {
    const { transport, batches, singles } = createBatchTransport(
      async (request) => request.texts.map((text) => `合:${text}`),
      async (request) => `单:${request.text}`,
    );
    const translator = createTextTranslator({ transport });

    const result = await translator.translateRegions({
      regions: regionsOf(
        '몬스터들과\n본드래곤을',
        '이번 사건을\n계기로\n카시드노바는',
      ),
      config: createConfig(),
    });

    // 每一条都必须是不含换行的单行，否则合并通道按行切回来时会串位。
    expect(batches).toHaveLength(1);
    expect(batches[0].texts).toEqual([
      '몬스터들과 본드래곤을',
      '이번 사건을 계기로 카시드노바는',
    ]);
    expect(singles).toHaveLength(0);
    expect(result.regions.map((region) => region.translatedText)).toEqual([
      '合:몬스터들과 본드래곤을',
      '合:이번 사건을 계기로 카시드노바는',
    ]);
  });

  it('通道全部限流时快速失败，不逐条空转', async () => {
    const { transport, singles } = createBatchTransport(
      async () => {
        throw new Error('合并失败');
      },
      async () => {
        const error = new Error('免费翻译通道全部失败: Google: Google 翻译请求失败: 429') as Error & {
          code?: string;
        };
        error.code = 'plain_throttled';
        throw error;
      },
    );
    const translator = createTextTranslator({ transport });

    await expect(
      translator.translateRegions({
        regions: regionsOf('First english line.', 'Second english line.', 'Third english line.'),
        config: createConfig(),
      }),
    ).rejects.toThrow(/翻译全部失败/);
    // 第一条就判定为限流，后面两条不再发起请求。
    expect(singles).toHaveLength(1);
  });
});
