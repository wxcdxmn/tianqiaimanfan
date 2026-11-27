import { describe, expect, it } from 'vitest';
import { matchLocalPhrase } from '../../packages/text-translation/src/translators/localPhrases';

describe('短拟声词本地兜底', () => {
  it('日志里的西语拟声词能映射到中文', () => {
    for (const source of ['¿MMPH?', 'MMPH', 'LEH?', '...BLE.', '…N.']) {
      expect(matchLocalPhrase(source)?.kind).toBe('translate');
    }
  });

  it('OCR 噪声判为不可翻译，不再占用补翻名额', () => {
    expect(matchLocalPhrase('G:JNDZHSZ')).toEqual({ kind: 'untranslatable' });
    expect(matchLocalPhrase('G:3NDZHS2')).toEqual({ kind: 'untranslatable' });
  });

  it('正文台词不误命中', () => {
    expect(matchLocalPhrase('你为什么又制造丑闻......？')).toBeNull();
    expect(matchLocalPhrase('LA SALIVA DE ESTE TIPO')).toBeNull();
  });
});
