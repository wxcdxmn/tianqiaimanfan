import { getExtensionApi } from '../../shared/extensionRuntime';
import { isExtensionContextAlive } from '../../shared/contextGuard';
import {
  defaultGenericSiteState,
  genericSiteHostFromKey,
  isGenericSiteStorageKey,
  mergeGenericSiteState,
  normalizeGenericSiteState,
  readGenericSiteStateFrom,
  writeGenericSiteStateTo,
  type GenericSiteState,
} from '../../shared/genericSiteState';

/**
 * Per-site opt-in for the generic (RuneManga-style) in-place translation on
 * sites that have no dedicated SiteAdapter.
 *
 * Extension local storage is the single source of truth, so the popup, the
 * context menu and every tab of the same site observe the same state. This
 * module owns the in-page cache that keeps reads synchronous for the render
 * path and notifies subscribers when the state changes anywhere.
 */

export type { GenericSiteState };

let cachedHost: string | null = null;
let cachedState: GenericSiteState = defaultGenericSiteState;
const listeners = new Set<() => void>();
let observingStorage = false;
let stateRevision = 0;

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
  if (
    cachedHost === host
    && cachedState.enabled === state.enabled
    && cachedState.auto === state.auto
  ) {
    return;
  }
  cachedHost = host;
  cachedState = state;
  stateRevision += 1;
  notify();
}

export function subscribeGenericSiteState(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Keep the cache in sync when another context (popup, or another tab of the
 * same site) writes the key, so "enable for this site" applies everywhere
 * without a reload.
 */
function observeStorage(host: string): void {
  const storage = getExtensionApi()?.storage;
  if (observingStorage || !storage?.onChanged?.addListener) return;
  observingStorage = true;
  storage.onChanged.addListener((changes, areaName) => {
    if (!isExtensionContextAlive()) {
      observingStorage = false;
      console.info('[tianqiaimanfan] 扩展已重新加载，请刷新页面');
      return;
    }
    if (areaName && areaName !== 'local') return;
    for (const [key, change] of Object.entries(changes)) {
      if (!isGenericSiteStorageKey(key)) continue;
      if (genericSiteHostFromKey(key) !== host) continue;
      setCachedState(host, normalizeGenericSiteState(change.newValue));
    }
  });
}

export async function readGenericSiteState(host: string): Promise<GenericSiteState> {
  return readGenericSiteStateFrom(getExtensionApi(), host);
}

export async function writeGenericSiteState(host: string, state: GenericSiteState): Promise<void> {
  await writeGenericSiteStateTo(getExtensionApi(), host, state);
}

/** Load the persisted state for `host` into the in-memory cache. */
export async function primeGenericSiteState(host: string): Promise<void> {
  observeStorage(host);
  const revision = stateRevision;
  const state = await readGenericSiteState(host);
  // A live change (popup, another tab) may have landed while we were reading.
  if (stateRevision !== revision) return;
  setCachedState(host, state);
}

/** Apply a partial update; turning the site off also clears `auto`. */
export async function setGenericSiteState(
  host: string,
  patch: Partial<GenericSiteState>,
): Promise<GenericSiteState> {
  const current = cachedHost === host ? cachedState : await readGenericSiteState(host);
  const next = mergeGenericSiteState(current, patch);
  await writeGenericSiteState(host, next);
  setCachedState(host, next);
  return next;
}

export async function setGenericSiteEnabled(host: string, enabled: boolean): Promise<GenericSiteState> {
  return setGenericSiteState(host, { enabled });
}

export async function setGenericSiteAuto(host: string, auto: boolean): Promise<GenericSiteState> {
  return setGenericSiteState(host, { auto });
}

export async function toggleGenericSite(host: string): Promise<GenericSiteState> {
  const current = cachedHost === host ? cachedState : await readGenericSiteState(host);
  return setGenericSiteEnabled(host, !current.enabled);
}
