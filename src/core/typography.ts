import type { PageSample } from './types';

/**
 * 字号聚类的相对容差。
 *
 * 字号是一维量，不需要像颜色那样转到感知空间算距离，相对差就够。
 * 0.05 这个值来自设计系统里字号步进的常识：主流阶梯相邻两级大约差
 * 1.125 到 1.333 倍，也就是 12.5% 到 33%，最小的真实步进也远在 5% 以上；
 * 而同一个字号在页面上的不同写法（rem 折算、百分比、em 继承）常见偏差
 * 在 1% 以内，最大的也到不了 5%。所以 5% 落在一条很宽的空档里。
 *
 * 调这个值之前先想清楚要往哪边偏：
 *   调大 → 层级更少更整齐，但 14px 和 15px 这种真实相邻级会被吞成一个
 *   调小 → 保住每一级，但 rem 折算出的小数偏差会让同一个字号裂成两条
 *
 * 这里用 leader 聚类而不是把相邻值连起来。连起来会有链式传播的问题，
 * 12 接 13、13 接 14 一路接下去，最后 12 到 18 全挤进同一簇，
 * 层级就全没了。leader 聚类只跟簇心比，不会连成一条链。
 */
export const SIZE_MERGE_RATIO = 0.05;

/** 一个字号至少要承载这么多字符，才有资格单独占一级 */
export const MIN_STEP_CHARS = 12;

/** 层级最多输出多少级。超出的按承载文字量从少到多砍掉 */
export const MAX_STEPS = 8;

/** 达到正文的这个倍数，判定为标题级 */
const HEADING_RATIO = 1.15;

/** 低于正文的这个倍数，判定为辅助文字 */
const CAPTION_RATIO = 0.92;

/** 等宽字符占比达到这个值，这一级判定为代码字体 */
const MONO_SHARE = 0.6;

/** 一个字体族至少要承载这么多字符，才值得单独输出并给替代建议 */
const MIN_FAMILY_CHARS = 8;

/** 页面直接文字少于这么多字时，层级判断要打折扣，必须告知使用者 */
const THIN_TEXT_CHARS = 100;

/** 每级最多列出几个字重 */
const MAX_WEIGHTS = 3;

// ---------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------

/** 字体族在这台机器上是否存在的判断结果 */
export type FontOrigin =
  /** 页面用 @font-face 或 FontFace API 注册的，别人机器上不保证有 */
  | 'font-face'
  /** 命中常见系统预装名单，本地基本都有 */
  | 'system'
  /** 两者都不是，无法确定，需要提示 */
  | 'unknown';

export type GenericFamily = 'sans-serif' | 'serif' | 'monospace';

/** 一个字号层级在页面里承担的排版角色 */
export type TypeRole = 'heading' | 'body' | 'caption' | 'code' | 'ui';

export const ROLE_LABEL: Record<TypeRole, string> = {
  heading: '标题',
  body: '正文',
  caption: '辅助文字',
  code: '代码',
  ui: '界面文字',
};

export interface FontFamilyStat {
  /** 归一化后的族名，去掉引号和多余空白 */
  name: string;
  origin: FontOrigin;
  generic: GenericFamily;
  /** 用这个字体渲染的字符数 */
  chars: number;
  elementCount: number;
  /** 承担的角色，按承载的字符量降序 */
  roles: TypeRole[];
  /** 该字体用到的字号，px，升序 */
  sizes: number[];
  /** 是不是承载全页文字最多的那一个 */
  isPrimary: boolean;
}

export interface TypeStep {
  /** 字号，px */
  size: number;
  /**
   * 这一级实际覆盖的全部原始字号，升序，含 size 本身。
   *
   * size 是簇的代表值，而 5% 容差的聚类会把 15.9 和 16 收到一起。
   * 溯源高亮要按 sizes 去认元素，只按 size 认会漏掉簇里的其余写法。
   */
  sizes: number[];
  role: TypeRole;
  /** 中文角色名，用在界面和说明文案里 */
  label: string;
  chars: number;
  elementCount: number;
  /** 这一级用到的字重，按使用量降序，最多三个 */
  weights: number[];
  /** 这一级的主流行高，px。整级都是 normal 时为 null */
  lineHeight: number | null;
  /** 行高与字号之比，两位小数。行高为 normal 时为 null */
  lineHeightRatio: number | null;
  /** 这一级的字间距，px。整级都是 normal 时为 null */
  letterSpacing: number | null;
  /** 这一级用到的字体族，按承载字符量降序 */
  families: string[];
  /** 这一级实际落在哪些标题标签上，例如 [1]，非标题为空数组 */
  headingLevels: number[];
  /** 用途说明，会直接写进生成的文件 */
  usage: string;
  confidence: 'high' | 'medium' | 'low';
}

export interface DiscardedStep {
  size: number;
  /** 被判为一次性数值的这一簇覆盖的全部原始字号，含义同 TypeStep.sizes */
  sizes: number[];
  chars: number;
  elementCount: number;
  reason: string;
}

export interface FontFallbackAdvice {
  family: string;
  origin: FontOrigin;
  generic: GenericFamily;
  /** 替代字体，按优先级排列 */
  suggested: string[];
  /** 可直接粘贴的完整 font-family 栈，已把原主族替换成首选替代 */
  stack: string;
  reason: string;
}

export type TypographyNoteKind =
  | 'same-family'
  | 'split-family'
  | 'webfont'
  | 'no-explicit-line-height'
  | 'mono-body'
  | 'thin-text';

export interface TypographyNote {
  kind: TypographyNoteKind;
  text: string;
}

export interface TypographyAnalysis {
  families: FontFamilyStat[];
  /** 字号阶梯，按字号从大到小 */
  steps: TypeStep[];
  /** 正文基准字号，px */
  bodySize: number | null;
  /** 页面用到的等宽字体族名 */
  monoFamilies: string[];
  /** 判定为一次性数值、没有立为层级的字号 */
  discarded: DiscardedStep[];
  /** 需要替代方案的自定义字体 */
  fallbacks: FontFallbackAdvice[];
  notes: TypographyNote[];
  /** 聚类前的原始字号数，和 steps 的长度之差就是降噪幅度 */
  rawSizeCount: number;
}

// ---------------------------------------------------------------------
// 字体名解析
// ---------------------------------------------------------------------

/** CSS 规范里的通用族关键字。它们不是具体字体，是「交给浏览器挑一个」 */
const GENERIC_FAMILIES = new Set([
  'sans-serif',
  'serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-sans-serif',
  'ui-serif',
  'ui-monospace',
  'ui-rounded',
  'emoji',
  'math',
  'fangsong',
]);

/**
 * 厂商定义的平台关键字。它们同样不是字体文件，而是「用系统默认」的意思，
 * 所以归到 system，也永远不需要给替代方案——用户没法替换一个平台概念。
 */
const PLATFORM_KEYWORDS = new Set(['-apple-system', 'blinkmacsystemfont']);

/**
 * 常见系统预装字体。
 *
 * 这份名单的作用是避免误报：一份字体名如果本来就在目标机器上，
 * 还去提示「本地可能没有、建议换个替代」就是纯噪音。名单覆盖
 * macOS、Windows、Android 和主流 Linux 发行版的预装字体，加上
 * 几个装机量极大的开源字体。
 *
 * 判断顺序上 @font-face 名单优先，所以即使某个开源字体既被页面
 * 内嵌又在这份名单里，也会先被判成网页字体，不会漏掉提示。
 */
const SYSTEM_FONTS = new Set([
  // macOS
  'helvetica',
  'helvetica neue',
  'arial',
  'arial black',
  'lucida grande',
  'menlo',
  'monaco',
  'geneva',
  'optima',
  'georgia',
  'times',
  'times new roman',
  'courier',
  'courier new',
  'verdana',
  'tahoma',
  'trebuchet ms',
  'palatino',
  'sf pro',
  'sf pro text',
  'sf pro display',
  'sf mono',
  // macOS 等宽栈里真正命中的那个名字。写成 ui-monospace, SFMono-Regular,
  // Menlo, ... 的页面很多，漏了它就会把一个纯系统字体报成「页面自带」
  'sfmono-regular',
  'new york',
  // macOS 中文字体
  'pingfang sc',
  'pingfang tc',
  'pingfang hk',
  'hiragino sans',
  'hiragino sans gb',
  'heiti sc',
  'stheiti',
  'songti sc',
  'stsong',
  'kaiti sc',
  'yuanti sc',
  // Windows
  'segoe ui',
  'segoe ui variable',
  'calibri',
  'candara',
  'consolas',
  'corbel',
  'cambria',
  'constantia',
  'franklin gothic medium',
  'impact',
  'lucida console',
  'lucida sans',
  'ms gothic',
  'ms pgothic',
  'meiryo',
  'malgun gothic',
  'gulim',
  // Windows 中文字体
  'microsoft yahei',
  'microsoft jhenghei',
  'simsun',
  'simhei',
  'nsimsun',
  // Android / Linux / 装机量大的开源字体
  'roboto',
  'roboto condensed',
  'noto sans',
  'noto serif',
  'noto sans sc',
  'noto serif sc',
  'noto sans cjk sc',
  'droid sans',
  'droid sans mono',
  'ubuntu',
  'ubuntu mono',
  'cantarell',
  'dejavu sans',
  'dejavu serif',
  'dejavu sans mono',
  'liberation sans',
  'liberation serif',
  'liberation mono',
  'free sans',
  'wenquanyi micro hei',
  'source han sans',
  'source han sans sc',
  'fira sans',
  'open sans',
  'lato',
  'montserrat',
  'nunito',
  'pt sans',
  'source sans pro',
  'source sans 3',
  'inter',
  'work sans',
  'ibm plex sans',
  'ibm plex mono',
]);

/**
 * 等宽字体的识别词。
 *
 * 刻意按词比对而不是整串包含。字体名里带 mono 的并不都是等宽字体，
 * Monotype Corsiva 就是一个反例，整串匹配会把它判成等宽，直接污染
 * 代码字体的结论。所以先把族名拆成词，再逐词比对。
 */
const MONO_WORDS = new Set([
  'mono',
  'monospace',
  'code',
  'console',
  'courier',
  'consolas',
  'menlo',
  'monaco',
  'inconsolata',
  'hack',
  'iosevka',
  'terminus',
  'fixed',
]);

/** 字体栈里出现这些词，说明页面给中文准备了专用字体 */
const CJK_HINTS = [
  'pingfang',
  'hiragino',
  'yahei',
  'jhenghei',
  'heiti',
  'songti',
  'kaiti',
  'simsun',
  'simhei',
  'source han',
  'noto sans sc',
  'noto serif sc',
  'noto sans cjk',
  'wenquanyi',
  'cjk',
];

function stackHasCjk(stack: string[]): boolean {
  for (let i = 0; i < stack.length; i++) {
    const s = (stack[i] ?? '').toLowerCase();
    if (!s) continue;
    if (CJK_HINTS.some((h) => s.indexOf(h) !== -1)) return true;
  }
  return false;
}

/**
 * 拆字体栈。
 *
 * 不能直接按逗号切。字体名里允许出现逗号，只要用引号包起来，
 * 直接切会把 "Foo, Inc." 这种名字从中间断开。这里走一遍引号状态机，
 * 只在引号外面切，同时把引号本身去掉。
 */
function splitStack(value: string): string[] {
  const out: string[] = [];
  let buf = '';
  let quote = '';

  for (let i = 0; i < value.length; i++) {
    const ch = value[i] ?? '';
    if (quote) {
      if (ch === quote) quote = '';
      else buf += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ',') {
      if (buf.trim()) out.push(buf.trim());
      buf = '';
      continue;
    }
    buf += ch;
  }

  if (buf.trim()) out.push(buf.trim());
  return out;
}

function normName(value: string): string {
  return value.replace(/^["']|["']$/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * 从一条 font-family 计算值里取出主族。
 *
 * 取栈里第一个不是通用关键字的族。像 -apple-system 这种平台关键字要算
 * 主族，因为它就是这一栈在目标平台上的实际结果，跳过它会去报一个
 * 根本轮不到的字体。
 *
 * 导出给溯源用。界面上「PingFang SC 承载 1240 字」这一行，要能点出
 * 到底哪些元素在用它，判据只能是这一条；另写一份的话两边的分组会
 * 在边界上错开，而这种错开从结果上几乎看不出来。
 */
export function primaryFamilyOf(fontFamily: string): string {
  const stack = splitStack(typeof fontFamily === 'string' ? fontFamily : '');
  for (let i = 0; i < stack.length; i++) {
    const s = stack[i] ?? '';
    if (s && !GENERIC_FAMILIES.has(s.toLowerCase())) return normName(s);
  }
  return '';
}

/** 把族名拆成词。连写形式（SFMono、RobotoMono）拆不开，另有后缀规则兜底 */
function nameWords(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[\s\-_]+/)
    .filter((w) => w.length > 0);
}

function isMonoName(name: string): boolean {
  const ws = nameWords(name);
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i];
    if (!w) continue;
    if (MONO_WORDS.has(w)) return true;
    // 连写形式：SFMono、RobotoMono、JetBrainsMono。
    // 只认后缀不认前缀，否则 Monotype 这种会被误判成等宽。
    if (w.length >= 5 && w.endsWith('mono')) return true;
  }
  return false;
}

/**
 * 推断某个字体族属于哪一类。
 *
 * 字体栈末尾的通用族是最可信的依据，因为那是原作者亲手写下的回退方向。
 * 只有整个栈里找不到通用族时才退回按族名里的词猜。
 */
function inferGeneric(stack: string[], family: string): GenericFamily {
  for (let i = stack.length - 1; i >= 0; i--) {
    const s = (stack[i] ?? '').toLowerCase();
    if (s === 'serif' || s === 'ui-serif') return 'serif';
    if (s === 'monospace' || s === 'ui-monospace') return 'monospace';
    if (s === 'sans-serif' || s === 'ui-sans-serif' || s === 'system-ui') return 'sans-serif';
  }

  if (isMonoName(family)) return 'monospace';

  const ws = nameWords(family);
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i];
    if (!w) continue;
    if (
      w === 'serif' ||
      w === 'roman' ||
      w === 'georgia' ||
      w === 'times' ||
      w === 'garamond' ||
      w === 'baskerville' ||
      w === 'didot' ||
      w === 'playfair' ||
      w === 'merriweather' ||
      w === 'lora' ||
      w === 'songti' ||
      w === 'song'
    ) {
      return 'serif';
    }
  }

  // 猜不出来就按无衬线处理，这是当下网页的绝对主流
  return 'sans-serif';
}

/** 替代字体表。选的都是各平台预装或有极高装机量的，保证换上去能真的显示出来 */
const FALLBACK_BY_GENERIC: Record<GenericFamily, string[]> = {
  'sans-serif': ['Inter', 'system-ui', 'Helvetica Neue', 'Arial'],
  serif: ['Georgia', 'Times New Roman'],
  monospace: ['SF Mono', 'Menlo', 'Consolas', 'Liberation Mono'],
};

/**
 * 字体名里的引号只在写进 CSS 时才需要，所以统一在拼栈的最后一步补。
 * suggested 数组本身留纯名字，展示的时候不带引号更好读。
 *
 * 含空格、以数字开头、带标点的名字必须包引号。以连字符开头的
 * -apple-system 是个例外，它按规范就是裸写的，包上引号在 Safari 里会失效。
 */
function quoteIfNeeded(name: string): string {
  const n = name.trim();
  if (!n) return n;
  if (n.startsWith('"') || n.startsWith("'")) return n;
  if (/^[A-Za-z_][\w-]*$/.test(n)) return n;
  if (/^-[A-Za-z_][\w-]*$/.test(n)) return n;
  return `"${n}"`;
}

/** 替代栈末尾补上的通用族，保证最坏情况下浏览器仍能自己挑一个 */
const GENERIC_TAIL: Record<GenericFamily, string> = {
  'sans-serif': 'sans-serif',
  serif: 'serif',
  monospace: 'monospace',
};

// ---------------------------------------------------------------------
// 累计器
// ---------------------------------------------------------------------

interface SizeAcc {
  /** 代表字号，取簇内承载字符最多的那个原始值 */
  size: number;
  /**
   * 簇内全部原始字号，含代表值本身，升序。
   *
   * 留着它是为了溯源：5% 容差会把 15.9 和 16 并成一级，界面上只显示 16，
   * 而页面上真实用到的是两个值。要点出「这一级到底是哪些元素」就必须
   * 知道簇里有哪几个原始值，光有代表值会漏掉一半元素。
   */
  members: number[];
  chars: number;
  elementCount: number;
  /** 字重 → 承载字符数 */
  weights: Map<number, number>;
  /** 显式行高 px → 承载字符数 */
  lineHeights: Map<number, number>;
  /** 行高为 normal 的字符数 */
  normalLineHeightChars: number;
  /** 字间距 px → 承载字符数 */
  letterSpacings: Map<number, number>;
  /** 字间距为 normal 的字符数 */
  normalSpacingChars: number;
  /** 字体族 → 承载字符数 */
  families: Map<string, number>;
  /** 等宽字体承载的字符数 */
  monoChars: number;
  /** 落在控件上的字符数 */
  controlChars: number;
  headingLevels: Set<number>;
}

interface FamilyAcc {
  name: string;
  /** 归一化后的完整字体栈，生成替代栈时要用它保留原有的回退顺序 */
  stack: string[];
  chars: number;
  elementCount: number;
  sizes: Set<number>;
  generic: GenericFamily;
  /** 角色 → 承载字符数。要等层级角色定完才能回填 */
  roles: Map<TypeRole, number>;
}

function emptySize(size: number): SizeAcc {
  return {
    size,
    members: [size],
    chars: 0,
    elementCount: 0,
    weights: new Map(),
    lineHeights: new Map(),
    normalLineHeightChars: 0,
    letterSpacings: new Map(),
    normalSpacingChars: 0,
    families: new Map(),
    monoChars: 0,
    controlChars: 0,
    headingLevels: new Set(),
  };
}

/**
 * 深拷贝一格累计器。
 *
 * 必须显式重建里面四个容器。直接展开对象只会复制引用，两个簇会指向
 * 同一份 Map，后面往其中一个写数据另一个也跟着变，簇的边界就没了。
 */
function cloneAcc(src: SizeAcc): SizeAcc {
  return {
    size: src.size,
    members: [...src.members],
    chars: src.chars,
    elementCount: src.elementCount,
    weights: new Map(src.weights),
    lineHeights: new Map(src.lineHeights),
    normalLineHeightChars: src.normalLineHeightChars,
    letterSpacings: new Map(src.letterSpacings),
    normalSpacingChars: src.normalSpacingChars,
    families: new Map(src.families),
    monoChars: src.monoChars,
    controlChars: src.controlChars,
    headingLevels: new Set(src.headingLevels),
  };
}

function bump(map: Map<number, number>, key: number, by: number): void {
  map.set(key, (map.get(key) ?? 0) + by);
}

function bumpName(map: Map<string, number>, key: string, by: number): void {
  map.set(key, (map.get(key) ?? 0) + by);
}

function mergeInto(target: SizeAcc, src: SizeAcc): void {
  target.chars += src.chars;
  target.elementCount += src.elementCount;
  for (const m of src.members) {
    if (target.members.indexOf(m) === -1) target.members.push(m);
  }
  target.members.sort((a, b) => a - b);
  target.normalLineHeightChars += src.normalLineHeightChars;
  target.normalSpacingChars += src.normalSpacingChars;
  target.monoChars += src.monoChars;
  target.controlChars += src.controlChars;
  for (const [k, v] of src.weights) bump(target.weights, k, v);
  for (const [k, v] of src.lineHeights) bump(target.lineHeights, k, v);
  for (const [k, v] of src.letterSpacings) bump(target.letterSpacings, k, v);
  for (const [k, v] of src.families) bumpName(target.families, k, v);
  for (const lv of src.headingLevels) target.headingLevels.add(lv);
}

/** 取权值最大的键。没有有效项时返回 null */
function topKey(map: Map<number, number>): number | null {
  let best: number | null = null;
  let bestW = -1;
  for (const [k, w] of map) {
    if (w > bestW) {
      bestW = w;
      best = k;
    }
  }
  return best;
}

function topKeys(map: Map<string, number>, limit: number): string[] {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map((e) => e[0]);
}

/**
 * 字号归一。
 *
 * 保留一位小数就够。rem 折算出来的值经常是 15.999999 这种，
 * 多留几位精度只会让同一个字号在聚合前就裂成两条。
 *
 * 导出给溯源用：字号层级里每一级带着的那串原始字号就是按这条规则算出来的，
 * 界面上点一级要回到「用了这个字号的元素」，判据只能是同一个函数。
 * 另写一份的话，15.999999 会在一处归到 16、在另一处归到 15.9，
 * 结果就是高亮少描一批元素，而少的那批看起来像本来就不该有。
 */
export function normalizeSize(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * 10) / 10;
}

// ---------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------

interface StepContext {
  bodySize: number | null;
  totalChars: number;
  maxSize: number;
}

function describeStep(role: TypeRole, acc: SizeAcc, ctx: StepContext): string {
  const share = ctx.totalChars > 0 ? acc.chars / ctx.totalChars : 0;
  const shareText = share >= 0.01 ? `承载全页 ${(share * 100).toFixed(share < 0.1 ? 1 : 0)}% 的文字` : '';

  const ratioToBody =
    ctx.bodySize && ctx.bodySize > 0 ? Math.round((acc.size / ctx.bodySize) * 100) / 100 : null;

  const headingOn =
    acc.headingLevels.size > 0
      ? `用在 ${[...acc.headingLevels]
          .sort((a, b) => a - b)
          .map((n) => 'h' + n)
          .join(' / ')} 上`
      : '';

  const lhNote = (() => {
    // 只有显式设过行高的才写出来。整级都是 normal 时不补一个默认倍数，
    // 那是页面里并不存在的值，写进去反而误导。
    const explicit = topKey(acc.lineHeights);
    if (explicit === null || acc.size <= 0) return '';
    const weight = acc.lineHeights.get(explicit) ?? 0;
    if (weight < acc.normalLineHeightChars) return '';
    return `行高 ${Math.round((explicit / acc.size) * 100) / 100} 倍`;
  })();

  const lsNote = (() => {
    const explicit = topKey(acc.letterSpacings);
    if (explicit === null) return '';
    const weight = acc.letterSpacings.get(explicit) ?? 0;
    if (weight < acc.normalSpacingChars) return '';
    if (explicit === 0) return '';
    return explicit < 0
      ? `字间距收紧了 ${Math.abs(explicit)}px，大字号靠这一步把字母拉回紧凑`
      : `字间距放宽了 ${explicit}px，用于拉长小字的视觉节奏`;
  })();

  const join = (parts: string[]) => parts.filter((p) => p.length > 0).join('，');

  switch (role) {
    case 'body':
      return join([
        '正文基准，页面里绝大多数文字都用这个字号',
        shareText,
        '其他所有字号都以它为基准做加减，新增正文不要再另起一个字号',
        lhNote,
        lsNote,
      ]);

    case 'heading': {
      const biggest = acc.size >= ctx.maxSize;
      return join([
        biggest ? '页面最大的一级文字' : '标题层级',
        headingOn,
        ratioToBody !== null ? `字号是正文的 ${ratioToBody} 倍` : '',
        biggest ? '只用在页面主标题上，正文里不要出现这个尺寸' : '与下一级之间保持这个落差，不要为了塞下长标题去缩小它',
        lhNote,
        lsNote,
      ]);
    }

    case 'caption':
      return join([
        '辅助文字层级',
        ratioToBody !== null ? `字号是正文的 ${ratioToBody} 倍` : '',
        '用于说明文字、时间戳、单位、表单校验提示这类不该抢占注意力的内容',
        '不要再往下加更小的字号，这一级已经是可读下限',
        lhNote,
        lsNote,
      ]);

    case 'code':
      return join([
        '等宽字体层级',
        shareText,
        '用于代码、文件路径、标识符和需要按列对齐的数字',
        '代码块的行高要比正文更松，否则连续多行会挤在一起',
        lhNote,
        lsNote,
      ]);

    default:
      return join([
        '介于正文和标题之间的字号',
        shareText,
        '多用于导航项、按钮文字和表单标签',
        '不要在正文和标题之外再造第四种用途',
        lhNote,
        lsNote,
      ]);
  }
}

function confidenceOf(role: TypeRole, acc: SizeAcc, ctx: StepContext): 'high' | 'medium' | 'low' {
  const share = ctx.totalChars > 0 ? acc.chars / ctx.totalChars : 0;
  switch (role) {
    case 'body':
      return share >= 0.3 ? 'high' : 'medium';
    case 'heading':
      // 有标签语义支持的标题级是硬证据，只靠字号推出来的要弱一档
      return acc.headingLevels.size > 0 ? 'high' : 'medium';
    case 'code':
      return acc.chars > 0 && acc.monoChars / acc.chars >= 0.8 ? 'high' : 'medium';
    case 'caption':
      return 'medium';
    default:
      return 'low';
  }
}

export function analyzeTypography(sample: PageSample): TypographyAnalysis {
  const empty: TypographyAnalysis = {
    families: [],
    steps: [],
    bodySize: null,
    monoFamilies: [],
    discarded: [],
    fallbacks: [],
    notes: [],
    rawSizeCount: 0,
  };

  // 采集结果穿过一次序列化边界，字段可能整体缺失，先兜住再往下走
  const obs = Array.isArray(sample.typography) ? sample.typography : [];
  if (obs.length === 0) return empty;

  const webFonts = new Set<string>();
  if (Array.isArray(sample.webFontFamilies)) {
    for (const f of sample.webFontFamilies) {
      if (f) webFonts.add(normName(String(f)).toLowerCase());
    }
  }

  // --- 1. 按字号与字体族分通道累计证据 --------------------------------
  const sizeAcc = new Map<number, SizeAcc>();
  const familyAcc = new Map<string, FamilyAcc>();
  const monoFamilies = new Set<string>();
  let totalChars = 0;

  for (const o of obs) {
    if (!o) continue;
    const chars = typeof o.textChars === 'number' ? o.textChars : 0;
    if (chars <= 0) continue;

    const size = normalizeSize(typeof o.fontSize === 'number' ? o.fontSize : 0);
    if (size <= 0) continue;

    const stack = splitStack(typeof o.fontFamily === 'string' ? o.fontFamily : '');
    const primary = primaryFamilyOf(typeof o.fontFamily === 'string' ? o.fontFamily : '');

    const mono = primary.length > 0 && isMonoName(primary);
    if (mono) monoFamilies.add(primary);

    const headingLevel =
      typeof o.headingLevel === 'number' && o.headingLevel >= 1 && o.headingLevel <= 6
        ? o.headingLevel
        : 0;

    totalChars += chars;

    // 字号通道
    let sa = sizeAcc.get(size);
    if (!sa) {
      sa = emptySize(size);
      sizeAcc.set(size, sa);
    }
    sa.chars += chars;
    sa.elementCount++;
    if (mono) sa.monoChars += chars;
    if (o.isControl) sa.controlChars += chars;
    if (headingLevel > 0) sa.headingLevels.add(headingLevel);

    const weight = typeof o.fontWeight === 'number' ? o.fontWeight : 400;
    bump(sa.weights, weight, chars);

    if (typeof o.lineHeight === 'number' && Number.isFinite(o.lineHeight) && o.lineHeight > 0) {
      bump(sa.lineHeights, Math.round(o.lineHeight * 100) / 100, chars);
    } else {
      sa.normalLineHeightChars += chars;
    }

    if (
      typeof o.letterSpacing === 'number' &&
      Number.isFinite(o.letterSpacing) &&
      o.letterSpacing !== 0
    ) {
      bump(sa.letterSpacings, Math.round(o.letterSpacing * 100) / 100, chars);
    } else {
      sa.normalSpacingChars += chars;
    }

    if (primary.length > 0) bumpName(sa.families, primary, chars);

    // 字体族通道
    if (primary.length > 0) {
      const key = primary.toLowerCase();
      let fa = familyAcc.get(key);
      if (!fa) {
        fa = {
          name: primary,
          stack,
          chars: 0,
          elementCount: 0,
          sizes: new Set(),
          generic: inferGeneric(stack, primary),
          roles: new Map(),
        };
        familyAcc.set(key, fa);
      }
      fa.chars += chars;
      fa.elementCount++;
      fa.sizes.add(size);
    }
  }

  if (sizeAcc.size === 0) return empty;

  const rawSizeCount = sizeAcc.size;

  // --- 2. 字号聚类。按承载文字量从多到少扫，能贴到簇心的就并入 -------
  const entries = [...sizeAcc.values()].sort((a, b) => b.chars - a.chars);
  const clusters: SizeAcc[] = [];
  /** 原始字号 → 所属簇下标。回填字体角色时按这个查 */
  const owner = new Map<number, number>();

  for (const e of entries) {
    let best = -1;
    let bestDiff = Infinity;

    for (let i = 0; i < clusters.length; i++) {
      const c = clusters[i];
      if (!c || c.size <= 0) continue;
      const diff = Math.abs(e.size - c.size) / c.size;
      if (diff <= SIZE_MERGE_RATIO && diff < bestDiff) {
        bestDiff = diff;
        best = i;
      }
    }

    const target = best >= 0 ? clusters[best] : undefined;
    if (target) {
      mergeInto(target, e);
      owner.set(e.size, best);
    } else {
      clusters.push(cloneAcc(e));
      owner.set(e.size, clusters.length - 1);
    }
  }

  // --- 3. 一次性数值过滤 ----------------------------------------------
  //
  // 过滤必须发生在角色分配之前，理由和颜色那边一样：先分角色再过滤的话，
  // 一个只出现一次的装饰字号会因为没人和它竞争而直接拿到正文这类角色，
  // 再想把它拿掉就晚了。
  const kept: SizeAcc[] = [];
  const discarded: DiscardedStep[] = [];

  for (const c of clusters) {
    // 标题标签豁免。一个只有两个字的 h1 是真实存在的层级，按字符量
    // 判定会把它当噪声丢掉，这和颜色那边「控件上的颜色一律保留」同一个道理。
    if (c.headingLevels.size > 0) {
      kept.push(c);
      continue;
    }
    if (c.chars >= MIN_STEP_CHARS) {
      kept.push(c);
      continue;
    }
    // 字符少但铺得开的，仍然可能是真实层级，比如一列只有三四个字的导航项
    if (c.elementCount >= 2 && c.chars * 2 >= MIN_STEP_CHARS) {
      kept.push(c);
      continue;
    }
    discarded.push({
      size: c.size,
      sizes: [...c.members],
      chars: c.chars,
      elementCount: c.elementCount,
      reason:
        c.elementCount <= 1
          ? `只在 1 个元素上出现，共 ${c.chars} 个字，判定为一次性数值`
          : `只承载 ${c.chars} 个字，不足以支撑一个独立层级`,
    });
  }

  // 按承载文字量保留最主要的若干级，超出的记下来
  kept.sort((a, b) => b.chars - a.chars);
  if (kept.length > MAX_STEPS) {
    for (const c of kept.slice(MAX_STEPS)) {
      discarded.push({
        size: c.size,
        sizes: [...c.members],
        chars: c.chars,
        elementCount: c.elementCount,
        reason: `页面共 ${kept.length} 个字号层级，只保留最主要的 ${MAX_STEPS} 级`,
      });
    }
    kept.length = MAX_STEPS;
  }

  // --- 4. 角色分配 ----------------------------------------------------
  const body = kept[0] ?? null;
  const bodySize = body ? body.size : null;
  const maxSize = kept.reduce((m, c) => (c.size > m ? c.size : m), 0);

  const ctx: StepContext = { bodySize, totalChars, maxSize };

  const drafts: { acc: SizeAcc; role: TypeRole }[] = [];

  for (const c of kept) {
    let role: TypeRole;

    if (body && c === body) {
      // 承载字符最多的那一级就是正文。这是全表最强的信号，
      // 任何其他判据都不该盖过它，否则正文会被判到别处去。
      role = 'body';
    } else if (c.chars > 0 && c.monoChars / c.chars >= MONO_SHARE) {
      role = 'code';
    } else if (c.headingLevels.size > 0) {
      role = 'heading';
    } else if (bodySize !== null && c.size >= bodySize * HEADING_RATIO) {
      role = 'heading';
    } else if (c.chars > 0 && c.controlChars / c.chars >= 0.6) {
      // 大部分字数落在按钮、输入框这类控件上，这是界面文字，
      // 不该按字号大小把它归到辅助说明里去
      role = 'ui';
    } else if (bodySize !== null && c.size < bodySize * CAPTION_RATIO) {
      role = 'caption';
    } else {
      role = 'ui';
    }

    drafts.push({ acc: c, role });
  }

  // --- 5. 回填每一级的排版参数 ----------------------------------------
  const ordered = [...drafts].sort((a, b) => b.acc.size - a.acc.size);

  const steps: TypeStep[] = ordered.map((d) => {
    const c = d.acc;

    const explicitLh = topKey(c.lineHeights);
    const explicitLhWeight = explicitLh === null ? 0 : c.lineHeights.get(explicitLh) ?? 0;
    const lineHeight =
      explicitLh !== null && explicitLhWeight >= c.normalLineHeightChars ? explicitLh : null;
    const lineHeightRatio =
      lineHeight !== null && c.size > 0 ? Math.round((lineHeight / c.size) * 100) / 100 : null;

    const explicitLs = topKey(c.letterSpacings);
    const explicitLsWeight = explicitLs === null ? 0 : c.letterSpacings.get(explicitLs) ?? 0;
    const letterSpacing =
      explicitLs !== null && explicitLsWeight >= c.normalSpacingChars ? explicitLs : null;

    const weights = [...c.weights.entries()]
      .sort((x, y) => y[1] - x[1])
      .slice(0, MAX_WEIGHTS)
      .map((e) => e[0]);

    return {
      size: c.size,
      sizes: [...c.members],
      role: d.role,
      label: ROLE_LABEL[d.role],
      chars: c.chars,
      elementCount: c.elementCount,
      weights,
      lineHeight,
      lineHeightRatio,
      letterSpacing,
      families: topKeys(c.families, 3),
      headingLevels: [...c.headingLevels].sort((a, b) => a - b),
      usage: describeStep(d.role, c, ctx),
      confidence: confidenceOf(d.role, c, ctx),
    };
  });

  // --- 6. 字体族汇总。角色要从字号那边借过来 --------------------------
  const roleBySize = new Map<number, TypeRole>();
  for (const d of drafts) roleBySize.set(d.acc.size, d.role);

  for (const o of obs) {
    if (!o) continue;
    const chars = typeof o.textChars === 'number' ? o.textChars : 0;
    if (chars <= 0) continue;

    const size = normalizeSize(typeof o.fontSize === 'number' ? o.fontSize : 0);
    if (size <= 0) continue;

    const primary = primaryFamilyOf(typeof o.fontFamily === 'string' ? o.fontFamily : '');
    if (!primary) continue;

    const fa = familyAcc.get(primary.toLowerCase());
    if (!fa) continue;

    // 字号可能已经被判成一次性数值丢掉了，那样就没有角色可归
    const clusterIndex = owner.get(size);
    const clusterSize = clusterIndex === undefined ? undefined : clusters[clusterIndex]?.size;
    const role = clusterSize === undefined ? undefined : roleBySize.get(clusterSize);
    if (!role) continue;

    fa.roles.set(role, (fa.roles.get(role) ?? 0) + chars);
  }

  const familyStats: FontFamilyStat[] = [];
  for (const fa of familyAcc.values()) {
    if (fa.chars < MIN_FAMILY_CHARS) continue;

    const lower = fa.name.toLowerCase();
    const isPlatform = PLATFORM_KEYWORDS.has(lower);
    let origin: FontOrigin;
    if (webFonts.has(lower)) origin = 'font-face';
    else if (isPlatform || SYSTEM_FONTS.has(lower) || GENERIC_FAMILIES.has(lower)) origin = 'system';
    else origin = 'unknown';

    familyStats.push({
      name: fa.name,
      origin,
      generic: fa.generic,
      chars: fa.chars,
      elementCount: fa.elementCount,
      roles: [...fa.roles.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0]),
      sizes: [...fa.sizes].sort((a, b) => a - b),
      isPrimary: false,
    });
  }

  familyStats.sort((a, b) => b.chars - a.chars);
  const primaryStat = familyStats[0];
  if (primaryStat) primaryStat.isPrimary = true;

  // --- 7. 自定义字体的替代方案 ----------------------------------------
  const fallbacks: FontFallbackAdvice[] = [];

  for (const f of familyStats) {
    // 系统字体不需要替代，平台关键字连字体文件都不是，更无从替换
    if (f.origin === 'system') continue;

    const acc = familyAcc.get(f.name.toLowerCase());
    const original = acc ? acc.stack : [f.name];
    const suggested = [...FALLBACK_BY_GENERIC[f.generic]];
    const reasonBits: string[] = [];

    if (f.origin === 'font-face') {
      reasonBits.push('这个字体是页面自己连文件一起发过来的，别人机器上不一定装了');
    } else {
      reasonBits.push('这个字体不在常见系统字体名单里，没法确认打开的人本地有没有');
    }

    reasonBits.push(
      f.isPrimary
        ? '它承担了页面主要文字，换掉之后整体观感变化最明显'
        : '替换时优先保住字号、字重和行高的节奏，字形差异在次要位置影响有限',
    );

    // 原栈里如果本来就写了中文字体，替换栈会把它保留下来，
    // 这一点值得说明：不说明的话，看到英文被换成 Inter 会以为中文也一起没了。
    if (stackHasCjk(original)) {
      reasonBits.push('原字体栈里的中文字体已保留在替代栈中，中英文混排不会掉字体');
    }

    fallbacks.push({
      family: f.name,
      origin: f.origin,
      generic: f.generic,
      suggested,
      stack: buildFallbackStack(f.name, f.generic, suggested, original),
      reason: reasonBits.join('，') + '。',
    });
  }

  // --- 8. 需要主动说明的情况 ------------------------------------------
  const notes: TypographyNote[] = [];

  const headingSteps = steps.filter((s) => s.role === 'heading');
  const bodyStep = steps.find((s) => s.role === 'body');
  const headingFamilies = new Set<string>();
  for (const s of headingSteps) {
    for (const fam of s.families) headingFamilies.add(fam);
  }
  const bodyFamilies = new Set(bodyStep ? bodyStep.families : []);

  if (headingFamilies.size > 0 && bodyFamilies.size > 0) {
    const shared = [...headingFamilies].filter((f) => bodyFamilies.has(f));
    if (shared.length === headingFamilies.size && shared.length === bodyFamilies.size) {
      notes.push({
        kind: 'same-family',
        text:
          `标题和正文用的是同一套字体（${[...bodyFamilies].join('、')}），层级完全靠字号和字重拉开。` +
          `复刻时不要再引入第二种字体，加了反而会让层级变模糊。`,
      });
    } else {
      notes.push({
        kind: 'split-family',
        text:
          `标题用的是 ${[...headingFamilies].join('、')}，正文用的是 ${[...bodyFamilies].join('、')}，` +
          `两者分工明确。复刻时不要用同一套字体同时承担标题和正文，` +
          `标题字体的性格通常更重，混进正文会显得吵。`,
      });
    }
  }

  const webFontList = familyStats.filter((f) => f.origin === 'font-face');
  if (webFontList.length > 0) {
    notes.push({
      kind: 'webfont',
      text:
        `页面自带了 ${webFontList.length} 款字体文件（${webFontList
          .map((f) => f.name)
          .join('、')}）。这些字体依赖网络加载，在没装这些字体、也没有网络的环境里会直接掉到回退字体，` +
        `整个页面的观感会变。下面给出了每款的替代方案。`,
    });
  }

  const explicitLineHeightSteps = steps.filter((s) => s.lineHeight !== null);
  if (steps.length > 0 && explicitLineHeightSteps.length === 0) {
    notes.push({
      kind: 'no-explicit-line-height',
      text:
        '页面没有显式设置行高，全部交给浏览器按字体自身的度量渲染。' +
        '这一项不要写死成某个像素值，需要指定时用 normal，或按正文 1.5 倍起步。',
    });
  }

  if (bodyStep && bodyStep.families.some((f) => monoFamilies.has(f))) {
    notes.push({
      kind: 'mono-body',
      text:
        '正文本身就落在等宽字体上，这个页面大概率是代码、终端或技术文档类界面。' +
        '这种情况下正文的字间距和行高都要比常规网页更松。',
    });
  }

  const totalText = typeof sample.textCharsTotal === 'number' ? sample.textCharsTotal : totalChars;
  if (totalText > 0 && totalText < THIN_TEXT_CHARS) {
    notes.push({
      kind: 'thin-text',
      text:
        `页面能读到的文字只有 ${totalText} 个字，字号层级的判断样本偏少，` +
        `结果可能遗漏真实存在的层级。可以结合下面的层级明细人工确认一遍。`,
    });
  }

  return {
    families: familyStats,
    steps,
    bodySize,
    monoFamilies: [...monoFamilies],
    discarded,
    fallbacks,
    notes,
    rawSizeCount,
  };
}

/**
 * 生成可直接粘贴的字体栈。
 *
 * 思路是只换最前面那一个，其余原样保留。原作者写下的回退顺序是有信息量的，
 * 它表达了「在这个平台上优先用谁」，比如 -apple-system 打头意味着这份设计
 * 主要在苹果设备上被看过。替代方案不该把这个顺序抹掉重来。
 *
 * 顺手要做两件清理。
 * 一是跳过主族本身，否则替换完之后原来的字体名还留在栈里，等于没换。
 * 二是跳过主族的伴生占位族。Söhne 这类商业字体常常同时声明一个
 * Söhne Fallback，占位族在别人机器上同样不存在，留着它问题原样搬过去。
 */
function buildFallbackStack(
  family: string,
  generic: GenericFamily,
  suggested: string[],
  original: string[],
): string {
  const first = suggested[0] ?? GENERIC_TAIL[generic];
  const parts: string[] = [first, ...suggested.slice(1)];

  const lower = family.toLowerCase();
  const seen = new Set<string>(parts.map((p) => p.toLowerCase()));

  for (let i = 0; i < original.length; i++) {
    const s = original[i] ?? '';
    if (!s) continue;
    const sl = s.toLowerCase();
    if (sl === lower) continue;
    if (sl.startsWith(lower) || lower.startsWith(sl)) continue;
    if (seen.has(sl)) continue;
    seen.add(sl);
    parts.push(s);
  }

  // 末尾一定要落到通用族，最坏情况下浏览器还能自己挑一个
  const tail = GENERIC_TAIL[generic];
  if (!seen.has(tail)) parts.push(tail);

  return parts.map(quoteIfNeeded).join(', ');
}
