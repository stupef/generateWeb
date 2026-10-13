/**
 * 间距分析层的回归检查，用合成数据跑，不需要浏览器。
 *
 * 运行：npm run check:spacing
 *
 * 前两组对得上 B4 的两条验收标准：
 *   一、输出的是有规律的间距档位，不是页面上所有出现过的数值的罗列
 *   二、内容最大宽度等关键参数与页面实际一致
 *
 * 后面几组补的是判据的边界。一次性数值、负外边距、四边相同的去重、
 * 没有 gap 时退回外边距，这几种情况都会让「看见什么就报什么」的
 * 简单做法出错，必须单独锁住。
 *
 * 每个断言里的期望值都是人工指定的。改分析逻辑之前先跑一遍这个脚本，
 * 改完必须让所有断言回到全绿。
 */
import { analyzeSpacing, MIN_SPACING, MIN_STEP_COUNT, PILL_RADIUS } from '../src/core/spacing';
import type {
  BackgroundSummary,
  BoxObservation,
  EmbeddedContentSummary,
  PageSample,
} from '../src/core/types';

/**
 * 局部声明退出码用的 Node 全局。
 *
 * 故意不装 @types/node：这个项目的源码只跑在浏览器里，
 * 一旦把 Node 的全局类型并进来，DOM 里同名的 setTimeout、fetch 这些
 * 就会被 Node 的重载覆盖，扩展代码会拿到错误的类型。
 */
declare const process: { exit(code?: number): never };

const report: string[] = [];
let failed = 0;

function check(name: string, ok: boolean): void {
  if (!ok) failed++;
  report.push(`${ok ? '✓' : '✗'} ${name}`);
}

/** 与其它用例共用的空结构，间距用例不关心背景和框架 */
const noBackground: BackgroundSummary = {
  gradient: { elementCount: 0, viewportAreaRatio: 0, kinds: [], samples: [] },
  imageBackedCount: 0,
};

const plainStructure: EmbeddedContentSummary = {
  contentType: 'text/html',
  pdfEmbeds: 0,
  largeFrames: 0,
  largestFrameRatio: 0,
  framesetDocument: false,
  sameOriginFrames: 0,
  blockedFrames: 0,
};

/** 用例里的元素编号。自增，理由见 color-check.ts 里同一处的说明 */
let refSeq = 0;

function b(partial: Partial<BoxObservation>): BoxObservation {
  return {
    ref: refSeq++,
    tag: 'DIV',
    padding: [0, 0, 0, 0],
    margin: [0, 0, 0, 0],
    gap: null,
    radius: 0,
    width: 0,
    maxWidth: null,
    looksLikeCard: false,
    isControl: false,
    isLandmark: false,
    layout: 'block',
    ...partial,
  };
}

function sample(boxes: BoxObservation[], viewportWidth = 1440): PageSample {
  return {
    url: 'https://example.com/',
    title: '合成样例',
    viewportWidth,
    viewportHeight: 900,
    canvasColor: '#ffffff',
    prefersDark: false,
    elements: [],
    typography: [],
    boxes,
    styles: [],
    webFontFamilies: [],
    background: noBackground,
    embedded: plainStructure,
    textCharsTotal: 0,
    skipped: 0,
    visited: boxes.length,
    truncated: false,
    elapsedMs: 8,
  };
}

/** 批量造四边 padding 都等于 value 的普通块 */
function pads(n: number, value: number, partial: Partial<BoxObservation> = {}): BoxObservation[] {
  const out: BoxObservation[] = [];
  for (let i = 0; i < n; i++) {
    out.push(b({ ...partial, padding: [value, value, value, value] }));
  }
  return out;
}

// ---------------------------------------------------------------------
// 用例一：4px 网格页面（验收标准一）
// 间距全部落在 4 的倍数上，另外混进三个不是 4 倍数的偶发数值。
// ---------------------------------------------------------------------

const gridPage = sample([
  ...pads(12, 4),
  ...pads(10, 8),
  ...pads(6, 12),
  ...pads(8, 16),
  ...pads(4, 20),
  ...pads(5, 24),
  ...pads(3, 32),
  ...pads(2, 48),
  b({ padding: [13, 13, 13, 13] }),
  b({ padding: [17, 17, 17, 17] }),
  b({ padding: [23, 23, 23, 23] }),
]);

const grid = analyzeSpacing(gridPage);

{
  check(
    `4px 网格应识别出基础单位 4，实际 ${grid.baseUnit}`,
    grid.baseUnit === 4,
  );
  const values = grid.steps.map((s) => s.value).join(', ');
  check(
    `应输出 8 个有规律的档位，实际 ${grid.steps.length} 个（${values}）`,
    grid.steps.length === 8 &&
      [4, 8, 12, 16, 20, 24, 32, 48].every((v) => grid.steps.some((s) => s.value === v)),
  );
}

{
  // 验收一的核心：不是 4 倍数的偶发值一个都不能出现在档位里
  const leaked = grid.steps.filter((s) => s.value % 4 !== 0).map((s) => s.value);
  check(`档位里不应出现非 4 倍数的值，实际漏进 [${leaked.join(',')}]`, leaked.length === 0);
  const dropped = grid.discarded.map((d) => d.value).sort((a, b) => a - b);
  check(
    `三个偶发值应出现在已过滤列表，实际 [${dropped.join(', ')}]`,
    dropped.length === 3 && dropped.join(',') === '13,17,23',
  );
}

{
  const at16 = grid.steps.find((s) => s.value === 16);
  check(
    `16px 应折合 4 个基础单位，实际 ${at16 ? at16.units : '缺失'}`,
    !!at16 && at16.units === 4,
  );
  check(
    `16px 的来源应是内边距，实际 [${at16 ? at16.sources.join(',') : ''}]`,
    !!at16 && at16.sources.length === 1 && at16.sources[0] === 'padding',
  );
}

// ---------------------------------------------------------------------
// 用例二：8px 网格（验收标准一）
// 全部是 8 的倍数，其中 8 和 24 不是 16 的倍数，所以不该被判成 16。
// ---------------------------------------------------------------------

const eightPage = sample([
  ...pads(10, 8),
  ...pads(8, 16),
  ...pads(6, 24),
  ...pads(4, 32),
  ...pads(2, 48),
  ...pads(2, 64),
]);

const eight = analyzeSpacing(eightPage);

{
  check(`8px 网格应识别出基础单位 8，实际 ${eight.baseUnit}`, eight.baseUnit === 8);
  check(
    `全部落在基础单位上时应给出高置信，实际 ${eight.baseUnitConfidence}`,
    eight.baseUnitConfidence === 'high',
  );
  check(
    `8px 网格应有 6 个档位，实际 ${eight.steps.length} 个`,
    eight.steps.length === 6,
  );
}

// ---------------------------------------------------------------------
// 用例三：内容最大宽度（验收标准二）
// ---------------------------------------------------------------------

{
  const withMax = analyzeSpacing(
    sample([
      ...pads(3, 24, { maxWidth: 1200, width: 1200, isLandmark: true, tag: 'SECTION' }),
      // 铺满全宽的容器。视口 1440，减去滚动条余量后 1425 仍算全宽，
      // 不该被当成一个内容宽度
      ...pads(2, 16, { width: 1425 }),
    ]),
  );
  check(
    `内容最大宽度应取 max-width 的众数 1200，实际 ${withMax.contentMaxWidth}`,
    withMax.contentMaxWidth === 1200,
  );
  check(
    `内容宽度应附来源说明，实际 ${withMax.contentWidthNote ? '有' : '无'}`,
    !!withMax.contentWidthNote && withMax.contentWidthNote.indexOf('max-width') !== -1,
  );
}

{
  // 页面完全没用 max-width 时才退回看实际宽度
  const byWidth = analyzeSpacing(
    sample([
      ...pads(3, 24, { width: 1140, isLandmark: true, tag: 'SECTION' }),
      ...pads(2, 16, { width: 1425 }),
    ]),
  );
  check(
    `没有 max-width 时应退回实际宽度的众数 1140，实际 ${byWidth.contentMaxWidth}`,
    byWidth.contentMaxWidth === 1140,
  );
}

{
  // 只有一个容器设了 max-width，缺少第二处印证，要如实说明
  const single = analyzeSpacing(sample([...pads(3, 24, { maxWidth: 1080, width: 1080 })]));
  check(
    `单一样本时应给出内容宽度但标注样本偏少，实际 ${single.contentWidthNote ?? '无说明'}`,
    single.contentMaxWidth === 1080 && !!single.contentWidthNote && single.contentWidthNote.indexOf('一个') !== -1,
  );
}

{
  const none = analyzeSpacing(sample(pads(6, 16, { width: 1425 })));
  check(
    `只有全宽容器时不应报出内容宽度，实际 ${none.contentMaxWidth}`,
    none.contentMaxWidth === null,
  );
  check(
    '没有内容宽度时必须给出说明',
    none.notes.some((n) => n.kind === 'no-content-width'),
  );
}

// ---------------------------------------------------------------------
// 用例四：卡片内边距
// 左右 24、上下 16，要分别取两个方向的众数，不能混成一个数。
// ---------------------------------------------------------------------

{
  const card = analyzeSpacing(
    sample(
      Array.from({ length: 3 }, () =>
        b({ padding: [16, 24, 16, 24], looksLikeCard: true, radius: 8 }),
      ),
    ),
  );
  const cp = card.cardPadding;
  check(
    `卡片内边距应为水平 24 / 垂直 16，实际 ${cp ? `${cp.x} / ${cp.y}` : '缺失'}`,
    !!cp && cp.x === 24 && cp.y === 16,
  );
  check(
    `卡片内边距应记录命中样本数，实际 ${cp ? cp.sampleCount : '缺失'}`,
    !!cp && cp.sampleCount === 3,
  );
}

// ---------------------------------------------------------------------
// 用例四之二：控件不能混进卡片内边距
//
// 这一条来自真实浏览器实测。导航链接和按钮同样有底色和圆角，
// 在 looksLikeCard 这个宽口径下和卡片无法区分，但它们的内边距是
// 控件内边距。实测一个页面里四条导航链接的 8 / 12 在数量上压过了
// 三张真卡片的 20 / 24，卡片内边距就被报成了 12 / 8。
// ---------------------------------------------------------------------

{
  const mixed = analyzeSpacing(
    sample([
      ...Array.from({ length: 3 }, () =>
        b({ padding: [20, 24, 20, 24], looksLikeCard: true, radius: 8 }),
      ),
      // 四条导航链接：有圆角、有内边距，在宽口径下也算「像表面」
      ...Array.from({ length: 4 }, () =>
        b({ tag: 'A', padding: [8, 12, 8, 12], looksLikeCard: true, radius: 4, isControl: true }),
      ),
      // 两个按钮
      ...Array.from({ length: 2 }, () =>
        b({ tag: 'BUTTON', padding: [8, 16, 8, 16], looksLikeCard: true, radius: 4, isControl: true }),
      ),
    ]),
  );
  const cp = mixed.cardPadding;
  check(
    `控件不应污染卡片内边距，应为 24 / 20，实际 ${cp ? `${cp.x} / ${cp.y}` : '缺失'}`,
    !!cp && cp.x === 24 && cp.y === 20,
  );
  check(
    `卡片内边距的样本数只算非控件，实际 ${cp ? cp.sampleCount : '缺失'}`,
    !!cp && cp.sampleCount === 3,
  );
}

// ---------------------------------------------------------------------
// 用例五：区块间距
// gap 是分层的：8 用于导航项，24 用于卡片，64 用于大区块。
// 不分层直接取众数会取到 8，那不是区块间距。
// ---------------------------------------------------------------------

{
  const gaps = analyzeSpacing(
    sample([
      b({ gap: 8, layout: 'flex' }),
      b({ gap: 8, layout: 'flex' }),
      b({ gap: 24, layout: 'grid' }),
      b({ gap: 24, layout: 'grid' }),
      b({ gap: 24, layout: 'grid' }),
      b({ gap: 64, layout: 'flex', isLandmark: true, tag: 'SECTION' }),
      b({ gap: 64, layout: 'flex', isLandmark: true, tag: 'FOOTER' }),
    ]),
  );
  check(
    `区块间距应取较大 gap 的众数 24，实际 ${gaps.sectionGap}`,
    gaps.sectionGap === 24,
  );
  const at8 = gaps.steps.find((s) => s.value === 8);
  check(
    `gap 来源应记进档位，实际 8px 的来源 [${at8 ? at8.sources.join(',') : ''}]`,
    !!at8 && at8.sources.length === 1 && at8.sources[0] === 'gap',
  );
  check(
    `baseUnit 应为 8，实际 ${gaps.baseUnit}`,
    gaps.baseUnit === 8,
  );
}

{
  // 页面完全不用 gap 时，退回语义区块元素的垂直外边距
  const byMargin = analyzeSpacing(
    sample([...pads(3, 16, { tag: 'SECTION', isLandmark: true, margin: [48, 0, 48, 0] })]),
  );
  check(
    `没有 gap 时应退回区块外边距 48，实际 ${byMargin.sectionGap}`,
    byMargin.sectionGap === 48,
  );
}

{
  // 卡片网格和区块容器各只有一个，两档次数打平。此时要取大的那个，
  // 取小的会退回到卡片间距上去（真实页面上这种情况很常见）
  const tie = analyzeSpacing(
    sample([
      b({ gap: 24, layout: 'grid' }),
      b({ gap: 64, layout: 'flex', isLandmark: true, tag: 'SECTION' }),
    ]),
  );
  check(`大间距平票时应取更大的那一档，实际 ${tie.sectionGap}`, tie.sectionGap === 64);
}

{
  const noSeparation = analyzeSpacing(sample(pads(4, 16)));
  check(
    `既没有 gap 也没有区块外边距时不应臆造区块间距，实际 ${noSeparation.sectionGap}`,
    noSeparation.sectionGap === null,
  );
  check(
    '缺少区块间距时必须给出说明',
    noSeparation.notes.some((n) => n.kind === 'no-section-gap'),
  );
}

// ---------------------------------------------------------------------
// 用例六：圆角档位
// ---------------------------------------------------------------------

{
  const radii = analyzeSpacing(
    sample([
      ...pads(5, 8, { radius: 4 }),
      ...pads(4, 16, { radius: 8 }),
      // 胶囊的两种常见写法，必须归到同一档
      ...pads(1, 24, { radius: 999 }),
      ...pads(1, 24, { radius: 9999 }),
    ]),
  );
  const values = radii.radii.map((r) => r.value).join(', ');
  check(
    `圆角应聚出 4 / 8 / 胶囊三档，实际 [${values}]`,
    radii.radii.length === 3 &&
      radii.radii.some((r) => r.value === 4) &&
      radii.radii.some((r) => r.value === 8) &&
      radii.radii.some((r) => r.value === PILL_RADIUS),
  );
  const pill = radii.radii.find((r) => r.value === PILL_RADIUS);
  check(
    `胶囊两档应合并计数，实际 ${pill ? pill.count : '缺失'} 次`,
    !!pill && pill.count === 2,
  );
}

// ---------------------------------------------------------------------
// 用例七：基础单位的两个边界
// ---------------------------------------------------------------------

{
  // 全部是 16 的倍数。16 比 8 更具体，应当报 16 而不是含糊地报 8
  const sixteen = analyzeSpacing(
    sample([...pads(6, 16), ...pads(4, 32), ...pads(3, 48), ...pads(2, 64)]),
  );
  check(`全 16 倍数的页面应报基础单位 16，实际 ${sixteen.baseUnit}`, sixteen.baseUnit === 16);
}

{
  // 7 / 13 / 19 / 23 这几个值连 2 都整除不了，说明页面根本没有体系。
  // 这种情况必须如实报「没有基础单位」，不能硬凑一个出来。
  const messy = analyzeSpacing(sample([...pads(4, 7), ...pads(3, 13), ...pads(3, 19), ...pads(2, 23)]));
  check(`无规律的间距应报不出基础单位，实际 ${messy.baseUnit}`, messy.baseUnit === null);
  check(
    '报不出基础单位时必须给出说明',
    messy.notes.some((n) => n.kind === 'no-base-unit'),
  );
}

// ---------------------------------------------------------------------
// 用例八：一次性数值
// ---------------------------------------------------------------------

{
  const once = analyzeSpacing(
    sample([...pads(5, 4), ...pads(5, 12), b({ padding: [28, 28, 28, 28] })]),
  );
  check(
    `28px 只出现一次，应被挡在档位之外，实际档位 [${once.steps.map((s) => s.value).join(',')}]`,
    once.steps.length === 2 && once.steps.every((s) => s.value !== 28),
  );
  check(
    `28px 应记进已过滤列表，实际 [${once.discarded.map((d) => d.value).join(',')}]`,
    once.discarded.some((d) => d.value === 28),
  );
}

{
  // 同一个元素四边 padding 都是 16，只该记一次而不是四次。
  // 按四边记的话这一档会凭空达到门槛，被误当成真实档位
  const oneBox = analyzeSpacing(sample([b({ padding: [16, 16, 16, 16] })]));
  check(
    '单个元素的四边间距只计一次，不足以立为档位',
    oneBox.steps.length === 0 && oneBox.discarded.length === 1,
  );
}

// ---------------------------------------------------------------------
// 用例九：负外边距与空输入
// ---------------------------------------------------------------------

{
  const negative = analyzeSpacing(
    sample([...pads(5, 4), ...pads(5, 12), b({ margin: [-8, -8, -8, -8] })]),
  );
  const neg = negative.discarded.find((d) => d.value === -8);
  check(
    `负外边距应被剔除并说明原因，实际 ${neg ? neg.reason : '未出现'}`,
    !!neg && neg.reason.indexOf('负间距') !== -1,
  );
  check(
    `负外边距不该占用档位，实际 [${negative.steps.map((s) => s.value).join(',')}]`,
    negative.steps.every((s) => s.value > 0),
  );
}

{
  const empty = analyzeSpacing(sample([]));
  check(
    '空页面应返回空结果而不是抛错',
    empty.steps.length === 0 &&
      empty.baseUnit === null &&
      empty.contentMaxWidth === null &&
      empty.cardPadding === null,
  );
}

{
  // 字段残缺时不能抛错。采集结果穿过一次序列化边界，理论上可能变形
  const broken = analyzeSpacing({
    ...sample([]),
    boxes: [{ tag: 'DIV' } as unknown as BoxObservation],
  });
  check('字段残缺的观测应被安全跳过，不抛错', broken.steps.length === 0);
}

// ---------------------------------------------------------------------
// 用例十：阈值边界
// ---------------------------------------------------------------------

{
  // 次数门槛定在 2 而不是更高，是为了保住大间距档位。大间距天然用得少，
  // 64px 的区块间距在一个页面上往往只有两三处，门槛提高到 3 就会把它砍掉。
  // 这条是 MIN_STEP_COUNT 唯一该被改动的地方，想动它先看这条断言
  check(`档位次数门槛应是 ${MIN_STEP_COUNT}`, MIN_STEP_COUNT === 2);
  check(`最小间距应是 ${MIN_SPACING}`, MIN_SPACING === 2);
  check(`胶囊圆角阈值应是 ${PILL_RADIUS}`, PILL_RADIUS === 100);
  check(
    `基础单位识别置信度应随覆盖率变化，4px 网格实测 ${grid.baseUnitConfidence}`,
    grid.baseUnitConfidence === 'medium',
  );
}

// ---------------------------------------------------------------------

console.log('='.repeat(56));
console.log(`断言结果（档位门槛 ${MIN_STEP_COUNT} 次 / 基础单位覆盖率 0.8）`);
console.log('='.repeat(56));
for (const line of report) console.log(line);
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项未通过`);

process.exit(failed === 0 ? 0 : 1);
