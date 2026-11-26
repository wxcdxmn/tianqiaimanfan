import { getExtensionApi } from '../../shared/extensionRuntime';

/**
 * Per-site opt-in for the generic (RuneManga-style) in-place translation on
 * sites that have no dedicated SiteAdapter.
 *
 * State lives in the extension's local storage so it survives reloads and is
 * shared by every tab without a background round-trip for reads in the common case.
 */

export type GenericSiteState = {
  enabled: boolean;
  auto: boolean;
};

const STORAGE_KEY_PREFIX = 'shinobu:generic-site:';
const DEFAULT_STATE: GenericSiteState = { enabled: false, auto: false };

let cachedHost: string | null = null;
let cachedState: GenericSiteState = DEFAULT_STATE;
const listeners = new Set<() => void>();

export function genericSiteStorageKey(host: string): string {
  return `${STORAGE_KEY_PREFIX}${host}`;
}

function normalizeState(value: unknown): GenericSiteState {
  if (!value || typeof value !== 'object') return DEFAULT_STATE;
  const record = value as { enabled?: unknown; auto?: unknown };
  return {
    enabled: record.enabled === true,
    auto: record.auto === true,
  };
}

export function isGenericSiteEnabled(): boolean {
  return cachedState.enabled;
}

export function isGenericSiteAutoEnabled(): boolean {
  return cachedState.auto;
}

function notify(): void {
  for (const listener of listeners) listener();
}

function setCachedState(host: string, state: GenericSiteState): void {
  if (cachedHost === host && cachedState.enabled === state.enabled && cachedState.auto === state.auto) {
    return;
  }
  cachedHost = host;
  cachedState = state;
  notify();
}

export function subscribeGenericSiteState(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function readGenericSiteState(host: string): Promise<GenericSiteState> {
  const local = getExtensionApi()?.storage?.local;
  const key = genericSiteStorageKey(host);
  if (!local?.get) return DEFAULT_STATE;
  const items = await new Promise<Record<string, unknown>>((resolve) => {
    try {
      local.get?.(key, resolve);
    } catch {
      resolve({});
    }
  });
  return normalizeState(items[key]);
}

export async function writeGenericSiteState(host: string, state: GenericSiteState): Promise<void> {
  const local = getExtensionApi()?.storage?.local;
  if (!local?.set) return;
  await new Promise<void>((resolve) => {
    try {
      local.set?.({ [genericSiteStorageKey(host)]: state }, resolve);
    } catch {
      resolve();
    }
  });
}

/** Load the persisted state for `host` into the in-memory cache. */
export async function primeGenericSiteState(host: string): Promise<void> {
  const state = await readGenericSiteState(host);
  setCachedState(host, state);
}

export async function setGenericSiteEnabled(host: string, enabled: boolean): Promise<GenericSiteState> {
  const next: GenericSiteState = { enabled, auto: enabled ? cachedState.auto : false };
  await writeGenericSiteState(host, next);
  setCachedState(host, next);
  return next;
}

export async function toggleGenericSite(host: string): Promise<GenericSiteState> {
  return setGenericSiteEnabled(host, !cachedState.enabled);
}
