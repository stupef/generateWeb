/**
 * 圆角、边框、投影分析层的回归检查，用合成数据跑，不需要浏览器。
 *
 * 运行：npm run check:effects
 *
 * 前两组对应 B5 的两条验收标准：
 *   一、圆角能按元素类型区分（按钮、输入框、卡片的圆角不同时能分别体现）
 *   二、页面没有使用阴影时，输出中明确说明「不使用阴影」，而不是编造一个值
 *
 * 后面几组补的是投影解析的边界。这一段是本轮最容易出错的地方：一条
 * box-shadow 的计算值里颜色可前可后、长度可多可少、颜色内部还带着逗号，
 * 任何一个处理错都会让同一个投影被拆成好几条，或者解析出一个错的颜色。
 * 这些分支光靠真实页面看不出来（页面上看着是对的），必须逐条锁住。
 *
 * 每个断言里的期望值都是人工指定的。改分析逻辑之前先跑一遍这个脚本，
 * 改完必须让所有断言回到全绿。
 */
import { analyzeEffects, radiusLabel } from '../src/core/effects';
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
    textChars: 0,
    childCount: 0,
    fillsParent: false,
    backgroundColor: null,
    textColor: null,
    padding: [0, 0, 0, 0],
    radius: 0,
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

function sample(styles: StyleObservation[], viewportWidth = 1440): PageSample {
  return {
    url: 'https://example.com/',
    title: '合成样例',
    viewportWidth,
    viewportHeight: 900,
    canvasColor: '#ffffff',
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

/**
 * 造一个真正算得上卡片的元素。
 *
 * 圆角归组之前会先把「像表面一样的元素」细分一档，只有装着内容、
 * 有两个方向的内边距、面积够大、又不撑满父容器的才算卡片。用例里要
 * 验证卡片的圆角，就必须先给它一个卡片的形状，否则它会被归到
 * 「其他元素」那一组，断言看起来失败但实现是对的。
 */
function cardLike(partial: Partial<StyleObservation> = {}): Partial<StyleObservation> & { kind: StyleElementKind } {
  return {
    kind: 'card',
    childCount: 3,
    padding: [20, 24, 20, 24],
    width: 380,
    height: 180,
    fillsParent: false,
    ...partial,
  };
}

/** 造 n 条同款式的元素 */
function many(
  n: number,
  partial: Partial<StyleObservation> & { kind: StyleElementKind },
): StyleObservation[] {
  const out: StyleObservation[] = [];
  for (let i = 0; i < n; i++) out.push(s(partial));
  return out;
}

// ---------------------------------------------------------------------
// 用例一：圆角按元素类型区分（验收标准一）
//
// 按钮 8、输入框 6、卡片 12，三种元素用三个不同的圆角。
// 只给一张取值表的话，读的人不知道哪个值该用在哪个元素上。
// ---------------------------------------------------------------------

const byKind = analyzeEffects(
  sample([
    ...many(4, { kind: 'button', radius: 8, backgroundColor: '#3d5afe' }),
    ...many(3, { kind: 'input', radius: 6, borderWidth: 1, borderSides: 4, borderColor: '#d8d8d4' }),
    ...many(2, cardLike({ radius: 12, backgroundColor: '#f6f6f4', shadow: 'rgba(0, 0, 0, 0.06) 0px 4px 12px 0px' })),
  ]),
);

{
  const got = byKind.radii.map((r) => `${r.label}${r.radius}`).join(' ');
  check(
    `按钮 8 / 输入框 6 / 卡片 12 应各自成组，实际 ${got}`,
    byKind.radii.length === 3 &&
      byKind.radii.some((r) => r.kind === 'button' && r.radius === 8) &&
      byKind.radii.some((r) => r.kind === 'input' && r.radius === 6) &&
      byKind.radii.some((r) => r.kind === 'card' && r.radius === 12),
  );
  check(
    `每个类型都要带上这一类里的元素数，实际 [${byKind.radii.map((r) => r.count).join(',')}]`,
    byKind.radii.every((r) => r.count > 0),
  );
  check(
    '每个类型都要给出用途说明',
    byKind.radii.every((r) => r.usage.length > 0),
  );
}

{
  // 同一个类型下有两种圆角时，次要的要在 others 里如实带上，不能只报一个值
  const mixed = analyzeEffects(
    sample([
      ...many(5, { kind: 'button', radius: 8 }),
      ...many(2, { kind: 'button', radius: 4 }),
    ]),
  );
  const btn = mixed.radii.find((r) => r.kind === 'button');
  check(
    `按钮的主圆角应取多数 8，实际 ${btn ? btn.radius : '缺失'}`,
    !!btn && btn.radius === 8,
  );
  check(
    `按钮的次圆角 4 应出现在 others 里，实际 [${btn ? btn.others.join(',') : ''}]`,
    !!btn && btn.others.length === 1 && btn.others[0] === 4,
  );
}

{
  // 胶囊的两种写法归一。不归一会得到 999 和 9999 两个档，
  // 而它们在视觉上完全没有区别
  const pill = analyzeEffects(
    sample([...many(2, { kind: 'button', radius: 999 }), ...many(2, { kind: 'button', radius: 9999 })]),
  );
  const btn = pill.radii.find((r) => r.kind === 'button');
  check(
    `999 和 9999 应归到同一档胶囊，实际 ${btn ? btn.radius : '缺失'}`,
    !!btn && radiusLabel(btn.radius) === '胶囊',
  );
}

{
  // 徽标、头像、状态点和卡片在采集层是同一类（都是「有表面的元素」），
  // 但徽标几乎必然是胶囊而卡片不是。不分细的话，一页上五个徽标就能把
  // 卡片的圆角结论从 12 改成胶囊。这一条锁的就是那次细分
  const mixed = analyzeEffects(
    sample([
      ...many(3, cardLike({ radius: 12, backgroundColor: '#f6f6f4' })),
      ...many(
        5,
        s({ kind: 'card', radius: 999, backgroundColor: '#eef0ff', width: 80, height: 24, padding: [0, 0, 0, 0] }),
      ),
    ]),
  );
  const byLabel = new Map(mixed.radii.map((r) => [r.label, r.radius]));
  check(
    `卡片组的圆角应仍是 12，实际 ${byLabel.get('卡片') ?? '缺失'}`,
    byLabel.get('卡片') === 12,
  );
  check(
    `徽标应归到其他元素那一组，实际 ${byLabel.get('其他元素') === undefined ? '缺失' : radiusLabel(byLabel.get('其他元素')!)}`,
    byLabel.get('其他元素') !== undefined && radiusLabel(byLabel.get('其他元素')!) === '胶囊',
  );
}

// ---------------------------------------------------------------------
// 用例二：没有投影时明确说明（验收标准二）
// ---------------------------------------------------------------------

{
  const none = analyzeEffects(
    sample([
      ...many(3, { kind: 'button', radius: 8, backgroundColor: '#3d5afe' }),
      ...many(2, cardLike({ radius: 12, backgroundColor: '#f6f6f4' })),
    ]),
  );

  check(`完全没有投影时应报 usesShadow 为假，实际 ${none.usesShadow}`, none.usesShadow === false);
  check(`没有投影时 shadows 必须是空的，实际 ${none.shadows.length} 条`, none.shadows.length === 0);

  const note = none.notes.find((n) => n.kind === 'no-shadow');
  check('没有投影时必须给出一条明确说明', !!note);
  check(
    `说明里必须点明「完全没有使用投影」，实际：${note ? note.text.slice(0, 40) : '缺失'}`,
    !!note && note.text.indexOf('完全没有使用投影') !== -1,
  );
  // 这条说明是给复刻的人看的，必须带上「不要补默认阴影」这个动作，
  // 否则读文件的人会自己补一个，而原设计恰恰不靠阴影分层
  check(
    '说明里必须给出「不要补阴影」这个动作',
    !!note && note.text.indexOf('不要给卡片和按钮补默认阴影') !== -1,
  );
}

{
  const has = analyzeEffects(
    sample([
      ...many(2, { kind: 'card', radius: 12, shadow: 'rgba(0, 0, 0, 0.06) 0px 4px 12px 0px' }),
    ]),
  );
  check(`有投影时 usesShadow 应为真，实际 ${has.usesShadow}`, has.usesShadow === true);
  check(`有投影时不应出现「没有投影」的说明`, !has.notes.some((n) => n.kind === 'no-shadow'));
  check(
    `投影的 css 写法要可直接粘贴，实际 ${has.shadows[0] ? has.shadows[0].css : '缺失'}`,
    has.shadows.length === 1 &&
      !!has.shadows[0] &&
      has.shadows[0].css === '0px 4px 12px 0px rgba(0, 0, 0, 0.06)',
  );
}

{
  // 页面既没有边框也没有圆角时，同样要明确说出来，不能静默省略
  const bare = analyzeEffects(sample([...many(2, { kind: 'button', backgroundColor: '#3d5afe' })]));
  check('没有边框时要明确说明', bare.notes.some((n) => n.kind === 'no-border'));
  check('没有圆角时要明确说明', bare.notes.some((n) => n.kind === 'no-radius'));
}

// ---------------------------------------------------------------------
// 用例三：投影的归一
//
// 同一条声明在不同浏览器、不同写法下的计算值不一样，归一之后要能
// 落进同一组。归一没做对的话，一个页面上本来只有一条投影会报成三条。
// ---------------------------------------------------------------------

{
  // 颜色在前（Chrome）与颜色在后（Firefox）是同一个投影
  const order = analyzeEffects(
    sample([
      s({ kind: 'card', shadow: 'rgba(0, 0, 0, 0.1) 0px 1px 2px 0px' }),
      s({ kind: 'card', shadow: '0px 1px 2px 0px rgba(0, 0, 0, 0.1)' }),
    ]),
  );
  check(
    `颜色写在前或写在后应归为同一组，实际 ${order.shadows.length} 组`,
    order.shadows.length === 1,
  );
  check(
    `同一组里应累计到 2 个元素，实际 ${order.shadows[0] ? order.shadows[0].count : '缺失'}`,
    !!order.shadows[0] && order.shadows[0].count === 2,
  );
}

{
  // 省略 spread 与写满四个长度是同一个投影
  const spread = analyzeEffects(
    sample([
      s({ kind: 'card', shadow: 'rgba(0, 0, 0, 0.1) 0px 2px 8px' }),
      s({ kind: 'card', shadow: 'rgba(0, 0, 0, 0.1) 0px 2px 8px 0px' }),
    ]),
  );
  check(
    `省略扩展半径与写满四个长度应归为同一组，实际 ${spread.shadows.length} 组`,
    spread.shadows.length === 1,
  );
  const layer = spread.shadows[0] ? spread.shadows[0].layers[0] : undefined;
  check(
    `缺失的长度应补 0，实际扩展 ${layer ? layer.spread : '缺失'}`,
    !!layer && layer.spread === 0,
  );
}

{
  // 颜色里的逗号不能把一层切成好几层
  const comma = analyzeEffects(
    sample([s({ kind: 'card', shadow: 'rgba(0, 0, 0, 0.08) 0px 4px 12px 0px' })]),
  );
  const layers = comma.shadows[0] ? comma.shadows[0].layers : [];
  check(
    `颜色内部的逗号不应被当成分层，实际 ${layers.length} 层`,
    layers.length === 1,
  );
  check(
    `颜色应解析成带透明度的写法，实际 ${layers[0] ? layers[0].color : '缺失'}`,
    !!layers[0] && layers[0].color === 'rgba(0, 0, 0, 0.08)',
  );
}

{
  // 多层投影要完整保留，不能被砍成一层
  const multi = analyzeEffects(
    sample([
      s({
        kind: 'card',
        shadow: 'rgba(0, 0, 0, 0.1) 0px 1px 2px 0px, rgba(0, 0, 0, 0.06) 0px 4px 8px 0px',
      }),
    ]),
  );
  const g = multi.shadows[0];
  check(`两层投影应保留两层，实际 ${g ? g.layers.length : '缺失'} 层`, !!g && g.layers.length === 2);
  check(
    `两层拼成的 css 应保留逗号，实际 ${g ? g.css : '缺失'}`,
    !!g && g.css === '0px 1px 2px 0px rgba(0, 0, 0, 0.1), 0px 4px 8px 0px rgba(0, 0, 0, 0.06)',
  );
  check(
    `说明里要点出多层叠加，实际 ${g ? g.usage : '缺失'}`,
    !!g && g.usage.indexOf('2 层叠加') !== -1,
  );
}

{
  const inset = analyzeEffects(sample([s({ kind: 'input', shadow: 'inset 0px 1px 2px rgba(0, 0, 0, 0.1)' })]));
  const layer = inset.shadows[0] ? inset.shadows[0].layers[0] : undefined;
  check(`内投影应被识别，实际 ${layer ? layer.inset : '缺失'}`, !!layer && layer.inset === true);
  check(
    `内投影的 css 要带 inset 关键字，实际 ${inset.shadows[0] ? inset.shadows[0].css : '缺失'}`,
    inset.shadows.length === 1 && !!inset.shadows[0] && inset.shadows[0].css.indexOf('inset ') === 0,
  );
  check(
    `内投影的说明要点明用途，实际 ${inset.shadows[0] ? inset.shadows[0].usage.slice(0, 20) : '缺失'}`,
    inset.shadows.length === 1 && !!inset.shadows[0] && inset.shadows[0].usage.indexOf('凹') !== -1,
  );
}

{
  // 百分比通道写法。不折算的话 rgb(100% 0% 0%) 会被读成 rgb(1, 0, 0)，
  // 一个几乎全黑的颜色
  const pct = analyzeEffects(
    sample([s({ kind: 'card', shadow: 'rgb(100% 0% 0% / 20%) 0px 2px 4px 0px' })]),
  );
  const layer = pct.shadows[0] ? pct.shadows[0].layers[0] : undefined;
  check(
    `百分比通道要按 255 折算，实际 ${layer ? layer.color : '缺失'}`,
    !!layer && layer.color === 'rgba(255, 0, 0, 0.2)',
  );
}

{
  // 不透明的投影颜色用十六进制，带透明度的用 rgba。两者不能混
  const opaque = analyzeEffects(
    sample([s({ kind: 'card', shadow: 'rgb(0, 0, 0) 0px 2px 4px 0px' })]),
  );
  const layer = opaque.shadows[0] ? opaque.shadows[0].layers[0] : undefined;
  check(
    `不透明颜色应写成十六进制，实际 ${layer ? layer.color : '缺失'}`,
    !!layer && layer.color === '#000000',
  );
}

// ---------------------------------------------------------------------
// 用例四：边框
//
// 分割线和输入框都只有 1px 的线，宽度和颜色可能完全一样，
// 差别全在「有几条边」。少了可见边数这个字段，两者会被合成一条。
// ---------------------------------------------------------------------

{
  const borders = analyzeEffects(
    sample([
      ...many(3, { kind: 'input', borderWidth: 1, borderSides: 4, borderColor: '#d8d8d4' }),
      ...many(2, { kind: 'other', borderWidth: 1, borderSides: 1, borderColor: '#d8d8d4' }),
    ]),
  );

  check(
    `四边描边与单边分割线应分成两组，实际 ${borders.borders.length} 组`,
    borders.borders.length === 2,
  );
  const four = borders.borders.find((b) => b.sides === 4);
  const one = borders.borders.find((b) => b.sides === 1);
  check(`输入框应归到四边那一组，实际 ${four ? four.kinds.join(',') : '缺失'}`, !!four && four.kinds.indexOf('input') !== -1);
  check(
    `分割线的说明要点明它是分割线而不是边框，实际 ${one ? one.usage : '缺失'}`,
    !!one && one.usage.indexOf('分割线') !== -1,
  );
  check(
    `四边描边的说明要点明是完整的框，实际 ${four ? four.usage : '缺失'}`,
    !!four && four.usage.indexOf('完整的框') !== -1,
  );
}

{
  // 线型要区分。虚线的分割线和实线的输入框是两种语言
  const dashed = analyzeEffects(
    sample([s({ kind: 'other', borderWidth: 1, borderSides: 1, borderStyle: 'dashed', borderColor: '#d8d8d4' })]),
  );
  check(
    `虚线线型要写进说明，实际 ${dashed.borders[0] ? dashed.borders[0].usage : '缺失'}`,
    dashed.borders.length === 1 && !!dashed.borders[0] && dashed.borders[0].usage.indexOf('虚线') !== -1,
  );
}

// ---------------------------------------------------------------------
// 用例五：分组门槛与空输入
// ---------------------------------------------------------------------

{
  // 只出现一次的投影必须报出来。全页只有一个弹层带投影很常见，
  // 而这一处恰恰最需要复刻。按次数过滤会把它丢掉
  const once = analyzeEffects(
    sample([
      ...many(3, { kind: 'button', radius: 8 }),
      s({ kind: 'other', shadow: 'rgba(0, 0, 0, 0.12) 0px 8px 24px 0px' }),
    ]),
  );
  check(
    `只出现一次的投影也要报出来，实际 ${once.shadows.length} 组`,
    once.shadows.length === 1,
  );
  check(
    `这一组应带上它出现在哪类元素上，实际 [${once.shadows[0] ? once.shadows[0].kinds.join(',') : ''}]`,
    !!once.shadows[0] && once.shadows[0].kinds.indexOf('other') !== -1,
  );
}

{
  const empty = analyzeEffects(sample([]));
  check(
    '空页面应返回空结果而不是抛错',
    empty.radii.length === 0 && empty.borders.length === 0 && empty.shadows.length === 0,
  );
  check('空页面必须给出说明', empty.notes.length > 0);
}

{
  // 字段残缺时不能抛错。采集结果穿过一次序列化边界，理论上可能变形
  const broken = analyzeEffects({
    ...sample([]),
    styles: [
      { kind: 'card' } as unknown as StyleObservation,
      { kind: 'card', radius: null } as unknown as StyleObservation,
      { kind: 'card', shadow: 12345 } as unknown as StyleObservation,
    ],
  });
  check('字段残缺的观测应被安全跳过，不抛错', broken.shadows.length === 0 && broken.borders.length === 0);
}

{
  // 认不出来的颜色写法原样保留，不猜一个值出来
  const exotic = analyzeEffects(
    sample([s({ kind: 'card', shadow: 'oklch(0.7 0.1 250) 0px 2px 4px 0px' })]),
  );
  const layer = exotic.shadows[0] ? exotic.shadows[0].layers[0] : undefined;
  check(
    `认不出的颜色格式应原样保留，实际 ${layer ? layer.color : '缺失'}`,
    !!layer && layer.color === 'oklch(0.7 0.1 250)',
  );
}

// ---------------------------------------------------------------------
// 用例六：阈值边界
// ---------------------------------------------------------------------

{
  // 样本过少时必须提醒，否则一个只有两三个元素的页面上得出的结论
  // 会被当成可信的结论直接用出去
  const thin = analyzeEffects(sample([s({ kind: 'button', radius: 8 })]));
  check('样本过少时要给出说明', thin.notes.some((n) => n.kind === 'thin-sample'));
  const enough = analyzeEffects(
    sample([
      ...many(4, { kind: 'button', radius: 8 }),
      ...many(4, { kind: 'card', radius: 12 }),
    ]),
  );
  check('样本充足时不应给出样本偏少的提示', !enough.notes.some((n) => n.kind === 'thin-sample'));
}

// ---------------------------------------------------------------------

console.log('='.repeat(56));
console.log('断言结果（圆角按元素类型 / 边框按边数与线型 / 投影归一）');
console.log('='.repeat(56));
for (const line of report) console.log(line);
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项未通过`);

process.exit(failed === 0 ? 0 : 1);
