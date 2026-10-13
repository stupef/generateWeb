import { KIND_LABEL, KIND_ORDER } from './kinds';
import { numOf, radiusKeyOf, radiusTextOf, refineKind } from './observation';
import type { PageSample, StyleElementKind, StyleObservation } from './types';

/**
 * 圆角、边框、投影的分组门槛。
 *
 * 三类都定在 1，和间距那边定 2 不一样，理由也不一样。间距值是几十上百个
 * 元素共用的量，出现一次的多半是手调出来的杂值；圆角、边框、投影则是
 * 「一整套样式只出现一处」很常见的量：全页只有一个弹层带投影、只有一个
 * 表格带边框，而这一处恰恰是最需要复刻的。按次数过滤会把最有信息量的
 * 那一条丢掉。
 */
const MIN_GROUP_COUNT = 1;

/** 同一个元素类型下最多列出几个圆角变体。多出来的在说明里报个数 */
const MAX_RADIUS_VARIANTS = 2;

/** 最多输出多少组边框和投影，超出的按使用量从少到多砍掉 */
const MAX_BORDER_GROUPS = 6;
const MAX_SHADOW_GROUPS = 6;

/** 样本少于这个数时，结论要打折扣并告知使用者 */
const THIN_SAMPLE = 8;

// ---------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------

/**
 * 一个元素类型上的圆角情况。
 *
 * 按元素类型分组而不是只给一张圆角取值表，是因为「按钮 8px、输入框 6px、
 * 卡片 12px」和「页面用到 6/8/12 三个圆角」是两件不同的事。后者只说出了
 * 有哪些值，复刻的人仍然不知道该把哪个值用在哪个元素上。
 */
export interface RadiusByKind {
  kind: StyleElementKind;
  label: string;
  /** 这一类元素最常用的圆角，px。胶囊统一归到 PILL_RADIUS */
  radius: number;
  /** 同一个类型下的其它圆角，按使用量降序，最多两个 */
  others: number[];
  /** 带圆角的这一类元素数 */
  count: number;
  usage: string;
}

/** 一组边框样式，按「宽度 + 边数 + 线型 + 颜色」四元组聚合 */
export interface BorderGroup {
  /** 边框宽度，px */
  width: number;
  /** 可见边的数量，1 到 4 */
  sides: number;
  /** 线型：solid / dashed / dotted 等，计算样式里的原始写法 */
  style: string;
  /** 边框颜色。已合成到底色上 */
  color: string | null;
  count: number;
  /** 这种边框出现在哪些元素类型上 */
  kinds: StyleElementKind[];
  usage: string;
}

/** 一条边框分组的键与展示字段。见 borderKeyOf */
export interface BorderKey {
  key: string;
  width: number;
  sides: number;
  style: string;
  color: string | null;
}

/** 投影里的一层 */
export interface ShadowLayer {
  offsetX: number;
  offsetY: number;
  blur: number;
  spread: number;
  /**
   * 颜色。带透明度时写成 rgba()，不透明时写成十六进制。
   * 解析不出来的颜色格式原样保留，完全不写颜色时为 null。
   */
  color: string | null;
  inset: boolean;
}

/** 一组投影，按图层序列聚合 */
export interface ShadowGroup {
  /** 归一后可直接粘进样式表的写法 */
  css: string;
  layers: ShadowLayer[];
  count: number;
  kinds: StyleElementKind[];
  usage: string;
}

export type EffectsNoteKind = 'no-shadow' | 'no-border' | 'no-radius' | 'thin-sample';

export interface EffectsNote {
  kind: EffectsNoteKind;
  text: string;
}

export interface EffectsAnalysis {
  /** 圆角按元素类型分组，顺序跟随 KIND_ORDER */
  radii: RadiusByKind[];
  borders: BorderGroup[];
  shadows: ShadowGroup[];
  /**
   * 页面有没有用到投影。
   *
   * 单独给一个布尔量而不让调用方去看 shadows 是否为空，是因为
   * 「没有投影」在这个产品里是一条必须明确写出来的结论，不能被
   * 当成「这一块没有数据」而跳过。
   */
  usesShadow: boolean;
  notes: EffectsNote[];
  /** 进入候选通道的元素总数，也就是这次的样本量 */
  sampleCount: number;
}

// ---------------------------------------------------------------------
// 投影解析
// ---------------------------------------------------------------------

/**
 * 按顶层逗号切分。
 *
 * 不能直接 split(',')。一条 box-shadow 可以有多个图层用逗号分隔，而颜色
 * 里的 rgb(0, 0, 0) 内部同样是逗号，直接切会把一个图层切成三段。
 */
function splitLayers(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value.charAt(i);
    if (c === '(') depth++;
    else if (c === ')') depth = depth > 0 ? depth - 1 : 0;
    else if (c === ',' && depth === 0) {
      out.push(value.slice(start, i));
      start = i + 1;
    }
  }
  out.push(value.slice(start));
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

/** 按顶层空白切分记号。同样要绕开括号内的空格，color(srgb 1 0 0) 是一整个记号 */
function tokenize(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < value.length; i++) {
    const c = value.charAt(i);
    if (c === '(') depth++;
    else if (c === ')') depth = depth > 0 ? depth - 1 : 0;
    if (depth === 0 && /\s/.test(c)) {
      if (cur) {
        out.push(cur);
        cur = '';
      }
      continue;
    }
    cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

function channel(n: number): string {
  const v = Math.max(0, Math.min(255, Math.round(n)));
  return v.toString(16).padStart(2, '0');
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * 投影颜色的解析。
 *
 * 计算样式在主流浏览器里给的是 rgb()/rgba()，但新式颜色写法（oklch、
 * color-mix）也可能出现在这里。解析不了的格式原样返回，宁可让使用者
 * 看到一个陌生但正确的写法，也不要吐一个自己猜出来的值。
 */
function parseShadowColor(token: string): string | null {
  const m = /^rgba?\(([^)]+)\)$/i.exec(token);
  if (!m) {
    if (token.indexOf('(') !== -1) return token;
    if (token.charAt(0) === '#') return token.toUpperCase();
    return null;
  }

  const raw = m[1] ?? '';
  const parts = raw.split(/[,\s/]+/).filter((s) => s.length > 0);
  if (parts.length < 3) return token;

  // 前三个通道可能是百分比写法，这时要按 255 折算。不区分的话
  // rgb(100% 0% 0%) 会被读成 rgb(1, 0, 0)，一个几乎全黑的颜色。
  const first = parts[0] ?? '';
  const percentRGB = first.indexOf('%') !== -1;
  const scale = percentRGB ? (255 / 100) : 1;

  const nums: number[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i] ?? '';
    const isPercent = p.indexOf('%') !== -1;
    const n = parseFloat(p);
    if (Number.isNaN(n)) return token;
    // 第四个通道永远是 0-1 的比例，百分比写法按 1 折算
    nums.push(i >= 3 ? (isPercent ? n / 100 : n) : (percentRGB ? n * scale : n));
  }

  const r = nums[0] ?? 0;
  const g = nums[1] ?? 0;
  const b = nums[2] ?? 0;
  const a = nums.length > 3 ? (nums[3] ?? 1) : 1;

  if (a >= 0.999) return ('#' + channel(r) + channel(g) + channel(b)).toUpperCase();
  return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${round2(a)})`;
}

/** 一个图层的规范写法，同时用作聚合的键 */
function layerKey(l: ShadowLayer): string {
  return `${l.inset ? 'inset ' : ''}${l.offsetX} ${l.offsetY} ${l.blur} ${l.spread} ${l.color ?? 'currentColor'}`;
}

function layerCss(l: ShadowLayer): string {
  return `${l.inset ? 'inset ' : ''}${l.offsetX}px ${l.offsetY}px ${l.blur}px ${l.spread}px ${
    l.color ?? 'currentColor'
  }`;
}

/**
 * 把一条 box-shadow 的计算值拆成图层。
 *
 * 不能按固定位置取值。计算样式里颜色既可以写在最前面（Chrome 的写法）
 * 也可以写在最后面（Firefox 的写法），长度也不一定写满四个，`0 0 2px`
 * 和 `0 0 2px 0` 是同一个投影。这里按记号逐个认，认出颜色就是颜色，
 * 剩下的数字按顺序当成长度，缺失的补零。
 */
function parseLayer(chunk: string): ShadowLayer | null {
  const tokens = tokenize(chunk);
  if (tokens.length === 0) return null;

  const lengths: number[] = [];
  let color: string | null = null;
  let inset = false;
  let sawAnything = false;

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] ?? '';
    if (t.toLowerCase() === 'inset') {
      inset = true;
      sawAnything = true;
      continue;
    }
    // 颜色记号：带括号的颜色函数，或者井号开头的十六进制
    if (t.indexOf('(') !== -1 || t.charAt(0) === '#') {
      const parsed = parseShadowColor(t);
      if (parsed !== null) color = parsed;
      sawAnything = true;
      continue;
    }
    const n = parseFloat(t);
    if (!Number.isNaN(n)) {
      lengths.push(round1(n));
      sawAnything = true;
      continue;
    }
    // 认不出来的记号，例如 currentColor。当作颜色占位，保留原样
    color = color ?? t;
    sawAnything = true;
  }

  if (!sawAnything) return null;

  return {
    offsetX: lengths[0] ?? 0,
    offsetY: lengths[1] ?? 0,
    blur: lengths[2] ?? 0,
    spread: lengths[3] ?? 0,
    color,
    inset,
  };
}

function parseShadow(value: string): ShadowLayer[] {
  const out: ShadowLayer[] = [];
  for (const chunk of splitLayers(value)) {
    const layer = parseLayer(chunk);
    if (layer) out.push(layer);
  }
  return out;
}

/**
 * 把一条边框归一成分组用的键和展示字段。
 *
 * 四元组（宽度 + 边数 + 线型 + 颜色）的拼法只写在这里，因为分组和溯源
 * 都要用它。分开写两遍的话，某天改了其中一个的归一方式，就会出现
 * 「分组说这里有 35 处，点开只描出 30 个」这种自相矛盾，而且差得不多，
 * 看起来只像漏了几处。
 *
 * 三个缺省值的口径与采集层对齐：边数读不到时按四边算（有四条边才构成
 * 一个完整的框），线型缺省 solid，颜色读不到时按无色。
 */
export function borderKeyOf(s: StyleObservation): BorderKey | null {
  const width = round1(numOf(s.borderWidth));
  if (width <= 0) return null;
  const sides = typeof s.borderSides === 'number' && s.borderSides > 0 ? s.borderSides : 4;
  const style = typeof s.borderStyle === 'string' && s.borderStyle ? s.borderStyle : 'solid';
  const color = typeof s.borderColor === 'string' && s.borderColor ? s.borderColor : null;
  return { key: borderKey(width, sides, style, color), width, sides, style, color };
}

/** 从分组的展示字段还原同一个键。溯源按组回找元素时用它 */
export function borderKeyOfGroup(g: BorderGroup): string {
  return borderKey(g.width, g.sides, g.style, g.color);
}

function borderKey(width: number, sides: number, style: string, color: string | null): string {
  return `${width}|${sides}|${style}|${color ?? ''}`;
}

/**
 * 投影的口语说明。
 *
 * 分三段说：模糊多大（决定它看起来是贴着还是飘着）、往哪边投（决定
 * 光源方向，同一页面上方向一致才自然）、用来干什么（照抄时该放在哪类
 * 元素上）。只给一串数字的话，读的人不知道 0 1 2 和 0 4 12 的区别在哪。
 */
function describeShadow(layers: ShadowLayer[]): string {
  const first = layers[0];
  if (!first) return '';

  const anyInset = layers.some((l) => l.inset);
  const maxBlur = layers.reduce((m, l) => (l.blur > m ? l.blur : m), 0);
  const maxSpread = layers.reduce((m, l) => (l.spread > m ? l.spread : m), 0);

  const parts: string[] = [];

  if (anyInset) {
    parts.push(
      '内投影，让容器看起来是凹进去的。一般只用在输入框、按下的按钮和凹陷的容器上，' +
        '用在卡片上会跟页面其它部分不是一套语言。',
    );
  } else {
    if (maxBlur === 0) {
      parts.push('没有模糊的硬边投影，边缘是一条清晰的线，视觉上更像一圈描边而不是影子。');
    } else if (maxBlur <= 6) {
      parts.push('贴边的小范围投影，只能把元素从背景上轻轻托起一点，克制、不抢注意力，是卡片最常用的一档。');
    } else if (maxBlur <= 24) {
      parts.push('中等柔和度的投影，能明显看出元素和背景之间隔着一层，卡片和下拉面板都用得住。');
    } else {
      parts.push('大范围的柔和投影，用于弹窗、抽屉这类要压住下方内容的浮层。大面积投影不要用在普通卡片上，会显得脏。');
    }

    // 方向只对非内投影有意义，内投影没有光源方向这个概念
    const dx = first.offsetX;
    const dy = first.offsetY;
    if (Math.abs(dx) <= 1 && dy === 0) {
      parts.push('四周均匀没有偏移，看起来像元素整体浮起来。');
    } else {
      const horizontal = Math.abs(dx) > Math.abs(dy);
      const amount = Math.abs(horizontal ? dx : dy);
      const dir = horizontal ? (dx > 0 ? '右' : '左') : (dy > 0 ? '下' : '上');
      parts.push(`朝${dir}偏移 ${round1(amount)}px，等于把光源定在了反方向。同一个页面上所有投影的方向要一致。`);
    }
  }

  if (maxSpread > 0) parts.push(`比元素本身大出 ${maxSpread}px，影子会比元素轮廓宽一圈。`);
  if (layers.length > 1) parts.push(`由 ${layers.length} 层叠加而成，比单层更容易做得自然，可以照抄整串。`);

  return parts.join('');
}

// ---------------------------------------------------------------------
// 圆角
// ---------------------------------------------------------------------

function describeRadiusUsage(kind: StyleElementKind, value: number, count: number): string {
  const size =
    value >= 100
      ? '胶囊形，两端是半圆'
      : value <= 4
        ? '接近直角，克制、偏工具感'
        : value <= 8
          ? '小圆角，含蓄但能软化边缘'
          : value <= 16
            ? '中等偏大的圆角，看起来更柔和'
            : '很大的圆角，接近胶囊，视觉上很软';

  const target =
    kind === 'button'
      ? '按钮'
      : kind === 'input'
        ? '输入框'
        : kind === 'card'
          ? '卡片'
          : kind === 'nav'
            ? '导航栏'
            : '这一类元素';

  return `${target}用的是${radiusTextOf(value)}，${size}。这一类里带圆角的元素有 ${count} 个。`;
}

// ---------------------------------------------------------------------
// 边框
// ---------------------------------------------------------------------

const BORDER_STYLE_LABEL: Record<string, string> = {
  solid: '实线',
  dashed: '虚线',
  dotted: '点线',
  double: '双线',
  groove: '凹槽线',
  ridge: '凸起线',
  inset: '内嵌线',
  outset: '外凸线',
};

function describeBorderUsage(width: number, sides: number, style: string): string {
  const styleText = BORDER_STYLE_LABEL[style] ?? style;

  const sidesText =
    sides >= 4
      ? '四边都描了边，是一个完整的框。输入框、卡片和需要明确边界的容器用这种。'
      : sides === 1
        ? '只有一条边有描边，这实际上是分割线，不要理解成给元素加了边框。分割线只用来分区，不承担元素边界。'
        : `只有 ${sides} 条边有描边，是强调某一侧的写法（常见于列表项之间有分隔、上下不留线）。`;

  return `${width}px ${styleText}，${sidesText}`;
}

/**
 * 把一条原始 box-shadow 归一成分组用的签名和可直接粘贴的写法。
 *
 * 两个返回值一起给，是因为它们必须出自同一批图层：签名用来归组，
 * css 用来展示。分开算两遍，某天改了其中一个的归一规则，就会出现
 * 「分组的键说这是同一组，展示出来的写法却不一样」这种自相矛盾。
 *
 * 导出给溯源用。界面上「3 处投影」那一行要点出是哪 3 个元素，
 * 判据只能是这个函数；另写一遍归一，两边的分组会在数值写法的差异上错开。
 */
export function shadowSignatureOf(
  raw: string,
): { key: string; css: string; layers: ShadowLayer[] } | null {
  const layers = parseShadow(raw);
  if (layers.length === 0) return null;
  return {
    key: layers.map(layerKey).join(' | '),
    css: layers.map(layerCss).join(', '),
    layers,
  };
}

/**
 * 从分组里的图层还原同一个键。溯源按组回找元素时用它。
 *
 * 不拿分组的 css 串去比，虽然两者都由同一批图层算出来。分组说的是
 * 「键相同」，而 css 是用来给人看的写法，用展示字段做等同判断等于把
 * 两件事绑在一起，日后改了展示格式就会连带影响分组。
 */
export function shadowKeyOfGroup(layers: ShadowLayer[]): string {
  return layers.map(layerKey).join(' | ');
}

// ---------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------

function emptyAnalysis(): EffectsAnalysis {
  return {
    radii: [],
    borders: [],
    shadows: [],
    usesShadow: false,
    notes: [],
    sampleCount: 0,
  };
}

/**
 * 圆角、边框、投影的提取。
 *
 * 三段都用同一条 styles 通道，这样「用在哪些元素上」才说得准。
 * 这条通道是按元素记的，每条都带着元素自己的角色分类，可以按角色聚合；
 * 而颜色、间距、排版三条通道的元素序列互不重合，事后对不回同一个元素。
 */
export function analyzeEffects(sample: PageSample): EffectsAnalysis {
  const styles = Array.isArray(sample.styles) ? sample.styles : [];
  const viewportWidth =
    typeof sample.viewportWidth === 'number' && Number.isFinite(sample.viewportWidth)
      ? sample.viewportWidth
      : 0;
  if (styles.length === 0) {
    return {
      ...emptyAnalysis(),
      notes: [
        {
          kind: 'no-shadow',
          text: '没有读到任何可判断的元素样式，这一页的圆角、边框和投影都无法给出。页面主体可能渲染在图片或 canvas 里。',
        },
      ],
    };
  }

  // --- 1. 圆角，按元素类型分组 ----------------------------------------
  //
  // 归组前先把采集层的粗分类细分一档。徽标、头像、色块这些「有表面的小
  // 东西」在采集层和卡片是同一类，而它们的圆角几乎必然是胶囊，混进卡片
  // 那一组会把卡片的圆角结论整个带偏。细分判据与组件识别共用一条，
  // 见 observation.ts。
  const radiusByKind = new Map<StyleElementKind, Map<number, number>>();
  for (const s of styles) {
    if (!s) continue;
    const r = typeof s.radius === 'number' && Number.isFinite(s.radius) ? s.radius : 0;
    if (r <= 0) continue;
    const key = radiusKeyOf(r);
    const kind = refineKind(s, viewportWidth);
    let bucket = radiusByKind.get(kind);
    if (!bucket) {
      bucket = new Map<number, number>();
      radiusByKind.set(kind, bucket);
    }
    bucket.set(key, (bucket.get(key) ?? 0) + 1);
  }

  const radii: RadiusByKind[] = [];
  let radiusElementCount = 0;
  for (const kind of KIND_ORDER) {
    const bucket = radiusByKind.get(kind);
    if (!bucket || bucket.size === 0) continue;

    const sorted = [...bucket.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    const top = sorted[0];
    if (!top) continue;

    let count = 0;
    for (const e of bucket) count += e[1];
    radiusElementCount += count;

    radii.push({
      kind,
      label: KIND_LABEL[kind],
      radius: top[0],
      others: sorted.slice(1, 1 + MAX_RADIUS_VARIANTS).map((e) => e[0]),
      count,
      usage: describeRadiusUsage(kind, top[0], count),
    });
  }

  // --- 2. 边框 --------------------------------------------------------
  const borderAcc = new Map<
    string,
    { width: number; sides: number; style: string; color: string | null; count: number; kinds: Set<StyleElementKind> }
  >();

  for (const s of styles) {
    if (!s) continue;
    const info = borderKeyOf(s);
    if (!info) continue;

    let acc = borderAcc.get(info.key);
    if (!acc) {
      acc = {
        width: info.width,
        sides: info.sides,
        style: info.style,
        color: info.color,
        count: 0,
        kinds: new Set(),
      };
      borderAcc.set(info.key, acc);
    }
    acc.count++;
    acc.kinds.add(refineKind(s, viewportWidth));
  }

  let borders: BorderGroup[] = [...borderAcc.values()]
    .filter((b) => b.count >= MIN_GROUP_COUNT)
    .sort((a, b) => b.count - a.count)
    .map((b) => ({
      width: b.width,
      sides: b.sides,
      style: b.style,
      color: b.color,
      count: b.count,
      kinds: KIND_ORDER.filter((k) => b.kinds.has(k)),
      usage: describeBorderUsage(b.width, b.sides, b.style),
    }));

  if (borders.length > MAX_BORDER_GROUPS) borders = borders.slice(0, MAX_BORDER_GROUPS);

  // --- 3. 投影 --------------------------------------------------------
  const shadowAcc = new Map<
    string,
    { css: string; layers: ShadowLayer[]; count: number; kinds: Set<StyleElementKind> }
  >();
  let shadowElements = 0;

  for (const s of styles) {
    if (!s) continue;
    const raw = typeof s.shadow === 'string' ? s.shadow : null;
    if (!raw) continue;
    const sig = shadowSignatureOf(raw);
    if (!sig) continue;
    shadowElements++;

    let acc = shadowAcc.get(sig.key);
    if (!acc) {
      acc = { css: sig.css, layers: sig.layers, count: 0, kinds: new Set() };
      shadowAcc.set(sig.key, acc);
    }
    acc.count++;
    acc.kinds.add(refineKind(s, viewportWidth));
  }

  let shadows: ShadowGroup[] = [...shadowAcc.values()]
    .filter((g) => g.count >= MIN_GROUP_COUNT)
    .sort((a, b) => b.count - a.count)
    .map((g) => ({
      css: g.css,
      layers: g.layers,
      count: g.count,
      kinds: KIND_ORDER.filter((k) => g.kinds.has(k)),
      usage: describeShadow(g.layers),
    }));

  if (shadows.length > MAX_SHADOW_GROUPS) shadows = shadows.slice(0, MAX_SHADOW_GROUPS);

  // --- 4. 需要明确说出来的情况 ----------------------------------------
  const usesShadow = shadowElements > 0;
  const notes: EffectsNote[] = [];

  if (!usesShadow) {
    // 这一条是硬要求，不能被当成「这一块没数据」跳过。不写出来的话，
    // 读文件的人会自己补一个默认阴影，而原设计恰恰是靠背景和描边分层的。
    notes.push({
      kind: 'no-shadow',
      text:
        '这个页面完全没有使用投影。所有层次都靠背景色、边框和间距区分，没有一处靠影子。' +
        '复刻时不要给卡片和按钮补默认阴影，那是另一种设计语言，加了就与原页面不是一套。',
    });
  }

  if (borders.length === 0) {
    notes.push({
      kind: 'no-border',
      text:
        '页面没有使用任何边框。分隔完全靠背景色差和留白完成。' +
        '复刻时也不要用描边去代替底色，那样会把分区变重。',
    });
  }

  if (radii.length === 0) {
    notes.push({
      kind: 'no-radius',
      text:
        '页面没有使用任何圆角，所有边角都是直角。这是一套偏工具感、偏严肃的视觉语言，' +
        '复刻时不要顺手加圆角。',
    });
  }

  if (styles.length < THIN_SAMPLE) {
    notes.push({
      kind: 'thin-sample',
      text: `只采到 ${styles.length} 个带边框、投影或圆角的元素，样本偏少，这几项结论需要人工过一眼再采用。`,
    });
  }

  return {
    radii,
    borders,
    shadows,
    usesShadow,
    notes,
    sampleCount: styles.length,
  };
}

/** 与界面共用同一套圆角写法，避免弹窗里再实现一遍「胶囊」这个词 */
export function radiusLabel(value: number): string {
  return radiusTextOf(value);
}
