import { describe, expect, it } from 'vitest';
import {
  AUTO_SOURCE_LANGUAGE,
  canonicalizeLanguageCode,
  fontVariantForTarget,
  isRightToLeftLanguage,
  languageLabel,
  normalizeSourceLanguage,
  normalizeTargetLanguage,
  sourceLanguageOptions,
  targetLanguageLabel,
  targetLanguageOptions,
} from '../../apps/extension/src/shared/languages';

describe('language catalog', () => {
  it('offers 自动检测 as the first source option', () => {
    expect(sourceLanguageOptions[0]?.value).toBe(AUTO_SOURCE_LANGUAGE);
    expect(sourceLanguageOptions[0]?.label).toBe('自动检测');
  });

  it('supports more than the two Chinese targets', () => {
    const values = targetLanguageOptions.map((option) => option.value);
    expect(values).toContain('zh-CHS');
    expect(values).toContain('zh-CHT');
    expect(values).toContain('en');
    expect(values).toContain('ja');
    expect(values).toContain('ko');
    expect(values.length).toBeGreaterThanOrEqual(12);
  });

  it('canonicalizes browser-style tags', () => {
    expect(canonicalizeLanguageCode('zh-CN')).toBe('zh-CHS');
    expect(canonicalizeLanguageCode('zh_Hant')).toBe('zh-CHT');
    expect(canonicalizeLanguageCode('zh-Hant')).toBe('zh-CHT');
    expect(canonicalizeLanguageCode('zh-TW')).toBe('zh-CHT');
    expect(canonicalizeLanguageCode('jp')).toBe('ja');
    expect(canonicalizeLanguageCode('KO')).toBe('ko');
    expect(canonicalizeLanguageCode('en-GB')).toBe('en');
    expect(canonicalizeLanguageCode('th')).toBe('th');
    expect(canonicalizeLanguageCode('klingon')).toBe(null);
  });

  it('keeps auto for source languages and falls back for junk', () => {
    expect(normalizeSourceLanguage('AUTO')).toBe('auto');
    expect(normalizeSourceLanguage('ja')).toBe('ja');
    expect(normalizeSourceLanguage('')).toBe('auto');
    expect(normalizeSourceLanguage('xx-unknown')).toBe('auto');
  });

  it('never resolves a target language to auto', () => {
    expect(normalizeTargetLanguage('auto')).toBe('zh-CHS');
    expect(normalizeTargetLanguage(undefined)).toBe('zh-CHS');
    expect(normalizeTargetLanguage('fr')).toBe('fr');
  });

  it('labels targets for prompts and UI', () => {
    expect(targetLanguageLabel('zh-CHS')).toBe('简体中文');
    expect(targetLanguageLabel('zh-CHT')).toBe('繁体中文');
    expect(targetLanguageLabel('en')).toBe('英文');
    expect(targetLanguageLabel('ko')).toBe('韩文');
    expect(languageLabel('de')).toBe('Deutsch');
    expect(languageLabel('auto')).toBe('自动检测');
  });

  it('picks the TW font only for traditional Chinese', () => {
    expect(fontVariantForTarget('zh-CHT')).toBe('TW');
    expect(fontVariantForTarget('zh-TW')).toBe('TW');
    expect(fontVariantForTarget('ja')).toBe('CN');
  });

  it('flags right-to-left targets', () => {
    expect(isRightToLeftLanguage('ar')).toBe(true);
    expect(isRightToLeftLanguage('zh-CHS')).toBe(false);
  });
});
