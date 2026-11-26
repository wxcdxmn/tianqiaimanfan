import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  readSiteControlState,
  updateSiteControlState,
} from '../../apps/extension/src/popup/siteControlClient';
import { genericSiteStorageKey } from '../../apps/extension/src/shared/genericSiteState';

type StubOptions = {
  url?: string;
  tabId?: number;
  sendMessage?: (message: Record<string, unknown>) => Promise<unknown>;
  stored?: Record<string, unknown>;
};

function stubChrome(options: StubOptions = {}) {
  const { url = 'https://manga.test/chapter/1', tabId = 7, sendMessage, stored = {} } = options;
  const store: Record<string, unknown> = { ...stored };
  const writes: Array<Record<string, unknown>> = [];

  const api = {
    tabs: {
      query: (
        _info: unknown,
        callback: (tabs: Array<{ id?: number; url?: string }>) => void,
      ) => {
        callback([{ id: tabId, url }]);
      },
      ...(sendMessage
        ? { sendMessage: (_tabId: number, message: Record<string, unknown>) => sendMessage(message) }
        : {}),
    },
    storage: {
      local: {
        get: (keys: string | string[], callback: (items: Record<string, unknown>) => void) => {
          const list = typeof keys === 'string' ? [keys] : keys;
          callback(Object.fromEntries(list.filter((key) => key in store).map((key) => [key, store[key]])));
        },
        set: (items: Record<string, unknown>, callback: () => void) => {
          Object.assign(store, items);
          writes.push(items);
          callback();
        },
      },
    },
  };

  vi.stubGlobal('chrome', api);
  return { store, writes };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('popup site control client', () => {
  it('reads the live state from the content script', async () => {
    stubChrome({
      sendMessage: async (message) => {
        expect(message.type).toBe('mt:generic-site-status');
        return { ok: true, type: 'mt:generic-site-status', builtIn: false, enabled: true, auto: true };
      },
    });

    await expect(readSiteControlState()).resolves.toEqual({
      host: 'manga.test',
      supported: true,
      builtIn: false,
      enabled: true,
      auto: true,
    });
  });

  it('reports hosts that ship a dedicated adapter', async () => {
    stubChrome({
      url: 'https://www.pixiv.net/artworks/1',
      sendMessage: async () => ({
        ok: true,
        type: 'mt:generic-site-status',
        builtIn: true,
        enabled: false,
        auto: false,
      }),
    });

    await expect(readSiteControlState()).resolves.toEqual({
      host: 'www.pixiv.net',
      supported: true,
      builtIn: true,
      enabled: false,
      auto: false,
    });
  });

  it('falls back to stored state when no content script answers', async () => {
    stubChrome({
      stored: { [genericSiteStorageKey('manga.test')]: { enabled: true, auto: false } },
    });

    await expect(readSiteControlState()).resolves.toEqual({
      host: 'manga.test',
      supported: true,
      builtIn: false,
      enabled: true,
      auto: false,
    });
  });

  it('ignores pages that are not regular web pages', async () => {
    stubChrome({ url: 'chrome://extensions/' });

    await expect(readSiteControlState()).resolves.toEqual({
      host: '',
      supported: false,
      builtIn: false,
      enabled: false,
      auto: false,
    });
  });

  it('applies a patch through the content script and returns its state', async () => {
    const { writes } = stubChrome({
      sendMessage: async (message) => {
        expect(message).toEqual({ type: 'mt:set-generic-site', enabled: true });
        return { ok: true, type: 'mt:set-generic-site', host: 'manga.test', enabled: true, auto: false };
      },
    });

    await expect(updateSiteControlState({ enabled: true })).resolves.toEqual({
      host: 'manga.test',
      supported: true,
      builtIn: false,
      enabled: true,
      auto: false,
    });
    expect(writes).toHaveLength(0);
  });

  it('writes storage itself when the page has no content script', async () => {
    const { store, writes } = stubChrome();

    await expect(updateSiteControlState({ enabled: true, auto: true })).resolves.toEqual({
      host: 'manga.test',
      supported: true,
      builtIn: false,
      enabled: true,
      auto: true,
    });
    expect(store[genericSiteStorageKey('manga.test')]).toEqual({ enabled: true, auto: true });
    expect(writes).toHaveLength(1);
  });

  it('surfaces a rejection from the content script instead of writing storage', async () => {
    const { writes } = stubChrome({
      sendMessage: async () => ({
        ok: false,
        type: 'mt:set-generic-site',
        error: '该站点已有内置适配器',
      }),
    });

    await expect(updateSiteControlState({ enabled: true })).rejects.toThrow('该站点已有内置适配器');
    expect(writes).toHaveLength(0);
  });
});
