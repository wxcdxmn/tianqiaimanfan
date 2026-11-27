import { bingWebTranslateMany } from './bingWeb';
import { deepLxTranslateMany } from './deepLx';
import { googleWebTranslateMany } from './googleWeb';
import { myMemoryTranslateMany } from './myMemory';
import { isAbortError, isRetryableProviderError, readErrorStatus } from './errors';

export type PlainTranslateProviderId = 'google' | 'bing' | 'mymemory' | 'deeplx';

export type PlainTranslateOptions = {
  from: string;
  to: string;
  /** 合并翻译的正文上限，超过则由调用方自行分组。 */
  maxChars?: number;
  signal?: AbortSignal;
  /**
   * 首选通道：本次请求先试它，被限流/失败时按健康度自动降级到其余免费通道。
   *
   * 用户在设置里选「谷歌翻译」表达的是「优先谷歌」；谷歌限流时静默降级到
   * Bing/MyMemory/DeepLX，比整页失败或留下一堆原文更符合预期。不同通道的
   * 语气差异由「首选通道承载绝大多数请求」来控制——降级只发生在少数请求上。
   */
  preferredProvider?: PlainTranslateProviderId;
};

type Provider = {
  id: PlainTranslateProviderId;
  label: string;
  translate(texts: readonly string[], options: PlainTranslateOptions): Promise<string[]>;
};

type ProviderState = {
  strikes: number;
  cooldownUntil: number;
  lastError?: string;
};

/** 429 后第一次冷却时长；连续踩限流按 2 倍递增。 */
export const PROVIDER_COOLDOWN_BASE_MS = 6_000;
export const PROVIDER_COOLDOWN_MAX_MS = 3 * 60_000;
/** 冷却超过这个时长就当作「不可用」，本轮直接换下一个通道。 */
export const PROVIDER_COOLDOWN_SKIP_MS = 30_000;
/** 全通道冷却时，最多等这么久再试一次。 */
export const PROVIDER_COOLDOWN_HARD_WAIT_MS = 20_000;

const state = new Map<PlainTranslateProviderId, ProviderState>();

function stateOf(id: PlainTranslateProviderId): ProviderState {
  let entry = state.get(id);
  if (!entry) {
    entry = { strikes: 0, cooldownUntil: 0 };
    state.set(id, entry);
  }
  return entry;
}

function cooldownRemaining(id: PlainTranslateProviderId): number {
  return Math.max(0, stateOf(id).cooldownUntil - Date.now());
}

function markSuccess(id: PlainTranslateProviderId): void {
  const entry = stateOf(id);
  entry.strikes = 0;
  entry.cooldownUntil = 0;
  entry.lastError = undefined;
}

function markFailure(id: PlainTranslateProviderId, error: unknown): void {
  const entry = stateOf(id);
  entry.strikes += 1;
  entry.lastError = error instanceof Error ? error.message : String(error);
  const retryAfter = (error as { retryAfterMs?: number } | null)?.retryAfterMs;
  const status = readErrorStatus(error);
  const isThrottle = status === 429 || status === 503;
  if (!isRetryableProviderError(error) && !isThrottle) {
    // 参数类错误不该长时间封禁通道，但也别立刻再用。
    entry.cooldownUntil = Date.now() + 1_500;
    return;
  }
  const backoff = PROVIDER_COOLDOWN_BASE_MS * 2 ** Math.min(entry.strikes - 1, 5);
  const cooldown = Math.min(
    PROVIDER_COOLDOWN_MAX_MS,
    Math.max(backoff, retryAfter ?? 0),
  );
  entry.cooldownUntil = Date.now() + cooldown;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('已取消', 'AbortError'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('已取消', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

const PROVIDERS: readonly Provider[] = [
  {
    id: 'google',
    label: 'Google',
    async translate(texts, options) {
      const output = await googleWebTranslateMany({
        texts,
        from: options.from,
        to: options.to,
        signal: options.signal,
      });
      if (output.length !== texts.length) {
        throw new Error(`Google 返回 ${output.length} 条，期望 ${texts.length} 条`);
      }
      return output;
    },
  },
  {
    id: 'bing',
    label: 'Bing',
    async translate(texts, options) {
      const output = await bingWebTranslateMany({
        texts,
        from: options.from,
        to: options.to,
        signal: options.signal,
      });
      if (output.length !== texts.length) {
        throw new Error(`Bing 返回 ${output.length} 条，期望 ${texts.length} 条`);
      }
      return output;
    },
  },
  {
    id: 'mymemory',
    label: 'MyMemory',
    async translate(texts, options) {
      const output = await myMemoryTranslateMany({
        texts,
        from: options.from,
        to: options.to,
        signal: options.signal,
      });
      if (output.length !== texts.length) {
        throw new Error(`MyMemory 返回 ${output.length} 条，期望 ${texts.length} 条`);
      }
      return output;
    },
  },
  {
    id: 'deeplx',
    label: 'DeepLX',
    async translate(texts, options) {
      const output = await deepLxTranslateMany({
        texts,
        from: options.from,
        to: options.to,
        signal: options.signal,
      });
      if (output.length !== texts.length) {
        throw new Error(`DeepLX 返回 ${output.length} 条，期望 ${texts.length} 条`);
      }
      return output;
    },
  },
];

/** 健康的通道排前面：踩过限流的通道自动后移，避免每次请求都先撞一次 429。 */
function rankProviders(): Provider[] {
  return PROVIDERS.map((provider, index) => ({ provider, index }))
    .sort((left, right) => {
      const leftState = stateOf(left.provider.id);
      const rightState = stateOf(right.provider.id);
      const leftCooling = leftState.cooldownUntil > Date.now() ? 1 : 0;
      const rightCooling = rightState.cooldownUntil > Date.now() ? 1 : 0;
      if (leftCooling !== rightCooling) return leftCooling - rightCooling;
      if (leftState.strikes !== rightState.strikes) return leftState.strikes - rightState.strikes;
      return left.index - right.index;
    })
    .map((entry) => entry.provider);
}

/**
 * 逐条/合并翻译的统一入口。
 *
 * 按「首选通道优先、其余按健康度」排序尝试：首选被限流/失败时自动降级到
 * 其余免费通道（冷却中的通道排后面，避免每次请求都先撞一次 429）；全部
 * 通道都不可用时抛错，由上层决定整页失败还是保留原文。
 */
export async function translatePlainTexts(
  texts: readonly string[],
  options: PlainTranslateOptions,
): Promise<string[]> {
  if (texts.length === 0) {
    return [];
  }
  const cleaned = texts.map((text) => text.trim());
  if (cleaned.every((text) => !text)) {
    return texts.map(() => '');
  }

  const preferred = options.preferredProvider
    ? PROVIDERS.find((provider) => provider.id === options.preferredProvider)
    : undefined;
  if (options.preferredProvider && !preferred) {
    throw new Error(`未知的翻译通道: ${String(options.preferredProvider)}`);
  }
  const rest = rankProviders().filter((provider) => provider.id !== preferred?.id);
  const order = preferred ? [preferred, ...rest] : rankProviders();

  const errors: string[] = [];
  let hardWaited = false;
  let sawThrottle = false;

  for (;;) {
    for (const provider of order) {
      if (options.signal?.aborted) {
        throw new DOMException('已取消', 'AbortError');
      }
      const remaining = cooldownRemaining(provider.id);
      if (remaining > PROVIDER_COOLDOWN_SKIP_MS) {
        sawThrottle = true;
        errors.push(`${provider.label} 限流冷却中`);
        continue;
      }
      if (remaining > 0) {
        const hasHealthy = order.some(
          (other) => other.id !== provider.id && cooldownRemaining(other.id) === 0,
        );
        if (hasHealthy) {
          sawThrottle = true;
          errors.push(`${provider.label} 限流冷却中`);
          continue;
        }
        await delay(remaining, options.signal);
      }
      try {
        const output = await provider.translate(texts, options);
        markSuccess(provider.id);
        return output;
      } catch (error) {
        if (isAbortError(error)) {
          throw error;
        }
        markFailure(provider.id, error);
        const status = readErrorStatus(error);
        if (status === 429 || status === 503) {
          sawThrottle = true;
        }
        errors.push(`${provider.label}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // 所有通道都在限流：等最短的那个冷却结束再来一轮（只等一次，避免拖死整页）。
    const waits = order
      .map((provider) => cooldownRemaining(provider.id))
      .filter((ms) => ms > 0);
    const shortest = waits.length > 0 ? Math.min(...waits) : 0;
    if (!hardWaited && shortest > 0 && shortest <= PROVIDER_COOLDOWN_HARD_WAIT_MS) {
      hardWaited = true;
      await delay(shortest, options.signal);
      continue;
    }
    const detail = errors.slice(-4).join('；') || '未知错误';
    const error = new Error(`免费翻译通道全部失败: ${detail}`) as Error & { code?: string };
    if (sawThrottle) {
      // 告诉上层「这是限流，不是内容问题」，别再逐条空转重试。
      error.code = 'plain_throttled';
    }
    throw error;
  }
}

export function translatePlainText(
  text: string,
  from: string,
  to: string,
  signal?: AbortSignal,
  preferredProvider?: PlainTranslateProviderId,
): Promise<string> {
  return translatePlainTexts([text], { from, to, signal, preferredProvider }).then((output) => output[0] ?? '');
}

export function translatePlainBatch(
  texts: readonly string[],
  from: string,
  to: string,
  signal?: AbortSignal,
  preferredProvider?: PlainTranslateProviderId,
): Promise<string[]> {
  return translatePlainTexts(texts, { from, to, signal, preferredProvider });
}

export type PlainTranslateDiagnostics = {
  provider: PlainTranslateProviderId;
  strikes: number;
  cooldownMs: number;
  lastError?: string;
};

export function getPlainTranslateDiagnostics(): PlainTranslateDiagnostics[] {
  return PROVIDERS.map((provider) => ({
    provider: provider.id,
    strikes: stateOf(provider.id).strikes,
    cooldownMs: cooldownRemaining(provider.id),
    lastError: stateOf(provider.id).lastError,
  }));
}

/** 仅用于测试：清空限流冷却状态。 */
export function resetPlainTranslateState(): void {
  state.clear();
}
