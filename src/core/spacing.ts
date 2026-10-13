import type { BoxObservation, PageSample } from './types';

/**
 * 一个间距档位至少要被这么多个元素用到，才有资格立为档位。
 *
 * 门槛定在 2 而不是 3，是因为大间距天然用得少。4px 的内边距可能出现在
 * 几十个元素上，而 64px 的区块间距在一个页面上往往只有两三处，按次数
 * 一刀切会把最大的那几档全部砍掉，而那恰恰是「区块之间的间距」这一项
 * 最需要的证据。真正该被挡在外面的是只出现一次的偶然值，2 足够了。
 */
export const MIN_STEP_COUNT = 2;

/** 参与基础单位推断的最小间距值，px。1px 及以下通常是描边而不是间距 */
export const MIN_SPACING = 2;

/**
 * 判定一个间距值落在基础单位整数倍上的容差，px。
 *
 * 只用来吸收浏览器算出来的浮点误差：rem 折算出来的 3.999999 要能归到 4，
 * 而 13 这类真的不在网格上的值必须留在网格外。
 *
 * 这个值不能放大到 1。基础单位为 4 时，容差 1 意味着 4k±1 全部算命中，
 * 13 会被吸进 12、17 被吸进 16、23 被吸进 24，等于把「不规律的偶发值」
 * 整类放行，档位立刻退化成数值罗列。半像素是既能收拢浮点误差、
 * 又不会误伤相邻整数的位置。
 */
const SNAP_TOLERANCE = 0.5;

/**
 * 基础单位的候选，从大到小试。
 *
 * 顺序按「具体程度」排，先试大的，命中即止。这样「所有间距都是 16 的
 * 倍数」会得到 16 而不是被 8 抢走，而 8 网格的页面里 12、20 这些不是
 * 8 倍数的值会把覆盖率压下去，自然落到 4。取向是宁可说得具体，
 * 也不要含糊地报一个 4 完事。
 */
const BASE_CANDIDATES = [16, 12, 10, 8, 6, 4];

/**
 * 兜底候选。主候选全部达不到覆盖率时才启用，并且强制把置信度压到最低。
 *
 * 一个页面的间距体系如果只能被 2 或 3 整除，说明它其实没有体系，
 * 只是恰好都是偶数或三的倍数。这种情况必须如实标注，不能硬报一个
 * 「基础单位 2」出去。
 */
const FALLBACK_BASES = [3, 2];

/** 落在基础单位倍数上的间距占比达到这个值，才认定它就是这个页面的基础单位 */
const BASE_COVERAGE = 0.8;

/** 内容宽度至少要这么宽才可能是内容容器，px。窄于此的多半是侧栏或卡片 */
const MIN_CONTENT_WIDTH = 320;

/** 内容宽度的众数至少出现这么多次，才认为页面确实有一个统一的内容宽度 */
const MIN_CONTENT_WIDTH_COUNT = 2;

/**
 * 全宽容器与视口宽度的容差，px。
 *
 * window.innerWidth 含滚动条宽度，而 getBoundingClientRect 拿到的是
 * 不含滚动条的内容区宽度，两者通常差十几像素。判断「这个容器是不是
 * 铺满全宽」时要留出这个余量，否则滚动条一出现，全宽容器就会被
 * 误认成一个 1425px 的内容宽度。
 */
const FULL_WIDTH_TOLERANCE = 24;

/** 圆角超过这个值一律按胶囊处理。999 / 9999 / 99999 三种写法的语义完全相同 */
export const PILL_RADIUS = 100;

/** 判定为区块间距的最小值，px。比这更小的间距只可能是元素内部的 */
const SECTION_GAP_MIN = 16;

/** 最多输出多少个间距档位。超出的按使用量从少到多砍掉 */
const MAX_STEPS = 10;

// ---------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------

/** 一个间距值是从哪个属性上读到的 */
export type SpacingSource = 'padding' | 'gap' | 'margin';

export const SOURCE_LABEL: Record<SpacingSource, string> = {
  padding: '内边距',
  gap: '子项间距',
  margin: '外边距',
};

export interface SpacingStep {
  /** 间距值，px */
  value: number;
  /**
   * 被吸附进这一档的其余原始值，px。不含 value 本身。
   *
   * 吸附会把 15.5 收进 16、3.9 收进 4，界面上只显示吸附后的那一个，
   * 而页面上真实写着的是这些值。溯源高亮要按「value 加 mergedFrom」
   * 这个合集去认元素，只按 value 认会漏掉被吸上来的那一半。
   */
  mergedFrom: number[];
  /** 折合几个基础单位。基础单位未确定时为 0 */
  units: number;
  /** 页面上有多少个元素用了这个值 */
  count: number;
  /** 这些出现分别来自哪些属性 */
  sources: SpacingSource[];
  /** 用途说明，会直接写进生成的文件 */
  usage: string;
  confidence: 'high' | 'medium' | 'low';
}

export interface DiscardedSpacing {
  value: number;
  /**
   * 被吸附进这个值的其余原始值，px。不含 value 本身。含义同 SpacingStep.mergedFrom。
   *
   * 有的丢弃项是在吸附之后才被判掉的（只出现一次的那一档），这时候界面上
   * 写的是吸附后的值，而页面上真实写着的是原始值，两者差着这一串。
   */
  mergedFrom: number[];
  count: number;
  reason: string;
}

export interface RadiusStep {
  /** 圆角半径，px。胶囊统一归到 PILL_RADIUS */
  value: number;
  count: number;
  /** 用途说明 */
  usage: string;
}

export interface CardPadding {
  /** 水平内边距，px */
  x: number;
  /** 垂直内边距，px */
  y: number;
  /** 命中判定的卡片元素数 */
  sampleCount: number;
}

export type SpacingNoteKind =
  | 'no-base-unit'
  | 'irregular'
  | 'few-steps'
  | 'no-content-width'
  | 'no-section-gap'
  | 'thin-sample';

export interface SpacingNote {
  kind: SpacingNoteKind;
  text: string;
}

export interface SpacingAnalysis {
  /** 推断出的基础单位，px。无法确定时为 null */
  baseUnit: number | null;
  baseUnitConfidence: 'high' | 'medium' | 'low';
  /** 落在基础单位倍数上的间距占比，0-1 */
  baseCoverage: number;
  /** 间距档位，按值升序 */
  steps: SpacingStep[];
  /** 判定为不规律、没有立为档位的间距值 */
  discarded: DiscardedSpacing[];
  /** 内容最大宽度，px。未检出为 null */
  contentMaxWidth: number | null;
  /** 内容宽度的来源说明 */
  contentWidthNote: string | null;
  /** 卡片内边距 */
  cardPadding: CardPadding | null;
  /** 区块之间的间距，px */
  sectionGap: number | null;
  /** 圆角档位，按值升序 */
  radii: RadiusStep[];
  notes: SpacingNote[];
  /** 去重后的原始间距值个数，与 steps 之差就是降噪幅度 */
  rawValueCount: number;
}

// ---------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------

interface ValueAcc {
  value: number;
  /** 元素级计数。同一个元素里四边 padding 都是 16 时只算一次 */
  count: number;
  paddingCount: number;
  gapCount: number;
  marginCount: number;
}

/**
 * 四边数值的安全读取。
 *
 * 这些值穿过一次 executeScript 的序列化边界，理论上可能是数组、可能是
 * 长度不足的数组、也可能整个缺失。分析层不能假定它一定完好，
 * 否则一个残缺的字段就能让整个分析抛错。
 */
function sidesOf(input: unknown): [number, number, number, number] {
  const arr = Array.isArray(input) ? input : [];
  const num = (i: number): number => {
    const n = arr[i];
    return typeof n === 'number' && Number.isFinite(n) ? n : 0;
  };
  return [num(0), num(1), num(2), num(3)];
}

function bump(map: Map<number, number>, key: number, by: number): void {
  map.set(key, (map.get(key) ?? 0) + by);
}

/**
 * 一个间距值进入统计前的归一与门槛。够格就返回归一后的值，不够格返回 null。
 *
 * 导出给 provenance.ts 用。界面上写着「16px 这一档出现 47 处」，点开之后
 * 描出来的也必须是 47 个元素，而「一个元素里四边同值只算一次」「小于 2px
 * 不算间距」「保留一位小数」这三条口径必须在两处完全一致才做得到。
 * 差一处的结果是少描一两个元素，看起来只像漏了一处。
 */
export function spacingKeyOf(value: number): number | null {
  if (!Number.isFinite(value) || Math.abs(value) < MIN_SPACING) return null;
  return Math.round(value * 10) / 10;
}

/**
 * 圆角进入统计前的归一与门槛。含义同上，用在盒模型通道上。
 *
 * 和 observation.ts 的 radiusKeyOf 只差一道最小间距门槛：那边的圆角来自
 * 带边框或投影的元素，凡是读到就都是有效值；这边来自盒模型通道，小于 2px
 * 的圆角在版面上等于直角，不参与圆角体系。
 */
export function radiusBucketOf(value: number): number | null {
  if (!Number.isFinite(value) || value < MIN_SPACING) return null;
  return value >= PILL_RADIUS ? PILL_RADIUS : Math.round(value);
}

/** 取权值最大的键。平票时取更小的键，小的间距更可能是体系里的基础档 */
function topEntry(map: Map<number, number>): [number, number] | null {
  let best: [number, number] | null = null;
  for (const e of map) {
    if (!best || e[1] > best[1] || (e[1] === best[1] && e[0] < best[0])) best = [e[0], e[1]];
  }
  return best;
}

/**
 * 一个值是否落在基础单位的整数倍上。
 *
 * 用绝对值取模，负外边距也要参与判定；判定本身不受符号影响，
 * 剔除负值是后面吸附那一步的事。
 */
function onGrid(value: number, base: number): boolean {
  const r = Math.abs(value) % base;
  return r <= SNAP_TOLERANCE || base - r <= SNAP_TOLERANCE;
}

// ---------------------------------------------------------------------
// 档位说明
// ---------------------------------------------------------------------

/**
 * 按相对大小判断这一档在页面上扮演什么角色。
 *
 * 不按绝对像素值硬编（「24px 就是卡片内边距」这类）。同样的 24px，
 * 在一个紧凑的控制台里是最大的区块间距，在一个宽松的营销页上只是
 * 卡片内边距。用相对位置判断才能两种情况都说对。
 */
function spacingRole(value: number, maxValue: number): string {
  if (value <= 4) {
    return '最紧的一档，用于图标与文字之间、紧挨着的按钮这类必须贴住的地方';
  }
  const ratio = maxValue > 0 ? value / maxValue : 0;
  if (ratio <= 0.2) return '小幅留白，控件内部、标签与数值之间';
  if (ratio <= 0.45) return '常用档，控件内边距和表单字段之间的间隔';
  if (ratio <= 0.7) return '中等留白，列表项之间和卡片内边距';
  if (ratio <= 0.9) return '较大留白，卡片之间、内容块之间的分隔';
  return '页面级留白，用于大区块之间的呼吸空间';
}

function describeSpacing(
  value: number,
  units: number,
  count: number,
  sources: SpacingSource[],
  maxValue: number,
  baseUnit: number | null,
): string {
  const srcText = sources.map((s) => SOURCE_LABEL[s]).join('、');
  const unitText = baseUnit !== null && units > 0 ? `折合 ${units} 个基础单位，` : '';
  return `${unitText}${spacingRole(value, maxValue)}。页面上作为${srcText}出现 ${count} 处。`;
}

function describeRadius(value: number): string {
  if (value >= PILL_RADIUS) return '胶囊圆角，用于标签、开关和主按钮';
  if (value <= 4) return '小圆角，用在输入框和内层容器这种需要克制的地方';
  if (value <= 8) return '中等圆角，按钮和卡片的常用档';
  if (value <= 16) return '大圆角，用于大卡片和弹窗';
  return '极大圆角，接近胶囊，一般用在装饰性容器上';
}

// ---------------------------------------------------------------------
// 各分项
// ---------------------------------------------------------------------

interface StepAcc {
  value: number;
  count: number;
  paddingCount: number;
  gapCount: number;
  marginCount: number;
  /** 被吸附上来的原始值，用于说明这一档实际覆盖了哪些写法 */
  mergedFrom: number[];
}

function sourcesOf(acc: StepAcc): SpacingSource[] {
  const out: SpacingSource[] = [];
  if (acc.paddingCount > 0) out.push('padding');
  if (acc.gapCount > 0) out.push('gap');
  if (acc.marginCount > 0) out.push('margin');
  return out;
}

/**
 * 内容最大宽度。
 *
 * 两条路取，优先 max-width。理由是 max-width 是作者亲手写下的约束，
 * 语义就是「内容最宽到这里」；而元素的实际宽度是布局的结果，可能被
 * 视口、兄弟元素、flex 分配影响，读出来的是一个结果值而不是意图值。
 *
 * 只有在页面完全没用 max-width 时才退回看实际宽度，这时取出现次数
 * 最多的那个宽度：一个页面若有统一的内容宽度，会有一批区块同时落在
 * 这个值上，众数能把它捞出来。
 */
function pickContentWidth(
  boxes: BoxObservation[],
  viewportWidth: number,
): { width: number | null; note: string | null } {
  const maxWidthCount = new Map<number, number>();
  const widthCount = new Map<number, number>();

  for (const b of boxes) {
    const mw = typeof b.maxWidth === 'number' && Number.isFinite(b.maxWidth) ? b.maxWidth : null;
    if (mw !== null && mw >= MIN_CONTENT_WIDTH) {
      // 比视口还宽的 max-width 起不到限制作用，不构成内容宽度
      if (viewportWidth <= 0 || mw <= viewportWidth) bump(maxWidthCount, Math.round(mw), 1);
    }

    const w = typeof b.width === 'number' && Number.isFinite(b.width) ? b.width : 0;
    if (w >= MIN_CONTENT_WIDTH) {
      const rounded = Math.round(w);
      const isFullWidth = viewportWidth > 0 && rounded >= viewportWidth - FULL_WIDTH_TOLERANCE;
      if (!isFullWidth) bump(widthCount, rounded, 1);
    }
  }

  const maxW = topEntry(maxWidthCount);
  const boxW = topEntry(widthCount);

  if (maxW && maxW[1] >= MIN_CONTENT_WIDTH_COUNT) {
    return {
      width: maxW[0],
      note: `页面有 ${maxW[1]} 个容器把 max-width 设成了同一个值，这就是内容区的最大宽度。它是作者写下的约束，复刻时直接照用。`,
    };
  }
  if (boxW && boxW[1] >= MIN_CONTENT_WIDTH_COUNT) {
    return {
      width: boxW[0],
      note: `页面没有统一设置 max-width，但有 ${boxW[1]} 个区块的实际宽度都是这个值，内容区就是按这个宽度排的。复刻时写成 max-width 更稳，可以避免视口变宽后内容被拉散。`,
    };
  }
  if (maxW) {
    return {
      width: maxW[0],
      note: '只在一个容器上读到 max-width，没有第二处印证，这个数字可能只是某个局部容器而不是整页的内容宽度。',
    };
  }
  return { width: null, note: null };
}

/**
 * 卡片内边距。取水平、垂直两个方向的众数，而不是四边的平均值。
 *
 * 只统计非控件的元素。looksLikeCard 回答的是「视觉上像不像一块表面」，
 * 导航链接和按钮一样有底色和圆角，同样会命中它，但它们的「内边距」
 * 是控件内边距。实测过一个页面，四条导航链接的 padding 是 8px 12px，
 * 数量压过了三张真正的卡片，卡片内边距就被报成了 12 / 8。
 */
function pickCardPadding(boxes: BoxObservation[]): CardPadding | null {
  const xCount = new Map<number, number>();
  const yCount = new Map<number, number>();
  let cards = 0;

  for (const b of boxes) {
    if (!b.looksLikeCard) continue;
    if (b.isControl) continue;
    cards++;
    const [top, right, bottom, left] = sidesOf(b.padding);
    // 左右取较大的那个。四边相等的卡片占多数，这一步等价于直接取值；
    // 左右不等时大的那一边更能代表卡片的视觉内边距。
    const x = Math.max(left, right);
    const y = Math.max(top, bottom);
    if (x > 0) bump(xCount, Math.round(x), 1);
    if (y > 0) bump(yCount, Math.round(y), 1);
  }

  if (cards === 0) return null;
  const x = topEntry(xCount);
  if (!x) return null;
  const y = topEntry(yCount);

  return { x: x[0], y: y ? y[0] : x[0], sampleCount: cards };
}

/**
 * 区块之间的间距。
 *
 * 优先看 flex / grid 容器的子项间距，并且只在较大的那一档里取众数。
 * 原因是一个页面上 gap 的取值是分层的：8px 用于导航项之间、24px 用于
 * 卡片之间、64px 用于大区块之间。不分层直接取众数，几乎必然取到最小的
 * 那个，得到的就不是「区块间距」而是「控件间距」。
 *
 * 页面完全不用 gap 时才退回语义区块元素的垂直外边距，那是老式的
 * 分块写法，用的同样是上下 margin。
 */
function pickSectionGap(boxes: BoxObservation[]): number | null {
  const gapCount = new Map<number, number>();
  for (const b of boxes) {
    const g = typeof b.gap === 'number' && Number.isFinite(b.gap) ? b.gap : null;
    if (g !== null && g >= MIN_SPACING) bump(gapCount, Math.round(g), 1);
  }

  let large: [number, number] | null = null;
  for (const e of gapCount) {
    if (e[0] < SECTION_GAP_MIN) continue;
    // 平票时取更大的那个。一个页面上大间距往往各自的容器只有一个
    // （主内容区一个、页脚一个），次数打平是常态，而这两档里更大的
    // 那一档才代表整页的呼吸节奏。取小的会退回到卡片间距上去。
    if (!large || e[1] > large[1] || (e[1] === large[1] && e[0] > large[0])) large = e;
  }
  if (large) return large[0];

  const marginCount = new Map<number, number>();
  for (const b of boxes) {
    if (!b.isLandmark) continue;
    const [top, , bottom] = sidesOf(b.margin);
    if (top >= SECTION_GAP_MIN) bump(marginCount, Math.round(top), 1);
    if (bottom >= SECTION_GAP_MIN) bump(marginCount, Math.round(bottom), 1);
  }
  const m = topEntry(marginCount);
  return m ? m[0] : null;
}

// ---------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------

export function analyzeSpacing(sample: PageSample): SpacingAnalysis {
  const empty: SpacingAnalysis = {
    baseUnit: null,
    baseUnitConfidence: 'low',
    baseCoverage: 0,
    steps: [],
    discarded: [],
    contentMaxWidth: null,
    contentWidthNote: null,
    cardPadding: null,
    sectionGap: null,
    radii: [],
    notes: [],
    rawValueCount: 0,
  };

  // 采集结果穿过一次序列化边界，字段可能整体缺失，先兜住再往下走
  const boxes = Array.isArray(sample.boxes) ? sample.boxes : [];
  if (boxes.length === 0) return empty;

  const viewportWidth =
    typeof sample.viewportWidth === 'number' && Number.isFinite(sample.viewportWidth)
      ? sample.viewportWidth
      : 0;

  // --- 1. 按值累计证据 ------------------------------------------------
  //
  // 同一个元素里四边 padding 都是 16，只算一次。不这么做的话
  // 「padding: 16px」这一个写法就会被记成四条证据，把别的值全压下去。
  const valueAcc = new Map<number, ValueAcc>();

  for (const b of boxes) {
    if (!b) continue;
    const seen = new Set<number>();

    const record = (value: number, source: SpacingSource): void => {
      const key = spacingKeyOf(value);
      if (key === null) return;

      let acc = valueAcc.get(key);
      if (!acc) {
        acc = { value: key, count: 0, paddingCount: 0, gapCount: 0, marginCount: 0 };
        valueAcc.set(key, acc);
      }

      if (source === 'padding') acc.paddingCount++;
      else if (source === 'gap') acc.gapCount++;
      else acc.marginCount++;

      if (!seen.has(key)) {
        seen.add(key);
        acc.count++;
      }
    };

    const [padTop, padRight, padBottom, padLeft] = sidesOf(b.padding);
    record(padTop, 'padding');
    record(padRight, 'padding');
    record(padBottom, 'padding');
    record(padLeft, 'padding');

    const [marTop, marRight, marBottom, marLeft] = sidesOf(b.margin);
    record(marTop, 'margin');
    record(marRight, 'margin');
    record(marBottom, 'margin');
    record(marLeft, 'margin');

    if (typeof b.gap === 'number') record(b.gap, 'gap');
  }

  if (valueAcc.size === 0) return empty;

  const rawValueCount = valueAcc.size;
  const entries = [...valueAcc.values()];
  const totalWeight = entries.reduce((sum, e) => sum + e.count, 0);

  // --- 2. 基础单位推断 ------------------------------------------------
  const coverageOf = (base: number): number => {
    let hit = 0;
    for (const e of entries) {
      if (onGrid(e.value, base)) hit += e.count;
    }
    return totalWeight > 0 ? hit / totalWeight : 0;
  };

  let baseUnit: number | null = null;
  let baseCoverage = 0;
  let fromFallback = false;

  for (const base of BASE_CANDIDATES) {
    const coverage = coverageOf(base);
    if (coverage >= BASE_COVERAGE) {
      baseUnit = base;
      baseCoverage = coverage;
      break;
    }
  }
  if (baseUnit === null) {
    for (const base of FALLBACK_BASES) {
      const coverage = coverageOf(base);
      if (coverage >= BASE_COVERAGE) {
        baseUnit = base;
        baseCoverage = coverage;
        fromFallback = true;
        break;
      }
    }
  }

  const baseUnitConfidence: 'high' | 'medium' | 'low' =
    baseUnit === null || fromFallback
      ? 'low'
      : baseCoverage >= 0.95
        ? 'high'
        : baseCoverage >= 0.85
          ? 'medium'
          : 'low';

  // --- 3. 吸附成档位，不规律的记为丢弃 --------------------------------
  const stepAcc = new Map<number, StepAcc>();
  const discarded: DiscardedSpacing[] = [];
  let irregularWeight = 0;
  let irregularValues = 0;

  for (const e of entries) {
    // 没有基础单位时，值本身就是档位，谈不上吸不吸附
    let target = e.value;

    if (baseUnit !== null) {
      if (!onGrid(e.value, baseUnit)) {
        irregularWeight += e.count;
        irregularValues++;
        discarded.push({
          value: e.value,
          mergedFrom: [],
          count: e.count,
          reason: `不是基础单位 ${baseUnit} 的倍数，判定为个别调整`,
        });
        continue;
      }
      target = Math.round(e.value / baseUnit) * baseUnit;
    }

    if (target < MIN_SPACING) {
      discarded.push({
        value: e.value,
        mergedFrom: [],
        count: e.count,
        reason: e.value < 0 ? '负间距，属于个别重叠处理，不纳入间距体系' : '小于最小间距',
      });
      continue;
    }

    let acc = stepAcc.get(target);
    if (!acc) {
      acc = {
        value: target,
        count: 0,
        paddingCount: 0,
        gapCount: 0,
        marginCount: 0,
        mergedFrom: [],
      };
      stepAcc.set(target, acc);
    }
    acc.count += e.count;
    acc.paddingCount += e.paddingCount;
    acc.gapCount += e.gapCount;
    acc.marginCount += e.marginCount;
    if (e.value !== target) acc.mergedFrom.push(e.value);
  }

  // 出现次数不足的档位也要说明去向，否则用户会以为工具漏读了
  let kept = [...stepAcc.values()].sort((a, b) => a.value - b.value);
  const enough = kept.filter((s) => s.count >= MIN_STEP_COUNT);
  for (const s of kept) {
    if (s.count < MIN_STEP_COUNT) {
      discarded.push({
        value: s.value,
        mergedFrom: [...s.mergedFrom],
        count: s.count,
        reason: '只出现在 1 个元素上，判定为一次性数值',
      });
    }
  }
  kept = enough;

  if (kept.length > MAX_STEPS) {
    const byCount = [...kept].sort((a, b) => b.count - a.count);
    for (const s of byCount.slice(MAX_STEPS)) {
      discarded.push({
        value: s.value,
        mergedFrom: [...s.mergedFrom],
        count: s.count,
        reason: `页面共 ${kept.length} 个间距档位，只保留使用最多的 ${MAX_STEPS} 档`,
      });
    }
    const keepSet = new Set(byCount.slice(0, MAX_STEPS).map((s) => s.value));
    kept = kept.filter((s) => keepSet.has(s.value));
  }

  const maxValue = kept.reduce((m, s) => (s.value > m ? s.value : m), 0);

  const steps: SpacingStep[] = kept.map((s) => {
    const units = baseUnit !== null ? Math.round(s.value / baseUnit) : 0;
    let confidence: 'high' | 'medium' | 'low' = 'medium';
    if (baseUnitConfidence === 'low') confidence = 'low';
    else if (baseUnitConfidence === 'high' && s.count >= 5) confidence = 'high';

    return {
      value: s.value,
      mergedFrom: [...s.mergedFrom],
      units,
      count: s.count,
      sources: sourcesOf(s),
      usage: describeSpacing(s.value, units, s.count, sourcesOf(s), maxValue, baseUnit),
      confidence,
    };
  });

  discarded.sort((a, b) => b.count - a.count);

  // --- 4. 圆角档位 ----------------------------------------------------
  const radiusCount = new Map<number, number>();
  for (const b of boxes) {
    // 胶囊的三种写法归一。不归一会得到 999 和 9999 两个档位，
    // 而它们在视觉上完全没有区别。归一和门槛都在 radiusBucketOf 里，
    // 溯源按同一个函数回找元素
    const bucket = radiusBucketOf(typeof b.radius === 'number' ? b.radius : 0);
    if (bucket === null) continue;
    bump(radiusCount, bucket, 1);
  }

  const radii: RadiusStep[] = [...radiusCount.entries()]
    .filter((e) => e[1] >= MIN_STEP_COUNT)
    .sort((a, b) => a[0] - b[0])
    .map((e) => ({ value: e[0], count: e[1], usage: describeRadius(e[0]) }));

  // --- 5. 布局参数 ----------------------------------------------------
  const content = pickContentWidth(boxes, viewportWidth);
  const cardPadding = pickCardPadding(boxes);
  const sectionGap = pickSectionGap(boxes);

  // --- 6. 需要主动说明的情况 ------------------------------------------
  const notes: SpacingNote[] = [];

  if (baseUnit === null) {
    notes.push({
      kind: 'no-base-unit',
      text:
        '页面的间距值没有找到一个共同的基础单位，说明这套间距可能是逐处手调出来的，而不是按基准倍数排的。' +
        '下面列的是出现最多的几个值，它们之间不一定构成完整的阶梯，复刻时建议自己定一个 4 或 8 的基准再对齐过去。',
    });
  } else {
    const share = Math.round(irregularWeight / Math.max(1, totalWeight) * 100);
    if (irregularValues > 0 && share >= 5) {
      notes.push({
        kind: 'irregular',
        text:
          `有 ${irregularValues} 个间距值不是 ${baseUnit} 的倍数，占全部间距出现次数的 ${share}%，` +
          '这部分是体系之外的手工调整。复刻时把它们就近归到下面的档位上，不要原样照抄。',
      });
    }
    if (fromFallback) {
      notes.push({
        kind: 'no-base-unit',
        text:
          `只能被 ${baseUnit} 整除，更大的基准（4 或 8）都对不上。这更像是恰好凑出来的规律而不是设计体系，` +
          '下面的档位仅供参考。',
      });
    }
  }

  if (steps.length > 0 && steps.length < 3) {
    notes.push({
      kind: 'few-steps',
      text: `只识别出 ${steps.length} 个间距档位，样本偏少。可能这个页面本身很简单，也可能主体内容渲染在图片或 canvas 里，样式读不到。`,
    });
  }

  if (content.width === null) {
    notes.push({
      kind: 'no-content-width',
      text:
        '没有检出统一的内容宽度。这个页面可能是全宽布局，或者靠左右 padding 而不是 max-width 控制内容边界。' +
        '复刻时如果不确定，先按 1200px 到 1280px 试。',
    });
  }

  if (sectionGap === null) {
    notes.push({
      kind: 'no-section-gap',
      text:
        '没有读到 flex 或 grid 容器的子项间距，页面间似乎是用外边距分隔的。跨区块的节奏要参照下面的档位自己定，' +
        '通常取最大那两档。',
    });
  }

  if (totalWeight < 40) {
    notes.push({
      kind: 'thin-sample',
      text:
        `全页只采到 ${totalWeight} 处间距，样本偏少，基础单位的判断可能不稳。` +
        '页面越简单，这个结论越需要人工过一眼。',
    });
  }

  return {
    baseUnit,
    baseUnitConfidence,
    baseCoverage,
    steps,
    discarded,
    contentMaxWidth: content.width,
    contentWidthNote: content.note,
    cardPadding,
    sectionGap,
    radii,
    notes,
    rawValueCount,
  };
}
