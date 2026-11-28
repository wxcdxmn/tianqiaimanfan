import type { DiagnosticLogObserver } from '@shinobu/diagnostics';
import { toDiagnosticError } from '@shinobu/diagnostics';
import type {
  PlainTranslationProvider,
  TextTranslationConfig,
  TextTranslationRegion,
  TextTranslationResult,
  TextTranslationTransport,
  TextTranslator,
  TextTranslatorKind,
  TranslationDebugInfo,
} from './contracts';
import {
  LlmColumnsParseError,
  LlmThinkingConfigError,
  llmTranslate,
  llmTranslateRegions,
} from './translators/llm';
import { resolveSourceLanguage } from './detectLanguage';
import { matchLocalPhrase } from './translators/localPhrases';

/**
 * 用户选中的引擎 → 免费通道链：首选通道在首位，其余按固定顺序兜底。
 *
 * 选「谷歌翻译」表达的是「优先谷歌」；谷歌被限流（transport 内部降级）或对
 * 专名原样回吐（下面的通道轮换兜底）时，依次换用必应 / MyMemory / DeepLX，
 * 不再让整页失败或留下一堆原文，也不再牵扯 LLM。
 */
const PLAIN_PROVIDER_CHAIN_BY_TRANSLATOR: Record<Exclude<TextTranslatorKind, 'llm'>, readonly PlainTranslationProvider[]> = {
  google_web: ['google', 'bing', 'mymemory', 'deeplx'],
  bing_web: ['bing', 'google', 'mymemory', 'deeplx'],
  mymemory_web: ['mymemory', 'google', 'bing', 'deeplx'],
  deeplx_web: ['deeplx', 'google', 'bing', 'mymemory'],
};

const PLAIN_PROVIDER_LABEL: Record<PlainTranslationProvider, string> = {
  google: '谷歌翻译',
  bing: '必应翻译',
  mymemory: 'MyMemory',
  deeplx: 'DeepLX',
};

function plainProviderChainFor(translator: TextTranslatorKind | undefined): readonly PlainTranslationProvider[] {
  return translator && translator !== 'llm'
    ? PLAIN_PROVIDER_CHAIN_BY_TRANSLATOR[translator]
    : PLAIN_PROVIDER_CHAIN_BY_TRANSLATOR.google_web;
}

function plainEngineLabel(translator: TextTranslatorKind | undefined): string {
  return `免费通道（${PLAIN_PROVIDER_LABEL[plainProviderChainFor(translator)[0]]}）`;
}

type LlmRegionRequest = {
  id: string;
  text: string;
  direction: 'h' | 'v';
  targetColumns?: number;
  targetLines?: number;
};

type StructuredTranslationResult = {
  translatedText: string;
  translatedColumns?: string[];
};

/**
 * 免费通道「请求成功但根本没翻」的判定。
 *
 * Google 网页接口对一部分输入会原样回吐：整段韩文对白、纯大写站点名、
 * 带装饰符号的短句都见过。这些条目以前被算成翻译成功，于是气泡被擦掉、
 * 又把原文写回去——读者看到的就是「一大半台词没翻」。
 * 判成失败之后，可以走已有的补翻与 LLM 兜底链路。
 */
export function looksUntranslated(
  source: string,
  translated: string,
  targetLang: string,
): boolean {
  const target = targetLang.trim().toLowerCase();
  const isChineseTarget = target === 'zh-chs' || target === 'zh' || target === 'zh-cht' || target === 'zh-tw';
  if (!isChineseTarget) return false;
  const output = translated.replace(/\s+/gu, '');
  if (!output) return true;
  // 译文里有汉字就是翻了；没有汉字才需要怀疑。
  if (/[\u3400-\u9fff]/u.test(output)) return false;
  // 原文本身没有汉字（韩文/日文假名/拉丁文），译文却一个汉字也没有 → 原样返回。
  return /[\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Latin}]/u.test(source);
}

/**
 * 原样回吐时用本地固定映射兜底。
 * 只处理拟声词/语气词与 OCR 噪声，不碰正文台词；不命中就保持空串走补翻。
 */
function resolveLocalPhraseFallback(source: string): string {
  const match = matchLocalPhrase(source);
  return match?.kind === 'translate' ? match.text : '';
}

function assertTextTranslationProvider(config: TextTranslationConfig): void {
  if (config.llmProvider === 'gemini') {
    throw new Error('Nano Banana 使用端到端译图流程，不支持 OCR 文本翻译流程');
  }
}

function isTweetContextLengthError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /\bHTTP\s*413\b/iu.test(message)
    || /context[_\s-]*(?:length|window)/iu.test(message)
    || /(?:prompt|request|payload)(?:\s+entity)?\s+(?:is\s+)?too\s+large/iu.test(message)
    || /prompt\s+(?:is\s+)?too\s+long/iu.test(message)
    || /too\s+many\s+(?:input\s+)?tokens?/iu.test(message)
    || /(?:input|prompt).{0,40}tokens?.{0,40}(?:exceed|limit|maximum)/iu.test(message)
    || /上下文(?:长度|窗口).*(?:超|限制|过长|最大)/u.test(message)
    || /(?:输入|提示词|请求).*(?:token|令牌).*(?:超|过多|限制)/iu.test(message)
  );
}

function buildLlmRegionRequest(region: TextTranslationRegion): LlmRegionRequest {
  const direction = region.direction ?? 'h';
  return {
    id: region.id,
    text: region.sourceText,
    direction,
    targetColumns: direction === 'v' ? Math.max(1, region.originalLineCount ?? 1) : undefined,
    targetLines: direction === 'h' ? Math.max(1, region.originalLineCount ?? 1) : undefined,
  };
}

export type RunTranslateOptions = {
  signal?: AbortSignal;
  transport?: TextTranslationTransport;
  observer?: DiagnosticLogObserver;
};

function hasPipelineFailure(error: unknown): boolean {
  return error !== null
    && typeof error === 'object'
    && 'failure' in error
    && error.failure !== null
    && typeof error.failure === 'object'
    && 'code' in error.failure;
}

/** 免费网页接口的节流间隔；小于这个值会明显提高 429/5xx 概率。 */
export const GOOGLE_REQUEST_GAP_MS = 160;
export const GOOGLE_MAX_ATTEMPTS = 3;
/** 整页跑完后补翻失败条目前的等待，避开限流窗口。 */
export const GOOGLE_PAGE_RETRY_GAP_MS = 1200;

function abortError(): Error {
  return typeof DOMException === 'function'
    ? new DOMException('已取消', 'AbortError')
    : new Error('已取消');
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** 只有限流、5xx 与瞬时网络错误值得重试；4xx 参数错误重试也没用。 */
function isRetryableTranslationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const status = message.match(/(?:失败:|HTTP)\s*(\d{3})/i);
  if (status) {
    const code = Number(status[1]);
    return code === 429 || code >= 500;
  }
  return /failed to fetch|networkerror|network error|timeout|econnreset|eai_again|socket hang up/i.test(message);
}

/** 免费通道全部被限流：重试只会白等，整页直接走兜底逻辑。 */
function isThrottleExhausted(error: unknown): boolean {
  return error !== null
    && typeof error === 'object'
    && (error as { code?: unknown }).code === 'plain_throttled';
}

/** 合并翻译：一组最多 8 条 / 1200 字，避免单次请求过长被接口截断。 */
export const PLAIN_BATCH_MAX_ITEMS = 8;
export const PLAIN_BATCH_MAX_CHARS = 1200;
/** 合并请求之间的间隔：一次请求的文本量更大，间隔比逐条略宽。 */
export const PLAIN_BATCH_GAP_MS = 320;

/**
 * 合并通道把多条文本用换行拼成一个请求，再按换行切回。
 * 漫画的一个文字区域常带内部换行（多行对白），直接拼进去会让「行数」远多于「条数」，
 * 切回来时就按行错位——译文跑到隔壁气泡，或者整组退化成逐条。
 * 送进合并通道前先把内部换行压成空格，保证一「条」就是一「行」。
 */
function toBatchLine(text: string): string {
  return text.replace(/[ \t]*[\r\n]+[ \t]*/g, ' ').trim();
}

function emitTranslateDiagnostic(
  config: TextTranslationConfig,
  options: RunTranslateOptions,
  level: 'info' | 'warn' | 'error',
  message: string,
  data?: Record<string, unknown>,
  error?: unknown,
): void {
  if (!options.observer) return;
  try {
    options.observer.emit({
      runId: config.diagnosticRunId,
      level,
      category: 'pipeline.stage',
      source: { context: 'worker', module: 'text-translation/translator.ts' },
      message,
      data,
      ...(error === undefined ? {} : { error: toDiagnosticError(error) }),
    });
  } catch {
    // 诊断上报永远不影响翻译结果。
  }
}

/**
 * 免费通道兜底：对仍然失败的区域，按通道链逐个 provider 单独重试。
 *
 * translatePlainTexts 内部的降级只在「请求失败」时触发；谷歌对
 * 「¿R-RYU ZION...?」这类专名会「请求成功但原样回吐」，transport 感知不到。
 * 这里显式轮换首选通道（谷歌 → 必应 → MyMemory → DeepLX）再试，
 * 任何一个通道给出真译文就收下；全链都不行则保留原文。
 */
async function recoverFailedRegionsWithFreeChain<T extends TextTranslationRegion>(
  next: T[],
  config: TextTranslationConfig,
  options: RunTranslateOptions,
  chain: readonly PlainTranslationProvider[],
): Promise<number> {
  let failedCount = 0;
  let recoveredCount = 0;
  for (let index = 0; index < next.length; index += 1) {
    const region = next[index];
    if (!region.translationFailed || !region.sourceText.trim()) continue;
    // 只对气泡内对话做跨通道轮换。自由漂浮的文字(拟声词/旁白/水印残迹)
    // 原样回吐时保留原文,比接受其他通道对噪声的瞎猜更安全——瞎猜出来的
    // 音译会被擦掉原文嵌进气泡,比不翻更伤观感。
    // bubbleBox 由管线层富化(气泡归属),契约类型不声明,用结构探测。
    if (!(region as { bubbleBox?: unknown }).bubbleBox) continue;
    failedCount += 1;
    for (const provider of chain) {
      let translatedText = '';
      try {
        await delay(GOOGLE_REQUEST_GAP_MS, options.signal);
        translatedText = await translateOne(region.sourceText, config, options, provider);
      } catch (error) {
        if (options.signal?.aborted) throw error;
        continue;
      }
      if (!translatedText || looksUntranslated(region.sourceText, translatedText, config.targetLang)) {
        continue;
      }
      const { translationFailed: _failed, ...rest } = region;
      next[index] = { ...rest, translatedText } as T;
      recoveredCount += 1;
      break;
    }
  }
  if (recoveredCount > 0) {
    console.info(`[translate] 已用备用免费通道补翻成功 ${recoveredCount}/${failedCount} 条`);
    emitTranslateDiagnostic(config, options, 'info', '已用备用免费通道补翻失败条目', {
      recoveredCount,
      failedCount,
      targetLang: config.targetLang,
    });
  }
  return recoveredCount;
}

function planPlainBatchGroups<T extends TextTranslationRegion>(
  regions: readonly T[],
  indexes: readonly number[],
): number[][] {
  const groups: number[][] = [];
  let current: number[] = [];
  let chars = 0;
  for (const index of indexes) {
    const length = regions[index].sourceText.trim().length;
    const overflow = current.length >= PLAIN_BATCH_MAX_ITEMS
      || (current.length > 0 && chars + length > PLAIN_BATCH_MAX_CHARS);
    if (overflow) {
      groups.push(current);
      current = [];
      chars = 0;
    }
    current.push(index);
    chars += length;
  }
  if (current.length > 0) {
    groups.push(current);
  }
  // 单条分组没必要走合并接口，交给逐条通道处理。
  return groups.filter((group) => group.length > 1);
}

/**
 * 免费接口通道：先合并翻译（大幅降低请求数），再对漏网条目逐条补，
 * 整页失败喘息一轮，最后按通道链轮换兜底。单条失败不拖垮整页。
 * LLM 只在用户显式选择 LLM 引擎时才走（见 runTranslate），这里绝不触碰。
 */
async function translateRegionsWithPlainTransport<T extends TextTranslationRegion>(
  regions: readonly T[],
  config: TextTranslationConfig,
  options: RunTranslateOptions,
): Promise<TextTranslationResult<T>> {
  const chain = plainProviderChainFor(config.translator);
  const next: T[] = regions.map((region) => ({ ...region, translatedText: '' }) as T);
  const pending: number[] = [];
  next.forEach((region, index) => {
    if (region.sourceText.trim()) {
      pending.push(index);
    }
  });

  let lastRequestAt = 0;
  const throttle = async (gap: number): Promise<void> => {
    const wait = gap - (Date.now() - lastRequestAt);
    if (wait > 0) {
      await delay(wait, options.signal);
    }
    lastRequestAt = Date.now();
  };

  const batch = options.transport?.translatePlainBatch;
  if (batch && pending.length > 1) {
    for (const group of planPlainBatchGroups(regions, pending)) {
      await throttle(PLAIN_BATCH_GAP_MS);
      try {
        const output = await batch.call(options.transport, {
          texts: group.map((index) => toBatchLine(regions[index].sourceText)),
          from: config.sourceLang,
          to: config.targetLang,
          preferredProvider: chain[0],
          signal: options.signal,
        });
        if (output.length !== group.length) {
          throw new Error(`合并翻译返回 ${output.length} 条，期望 ${group.length} 条`);
        }
        group.forEach((index, position) => {
          const translated = output[position]?.trim();
          // 原样回吐的条目留空，交给下面的逐条通道再试一条：
          // 合并通道会把多行压成一行，逐条通道发原文，两者结果可能不同。
          if (translated) {
            if (!looksUntranslated(regions[index].sourceText, translated, config.targetLang)) {
              next[index].translatedText = translated;
            } else {
              // 短拟声词合并后必然回吐：直接落本地映射，省掉一次逐条往返。
              const local = resolveLocalPhraseFallback(regions[index].sourceText);
              if (local) next[index].translatedText = local;
            }
          }
        });
      } catch (error) {
        if (options.signal?.aborted) throw error;
        // 合并失败（多为换行对不齐）：该组退回逐条，不影响整页。
        console.debug(
          '[translate] 合并翻译失败，该组退回逐条:',
          error instanceof Error ? error.message : error,
        );
      }
    }
  }

  const attemptedCount = pending.length;
  let failedCount = 0;
  let untranslatedCount = 0;
  let throttleExhausted = false;

  for (const index of pending) {
    if (next[index].translatedText) {
      continue;
    }
    if (throttleExhausted) {
      failedCount += 1;
      next[index] = { ...next[index], translationFailed: true } as T;
      continue;
    }

    const source = next[index].sourceText;
    let translatedText = '';
    for (let attempt = 1; attempt <= GOOGLE_MAX_ATTEMPTS; attempt += 1) {
      await throttle(GOOGLE_REQUEST_GAP_MS);
      try {
        translatedText = await translateOne(source, config, options);
        if (translatedText && looksUntranslated(source, translatedText, config.targetLang)) {
          // 原样回吐：先试本地拟声词映射；不命中才进补翻 / LLM 兜底。
          const local = resolveLocalPhraseFallback(source);
          if (local) {
            translatedText = local;
          } else {
            untranslatedCount += 1;
            translatedText = '';
          }
        }
        break;
      } catch (error) {
        if (options.signal?.aborted) throw error;
        if (isThrottleExhausted(error)) {
          throttleExhausted = true;
          emitTranslateDiagnostic(config, options, 'warn', `${plainEngineLabel(config.translator)}全部限流，剩余对白不再逐条重试`, {
            attemptedCount,
            failedCount,
            reason: error instanceof Error ? error.message : String(error),
          }, error);
          break;
        }
        if (attempt >= GOOGLE_MAX_ATTEMPTS || !isRetryableTranslationError(error)) {
          console.warn(
            `[translate] 单条翻译失败（已重试 ${attempt} 次），保留原文: ${source.slice(0, 40)}`,
            error instanceof Error ? error.message : error,
          );
          break;
        }
        await delay(400 * 2 ** (attempt - 1), options.signal);
      }
    }

    if (!translatedText) {
      failedCount += 1;
      // 译文留空 + 标记失败：下游据此跳过擦除，气泡保留原文而不是变成空白。
      next[index] = { ...next[index], translationFailed: true } as T;
      continue;
    }
    next[index].translatedText = translatedText;
  }

  if (attemptedCount > 0 && failedCount === attemptedCount) {
    // 整页都失败。全通道限流时补翻只会再等冷却，直接报错让用户稍后重试。
    if (throttleExhausted) {
      throw new Error(
        `文本翻译全部失败（${failedCount} 条）：所有免费翻译通道被限流或不可达，稍后重试`,
      );
    }
    // 整页都失败通常是被限流或断网，先给一次整体喘息，再把整页重试一轮。
    await delay(GOOGLE_PAGE_RETRY_GAP_MS, options.signal);
    let recoveredCount = 0;
    for (let index = 0; index < next.length; index += 1) {
      const region = next[index];
      if (!region.translationFailed) {
        continue;
      }
      let translatedText = '';
      try {
        await delay(GOOGLE_REQUEST_GAP_MS, options.signal);
        translatedText = await translateOne(region.sourceText, config, options);
      } catch {
        translatedText = '';
      }
      if (!translatedText || looksUntranslated(region.sourceText, translatedText, config.targetLang)) {
        continue;
      }
      recoveredCount += 1;
      const { translationFailed: _failed, ...rest } = region;
      next[index] = { ...rest, translatedText } as T;
    }
    failedCount -= recoveredCount;
    if (failedCount > 0) {
      failedCount -= await recoverFailedRegionsWithFreeChain(next, config, options, chain);
    }
    // 整页失败要区分两种情况:全是「原样回吐」说明通道健康、只是这些内容
    // 翻不了(专名/拟声词)——保留原文正常渲染比报错好;混有真失败(限流/
    // 断网)才是「通道不可达」,值得报错。
    if (failedCount >= attemptedCount && untranslatedCount < attemptedCount) {
      throw new Error(
        `文本翻译全部失败（${failedCount} 条）：${plainEngineLabel(config.translator)}等免费通道被限流或不可达，稍后重试`,
      );
    }
    return { regions: next, translationDebug: null };
  }
  if (failedCount > 0) {
    if (throttleExhausted) {
      // 全部免费通道都被限流：不再空转，失败的气泡保留原文。
      console.warn(`[translate] ${failedCount}/${attemptedCount} 条翻译失败（通道限流），这些气泡保留原文`);
      return { regions: next, translationDebug: null };
    }
    // 部分失败：整页跑完再补一轮，缓解限流导致的零星漏翻。
    await delay(GOOGLE_PAGE_RETRY_GAP_MS, options.signal);
    let recoveredCount = 0;
    for (let index = 0; index < next.length; index += 1) {
      const region = next[index];
      if (!region.translationFailed) continue;
      try {
        await delay(GOOGLE_REQUEST_GAP_MS, options.signal);
        const translatedText = await translateOne(region.sourceText, config, options);
        if (!translatedText || looksUntranslated(region.sourceText, translatedText, config.targetLang)) continue;
        const { translationFailed: _failed, ...rest } = region;
        next[index] = { ...rest, translatedText } as T;
        recoveredCount += 1;
      } catch {
        // 补一轮仍失败：保持原文，不再抛错。
      }
    }
    if (recoveredCount > 0) {
      console.info(`[translate] 补翻成功 ${recoveredCount}/${failedCount} 条`);
      failedCount -= recoveredCount;
    }
    if (failedCount > 0) {
      // 补翻一轮后仍有失败：按通道链轮换（专名回吐大多在这里被必应/MyMemory 翻掉）。
      failedCount -= await recoverFailedRegionsWithFreeChain(next, config, options, chain);
    }
    if (failedCount > 0) {
      console.warn(`[translate] ${failedCount}/${attemptedCount} 条翻译失败，这些气泡保留原文`);
    }
  }

  if (untranslatedCount > 0) {
    emitTranslateDiagnostic(config, options, 'warn', '免费通道原样回吐未翻译的条目，已交给备用通道兜底', {
      untranslatedCount,
      attemptedCount,
      failedCount,
      targetLang: config.targetLang,
    });
  }

  return { regions: next, translationDebug: null };
}

async function translateOne(
  text: string,
  config: TextTranslationConfig,
  options: RunTranslateOptions,
  preferredProvider?: PlainTranslationProvider,
): Promise<string> {
  if (!text.trim()) {
    return '';
  }

  if (config.translator !== 'llm') {
    if (!options.transport) {
      throw new Error('未配置文本翻译 transport');
    }
    return options.transport.translatePlain({
      text,
      from: config.sourceLang,
      to: config.targetLang,
      preferredProvider: preferredProvider ?? plainProviderChainFor(config.translator)[0],
      signal: options.signal,
    });
  }

  assertTextTranslationProvider(config);

  return llmTranslate({
    provider: config.llmProvider,
    authMode: config.llmAuthMode,
    baseUrl: config.llmBaseUrl,
    model: config.llmModel,
    useCustomModel: config.llmUseCustomModel === true,
    thinkingLevel: config.llmUseCustomModel ? undefined : config.llmThinkingLevel,
    from: config.sourceLang,
    to: config.targetLang,
    text,
    translationContext: config.translationContext,
    diagnosticRunId: config.diagnosticRunId,
    observer: options.observer,
    signal: options.signal,
    transport: options.transport,
  });
}

async function translateOneStructured(
  region: TextTranslationRegion,
  config: TextTranslationConfig,
  options: RunTranslateOptions,
): Promise<StructuredTranslationResult> {
  const result = await llmTranslateRegions({
    provider: config.llmProvider,
    authMode: config.llmAuthMode,
    baseUrl: config.llmBaseUrl,
    model: config.llmModel,
    useCustomModel: config.llmUseCustomModel === true,
    thinkingLevel: config.llmUseCustomModel ? undefined : config.llmThinkingLevel,
    from: config.sourceLang,
    to: config.targetLang,
    regions: [buildLlmRegionRequest(region)],
    translationContext: config.translationContext,
    diagnosticRunId: config.diagnosticRunId,
    observer: options.observer,
    signal: options.signal,
    transport: options.transport,
  });
  const translated = result.byId.get(region.id);
  if (!translated?.translatedText) {
    throw new Error('LLM 单框结构化翻译未返回译文');
  }
  return translated;
}

export async function runTranslate<T extends TextTranslationRegion>(
  regions: readonly T[],
  config: TextTranslationConfig,
  options: RunTranslateOptions = {},
): Promise<TextTranslationResult<T>> {
  if (regions.length === 0) {
    return {
      regions: [],
      translationDebug: null,
    };
  }

  // 设置里的 sourceLang 默认是「日文」，但页面可能是英文条漫或韩文 webtoon。
  // 用整页 OCR 文本反推真实源语言，避免把错误的 sl / 提示词交给翻译层。
  const resolvedSource = resolveSourceLanguage(config.sourceLang, regions.map((region) => region.sourceText));
  if (resolvedSource.overridden) {
    console.info(
      `[translate] 源语言按页面实测校正: ${config.sourceLang || 'auto'} → ${resolvedSource.language}`,
      resolvedSource.detection.counts,
    );
    config = { ...config, sourceLang: resolvedSource.language };
  }

  if (config.translator === 'llm') {
    assertTextTranslationProvider(config);

    let activeConfig = config;
    let tweetContextLengthFallback = false;
    const runLlmRequest = async <T>(
      request: (requestConfig: TextTranslationConfig) => Promise<T>,
    ): Promise<T> => {
      try {
        return await request(activeConfig);
      } catch (error) {
        if (
          !tweetContextLengthFallback
          && activeConfig.translationContext
          && isTweetContextLengthError(error)
        ) {
          activeConfig = {
            ...activeConfig,
            translationContext: undefined,
          };
          tweetContextLengthFallback = true;
          return request(activeConfig);
        }
        throw error;
      }
    };

    let batched = new Map<string, { translatedText: string; translatedColumns?: string[] }>();
    const translationDebug: TranslationDebugInfo = {
      llmBatchRequestedRegionCount: regions.length,
      llmBatchFailed: false,
    };
    try {
      const batchedResult = await runLlmRequest((requestConfig) => llmTranslateRegions({
        provider: requestConfig.llmProvider,
        authMode: requestConfig.llmAuthMode,
        baseUrl: requestConfig.llmBaseUrl,
        model: requestConfig.llmModel,
        useCustomModel: requestConfig.llmUseCustomModel === true,
        thinkingLevel: requestConfig.llmUseCustomModel ? undefined : requestConfig.llmThinkingLevel,
        from: requestConfig.sourceLang,
        to: requestConfig.targetLang,
        regions: regions.map(buildLlmRegionRequest),
        translationContext: requestConfig.translationContext,
        diagnosticRunId: requestConfig.diagnosticRunId,
        observer: options.observer,
        signal: options.signal,
        transport: options.transport,
      }));
      batched = batchedResult.byId;
      translationDebug.llmBatchRawResponse = batchedResult.rawContent;
    } catch (error) {
      if (error instanceof LlmThinkingConfigError || hasPipelineFailure(error)) {
        throw error;
      }
      batched = new Map();
      translationDebug.llmBatchFailed = true;
      translationDebug.llmBatchError = error instanceof Error ? error.message : String(error);
      if (error instanceof LlmColumnsParseError) {
        translationDebug.llmBatchRawResponse = error.rawContent;
        translationDebug.llmBatchParseError = error.message;
      }
    }

    const next: T[] = [];
    let llmBatchHitRegionCount = 0;
    let llmFallbackRegionCount = 0;
    let llmFallbackRequestCount = 0;
    for (const region of regions) {
      const result = batched.get(region.id);
      if (result?.translatedText) {
        llmBatchHitRegionCount += 1;
        next.push({
          ...region,
          translatedText: result.translatedText,
          translatedColumns: result.translatedColumns,
        });
        continue;
      }

      llmFallbackRegionCount += 1;
      if (region.sourceText.trim()) {
        llmFallbackRequestCount += 1;
        try {
          const translated = await runLlmRequest(
            (requestConfig) => translateOneStructured(region, requestConfig, options),
          );
          next.push({
            ...region,
            translatedText: translated.translatedText,
            translatedColumns: translated.translatedColumns,
          });
          continue;
        } catch (error) {
          if (error instanceof LlmThinkingConfigError || hasPipelineFailure(error)) {
            throw error;
          }
          llmFallbackRequestCount += 1;
        }
      }
      const translatedText = await runLlmRequest(
        (requestConfig) => translateOne(region.sourceText, requestConfig, options),
      );
      next.push({ ...region, translatedText, translatedColumns: undefined });
    }
    translationDebug.llmBatchHitRegionCount = llmBatchHitRegionCount;
    translationDebug.llmFallbackRegionCount = llmFallbackRegionCount;
    translationDebug.llmFallbackRequestCount = llmFallbackRequestCount;
    translationDebug.llmFallbackUsed = llmFallbackRegionCount > 0;
    if (tweetContextLengthFallback) {
      translationDebug.tweetContextLengthFallback = true;
    }
    return {
      regions: next,
      translationDebug,
    };
  }

  return translateRegionsWithPlainTransport(regions, config, options);
}
export function createTextTranslator(dependencies: {
  transport: TextTranslationTransport;
  observer?: DiagnosticLogObserver;
}): TextTranslator {
  return Object.freeze({
    translateRegions<T extends TextTranslationRegion>(
      request: {
        regions: readonly T[];
        config: TextTranslationConfig;
        signal?: AbortSignal;
      },
    ): Promise<TextTranslationResult<T>> {
      return runTranslate(request.regions, request.config, {
        signal: request.signal,
        transport: dependencies.transport,
        observer: dependencies.observer,
      });
    },
  });
}
