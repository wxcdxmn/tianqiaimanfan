import { getExtensionApi, type ExtensionBrowserApi } from '../shared/extensionRuntime';
import {
  mergeGenericSiteState,
  readGenericSiteStateFrom,
  writeGenericSiteStateTo,
  type GenericSiteState,
} from '../shared/genericSiteState';

/**
 * Popup side of the per-site switch.
 *
 * The content script owns the authoritative state (it also drives the in-page
 * UI), so the popup asks it first and only falls back to `storage.local` when
 * the page has no reachable content script (e.g. a tab opened before install).
 */

export type SiteControlState = {
  host: string;
  /** false when the active tab is not a regular http(s) page. */
  supported: boolean;
  /** true when the host ships a dedicated adapter instead of the generic one. */
  builtIn: boolean;
  enabled: boolean;
  auto: boolean;
};

const unsupportedSite: SiteControlState = {
  host: '',
  supported: false,
  builtIn: false,
  enabled: false,
  auto: false,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function queryActiveTab(api: ExtensionBrowserApi | null): Promise<{ id?: number; url?: string } | null> {
  const query = api?.tabs?.query;
  if (!query) return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      query({ active: true, currentWindow: true }, (tabs) => resolve(tabs?.[0] ?? null));
    } catch {
      resolve(null);
    }
  });
}

/** Resolves `undefined` when the page has no reachable content script. */
async function askContentScript(
  api: ExtensionBrowserApi | null,
  tabId: number,
  message: unknown,
): Promise<unknown> {
  const sendMessage = api?.tabs?.sendMessage;
  if (!sendMessage) return undefined;
  try {
    return await Promise.resolve(sendMessage(tabId, message));
  } catch {
    return undefined;
  }
}

function toHost(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.hostname.toLowerCase();
  } catch {
    return null;
  }
}

export async function readSiteControlState(): Promise<SiteControlState> {
  const api = getExtensionApi();
  const tab = await queryActiveTab(api);
  const host = tab?.url ? toHost(tab.url) : null;
  if (!host) return unsupportedSite;

  if (tab?.id !== undefined) {
    const response = await askContentScript(api, tab.id, { type: 'mt:generic-site-status' });
    if (isRecord(response) && response.ok === true && response.type === 'mt:generic-site-status') {
      return {
        host,
        supported: true,
        builtIn: response.builtIn === true,
        enabled: response.enabled === true,
        auto: response.auto === true,
      };
    }
  }

  const stored = await readGenericSiteStateFrom(api, host);
  return { host, supported: true, builtIn: false, ...stored };
}

export async function updateSiteControlState(
  patch: Partial<GenericSiteState>,
): Promise<SiteControlState> {
  const api = getExtensionApi();
  const tab = await queryActiveTab(api);
  const host = tab?.url ? toHost(tab.url) : null;
  if (!host) return unsupportedSite;

  if (tab?.id !== undefined) {
    const response = await askContentScript(api, tab.id, {
      type: 'mt:set-generic-site',
      ...patch,
    });
    if (isRecord(response) && response.ok === true && response.type === 'mt:set-generic-site') {
      return {
        host,
        supported: true,
        builtIn: false,
        enabled: response.enabled === true,
        auto: response.auto === true,
      };
    }
    if (isRecord(response) && response.ok === false && typeof response.error === 'string') {
      throw new Error(response.error);
    }
  }

  const current = await readGenericSiteStateFrom(api, host);
  const next = mergeGenericSiteState(current, patch);
  await writeGenericSiteStateTo(api, host, next);
  return { host, supported: true, builtIn: false, ...next };
}
