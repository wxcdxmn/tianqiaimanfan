import type { ExtensionSettings } from "../../shared/config";
import { getExtensionApi } from '../../shared/extensionRuntime';
import {
  createDiagnosticEvent,
  createDiagnosticId,
  formatDiagnosticTextLog,
  normalizeDiagnosticTimestamp,
} from '@shinobu/diagnostics';
import { sanitizeExtensionSettings } from '../../shared/diagnosticSettings';
import type {
  DiagnosticLogEvent,
  DiagnosticLogEventInput,
  DiagnosticLogRun,
  DiagnosticLogTextExport,
} from '@shinobu/diagnostics';
import { getSettings } from "../settings/settingsStore";
import {
  storageGet,
  storageRemove,
  storageSet,
} from "../storage/chromeStorage";
import { isRecord } from "../utils";

const diagnosticLogStorageKey = "mangaTranslate.diagnosticLog";
const backgroundDiagnosticSessionId = createDiagnosticId("background-session");

type DiagnosticLogStore = {
  events: DiagnosticLogEvent[];
  truncated?: boolean;
  truncationReason?: string;
};

const diagnosticLogMaxEvents = 2000;

/**
 * 导出诊断时剥除的内容载体字段。
 *
 * 隐私政策 §5 承诺「导出的脱敏诊断只应包含版本、阶段、耗时、设备能力、错误码
 * 和提供商主机」。写入侧的 `enableDebugLog`（默认关）只决定"存不存"，导出侧
 * 必须独立兜底：调试日志一旦开启，`requestBody`（OCR 原文 + 提示词）、
 * `responseData`/`responseText`（译文与接口原始响应）、`rawResponse`（Gemini
 * 原始返回）都会进入事件 data，导出前在这里剥掉，保留计时/状态/错误码。
 */
const exportRedactedDataKeys = new Set(['requestBody', 'responseData', 'rawResponse', 'responseText']);

function redactDiagnosticEventDataForExport(data: unknown): unknown {
  if (!isRecord(data)) return data;
  let touched = false;
  const next: Record<string, unknown> = { ...data };
  for (const key of Object.keys(next)) {
    if (exportRedactedDataKeys.has(key) && next[key] !== undefined) {
      next[key] = `[REDACTED_CONTENT:${key}]`;
      touched = true;
    }
  }
  return touched ? next : data;
}

function redactDiagnosticEventForExport(event: DiagnosticLogEvent): DiagnosticLogEvent {
  if (!isRecord(event.data)) return event;
  const data = redactDiagnosticEventDataForExport(event.data);
  return data === event.data ? event : { ...event, data } as DiagnosticLogEvent;
}

function normalizeStoredDiagnosticLogEvent(value: unknown): DiagnosticLogEvent | null {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.sessionId !== 'string' ||
    typeof value.level !== 'string' ||
    typeof value.category !== 'string' ||
    !isRecord(value.source) ||
    typeof value.source.context !== 'string' ||
    typeof value.message !== 'string'
  ) {
    return null;
  }

  const timestamp = normalizeDiagnosticTimestamp(value.timestamp, '');
  const normalized = createDiagnosticEvent({
    id: value.id,
    sessionId: value.sessionId,
    runId: typeof value.runId === 'string' ? value.runId : undefined,
    timestamp,
    level: value.level as DiagnosticLogEvent['level'],
    category: value.category as DiagnosticLogEvent['category'],
    source: {
      context: value.source.context as DiagnosticLogEvent['source']['context'],
      module: typeof value.source.module === 'string' ? value.source.module : undefined,
    },
    message: value.message,
    data: isRecord(value.data) ? value.data : undefined,
    error: isRecord(value.error) && typeof value.error.message === 'string'
      ? value.error as DiagnosticLogEvent['error']
      : undefined,
  }, value.sessionId);

  // Persisted legacy events may not have a timestamp. Keep the empty value so
  // the readable formatter can show "unknown-time" instead of inventing a new
  // timestamp that would move the event to the latest run.
  normalized.timestamp = timestamp;
  return normalized;
}

function appendTruncationReason(current: unknown, reason: string): string {
  return typeof current === 'string' && current.length > 0
    ? `${current}；${reason}`
    : reason;
}

function normalizeDiagnosticLogStore(value: unknown): DiagnosticLogStore {
  if (!isRecord(value) || !Array.isArray(value.events)) {
    return { events: [] };
  }

  const events: DiagnosticLogEvent[] = [];
  let invalidEventCount = 0;
  for (const candidate of value.events) {
    const event = normalizeStoredDiagnosticLogEvent(candidate);
    if (event) {
      events.push(event);
    } else {
      invalidEventCount += 1;
    }
  }

  const invalidEventReason = invalidEventCount > 0
    ? `持久化日志中有 ${invalidEventCount} 条事件格式无效，已忽略`
    : undefined;
  const truncationReason = invalidEventReason
    ? appendTruncationReason(value.truncationReason, invalidEventReason)
    : typeof value.truncationReason === 'string'
      ? value.truncationReason
      : undefined;

  return {
    events,
    truncated: value.truncated === true || invalidEventCount > 0,
    truncationReason,
  };
}

async function readDiagnosticLogStore(): Promise<DiagnosticLogStore> {
  const saved = await storageGet(diagnosticLogStorageKey);
  return normalizeDiagnosticLogStore(saved);
}

async function writeDiagnosticLogStore(store: DiagnosticLogStore): Promise<void> {
  await storageSet(diagnosticLogStorageKey, store);
}

/**
 * 内存追加 + 合并落盘。
 *
 * 旧实现每来一条事件就把整份日志（一章下来两三千条、好几 MB）读出来、push 一条、
 * 再整份写回去，并且所有调用方都在写队列上排队等待。日志越长越慢：章节末尾一张
 * 图光「写完日志」就要几十秒，体感就是“越翻越卡、越翻越慢”。
 *
 * 现在的写入路径只在内存里追加（微秒级），由 400ms 的合并窗口统一落盘一次；
 * 导出与清空会先把未落盘的增量刷下去，保证导出的就是刚跑完的内容。
 */
let cachedStore: DiagnosticLogStore | null = null;
let cacheLoading: Promise<DiagnosticLogStore> | null = null;
let logDirty = false;
let flushHandle: ReturnType<typeof setTimeout> | null = null;
let flushChain: Promise<void> = Promise.resolve();

function loadDiagnosticLogStore(): Promise<DiagnosticLogStore> {
  if (cachedStore) return Promise.resolve(cachedStore);
  if (!cacheLoading) {
    cacheLoading = readDiagnosticLogStore()
      .then((store) => {
        cachedStore = store;
        return store;
      })
      .finally(() => {
        cacheLoading = null;
      });
  }
  return cacheLoading;
}

async function flushDiagnosticLog(): Promise<void> {
  if (!logDirty || !cachedStore) return;
  logDirty = false;
  const store = cachedStore;
  try {
    await writeDiagnosticLogStore({ ...store, events: store.events.slice() });
  } catch (error) {
    logDirty = true;
    throw error;
  }
}

function requestDiagnosticLogFlush(): Promise<void> {
  flushChain = flushChain.then(flushDiagnosticLog, flushDiagnosticLog);
  return flushChain;
}

function scheduleDiagnosticLogFlush(): void {
  if (flushHandle !== null) return;
  flushHandle = setTimeout(() => {
    flushHandle = null;
    void requestDiagnosticLogFlush().catch(() => undefined);
  }, 400);
}

/** 立刻把内存里未落盘的增量写下去（导出、清空、测试都走这里）。 */
export function flushDiagnosticLogNow(): Promise<void> {
  if (flushHandle !== null) {
    clearTimeout(flushHandle);
    flushHandle = null;
  }
  return requestDiagnosticLogFlush();
}

/** 仅用于测试：丢弃内存缓存与待落盘状态，下一次读取回到存储。 */
export function resetDiagnosticLogStoreCache(): void {
  if (flushHandle !== null) {
    clearTimeout(flushHandle);
    flushHandle = null;
  }
  cachedStore = null;
  cacheLoading = null;
  logDirty = false;
  flushChain = Promise.resolve();
}

function appendDiagnosticLogEvent(event: DiagnosticLogEvent): Promise<void> {
  const normalized = createDiagnosticEvent(event, event.sessionId);
  return loadDiagnosticLogStore()
    .then((store) => {
      store.events.push(normalized);
      const overflow = store.events.length - diagnosticLogMaxEvents;
      if (overflow > 0) {
        store.events.splice(0, overflow);
        store.truncated = true;
        store.truncationReason = `事件数量超过 ${diagnosticLogMaxEvents}，已丢弃最早的 ${overflow} 条`;
      }
      logDirty = true;
      scheduleDiagnosticLogFlush();
    })
    .catch(() => undefined);
}

export function recordDiagnosticLogEvent(event: DiagnosticLogEvent): Promise<void> {
  return appendDiagnosticLogEvent(event);
}

export function toImageTranslateDiagnosticData(image: { base64: string; contentType: string; filename: string }): Record<string, unknown> {
  return {
    contentType: image.contentType,
    filename: image.filename,
    base64Length: image.base64.length,
  };
}

export async function recordBackgroundDiagnosticLog(
  settings: ExtensionSettings,
  event: DiagnosticLogEventInput,
): Promise<void> {
  if (!settings.enableDebugLog || !event.runId) {
    return;
  }
  try {
    await recordDiagnosticLogEvent(createDiagnosticEvent(event, event.sessionId ?? backgroundDiagnosticSessionId));
  } catch {
    // Diagnostic writes are best-effort and must not affect API requests.
  }
}

export function deriveDiagnosticRuns(events: DiagnosticLogEvent[]): DiagnosticLogRun[] {
  const runs = new Map<string, DiagnosticLogRun>();
  for (const event of events) {
    if (!event.runId) continue;
    const timestamp = normalizeDiagnosticTimestamp(event.timestamp, '');
    const existing = runs.get(event.runId);
    if (!existing) {
      runs.set(event.runId, {
        runId: event.runId,
        startedAt: timestamp,
        status: 'running',
        label: typeof event.data?.label === 'string' ? event.data.label : undefined,
      });
      continue;
    }
    if (timestamp < existing.startedAt) {
      existing.startedAt = timestamp;
    }
    const runStatus = event.data?.runStatus;
    if (runStatus === 'success' || runStatus === 'failed') {
      existing.status = runStatus;
      existing.finishedAt = timestamp;
      existing.error = event.error?.message ?? (typeof event.data?.error === 'string' ? event.data.error : existing.error);
    }
  }
  return [...runs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export async function exportDiagnosticLog(): Promise<DiagnosticLogTextExport> {
  await flushDiagnosticLogNow().catch(() => undefined);
  const store = await loadDiagnosticLogStore();
  const settings = await getSettings();
  const chromeApi = getExtensionApi();
  const manifest = chromeApi?.runtime?.getManifest?.();
  const events = store.events.map(redactDiagnosticEventForExport);
  const exportedAt = new Date().toISOString();
  const extension = {
    version: manifest?.version,
    manifestVersion: manifest?.manifest_version,
  };
  const environment = {
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
    language: typeof navigator !== 'undefined' ? navigator.language : undefined,
    platform: typeof navigator !== 'undefined' ? navigator.platform : undefined,
    crossOriginIsolated: typeof crossOriginIsolated === 'boolean' ? crossOriginIsolated : undefined,
  };
  const activeSettings = sanitizeExtensionSettings(settings);
  const runs = deriveDiagnosticRuns(events);
  return {
    schemaVersion: 1,
    exportedAt,
    filenamePrefix: 'shinobu-diagnostic-log',
    contentType: 'text/plain;charset=utf-8',
    eventCount: events.length,
    text: formatDiagnosticTextLog(events, {
      exportedAt,
      extension,
      environment,
      activeSettings,
      runs,
      truncated: store.truncated,
      truncationReason: store.truncationReason,
    }),
  };
}

export async function clearDiagnosticLog(): Promise<void> {
  if (flushHandle !== null) {
    clearTimeout(flushHandle);
    flushHandle = null;
  }
  cachedStore = { events: [] };
  logDirty = false;
  flushChain = Promise.resolve();
  await storageRemove(diagnosticLogStorageKey);
}
