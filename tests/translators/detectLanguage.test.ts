import { describe, expect, it } from 'vitest';
import {
  countScripts,
  detectSourceLanguage,
  resolveSourceLanguage,
  scriptOfLanguage,
} from '../../packages/text-translation/src/detectLanguage';

describe('countScripts', () => {
  it('把假名、谚文、汉字、拉丁字母分开计数，并忽略数字与标点', () => {
    const counts = countScripts('こんにちは ABC 123 !? 漢字');
    expect(counts.kana).toBe(5);
    expect(counts.latin).toBe(3);
    expect(counts.han).toBe(2);
    // 数字、空格、标点都不进分母
    expect(counts.total).toBe(10);
  });

  it('全角标点不算字母', () => {
    const counts = countScripts('「你好」，！');
    expect(counts.han).toBe(2);
    expect(counts.total).toBe(2);
  });
});

describe('detectSourceLanguage', () => {
  it('假名占比够高判为日文', () => {
    const result = detectSourceLanguage([
      'お前、いつになったら来るんだ',
      'そんな約束はしていない',
    ]);
    expect(result.script).toBe('ja');
    expect(result.language).toBe('ja');
  });

  it('汉字为主且无假名判为中文', () => {
    const result = detectSourceLanguage(['你给我站住', '这件事没完']);
    expect(result.script).toBe('zh');
    expect(result.language).toBe('zh-CHS');
  });

  it('谚文判为韩文', () => {
    const result = detectSourceLanguage(['너는 왜 여기 있어', '내가 부를 때까지 기다려']);
    expect(result.script).toBe('ko');
    expect(result.language).toBe('ko');
  });

  it('英文条漫判为拉丁语族并给出 en', () => {
    const result = detectSourceLanguage([
      "YOU SHOULD'VE SHOWED UP THE MOMENT I REGRESSED.",
      'I told you to wait until I called for you.',
    ]);
    expect(result.script).toBe('latin');
    expect(result.language).toBe('en');
  });

  it('字符太少时不判定，避免拟声字误判', () => {
    expect(detectSourceLanguage(['뻐']).script).toBeNull();
    expect(detectSourceLanguage(['']).script).toBeNull();
    expect(detectSourceLanguage([]).script).toBeNull();
  });

  it('OCR 噪声（偶发错字）不会翻转判定', () => {
    const result = detectSourceLanguage([
      'I will never forgive you for what you did to my family',
      '그래도',
    ]);
    expect(result.script).toBe('latin');
  });
});

describe('scriptOfLanguage', () => {
  it('识别常见语言码', () => {
    expect(scriptOfLanguage('ja')).toBe('ja');
    expect(scriptOfLanguage('jp')).toBe('ja');
    expect(scriptOfLanguage('ko')).toBe('ko');
    expect(scriptOfLanguage('zh-CHS')).toBe('zh');
    expect(scriptOfLanguage('zh-CHT')).toBe('zh');
    expect(scriptOfLanguage('en')).toBe('latin');
    expect(scriptOfLanguage('auto')).toBeNull();
    expect(scriptOfLanguage(undefined)).toBeNull();
  });
});

describe('resolveSourceLanguage', () => {
  const english = [
    'YOU SHOULD HAVE SHOWED UP EARLIER.',
    'Then I will take it by force.',
  ];
  const japanese = ['お前はもう死んでいる', '何を言っているんだ'];

  it('配置为日文但页面是英文时按实测改写为 en', () => {
    const result = resolveSourceLanguage('ja', english);
    expect(result.overridden).toBe(true);
    expect(result.language).toBe('en');
  });

  it('配置为日文且页面确实是日文时保持配置', () => {
    const result = resolveSourceLanguage('ja', japanese);
    expect(result.overridden).toBe(false);
    expect(result.language).toBe('ja');
  });

  it('配置 zh-CHT 遇到中文页面时保留繁体，不被改写成简体', () => {
    const result = resolveSourceLanguage('zh-CHT', ['你给我站住', '这件事没完']);
    expect(result.overridden).toBe(false);
    expect(result.language).toBe('zh-CHT');
  });

  it('auto 直接采用检测结果', () => {
    expect(resolveSourceLanguage('auto', english).language).toBe('en');
    expect(resolveSourceLanguage('', japanese).language).toBe('ja');
  });

  it('无法判定时回退到配置值', () => {
    const result = resolveSourceLanguage('ko', ['뻐']);
    expect(result.overridden).toBe(false);
    expect(result.language).toBe('ko');
  });
});

describe('拉丁语系细分', () => {
  it('识别西语（¿ ¡ ñ 与高频虚词）', () => {
    const text = ['¿Qué estás haciendo aquí? No puedo creerlo.', 'Esto es muy peligroso para usted.'];
    expect(detectSourceLanguage(text).language).toBe('es');
  });

  it('识别法语', () => {
    const text = ['Je ne sais pas ce que vous voulez.', 'Mais cette histoire est très étrange.'];
    expect(detectSourceLanguage(text).language).toBe('fr');
  });

  it('识别德语（变音符号与虚词）', () => {
    const text = ['Ich weiß nicht, was du hier machst.', 'Das ist nicht der richtige Weg für dich.'];
    expect(detectSourceLanguage(text).language).toBe('de');
  });

  it('识别葡语', () => {
    const text = ['Não sei o que você está fazendo aqui.', 'Isso não é uma boa ideia, meu amigo.'];
    expect(detectSourceLanguage(text).language).toBe('pt');
  });

  it('识别越南语', () => {
    const text = ['Tôi không biết bạn đang làm gì ở đây.', 'Đây là một điều rất nguy hiểm.'];
    expect(detectSourceLanguage(text).language).toBe('vi');
  });

  it('普通英文不会被误判成别的语种', () => {
    const text = ['You should have shown up the moment I regressed.', 'I told you to wait until I called for you.'];
    expect(detectSourceLanguage(text).language).toBe('en');
  });

  it('证据太弱时按英文处理', () => {
    // 只出现 De la 这类常见西语虚词，但整句明显是英文，不应判成西语。
    expect(detectSourceLanguage(['De la Cruz is my name, come with me please.']).language).toBe('en');
  });

  it('字符太少时干脆不判定', () => {
    expect(detectSourceLanguage(['La de']).language).toBeNull();
  });

  it('用户显式选定的拉丁语种不会被改写', () => {
    const result = resolveSourceLanguage('es', [
      '¿Qué estás haciendo aquí? Esto es muy peligroso para usted.',
    ]);
    expect(result.overridden).toBe(false);
    expect(result.language).toBe('es');
  });

  it('auto 时采用细分结果', () => {
    const result = resolveSourceLanguage('auto', [
      'Je ne sais pas ce que vous voulez. Mais cette histoire est très étrange.',
    ]);
    expect(result.overridden).toBe(true);
    expect(result.language).toBe('fr');
  });
});

describe('泰文与阿拉伯文', () => {
  it('识别泰文', () => {
    const text = ['ฉันไม่รู้ว่าคุณกำลังทำอะไรที่นี่', 'มันอันตรายมาก'];
    const result = detectSourceLanguage(text);
    expect(result.script).toBe('thai');
    expect(result.language).toBe('th');
  });

  it('识别阿拉伯文', () => {
    const text = ['لا أعرف ما الذي تفعله هنا', 'هذا أمر خطير جدا'];
    const result = detectSourceLanguage(text);
    expect(result.script).toBe('arabic');
    expect(result.language).toBe('ar');
  });

  it('scriptOfLanguage 认得新增语种', () => {
    expect(scriptOfLanguage('th')).toBe('thai');
    expect(scriptOfLanguage('ar')).toBe('arabic');
    expect(scriptOfLanguage('it')).toBe('latin');
  });
});
