import type { TextRegion } from '../../types';

/**
 * 通用顶级域白名单：水印里常见「MANGA18FX.COM」「OMEGASCANS.ORG」这类站点名。
 * 正文对白极少包含裸域名，命中即视为水印。
 *
 * 注意这里不能用 `\b` 收左边界：OCR 常把站点名和中文宣传语连成一段
 * （「漫画18FX.COM」「免费阅读newxtoon5.com」），汉字属于 `\p{L}`，
 * 和后面的 ASCII 字母之间不构成 `\b`，于是整条规则失效——这正是一批水印
 * 被当成台词翻译、擦除、重排的原因。
 */
const TOP_LEVEL_DOMAINS = [
  'com', 'net', 'org', 'io', 'xyz', 'to', 'me', 'cc', 'tv', 'co', 'info',
  'online', 'site', 'app', 'biz', 'us', 'ru', 'eu', 'vip', 'kr', 'jp', 'cn',
  'tw', 'hk', 'uk', 'de', 'fr', 'es', 'br', 'club', 'store', 'link', 'top',
  'shop', 'art', 'fun', 'space', 'website', 'live', 'pro', 'dev', 'gg', 'ly',
].join('|');

const DOMAIN_PATTERN = new RegExp(
  `(?:[A-Za-z0-9][A-Za-z0-9-]{0,40}\\.)+(?:${TOP_LEVEL_DOMAINS})(?![A-Za-z0-9])`,
  'i',
);

/**
 * OCR 截断的站点名：条漫上的「TEMPLESCANESPNET」常被认成「MPLESCANESP.NE」
 * 这类首尾缺失的残片，域名正则要求完整 TLD 因而漏掉。这里只针对带 SCAN +
 * ESP/NET 的组合（汉化组站名的常见骨架），不碰正常台词。
 */
const TRUNCATED_SITE_PATTERN = /[A-Z]{2,}SCAN[A-Z]{2,}(?:\.[A-Z]{2,3})?/i;

/** 裸链接、社媒主页与短链：出现在画面上几乎只可能是站点推广。 */
const LINK_PATTERN = /https?:\/\/|www\.|(?:t\.me|discord\.gg|patreon\.com|twitter\.com|instagram\.com|facebook\.com)\//i;

/** 「@账号」「扫码关注」这类账号推广。 */
const HANDLE_PATTERN = /(?:^|[\s：:])@[A-Za-z0-9._-]{3,}/;

/**
 * 站点推广语 / 汉化组署名。
 *
 * 只收「成套」的词组而不是单个常用字（例如只收「免费阅读」「最新更新」，
 * 不收「阅读」「更新」），否则正文台词里正常的「我读完了」也会被吃掉。
 */
const PROMO_PATTERNS: RegExp[] = [
  /免费阅读|在线阅读|在线看|免费看|最新更新|最新话|最新一话|更新至第?\s*\d+\s*[话章回]?|点(?:击|我)(?:阅读|查看|进入)|扫码|扫一扫|二维码|关注(?:我们|公众号|作者|频道)|公众号|订阅(?:我们|频道)?|加入(?:我们|群组|频道)|官方(?:网站|网址|app|账号)|网址|网站|下载(?:app|客户端)|全集|无删|完整版|资源(?:分享|站)|搬运|禁止转载|未(?:经)?授权|汉化组|翻译组|嵌字|图源|校对|招募|频道|群组|连载中|第\s*\d+\s*[话章回]\s*完/iu,
  /read\s+(?:the\s+)?(?:latest|more|free)|latest\s+(?:chapter|update|episode)|new\s+chapter|free\s+(?:read|chapter|access)|scanlat(?:ion|ed)?|translated\s+by|join\s+(?:our|the)\s+discord|patreon|support\s+us|official\s+(?:site|website|page)/i,
  /무료\s*(?:로|보기|웹툰|감상)|최신\s*(?:화|회차)|업데이트|번역\s*[:：]/u,
  /無料(?:で)?(?:読|公開|配信)|最新話|公式(?:サイト|Twitter|アカウント)|翻訳\s*[:：]/u,
];

/** 推广语判定的字数上限：水印标语是一行短语，长句基本都是台词。 */
const PROMO_MAX_CHARS = 28;

/** 句末标点：台词才有的东西，水印标语不会以句号/问号收尾。 */
const SENTENCE_END_PATTERN = /[。．.！!？?…~～♥♡]$/u;

/**
 * 站点水印的兜底特征：位于页面顶部一条细带内、又细又长的单行小字，
 * 例如「Read Manga Online in English Free」。
 *
 * 阈值刻意保守：
 * - 顶带不超过页高 4% 且至多 400px——条漫首页顶部通常是水印/标题区；
 * - 高度不超过页高 0.8% 且至多 40px——正文对白字高很少低到这个量级；
 * - 宽高比 ≥ 5——水印是横贯整页的细条，对白框很少这么扁。
 */
export function isSiteWatermarkRegion(
  region: Pick<TextRegion, 'sourceText' | 'box'> & { bubbleBox?: TextRegion['bubbleBox'] },
  pageWidth: number,
  pageHeight: number,
): boolean {
  const text = region.sourceText.trim();
  if (!text) return false;

  // 域名 / 链接 / 账号是硬证据，出现在画面上就是水印，不区分位置和气泡。
  if (DOMAIN_PATTERN.test(text)) return true;
  // 截断站名只在「无句末标点、且短」时命中，避免误伤对白里提到的站名。
  if (Array.from(text).length <= 28 && !/[。！？?！]$/u.test(text) && TRUNCATED_SITE_PATTERN.test(text)) {
    return true;
  }
  if (LINK_PATTERN.test(text)) return true;
  if (HANDLE_PATTERN.test(text)) return true;

  const pageH = Math.max(1, pageHeight);
  const pageW = Math.max(1, pageWidth);
  const box = region.box;

  // 推广语只在「不是台词框」时才判定：气泡内的文字一定是角色说的话，
  // 哪怕它恰好包含「免费阅读」这类字眼。
  if (region.bubbleBox === undefined && isPromoCopy(text)) {
    return true;
  }

  const topBand = Math.min(pageH * 0.04, 400);
  const thinHeight = Math.min(pageH * 0.008, 40);
  if (box.height <= 0 || box.width <= 0) return false;
  const aspect = box.width / box.height;
  return box.y <= topBand
    && box.height <= thinHeight
    && aspect >= 5
    && box.width <= pageW * 0.98;
}

function isPromoCopy(text: string): boolean {
  const compact = text.replace(/\s+/gu, '');
  if (!compact) return false;
  // 长句、带句末标点的句子按台词处理：宁可漏掉一条水印，也不能吞掉对白。
  if (Array.from(compact).length > PROMO_MAX_CHARS) return false;
  if (SENTENCE_END_PATTERN.test(compact)) return false;
  return PROMO_PATTERNS.some((pattern) => pattern.test(compact));
}
