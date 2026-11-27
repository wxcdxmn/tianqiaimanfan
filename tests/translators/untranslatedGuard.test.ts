import { describe, expect, it } from 'vitest';

import {
  createTextTranslator,
  looksUntranslated,
} from '../../packages/text-translation/src/translator';
import type { TextTranslationConfig } from '../../packages/text-translation/src/contracts';

function createConfig(overrides: Partial<TextTranslationConfig> = {}): TextTranslationConfig {
  return {
    sourceLang: 'ko',
    targetLang: 'zh-CHS',
    translator: 'google_web',
    llmProvider: 'deepseek',
    llmAuthMode: 'api_key',
    llmBaseUrl: 'https://example.invalid',
    llmModel: 'test-model',
    ...overrides,
  };
}

function createTransport(handler: (text: string) => Promise<string>) {
  const calls: string[] = [];
  return {
    calls,
    transport: {
      requestChatCompletion: async () => {
        throw new Error('不该走 LLM 通道');
      },
      translatePlain: async (request: { text: string }) => {
        calls.push(request.text);
        return handler(request.text);
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

const KOREAN = '둘이 진정으로 화해했다는 의미로 서로 뽀뽀해.';

describe('免费通道原样回吐检测', () => {
  it('韩文原样回吐算没翻', () => {
    expect(looksUntranslated(KOREAN, KOREAN, 'zh-CHS')).toBe(true);
    expect(looksUntranslated('MANGA18FX.COM', 'MANGA18FX.COM', 'zh-CHS')).toBe(true);
  });

  it('真翻成中文就不算', () => {
    expect(looksUntranslated(KOREAN, '意思是两人真心和好了，互相亲亲吧。', 'zh-CHS')).toBe(false);
    expect(looksUntranslated('Hello there!', '你好！', 'zh-CHS')).toBe(false);
  });

  it('中文原文译成中文不算没翻（原文本来就没有外文）', () => {
    expect(looksUntranslated('在这里阅读最新更新', '在这里阅读最新更新', 'zh-CHS')).toBe(false);
  });

  it('空译文算没翻', () => {
    expect(looksUntranslated(KOREAN, '   ', 'zh-CHS')).toBe(true);
  });

  it('目标语言不是中文时不启这条规则', () => {
    expect(looksUntranslated('こんにちは', 'こんにちは', 'en')).toBe(false);
  });
});

describe('免费通道原样回吐后交给兜底', () => {
  it('原样回吐的区域标记为失败，保留原文而不是擦掉重排', async () => {
    const { transport, calls } = createTransport(async (text) => (
      text === KOREAN ? KOREAN : '第二句译文'
    ));
    const translator = createTextTranslator({ transport });

    const result = await translator.translateRegions({
      regions: regionsOf(KOREAN, '오늘 날씨 좋네.'),
      config: createConfig(),
    });

    expect(calls).toContain(KOREAN);
    const untranslated = result.regions.find((region) => region.sourceText === KOREAN);
    expect(untranslated?.translationFailed).toBe(true);
    expect(untranslated?.translatedText).toBe('');
    const translated = result.regions.find((region) => region.sourceText === '오늘 날씨 좋네.');
    expect(translated?.translatedText).toBe('第二句译文');
    expect(translated?.translationFailed).toBeUndefined();
  });
});

describe('免费通道回吐短拟声词的本地兜底', () => {
  it('谷歌原样回吐时用地道中文语气词，不占补翻名额', async () => {
    const { transport } = createTransport(async (text) => text);
    const translator = createTextTranslator({ transport });

    const result = await translator.translateRegions({
      regions: regionsOf('¿MMPH?', 'LEH?', 'G:JNDZHSZ'),
      config: createConfig({ sourceLang: 'es' }),
    });

    const mmph = result.regions.find((region) => region.sourceText === '¿MMPH?');
    const leh = result.regions.find((region) => region.sourceText === 'LEH?');
    const noise = result.regions.find((region) => region.sourceText === 'G:JNDZHSZ');
    expect(mmph?.translatedText).toBe('唔？');
    expect(mmph?.translationFailed).toBeUndefined();
    expect(leh?.translatedText).toBe('欸？');
    // OCR 噪声翻不了：保留原文、标记失败，不擦除不重排。
    expect(noise?.translationFailed).toBe(true);
  });
});
