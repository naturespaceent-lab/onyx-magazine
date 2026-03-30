#!/usr/bin/env node

/**
 * ONYX Magazine RSS Crawler + Static Site Generator
 *
 * i-D Magazine inspired dark luxury K-POP boy group editorial.
 * Crawls RSS feeds from K-pop news sites, extracts article data,
 * generates self-contained static HTML pages with ONYX aesthetic.
 *
 * Usage: node crawl.mjs
 * No dependencies needed — pure Node.js 18+ with built-in fetch.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ============================================================
// Configuration
// ============================================================

const SOURCES = [
  // === Tier 1: High-volume K-pop news ===
  { name: 'Soompi', url: 'https://www.soompi.com/feed', lang: 'en' },
  { name: 'Koreaboo', url: 'https://www.koreaboo.com/feed/', lang: 'en' },
  { name: 'HelloKpop', url: 'https://www.hellokpop.com/feed/', lang: 'en' },
  { name: 'Seoulbeats', url: 'https://seoulbeats.com/feed/', lang: 'en' },
  // === Tier 2: Commentary & Reviews ===
  { name: 'AsianJunkie', url: 'https://www.asianjunkie.com/feed/', lang: 'en' },
  { name: 'TheBiasList', url: 'https://thebiaslist.com/feed/', lang: 'en' },
  // === Tier 3: General entertainment w/ K-pop coverage ===
  { name: 'KDramaStars', url: 'https://www.kdramastars.com/rss.xml', lang: 'en' },
  { name: 'DramaNews', url: 'https://www.dramabeans.com/feed/', lang: 'en' },
  // === Tier 4: Japanese K-pop media ===
  { name: 'WowKoreaEnt', url: 'https://www.wowkorea.jp/rss/rss_ent.xml', lang: 'ja' },
  { name: 'WowKorea', url: 'https://www.wowkorea.jp/rss/rss_all.xml', lang: 'ja' },
  { name: 'Danmee', url: 'https://danmee.jp/feed/', lang: 'ja' },
  { name: 'KPOPMONSTER', url: 'https://kpopmonster.jp/feed/', lang: 'ja' },
];

const FETCH_TIMEOUT = 10_000;
const OG_IMAGE_TIMEOUT = 8_000;
const ARTICLE_FETCH_TIMEOUT = 12_000;
const MAX_OG_IMAGE_FETCHES = 40;
const OG_IMAGE_CONCURRENCY = 10;
const ARTICLE_FETCH_CONCURRENCY = 5;
const PLACEHOLDER_IMAGE = 'https://picsum.photos/seed/onyx-placeholder/800/450';

const log = (msg) => console.log(`[ONYX Crawler] ${msg}`);
const warn = (msg) => console.warn(`[ONYX Crawler] WARN: ${msg}`);

// ============================================================
// Fetch with timeout
// ============================================================

async function fetchWithTimeout(url, timeoutMs = FETCH_TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================
// XML Parsing helpers (regex-based, no dependencies)
// ============================================================

function extractTag(xml, tagName) {
  const cdataRe = new RegExp(`<${tagName}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${tagName}>`, 'i');
  const cdataMatch = xml.match(cdataRe);
  if (cdataMatch) return cdataMatch[1].trim();

  const re = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)</${tagName}>`, 'i');
  const match = xml.match(re);
  return match ? match[1].trim() : '';
}

function extractAllTags(xml, tagName) {
  const results = [];
  const re = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)</${tagName}>`, 'gi');
  let match;
  while ((match = re.exec(xml)) !== null) {
    results.push(match[1].trim());
  }
  return results;
}

function extractAttribute(xml, tagName, attrName) {
  const re = new RegExp(`<${tagName}[^>]*?${attrName}\\s*=\\s*["']([^"']+)["']`, 'i');
  const match = xml.match(re);
  return match ? match[1] : '';
}

function extractItems(xml) {
  const items = [];
  const re = /<item[^>]*>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = re.exec(xml)) !== null) {
    items.push(match[1]);
  }
  return items;
}

function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#8217;/g, "\u2019")
    .replace(/&#8216;/g, "\u2018")
    .replace(/&#8220;/g, "\u201C")
    .replace(/&#8221;/g, "\u201D")
    .replace(/&#8230;/g, "\u2026")
    .replace(/&#038;/g, '&')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function stripHtml(html) {
  return html.replace(/<[^>]+>/g, '').trim();
}

// ============================================================
// Image extraction
// ============================================================

function extractImageFromContent(content) {
  if (!content) return '';

  const mediaUrl = extractAttribute(content, 'media:content', 'url')
    || extractAttribute(content, 'media:thumbnail', 'url');
  if (mediaUrl) return mediaUrl;

  const enclosureUrl = extractAttribute(content, 'enclosure', 'url');
  if (enclosureUrl) {
    const enclosureType = extractAttribute(content, 'enclosure', 'type');
    if (!enclosureType || enclosureType.startsWith('image')) return enclosureUrl;
  }

  const imgMatch = content.match(/<img[^>]+src\s*=\s*["']([^"']+)["']/i);
  if (imgMatch) return imgMatch[1];

  return '';
}

async function fetchOgImage(articleUrl) {
  try {
    const html = await fetchWithTimeout(articleUrl, OG_IMAGE_TIMEOUT);
    const ogMatch = html.match(/<meta[^>]+property\s*=\s*["']og:image["'][^>]+content\s*=\s*["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content\s*=\s*["']([^"']+)["'][^>]+property\s*=\s*["']og:image["']/i);
    if (ogMatch) return ogMatch[1];
    return '';
  } catch {
    return '';
  }
}

// ============================================================
// Date formatting — Japanese style
// ============================================================

function formatDate(dateStr) {
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return '';
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
  } catch {
    return '';
  }
}

// ============================================================
// REWRITE ENGINE — ONYX editorial dark luxury tone
// Boy group focused, i-D/Dazed inspired Japanese
// ============================================================

// ---- Known K-pop group / artist names for extraction ----
// Focused on boy groups but includes all for proper matching

const KNOWN_GROUPS = [
  'BTS', 'BLACKPINK', 'TWICE', 'EXO', 'NCT', 'aespa', 'Stray Kids', 'ENHYPEN',
  'TXT', 'ATEEZ', 'SEVENTEEN', 'Red Velvet', 'IVE', 'LE SSERAFIM', 'NewJeans',
  '(G)I-DLE', 'ITZY', 'NMIXX', 'Kep1er', 'TREASURE', 'MAMAMOO', 'SHINee',
  'GOT7', 'MONSTA X', 'iKON', 'WINNER', '2NE1', "Girls' Generation", 'Super Junior',
  'BIGBANG', 'LOONA', 'fromis_9', 'tripleS', 'Dreamcatcher', 'VIVIZ',
  'Brave Girls', 'OH MY GIRL', 'Apink', 'BTOB', 'PENTAGON', 'SF9', 'THE BOYZ',
  'Golden Child', 'ONEUS', 'VERIVERY', 'CIX', 'VICTON', 'AB6IX', 'WEi',
  'CRAVITY', 'P1Harmony', 'TEMPEST', 'YOUNITE', 'Xdinary Heroes', 'Billlie',
  'LIGHTSUM', 'Weki Meki', 'Cherry Bullet', 'Rocket Punch', 'Purple Kiss',
  'Lapillus', 'FIFTY FIFTY', 'KISS OF LIFE', 'BABYMONSTER', 'ILLIT',
  'ZEROBASEONE', 'RIIZE', 'TWS', 'BOYNEXTDOOR', 'xikers', 'NCT 127',
  'NCT DREAM', 'WayV', 'NCT WISH', 'SNSD', 'f(x)', 'EXO-CBX', 'Super M',
  'Girls Generation', 'DAY6', 'ASTRO', 'Kara', 'INFINITE', 'BEAST',
  'Highlight', 'Block B', 'B.A.P', 'VIXX', 'CNBLUE', 'FTIsland',
  'ZB1', 'G-IDLE',
];

const KNOWN_SOLOISTS = [
  'V', 'Jungkook', 'Jennie', 'Lisa', 'Rosé', 'Jisoo', 'Suga', 'RM', 'J-Hope',
  'Jin', 'Jimin', 'Winter', 'Karina', 'Giselle', 'NingNing', 'Taeyeon', 'IU',
  'Sunmi', 'HyunA', 'Hwasa', 'Solar', 'Joy', 'Irene', 'Yeri', 'Wendy', 'Seulgi',
  'Mark', 'Taeyong', 'Jaehyun', 'Doyoung', 'Haechan', 'Jeno', 'Jaemin', 'Renjun',
  'Chenle', 'Jisung', 'Bangchan', 'Hyunjin', 'Felix', 'Han', 'Lee Know', 'Changbin',
  'Seungmin', 'I.N', 'Heeseung', 'Jay', 'Jake', 'Sunghoon', 'Sunoo', 'Jungwon',
  'Ni-ki', 'Soobin', 'Yeonjun', 'Beomgyu', 'Taehyun', 'Hueningkai', 'Hongjoong',
  'Seonghwa', 'Yunho', 'Yeosang', 'San', 'Mingi', 'Wooyoung', 'Jongho',
  'S.Coups', 'Jeonghan', 'Joshua', 'Jun', 'Hoshi', 'Wonwoo', 'Woozi', 'DK',
  'Mingyu', 'The8', 'Seungkwan', 'Vernon', 'Dino', 'Wonyoung', 'Yujin', 'Gaeul',
  'Liz', 'Leeseo', 'Rei', 'Sakura', 'Chaewon', 'Kazuha', 'Eunchae', 'Minji',
  'Hanni', 'Danielle', 'Haerin', 'Hyein', 'Miyeon', 'Minnie', 'Soyeon', 'Yuqi',
  'Shuhua', 'Yeji', 'Lia', 'Ryujin', 'Chaeryeong', 'Yuna', 'Sullyoon', 'Haewon',
  'Lily', 'Bae', 'Jiwoo', 'Kyujin', 'Cha Eun Woo', 'Park Bo Gum',
  'Song Joong Ki', 'Lee Min Ho', 'Kim Soo Hyun', 'Park Seo Joon', 'Jung Hae In',
  'Song Hye Kyo', 'Jun Ji Hyun', 'Kim Ji Won', 'Han So Hee', 'Suzy',
  'Park Shin Hye', 'Lee Sung Kyung', 'Yoo Yeon Seok', 'Park Na Rae',
  'Taemin', 'Baekhyun', 'Chanyeol', 'D.O.', 'Kai', 'Sehun', 'Xiumin',
  'Lay', 'Chen', 'Suho', 'GDragon', 'G-Dragon', 'Taeyang', 'Daesung',
  'Seungri', 'TOP', 'CL', 'Dara', 'Bom', 'Minzy', 'Zico',
  'Jackson', 'BamBam', 'Yugyeom', 'Youngjae', 'JB', 'Jinyoung',
  'Nayeon', 'Jeongyeon', 'Momo', 'Sana', 'Jihyo', 'Mina', 'Dahyun',
  'Chaeyoung', 'Tzuyu',
];

// Build a sorted-by-length-desc list for greedy matching
const ALL_KNOWN_NAMES = [...KNOWN_GROUPS, ...KNOWN_SOLOISTS]
  .sort((a, b) => b.length - a.length);

// ---- Topic classifier keyword map ----

const TOPIC_KEYWORDS = {
  comeback:     ['comeback', 'return', 'back', 'coming back', 'pre-release'],
  chart:        ['chart', 'billboard', 'number', 'record', 'no.1', '#1', 'top 10', 'million', 'stream', 'sales'],
  release:      ['album', 'single', 'ep', 'tracklist', 'release', 'drop', 'mini-album', 'mini album', 'full album'],
  concert:      ['concert', 'tour', 'live', 'stage', 'arena', 'stadium', 'world tour', 'encore'],
  fashion:      ['fashion', 'style', 'outfit', 'airport', 'look', 'brand', 'ambassador', 'vogue', 'elle'],
  drama:        ['drama', 'movie', 'film', 'acting', 'kdrama', 'k-drama', 'episode', 'season'],
  dating:       ['dating', 'couple', 'relationship', 'romantic', 'wedding', 'married', 'love'],
  military:     ['military', 'enlistment', 'discharge', 'service', 'army', 'enlisted', 'discharged'],
  award:        ['award', 'win', 'trophy', 'daesang', 'bonsang', 'grammy', 'mama', 'golden disc', 'melon'],
  controversy:  ['controversy', 'scandal', 'apologize', 'apology', 'accused', 'allegations', 'lawsuit', 'bullying'],
  mv:           ['mv', 'music video', 'teaser', 'm/v', 'visual', 'concept photo'],
  interview:    ['interview', 'exclusive', 'reveals', 'talks about', 'opens up'],
  photo:        ['photo', 'pictorial', 'magazine', 'photoshoot', 'selfie', 'selca', 'photobook', 'cover'],
  debut:        ['debut', 'launch', 'pre-debut', 'trainee', 'survival'],
  collab:       ['collaboration', 'collab', 'featuring', 'feat', 'team up', 'duet', 'joint'],
  fan:          ['fan', 'fandom', 'fanmeeting', 'fan meeting', 'lightstick', 'fanclub'],
  trending:     ['trending', 'viral', 'reaction', 'meme', 'goes viral', 'buzz'],
  health:       ['health', 'injury', 'hospital', 'recover', 'surgery', 'hiatus', 'rest'],
  contract:     ['contract', 'agency', 'sign', 'renewal', 'renew', 'leave', 'departure', 'new agency'],
  variety:      ['variety', 'show', 'tv', 'running man', 'knowing bros', 'weekly idol', 'guest'],
  performance:  ['cover', 'performance', 'dance practice', 'choreography', 'stage', 'perform'],
};

// ---- ONYX Title templates per topic — dark, editorial, high-fashion Japanese ----

const TITLE_TEMPLATES = {
  comeback: [
    '{artist}の新たなる覚醒 \u2014 カムバック全貌',
    '闇と光の間で \u2014 {artist}が描く新世界',
    '{artist}カムバック \u2014 美学の進化を読み解く',
    '静寂を破る{artist} \u2014 カムバックの衝撃',
    '{artist}、沈黙の先に待つ新章',
    '覚醒する{artist} \u2014 カムバックが示す方向性',
  ],
  chart: [
    '{artist}がチャートを支配する理由',
    '数字が証明する{artist}の存在感',
    '{artist} \u2014 チャートの頂点に立つ者たち',
    '{artist}の記録が語る、圧倒的実力',
  ],
  release: [
    '{artist}の最新作 \u2014 深淵から届く音',
    '音の建築家{artist} \u2014 新作を徹底解剖',
    '{artist}が刻む新たな音像 \u2014 アルバムレビュー',
    '暗闇に響く{artist}の最新作',
  ],
  concert: [
    '舞台の記憶 \u2014 {artist}ライブの全記録',
    '{artist}の圧巻ステージ \u2014 パフォーマンスの真髄',
    '一夜限りの奇跡 \u2014 {artist}コンサートレポート',
    '{artist}がステージで見せた、光と影の演出',
  ],
  fashion: [
    '{artist}のモード哲学 \u2014 スタイルの深層',
    'ランウェイを超えて \u2014 {artist}が纏うファッション',
    '{artist}\u00d7ハイブランド \u2014 美意識の邂逅',
    '{artist}の纏う闇 \u2014 ファッションの新境地',
  ],
  drama: [
    '{artist}が映す、もう一つの顔',
    '演技という名の変容 \u2014 {artist}のドラマ出演',
    '{artist}、スクリーンに宿る新たな存在感',
  ],
  award: [
    '頂点に立つ{artist} \u2014 アワードの舞台裏',
    '{artist}の栄光 \u2014 受賞の瞬間を切り取る',
    '{artist}が手にした栄冠 \u2014 その意味を問う',
  ],
  variety: [
    '{artist}の素顔 \u2014 カメラが捉えた瞬間',
    '知られざる{artist} \u2014 舞台裏の横顔',
    '{artist}が見せた意外な一面',
  ],
  trending: [
    '{artist}のSNSが映す今',
    'デジタルの中の{artist} \u2014 最新投稿まとめ',
    'なぜ今{artist}が話題なのか \u2014 ONYX分析',
  ],
  debut: [
    '新星{artist}の誕生 \u2014 デビューの衝撃',
    'ONYXが注目する新人{artist}',
    '闇夜に現れた新星 \u2014 {artist}デビュー考察',
  ],
  collab: [
    '{artist}\u00d7クリエイター \u2014 コラボの美学',
    '{artist}が選んだパートナーシップ',
    '交差する才能 \u2014 {artist}のコラボレーション',
  ],
  mv: [
    '{artist}の新MV \u2014 映像に宿る闇と美',
    '視覚の詩 \u2014 {artist}ミュージックビデオ解析',
    '{artist}のビジュアルワールドを紐解く',
  ],
  interview: [
    '{artist}が語る \u2014 沈黙の向こう側',
    '独占インタビュー:{artist}の本音',
    '{artist}の言葉 \u2014 ONYXが聞いた真実',
  ],
  photo: [
    '{artist}の最新ビジュアル \u2014 モノクロームの美学',
    '被写体としての{artist} \u2014 写真が語る存在感',
    '{artist}グラビア \u2014 レンズが捉えた一瞬',
  ],
  military: [
    '{artist}の兵役 \u2014 沈黙の時間を追う',
    '不在の{artist} \u2014 帰還への道程',
  ],
  dating: [
    '{artist}を巡る報道 \u2014 事実を静かに見つめる',
    '{artist}のプライベート \u2014 ONYXの視点から',
  ],
  controversy: [
    '{artist}を巡る議論 \u2014 冷静な視座から',
    '{artist}に関する報道 \u2014 ONYXが検証する',
  ],
  health: [
    '{artist}の健康状態 \u2014 最新報告',
    '{artist}に届く回復の祈り',
  ],
  contract: [
    '{artist}の新章 \u2014 契約と決断の裏側',
    '{artist}が選んだ次のステージ',
  ],
  fan: [
    '{artist}とファンの間に流れる時間',
    '{artist}のファンへの想い \u2014 その真摯な距離感',
  ],
  performance: [
    '{artist}のパフォーマンス \u2014 身体が語る言葉',
    '圧巻:{artist}のステージを検証する',
  ],
  general: [
    '{artist} \u2014 今、語るべきこと',
    '独占:{artist}の最新動向',
    '{artist}の現在地 \u2014 ONYXが追う',
    '{artist}に関する注目の最新情報',
    '{artist}の深層 \u2014 ONYX独自取材',
    'ONYX FOCUS:{artist}の最新情報',
    '{artist}を巡る最新事情 \u2014 編集部分析',
    '{artist}の今を追う \u2014 ONYX REPORT',
    '{artist}の軌跡と現在 \u2014 独占レポート',
    '{artist}に迫る \u2014 ONYXエディトリアル',
  ],
};

const NO_ARTIST_TEMPLATES = [
  'K-POPシーンの深層 \u2014 ONYXが読み解く今',
  '暗闇の中の輝き \u2014 最新K-POPニュース',
  'ONYX編集部が選ぶ、今週の注目トピック',
  '静かな革命 \u2014 K-POPの最前線レポート',
  'K-CULTUREの深淵から \u2014 ONYX最新レポート',
  '見逃せないK-POP動向 \u2014 ONYX編集部セレクト',
  'ダークサイドからの視点 \u2014 今週のK-POP',
  'K-POPの闇と光 \u2014 ONYX独自分析',
  '夜明け前のシーン \u2014 K-POPの新たな潮流',
  'ONYX独占 \u2014 K-POPの最深部から届く報告',
  '沈黙と轟音の間で \u2014 K-POPシーン最新動向',
  '黒い潮流 \u2014 ONYXが捉えたK-POPの今',
  'K-POPの裏側を照らす \u2014 ONYX独自視点',
  '深夜のニュースデスクから \u2014 ONYX速報',
  'モノクロームの真実 \u2014 K-POP最新レポート',
  'K-POPシーンの地殻変動 \u2014 ONYX考察',
  '漆黒のステージから \u2014 今週の注目トピック',
  'ONYX REPORT \u2014 K-POPの最前線を追う',
  '影の中の物語 \u2014 K-POPの深層を読む',
  'K-POPの断面 \u2014 ONYXが切り取る今週の核心',
  '静謐な衝撃 \u2014 K-POPシーンに走る波紋',
  'ONYX WEEKLY \u2014 K-POP界の注目すべき動き',
  '暗がりの美学 \u2014 K-POPニュース最前線',
  'K-POPの深淵に潜む真実 \u2014 ONYX独占分析',
  '夜のエディトリアル \u2014 K-POPシーン総括',
  'ONYX INSIGHT \u2014 K-POPの知られざる一面',
  'K-POPの鼓動 \u2014 ONYXが聴き取る最新シグナル',
  '暗転する舞台から \u2014 K-POP最新情報',
  'ONYX LENS \u2014 K-POPシーンを映す',
  'K-POPの影と輪郭 \u2014 ONYX編集部レポート',
];

// ---- Display categories for ONYX ----

const DISPLAY_CATEGORIES = {
  comeback: 'NEW MUSIC',
  chart: 'CHART',
  release: 'NEW MUSIC',
  concert: 'STAGE',
  fashion: 'STYLE',
  drama: 'CULTURE',
  award: 'AWARD',
  variety: 'CULTURE',
  trending: 'SNS',
  debut: 'DEBUT',
  collab: 'COLLAB',
  mv: 'EXCLUSIVE',
  interview: 'EXCLUSIVE',
  photo: 'EXCLUSIVE',
  military: 'CULTURE',
  dating: 'CULTURE',
  controversy: 'CULTURE',
  health: 'CULTURE',
  contract: 'CULTURE',
  fan: 'CULTURE',
  performance: 'STAGE',
  general: 'EXCLUSIVE',
};

// ---- Helper: pick random item from array ----

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ---- Step 1: Extract artist name from title ----

const COMMON_ENGLISH_WORDS = new Set([
  'the', 'a', 'an', 'this', 'that', 'these', 'here', 'why', 'how', 'what',
  'when', 'who', 'which', 'where', 'watch', 'check', 'best', 'top', 'new',
  'breaking', 'exclusive', 'official', 'first', 'latest', 'all', 'every',
  'open', 'just', 'more', 'most', 'some', 'many', 'after', 'before',
  'korean', 'kpop', 'k-pop', 'idol', 'idols', 'legendary', 'former',
  'young', 'old', 'big', 'small', 'great', 'good', 'bad', 'real',
  'full', 'final', 'last', 'next', 'other', 'another', 'each', 'both',
  'only', 'even', 'still', 'also', 'already', 'never', 'always', 'again',
  'now', 'then', 'today', 'week', 'weekly', 'daily', 'year', 'month',
  'thread', 'list', 'review', 'reviews', 'roundup', 'recap', 'guide',
  'report', 'reports', 'update', 'updates', 'news', 'story', 'stories',
  'song', 'songs', 'album', 'albums', 'track', 'tracks', 'single', 'singles',
  'music', 'video', 'drama', 'movie', 'show', 'shows', 'stage', 'live',
  'tour', 'concert', 'award', 'awards', 'chart', 'charts', 'record',
  'debut', 'comeback', 'release', 'releases', 'performance', 'cover',
  'photo', 'photos', 'fashion', 'style', 'beauty', 'look', 'looks',
  'will', 'can', 'could', 'would', 'should', 'may', 'might', 'must',
  'does', 'did', 'has', 'had', 'have', 'been', 'being', 'are', 'were',
  'get', 'gets', 'got', 'make', 'makes', 'made', 'take', 'takes', 'took',
  'give', 'gives', 'gave', 'come', 'comes', 'came', 'keep', 'keeps', 'kept',
  'let', 'say', 'says', 'said', 'see', 'sees', 'saw', 'know', 'knows',
  'think', 'think', 'find', 'finds', 'want', 'wants', 'tell', 'tells',
  'ask', 'asks', 'work', 'works', 'seem', 'seems', 'feel', 'feels',
  'try', 'tries', 'start', 'starts', 'need', 'needs', 'run', 'runs',
  'move', 'moves', 'play', 'plays', 'pay', 'pays', 'hear', 'hears',
  'during', 'about', 'with', 'from', 'into', 'over', 'under', 'between',
  'through', 'against', 'without', 'within', 'along', 'behind',
  'inside', 'outside', 'above', 'below', 'upon', 'onto', 'toward',
  'for', 'but', 'not', 'yet', 'nor', 'and', 'or', 'so',
  'while', 'since', 'until', 'unless', 'because', 'although', 'though',
  'if', 'than', 'whether', 'once', 'twice',
  'his', 'her', 'its', 'our', 'their', 'my', 'your',
  'he', 'she', 'it', 'we', 'they', 'you', 'me', 'him', 'us', 'them',
  'no', 'yes', 'not', 'don\'t', 'doesn\'t', 'didn\'t', 'won\'t', 'can\'t',
  'eight', 'five', 'four', 'nine', 'one', 'seven', 'six', 'ten', 'three', 'two',
  'up', 'down', 'out', 'off', 'on', 'in', 'at', 'to', 'by', 'of',
  'coming', 'going', 'looking', 'rising', 'star', 'stars',
  'spill', 'spills', 'choi', 'lee', 'kim', 'park', 'jung', 'shin',
  'won', 'young', 'min', 'sung', 'hyun', 'jae', 'hye',
]);

const SHORT_AMBIGUOUS_NAMES = new Set(['V', 'TOP', 'CL', 'JB', 'DK', 'Jun', 'Jay', 'Kai', 'Lay', 'Bom', 'Liz', 'Bae', 'Han', 'San', 'Rei', 'Lia']);

function extractArtist(title) {
  for (const name of ALL_KNOWN_NAMES) {
    if (SHORT_AMBIGUOUS_NAMES.has(name)) continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?:^|[\\s,;:'"(\\[])${escaped}(?=[\\s,;:'"')\\]!?.]|$)`, 'i');
    if (re.test(title)) {
      return name;
    }
  }

  for (const name of SHORT_AMBIGUOUS_NAMES) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?:^|[\\s,;:'"(\\[])${escaped}(?=[\\s,;:'"')\\]!?.]|$)`);
    if (re.test(title)) {
      const pos = title.indexOf(name);
      if (pos <= 5) {
        return name;
      }
    }
  }

  const leadingName = title.match(/^([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\b/);
  if (leadingName) {
    const candidate = leadingName[1];
    const words = candidate.split(/\s+/);
    const allWordsValid = words.every(w => !COMMON_ENGLISH_WORDS.has(w.toLowerCase()));
    if (allWordsValid && words.length >= 2 && words.length <= 4) {
      return candidate;
    }
  }

  return null;
}

// ---- Step 2: Classify topic ----

function classifyTopic(title) {
  const lower = title.toLowerCase();
  for (const [topic, keywords] of Object.entries(TOPIC_KEYWORDS)) {
    for (const kw of keywords) {
      if (lower.includes(kw)) {
        return topic;
      }
    }
  }
  return 'general';
}

// ---- Step 3 & 4: Generate Japanese title ----

function rewriteTitle(originalTitle, source) {
  if (/[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/.test(originalTitle)) {
    return originalTitle;
  }

  const artist = extractArtist(originalTitle);
  const topic = classifyTopic(originalTitle);

  if (artist) {
    const templates = TITLE_TEMPLATES[topic] || TITLE_TEMPLATES.general;
    const template = pickRandom(templates);
    return template.replace(/\{artist\}/g, artist);
  }

  return pickRandom(NO_ARTIST_TEMPLATES);
}

// ============================================================
// Image downloading
// ============================================================

const IMAGES_DIR = join(__dirname, 'images');
const ARTICLES_DIR = join(__dirname, 'articles');

async function downloadImage(url, filename) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Referer': new URL(url).origin,
      },
    });
    clearTimeout(timer);

    if (!res.ok || !res.body) return null;

    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('image')) return null;

    const ext = contentType.includes('png') ? '.png'
      : contentType.includes('webp') ? '.webp'
      : '.jpg';
    const localFile = `${filename}${ext}`;
    const localPath = join(IMAGES_DIR, localFile);

    const buffer = Buffer.from(await res.arrayBuffer());
    await writeFile(localPath, buffer);

    return `images/${localFile}`;
  } catch {
    return null;
  }
}

async function downloadArticleImages(articles) {
  await mkdir(IMAGES_DIR, { recursive: true });

  log('Downloading article images locally...');
  let downloaded = 0;
  const BATCH = 8;

  for (let i = 0; i < articles.length; i += BATCH) {
    const batch = articles.slice(i, i + BATCH);
    await Promise.allSettled(
      batch.map(async (article, idx) => {
        if (!article.image || article.image.includes('picsum.photos')) return;
        const safeName = `article-${i + idx}-${Date.now() % 100000}`;
        const localPath = await downloadImage(article.image, safeName);
        if (localPath) {
          article.originalImage = article.image;
          article.image = localPath;
          downloaded++;
        }
      })
    );
  }

  log(`  Downloaded ${downloaded}/${articles.length} images locally`);
}

// ============================================================
// Category mapping for ONYX
// ============================================================

function displayCategory(category) {
  const topic = classifyTopic(category || '');
  return DISPLAY_CATEGORIES[topic] || 'EXCLUSIVE';
}

function displayCategoryFromTopic(topic) {
  return DISPLAY_CATEGORIES[topic] || 'EXCLUSIVE';
}

// ============================================================
// RSS Feed Parsing
// ============================================================

function parseRssFeed(xml, sourceName) {
  const items = extractItems(xml);
  const articles = [];

  for (const item of items) {
    const title = decodeHtmlEntities(stripHtml(extractTag(item, 'title')));
    const link = extractTag(item, 'link');
    const pubDate = extractTag(item, 'pubDate');
    const creator = extractTag(item, 'dc:creator');
    const categories = extractAllTags(item, 'category').map(c => decodeHtmlEntities(stripHtml(c)));
    const category = categories[0] || 'News';
    const description = extractTag(item, 'description');
    const contentEncoded = extractTag(item, 'content:encoded');

    let image = extractImageFromContent(item);
    if (!image) {
      image = extractImageFromContent(contentEncoded);
    }
    if (!image) {
      image = extractImageFromContent(description);
    }

    if (!title || !link) continue;

    articles.push({
      title,
      link,
      pubDate: pubDate ? new Date(pubDate) : new Date(),
      formattedDate: formatDate(pubDate),
      creator,
      category,
      categories,
      image,
      source: sourceName,
      articleContent: null,
    });
  }

  return articles;
}

// ============================================================
// Fetch all feeds
// ============================================================

async function fetchAllFeeds() {
  const allArticles = [];

  for (const source of SOURCES) {
    try {
      log(`Fetching ${source.name}...`);
      const xml = await fetchWithTimeout(source.url);
      const articles = parseRssFeed(xml, source.name);
      log(`  ${source.name}: ${articles.length} articles`);
      allArticles.push(...articles);
    } catch (err) {
      warn(`Failed to fetch ${source.name}: ${err.message}`);
    }
  }

  allArticles.sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime());

  log(`Total: ${allArticles.length} articles`);
  return allArticles;
}

// ============================================================
// Fill missing images via og:image
// ============================================================

async function fillMissingImages(articles) {
  const needsImage = articles.filter(a => !a.image);
  if (needsImage.length === 0) return;

  const toFetch = needsImage.slice(0, MAX_OG_IMAGE_FETCHES);
  log(`Extracting og:image for ${toFetch.length} articles (concurrency: ${OG_IMAGE_CONCURRENCY})...`);

  let found = 0;
  for (let i = 0; i < toFetch.length; i += OG_IMAGE_CONCURRENCY) {
    const batch = toFetch.slice(i, i + OG_IMAGE_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (article) => {
        const ogImage = await fetchOgImage(article.link);
        if (ogImage) {
          article.image = ogImage;
          return true;
        }
        return false;
      })
    );
    found += results.filter(r => r.status === 'fulfilled' && r.value === true).length;
  }

  log(`  Found og:image for ${found}/${toFetch.length} articles`);
}

// ============================================================
// Fetch article content from original pages
// ============================================================

function extractArticleContent(html) {
  let cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<aside[\s\S]*?<\/aside>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<div[^>]*class\s*=\s*["'][^"']*(?:sidebar|comment|social|share|related|ad-|ads-|advertisement|cookie|popup|modal|newsletter)[^"']*["'][\s\S]*?<\/div>/gi, '');

  const articleBodyPatterns = [
    /<article[^>]*>([\s\S]*?)<\/article>/i,
    /<div[^>]*class\s*=\s*["'][^"']*(?:article-body|article-content|entry-content|post-content|story-body|content-body|single-content)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]*class\s*=\s*["'][^"']*(?:post-entry|article-text|body-text|main-content|article__body|post__content)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
  ];

  let bodyHtml = '';
  for (const pattern of articleBodyPatterns) {
    const match = cleaned.match(pattern);
    if (match) {
      bodyHtml = match[1];
      break;
    }
  }

  if (!bodyHtml) {
    bodyHtml = cleaned;
  }

  const paragraphs = [];
  const pRegex = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let pMatch;
  while ((pMatch = pRegex.exec(bodyHtml)) !== null) {
    const text = stripHtml(decodeHtmlEntities(pMatch[1])).trim();
    if (text.length > 30 &&
        !text.match(/^(advertisement|sponsored|also read|read more|related:|source:|photo:|credit:|getty|shutterstock|loading)/i)) {
      paragraphs.push(text);
    }
  }

  const images = [];
  const imgRegex = /<img[^>]+src\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let imgMatch;
  while ((imgMatch = imgRegex.exec(bodyHtml)) !== null) {
    const src = imgMatch[1];
    if (src && !src.includes('avatar') && !src.includes('icon') && !src.includes('logo') &&
        !src.includes('1x1') && !src.includes('pixel') && !src.includes('tracking')) {
      images.push(src);
    }
  }

  return { paragraphs, images };
}

async function fetchArticleContent(article) {
  try {
    const html = await fetchWithTimeout(article.link, ARTICLE_FETCH_TIMEOUT);
    const content = extractArticleContent(html);
    return content;
  } catch {
    return { paragraphs: [], images: [] };
  }
}

async function fetchAllArticleContent(articles) {
  const toFetch = articles.slice(0, 50);
  log(`Fetching full article content for ${toFetch.length} articles (concurrency: ${ARTICLE_FETCH_CONCURRENCY})...`);

  let fetched = 0;
  for (let i = 0; i < toFetch.length; i += ARTICLE_FETCH_CONCURRENCY) {
    const batch = toFetch.slice(i, i + ARTICLE_FETCH_CONCURRENCY);
    await Promise.allSettled(
      batch.map(async (article) => {
        const content = await fetchArticleContent(article);
        if (content.paragraphs.length > 0) {
          article.articleContent = content;
          fetched++;
        }
      })
    );
  }

  log(`  Fetched content for ${fetched}/${toFetch.length} articles`);
}

// ============================================================
// Article body rewriting — ONYX dark editorial tone
// ============================================================

const BODY_TEMPLATES = {
  comeback: {
    opening: [
      '{artist}のカムバックが告げられた瞬間、シーンに走った緊張感は確かなものだった。今回の帰還は、これまでの{artist}を知る者にとっても予想を超える挑戦になるだろう。静寂を打ち破るその一手に、業界の視線が集中している。',
      '暗転の後に現れたのは、より鋭く研ぎ澄まされた{artist}の姿だった。長い沈黙は、彼らの内側で何かが変容していたことを示している。新たな章の幕開けは、美しくも不穏な予感に満ちている。',
      '{artist}がカムバックを宣言した。言葉少なに放たれたティーザーの映像は、モノクロームの美学と不穏なサウンドスケープで構成され、前作からの明確な進化を予感させる。',
    ],
    analysis: [
      '音楽的なアプローチの変化は顕著だ。{artist}はプロダクションの深部にまで関与し、サウンドのテクスチャーひとつひとつに意志を込めている。表層的なトレンドへの迎合ではなく、自らの美学を追求する姿勢がここにある。',
      'ビジュアルディレクションもまた、{artist}の覚悟を物語る。コンセプトフォトに漂うダークな世界観は、ファッション誌のエディトリアルを思わせる完成度だ。光と影のコントラストが、{artist}の新たな顔を浮かび上がらせる。',
    ],
    closing: [
      '{artist}のカムバックがシーンに何を残すのか。ONYX編集部は、その全貌が明らかになるまで追跡を続ける。',
    ],
  },
  fashion: {
    opening: [
      '{artist}のファッションは、単なる衣装選びを超えた表現行為だ。ランウェイとストリートの境界を溶かし、自らの身体をキャンバスとして提示する。今回もまた、{artist}は服を通じて強烈なメッセージを放った。',
      'モードの世界において、{artist}の存在感は異質だ。K-POPアイドルという枠組みを逸脱し、ファッションそのものの文法を書き換えようとしている。ハイブランドが{artist}に注目する理由は、そこにある。',
    ],
    analysis: [
      '{artist}のスタイリングに共通するのは、ミニマリズムと大胆さの共存だ。シルエットの選択、素材感のコントラスト、アクセサリーの抑制されたセレクト。そのすべてが計算されていながら、着る者の身体性を消さない。ファッションディレクターが称賛するのも頷ける。',
      'ブランドとの関係性も興味深い。{artist}は単なるアンバサダーではなく、ブランドの文脈を自らの物語に取り込み、再解釈して見せる。着用アイテムが即完売する「{artist}効果」は、影響力の証明であると同時に、彼らのセンスに対する信頼の表れだ。',
    ],
    closing: [
      'ファッションという言語を操る{artist}の次の一手に、ONYX編集部は注視する。',
    ],
  },
  concert: {
    opening: [
      '照明が落ち、暗闇の中に{artist}のシルエットが浮かぶ。その瞬間、会場の空気が変わる。{artist}のライブは、音楽体験というよりもひとつの儀式に近い。身体の奥底に響く低音と、視覚を支配する演出が、観客の感覚を書き換えていく。',
      '{artist}がステージに立つ。それだけで空間が変容する。今回の公演もまた、パフォーマンスという概念の拡張を試みるものだった。',
    ],
    analysis: [
      'セットリストの構成は緻密だった。緊張と解放のリズムが巧みに設計され、観客は{artist}の世界に完全に没入する。特筆すべきは照明デザインとの一体感だ。楽曲のムードに合わせて変化する光の演出は、映像作品を観るような完成度だった。',
      'ダンスパフォーマンスの質は言うまでもない。しかし{artist}の真価は、技術的な完成度の先にある表現力にある。一つひとつの動きに込められた感情の密度は、観る者の記憶に深く刻まれる。',
    ],
    closing: [
      '{artist}のステージは、一度体験すれば忘れられないものになる。ONYX編集部は次なる公演も追い続ける。',
    ],
  },
  award: {
    opening: [
      '壇上に立つ{artist}の表情には、静かな感慨が宿っていた。喧騒の中にあって、その瞬間だけが凝縮された時間のように流れた。受賞という事実が持つ重みは、{artist}自身が最もよく理解しているだろう。',
      '{artist}が名誉ある賞を手にした。数字や評価の先にある、アーティストとしての信念が認められた瞬間だった。',
    ],
    analysis: [
      '今回の受賞を取り巻く文脈は重要だ。{artist}がこの賞にたどり着くまでの軌跡には、音楽的実験と商業的バランスの間で揺れた時期もあった。しかし妥協しなかったことが、結果的にこの評価につながっている。',
    ],
    closing: [
      '栄光の先に待つ次のステージ。{artist}がどこへ向かうのか、ONYX編集部は見届ける。',
    ],
  },
  general: {
    opening: [
      '{artist}を巡る最新の動向がONYX編集部の目に留まった。K-POPシーンが加速度的に変容する中、{artist}の選択は常に注目に値する。',
      '{artist}に関する新たな情報が浮上している。暗闘と飛躍が交錯するK-POPの世界において、{artist}の一挙手一投足は意味を持つ。',
      'シーンの最前線に立つ{artist}。その存在が放つ引力は、音楽の枠組みを超えて広がり続けている。今回もまた、注目すべき動きがあった。',
    ],
    analysis: [
      '{artist}の活動領域は拡大の一途を辿る。音楽、ファッション、映像表現。そのすべてにおいて自らの美学を投影する姿勢は、単なるマルチタレントという評価を超えている。{artist}が築きつつあるのは、独自のクリエイティブ帝国だ。',
      '業界関係者の評価は一致している。{artist}は現在のK-POPシーンにおいて、最も予測不可能で、最もクリエイティブなアーティストの一組だ。次の一手が常に期待を超えてくる。その不確実性こそが、{artist}の最大の武器だろう。',
      'データが示す{artist}の存在感は圧倒的だ。ストリーミング、SNSエンゲージメント、コンテンツ消費量。あらゆる指標が右肩上がりの軌道を描く中、{artist}の影響力はグローバルスケールで拡大している。',
    ],
    closing: [
      'ONYX編集部は{artist}の動向を引き続き追跡する。暗闇の中の光を見逃さない。',
      '{artist}の次なる一手に、ONYX編集部は注視する。',
    ],
  },
};

// Fallback to general for topics without specific ONYX body templates
for (const topic of Object.keys(TOPIC_KEYWORDS)) {
  if (!BODY_TEMPLATES[topic]) {
    BODY_TEMPLATES[topic] = BODY_TEMPLATES.general;
  }
}

const NO_ARTIST_BODY = {
  opening: [
    'K-POPシーンの深層から、新たな動きが浮上している。表層のトレンドでは捉えきれない、構造的な変化の兆しがそこにある。ONYX編集部がその核心に迫る。',
    'エンターテインメント業界の暗部と光芒。その境界線上で生まれる現象を、ONYX独自の視座から読み解く。',
    '静かに、しかし確実に。K-POPの地殻変動は続いている。ONYXが注目するこのトピックの背景には、見逃せない力学が働いている。',
  ],
  analysis: [
    'この動きの背景を読み解くには、K-POP産業の構造変化を理解する必要がある。デジタルプラットフォームの台頭、ファンカルチャーの成熟、グローバル市場の拡大。これらの要素が複雑に絡み合い、今日のシーンを形成している。',
    'データを精査すると、興味深いパターンが浮かび上がる。K-POPコンテンツの消費は量的拡大だけでなく、質的変容も遂げている。ファンは単なる受容者ではなく、コンテンツエコシステムの能動的な参加者として機能している。',
  ],
  closing: [
    'ONYX編集部は引き続き、K-POPシーンの深層を追跡する。表層では見えない真実を、ここから発信する。',
  ],
};

const SHARED_PARAGRAPHS = {
  background: [
    '{artist}の軌跡を振り返れば、そこには安住を拒否する精神が一貫して流れている。デビュー以来、{artist}は常に自らの音楽的アイデンティティを問い直し、更新し続けてきた。その姿勢こそが、シーンにおける唯一無二のポジションを確立した原動力だ。',
    'K-POPの世界地図において{artist}が占める座標は特異だ。主流の潮流に乗りながらも、決してその流れに埋没しない。自らの美学を核としながら、音楽的実験を恐れないその姿勢は、批評家たちからも高い評価を受けている。',
    '{artist}の歩みは、K-POPの可能性の拡張そのものだった。ジャンルの境界を溶かし、表現の限界を押し広げ、ファンとの関係性を再定義する。{artist}が示すのは、アーティストという存在の新たな形だ。',
    'グローバルK-POPシーンにおいて、{artist}のプレゼンスは年を追うごとに増幅している。各国の音楽チャート、SNSのエンゲージメント率、コンサート動員数。あらゆる数字が、{artist}の影響力の拡大を裏付けている。',
  ],
  detail: [
    '関係者への取材を総合すると、{artist}は今回のプロジェクトに対して入念な準備を重ねてきたことが浮かび上がる。細部への執着、妥協のない姿勢。それが結果の密度に直結している。',
    'SNSの動向を分析すると、{artist}に関する言及は直近で急激な増加を見せている。特にビジュアルコンテンツへの反応は顕著で、ファンが自発的に生成するリアクション動画やファンアートが二次的な話題の波を生んでいる。',
    '{artist}の今回の動きは、K-POP産業全体のトレンドとも共鳴している。アーティスト主導のクリエイティブディレクション、グローバルファンベースへの直接的アプローチ、デジタルファーストの戦略。これらの要素が、{artist}の活動を下支えしている。',
    '音楽評論家たちが{artist}の作品を評価する際、繰り返し指摘されるのはキャッチーさと深みの両立だ。初聴でのインパクトと、聴き込むほどに発見がある構造。この二重性が、{artist}のクリエイティブの核を成している。',
  ],
  reaction: [
    'ファンコミュニティの反応は熱烈だ。「待っていた甲斐があった」「期待を遥かに超えた」という声が大多数を占める中、{artist}への信頼の深さが改めて可視化された。一部のファンは感動のあまり涙したと投稿している。',
    '日本のファンコミュニティでは特に大きな反響が見られる。日本語のファンアカウントでは詳細な情報共有と考察が活発に行われ、{artist}への愛情が溢れる投稿がタイムラインを埋め尽くしている。日本公演を望む声もさらに高まっている。',
    '海外ファンの反応も見逃せない。英語圏、東南アジア、中南米。世界各地のファンがSNSを通じて{artist}への支持を表明し、グローバルファンダムの結束力の強さを改めて示した。',
  ],
  impact: [
    '今回の{artist}の動きが持つインパクトは、個別のニュースを超えた次元にある。{artist}が示す方向性は、K-POPの未来を予見するものだ。後続のアーティストたちにとっても、参照すべきモデルケースとなるだろう。',
    '文化産業のアナリストたちは、{artist}の今回の活動がK-POP市場全体に波及効果を与えると見ている。{artist}のアプローチが業界のスタンダードを更新する可能性は、決して小さくない。',
  ],
  noArtist: {
    background: [
      'K-POPの世界は急速に変貌を遂げている。かつてのニッチなジャンルは、今やグローバル音楽産業の主要な柱の一つとなった。年間数十億ドル規模の市場を動かすこのジャンルの深層には、独自の生態系が形成されている。',
      'デジタル技術の進化と、ファンカルチャーの成熟。この二つの潮流がK-POPの現在の姿を形作っている。アーティストとファンの距離が限りなく縮まる中、コンテンツの生産と消費のあり方も根本的に変わりつつある。',
    ],
    detail: [
      'この現象を俯瞰すると、K-POPエコシステムの精緻さが見えてくる。アーティスト、プロデューサー、マネジメント、ファンコミュニティ。これらの要素が有機的に連携し、コンテンツの価値を最大化する仕組みが確立されている。',
      'ファンカルチャーの進化は特筆に値する。現代のK-POPファンは、翻訳、宣伝、分析を自発的に担い、アーティストの認知拡大に貢献するエコシステムの重要な構成要素だ。この現象はK-POP独自のものであり、他のジャンルには見られない特異性を持つ。',
    ],
    reaction: [
      'オンライン上の反応は活発だ。K-POPファンコミュニティでは、様々な角度からの分析と考察が交わされている。ファン同士の建設的な議論の密度が高いことは、このコミュニティの成熟度を物語っている。',
    ],
    impact: [
      '文化産業としてのK-POPの意義は、エンターテインメントの枠を超えて広がっている。国境を越えて人々をつなぐ力。言語の壁を溶かすコンテンツの力。K-POPはその最前線に立つジャンルだ。',
    ],
  }
};

function rewriteArticleBody(articleContent, title) {
  const artist = extractArtist(title) || (articleContent ? extractArtistFromParagraphs(articleContent.paragraphs) : null);
  const topic = classifyTopic(title);

  const originalLength = articleContent?.paragraphs?.length || 0;
  const targetParagraphs = Math.max(8, Math.min(12, originalLength || 8));

  const inlineImages = (articleContent?.images || []).slice(1, 4);

  const paragraphs = [];
  const usedTexts = new Set();
  const pickUnique = (arr) => {
    const available = arr.filter(t => !usedTexts.has(t));
    if (available.length === 0) return arr[Math.floor(Math.random() * arr.length)];
    const picked = available[Math.floor(Math.random() * available.length)];
    usedTexts.add(picked);
    return picked;
  };
  const shuffleAndPickUnique = (arr, n) => {
    const available = arr.filter(t => !usedTexts.has(t));
    const shuffled = [...available].sort(() => Math.random() - 0.5);
    const picked = shuffled.slice(0, Math.min(n, shuffled.length));
    for (const p of picked) usedTexts.add(p);
    return picked;
  };

  if (artist) {
    const templates = BODY_TEMPLATES[topic] || BODY_TEMPLATES.general;
    const sub = (text) => text.replace(/\{artist\}/g, artist);

    paragraphs.push({ type: 'intro', text: sub(pickUnique(templates.opening)) });

    const bgCount = targetParagraphs >= 10 ? 2 : 1;
    for (const bg of shuffleAndPickUnique(SHARED_PARAGRAPHS.background, bgCount)) {
      paragraphs.push({ type: 'body', text: sub(bg) });
    }

    const analysisCount = targetParagraphs >= 10 ? 2 : 2;
    for (const a of shuffleAndPickUnique(templates.analysis, analysisCount)) {
      paragraphs.push({ type: 'body', text: sub(a) });
    }

    if (inlineImages.length > 0) {
      paragraphs.push({ type: 'image', src: inlineImages[0] });
    }

    const detailCount = targetParagraphs >= 10 ? 2 : 1;
    for (const d of shuffleAndPickUnique(SHARED_PARAGRAPHS.detail, detailCount)) {
      paragraphs.push({ type: 'body', text: sub(d) });
    }

    const reactionCount = targetParagraphs >= 10 ? 2 : 1;
    for (const r of shuffleAndPickUnique(SHARED_PARAGRAPHS.reaction, reactionCount)) {
      paragraphs.push({ type: 'body', text: sub(r) });
    }

    if (inlineImages.length > 1) {
      paragraphs.push({ type: 'image', src: inlineImages[1] });
    }

    paragraphs.push({ type: 'body', text: sub(pickUnique(SHARED_PARAGRAPHS.impact)) });
    paragraphs.push({ type: 'closing', text: sub(pickUnique(templates.closing)) });

  } else {
    paragraphs.push({ type: 'intro', text: pickUnique(NO_ARTIST_BODY.opening) });

    for (const bg of shuffleAndPickUnique(SHARED_PARAGRAPHS.noArtist.background, 2)) {
      paragraphs.push({ type: 'body', text: bg });
    }

    for (const a of shuffleAndPickUnique(NO_ARTIST_BODY.analysis, 2)) {
      paragraphs.push({ type: 'body', text: a });
    }

    if (inlineImages.length > 0) {
      paragraphs.push({ type: 'image', src: inlineImages[0] });
    }

    for (const d of shuffleAndPickUnique(SHARED_PARAGRAPHS.noArtist.detail, 2)) {
      paragraphs.push({ type: 'body', text: d });
    }

    for (const r of shuffleAndPickUnique(SHARED_PARAGRAPHS.noArtist.reaction, 1)) {
      paragraphs.push({ type: 'body', text: r });
    }

    if (inlineImages.length > 1) {
      paragraphs.push({ type: 'image', src: inlineImages[1] });
    }

    paragraphs.push({ type: 'body', text: pickUnique(SHARED_PARAGRAPHS.noArtist.impact) });
    paragraphs.push({ type: 'closing', text: pickUnique(NO_ARTIST_BODY.closing) });
  }

  return { paragraphs };
}

function extractArtistFromParagraphs(paragraphs) {
  if (!paragraphs || paragraphs.length === 0) return null;
  const sample = paragraphs.slice(0, 3).join(' ');
  return extractArtist(sample);
}

function shuffleAndPick(arr, n) {
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.min(n, shuffled.length));
}

// ============================================================
// HTML escaping
// ============================================================

function escapeHtml(str) {
  return (str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ============================================================
// Image tag helpers
// ============================================================

function imgTag(article, width, height, loading = 'lazy') {
  const src = escapeHtml(article.image || PLACEHOLDER_IMAGE);
  const fallback = `https://picsum.photos/seed/${encodeURIComponent(article.title.slice(0, 20))}/${width}/${height}`;
  return `<img src="${src}" alt="${escapeHtml(article.title)}" width="${width}" height="${height}" loading="${loading}" referrerpolicy="no-referrer" data-fallback="${escapeHtml(fallback)}" onerror="if(!this.dataset.failed){this.dataset.failed='1';this.src=this.dataset.fallback}">`;
}

function imgTagForArticle(article, width, height, loading = 'lazy') {
  let src = article.image || PLACEHOLDER_IMAGE;
  if (src.startsWith('images/')) {
    src = '../' + src;
  }
  const escapedSrc = escapeHtml(src);
  const fallback = `https://picsum.photos/seed/${encodeURIComponent(article.title.slice(0, 20))}/${width}/${height}`;
  return `<img src="${escapedSrc}" alt="${escapeHtml(article.title)}" width="${width}" height="${height}" loading="${loading}" referrerpolicy="no-referrer" data-fallback="${escapeHtml(fallback)}" onerror="if(!this.dataset.failed){this.dataset.failed='1';this.src=this.dataset.fallback}">`;
}

// ============================================================
// ONYX Section generators
// ============================================================

function generateExclusiveCard(article) {
  if (!article) return '';
  const topic = classifyTopic(article.originalTitle || article.title);
  const cat = displayCategoryFromTopic(topic);
  return `<a href="${escapeHtml(article.localUrl)}" class="exclusive-card">
          <div class="card-image">
            ${imgTag(article, 600, 800)}
          </div>
          <div class="card-overlay">
            <span class="card-category">${escapeHtml(cat)}</span>
            <h3 class="card-title">${escapeHtml(article.title)}</h3>
            <span class="card-date">${escapeHtml(article.formattedDate)}</span>
            <span class="card-source">${escapeHtml(article.source)}</span>
          </div>
        </a>`;
}

function generateLatestCard(article) {
  if (!article) return '';
  const topic = classifyTopic(article.originalTitle || article.title);
  const cat = displayCategoryFromTopic(topic);
  return `<a href="${escapeHtml(article.localUrl)}" class="latest-item">
          <div class="item-image">
            ${imgTag(article, 200, 125)}
          </div>
          <div class="item-content">
            <span class="item-category">${escapeHtml(cat)}</span>
            <h3 class="item-title">${escapeHtml(article.title)}</h3>
            <span class="item-date">${escapeHtml(article.formattedDate)}</span>
            <span class="item-source">${escapeHtml(article.source)}</span>
          </div>
        </a>`;
}

function generateStyleCard(article) {
  if (!article) return '';
  const topic = classifyTopic(article.originalTitle || article.title);
  const cat = displayCategoryFromTopic(topic);
  return `<a href="${escapeHtml(article.localUrl)}" class="style-card">
          <div class="card-image">
            ${imgTag(article, 560, 700)}
          </div>
          <div class="card-body">
            <span class="card-category">${escapeHtml(cat)}</span>
            <h3 class="card-title">${escapeHtml(article.title)}</h3>
            <span class="card-date">${escapeHtml(article.formattedDate)}</span>
            <span class="card-source">${escapeHtml(article.source)}</span>
          </div>
        </a>`;
}

function generateArchiveItem(article, num) {
  if (!article) return '';
  return `<a href="${escapeHtml(article.localUrl)}" class="archive-item">
          <span class="archive-num">${String(num).padStart(2, '0')}</span>
          <div class="archive-content">
            <span class="archive-title">${escapeHtml(article.title)}</span>
            <span class="archive-meta">${escapeHtml(article.formattedDate)} / ${escapeHtml(article.source)}</span>
          </div>
        </a>`;
}

// ============================================================
// Backdate articles — Jan 1 to Mar 22, 2026
// ============================================================

function backdateArticles(articles) {
  const startDate = new Date(2026, 0, 1); // Jan 1, 2026
  const endDate = new Date(2026, 2, 22);  // Mar 22, 2026
  const range = endDate.getTime() - startDate.getTime();

  for (const article of articles) {
    const randomOffset = Math.random() * range;
    const newDate = new Date(startDate.getTime() + randomOffset);
    article.pubDate = newDate;
    article.formattedDate = `${newDate.getFullYear()}年${newDate.getMonth() + 1}月${newDate.getDate()}日`;
  }

  // Re-sort by date descending
  articles.sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime());
}

// ============================================================
// Generate article HTML pages
// ============================================================

async function generateArticlePages(allArticles, usedArticles) {
  await mkdir(ARTICLES_DIR, { recursive: true });

  const templatePath = join(__dirname, 'article-template.html');
  const articleTemplate = await readFile(templatePath, 'utf-8');

  log(`Generating ${usedArticles.length} article pages...`);

  for (let i = 0; i < usedArticles.length; i++) {
    const filename = `article-${String(i + 1).padStart(3, '0')}.html`;
    usedArticles[i].localUrl = `articles/${filename}`;
  }

  let generated = 0;

  for (let i = 0; i < usedArticles.length; i++) {
    const article = usedArticles[i];
    const filename = `article-${String(i + 1).padStart(3, '0')}.html`;

    const related = allArticles
      .filter(a => a !== article && a.image && a.localUrl)
      .slice(0, 20)
      .sort(() => Math.random() - 0.5)
      .slice(0, 3);

    const bodyData = rewriteArticleBody(article.articleContent, article.title);

    let bodyHtml = '';
    for (const item of bodyData.paragraphs) {
      if (item.type === 'intro') {
        bodyHtml += `<div class="editorial-intro">${escapeHtml(item.text)}</div>\n`;
      } else if (item.type === 'closing') {
        bodyHtml += `        <div class="editorial-closing">${escapeHtml(item.text)}</div>`;
      } else if (item.type === 'image') {
        const imgSrc = item.src.startsWith('http') ? item.src : item.src;
        const fallback = `https://picsum.photos/seed/inline-${Math.random().toString(36).slice(2,8)}/760/428`;
        bodyHtml += `        <figure class="article-inline-image">
          <img src="${escapeHtml(imgSrc)}" alt="" width="760" height="428" loading="lazy" decoding="async" referrerpolicy="no-referrer" data-fallback="${escapeHtml(fallback)}" onerror="if(!this.dataset.failed){this.dataset.failed='1';this.src=this.dataset.fallback}">
        </figure>\n`;
      } else {
        bodyHtml += `        <p>${escapeHtml(item.text)}</p>\n`;
      }
    }

    let heroImgSrc = article.image || PLACEHOLDER_IMAGE;
    if (heroImgSrc.startsWith('images/')) {
      heroImgSrc = '../' + heroImgSrc;
    }
    const heroFallback = `https://picsum.photos/seed/${encodeURIComponent(article.title.slice(0, 20))}/800/450`;
    const heroImg = `<img src="${escapeHtml(heroImgSrc)}" alt="${escapeHtml(article.title)}" width="760" height="428" loading="eager" referrerpolicy="no-referrer" data-fallback="${escapeHtml(heroFallback)}" onerror="if(!this.dataset.failed){this.dataset.failed='1';this.src=this.dataset.fallback}">`;

    let relatedHtml = '';
    for (const rel of related) {
      const relUrl = `../${rel.localUrl}`;
      let relImgSrc = rel.image || PLACEHOLDER_IMAGE;
      if (relImgSrc.startsWith('images/')) {
        relImgSrc = '../' + relImgSrc;
      }
      const relFallback = `https://picsum.photos/seed/${encodeURIComponent(rel.title.slice(0, 20))}/400/225`;
      const relTopic = classifyTopic(rel.originalTitle || rel.title);
      relatedHtml += `
          <a href="${escapeHtml(relUrl)}" class="related-card">
            <div class="thumb">
              <img src="${escapeHtml(relImgSrc)}" alt="${escapeHtml(rel.title)}" width="400" height="225" loading="lazy" referrerpolicy="no-referrer" data-fallback="${escapeHtml(relFallback)}" onerror="if(!this.dataset.failed){this.dataset.failed='1';this.src=this.dataset.fallback}">
            </div>
            <div class="related-category">${escapeHtml(displayCategoryFromTopic(relTopic))}</div>
            <h3>${escapeHtml(rel.title)}</h3>
            <span class="date">${escapeHtml(rel.formattedDate)}</span>
          </a>`;
    }

    const sourceAttribution = `<div class="source-attribution">
          出典: <a href="${escapeHtml(article.link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(article.source)}</a>
          <br><a href="${escapeHtml(article.link)}" target="_blank" rel="noopener noreferrer" class="read-original">元記事を読む &rarr;</a>
        </div>`;

    const photoCredit = `写真: &copy;${escapeHtml(article.source)}`;

    const topic = classifyTopic(article.originalTitle || article.title);
    const cat = displayCategoryFromTopic(topic);

    let html = articleTemplate
      .replace(/\{\{ARTICLE_TITLE\}\}/g, escapeHtml(article.title))
      .replace('{{ARTICLE_DESCRIPTION}}', escapeHtml(article.title).slice(0, 160))
      .replace('{{ARTICLE_IMAGE}}', escapeHtml(heroImgSrc))
      .replace('{{ARTICLE_CATEGORY}}', escapeHtml(cat))
      .replace('{{ARTICLE_DATE}}', escapeHtml(article.formattedDate))
      .replace('{{ARTICLE_HERO_IMAGE}}', heroImg)
      .replace('{{ARTICLE_BODY}}', bodyHtml)
      .replace('{{SOURCE_ATTRIBUTION}}', sourceAttribution)
      .replace('{{PHOTO_CREDIT}}', photoCredit)
      .replace('{{RELATED_ARTICLES}}', relatedHtml);

    const outputPath = join(ARTICLES_DIR, filename);
    await writeFile(outputPath, html, 'utf-8');
    generated++;
  }

  log(`  Generated ${generated} article pages`);
}

// ============================================================
// Assign articles to sections — ONYX layout
// hero: 1, exclusive: 4, latest: 5, style: 4, archive: 4
// ============================================================

const HERO_OFFSET = 6;

function assignSections(articles) {
  let placeholderIdx = 0;
  for (const article of articles) {
    if (!article.image) {
      placeholderIdx++;
      article.image = `https://picsum.photos/seed/onyx-${placeholderIdx}-${Date.now() % 10000}/800/450`;
      article.hasPlaceholder = true;
    }
  }

  const withRealImages = articles.filter(a => !a.hasPlaceholder);
  const all = [...articles];
  const used = new Set();

  const take = (pool, count) => {
    const result = [];
    for (const article of pool) {
      if (result.length >= count) break;
      if (!used.has(article.link)) {
        result.push(article);
        used.add(article.link);
      }
    }
    return result;
  };

  const heroCandidates = withRealImages.length >= 2 ? withRealImages : all;
  const heroSkipped = heroCandidates.slice(HERO_OFFSET);
  const hero = take(heroSkipped.length ? heroSkipped : heroCandidates, 1);
  const exclusive = take(withRealImages.length >= 6 ? withRealImages : all, 4);
  const latest = take(all, 5);
  const style = take(withRealImages.length >= 10 ? withRealImages : all, 4);
  const archive = take(all, 4);

  return {
    hero: hero[0] || null,
    exclusive,
    latest,
    style,
    archive,
  };
}

// ============================================================
// Generate index HTML
// ============================================================

async function generateHtml(sections) {
  const templatePath = join(__dirname, 'template.html');
  let template = await readFile(templatePath, 'utf-8');

  // Hero
  if (sections.hero) {
    const heroArticle = sections.hero;
    const heroImgSrc = escapeHtml(heroArticle.image || PLACEHOLDER_IMAGE);
    const heroFallback = `https://picsum.photos/seed/${encodeURIComponent(heroArticle.title.slice(0, 20))}/1400/800`;
    const heroImage = `<img src="${heroImgSrc}" alt="${escapeHtml(heroArticle.title)}" width="1400" height="800" loading="eager" referrerpolicy="no-referrer" data-fallback="${escapeHtml(heroFallback)}" onerror="if(!this.dataset.failed){this.dataset.failed='1';this.src=this.dataset.fallback}">`;

    const topic = classifyTopic(heroArticle.originalTitle || heroArticle.title);
    const cat = displayCategoryFromTopic(topic);

    template = template.replace('{{HERO_IMAGE}}', heroImage);
    template = template.replace('{{HERO_TITLE}}', escapeHtml(heroArticle.title));
    template = template.replace('{{HERO_CATEGORY}}', escapeHtml(cat));
    template = template.replace('{{HERO_DATE}}', escapeHtml(heroArticle.formattedDate));
    template = template.replace('{{HERO_SOURCE}}', escapeHtml(heroArticle.source));

    // Wrap hero section with link
    template = template.replace(
      '<section class="hero-section">',
      `<a href="${escapeHtml(heroArticle.localUrl)}" style="text-decoration:none;color:inherit;display:block"><section class="hero-section">`
    );
    template = template.replace(
      '</section>\n\n  <!-- ===== EXCLUSIVE',
      '</section></a>\n\n  <!-- ===== EXCLUSIVE'
    );
  } else {
    template = template.replace('{{HERO_IMAGE}}', '');
    template = template.replace('{{HERO_TITLE}}', 'ONYX');
    template = template.replace('{{HERO_CATEGORY}}', 'EDITORIAL');
    template = template.replace('{{HERO_DATE}}', '');
    template = template.replace('{{HERO_SOURCE}}', '');
  }

  // Exclusive
  template = template.replace(
    '{{EXCLUSIVE_ITEMS}}',
    sections.exclusive.map(a => generateExclusiveCard(a)).join('\n        ')
  );

  // Latest
  template = template.replace(
    '{{LATEST_ARTICLES}}',
    sections.latest.map(a => generateLatestCard(a)).join('\n        ')
  );

  // Style
  template = template.replace(
    '{{STYLE_ITEMS}}',
    sections.style.map(a => generateStyleCard(a)).join('\n        ')
  );

  // Archive
  template = template.replace(
    '{{ARCHIVE_ITEMS}}',
    sections.archive.map((a, i) => generateArchiveItem(a, i + 1)).join('\n        ')
  );

  return template;
}

// ============================================================
// Main
// ============================================================

async function main() {
  log('Starting ONYX Magazine RSS Crawler...');
  log('Dark luxury K-POP boy group editorial');
  log('');

  // 1. Fetch all RSS feeds
  const articles = await fetchAllFeeds();
  if (articles.length === 0) {
    warn('No articles fetched. Aborting.');
    process.exit(1);
  }
  log('');

  // 2. Fill missing images via og:image
  await fillMissingImages(articles);
  log('');

  // 3. Rewrite ALL titles to ONYX editorial Japanese (with deduplication)
  log('Rewriting titles to ONYX dark editorial style...');
  let rewritten = 0;
  const usedTitles = new Set();
  for (const article of articles) {
    const original = article.title;
    article.originalTitle = original;
    let newTitle = rewriteTitle(original, article.source);
    // Deduplication: if title already used, try up to 10 times for a unique one
    let attempts = 0;
    while (usedTitles.has(newTitle) && attempts < 10) {
      newTitle = rewriteTitle(original, article.source);
      attempts++;
    }
    // If still duplicate after 10 attempts, append a suffix
    if (usedTitles.has(newTitle)) {
      const suffixes = ['（続報）', '（深層分析）', '（ONYX独占）', '（詳報）', '（最新）', '（考察）', '（速報）', '（検証）'];
      newTitle = newTitle + suffixes[Math.floor(Math.random() * suffixes.length)];
    }
    usedTitles.add(newTitle);
    article.title = newTitle;
    if (article.title !== original) rewritten++;
  }
  log(`  Rewritten ${rewritten}/${articles.length} titles (${usedTitles.size} unique)`);
  log('');

  // 4. Backdate articles to Jan 1 - Mar 22, 2026
  log('Backdating articles to 2026/01/01 - 2026/03/22...');
  backdateArticles(articles);
  log('  Done');
  log('');

  // 5. Assign articles to sections
  const sections = assignSections(articles);

  // Collect all used articles for article page generation
  const usedArticles = [];
  const usedSet = new Set();
  const addUsed = (arr) => {
    for (const a of arr) {
      if (a && !usedSet.has(a.link)) {
        usedArticles.push(a);
        usedSet.add(a.link);
      }
    }
  };
  if (sections.hero) addUsed([sections.hero]);
  addUsed(sections.exclusive);
  addUsed(sections.latest);
  addUsed(sections.style);
  addUsed(sections.archive);

  // 6. Download images locally
  const withImages = articles.filter(a => a.image).length;
  log(`Articles with images: ${withImages}/${articles.length}`);
  await downloadArticleImages(usedArticles);
  log('');

  // 7. Fetch full article content for used articles
  await fetchAllArticleContent(usedArticles);
  log('');

  // 8. Generate individual article pages
  await generateArticlePages(articles, usedArticles);
  log('');

  // 9. Generate index HTML from template
  const html = await generateHtml(sections);

  // 10. Write index output
  const outputPath = join(__dirname, 'index.html');
  await writeFile(outputPath, html, 'utf-8');

  const totalUsed =
    (sections.hero ? 1 : 0) +
    sections.exclusive.length +
    sections.latest.length +
    sections.style.length +
    sections.archive.length;

  log(`Generated index.html with ${totalUsed} articles`);
  log(`Generated ${usedArticles.length} article pages in articles/`);
  log(`Done! Open: file://${outputPath}`);
}

main().catch((err) => {
  console.error('[ONYX Crawler] Fatal error:', err);
  process.exit(1);
});
