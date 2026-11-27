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
   * 指定通道时只走这一条通道，失败就直接报错，不跨通道降级。
   *
   * 用户在设置里选了「谷歌翻译」就是要谷歌：谷歌挂了应该让他看到失败，
   * 而不是悄悄换成 Bing 的译文（语气和断句都不一样，整章风格会跳）。
   */
  provider?: PlainTranslateProviderId;
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
 * 默认按健康度轮换 Google → Bing → MyMemory（限流时自动降级）；一旦
 * options.provider 指定了通道，就只走那一条，绝不换用别的引擎。
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

  const pinned = options.provider
    ? PROVIDERS.filter((provider) => provider.id === options.provider)
    : null;
  if (pinned && pinned.length === 0) {
    throw new Error(`未知的翻译通道: ${String(options.provider)}`);
  }

  const errors: string[] = [];
  let hardWaited = false;
  let sawThrottle = false;

  for (;;) {
    const order = pinned ?? rankProviders();
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
        if (pinned) {
          // 指定引擎时最多等一次冷却：等完还失败就交给上层（限流标记 / LLM 兜底 ），
          // 不能像多通道那样一轮轮等下去，否则整页会卡在指数退避里。
          if (hardWaited) {
            sawThrottle = true;
            errors.push(`${provider.label} 限流冷却中（约 ${Math.ceil(remaining / 1000)}s）`);
            continue;
          }
          hardWaited = true;
          await delay(remaining, options.signal);
        } else {
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
    const error = new Error(
      pinned
        ? `${pinned[0]?.label ?? '所选引擎'} 翻译失败: ${detail}`
        : `免费翻译通道全部失败: ${detail}`,
    ) as Error & { code?: string };
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
  provider?: PlainTranslateProviderId,
): Promise<string> {
  return translatePlainTexts([text], { from, to, signal, provider }).then((output) => output[0] ?? '');
}

export function translatePlainBatch(
  texts: readonly string[],
  from: string,
  to: string,
  signal?: AbortSignal,
  provider?: PlainTranslateProviderId,
): Promise<string[]> {
  return translatePlainTexts(texts, { from, to, signal, provider });
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
