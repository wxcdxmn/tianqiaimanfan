import { describe, expect, it } from 'vitest';
import {
  genericSiteHostFromKey,
  genericSiteStorageKey,
  isGenericSiteStorageKey,
  mergeGenericSiteState,
  normalizeGenericSiteState,
} from '../../apps/extension/src/shared/genericSiteState';

describe('generic site state', () => {
  it('round-trips the host through the storage key', () => {
    const key = genericSiteStorageKey('manga.example');
    expect(isGenericSiteStorageKey(key)).toBe(true);
    expect(genericSiteHostFromKey(key)).toBe('manga.example');
    expect(isGenericSiteStorageKey('shinobu:settings')).toBe(false);
  });

  it('treats anything but an explicit true as disabled', () => {
    expect(normalizeGenericSiteState(undefined)).toEqual({ enabled: false, auto: false });
    expect(normalizeGenericSiteState({ enabled: 'yes', auto: 1 })).toEqual({
      enabled: false,
      auto: false,
    });
  });

  it('drops auto when the site is switched off', () => {
    expect(normalizeGenericSiteState({ enabled: false, auto: true })).toEqual({
      enabled: false,
      auto: false,
    });
  });

  it('turns auto off when the site is disabled through a patch', () => {
    expect(mergeGenericSiteState({ enabled: true, auto: true }, { enabled: false })).toEqual({
      enabled: false,
      auto: false,
    });
  });

  it('keeps auto when only the site switch is touched', () => {
    expect(mergeGenericSiteState({ enabled: true, auto: true }, { enabled: true })).toEqual({
      enabled: true,
      auto: true,
    });
    expect(mergeGenericSiteState({ enabled: true, auto: false }, { auto: true })).toEqual({
      enabled: true,
      auto: true,
    });
  });

  it('ignores auto on a disabled site', () => {
    expect(mergeGenericSiteState({ enabled: false, auto: false }, { auto: true })).toEqual({
      enabled: false,
      auto: false,
    });
  });
});
