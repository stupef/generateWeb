/**
 * 溯源高亮的对账检查，不需要浏览器。
 *
 * 运行：npm run check:provenance
 *
 * ── 这个脚本守的是什么 ──
 *
 * 只有一条，但它是这个功能的全部价值所在：
 *
 *     ProvenanceGroup.displayed 必须等于 refs 的长度。
 *
 * displayed 是界面上已经印出来的那个数字（「作背景 12 处」「间距 16px 出现
 * 47 处」「主按钮 1 个」），refs 是点下去之后页面上真正被描边的元素。这两个
 * 数字只要对不上，用户就会认为提取错了——而这个功能存在的唯一理由，就是让
 * 用户能确认提取没有错。所以它不是「顺便验一下」，是验收标准本身。
 *
 * 做法是把分析结果里**每一个** token 都过一遍，而不是挑几个代表性的。挑着
 * 验的话，没被挑中的那一类什么时候错开都不会有人知道，而错开的表现只是差一
 * 两个元素，看起来像漏了一处。逐条断言之后，「数字对得上」这件事不再依赖
 * 谁记得去核。
 *
 * ── 为什么合成数据还不够 ──
 *
 * 合成数据能卡住边界（簇成员、吸收值、同一元素跨渠道、越界下标），但它的
 * 颜色是手写的十六进制串，字号是手写的整数。真实浏览器产生的是
 * 15.999999、rgb() 带小数、圆角被展开成四角，而这条链路上恰恰是归一规则
 * 最容易分叉的地方。所以末尾还有一半跑在端到端样本上，那份是可选的：
 * 不在就跳过并说明，不让整条链因为这个文件缺失而变红。
 */
import { analyzeColors, type ColorAnalysis } from '../src/core/color';
import { analyzeComponents, type ComponentsAnalysis } from '../src/core/components';
import { analyzeEffects, type EffectsAnalysis } from '../src/core/effects';
import {
  HIGHLIGHT_GLOW_ALPHA,
  HIGHLIGHT_GLOW_SPREAD,
  HIGHLIGHT_OUTLINE,
  HIGHLIGHT_OUTLINE_OFFSET,
  HIGHLIGHT_PAINT_KEY,
  HIGHLIGHT_REGISTRY_KEY,
  highlightElements,
} from '../src/core/highlight';
import { provenanceOf, type ProvenanceInput, type ProvenanceToken } from '../src/core/provenance';
import { decodeToken, encodeToken, TOKEN_ATTR } from '../src/core/token-ref';
import { analyzeSpacing, type SpacingAnalysis } from '../src/core/spacing';
import { analyzeTypography, type TypographyAnalysis } from '../src/core/typography';
import { collectPageSample } from '../src/core/collector';
import type {
  BackgroundSummary,
  BoxObservation,
  ElementObservation,
  EmbeddedContentSummary,
  PageSample,
  StyleElementKind,
  StyleObservation,
  TypeObservation,
} from '../src/core/types';
import type { SampleExport } from '../src/core/export';

/** 局部声明 Node 全局，理由同其它检查脚本，不为一个脚本引入 @types/node */
declare const require: (id: string) => {
  readFileSync(p: string, enc: string): string;
  existsSync(p: string): boolean;
};
declare const process: { exit(code?: number): void };

const fs = require('node:fs');

// ---------------------------------------------------------------------
// 断言脚手架
// ---------------------------------------------------------------------
let failed = 0;
const report: string[] = [];

function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failed++;
  report.push(`${ok ? '✓' : '✗'} ${name}${!ok && detail ? `　→ ${detail}` : ''}`);
}

// ---------------------------------------------------------------------
// 合成样本
//
// 一个元素只领一个编号，四条通道共用它——这一点必须和采集层一致，否则
// 「同一个元素在颜色那条算命中、在间距那条算另一处」这种错位就测不出来。
// 所以下面先按元素写一份全字段的定义，再由 toSample 摊成四条通道。
// ---------------------------------------------------------------------
interface Def {
  tag: string;
  textChars: number;
  fontSize: number;
  fontFamily: string;
  fontWeight: number;
  lineHeight: number | null;
  letterSpacing: number | null;
  headingLevel: number;
  isControl: boolean;
  area: number;
  background: string | null;
  textColor: string | null;
  borderColor: string | null;
  borderWidth: number;
  borderSides: number;
  borderStyle: string;
  padding: [number, number, number, number];
  margin: [number, number, number, number];
  gap: number | null;
  radius: number;
  width: number;
  height: number;
  maxWidth: number | null;
  childCount: number;
  fillsParent: boolean;
  shadow: string | null;
  inNav: boolean;
  isLandmark: boolean;
  /**
   * 布局模式。inline 的元素不参与盒模型统计，采集层就是这么挡的：
   * 纯 inline 元素的上下方向 padding 根本不占位，采进来只会污染间距体系。
   * 所以这里多出一个取值，摊样本时按它把这类元素排除在 boxes 之外。
   */
  layout: 'flex' | 'grid' | 'block' | 'inline';
  /** null 表示这个元素不构成组件，不进 styles 通道 */
  kind: StyleElementKind | null;
}

function def(partial: Partial<Def>): Def {
  return {
    tag: 'DIV',
    textChars: 0,
    fontSize: 16,
    fontFamily: 'Inter, sans-serif',
    fontWeight: 400,
    lineHeight: null,
    letterSpacing: null,
    headingLevel: 0,
    isControl: false,
    area: 10_000,
    background: null,
    textColor: null,
    borderColor: null,
    borderWidth: 0,
    borderSides: 0,
    borderStyle: '',
    padding: [0, 0, 0, 0],
    margin: [0, 0, 0, 0],
    gap: null,
    radius: 0,
    width: 200,
    height: 60,
    maxWidth: null,
    childCount: 1,
    fillsParent: false,
    shadow: null,
    inNav: false,
    isLandmark: false,
    layout: 'block',
    kind: null,
    ...partial,
  };
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

/**
 * 把一份元素定义摊成四条通道。
 *
 * 摊的时候顺手补上采集层自己算出来的那几个派生字段（definesSurface、
 * looksLikeCard、isControl），因为它们的结果直接影响分析判据，手写一遍
 * 就等于在样本里塞了一份可能和采集层不一致的判据。
 */
function toSample(defs: Def[], canvasColor: string | null): PageSample {
  const elements: ElementObservation[] = [];
  const typography: TypeObservation[] = [];
  const boxes: BoxObservation[] = [];
  const styles: StyleObservation[] = [];

  for (let i = 0; i < defs.length; i++) {
    const d = defs[i];
    if (!d) continue;
    const padSum = d.padding[0] + d.padding[1] + d.padding[2] + d.padding[3];
    const hasSurface = d.background !== null;
    const hasBox = d.layout !== 'inline';
    const looksLikeCard = hasSurface || d.borderWidth > 0 || d.radius > 0;

    elements.push({
      ref: i,
      tag: d.tag,
      textChars: d.textChars,
      fontSize: d.fontSize,
      area: d.area,
      isControl: d.isControl,
      definesSurface: hasSurface,
      textColor: d.textChars > 0 ? d.textColor : null,
      backgroundColor: d.background,
      borderColor: d.borderWidth > 0 ? d.borderColor : null,
      borderWidth: d.padding.length > 0 ? d.borderWidth : 0,
    });

    if (d.textChars > 0) {
      typography.push({
        ref: i,
        tag: d.tag,
        headingLevel: d.headingLevel,
        fontFamily: d.fontFamily,
        fontWeight: d.fontWeight,
        fontSize: d.fontSize,
        lineHeight: d.lineHeight,
        letterSpacing: d.letterSpacing,
        textChars: d.textChars,
        isControl: d.isControl,
      });
    }

    if (hasBox && (padSum > 0 || d.radius > 0 || d.margin.some((v) => v !== 0) || d.gap !== null)) {
      boxes.push({
        ref: i,
        tag: d.tag,
        padding: d.padding,
        margin: d.margin,
        gap: d.gap,
        radius: d.radius,
        width: d.width >= 400 ? d.width : 0,
        maxWidth: d.maxWidth,
        looksLikeCard,
        isControl: d.isControl,
        isLandmark: d.isLandmark,
        layout: d.layout === 'inline' ? 'block' : d.layout,
      });
    }

    if (d.kind !== null) {
      styles.push({
        ref: i,
        tag: d.tag,
        kind: d.kind,
        inNav: d.inNav,
        textChars: d.textChars,
        childCount: d.childCount,
        fillsParent: d.fillsParent,
        backgroundColor: d.background,
        textColor: d.textColor,
        padding: d.padding,
        radius: d.radius,
        borderWidth: d.borderWidth,
        borderSides: d.borderSides,
        borderStyle: d.borderStyle,
        borderColor: d.borderColor,
        shadow: d.shadow,
        width: d.width,
        height: d.height,
        fontSize: d.fontSize,
        fontWeight: d.fontWeight,
        fontFamily: d.fontFamily,
      });
    }
  }

  return {
    url: 'https://example.com/',
    title: '溯源合成样例',
    viewportWidth: 1440,
    viewportHeight: 900,
    canvasColor,
    prefersDark: false,
    elements,
    typography,
    boxes,
    styles,
    webFontFamilies: ['Söhne Buch'],
    background: noBackground,
    embedded: plainStructure,
    textCharsTotal: elements.reduce((n, e) => n + e.textChars, 0),
    skipped: 6,
    visited: defs.length,
    truncated: false,
    elapsedMs: 30,
  };
}

// --- 合成样本的内容 ---------------------------------------------------
//
// 覆盖面是按「每一类 token 都至少有一处」倒推着写的，而且刻意埋了四处
// 容易分叉的地方：
//   1. 15.9px 和 16px 会被 5% 容差并成一级，簇里有两个原始值
//   2. 15.5px 的 padding 会被 0.5 容差吸进 16 这一档
//   3. 一个元素同时拿同一个色值当背景和当文字，跨渠道重叠
//   4. 一个色值同时作背景和作边框，用来验未入选颜色那一行的多渠道
const page: Def[] = [
  def({ tag: 'HTML', area: 1_400_000, width: 1440, height: 4000, childCount: 1, layout: 'block' }),
  def({ tag: 'BODY', background: '#ffffff', width: 1440, height: 4000, childCount: 2, fillsParent: true }),
];

// 正文：40 段，11px 到 24px 的五级字号都在这里铺开
for (let i = 0; i < 40; i++) {
  page.push(def({ tag: 'P', textChars: 120, textColor: '#1a1a1a', fontSize: 16, area: 40_000 }));
}
// 同色不同写法，必须被并进主要文字色
page.push(def({ tag: 'P', textChars: 40, textColor: '#1b1b1b', fontSize: 16, area: 6_000 }));
page.push(def({ tag: 'P', textChars: 40, textColor: '#1a1a19', fontSize: 16, area: 6_000 }));
// 被 5% 容差并进 16px 那一级的分数写法
page.push(def({ tag: 'SPAN', textChars: 60, textColor: '#1a1a1a', fontSize: 15.9, area: 4_000 }));

for (let i = 0; i < 20; i++) {
  page.push(def({ tag: 'SPAN', textChars: 26, textColor: '#6b7280', fontSize: 14, area: 3_000 }));
}
for (let i = 0; i < 14; i++) {
  page.push(def({ tag: 'P', textChars: 30, textColor: '#4a4a46', fontSize: 13, area: 3_000 }));
}
for (let i = 0; i < 4; i++) {
  page.push(
    def({
      tag: 'H1',
      textChars: 12,
      textColor: '#111111',
      fontSize: 32,
      fontWeight: 700,
      headingLevel: 1,
      margin: [24, 0, 24, 0],
      area: 20_000,
    }),
  );
}
for (let i = 0; i < 8; i++) {
  page.push(
    def({
      tag: 'H2',
      textChars: 18,
      textColor: '#111111',
      fontSize: 24,
      fontWeight: 600,
      headingLevel: 2,
      margin: [16, 0, 16, 0],
      area: 16_000,
    }),
  );
}
// 只出现一次的小字号，进一次性数值那一档。
// 位置要离已有的档位远一点（离 12px 差 25%），否则会被 5% 容差并进相邻一级，
// 那样就没有「被丢掉的字号」可验了
page.push(def({ tag: 'SPAN', textChars: 5, textColor: '#9a9a94', fontSize: 9, area: 900 }));

// 代码块：等宽字体那一级
for (let i = 0; i < 12; i++) {
  page.push(
    def({
      tag: 'CODE',
      textChars: 40,
      textColor: '#1a1a1a',
      fontSize: 13,
      fontFamily: 'SF Mono, monospace',
      padding: [4, 6, 4, 6],
      area: 3_600,
    }),
  );
}
// 页面自带的字体，走替代方案
for (let i = 0; i < 6; i++) {
  page.push(
    def({ tag: 'SPAN', textChars: 30, textColor: '#1a1a1a', fontSize: 18, fontFamily: "'Söhne Buch', serif", area: 4_200 }),
  );
}

// 卡片底色与描边
for (let i = 0; i < 9; i++) {
  page.push(
    def({
      tag: 'DIV',
      background: '#f9fafb',
      padding: [24, 24, 24, 24],
      radius: 12,
      margin: [24, 0, 24, 0],
      childCount: 3,
      kind: 'card',
      area: 60_000,
      width: 320,
      height: 200,
    }),
  );
}
for (let i = 0; i < 26; i++) {
  page.push(
    def({
      tag: 'DIV',
      borderColor: '#e5e7eb',
      borderWidth: 1,
      borderSides: 4,
      borderStyle: 'solid',
      padding: [12, 16, 12, 16],
      margin: [8, 0, 8, 0],
      kind: 'other',
      area: 12_000,
    }),
  );
}

// 主按钮：填充色与页面底色差得开，没有看得见的描边
for (let i = 0; i < 3; i++) {
  page.push(
    def({
      tag: 'BUTTON',
      isControl: true,
      textChars: 8,
      textColor: '#ffffff',
      background: '#2563eb',
      padding: [10, 18, 10, 18],
      radius: 8,
      borderWidth: 0,
      fontSize: 15,
      fontWeight: 600,
      kind: 'button',
      width: 120,
      height: 40,
      area: 4_800,
    }),
  );
}
// 次按钮：白底加一圈看得见的边
for (let i = 0; i < 2; i++) {
  page.push(
    def({
      tag: 'BUTTON',
      isControl: true,
      textChars: 8,
      textColor: '#1a1a1a',
      background: '#ffffff',
      borderColor: '#d0d0d0',
      borderWidth: 1,
      borderSides: 4,
      borderStyle: 'solid',
      padding: [10, 18, 10, 18],
      radius: 8,
      fontSize: 15,
      kind: 'button',
      width: 130,
      height: 40,
      area: 5_200,
    }),
  );
}
// 幽灵按钮：完全透明，连表面都没有
page.push(
  def({
    tag: 'BUTTON',
    isControl: true,
    textChars: 6,
    textColor: '#2563eb',
    padding: [10, 18, 10, 18],
    radius: 8,
    fontSize: 15,
    kind: 'button',
    width: 110,
    height: 40,
    area: 4_400,
  }),
);

// 输入框：四条边都有描边，圆角比按钮小一档
for (let i = 0; i < 2; i++) {
  page.push(
    def({
      tag: 'INPUT',
      isControl: true,
      background: '#ffffff',
      borderColor: '#d8d8d4',
      borderWidth: 1,
      borderSides: 4,
      borderStyle: 'solid',
      padding: [8, 12, 8, 12],
      radius: 6,
      fontSize: 15,
      kind: 'input',
      width: 280,
      height: 36,
      area: 10_080,
    }),
  );
}

// 被 0.5 容差吸进 16 这一档的分数间距，同时制造一档带成员集的间距
for (let i = 0; i < 3; i++) {
  page.push(def({ tag: 'DIV', padding: [15.5, 15.5, 15.5, 15.5], area: 9_000 }));
}
// 不是 4 的倍数，进未立为档位那一列
page.push(def({ tag: 'DIV', padding: [13, 13, 13, 13], area: 5_000 }));
// 只出现一次，吸附之后照样不够格
page.push(def({ tag: 'DIV', padding: [48, 0, 48, 0], margin: [0, 0, 0, 0], area: 5_000 }));
// 胶囊圆角
for (let i = 0; i < 4; i++) {
  page.push(
    def({
      tag: 'SPAN',
      background: '#2563eb',
      textColor: '#ffffff',
      textChars: 4,
      padding: [4, 10, 4, 10],
      radius: 999,
      fontSize: 12,
      width: 60,
      height: 24,
      childCount: 0,
      kind: 'other',
      area: 1_440,
    }),
  );
}
// 带投影的浮层
for (let i = 0; i < 2; i++) {
  page.push(
    def({
      tag: 'DIV',
      background: '#ffffff',
      padding: [16, 16, 16, 16],
      radius: 8,
      shadow: 'rgba(0, 0, 0, 0.06) 0px 4px 12px 0px',
      childCount: 2,
      kind: 'other',
      width: 260,
      height: 120,
      area: 31_200,
    }),
  );
}

// 导航栏：自己不带文字，容器高度决定顶部留白
page.push(
  def({
    tag: 'NAV',
    background: '#ffffff',
    borderColor: '#e5e7eb',
    borderWidth: 1,
    borderSides: 1,
    borderStyle: 'solid',
    padding: [16, 24, 16, 24],
    width: 1440,
    height: 64,
    fillsParent: true,
    childCount: 4,
    isLandmark: true,
    layout: 'flex',
    gap: 16,
    kind: 'nav',
    area: 92_160,
  }),
);

// 一个元素同时拿同一个色值当背景和当文字，用来验跨渠道重叠
for (let i = 0; i < 2; i++) {
  page.push(
    def({
      tag: 'SPAN',
      background: '#2563eb',
      textColor: '#2563eb',
      textChars: 10,
      padding: [4, 8, 4, 8],
      fontSize: 14,
      width: 120,
      height: 28,
      area: 3_360,
    }),
  );
}
// 一个色值同时作背景和作边框，用来验未入选颜色那一行
page.push(
  def({
    tag: 'MARK',
    background: '#ff00ff',
    borderColor: '#ff00ff',
    borderWidth: 1,
    borderSides: 4,
    borderStyle: 'solid',
    textChars: 3,
    textColor: '#ffffff',
    padding: [2, 4, 2, 4],
    width: 60,
    height: 20,
    kind: 'other',
    area: 1_200,
  }),
);

// 一份完全没有背景色的页面，用来验页面底色的兜底
const bare: Def[] = [
  def({ tag: 'HTML', area: 1_400_000, width: 1440, height: 4_000, layout: 'block' }),
  def({ tag: 'BODY', width: 1440, height: 4_000, fillsParent: true }),
];
for (let i = 0; i < 20; i++) {
  bare.push(def({ tag: 'P', textChars: 100, textColor: '#222222', fontSize: 16, area: 30_000 }));
}

// ---------------------------------------------------------------------
// 把分析结果里每一个 token 都列出来
// ---------------------------------------------------------------------
interface TokenCase {
  key: string;
  token: ProvenanceToken;
}

const CHANNELS: ('text' | 'background' | 'border')[] = ['text', 'background', 'border'];

function allTokens(input: ProvenanceInput): TokenCase[] {
  const out: TokenCase[] = [];

  input.colors.roles.forEach((r, i) => {
    out.push({ key: `color:${i}`, token: { kind: 'color', index: i, channel: 'all' } });
    for (const channel of CHANNELS) {
      out.push({ key: `color:${i}:${channel}`, token: { kind: 'color', index: i, channel } });
    }
    r.mergedFrom.forEach((m) => {
      out.push({ key: `colorhex:${m.hex}`, token: { kind: 'color-hex', hex: m.hex } });
    });
  });
  input.colors.discarded.forEach((d, i) => {
    out.push({ key: `colordrop:${i}`, token: { kind: 'color-discard', index: i } });
  });
  input.typography.steps.forEach((s, i) => {
    out.push({ key: `type:${i}`, token: { kind: 'type-step', index: i } });
  });
  input.typography.discarded.forEach((d, i) => {
    out.push({ key: `typedrop:${i}`, token: { kind: 'type-discard', index: i } });
  });
  input.typography.families.forEach((f, i) => {
    out.push({ key: `family:${i}`, token: { kind: 'family', index: i } });
  });
  input.spacing.steps.forEach((s, i) => {
    out.push({ key: `space:${i}`, token: { kind: 'spacing-step', index: i } });
  });
  input.spacing.discarded.forEach((d, i) => {
    out.push({ key: `spacedrop:${i}`, token: { kind: 'spacing-discard', index: i } });
  });
  input.spacing.radii.forEach((r, i) => {
    out.push({ key: `radius:${i}`, token: { kind: 'radius', index: i } });
  });
  input.effects.radii.forEach((r, i) => {
    out.push({ key: `radiuskind:${i}`, token: { kind: 'radius-kind', index: i } });
  });
  input.effects.borders.forEach((b, i) => {
    out.push({ key: `border:${i}`, token: { kind: 'border', index: i } });
  });
  input.effects.shadows.forEach((g, i) => {
    out.push({ key: `shadow:${i}`, token: { kind: 'shadow', index: i } });
  });
  input.components.specs.forEach((spec, i) => {
    out.push({ key: `component:${i}`, token: { kind: 'component', index: i } });
  });

  return out;
}

// ---------------------------------------------------------------------
// 对账
// ---------------------------------------------------------------------
interface SweepResult {
  tokens: number;
  refs: number;
  /** 每一类 token 出现了几次，用来确认样本真的覆盖到了这一类 */
  kinds: Map<string, number>;
  /** 有 displayed 且对不上的组 */
  mismatches: string[];
}

function sweep(name: string, input: ProvenanceInput, verbose: boolean): SweepResult {
  const cases = allTokens(input);
  const kinds = new Map<string, number>();
  const mismatches: string[] = [];
  let refs = 0;

  for (const c of cases) {
    const result = provenanceOf(c.token, input);
    kinds.set(c.token.kind, (kinds.get(c.token.kind) ?? 0) + 1);

    if (!result) {
      mismatches.push(`${c.key} 解析不出结果`);
      continue;
    }

    for (const g of result.groups) {
      refs += g.refs.length;

      if (g.displayed !== null && g.refs.length !== g.displayed) {
        mismatches.push(`${c.key} 的「${g.label}」界面写 ${g.displayed}，实际描出 ${g.refs.length}`);
      }
      // 同一组里同一个元素出现两次，会让描边次数和元素数对不上，而页面上
      // 是按元素去重的，重复项被静默吃掉。跨组的重叠是允许的：一个元素
      // 同时拿同一个色值当背景和当文字时，两条渠道的证据里都该有它，
      // 所以去重集按组重建，不跨组共用
      const seen = new Set<number>();
      for (const ref of g.refs) {
        if (seen.has(ref)) mismatches.push(`${c.key} 的「${g.label}」里元素 ${ref} 重复`);
        seen.add(ref);
      }
      if (g.color.length === 0 || g.label.length === 0) {
        mismatches.push(`${c.key} 的组缺标签或颜色`);
      }
    }

    if (verbose) {
      const brief = result.groups
        .map((g) => `${g.label} ${g.refs.length}${g.displayed === null ? '' : `/${g.displayed}`}`)
        .join('　');
      console.log(`  ${c.key.padEnd(16)} ${result.title.padEnd(22)} ${brief}`);
    }
  }

  return { tokens: cases.length, refs, kinds, mismatches };
}

// ---------------------------------------------------------------------
// 用例一：合成样本
// ---------------------------------------------------------------------
console.log('='.repeat(70));
console.log('溯源对账　合成样本');
console.log('='.repeat(70));

const sample = toSample(page, '#ffffff');
const input: ProvenanceInput = {
  sample,
  colors: analyzeColors(sample),
  typography: analyzeTypography(sample),
  spacing: analyzeSpacing(sample),
  effects: analyzeEffects(sample),
  components: analyzeComponents(sample),
};

const synthetic = sweep('合成样本', input, true);

console.log('');
for (const m of synthetic.mismatches.slice(0, 20)) console.log(`  ✗ ${m}`);
console.log(`  元素 ${sample.elements.length}　排版 ${sample.typography.length}　盒模型 ${sample.boxes.length}　样式 ${sample.styles.length}`);
console.log(`  token ${synthetic.tokens} 个，描出 ${synthetic.refs} 处`);
console.log('');

check(
  `合成样本每一类 token 的数字都与界面一致（${synthetic.tokens} 个 token）`,
  synthetic.mismatches.length === 0,
  synthetic.mismatches.slice(0, 3).join('；'),
);

// 覆盖范围。少一类就说明样本没造到，那样上面那条断言会对这一整类视而不见
const WANT_KINDS = [
  'color',
  'color-hex',
  'color-discard',
  'type-step',
  'type-discard',
  'family',
  'spacing-step',
  'spacing-discard',
  'radius',
  'radius-kind',
  'border',
  'shadow',
  'component',
];
const missingKinds = WANT_KINDS.filter((k) => (synthetic.kinds.get(k) ?? 0) === 0);
check(
  `样本覆盖全部 ${WANT_KINDS.length} 类 token`,
  missingKinds.length === 0,
  missingKinds.length > 0 ? `缺 ${missingKinds.join('、')}` : '',
);

// 出口自检本身也要验。它是个「正常情况下永远不响」的分支，不验的话哪天它
// 被写坏了也没人知道，而它恰恰是数字对不上时唯一的提示
{
  // 正常输入上一条 note 都不该有，否则提示会变成噪音，用户就不看了
  const noisy: string[] = [];
  for (const c of allTokens(input)) {
    const r = provenanceOf(c.token, input);
    if (r && r.note !== '') noisy.push(`${c.key}：${r.note}`);
  }
  check('正常输入下自检不发出噪音', noisy.length === 0, noisy.slice(0, 2).join('；'));

  // 造一份「界面上的数字来自完整样本，但元素只剩一半」的输入。这正是真实
  // 场景里样本被截断、或者弹窗手里那份分析结果是旧的时候的样子
  const half = Math.floor(sample.elements.length / 2);
  const truncated: ProvenanceInput = {
    ...input,
    sample: { ...sample, elements: sample.elements.slice(0, half) },
  };

  const fired: string[] = [];
  for (const c of allTokens(truncated)) {
    const r = provenanceOf(c.token, truncated);
    if (r && r.note !== '') fired.push(`${c.key}：${r.note}`);
  }
  const sample1 = fired[0] ?? '';
  check(
    '元素被截断时自检会说出哪个数对不上',
    fired.length > 0 && sample1.includes('界面上写') && sample1.includes('只数到'),
    fired.length === 0 ? '一条都没发出，说明这个自检是死的' : '',
  );
}

// ---------------------------------------------------------------------
// 用例二：簇成员、吸收值、跨渠道重叠这几个边界
// ---------------------------------------------------------------------
console.log('='.repeat(70));
console.log('边界用例');
console.log('='.repeat(70));
console.log('');

const stepIndex = input.typography.steps.findIndex((s) => s.sizes.includes(15.9));
{
  const step = input.typography.steps[stepIndex];
  const result = step ? provenanceOf({ kind: 'type-step', index: stepIndex }, input) : null;
  const refs = result?.groups[0]?.refs ?? [];
  const sizes = refs.map((r) => sample.typography.find((o) => o.ref === r)?.fontSize ?? 0);
  const ok =
    !!step &&
    step.sizes.includes(16) &&
    sizes.includes(15.9) &&
    sizes.includes(16) &&
    refs.length === step.elementCount;
  check('字号簇里 15.9 与 16 两个原始值都要描到', ok, `簇内 ${step?.sizes.join('/')}，命中字号 ${[...new Set(sizes)].join('/')}`);
}

{
  const idx = input.spacing.steps.findIndex((s) => s.mergedFrom.includes(15.5));
  const step = input.spacing.steps[idx];
  const result = step ? provenanceOf({ kind: 'spacing-step', index: idx }, input) : null;
  const refs = result?.groups[0]?.refs ?? [];
  const hasFraction = refs.some((r) =>
    (sample.boxes.find((b) => b.ref === r)?.padding ?? []).some((v) => v === 15.5),
  );
  check(
    '被吸附的 15.5px 要跟着 16px 那一档一起描出来',
    !!step && step.mergedFrom.includes(15.5) && hasFraction && refs.length === step.count,
    `档位 ${step?.value}，成员 ${step?.mergedFrom.join('/')}，命中 ${refs.length}/${step?.count}`,
  );
}

{
  // 同一个元素同时拿同一个色值当背景和当文字，两条渠道的组必然重叠。
  // 这时候总数不能等于两组相加，页面上是按元素去重描的
  const idx = input.colors.roles.findIndex((r) => r.hex === '#2563eb');
  const role = input.colors.roles[idx];
  const result = role ? provenanceOf({ kind: 'color', index: idx, channel: 'all' }, input) : null;
  const sum = (result?.groups ?? []).reduce((n, g) => n + g.refs.length, 0);
  const distinct = new Set((result?.groups ?? []).flatMap((g) => g.refs)).size;

  check(
    '同一元素跨渠道重叠时，两条渠道各自数对、去重后不等同相加',
    !!role &&
      (result?.groups.length ?? 0) >= 2 &&
      distinct < sum &&
      (role.evidence.textCount ?? 0) > 0 &&
      sum >= distinct,
    `相加 ${sum}，去重 ${distinct}`,
  );
}

{
  // 未入选颜色那一行印的是按渠道累计的出现次数，同一元素的多条渠道在其中
  // 重复计入，所以它的组不挂 displayed。样本里那个洋红同时是同一个元素上的
  // 背景和边框：界面写「出现 2 次」，而页面上只有一个元素
  const magenta = input.colors.discarded.find((d) => d.hex === '#ff00ff');
  const idx = input.colors.discarded.findIndex((d) => d.hex === '#ff00ff');
  const result = magenta ? provenanceOf({ kind: 'color-discard', index: idx }, input) : null;
  const groups = result?.groups ?? [];
  const sum = groups.reduce((n, g) => n + g.refs.length, 0);
  const distinct = new Set(groups.flatMap((g) => g.refs)).size;
  const allNull = groups.every((g) => g.displayed === null);

  check(
    '未入选颜色的组不挂界面数字（累计次数与元素数本就不同一个口径）',
    !!magenta && allNull && groups.length === 2 && sum === magenta.count && distinct < sum,
    magenta ? `累计 ${magenta.count}，相加 ${sum}，去重 ${distinct}` : '样本里没有这个色值',
  );
}

{
  // 单条渠道命中为零时也要给出结果，0 是答案而不是「没找到」
  const idx = input.colors.roles.findIndex((r) => r.token === 'primary');
  const role = input.colors.roles[idx];
  const result = role ? provenanceOf({ kind: 'color', index: idx, channel: 'border' }, input) : null;
  const group = result?.groups[0];
  check(
    '单条渠道零命中时照样返回一组零，不返回 null',
    !!role && !!group && group.refs.length === 0 && group.displayed === 0,
    JSON.stringify(group?.refs.length),
  );
}

{
  // 一个色值只要被并进簇里，点它就要只描它自己，不是整个簇
  const role = input.colors.roles.find((r) => r.mergedFrom.length > 0);
  const merged = role?.mergedFrom[0];
  const result = merged ? provenanceOf({ kind: 'color-hex', hex: merged.hex }, input) : null;
  const refs = (result?.groups ?? []).flatMap((g) => g.refs);
  const allMatch = refs.every((r) => {
    const el = sample.elements.find((e) => e.ref === r);
    if (!el) return false;
    const hex = merged ? merged.hex.toLowerCase() : '';
    return (
      el.backgroundColor?.toLowerCase() === hex ||
      el.textColor?.toLowerCase() === hex ||
      el.borderColor?.toLowerCase() === hex
    );
  });
  check(
    '合并色单独点开时只描它自己那一个色值',
    !!merged && refs.length > 0 && allMatch,
    `${merged?.hex} 命中 ${refs.length} 处`,
  );
}

{
  // 越界下标必须返回 null，不许猜一个近似结果
  const kinds: ProvenanceToken[] = [
    { kind: 'color', index: 99, channel: 'all' },
    { kind: 'color-discard', index: 99 },
    { kind: 'type-step', index: 99 },
    { kind: 'type-discard', index: 99 },
    { kind: 'family', index: 99 },
    { kind: 'spacing-step', index: 99 },
    { kind: 'spacing-discard', index: 99 },
    { kind: 'radius', index: 99 },
    { kind: 'radius-kind', index: 99 },
    { kind: 'border', index: 99 },
    { kind: 'shadow', index: 99 },
    { kind: 'component', index: 99 },
  ];
  const wrong = kinds.filter((t) => provenanceOf(t, input) !== null).map((t) => t.kind);
  check('越界下标一律返回 null', wrong.length === 0, wrong.join('、'));
}

// ---------------------------------------------------------------------
// 用例三：一份完全没有背景色的页面
//
// 分析层在这种页面会把底色当成唯一一条背景证据补进去，界面上于是写着
// 「作背景 1 处」。那 1 处必须能落到一个真实元素上，否则用户看到的是
// 「说了一处，一处都点不出来」。
// ---------------------------------------------------------------------
console.log('='.repeat(70));
console.log('页面底色兜底');
console.log('='.repeat(70));
console.log('');

const bareSample = toSample(bare, '#ffffff');
const bareInput: ProvenanceInput = {
  sample: bareSample,
  colors: analyzeColors(bareSample),
  typography: analyzeTypography(bareSample),
  spacing: analyzeSpacing(bareSample),
  effects: analyzeEffects(bareSample),
  components: analyzeComponents(bareSample),
};

const bareSweep = sweep('无背景页面', bareInput, false);
const neutralIdx = bareInput.colors.roles.findIndex((r) => r.token === 'neutral');
const neutralRole = bareInput.colors.roles[neutralIdx];
const neutralResult = neutralRole
  ? provenanceOf({ kind: 'color', index: neutralIdx, channel: 'background' }, bareInput)
  : null;
const neutralRefs = neutralResult?.groups[0]?.refs ?? [];
const neutralIsRoot = bareSample.elements.find((e) => e.ref === neutralRefs[0])?.tag === 'HTML';

console.log(`  页面里有背景色的元素 ${bareSample.elements.filter((e) => e.backgroundColor).length} 个`);
console.log(`  底色的背景证据 ${neutralRole?.evidence.backgroundCount} 处，落到 ${neutralRefs.length} 个元素上（${neutralRefs.map((r) => bareSample.elements.find((e) => e.ref === r)?.tag).join(',')}）`);
console.log('');

check(
  '全页没有背景色时，底色的那一处要落到文档根元素上',
  neutralRole?.evidence.backgroundCount === 1 && neutralRefs.length === 1 && neutralIsRoot,
  `证据 ${neutralRole?.evidence.backgroundCount}，命中 ${neutralRefs.length}`,
);
check(
  '无背景页面的全部 token 数字同样对得上',
  bareSweep.mismatches.length === 0,
  bareSweep.mismatches.slice(0, 3).join('；'),
);

// ---------------------------------------------------------------------
// 用例四：两个注入函数对挂载键的看法必须一致
//
// collectPageSample 在页面里写下注册表，highlightElements 按同一个键去读。
// 两者都用字面量（注入后模块作用域不存在），所以这层对应关系只有源码能验。
// 键写错一个字，症状是「点高亮提示页面已经刷新过」，而页面明明没刷新过。
// ---------------------------------------------------------------------
console.log('='.repeat(70));
console.log('注入函数之间的约定');
console.log('='.repeat(70));
console.log('');

{
  const collectorSource = collectPageSample.toString();
  const highlightSource = highlightElements.toString();
  const pairs: [string, string][] = [
    ['元素注册表的挂载键', HIGHLIGHT_REGISTRY_KEY],
    ['高亮痕迹的挂载键（只有高亮自己用）', HIGHLIGHT_PAINT_KEY],
  ];

  for (const [what, literal] of pairs) {
    const inHighlight = highlightSource.includes(literal);
    // 采集层只需要认识前两个里它自己那一个：注册表由它写、浮层由它跳过
    const needsCollector = literal !== HIGHLIGHT_PAINT_KEY;
    const inCollector = collectorSource.includes(literal);
    check(
      `${what}「${literal}」在两个注入函数里写法一致`,
      inHighlight && (!needsCollector || inCollector),
      `高亮里${inHighlight ? '有' : '没有'}，采集里${inCollector ? '有' : '没有'}`,
    );
  }

  check(
    '页面高亮不再创建说明浮层',
    !highlightSource.includes('attachShadow'),
    '页面上不应出现右下角的说明框',
  );

  // 描边宽度和偏移量也只能内联（注入之后模块作用域不存在），所以要保证金
  // 导出出去的那两个常量确实就是函数体里写的值。改了常量不改函数（或反过来）
  // 会让「描边是 2px」这句话变成假的，而它在界面上看不出来
  const inlinePairs: [string, string][] = [
    ['描边宽度与线型', HIGHLIGHT_OUTLINE],
    ['描边内缩', HIGHLIGHT_OUTLINE_OFFSET],
  ];
  for (const [what, literal] of inlinePairs) {
    check(
      `${what}「${literal}」在两个地方写法一致`,
      highlightSource.includes(literal),
      `函数体里找不到 ${literal}`,
    );
  }

  // 光晕这两个字面量同样只能在函数体里内联。外扩半径那条断言特意带上
  // "0 0 0 " 前缀，因为单找一个 "6px" 会被浮层卡自己的投影（0 6px 24px）
  // 和字号（12px）命中，那条断言就永远为真了——这种恒真断言比没有断言更糟，
  // 它会让人觉得这一段已经被覆盖到了
  check(
    `光晕的写法是向外扩散的 ${HIGHLIGHT_GLOW_SPREAD}`,
    highlightSource.includes('0 0 0 ' + HIGHLIGHT_GLOW_SPREAD + ' '),
    '函数体里找不到 0 0 0 Npx 这种向外扩散的写法',
  );
  // 外扩半径必须越过描边外沿，否则光晕整个躲在描边底下，加了等于没加。
  // 外沿由描边宽度和内缩两个数算出来，不写死，改了那两个数这条会跟着变
  const glowPx = Number.parseFloat(HIGHLIGHT_GLOW_SPREAD);
  const outlineWidthPx = Number.parseFloat(HIGHLIGHT_OUTLINE);
  const outlineOffsetPx = Number.parseFloat(HIGHLIGHT_OUTLINE_OFFSET);
  const outlineOuterPx =
    (Number.isFinite(outlineWidthPx) ? outlineWidthPx : 0) +
    (Number.isFinite(outlineOffsetPx) ? outlineOffsetPx : 0);
  check(
    `光晕的外扩半径越过了描边的 ${outlineOuterPx}px 外沿`,
    Number.isFinite(glowPx) && glowPx > outlineOuterPx,
    `外扩半径 ${HIGHLIGHT_GLOW_SPREAD} 没越过描边外沿，光晕会被描边整个盖住，看起来等于没加`,
  );
  check(
    `光晕取半透明八位十六进制（${HIGHLIGHT_GLOW_ALPHA}）`,
    highlightSource.includes(HIGHLIGHT_GLOW_ALPHA),
    `函数体里找不到 ${HIGHLIGHT_GLOW_ALPHA}`,
  );

  // 这一条钉的是一个决定，不是一个实现。给元素补一层淡底会让它自己的背景色
  // 被改掉，而用户正是拿这个功能核对颜色，改掉被核对的对象等于把结论污染掉。
  // 将来真要在元素身上写背景色，先看 highlight.ts 模块头那一段再说
  check(
    '高亮期间不给元素写任何背景色',
    !highlightSource.includes('background-color'),
    '函数体里出现了 background-color，这会让元素自身的背景色被改掉',
  );

  // 写内联样式只许走 setAttribute，不许碰 CSSStyleDeclaration。
  //
  // 这一条是真金白银换来的。el.style 的写入不会立刻提交成真实的 style 属性，
  // 浏览器要等下一次读它才提交，这中间 removeAttribute('style') 只清属性不清
  // 属性本身，元素上会留下一个空的 style=""。批量画的时候必定出现，单个元素
  // 反而正常，所以源码级断言和合成样本都打不出来，只有真机逐元素对账才打得
  // 出来。真机那条在 scripts/highlight-shot.mjs，需要浏览器；这一条在源码层面
  // 把走回头路的门堵死。
  //
  // 只查写入。probe.style.getPropertyValue 是对脱离文档的元素做只读解析，
  // 不在禁止之列。
  check(
    '高亮写入只走 setAttribute，不碰 CSSStyleDeclaration 的写入',
    highlightSource.includes(`el.setAttribute('style'`) &&
      !highlightSource.includes('.setProperty(') &&
      !highlightSource.includes('.removeProperty('),
    '函数体里出现了通过 CSSStyleDeclaration 的写入，这会让清除留下空的 style 属性',
  );
}

// ---------------------------------------------------------------------
// 用例五：界面上那个属性值的往返
//
// 弹窗把每个可点行标成 data-tok="color:3:background"，点击时再解回 token。
// 中间过了一道 HTML 属性，而这一段错了的表现是「点了没反应」或者「点亮了
// 错的那一组」——两种都不留痕迹，所以 13 类 token 要逐类走一遍往返，并且
// 把几种改坏的属性值逐条拒掉。
// ---------------------------------------------------------------------
console.log('='.repeat(70));
console.log(`界面上那个属性的往返（${TOKEN_ATTR}）`);
console.log('='.repeat(70));
console.log('');

{
  // 每一类 token 各来一个。下标刻意用不同的数，这样某一类把下标读写反了
  // 会在往返结果里露出来，而不是因为都用 0 而看不出来
  const kinds: [string, ProvenanceToken][] = [
    ['颜色角色 · 三条渠道一起', { kind: 'color', index: 3, channel: 'all' }],
    ['颜色角色 · 单条渠道', { kind: 'color', index: 7, channel: 'border' }],
    ['合并掉的色值', { kind: 'color-hex', hex: '#1b1b1b' }],
    ['未入选的颜色', { kind: 'color-discard', index: 11 }],
    ['字号档位', { kind: 'type-step', index: 2 }],
    ['一次性字号', { kind: 'type-discard', index: 5 }],
    ['字体', { kind: 'family', index: 1 }],
    ['间距档位', { kind: 'spacing-step', index: 4 }],
    ['不规律间距', { kind: 'spacing-discard', index: 6 }],
    ['圆角档位', { kind: 'radius', index: 8 }],
    ['圆角按元素类型', { kind: 'radius-kind', index: 0 }],
    ['边框', { kind: 'border', index: 9 }],
    ['投影', { kind: 'shadow', index: 12 }],
    ['组件', { kind: 'component', index: 10 }],
  ];

  const bad: string[] = [];
  for (const [what, token] of kinds) {
    const raw = encodeToken(token);
    if (raw === '') {
      bad.push(`${what} 编不出来`);
      continue;
    }
    const back = decodeToken(raw);
    if (JSON.stringify(back) !== JSON.stringify(token)) {
      bad.push(`${what} 往返之后变成了 ${JSON.stringify(back)}`);
    }
    // 属性值里不该出现需要转义或被当成标签解析的字符。这一条是安全性的：
    // 编出来的值要能直接拼进 HTML 属性而不必再过一遍转义，转义漏一个字符
    // 就是一个注入点
    if (/["'<>&\s]/.test(raw)) {
      bad.push(`${what} 编出来的值含需要转义或会被当成标签的字符：${raw}`);
    }
  }
  check(`token 编出来的值都能原样解回去（13 类共 ${kinds.length} 项）`, bad.length === 0, bad.join('；'));

  // 越界和残缺的输入一律拒。属性值能被外部改，宽松解析的代价是点亮一组
  // 不相干的元素，而用户正拿这个功能核对结果
  const rejected: [string, string | null][] = [
    ['空值', ''],
    ['只有类型名', 'type-step'],
    ['下标不是数字', 'type-step:abc'],
    ['下标记成负数', 'type-step:-1'],
    ['下标带小数', 'type-step:1.5'],
    ['颜色少一段渠道', 'color:3'],
    ['颜色多一段', 'color:3:text:extra'],
    ['渠道名不认识', 'color:3:shadow'],
    ['颜色类型写错', 'colour:3:text'],
    ['色值不是十六进制', 'color-hex:#zzzzzz'],
    ['色值没有井号', 'color-hex:1b1b1b'],
    ['类型名不认识', 'everything:1'],
    ['塞了引号想越出属性', 'color:3:text" onload="x'],
    ['塞了尖括号', '<script>:1'],
    ['值里有空白', 'type-step: 1'],
    ['null', null],
  ];
  const leaked: string[] = [];
  for (const [what, raw] of rejected) {
    const got = decodeToken(raw);
    if (got !== null) leaked.push(`${what} 解成了 ${JSON.stringify(got)}`);
  }
  check(`改坏的属性值一律解不出来（${rejected.length} 种）`, leaked.length === 0, leaked.join('；'));

  // 大小写照常。页面标题里的十六进制串大小写不定，而色簇的成员集是按小写
  // 比对的，编码时统一压成小写，解码回来也必须是小写，否则查不到那一档
  const upper = encodeToken({ kind: 'color-hex', hex: '#1B1B1B' });
  const lower = encodeToken({ kind: 'color-hex', hex: '#1b1b1b' });
  const decodedUpper = decodeToken(upper);
  check(
    '色值大小写归一之后再编码，解回来也是小写',
    upper === lower && decodedUpper?.kind === 'color-hex' && decodedUpper.hex === '#1b1b1b',
    `大写编成 ${upper}，小写编成 ${lower}`,
  );
}

// ---------------------------------------------------------------------
// 用例六：端到端真实样本（可选）
//
// 合成数据的颜色是手写的十六进制串、字号是整数，真实页面给的是 rgb() 带
// 小数、15.999999 这种换算值、圆角被展开成四角。归一路径恰恰在这一段最
// 容易分叉，所以这一半不能省。
// ---------------------------------------------------------------------
const SOURCE = 'reports/e2e-sample/sample-export.json';

/**
 * 这份样本是不是当前代码导出来的。
 *
 * 快照是按当时的字段形状存的，改过观测结构（加编号、给档位带上成员集）
 * 之后旧样本会缺字段，硬扫下去只会在某个 undefined 上崩掉，而那个崩溃
 * 看起来像溯源本身的错。所以先判一句，过期就整段跳过并说明。
 */
function sampleIsCurrent(exported: SampleExport): boolean {
  const first = exported.raw.elements[0];
  const typeStep = exported.analysis.typography.steps[0];
  const spaceStep = exported.analysis.spacing.steps[0];
  const hasRef = first === undefined || typeof first.ref === 'number';
  const hasSizes = typeStep === undefined || Array.isArray(typeStep.sizes);
  const hasMembers = spaceStep === undefined || Array.isArray(spaceStep.mergedFrom);
  return hasRef && hasSizes && hasMembers;
}

if (!fs.existsSync(SOURCE)) {
  console.log('');
  console.log(`端到端样本不在（${SOURCE}），跳过真实页面那一半。先跑一次 npm run check:e2e 就能补上。`);
} else if (!sampleIsCurrent(JSON.parse(fs.readFileSync(SOURCE, 'utf8')) as SampleExport)) {
  console.log('');
  console.log('端到端样本是改动之前导出的，跳过真实页面那一半。');
  console.log('这一段被跳过时，真实页面上的对账等于没做。重跑一次 npm run check:e2e 就能补上。');
} else {
  console.log('='.repeat(70));
  console.log('溯源对账　端到端真实样本');
  console.log('='.repeat(70));

  const exported = JSON.parse(fs.readFileSync(SOURCE, 'utf8')) as SampleExport;
  const raw = exported.raw;

  // 快照里 page 那一段和 PageSample 同名不同形，只挑溯源真的用到的字段重建，
  // 不整段强转。少一个字段这里会编译不过，比在运行时读到 undefined 强
  const realSample = {
    url: exported.page.url,
    title: exported.page.title,
    viewportWidth: exported.page.viewportWidth,
    viewportHeight: exported.page.viewportHeight,
    canvasColor: exported.page.canvasColor,
    prefersDark: exported.page.prefersDark,
    textCharsTotal: exported.page.textCharsTotal,
    visited: exported.page.visited,
    skipped: exported.page.skipped,
    truncated: exported.page.truncated,
    elapsedMs: exported.page.elapsedMs,
    elements: raw.elements,
    typography: raw.typography,
    boxes: raw.boxes,
    styles: raw.styles,
    webFontFamilies: raw.webFontFamilies,
    background: raw.background,
    embedded: raw.embedded,
  } satisfies PageSample;

  const realInput: ProvenanceInput = {
    sample: realSample,
    colors: exported.analysis.colors as ColorAnalysis,
    typography: exported.analysis.typography as TypographyAnalysis,
    spacing: exported.analysis.spacing as SpacingAnalysis,
    effects: exported.analysis.effects as EffectsAnalysis,
    components: exported.analysis.components as ComponentsAnalysis,
  };

  const real = sweep('真实样本', realInput, false);

  console.log('');
  console.log(`  元素 ${realSample.elements.length}　排版 ${realSample.typography.length}　盒模型 ${realSample.boxes.length}　样式 ${realSample.styles.length}`);
  console.log(`  token ${real.tokens} 个，描出 ${real.refs} 处`);
  for (const m of real.mismatches.slice(0, 20)) console.log(`  ✗ ${m}`);
  console.log('');

  check(
    `真实样本每一类 token 的数字都与界面一致（${real.tokens} 个 token）`,
    real.mismatches.length === 0,
    real.mismatches.slice(0, 3).join('；'),
  );

  // 采集层在最近一次改动之后才带上 ref，样本是旧的就会是 undefined。
  // 那种情况下上面那条断言会以「全都不对」的形式失败，这里先单独报一句，
  // 免得看的人以为溯源本身错了
  const missingRef = realSample.elements.filter((e) => typeof e.ref !== 'number').length;
  check(
    '样本里的元素都带编号（样本过期时要重新跑一次端到端）',
    missingRef === 0,
    `${missingRef} 个元素没有编号，这份样本是加编号之前导出的`,
  );
}

// ---------------------------------------------------------------------
console.log('');
console.log('='.repeat(70));
console.log('断言结果');
console.log('='.repeat(70));
for (const line of report) console.log(line);
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项未通过`);

process.exit(failed === 0 ? 0 : 1);
