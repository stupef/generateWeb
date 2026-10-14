/**
 * 组件识别分析层的回归检查，用合成数据跑，不需要浏览器。
 *
 * 运行：npm run check:components
 *
 * 前两组对应 B6 的两条验收标准：
 *   一、每个识别出的组件都有背景色、文字色、圆角、内边距、字体等参数
 *   二、页面上没有某类组件时不输出该组件，不编造
 *
 * 第三条「人工对照可以确认识别结果与页面中的实际组件一致」没法自动化，
 * 靠的是 test/acceptance-b6.html 那份对照页。这里能锁住的是它的前置条件：
 * 给定一份已知的组件分布，识别出来的类别、数量、主次变体必须与输入严格对应。
 *
 * 后面几组补的是判别边界。主按钮和次按钮的差别只在填充和描边两件事上，
 * 卡片和版面容器的差别只在「有没有撑满父容器」这一件事上，这两处判反了
 * 从参数上看不出来，必须单独锁住。
 */
import { analyzeComponents } from '../src/core/components';
import type {
  BackgroundSummary,
  EmbeddedContentSummary,
  PageSample,
  StyleElementKind,
  StyleObservation,
} from '../src/core/types';

/**
 * 局部声明退出码用的 Node 全局。
 *
 * 故意不装 @types/node：这个项目的源码只跑在浏览器里，
 * 一旦把 Node 的全局类型并进来，DOM 里同名的 setTimeout、fetch 这些
 * 就会被 Node 的重载覆盖，扩展代码会拿到错误的类型。
 */
declare const process: { exit(code?: number): void };

const report: string[] = [];
let failed = 0;

function check(name: string, ok: boolean): void {
  if (!ok) failed++;
  report.push(`${ok ? '✓' : '✗'} ${name}`);
}

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

function s(partial: Partial<StyleObservation> & { kind: StyleElementKind }): StyleObservation {
  const base: StyleObservation = {
    ref: refSeq++,
    tag: 'DIV',
    kind: partial.kind,
    inNav: false,
    textChars: 4,
    childCount: 1,
    fillsParent: false,
    backgroundColor: null,
    textColor: '#1f1f1c',
    padding: [10, 16, 10, 16],
    radius: 8,
    borderWidth: 0,
    borderSides: 0,
    borderStyle: '',
    borderColor: null,
    shadow: null,
    width: 320,
    height: 48,
    fontSize: 16,
    fontWeight: 400,
    fontFamily: 'Inter',
  };
  return { ...base, ...partial };
}

/** 只要一个元素的场合，写成 one(...) 比 many(1, ...)[0]! 干净 */
function one(partial: Partial<StyleObservation> & { kind: StyleElementKind }): StyleObservation {
  return s(partial);
}

function sample(styles: StyleObservation[], canvasColor = '#ffffff'): PageSample {
  return {
    url: 'https://example.com/',
    title: '合成样例',
    viewportWidth: 1440,
    viewportHeight: 900,
    canvasColor,
    prefersDark: false,
    elements: [],
    typography: [],
    boxes: [],
    styles,
    webFontFamilies: [],
    background: noBackground,
    embedded: plainStructure,
    textCharsTotal: 0,
    skipped: 0,
    visited: 0,
    truncated: false,
    elapsedMs: 8,
  };
}

function many(
  n: number,
  partial: Partial<StyleObservation> & { kind: StyleElementKind },
): StyleObservation[] {
  const out: StyleObservation[] = [];
  for (let i = 0; i < n; i++) out.push(s(partial));
  return out;
}

// 一份覆盖四类组件的样张。三个按钮分别是实心无描边、白底带描边、
// 透明底带描边，正好对应主、次、幽灵三种形态。
const primary = { kind: 'button' as const, backgroundColor: '#3d5afe', textColor: '#ffffff', radius: 8, padding: [10, 18, 10, 18] as [number, number, number, number], height: 40 };
const secondary = { kind: 'button' as const, backgroundColor: '#ffffff', textColor: '#1f1f1c', borderWidth: 1, borderSides: 4, borderStyle: 'solid', borderColor: '#d0d0d0', radius: 8, padding: [10, 18, 10, 18] as [number, number, number, number], height: 40 };
const ghost = { kind: 'button' as const, backgroundColor: null, textColor: '#3d5afe', borderWidth: 1, borderSides: 4, borderStyle: 'solid', borderColor: '#c7d2fe', radius: 8, padding: [10, 18, 10, 18] as [number, number, number, number], height: 40 };
const input = { kind: 'input' as const, backgroundColor: '#ffffff', textColor: '#1f1f1c', borderWidth: 1, borderSides: 4, borderStyle: 'solid', borderColor: '#d8d8d4', radius: 6, padding: [9, 14, 9, 14] as [number, number, number, number], height: 38, childCount: 0, fontSize: 15 };

// about.nike.com 上的两类按钮：深色画布上，真正 CTA 与画布同色，
// 导航图标按钮比画布稍亮一档。旧实现会把图标按钮误判成主按钮。
const nikeCTA = {
  kind: 'button' as const,
  backgroundColor: '#111111',
  textColor: '#ffffff',
  radius: 80,
  padding: [13, 24, 13, 24] as [number, number, number, number],
  height: 40,
  width: 160,
  textChars: 12,
};
const nikeIcon = {
  kind: 'button' as const,
  backgroundColor: '#2d2d2d',
  textColor: null,
  radius: 15,
  padding: [0, 0, 0, 0] as [number, number, number, number],
  height: 30,
  width: 30,
  textChars: 0,
  inNav: true,
};
const nav = { kind: 'nav' as const, backgroundColor: '#ffffff', textColor: '#1f1f1c', borderWidth: 1, borderSides: 1, borderStyle: 'solid', borderColor: '#e8e8e4', radius: 0, padding: [0, 32, 0, 32] as [number, number, number, number], height: 64, childCount: 5, width: 1440, fillsParent: true };
const card = { kind: 'card' as const, backgroundColor: '#f6f6f4', textColor: '#1f1f1c', radius: 12, padding: [20, 24, 20, 24] as [number, number, number, number], height: 180, width: 380, childCount: 3 };

const fullPage = analyzeComponents(
  sample([
    ...many(1, primary),
    ...many(1, secondary),
    ...many(1, ghost),
    ...many(1, input),
    ...many(1, nav),
    ...many(1, card),
  ]),
);

// ---------------------------------------------------------------------
// 用例一：每个组件都要有完整参数（验收标准一）
// ---------------------------------------------------------------------

{
  check(
    `应识别出 4 类组件，实际 ${fullPage.kindCount} 类（${fullPage.specs.map((x) => x.label).join('、')}）`,
    fullPage.kindCount === 4,
  );

  // 「有这些参数」的准确含义是每个参数都给出了确定的值，而不是每个值
  // 都必须非零。幽灵按钮本来就没有底色，导航栏本来就没有圆角，把这两种
  // 正常情况判成缺项，反而会逼着实现去编一个值出来。
  //
  // 所以这里查的是「有没有值」而不是「值大不大」：颜色要么是一个色值、
  // 要么明确为 null（表示没有填充）；字号、字体、内边距必须有确切取值。
  const incomplete = fullPage.specs.filter(
    (x) =>
      typeof x.backgroundColor === 'undefined' ||
      x.textColor === null ||
      x.textColor.length === 0 ||
      !Number.isFinite(x.radius) ||
      x.paddingX <= 0 ||
      !Number.isFinite(x.paddingY) ||
      x.fontSize <= 0 ||
      x.fontFamily.length === 0,
  );
  check(
    `每个组件都要给全背景色、文字色、圆角、内边距、字体，缺项的有 [${incomplete
      .map((x) => x.label)
      .join('、')}]`,
    incomplete.length === 0,
  );

  // 幽灵按钮是唯一没有背景色的那一类，它本来就该明确为 null。
  // 这一条反过来验证「没有填充」这个事实没有被填一个假底色
  const ghostSpec = fullPage.specs.find((x) => x.variant === 'ghost');
  check(
    `幽灵按钮不应有背景色，实际 ${ghostSpec ? ghostSpec.backgroundColor : '缺失'}`,
    !!ghostSpec && ghostSpec.backgroundColor === null,
  );

  // 导航栏的圆角是 0，也必须如实报 0，不能因为 0 不好看就省略
  const navSpec = fullPage.specs.find((x) => x.kind === 'nav');
  check(
    `导航栏的直角应如实报 0，实际 ${navSpec ? navSpec.radius : '缺失'}`,
    !!navSpec && navSpec.radius === 0,
  );

  check(
    '每个组件都要给出用途说明',
    fullPage.specs.every((x) => x.usage.length > 40),
  );
}

{
  // 参数的取值必须来自真实元素，不能是默认值。这里逐项核对主按钮
  const p = fullPage.specs.find((x) => x.variant === 'primary');
  check(
    `主按钮参数应与输入一致（底色 #3d5afe / 圆角 8 / 内边距 18×10 / 字重 400），实际 ${
      p ? `${p.backgroundColor} / ${p.radius} / ${p.paddingX}×${p.paddingY} / ${p.fontWeight}` : '缺失'
    }`,
    !!p &&
      p.backgroundColor === '#3d5afe' &&
      p.radius === 8 &&
      p.paddingX === 18 &&
      p.paddingY === 10 &&
      p.fontWeight === 400,
  );
  check(
    `主按钮的高度应取 40，实际 ${p ? p.height : '缺失'}`,
    !!p && p.height === 40,
  );
  check(
    `主按钮的对比度应能算出，实际 ${p ? p.textContrast : '缺失'}`,
    !!p && p.textContrast !== null && p.textContrast > 4.5,
  );
}

// ---------------------------------------------------------------------
// 用例二：没有的组件不输出（验收标准二）
// ---------------------------------------------------------------------

{
  const only = analyzeComponents(sample([...many(3, primary)]));
  check(
    `只有按钮的页面应只输出按钮，实际 [${only.specs.map((x) => x.label).join('、')}]`,
    only.specs.length === 1 && only.specs[0] !== undefined && only.specs[0].kind === 'button',
  );
  check(
    `类别数应为 1，实际 ${only.kindCount}`,
    only.kindCount === 1,
  );
  check(
    '类别不足三类时要说明原因',
    only.notes.some((n) => n.kind === 'few-kinds'),
  );
  // 最要紧的一条：不该出现的组件一个参数都不许有。只要出现一条，
  // 说明某处漏了「先找到元素再生成结论」这条约束
  const leaked = only.specs.filter((x) => x.kind !== 'button').map((x) => x.label);
  check(`不该凭空出现输入框、卡片、导航栏，实际多出 [${leaked.join('、')}]`, leaked.length === 0);
}

{
  const nothing = analyzeComponents(sample([]));
  check(`候选为空时不应输出任何组件，实际 ${nothing.specs.length} 条`, nothing.specs.length === 0);
  check(`候选为空时应给出说明`, nothing.notes.length > 0);
}

// ---------------------------------------------------------------------
// 用例三：主按钮与次按钮的区分
//
// 两者的差别只在「填充和页面底色像不像」以及「有没有看得见的描边」
// 这两件事上，判反了从参数上看不出来
// ---------------------------------------------------------------------

{
  const variants = analyzeComponents(
    sample([...many(2, primary), ...many(2, secondary), ...many(2, ghost)]),
  );
  const got = variants.specs.filter((x) => x.kind === 'button').map((x) => x.label);
  check(
    `三种按钮形态应分别识别，实际 [${got.join('、')}]`,
    got.length === 3 &&
      got.indexOf('主按钮') !== -1 &&
      got.indexOf('次按钮') !== -1 &&
      got.indexOf('幽灵按钮') !== -1,
  );
}

{
  // 实心蓝底没有描边，与白底对比明显，是主按钮
  const solid = analyzeComponents(sample([one({ kind: 'button', backgroundColor: '#1f2937', textColor: '#ffffff' })]));
  check(
    `深色实心无描边的按钮应判为主按钮，实际 ${solid.specs[0] ? solid.specs[0].label : '缺失'}`,
    solid.specs.length === 1 && solid.specs[0] !== undefined && solid.specs[0].variant === 'primary',
  );
}

{
  // 白底配一条几乎看不见的浅灰边。填充和页面底色一样，不能算主按钮
  const subtle = analyzeComponents(
    sample([one({ kind: 'button', backgroundColor: '#fdfdfd', borderWidth: 1, borderSides: 4, borderColor: '#f0f0f0' })]),
  );
  check(
    `填充贴着底色的按钮应判为次按钮，实际 ${subtle.specs[0] ? subtle.specs[0].label : '缺失'}`,
    subtle.specs.length === 1 && subtle.specs[0] !== undefined && subtle.specs[0].variant === 'secondary',
  );
}

{
  // 深色页面上的白色按钮。填充和页面底色差得远，仍然是主按钮。
  // 这一条锁的是「主按钮不等于深色」这个判断，底色深浅没有关系，
  // 有关系的只是对比
  const dark = analyzeComponents(
    sample([one({ kind: 'button', backgroundColor: '#ffffff', textColor: '#0a0a0a' })], '#0a0a0a'),
  );
  check(
    `深色页面上的白色按钮应判为主按钮，实际 ${dark.specs[0] ? dark.specs[0].label : '缺失'}`,
    dark.specs.length === 1 && dark.specs[0] !== undefined && dark.specs[0].variant === 'primary',
  );
}

{
  // 透明底一律是幽灵按钮，不管有没有描边
  const withBorder = analyzeComponents(
    sample([one({ kind: 'button', backgroundColor: null, borderWidth: 1, borderSides: 4, borderColor: '#c7d2fe' })]),
  );
  const noBorder = analyzeComponents(
    sample([one({ kind: 'button', backgroundColor: null, borderWidth: 0 })]),
  );
  check(
    `透明底带描边应判为幽灵按钮，实际 ${withBorder.specs[0] ? withBorder.specs[0].label : '缺失'}`,
    withBorder.specs.length === 1 && withBorder.specs[0] !== undefined && withBorder.specs[0].variant === 'ghost',
  );
  check(
    `透明底无描边的纯文字按钮同样是幽灵按钮，实际 ${noBorder.specs[0] ? noBorder.specs[0].label : '缺失'}`,
    noBorder.specs.length === 1 && noBorder.specs[0] !== undefined && noBorder.specs[0].variant === 'ghost',
  );
}

{
  // 深色页面、CTA 与画布同色、导航图标按钮偏亮一档。
  // 这是 about.nike.com 的真实情形：1 个 CTA + 5 个导航图标按钮。
  const nike = analyzeComponents(
    sample([one(nikeCTA), ...many(5, nikeIcon)], '#111111'),
  );
  const buttons = nike.specs.filter((x) => x.kind === 'button');
  const primarySpec = buttons.find((x) => x.variant === 'primary');
  check(
    `深色页上真正 CTA 应被判为主按钮，实际 ${primarySpec ? primarySpec.backgroundColor : '缺失'}`,
    buttons.length >= 1 && primarySpec !== undefined && primarySpec.backgroundColor === '#111111',
  );
  check(
    `主按钮代表应是带文字的大尺寸 CTA，不是导航图标，实际高 ${primarySpec ? primarySpec.height : '缺失'}`,
    primarySpec !== undefined && primarySpec.height === 40 && primarySpec.radius === 80,
  );
}

{
  // 深色页面上没有真实 CTA，只有贴近画布的次要按钮。它不应因兜底规则变成主按钮。
  const onlySecondary = analyzeComponents(
    sample([one({ ...nikeIcon, inNav: false, backgroundColor: '#1f1f1f' })], '#111111'),
  );
  const buttons = onlySecondary.specs.filter((x) => x.kind === 'button');
  const primarySpec = buttons.find((x) => x.variant === 'primary');
  check(
    `无文字、无内边距的小按钮不应被兜底成主按钮，实际 ${primarySpec ? '有' : '无'}`,
    primarySpec === undefined,
  );
}

// ---------------------------------------------------------------------
// 用例四：卡片与版面容器的区分
//
// 两者都可能有底色、圆角和内边距，差别只在「有没有撑满父容器」。
// 判反了会让复刻的人给整个内容区加上卡片背景
// ---------------------------------------------------------------------

{
  const ok = analyzeComponents(sample([...many(3, card)]));
  check(
    `排在一行里的卡片应被识别，实际 ${ok.specs.filter((x) => x.kind === 'card').length} 条`,
    ok.specs.some((x) => x.kind === 'card'),
  );
}

{
  // 撑满父容器的整宽区块是版面容器。它同样有底色和内边距，
  // 只有这一条判据能把它和卡片分开
  const wrapper = analyzeComponents(
    sample([...many(3, { ...card, width: 1200, fillsParent: true })]),
  );
  check(
    `撑满父容器的整宽区块不应报成卡片，实际 ${wrapper.specs.filter((x) => x.kind === 'card').length} 条`,
    !wrapper.specs.some((x) => x.kind === 'card'),
  );
}

{
  // 铺满整屏的更不可能是卡片
  const fullWidth = analyzeComponents(
    sample([...many(3, { ...card, width: 1440, fillsParent: false })]),
  );
  check(
    `铺满整屏的区块不应报成卡片，实际 ${fullWidth.specs.filter((x) => x.kind === 'card').length} 条`,
    !fullWidth.specs.some((x) => x.kind === 'card'),
  );
}

{
  // 没有子元素的带底小方块是徽标或色块，不是卡片
  const badge = analyzeComponents(sample([...many(3, { ...card, childCount: 0 })]));
  check(
    `没有子元素的底面不应报成卡片，实际 ${badge.specs.filter((x) => x.kind === 'card').length} 条`,
    !badge.specs.some((x) => x.kind === 'card'),
  );
  const tiny = analyzeComponents(sample([...many(3, { ...card, width: 120 })]));
  check(
    `过窄的底面不应报成卡片，实际 ${tiny.specs.filter((x) => x.kind === 'card').length} 条`,
    !tiny.specs.some((x) => x.kind === 'card'),
  );
}

// ---------------------------------------------------------------------
// 用例五：多写法取样与说明
// ---------------------------------------------------------------------

{
  // 同一种组件有多种写法时，代表参数取数量最多的那一种，
  // 并且要说明还有别的写法。取到少数派会把结论带偏
  const spread = analyzeComponents(
    sample([
      ...many(5, { ...primary, backgroundColor: '#3d5afe' }),
      ...many(1, { ...primary, backgroundColor: '#e11d48' }),
    ]),
  );
  const p = spread.specs.find((x) => x.kind === 'button');
  check(
    `多数派的底色应被选为代表，实际 ${p ? p.backgroundColor : '缺失'}`,
    !!p && p.backgroundColor === '#3d5afe',
  );
  check(
    `应记录这个组件有几种写法，实际 ${p ? p.signatureCount : '缺失'} 种`,
    !!p && p.signatureCount === 2,
  );
  check(`有多种写法时要说明`, spread.notes.some((n) => n.kind === 'variant-spread'));
}

{
  // 导航栏里的链接常常长得像按钮。它们确实是按钮形态，
  // 但角色是导航项，必须点出来，否则读的人会以为页面上有好几个主操作
  const navLinks = analyzeComponents(
    sample([...many(4, { ...ghost, inNav: true }), ...many(1, { ...ghost, inNav: false })]),
  );
  check(
    '导航里的按钮形态要单独说明',
    navLinks.notes.some((n) => n.kind === 'nav-links'),
  );
}

{
  // 输入框的圆角和四边描边要如实带出来，这是它和分割线的唯一差别
  const i = fullPage.specs.find((x) => x.kind === 'input');
  check(
    `输入框应带出四边描边与圆角 6，实际 ${i ? `${i.borderWidth} 边 ${i.radius}px` : '缺失'}`,
    !!i && i.borderWidth === 1 && i.borderSides === 4 && i.radius === 6,
  );
  check(
    `输入框的说明要点出它只有部分边有描边时不成立，实际 ${i ? i.usage.slice(0, 30) : '缺失'}`,
    !!i && i.usage.indexOf('四边有 1px 的描边') !== -1,
  );
}

{
  // 导航栏的高度是复刻时最先要定的值，必须带出来
  const n = fullPage.specs.find((x) => x.kind === 'nav');
  check(
    `导航栏应带出高度 64，实际 ${n ? n.height : '缺失'}`,
    !!n && n.height === 64,
  );
  check(
    `导航栏的说明要点出高度决定顶部留白，实际 ${n ? n.usage.slice(0, 24) : '缺失'}`,
    !!n && n.usage.indexOf('决定整站页面的顶部留白') !== -1,
  );
}

// ---------------------------------------------------------------------
// 用例六：边界
// ---------------------------------------------------------------------

{
  // 字段残缺时不能抛错。采集结果穿过一次序列化边界，理论上可能变形
  const broken = analyzeComponents({
    ...sample([]),
    styles: [
      { kind: 'button' } as unknown as StyleObservation,
      { kind: 'card', padding: null } as unknown as StyleObservation,
    ],
  });
  check('字段残缺的观测应被安全跳过，不抛错', broken.specs.length + broken.notes.length >= 1);
}

{
  // 文字和底色的对比度不足时必须说出来。这一条是可读性的硬要求，
  // 复刻时照抄会直接得到一个读不清的按钮
  const low = analyzeComponents(
    sample([s({ ...primary, backgroundColor: '#7b8cff', textColor: '#8595ff' })]),
  );
  const p = low.specs.find((x) => x.kind === 'button');
  check(
    `对比度不足时必须写进说明，实际 ${p ? p.usage.slice(-30) : '缺失'}`,
    !!p && (p.usage.indexOf('几乎读不清') !== -1 || p.usage.indexOf('偏吃力') !== -1),
  );
}

{
  const thin = analyzeComponents(sample([...many(3, primary)]));
  check('候选样本过少时要给出说明', thin.notes.some((n) => n.kind === 'thin-sample') || thin.sampleCount >= 6);
}

// ---------------------------------------------------------------------

console.log('='.repeat(56));
console.log('断言结果（组件参数完整性 / 主次按钮 / 卡片与版面容器）');
console.log('='.repeat(56));
for (const line of report) console.log(line);
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项未通过`);

process.exit(failed === 0 ? 0 : 1);
