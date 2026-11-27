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

/** 用户选中的引擎 → transport 的通道 id；选一次就只用这一个，不跨引擎降级。 */
const PLAIN_PROVIDER_BY_TRANSLATOR: Record<Exclude<TextTranslatorKind, 'llm'>, PlainTranslationProvider> = {
  google_web: 'google',
  bing_web: 'bing',
  mymemory_web: 'mymemory',
  deeplx_web: 'deeplx',
};

const PLAIN_ENGINE_LABEL: Record<Exclude<TextTranslatorKind, 'llm'>, string> = {
  google_web: '谷歌翻译',
  bing_web: '必应翻译',
  mymemory_web: 'MyMemory',
  deeplx_web: 'DeepLX',
};

function plainProviderFor(translator: TextTranslatorKind | undefined): PlainTranslationProvider | undefined {
  return translator && translator !== 'llm' ? PLAIN_PROVIDER_BY_TRANSLATOR[translator] : undefined;
}

function plainEngineLabel(translator: TextTranslatorKind | undefined): string {
  return translator && translator !== 'llm'
    ? `免费通道（${PLAIN_ENGINE_LABEL[translator]}）`
    : '免费通道';
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

/**
 * 免费通道失败后的 LLM 自动补救：整页失败区域一次合并请求带上下文补翻。
 * 用户在设置里配置过 LLM API Key 时生效；未配置（请求被 transport 拒绝）
 * 则安静放弃，保持原有免费通道行为。
 */
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

async function llmRecoverFailedRegions<T extends TextTranslationRegion>(
  next: T[],
  config: TextTranslationConfig,
  options: RunTranslateOptions,
): Promise<number> {
  let failed = next.filter((region) => region.translationFailed && region.sourceText.trim());
  if (failed.length === 0) {
    return 0;
  }
  // 拟声词/OCR 噪声不必发 LLM：本地映射直接落地，剩下才需要真正的翻译。
  let localRecovered = 0;
  for (const region of failed) {
    const local = resolveLocalPhraseFallback(region.sourceText);
    if (!local) continue;
    const { translationFailed: _failed, ...rest } = region;
    delete (region as { translationFailed?: boolean }).translationFailed;
    Object.assign(region, rest, { translatedText: local });
    localRecovered += 1;
  }
  failed = failed.filter((region) => region.translationFailed);
  if (failed.length === 0) {
    return localRecovered;
  }
  if (config.llmProvider === 'gemini') {
    return localRecovered;
  }
  try {
    const result = await llmTranslateRegions({
      provider: config.llmProvider,
      authMode: config.llmAuthMode,
      baseUrl: config.llmBaseUrl,
      model: config.llmModel,
      useCustomModel: config.llmUseCustomModel === true,
      from: config.sourceLang,
      to: config.targetLang,
      regions: failed.map(buildLlmRegionRequest),
      translationContext: config.translationContext,
      diagnosticRunId: config.diagnosticRunId,
      observer: options.observer,
      signal: options.signal,
      transport: options.transport,
    });
    let recoveredCount = 0;
    for (const region of failed) {
      const translated = result.byId.get(region.id);
      if (!translated?.translatedText) {
        continue;
      }
      const { translationFailed: _failed, ...rest } = region;
      delete (region as { translationFailed?: boolean }).translationFailed;
      Object.assign(region, rest, { translatedText: translated.translatedText });
      recoveredCount += 1;
    }
    if (recoveredCount > 0) {
      console.info(
        `[translate] 免费通道失败 ${failed.length} 条，已用 LLM 通道补翻成功 ${recoveredCount} 条`,
      );
      emitTranslateDiagnostic(config, options, 'info', '免费通道失败，已用 LLM 补翻', {
        failedCount: failed.length,
        recoveredCount,
        provider: config.llmProvider,
        model: config.llmModel,
      });
    }
    return recoveredCount + localRecovered;
  } catch (error) {
    if (options.signal?.aborted) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    console.debug(
      '[translate] LLM 补翻不可用（未配置 API Key 或请求失败），保留免费通道结果:',
      message,
    );
    // 这条以前只打到 console，导出日志里看不到：只要 LLM 这条兜底路径坏了，
    // 用户看到的就是「一大半对白没翻译」，而日志里一片安静。
    emitTranslateDiagnostic(config, options, 'warn', 'LLM 补翻不可用，这些对白会保留原文', {
      failedCount: failed.length,
      provider: config.llmProvider,
      authMode: config.llmAuthMode,
      baseUrl: config.llmBaseUrl,
      model: config.llmModel,
      reason: message,
    }, error);
    return localRecovered;
  }
}

/**
 * 本章免费通道已确定耗尽：后续图片直接整页走 LLM，不再逐条撞 429。
 * 进程内状态，10 分钟后自动失效，避免长期绕过免费通道。
 */
let preferLlmAfterThrottle = false;
let preferLlmUntil = 0;
const PREFER_LLM_TTL_MS = 10 * 60_000;

function switchToLlmChannel(): void {
  preferLlmAfterThrottle = true;
  preferLlmUntil = Date.now() + PREFER_LLM_TTL_MS;
}

function shouldPreferLlmChannel(): boolean {
  return preferLlmAfterThrottle && Date.now() < preferLlmUntil;
}

/** 仅用于测试：清空「本章改走 LLM」的记忆。 */
export function resetTranslateChannelMemory(): void {
  preferLlmAfterThrottle = false;
  preferLlmUntil = 0;
}

/** 整页（所有还没有译文的条目）交给 LLM 一次带上下文翻译。 */
async function recoverWholePageWithLlm<T extends TextTranslationRegion>(
  next: T[],
  config: TextTranslationConfig,
  options: RunTranslateOptions,
): Promise<number> {
  // 在副本上操作：LLM 补翻失败时不能把 translationFailed 留在真实区域上，
  // 否则退回免费通道翻译成功的框也会因为标记残留而被排版阶段跳过。
  const snapshot = next.map((region) => ({ ...region }) as T);
  let targets = 0;
  for (const region of snapshot) {
    if (!region.sourceText.trim() || region.translatedText) continue;
    region.translationFailed = true;
    targets += 1;
  }
  if (targets === 0) return 0;
  const recovered = await llmRecoverFailedRegions(snapshot, config, options);
  if (recovered === 0) return 0;
  for (let index = 0; index < next.length; index += 1) {
    const translated = snapshot[index].translatedText;
    if (!translated) continue;
    const { translationFailed: _failed, ...rest } = next[index] as T & { translationFailed?: boolean };
    next[index] = { ...rest, translatedText: translated } as T;
  }
  return recovered;
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
 * 最后整页补一轮。单条失败不拖垮整页。
 */
async function translateRegionsWithPlainTransport<T extends TextTranslationRegion>(
  regions: readonly T[],
  config: TextTranslationConfig,
  options: RunTranslateOptions,
): Promise<TextTranslationResult<T>> {
  const next: T[] = regions.map((region) => ({ ...region, translatedText: '' }) as T);
  const pending: number[] = [];
  next.forEach((region, index) => {
    if (region.sourceText.trim()) {
      pending.push(index);
    }
  });

  // 一整章漫画会连续送来十几张图，每张都要发十几条请求；免费通道按出口 IP 共享额度，
  // 一旦这一章踩到限流，后面的图会继续按「先逐条撞 429、再补翻」的流程走一遍，
  // 结果是整章一大半对白拿不到译文。这里记住「本章免费通道已耗尽」，
  // 后续图片直接走 LLM，不再让每张图重新撞一轮。
  if (shouldPreferLlmChannel() && await recoverWholePageWithLlm(next, config, options) > 0) {
    return { regions: next, translationDebug: null };
  }

  let lastRequestAt = 0;
  const throttle = async (gap: number): Promise<void> => {
    const wait = gap - (Date.now() - lastRequestAt);
    if (wait > 0) {
      await delay(wait, options.signal);
    }
    lastRequestAt = Date.now();
  };

  const batch = options.transport?.translatePlainBatch;
  const provider = plainProviderFor(config.translator);
  if (batch && pending.length > 1) {
    for (const group of planPlainBatchGroups(regions, pending)) {
      await throttle(PLAIN_BATCH_GAP_MS);
      try {
        const output = await batch.call(options.transport, {
          texts: group.map((index) => toBatchLine(regions[index].sourceText)),
          from: config.sourceLang,
          to: config.targetLang,
          provider,
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
    // 通道全被限流时，补翻只会再等一轮冷却，直接报错让用户稍后重试/换通道。
    if (throttleExhausted) {
      // 已配置 LLM 通道时，用 LLM 整页补翻失败区域，不再直接报错。
      if (await llmRecoverFailedRegions(next, config, options) > 0) {
        switchToLlmChannel();
        return { regions: next, translationDebug: null };
      }
      throw new Error(
        `文本翻译全部失败（${failedCount} 条）：${plainEngineLabel(config.translator)}被限流或不可达，`
        + '稍后重试，或在设置里改用 LLM 通道',
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
    if (recoveredCount > 0) {
      return { regions: next, translationDebug: null };
    }
    if (await llmRecoverFailedRegions(next, config, options) > 0) {
      return { regions: next, translationDebug: null };
    }
    throw new Error(
      `文本翻译全部失败（${failedCount} 条）：${plainEngineLabel(config.translator)}被限流或不可达，`
      + '稍后重试，或在设置里改用 LLM 通道',
    );
  }
  if (failedCount > 0) {
    if (throttleExhausted) {
      // 已配置 LLM 通道时，用 LLM 整页补翻失败区域。
      if (await llmRecoverFailedRegions(next, config, options) > 0) {
        switchToLlmChannel();
        return { regions: next, translationDebug: null };
      }
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
      // 补翻一轮后仍有失败：已配置 LLM 通道时用 LLM 整页补翻。
      if (await llmRecoverFailedRegions(next, config, options) > 0) {
        return { regions: next, translationDebug: null };
      }
      console.warn(`[translate] ${failedCount}/${attemptedCount} 条翻译失败，这些气泡保留原文`);
    }
  }

  if (untranslatedCount > 0) {
    emitTranslateDiagnostic(config, options, 'warn', '免费通道原样回吐未翻译的条目，已交给补翻兜底', {
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
      provider: plainProviderFor(config.translator),
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
