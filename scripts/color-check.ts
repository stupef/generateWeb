/**
 * 颜色分析层的回归检查，用合成数据跑，不需要浏览器。
 *
 * 运行：npm run check:color
 *
 * 三个用例分别覆盖浅色、常规深色、近黑阶梯三条路径。后两条不是可有可无的补充：
 * 深色站点里「主要文字色」是浅色、「页面底色」是深色，角色推断方向整个反过来；
 * 近黑阶梯那条覆盖的是 OKLab 距离在暗端失真、必须靠对比度数字兜底的情况。
 * 只测浅色的话这两条分支永远不会暴露问题。
 *
 * 每个 token 的期望值都是人工指定的。改分析逻辑之前先跑一遍这个脚本，
 * 改完必须让所有断言回到全绿。
 */
import {
  analyzeColors,
  contrastRatio,
  describeNearCanvas,
  MERGE_THRESHOLD,
  NEAR_CANVAS_CONTRAST,
} from '../src/core/color';
import type {
  BackgroundSummary,
  ElementObservation,
  EmbeddedContentSummary,
  PageSample,
  StyleObservation,
} from '../src/core/types';

/**
 * 局部声明退出码用的 Node 全局。
 *
 * 故意不装 @types/node：这个项目的源码只跑在浏览器里，
 * 一旦把 Node 的全局类型并进来，DOM 里同名的 setTimeout、fetch 这些
 * 就会被 Node 的重载覆盖，扩展代码会拿到错误的类型。
 */
declare const process: { exit(code?: number): never };

/**
 * 用例里的元素编号。自增而不是一律给 0，因为溯源断言要验「命中了哪几个
 * 元素」，全都同名就验不出任何东西。
 */
let refSeq = 0;

function el(partial: Partial<ElementObservation>): ElementObservation {
  return {
    ref: refSeq++,
    tag: 'DIV',
    textChars: 0,
    fontSize: 16,
    area: 1000,
    isControl: false,
    definesSurface: false,
    textColor: null,
    backgroundColor: null,
    borderColor: null,
    borderWidth: 0,
    ...partial,
  };
}

/**
 * 这两个用例只关心颜色分析，所以背景检测结果留空。
 * 渐变检测的断言在 scripts/background-check.ts 里单独覆盖。
 */
const noBackground: BackgroundSummary = {
  gradient: { elementCount: 0, viewportAreaRatio: 0, kinds: [], samples: [] },
  imageBackedCount: 0,
};

/** 正常的单文档页面，没有框架也没有嵌入式文档 */
const plainStructure: EmbeddedContentSummary = {
  contentType: 'text/html',
  pdfEmbeds: 0,
  largeFrames: 0,
  largestFrameRatio: 0,
  framesetDocument: false,
  sameOriginFrames: 0,
  blockedFrames: 0,
};

function sample(canvasColor: string, elements: ElementObservation[], prefersDark: boolean): PageSample {
  const styles: StyleObservation[] = elements
    .filter((item) => item.tag === 'BUTTON')
    .map((item) => ({
      ref: item.ref,
      tag: item.tag,
      kind: 'button' as const,
      inNav: false,
      textChars: item.textChars,
      childCount: 0,
      fillsParent: false,
      backgroundColor: item.backgroundColor,
      textColor: item.textColor,
      padding: [8, 12, 8, 12] as [number, number, number, number],
      radius: 5,
      borderWidth: item.borderWidth,
      borderSides: item.borderWidth > 0 ? 4 : 0,
      borderStyle: item.borderWidth > 0 ? 'solid' : '',
      borderColor: item.borderColor,
      shadow: null,
      width: 120,
      height: 40,
      fontSize: 16,
      fontWeight: 600,
      fontFamily: 'Arial',
    }));
  return {
    url: 'https://example.com/',
    title: '合成样例',
    viewportWidth: 1440,
    viewportHeight: 900,
    canvasColor,
    prefersDark,
    elements,
    // 颜色用例不关心排版和间距，留空即可。这两条通道分别由
    // scripts/typography-check.ts 和 scripts/spacing-check.ts 覆盖
    typography: [],
    boxes: [],
    styles,
    webFontFamilies: [],
    background: noBackground,
    embedded: plainStructure,
    textCharsTotal: elements.reduce((n, e) => n + e.textChars, 0),
    skipped: 12,
    visited: elements.length,
    truncated: false,
    elapsedMs: 42,
  };
}

// ---------------------------------------------------------------------
// 用例一：浅色 SaaS 页面
// 纯白画布、深灰正文、中灰辅助文字、浅灰卡片、浅灰边框、蓝色主按钮
// ---------------------------------------------------------------------
const lightElements: ElementObservation[] = [
  el({ tag: 'BODY', backgroundColor: '#ffffff', definesSurface: true, area: 1_400_000 }),
];

for (let i = 0; i < 40; i++) {
  lightElements.push(el({ tag: 'P', textChars: 120, textColor: '#1a1a1a', area: 40_000 }));
}
// 同色不同写法的干扰项，必须被合并掉
lightElements.push(el({ tag: 'P', textChars: 30, textColor: '#1a1a19', area: 8_000 }));
lightElements.push(el({ tag: 'SPAN', textChars: 20, textColor: '#1b1b1b', area: 4_000 }));

for (let i = 0; i < 18; i++) {
  lightElements.push(el({ tag: 'SPAN', textChars: 24, textColor: '#6b7280', area: 3_000 }));
}
lightElements.push(el({ tag: 'SPAN', textChars: 10, textColor: '#6b7281', area: 1_200 }));

// 卡片底色离纯白很近，但属于真实层级，不能被合并掉
for (let i = 0; i < 9; i++) {
  lightElements.push(el({ tag: 'DIV', backgroundColor: '#f9fafb', definesSurface: true, area: 60_000 }));
}

for (let i = 0; i < 26; i++) {
  lightElements.push(el({ tag: 'DIV', borderColor: '#e5e7eb', borderWidth: 1, area: 12_000 }));
}

for (let i = 0; i < 3; i++) {
  lightElements.push(
    el({
      tag: 'BUTTON',
      isControl: true,
      backgroundColor: '#2563eb',
      definesSurface: true,
      textChars: 8,
      textColor: '#ffffff',
      area: 9_000,
    }),
  );
}

// 噪声：只出现一次的装饰色
lightElements.push(el({ tag: 'SVG', backgroundColor: '#ff00ff', definesSurface: true, area: 400 }));

// ---------------------------------------------------------------------
// 用例二：深色站点
// 近黑画布、石墨卡片、米白正文、灰蓝辅助文字、钴蓝主按钮
// ---------------------------------------------------------------------
const darkElements: ElementObservation[] = [
  el({ tag: 'BODY', backgroundColor: '#171721', definesSurface: true, area: 1_400_000 }),
];

for (let i = 0; i < 36; i++) {
  darkElements.push(el({ tag: 'P', textChars: 110, textColor: '#ededf3', area: 38_000 }));
}
for (let i = 0; i < 20; i++) {
  darkElements.push(el({ tag: 'SPAN', textChars: 26, textColor: '#c3c3cc', area: 3_200 }));
}

// 卡片比画布亮一档，靠明度差而不是阴影做层次
for (let i = 0; i < 10; i++) {
  darkElements.push(el({ tag: 'DIV', backgroundColor: '#1e1e2a', definesSurface: true, area: 72_000 }));
}

for (let i = 0; i < 4; i++) {
  darkElements.push(el({ tag: 'DIV', borderColor: '#70707d', borderWidth: 1, area: 15_000 }));
}

for (let i = 0; i < 2; i++) {
  darkElements.push(
    el({
      tag: 'BUTTON',
      isControl: true,
      backgroundColor: '#5266eb',
      definesSurface: true,
      textChars: 8,
      textColor: '#ffffff',
      area: 10_000,
    }),
  );
}

// 噪声：只出现一次的暖橙装饰
darkElements.push(el({ tag: 'SVG', backgroundColor: '#ff9900', definesSurface: true, area: 500 }));

// ---------------------------------------------------------------------
// 用例三：近黑阶梯（还原 linear.app 深色主题的真实结构）
// 页面底色 #08090a，卡片底色 #101112，两者对屏幕而言几乎同色
// ---------------------------------------------------------------------
const nearBlackElements: ElementObservation[] = [
  el({ tag: 'BODY', backgroundColor: '#08090a', definesSurface: true, area: 1_400_000 }),
];

for (let i = 0; i < 36; i++) {
  nearBlackElements.push(el({ tag: 'P', textChars: 110, textColor: '#f7f8f8', area: 38_000 }));
}
for (let i = 0; i < 20; i++) {
  nearBlackElements.push(el({ tag: 'SPAN', textChars: 26, textColor: '#8a8f98', area: 3_200 }));
}

// 与页面底色只差一个色阶的卡片底色。这一层不许被合并掉，
// 但必须在结果里明说它和底色几乎一样。Linear 实测的对比度是 1.05:1
for (let i = 0; i < 10; i++) {
  nearBlackElements.push(
    el({ tag: 'DIV', backgroundColor: '#101112', definesSurface: true, area: 72_000 }),
  );
}

for (let i = 0; i < 6; i++) {
  nearBlackElements.push(el({ tag: 'DIV', borderColor: '#26282b', borderWidth: 1, area: 15_000 }));
}

for (let i = 0; i < 2; i++) {
  nearBlackElements.push(
    el({
      tag: 'BUTTON',
      isControl: true,
      backgroundColor: '#5e6ad2',
      definesSurface: true,
      textChars: 8,
      textColor: '#ffffff',
      area: 10_000,
    }),
  );
}

// ---------------------------------------------------------------------
// 断言框架
// ---------------------------------------------------------------------
interface Case {
  name: string;
  data: PageSample;
  roles: [string, string][];
  mergedIntoPrimary?: string[];
  discarded: string[];
}

const cases: Case[] = [
  {
    name: '浅色 SaaS 页面',
    data: sample('#ffffff', lightElements, false),
    roles: [
      ['neutral', '#ffffff'],
      ['primary', '#1a1a1a'],
      ['secondary', '#6b7280'],
      ['tertiary', '#2563eb'],
      ['surface', '#f9fafb'],
      ['border', '#e5e7eb'],
    ],
    mergedIntoPrimary: ['#1a1a19', '#1b1b1b'],
    discarded: ['#ff00ff'],
  },
  {
    name: '深色站点',
    data: sample('#171721', darkElements, true),
    roles: [
      ['neutral', '#171721'],
      ['primary', '#ededf3'],
      ['secondary', '#c3c3cc'],
      ['tertiary', '#5266eb'],
      ['surface', '#1e1e2a'],
      ['border', '#70707d'],
    ],
    discarded: ['#ff9900'],
  },
  {
    name: '近黑阶梯（Linear 深色主题）',
    data: sample('#08090a', nearBlackElements, true),
    roles: [
      ['neutral', '#08090a'],
      ['primary', '#f7f8f8'],
      ['secondary', '#8a8f98'],
      ['tertiary', '#5e6ad2'],
      ['surface', '#101112'],
      ['border', '#26282b'],
    ],
    discarded: ['#ffffff'],
  },
];

let failed = 0;
const report: string[] = [];

for (const c of cases) {
  const result = analyzeColors(c.data);

  console.log('='.repeat(56));
  console.log(`${c.name}　原始颜色 ${result.rawColorCount} 个，合并后 ${result.clusterCount} 个色簇`);
  console.log('='.repeat(56));

  for (const r of result.roles) {
    console.log(`[${r.token}] ${r.label}  ${r.hex.toUpperCase()}  (${r.confidence})`);
    console.log(`    对比底色 ${r.contrastWithCanvas}:1`);
    console.log(`    ${r.usage}`);
    if (r.mergedFrom.length > 0) {
      console.log(`    合并了 ${r.mergedFrom.map((m) => m.hex).join(', ')}`);
    }
    if (r.nearCanvas) {
      console.log(`    [近色提示] ${r.nearCanvas.text}`);
    }
    console.log('');
  }

  console.log('被丢弃的颜色');
  for (const d of result.discarded) {
    console.log(`  ${d.hex.toUpperCase()}  出现 ${d.count} 次  ${d.reason}`);
  }
  console.log('');

  for (const [token, hex] of c.roles) {
    const got = result.roles.find((r) => r.token === token);
    const ok = got?.hex === hex;
    if (!ok) failed++;
    report.push(`${ok ? '✓' : '✗'} [${c.name}] ${token} 应为 ${hex}，实际 ${got?.hex ?? '(缺失)'}`);
  }

  if (c.mergedIntoPrimary) {
    const primary = result.roles.find((r) => r.token === 'primary');
    const missing = c.mergedIntoPrimary.filter(
      (h) => !primary?.mergedFrom.some((m) => m.hex === h),
    );
    const ok = missing.length === 0;
    if (!ok) failed++;
    report.push(
      `${ok ? '✓' : '✗'} [${c.name}] primary 合并同色不同写法${ok ? '' : `，漏掉 ${missing.join(', ')}`}`,
    );
  }

  for (const hex of c.discarded) {
    const asRole = result.roles.find((r) => r.hex === hex);
    const recorded = result.discarded.find((d) => d.hex === hex);
    const ok = !asRole && !!recorded;
    if (!ok) failed++;
    report.push(
      `${ok ? '✓' : '✗'} [${c.name}] 偶然色 ${hex} 不得成为角色且需记入丢弃清单` +
        (ok ? '' : `（角色：${asRole ? asRole.token : '无'}，清单：${recorded ? '有' : '无'}）`),
    );
  }

  const hasPrimary = result.roles.some((r) => r.token === 'primary');
  if (!hasPrimary) failed++;
  report.push(`${hasPrimary ? '✓' : '✗'} [${c.name}] 存在 primary（DESIGN.md lint 要求）`);
}

// ---------------------------------------------------------------------
// 近色提示的定点回归
//
// 这一组守的是「近黑不合并，改成明说」这个决定。起点是用户实测
// linear.app：页面底色 #08090a 与卡片底色 #101112 在屏幕上分不出来，
// 但工具判成两个角色且没给任何解释。
// ---------------------------------------------------------------------
const nearCase = analyzeColors(cases[2]!.data);
const nearSurface = nearCase.roles.find((r) => r.token === 'surface');
const nearNeutral = nearCase.roles.find((r) => r.token === 'neutral');

{
  const ok = !!nearSurface?.nearCanvas;
  if (!ok) failed++;
  report.push(`${ok ? '✓' : '✗'} [近色] surface 与底色对比过低时必须给出提示`);
}

{
  const ratio = nearSurface?.nearCanvas?.ratio;
  const ok = ratio === 1.05;
  if (!ok) failed++;
  report.push(`${ok ? '✓' : '✗'} [近色] 提示里的对比度应为 1.05，实际 ${ratio ?? '(无)'}`);
}

{
  const text = nearSurface?.nearCanvas?.text ?? '';
  const says = [
    ['差多少', text.includes('1.05:1')],
    ['为什么没合并', text.includes('真实存在的层级')],
    ['要不要留', text.includes('可以只保留一个')],
  ] as const;
  const bad = says.filter(([, hit]) => !hit).map(([name]) => name);
  const ok = bad.length === 0;
  if (!ok) failed++;
  report.push(
    `${ok ? '✓' : '✗'} [近色] 提示要同时说清差多少、为什么没合并、要不要留` +
      (ok ? '' : `（缺：${bad.join('、')}）`),
  );
}

{
  const ok = nearNeutral?.nearCanvas === null;
  if (!ok) failed++;
  report.push(`${ok ? '✓' : '✗'} [近色] 页面底色自己不给提示（它是 1:1）`);
}

{
  const falsePositives = nearCase.roles.filter(
    (r) => r.token !== 'neutral' && r.token !== 'surface' && r.nearCanvas,
  );
  const ok = falsePositives.length === 0;
  if (!ok) failed++;
  report.push(
    `${ok ? '✓' : '✗'} [近色] 对比度高于 ${NEAR_CANVAS_CONTRAST} 的角色不得出现提示` +
      (ok ? '' : `（误报：${falsePositives.map((r) => r.token).join(', ')}）`),
  );
}

{
  // 沿用渐变那层的守卫思路：这一层只负责解释，不许顺手把色值再报一遍
  const hexes = (nearSurface?.nearCanvas?.text ?? '').match(/#[0-9a-f]{3,8}/gi) ?? [];
  const ok = hexes.length === 0;
  if (!ok) failed++;
  report.push(`${ok ? '✓' : '✗'} [近色] 提示里不得出现十六进制色值（这层只解释，不给值）`);
}

// 这两条必须同时成立，它们说明「为什么不能靠调阈值解决」。
// 阈值调大到能吞掉 #08090a / #101112（OKLab 距离 0.03798），
// 必然也吞掉 #ffffff / #f9fafb（距离 0.01547），浅色卡片层级会一起消失。
{
  const ok = nearSurface?.hex === '#101112' && nearNeutral?.hex === '#08090a';
  if (!ok) failed++;
  report.push(`${ok ? '✓' : '✗'} [阈值] 深色对 #08090a / #101112 不得被合并`);
}
{
  const light = analyzeColors(cases[0]!.data);
  const s = light.roles.find((r) => r.token === 'surface');
  const n = light.roles.find((r) => r.token === 'neutral');
  const ok = s?.hex === '#f9fafb' && n?.hex === '#ffffff';
  if (!ok) failed++;
  report.push(`${ok ? '✓' : '✗'} [阈值] 浅色对 #ffffff / #f9fafb 不得被合并（同一枚阈值的另一侧）`);
}

// ---------------------------------------------------------------------
// describeNearCanvas 的直接单测，不经过角色分配
// ---------------------------------------------------------------------
{
  // Linear 实际写进 CSS 的 6 级阶梯（第 7 级是底色本身）。1.2 这个界
  // 就是为了把整条阶梯覆盖进来才定的
  const ladder = ['#0f1011', '#101112', '#111213', '#161718', '#18191a', '#191d20'];
  const missed = ladder.filter((h) => describeNearCanvas(h, '#08090a', 'surface') === null);
  const ok = missed.length === 0;
  if (!ok) failed++;
  report.push(
    `${ok ? '✓' : '✗'} [近色] Linear 近黑阶梯 6 级全部覆盖（这是 ${NEAR_CANVAS_CONTRAST} 的取值依据）` +
      (ok ? '' : `（漏掉：${missed.join(', ')}）`),
  );
}

{
  const cases2: [string, string, string, string][] = [
    ['#08090a', '#08090a', 'neutral', '底色自己，1:1'],
    ['#ffffff', '#08090a', 'primary', '正文，19.93:1'],
    ['#26282b', '#08090a', 'border', '边框，1.35:1 已超出界'],
  ];
  const bad = cases2
    .filter(([hex, canvas, token]) => describeNearCanvas(hex, canvas, token) !== null)
    .map(([, , , why]) => why);
  const ok = bad.length === 0;
  if (!ok) failed++;
  report.push(
    `${ok ? '✓' : '✗'} [近色] 不该提示的三类情况都要返回 null` + (ok ? '' : `（误报：${bad.join('、')}）`),
  );
}

{
  // 阈值必须待在两个实测边界之间：
  //   下界 0.00434 = #1a1a1a vs #1b1b1b，同色不同写法，必须合并
  //   上界 0.01547 = #ffffff vs #f9fafb，浅色卡片层级，必须区分
  // 想靠调大阈值来解决近黑那一对（距离 0.03798）会直接撞破上界，
  // 浅色卡片层级会一起消失。这是本文件里最不该被绕过的一条。
  const LOWER = 0.00434;
  const UPPER = 0.01547;
  const ok = MERGE_THRESHOLD > LOWER && MERGE_THRESHOLD < UPPER;
  if (!ok) failed++;
  report.push(
    `${ok ? '✓' : '✗'} [阈值] ${MERGE_THRESHOLD} 应落在实测边界 ${LOWER} ~ ${UPPER} 之间` +
      (ok ? '' : '（调大就会吞掉浅色卡片层级，调小则同色不同写法会重复出现）'),
  );
}

const blackWhite = contrastRatio('#000000', '#ffffff');
const contrastOk = Math.abs(blackWhite - 21) < 0.01;
if (!contrastOk) failed++;
report.push(`${contrastOk ? '✓' : '✗'} 对比度算法黑白应为 21:1，实际 ${blackWhite.toFixed(2)}`);

console.log('='.repeat(56));
console.log(`断言结果（合并阈值 ${MERGE_THRESHOLD}）`);
console.log('='.repeat(56));
for (const line of report) console.log(line);
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项未通过`);

process.exit(failed === 0 ? 0 : 1);
