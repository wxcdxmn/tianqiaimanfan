/** 翻译通道返回的条数与请求条数不一致时的专用错误：调用方据此退回逐条翻译。 */
export class TranslationBatchShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TranslationBatchShapeError';
  }
}

/** 从错误对象上读取 HTTP 状态码（兼容 message 里的 "失败: 429" 写法）。 */
export function readErrorStatus(error: unknown): number | undefined {
  if (error !== null && typeof error === 'object' && 'status' in error) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === 'number' && Number.isFinite(status)) {
      return status;
    }
  }
  const message = error instanceof Error ? error.message : String(error ?? '');
  const matched = message.match(/(?:失败:|HTTP)\s*(\d{3})/iu);
  return matched ? Number(matched[1]) : undefined;
}

/** 429/5xx 与瞬时网络错误：值得冷却后重试；其余 4xx 属于参数问题，重试无意义。 */
export function isRetryableProviderError(error: unknown): boolean {
  const status = readErrorStatus(error);
  if (status !== undefined) {
    return status === 429 || status >= 500 || status === 408;
  }
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /failed to fetch|networkerror|network error|timeout|econnreset|eai_again|socket hang up|aborted/iu
    .test(message);
}

export function isAbortError(error: unknown): boolean {
  if (error instanceof Error && error.name === 'AbortError') {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /aborted|已取消/iu.test(message) && /abort|取消/u.test(message);
}

export function readRetryAfterMs(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.min(120_000, seconds * 1000);
  }
  const date = Date.parse(value);
  if (Number.isFinite(date)) {
    const delta = date - Date.now();
    return delta > 0 ? Math.min(120_000, delta) : 0;
  }
  return undefined;
}
