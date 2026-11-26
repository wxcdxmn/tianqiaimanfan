import type { ExtensionBrowserApi } from './extensionRuntime';

/**
 * Persisted per-site opt-in for the generic (RuneManga-style) in-place
 * translation. Shared by the content script and the popup so both sides agree
 * on one storage contract.
 */

export type GenericSiteState = {
  /** Render translate buttons on manga-sized images of this host. */
  enabled: boolean;
  /** Translate the pages near the viewport automatically as the reader scrolls. */
  auto: boolean;
};

export const defaultGenericSiteState: GenericSiteState = { enabled: false, auto: false };

const STORAGE_KEY_PREFIX = 'shinobu:generic-site:';

export function genericSiteStorageKey(host: string): string {
  return `${STORAGE_KEY_PREFIX}${host}`;
}

export function isGenericSiteStorageKey(key: string): boolean {
  return key.startsWith(STORAGE_KEY_PREFIX);
}

export function genericSiteHostFromKey(key: string): string {
  return key.slice(STORAGE_KEY_PREFIX.length);
}

export function normalizeGenericSiteState(value: unknown): GenericSiteState {
  if (!value || typeof value !== 'object') return defaultGenericSiteState;
  const record = value as { enabled?: unknown; auto?: unknown };
  const enabled = record.enabled === true;
  // Auto is only meaningful while the site is enabled.
  return { enabled, auto: enabled && record.auto === true };
}

export function mergeGenericSiteState(
  current: GenericSiteState,
  patch: Partial<GenericSiteState>,
): GenericSiteState {
  const enabled = patch.enabled ?? current.enabled;
  return {
    enabled,
    auto: enabled ? (patch.auto ?? current.auto) : false,
  };
}

export async function readGenericSiteStateFrom(
  api: ExtensionBrowserApi | null,
  host: string,
): Promise<GenericSiteState> {
  const local = api?.storage?.local;
  const key = genericSiteStorageKey(host);
  if (!local?.get) return defaultGenericSiteState;
  const items = await new Promise<Record<string, unknown>>((resolve) => {
    try {
      local.get?.(key, resolve);
    } catch {
      resolve({});
    }
  });
  return normalizeGenericSiteState(items[key]);
}

export async function writeGenericSiteStateTo(
  api: ExtensionBrowserApi | null,
  host: string,
  state: GenericSiteState,
): Promise<void> {
  const local = api?.storage?.local;
  if (!local?.set) return;
  await new Promise<void>((resolve) => {
    try {
      local.set?.({ [genericSiteStorageKey(host)]: state }, resolve);
    } catch {
      resolve();
    }
  });
}
