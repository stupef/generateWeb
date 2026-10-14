/**
 * DESIGN.md 生成器的回归检查，纯 Node 跑，不需要浏览器。
 *
 * 运行：npm run check:design-md
 *
 * 这个脚本守的是「生成出来的文件能不能过 Google 那份规范的 lint」。
 * 规范来自 google-labs-code/design.md，它的 lint 规则里有一半是纯结构检查，
 * 不依赖网络也不依赖官方工具，就在这里自己实现一遍：
 *
 *   broken-ref           花括号引用必须能解析到某个已定义的 token
 *   missing-primary      colors 里有条目时必须存在 primary
 *   missing-typography   有 colors 就必须有 typography
 *   section-order        章节必须按规范顺序出现
 *   unknown-key          顶层键只能来自 schema
 *   token-like-ignored   同上，看起来像 token 的顶层键不能被静默忽略
 *
 * 剩下几条这里查不了，得靠真实页面和官方 linter：
 * contrast-ratio 要知道每个组件对的对比度、orphaned-tokens 要知道哪个颜色
 * 没被引用、token-summary 和 missing-sections 是纯统计。前两条另有断言在
 * 下面用 color.ts 的对比度函数覆盖。
 *
 * 两组判据的边界要说清楚：白名单、章节顺序、引用语法这些常量从
 * design-md.ts 导入，不在这里另写一份。两份判据早晚分叉，而分叉在这类
 * 格式约定上极难从结果看出来——生成端放宽了而校验端没放宽，最坏的结果是
 * 生成器产出不合规的文件而检查全绿。
 */
import {
  COMPONENT_TOKEN_KEYS,
  DESIGN_MD_SECTIONS,
  FRONT_MATTER_KEYS,
  IMPERATIVE,
  SELF_INSPECTION,
  collectReferences,
  collectSections,
  collectTokenPaths,
  frontMatterOf,
  renderDesignMd,
} from '../src/core/design-md';
import type { AiSemantics } from '../src/core/semantics';
import { analyzeColors, contrastRatio } from '../src/core/color';
import { analyzeComponents } from '../src/core/components';
import { analyzeEffects } from '../src/core/effects';
import { analyzeSpacing } from '../src/core/spacing';
import { analyzeTypography } from '../src/core/typography';
import { buildSampleExport, type SampleExport } from '../src/core/export';
import type {
  BackgroundSummary,
  BoxObservation,
  ElementObservation,
  EmbeddedContentSummary,
  PageSample,
  StyleObservation,
  TypeObservation,
} from '../src/core/types';

/** 局部声明退出码用的 Node 全局，理由同 color-check.ts，不引入 @types/node */
declare const process: { exit(code?: number): void };

const report: string[] = [];
let failed = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failed++;
  report.push(`${ok ? '✓' : '✗'} ${name}${!ok && detail ? `　→ 实际 ${detail}` : ''}`);
}

function eq(name: string, actual: unknown, expected: unknown): void {
  const a = typeof actual === 'string' ? actual : JSON.stringify(actual);
  const e = typeof expected === 'string' ? expected : JSON.stringify(expected);
  check(name, a === e, `${a}（期望 ${e}）`);
}

// ---------------------------------------------------------------------
// front matter 解析
//
// 输出格式由 design-md.ts 完全控制，缩进只有 0 / 2 / 4 三档，按行匹配就够，
// 不为这个检查引入一个 YAML 库。
// ---------------------------------------------------------------------

interface FmEntry {
  indent: number;
  key: string;
  value: string;
  top: string | null;
  sub: string | null;
}

function parseFrontMatter(md: string): FmEntry[] {
  const fm = frontMatterOf(md);
  if (!fm) return [];

  const out: FmEntry[] = [];
  let top: string | null = null;
  let sub: string | null = null;

  for (const raw of fm.split('\n')) {
    const m = /^( *)([A-Za-z0-9_-]+):(.*)$/.exec(raw);
    if (!m) continue;

    const indent = (m[1] ?? '').length;
    const key = m[2] ?? '';
    const value = (m[3] ?? '').trim();

    if (indent === 0) {
      top = value.length === 0 ? key : null;
      sub = null;
    } else if (indent === 2) {
      sub = value.length === 0 ? key : null;
    }

    out.push({ indent, key, value, top, sub });
  }

  return out;
}

// ---------------------------------------------------------------------
// 合成样本
// ---------------------------------------------------------------------

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

/**
 * 用例里的元素编号。这个脚本验的是生成出来的文件长什么样，不验溯源，
 * 所以编号只要唯一即可，不与其它数组对齐。
 */
let elRefSeq = 0;
let tyRefSeq = 0;

function el(
  tag: string,
  textChars: number,
  fontSize: number,
  textColor: string | null,
  backgroundColor: string | null,
  isControl = false,
): ElementObservation {
  return {
    ref: elRefSeq++,
    tag,
    textChars,
    fontSize,
    area: textChars * 900 + 4000,
    isControl,
    definesSurface: backgroundColor !== null,
    textColor,
    backgroundColor,
    borderColor: null,
    borderWidth: 0,
  };
}

function ty(
  tag: string,
  headingLevel: number,
  fontSize: number,
  fontWeight: number,
  textChars: number,
  family = 'Inter, sans-serif',
  isControl = false,
): TypeObservation {
  return {
    ref: tyRefSeq++,
    tag,
    headingLevel,
    fontFamily: family,
    fontWeight,
    fontSize,
    lineHeight: Math.round(fontSize * 1.6),
    letterSpacing: null,
    textChars,
    isControl,
  };
}

/**
 * 样本刻意造得比普通页面全：三级标题、一级正文、三级辅助文字再加一级代码，
 * 一共八级。规范对字号层级的数量没有约束，但命名规则必须对任意级数都成立，
 * 所以这里要拿满 MAX_STEPS 来试，尤其是 headline 组超过三个时的后缀分配。
 */
const elements: ElementObservation[] = [
  el('BODY', 0, 16, null, '#ffffff'),
  el('H1', 14, 36, '#18181b', null),
  el('H2', 22, 28, '#18181b', null),
  el('H3', 26, 22, '#18181b', null),
  el('P', 420, 16, '#3f3f46', null),
  el('SPAN', 90, 13, '#71717a', null),
  el('SMALL', 60, 12, '#71717a', null),
  el('TIME', 40, 11, '#a1a1aa', null),
  el('CODE', 70, 14, '#3f3f46', null),
  el('DIV', 0, 16, null, '#f4f4f5'),
  el('BUTTON', 8, 14, '#ffffff', '#2563eb', true),
];

const typography: TypeObservation[] = [
  ty('H1', 1, 36, 700, 14),
  ty('H2', 2, 28, 700, 22),
  ty('H3', 3, 22, 700, 26),
  ty('P', 0, 16, 400, 420),
  ty('SPAN', 0, 13, 400, 90),
  ty('SMALL', 0, 12, 400, 60),
  ty('TIME', 0, 11, 400, 40),
  ty('CODE', 0, 14, 500, 70, 'JetBrains Mono, monospace'),
];

const boxes: BoxObservation[] = [
  {
    ref: 0,
    tag: 'DIV',
    padding: [24, 24, 24, 24],
    margin: [0, 0, 0, 0],
    gap: null,
    radius: 12,
    width: 640,
    maxWidth: 1120,
    looksLikeCard: true,
    isControl: false,
    isLandmark: false,
    layout: 'block',
  },
  {
    ref: 10,
    tag: 'BUTTON',
    padding: [10, 18, 10, 18],
    margin: [0, 0, 0, 0],
    gap: null,
    radius: 8,
    width: 110,
    maxWidth: null,
    looksLikeCard: false,
    isControl: true,
    isLandmark: false,
    layout: 'block',
  },
];

const styles: StyleObservation[] = [
  {
    ref: 10,
    tag: 'BUTTON',
    kind: 'button',
    inNav: false,
    textChars: 8,
    childCount: 0,
    fillsParent: false,
    backgroundColor: '#2563eb',
    textColor: '#ffffff',
    padding: [10, 18, 10, 18],
    radius: 8,
    borderWidth: 0,
    borderSides: 0,
    borderStyle: '',
    borderColor: null,
    shadow: null,
    width: 110,
    height: 40,
    fontSize: 14,
    fontWeight: 500,
    fontFamily: 'Inter, sans-serif',
  },
  {
    ref: 0,
    tag: 'DIV',
    kind: 'card',
    inNav: false,
    textChars: 0,
    childCount: 3,
    fillsParent: false,
    backgroundColor: '#ffffff',
    textColor: '#3f3f46',
    padding: [24, 24, 24, 24],
    radius: 12,
    borderWidth: 1,
    borderSides: 4,
    borderStyle: 'solid',
    borderColor: '#e4e4e7',
    shadow: null,
    width: 640,
    height: 220,
    fontSize: 16,
    fontWeight: 400,
    fontFamily: 'Inter, sans-serif',
  },
];

function sample(): PageSample {
  return {
    url: 'https://example.com/pricing',
    title: '定价',
    viewportWidth: 1440,
    viewportHeight: 900,
    canvasColor: '#ffffff',
    prefersDark: false,
    elements,
    typography,
    boxes,
    styles,
    webFontFamilies: [],
    background: noBackground,
    embedded: plainStructure,
    textCharsTotal: 740,
    skipped: 12,
    visited: 240,
    truncated: false,
    elapsedMs: 180,
  };
}

const FIXED_TIME = new Date(2026, 9, 13, 10, 0, 0);

function exportOf(input: PageSample, at: Date = FIXED_TIME): SampleExport {
  return buildSampleExport({
    sample: input,
    colors: analyzeColors(input),
    typography: analyzeTypography(input),
    spacing: analyzeSpacing(input),
    effects: analyzeEffects(input),
    components: analyzeComponents(input),
    extractorVersion: '0.1.0',
    generatedAt: at,
  });
}

const base = exportOf(sample());
const md = renderDesignMd(base);
const entries = parseFrontMatter(md);

// ---------------------------------------------------------------------
// 一、文件骨架
// ---------------------------------------------------------------------

check('以 front matter 开头', md.startsWith('---\n'));
check('front matter 有结束围栏', frontMatterOf(md) !== null);
check('正文非空', md.length > 200, String(md.length));
check('以换行结尾', md.endsWith('\n'));
// 围栏一共出现两次，多一次说明正文里混进了 --- 分隔线
eq('围栏数量为二', (md.match(/^---$/gm) ?? []).length, 2);

const topKeys = entries.filter((e) => e.indent === 0).map((e) => e.key);
const allowed = FRONT_MATTER_KEYS as readonly string[];
const strays = topKeys.filter((k) => allowed.indexOf(k) === -1);
eq('顶层键全部在 schema 内', strays.join(',') || '—', '—');
check('name 存在', topKeys.indexOf('name') !== -1);
check('version 存在', topKeys.indexOf('version') !== -1);

const nameEntry = entries.find((e) => e.indent === 0 && e.key === 'name');
check('name 是非空字符串', (nameEntry?.value ?? '').length > 2, nameEntry?.value);

const versionEntry = entries.find((e) => e.indent === 0 && e.key === 'version');
eq('version 取规范当前值', versionEntry?.value, '"alpha"');

// ---------------------------------------------------------------------
// 二、colors
// ---------------------------------------------------------------------

const colorEntries = entries.filter((e) => e.indent === 2 && e.top === 'colors');
check('有颜色 token', colorEntries.length > 0, String(colorEntries.length));
check(
  '存在 primary（missing-primary）',
  colorEntries.some((e) => e.key === 'primary'),
  colorEntries.map((e) => e.key).join(','),
);
check(
  '每个颜色都是六位十六进制',
  colorEntries.every((e) => /^"#[0-9A-F]{6}"$/.test(e.value)),
  colorEntries.map((e) => e.value).join(','),
);
check(
  '颜色 token 名唯一',
  new Set(colorEntries.map((e) => e.key)).size === colorEntries.length,
);
// 色板里的颜色角色必须一个不少地带出去，砍掉任何一个都会让复刻时少一个色
eq(
  '颜色角色与结论同源',
  colorEntries.length,
  base.analysis.colors.roles.length,
);

// ---------------------------------------------------------------------
// 三、typography
// ---------------------------------------------------------------------

const typeEntries = entries.filter((e) => e.indent === 2 && e.top === 'typography');
check('有排版 token（missing-typography）', typeEntries.length > 0, String(typeEntries.length));
check(
  '排版 token 名唯一',
  new Set(typeEntries.map((e) => e.key)).size === typeEntries.length,
  typeEntries.map((e) => e.key).join(','),
);
check(
  '排版 token 名都在规范推荐的词族里',
  typeEntries.every((e) => /^(headline|body|label|code)-/.test(e.key)),
  typeEntries.map((e) => e.key).join(','),
);

const typeDeep = entries.filter((e) => e.indent === 4 && e.top === 'typography');
check(
  '每一级都给了 fontSize',
  typeEntries.every((e) => typeDeep.some((d) => d.sub === e.key && d.key === 'fontSize')),
);
check(
  'fontSize 带 px 单位',
  typeDeep
    .filter((d) => d.key === 'fontSize')
    .every((d) => /^"\d+(\.\d+)?px"$/.test(d.value)),
);
// fontWeight 和 lineHeight 在规范里是 number，写成字符串会被当成别的东西
const weightEntries = typeDeep.filter((d) => d.key === 'fontWeight');
check(
  'fontWeight 是裸数字',
  weightEntries.length > 0 && weightEntries.every((d) => /^\d+$/.test(d.value)),
  weightEntries.map((d) => d.value).join(','),
);
const lhEntries = typeDeep.filter((d) => d.key === 'lineHeight');
check(
  'lineHeight 是无单位倍数',
  lhEntries.every((d) => /^\d+(\.\d+)?$/.test(d.value)),
  lhEntries.map((d) => d.value).join(','),
);

// ---------------------------------------------------------------------
// 四、components 子 token 白名单
// ---------------------------------------------------------------------

const componentEntries = entries.filter((e) => e.indent === 2 && e.top === 'components');
const componentDeep = entries.filter((e) => e.indent === 4 && e.top === 'components');
const allowedSub = COMPONENT_TOKEN_KEYS as readonly string[];
const badSub = componentDeep.filter((d) => allowedSub.indexOf(d.key) === -1);

check('有组件 token', componentEntries.length > 0, String(componentEntries.length));
check(
  '组件子 token 全在白名单内',
  badSub.length === 0,
  badSub.map((d) => d.key).join(','),
);
check(
  '组件 token 名唯一',
  new Set(componentEntries.map((e) => e.key)).size === componentEntries.length,
);
eq('组件数量与结论同源', componentEntries.length, base.analysis.components.specs.length);

// ---------------------------------------------------------------------
// 五、引用解析（broken-ref）
// ---------------------------------------------------------------------

const refs = collectReferences(md);
const paths = new Set(collectTokenPaths(md));
const broken = refs.filter((r) => !paths.has(r));

check('确实用到了引用', refs.length > 0, String(refs.length));
eq('没有断引用', broken.join(',') || '—', '—');
check(
  '引用只在 colors / typography / spacing / rounded 四个组里',
  refs.every((r) => /^(colors|typography|spacing|rounded)\./.test(r)),
  refs.filter((r) => !/^(colors|typography|spacing|rounded)\./.test(r)).join(','),
);

// 组件的 padding 是 CSS 简写，规范只给单值。多值只可能出现在 padding 上，
// 别的子 token 一律单值，这条锁住那个刻意的例外不会蔓延
const multiValue = componentDeep.filter(
  (d) => d.key !== 'padding' && /^"[^"]*\s\d/.test(d.value),
);
eq('除 padding 外没有多值 dimension', multiValue.map((d) => d.key).join(',') || '—', '—');

// ---------------------------------------------------------------------
// 六、章节顺序与完整性
// ---------------------------------------------------------------------

const sections = collectSections(md);
const sectionOrder = DESIGN_MD_SECTIONS as readonly string[];
const unknownSections = sections.filter((s) => sectionOrder.indexOf(s) === -1);
eq('没有未知章节', unknownSections.join(',') || '—', '—');

const indexes = sections.map((s) => sectionOrder.indexOf(s));
const ascending = indexes.every((v, i) => i === 0 || (v > (indexes[i - 1] ?? -1)));
check('章节按规范顺序排列', ascending, sections.join(' > '));
check('有 Overview', sections.indexOf('Overview') !== -1);
check('有 Colors', sections.indexOf('Colors') !== -1);
check("有 Do's and Don'ts", sections.indexOf("Do's and Don'ts") !== -1);

// ---------------------------------------------------------------------
// 七、Do's and Don'ts 的可执行性
// ---------------------------------------------------------------------

const dosBlock = md.split("## Do's and Don'ts")[1] ?? '';
const dosBullets = dosBlock
  .split('\n')
  .filter((l) => l.startsWith('- '))
  .map((l) => l.slice(2).trim());

check('护栏条数在 4 到 8 之间', dosBullets.length >= 4 && dosBullets.length <= 8, String(dosBullets.length));
check('护栏没有空条目', dosBullets.every((b) => b.length > 8));
// 判据从生成器引，不在这里另写一份正则。两份判据分叉的表现是「生成器放行
// 了一条检查脚本判定不合格的护栏」，而这类分叉很难从结果上看出来
check(
  '护栏都是可执行的约束，不是提取质量的自检说明',
  dosBullets.every((b) => IMPERATIVE.test(b)),
  dosBullets.filter((b) => !IMPERATIVE.test(b)).join(' | '),
);
// 「样本偏少」「需要人工过一眼」这类要留在各自章节，不能混进护栏
check(
  '护栏里没有自检口吻的句子',
  dosBullets.every((b) => !SELF_INSPECTION.test(b)),
  dosBullets.filter((b) => SELF_INSPECTION.test(b)).join(' | '),
);
check(
  '被筛掉的说明仍然写在各自章节里',
  md.includes('**说明**') || base.analysis.typography.notes.length === 0,
);

// ---------------------------------------------------------------------
// 八、组件对比度（contrast-ratio）
// ---------------------------------------------------------------------

const contrastPairs = componentEntries
  .map((c) => {
    const bg = componentDeep.find((d) => d.sub === c.key && d.key === 'backgroundColor')?.value;
    const fg = componentDeep.find((d) => d.sub === c.key && d.key === 'textColor')?.value;
    if (!bg || !fg) return null;
    // 引用要先回到 hex 才能算对比度
    const resolve = (v: string): string | null => {
      const raw = v.replace(/"/g, '');
      const ref = /^\{colors\.(.+)\}$/.exec(raw);
      if (!ref) return raw;
      const hit = base.analysis.colors.roles.find((r) => r.token === ref[1]);
      return hit ? hit.hex : null;
    };
    const bgHex = resolve(bg);
    const fgHex = resolve(fg);
    if (!bgHex || !fgHex) return null;
    return { key: c.key, ratio: contrastRatio(bgHex, fgHex) };
  })
  .filter((x): x is { key: string; ratio: number } => x !== null);

check('至少有一对可算对比度的组件', contrastPairs.length > 0, String(contrastPairs.length));
check(
  '组件对比度都达到 WCAG AA（4.5:1）',
  contrastPairs.every((p) => p.ratio >= 4.5),
  contrastPairs.filter((p) => p.ratio < 4.5).map((p) => `${p.key}=${p.ratio.toFixed(2)}`).join(','),
);

// ---------------------------------------------------------------------
// 九、确定性
// ---------------------------------------------------------------------

check('同一输入两次生成逐字节相同', renderDesignMd(exportOf(sample())) === md);
check(
  '换一个生成时刻，只有日期那一处变',
  (() => {
    const later = renderDesignMd(exportOf(sample(), new Date(2026, 10, 1, 8, 0, 0)));
    const a = md.split('\n').filter((l) => !l.startsWith('description:'));
    const b = later.split('\n').filter((l) => !l.startsWith('description:'));
    return a.join('\n') === b.join('\n');
  })(),
);

// ---------------------------------------------------------------------
// 十、边界
// ---------------------------------------------------------------------

/** 一个元素都没有的页面。分析层全线返回空，生成器不能因此崩掉或产出半截文件 */
const barren = exportOf({
  ...sample(),
  elements: [],
  typography: [],
  boxes: [],
  styles: [],
  textCharsTotal: 0,
});
const barrenMd = renderDesignMd(barren);
const barrenSections = collectSections(barrenMd);
const barrenPaths = new Set(collectTokenPaths(barrenMd));
const barrenBroken = collectReferences(barrenMd).filter((r) => !barrenPaths.has(r));

check('空页面也能产出文件', barrenMd.startsWith('---\n') && barrenMd.length > 60);
check(
  '空页面的章节顺序仍然合法',
  barrenSections.every(
    (s, i) => i === 0 || sectionOrder.indexOf(s) > sectionOrder.indexOf(barrenSections[i - 1] ?? ''),
  ),
  barrenSections.join(' > '),
);
eq('空页面没有断引用', barrenBroken.join(',') || '—', '—');

/**
 * 分组行的写法是 `colors:` 后面什么都没有，所以「有没有子项」不能看那一行的
 * 值，要看它下面有没有缩进两格的键。空段在文件里表现为一个有头没内容的
 * 分组，读的人会以为这一块漏提取了。
 */
function isEmptyGroup(mdText: string, group: string): boolean {
  const es = parseFrontMatter(mdText);
  const declared = es.some((e) => e.indent === 0 && e.key === group);
  const hasChild = es.some((e) => e.indent === 2 && e.top === group);
  return declared && !hasChild;
}

for (const g of ['colors', 'typography', 'spacing', 'rounded', 'components']) {
  check(`空页面不写空的 ${g} 段`, !isEmptyGroup(barrenMd, g));
}

// 反过来也要成立：有内容的分组必须真的有内容，不能只输出一个标题
check(
  '主样本没有空的分组',
  ['colors', 'typography', 'spacing', 'rounded', 'components'].every((g) => !isEmptyGroup(md, g)),
  ['colors', 'typography', 'spacing', 'rounded', 'components']
    .filter((g) => isEmptyGroup(md, g))
    .join(','),
);

/** 只有颜色没有组件。没有组件时不该出现 components 段，也不该有孤立引用 */
const noComponents = exportOf({ ...sample(), styles: [] });
const noCompMd = renderDesignMd(noComponents);
const noCompEntries = parseFrontMatter(noCompMd);
check(
  '没有组件时不写 components 段',
  noCompEntries.every((e) => !(e.indent === 0 && e.key === 'components')),
);
check(
  '没有组件时不写空的 rounded 段',
  noCompEntries.every((e) => !(e.indent === 0 && e.key === 'rounded' && e.value === '')),
);

// ---------------------------------------------------------------------
// 十一、AI 补全版
//
// 这一节的断言是验收标准里「补全后的内容中，颜色、尺寸等数值必须与提取
// 结果一致」的落地。它不靠抽样比对，靠两条结构性结论：
//
//   一、front matter 里除去 description 那一行，带 AI 和不带 AI 逐字节相同。
//       token 块是机器读的那一半，它一个字都没动过。
//   二、正文里的阿拉伯数字多重集完全一致。模型回来的每个字符串都不允许
//       含数字（校验在 semantics.ts），所以正文里也不可能冒出新数字。
//
// 合起来就是：数值全部来自本地分析层，模型没有任何途径改动它们。
// ---------------------------------------------------------------------

const aiSemantics: AiSemantics = {
  model: 'unit-test-model',
  summary:
    '整体是克制的排版导向设计，层级靠字号落差拉开，不靠色块分隔。' +
    '视觉重心落在标题和主按钮两处，其余元素一律后退。',
  colors: {},
  components: {},
  added: {
    colors: {
      primary: '承担几乎全部阅读内容的主力色，改动它的明度会同时影响每一层级。',
      tertiary: '唯一的强调色，出现频率极低是刻意的，不要因为显眼就扩大使用范围。',
    },
    components: {
      'button-primary': '全页只有一处的决定性动作，靠填充和留白把自己和其他动作分开。',
    },
  },
  guidelines: [
    '主色只用于需要立刻被注意到的单个动作，不要扩散到装饰块上。',
    '标题和正文只应该使用同一套字体，新增一种字体会让层级判断变模糊。',
    '卡片内部不要再套一层同色底的卡片，层级一多整套样式会糊成一片。',
    '辅助文字只用来承载说明和单位。',
  ],
  prompt:
    '请遵循这份 DESIGN.md 描述的配色与排版层级。\n' +
    '正文统一使用 body-md，标题按 headline 那一族逐级取用，不要临时改字号。\n' +
    '主要动作使用 primary 对应的强调色，同一屏内不要出现两个以上的强调色元素。',
};

const aiMd = renderDesignMd(base, aiSemantics);
const aiSections = collectSections(aiMd);
const aiPaths = new Set(collectTokenPaths(aiMd));
const aiBroken = collectReferences(aiMd).filter((r) => !aiPaths.has(r));

/** front matter 那一层，去掉 description。description 带模型名，本来就会变 */
function tokenBlockOf(text: string): string {
  const fm = frontMatterOf(text);
  if (!fm) return '';
  return fm
    .split('\n')
    .filter((l) => !l.startsWith('description:'))
    .join('\n');
}

/** front matter 之后的正文 */
function bodyOf(text: string): string {
  if (!text.startsWith('---\n')) return text;
  const end = text.indexOf('\n---\n', 3);
  return end < 0 ? text : text.slice(end + 5);
}

/** 文中的连续数字，取出来排序。只比多重集，不比出现位置 */
function digitRuns(text: string): string[] {
  return (text.match(/\d+/g) ?? []).slice().sort();
}

check('不传补全文案与传 null 结果相同', renderDesignMd(base) === renderDesignMd(base, null));
check(
  'token 块逐字节未变（front matter 除 description 外）',
  tokenBlockOf(aiMd) === tokenBlockOf(md),
  '两边的 token 块不一致',
);
eq(
  '补全后正文里的数字多重集与本地版一致',
  digitRuns(bodyOf(aiMd)).join(','),
  digitRuns(bodyOf(md)).join(','),
);
check(
  '补全文案样本里一个阿拉伯数字都没有',
  digitRuns(aiSemantics.summary).length === 0 &&
    Object.values(aiSemantics.colors).every((v) => digitRuns(v).length === 0) &&
    Object.values(aiSemantics.components).every((v) => digitRuns(v).length === 0) &&
    aiSemantics.guidelines.every((v) => digitRuns(v).length === 0) &&
    digitRuns(aiSemantics.prompt).length === 0,
);
check(
  '补全没有引入新的 token 引用',
  collectReferences(aiMd).length === collectReferences(md).length,
  `${collectReferences(aiMd).length} 对 ${collectReferences(md).length}`,
);
eq('AI 版没有断引用', aiBroken.join(',') || '—', '—');
eq('AI 版没有未知章节', aiSections.filter((s) => sectionOrder.indexOf(s) === -1).join(',') || '—', '—');
check(
  'AI 版章节顺序仍然合法',
  aiSections.every((s, i) => sectionOrder.indexOf(s) > sectionOrder.indexOf(aiSections[i - 1] ?? '')),
  aiSections.join(' > '),
);
check('AI 版概述带上了风格综述', aiMd.includes(aiSemantics.summary));
check(
  'AI 版颜色一节有语义补充块',
  aiMd.includes('**语义补充**') && aiMd.includes(aiSemantics.added?.colors['primary'] ?? '\u0000'),
);
check(
  'AI 版组件描述接在本地说明之后',
  aiMd.includes(aiSemantics.added?.components['button-primary'] ?? '\u0000'),
);
check(
  '提示词示例写在三级标题下并用围栏包住',
  aiMd.includes('### 给编码 agent 的提示词') &&
    aiMd.indexOf('### 给编码 agent 的提示词') > aiMd.indexOf('## Overview') &&
    aiMd.includes('```text'),
);

const aiDosBlock = aiMd.split("## Do's and Don'ts")[1] ?? '';
const aiDosBullets = aiDosBlock
  .split('\n')
  .filter((l) => l.startsWith('- '))
  .map((l) => l.slice(2).trim());
check(
  'AI 版护栏条数仍在 4 到 8 之间',
  aiDosBullets.length >= 4 && aiDosBullets.length <= 8,
  String(aiDosBullets.length),
);
check('AI 版护栏都是祈使句', aiDosBullets.every((b) => IMPERATIVE.test(b)));
check('AI 版护栏里没有自检口吻', aiDosBullets.every((b) => !SELF_INSPECTION.test(b)));
// 补全的护栏不能靠挤走全部本地条目来上位，两边都要在
check(
  'AI 版护栏里同时保留了本地条目和补全条目',
  aiSemantics.guidelines.every((g) => aiDosBullets.indexOf(g) !== -1) &&
    dosBullets.some((b) => aiDosBullets.indexOf(b) !== -1),
  aiDosBullets.join(' | '),
);
check('AI 版的 description 指明了散文来源', (frontMatterOf(aiMd) ?? '').includes(aiSemantics.model));

// 语义层给了内容但生成器找不到对应位置，是最容易静默发生的一类错误：
// 比如组件改名之后补全文案挂空了，文件看起来一切正常，只是少了那一段
const strayMd = renderDesignMd(base, {
  ...aiSemantics,
  summary: '',
  guidelines: [],
  prompt: '',
  added: {
    colors: { noSuchColorToken: '这一条不该出现在文件里。' },
    components: { 'no-such-component': '这一条也不该出现。' },
  },
});
check(
  '对不上号的补全条目不会写进文件',
  !strayMd.includes('这一条不该出现在文件里') && !strayMd.includes('这一条也不该出现'),
);

const blankSemantics: AiSemantics = {
  model: 'unit-test-model',
  summary: '',
  colors: {},
  components: {},
  added: { colors: {}, components: {} },
  guidelines: [],
  prompt: '',
};
check(
  '补全文案全空时正文与本地产出逐字节相同',
  bodyOf(renderDesignMd(base, blankSemantics)) === bodyOf(md),
  '正文出现了差异',
);

console.log('='.repeat(64));
console.log('断言结果');
console.log('='.repeat(64));
for (const line of report) console.log(line);
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项未通过`);

process.exit(failed === 0 ? 0 : 1);
