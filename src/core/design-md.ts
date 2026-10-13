/**
 * 把一次提取结果渲染成符合 DESIGN.md 规范的 markdown 文件。
 *
 * 规范来自 google-labs-code/design.md（alpha）。一份 DESIGN.md 分两层，
 * 上面是 YAML front matter 装机器读的 token，下面是 markdown 章节装人读的
 * 设计理由。token 是规范值，prose 解释这些值从哪来、该怎么用。
 *
 * 输入取整个导出快照而不是五份 analysis，有三个理由。
 * 一是 page、viewport、coverage 这三块都要写进 Overview，只拿 analysis 就
 * 得让调用方逐个补参数。二是弹窗里的「导出 JSON」和「导出 DESIGN.md」应当
 * 出自同一批数据，取同一个快照最省事，也杜绝了两边不一致。三是这个文件
 * 日后要能由快照离线重放，留住全量输入才有重放的可能。
 *
 * ── 三个会直接导致文件不合规的坑 ──
 *
 * 1. components 的子 token 只认 backgroundColor / textColor / typography /
 *    rounded / padding / size / height / width。写别的名字一律触发 lint 的
 *    broken-ref。所以组件里的字号和字重不能直写，只能靠 {typography.xxx}
 *    引用带过去。白名单导出成 COMPONENT_TOKEN_KEYS，检查脚本共用一份，
 *    不另写一遍。
 *
 * 2. 花括号引用的路径必须能解析，断一条就是 error 级。这里的做法是从源头
 *    杜绝：引用不是手写的，是从实际生成的 token 表里挑出来的，挑不到就退回
 *    裸值。另导出 collectTokenPaths()，让检查脚本能用同一套格式解析回来核对。
 *
 * 3. 章节顺序是强制的。DESIGN_MD_SECTIONS 就是那一份顺序，生成和校验共用。
 *
 * 这几个常量导出而不是让检查脚本各写一份，理由和项目里 refineKind() 抽出来
 * 共用一样：两份判据早晚分叉，而分叉在这类格式约定上极难从结果看出来。
 *
 * 这个模块是纯函数，不碰浏览器 API，也不碰 chrome API，能在 Node 里直接测。
 */
import type { SampleExport } from './export';
import type { ColorRole } from './color';
import { ROLE_LABEL, type TypeRole, type TypeStep } from './typography';
import type { ComponentSpec } from './components';
import { PILL_RADIUS } from './spacing';

/**
 * 补全文案的类型从 semantics.ts 引。
 *
 * 用 import type 是有意为之的，它编译期就被擦掉了。运行时的依赖方向必须
 * 保持单向：semantics.ts 要从这里取护栏的两条判据（祈使句式、自检口吻），
 * 如果这里也运行时要 semantics.ts，两个模块就成环。类型引用不构成环。
 */
import type { AiSemantics } from './semantics';


// ---------------------------------------------------------------------
// 对外约定的常量：生成与校验共用，不另写第二份
// ---------------------------------------------------------------------

/**
 * 章节顺序。规范要求这些章节按此顺序出现，可省略但不能乱序。
 * 顺序错了 lint 会报 section-order。
 */
export const DESIGN_MD_SECTIONS = [
  'Overview',
  'Colors',
  'Typography',
  'Layout',
  'Elevation & Depth',
  'Shapes',
  'Components',
  "Do's and Don'ts",
] as const;

/** front matter 允许出现的顶层键。多一个都会被 lint 当成 unknown-key */
export const FRONT_MATTER_KEYS = [
  'name',
  'description',
  'version',
  'colors',
  'typography',
  'spacing',
  'rounded',
  'components',
] as const;

/** components 里允许出现的子 token。其它名字触发 broken-ref */
export const COMPONENT_TOKEN_KEYS = [
  'backgroundColor',
  'textColor',
  'typography',
  'rounded',
  'padding',
  'size',
  'height',
  'width',
] as const;

/** token 版本号，跟随规范的 alpha */
const TOKEN_VERSION = 'alpha';

/**
 * 下载时的文件名。
 *
 * 必须正好是 DESIGN.md，不带主机名也不带时间戳。这个文件的使用方式是
 * 直接丢进项目根目录，让 Cursor 和 Claude Code 按约定找到它——它们的
 * 寻找方式是照着固定路径读，改一个字符就读不到了。同一站点反复导出会
 * 覆盖上一次，但这正是想要的结果：根目录里那份始终是最近一次的结论。
 *
 * JSON 留档是另一回事，它按主机名加时间戳区分，见 export.ts。
 */
export const DESIGN_MD_FILENAME = 'DESIGN.md';

// ---------------------------------------------------------------------
// 命名表
// ---------------------------------------------------------------------

/**
 * 排版层级的角色分组。
 *
 * caption（辅助文字）和 ui（界面文字）合并到 label 一组，因为它们最终都
 * 落到规范推荐的 label-* 这个名字族里。不合并的话两组会各自生成 label-md，
 * 直接撞名，而 typography 是 map，撞名的后果是后者覆盖前者，静默丢一级。
 */
type TypeGroup = 'headline' | 'body' | 'label' | 'code';

const GROUP_OF_ROLE: Record<TypeRole, TypeGroup> = {
  heading: 'headline',
  body: 'body',
  ui: 'label',
  caption: 'label',
  code: 'code',
};

/**
 * 组内后缀表。
 *
 * headline 从最大的 display 开始排；其余组只有一级时用 md 表示基准档，
 * 多级时从 lg 起往下排。这套规则同时满足两件事：任意级数都能推出唯一名字，
 * 且落在规范推荐的那几个词里。
 */
const HEADLINE_SUFFIX = ['display', 'lg', 'md', 'sm', 'xs'];
const SCALE_SUFFIX = ['lg', 'md', 'sm', 'xs'];

/** 间距档位的名字，按值升序分配 */
const SPACING_SUFFIX = ['xs', 'sm', 'md', 'lg', 'xl', '2xl', '3xl', '4xl'];

/** 圆角档位的名字，按半径升序分配。胶囊单独叫 full */
const RADIUS_SUFFIX = ['sm', 'md', 'lg', 'xl', '2xl', '3xl'];

/** 胶囊的写法。取一个远大于任何实际像素值的数，等价于全圆 */
const PILL_VALUE = '9999px';

// ---------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------

/**
 * YAML 双引号字符串。
 *
 * 颜色和引用一律加引号，不加的话 # 会被当成注释起始符，而花括号在部分
 * YAML 实现里会被当成流式映射。转义只需要处理反斜杠和双引号两样，
 * 我们的值全部来自计算样式，不会带控制字符。
 */
function yamlStr(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** 去掉浮点尾巴。字号和间距可能是 15.999999 这种 */
function clean(n: number): number {
  return Math.round(n * 100) / 100;
}

function px(n: number): string {
  return `${clean(n)}px`;
}

/** 十六进制统一大写，读文件的人不至于因为大小写不同以为这是两个色 */
function upperHex(hex: string): string {
  return hex.toUpperCase();
}

// ---------------------------------------------------------------------
// 排版层级命名
// ---------------------------------------------------------------------

export interface TypeToken {
  step: TypeStep;
  key: string;
}

function suffixesFor(group: TypeGroup, count: number): string[] {
  const out: string[] = [];
  if (group === 'headline') {
    for (let i = 0; i < count; i++) out.push(HEADLINE_SUFFIX[i] ?? `x${i + 1}`);
    return out;
  }
  if (count <= 1) return ['md'];
  for (let i = 0; i < count; i++) out.push(SCALE_SUFFIX[i] ?? `x${i + 1}`);
  return out;
}

/**
 * 给每一级字号起 token 名。
 *
 * 组内按字号降序编，序号越小字号越大。分组后的顺序沿用 steps 原本的
 * 字号降序，所以输出的 token 表也是从大到小排的，读的时候层级关系一眼可见。
 *
 * 导出给 llm/brief.ts 用。模型看到的 token 名必须和写进文件的键完全一致，
 * 否则它补的语义会挂在一个不存在的条目上。命名规则只能有一份。
 */
export function typographyTokens(steps: TypeStep[]): TypeToken[] {
  const grouped = new Map<TypeGroup, TypeStep[]>();

  for (const s of steps) {
    const g = GROUP_OF_ROLE[s.role];
    const list = grouped.get(g);
    if (list) list.push(s);
    else grouped.set(g, [s]);
  }

  const out: TypeToken[] = [];
  for (const [group, list] of grouped) {
    const sorted = [...list].sort((a, b) => b.size - a.size);
    const suffixes = suffixesFor(group, sorted.length);
    for (let i = 0; i < sorted.length; i++) {
      const step = sorted[i];
      if (!step) continue;
      out.push({ step, key: `${group}-${suffixes[i] ?? `x${i + 1}`}` });
    }
  }

  return out;
}

// ---------------------------------------------------------------------
// 圆角与间距命名
// ---------------------------------------------------------------------

export interface NamedValue {
  key: string;
  value: string;
  numeric: number;
}

/**
 * 收集页面用到的圆角档位。
 *
 * 两个来源要合并：spacing 那边是「页面上出现过哪几个半径值」，effects 那边是
 * 「按元素类型归纳出来的半径」。实测里 effects 能带出 spacing 漏掉的输入框
 * 6px，所以取并集而不是只取一个。
 *
 * 0 不进档位表。没有圆角不是一档圆角，写进去会让人以为该给元素加圆角。
 *
 * 导出给 llm/brief.ts 用，理由同 typographyTokens。
 */
export function roundedTokens(exported: SampleExport): NamedValue[] {
  const values = new Set<number>();
  let hasPill = false;

  const push = (v: number) => {
    if (!Number.isFinite(v) || v <= 0) return;
    if (v >= PILL_RADIUS) {
      hasPill = true;
      return;
    }
    values.add(clean(v));
  };

  for (const r of exported.analysis.spacing.radii) push(r.value);
  for (const r of exported.analysis.effects.radii) push(r.radius);

  const sorted = [...values].sort((a, b) => a - b);
  const out: NamedValue[] = sorted.map((v, i) => ({
    key: RADIUS_SUFFIX[i] ?? `x${i + 1}`,
    value: px(v),
    numeric: v,
  }));

  if (hasPill) out.push({ key: 'full', value: PILL_VALUE, numeric: PILL_RADIUS });

  return out;
}

/** 导出给 llm/brief.ts 用，理由同 typographyTokens */
export function spacingTokens(exported: SampleExport): NamedValue[] {
  return exported.analysis.spacing.steps.map((s, i) => ({
    key: SPACING_SUFFIX[i] ?? `x${i + 1}`,
    value: px(s.value),
    numeric: s.value,
  }));
}

/** 找数值相等的圆角 token，用来把组件的圆角写成引用 */
function radiusRef(value: number, tokens: NamedValue[]): string | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  const hit =
    value >= PILL_RADIUS
      ? tokens.find((t) => t.key === 'full')
      : tokens.find((t) => t.numeric === clean(value));
  return hit ? `{rounded.${hit.key}}` : null;
}

/** 找字号字重都对的排版 token，用来把组件的字体写成引用 */
function typeRef(fontSize: number, fontWeight: number, tokens: TypeToken[]): string | null {
  const sameSize = tokens.filter((t) => Math.abs(t.step.size - clean(fontSize)) < 0.5);
  if (sameSize.length === 0) return null;
  const hit = sameSize.find((t) => t.step.weights.indexOf(fontWeight) !== -1) ?? sameSize[0];
  return hit ? `{typography.${hit.key}}` : null;
}

/**
 * 找同值的颜色 token。
 *
 * 只用在背景色上。文字色即使偶然撞上某个色板值也不写引用，因为文字色是
 * 元素级的合成结果，写成 {colors.surface} 会让人以为「正文该用这个底色」，
 * 语义整个反了。背景色不存在这个问题，色板里的 surface 本来就是底色。
 */
function colorRef(hex: string | null, roles: ColorRole[]): string | null {
  if (!hex) return null;
  const norm = hex.toLowerCase();
  const hit = roles.find((r) => r.hex.toLowerCase() === norm);
  if (!hit) return null;
  return `{colors.${hit.token}}`;
}

// ---------------------------------------------------------------------
// front matter
// ---------------------------------------------------------------------

/**
 * 设计系统的名字。
 *
 * 优先用主机名，因为它短、唯一，而且正是「这是哪一套设计」的答案。
 * file:// 这类地址没有主机名，hostOf 会把整串路径兜回来，直接当名字会得到
 * 一行 file:///Users/... 所以这类退到页面标题。标题也可能过长，截一下。
 *
 * 导出给 llm/brief.ts 用：简报里的页面名和 front matter 的 name 必须是
 * 同一个来源，否则模型会照着简报写一个名字、文件里却是另一个。
 */
export function designName(exported: SampleExport): string {
  const host = exported.page.host;
  if (/^[a-z0-9.-]+(:\d+)?$/i.test(host)) return host;

  const title = exported.page.title.trim().replace(/\s+/g, ' ');
  if (title.length === 0) return 'Untitled Design';
  if (title.length <= 48) return title;
  return title.slice(0, 47) + '…';
}

/**
 * 这份文件的散文是谁写的。
 *
 * 写进 description，是因为这一项在规范里本来就是「这份设计系统的来源与
 * 性质」，而「散文出自本地规则还是出自模型」正属于这个范畴。放在正文里有
 * 两个坏处：会挤占 Overview 的篇幅，而且在一个供程序读的文件里，来源信息
 * 放在机器读的那一半更合适。
 *
 * 模型名带进来是有必要的，它带着不带数字无所谓——「数字多重集一致」那条
 * 断言比的是正文，front matter 里除去 description 以外必须逐字节相同。
 */
function provenance(prose: AiSemantics | null): string {
  if (!prose) return '散文部分是本地规则生成的用法约束。';
  return `散文部分由 ${prose.model || 'AI'} 补全，数值仍取自本次采集的实测结果。`;
}

function frontMatter(exported: SampleExport, prose: AiSemantics | null): string {
  const { page, analysis } = exported;
  const { colors, typography, spacing, components } = analysis;

  const out: string[] = ['---'];

  // 生成时刻取到日就够。写到秒反而让同一份设计在两次导出里看起来是两个版本
  const day = exported.generatedAt.slice(0, 10);

  out.push(`name: ${yamlStr(designName(exported))}`);
  out.push(
    `description: ${yamlStr(
      `从 ${page.url} 提取于 ${day}，采样视口宽度 ${page.viewportWidth}px。` +
        `token 是这次采集的实测值，${provenance(prose)}`,
    )}`,
  );
  out.push(`version: ${yamlStr(TOKEN_VERSION)}`);

  if (colors.roles.length > 0) {
    out.push('colors:');
    for (const r of colors.roles) {
      out.push(`  ${r.token}: ${yamlStr(upperHex(r.hex))}`);
    }
  }

  const typeTokens = typographyTokens(typography.steps);
  if (typeTokens.length > 0) {
    out.push('typography:');
    for (const t of typeTokens) {
      const s = t.step;
      out.push(`  ${t.key}:`);
      const family = s.families.length > 0 ? s.families.join(', ') : null;
      if (family) out.push(`    fontFamily: ${yamlStr(family)}`);
      out.push(`    fontSize: ${yamlStr(px(s.size))}`);
      const weight = s.weights[0];
      if (typeof weight === 'number') out.push(`    fontWeight: ${weight}`);
      if (s.lineHeightRatio !== null) out.push(`    lineHeight: ${s.lineHeightRatio}`);
      if (s.letterSpacing !== null) out.push(`    letterSpacing: ${yamlStr(px(s.letterSpacing))}`);
    }
  }

  const spaceTokens = spacingTokens(exported);
  if (spaceTokens.length > 0) {
    out.push('spacing:');
    for (const t of spaceTokens) out.push(`  ${t.key}: ${yamlStr(t.value)}`);
  }

  const radii = roundedTokens(exported);
  if (radii.length > 0) {
    out.push('rounded:');
    for (const t of radii) out.push(`  ${t.key}: ${yamlStr(t.value)}`);
  }

  if (components.specs.length > 0) {
    out.push('components:');
    for (const spec of components.specs) {
      out.push(`  ${componentKey(spec)}:`);
      for (const line of componentTokenLines(spec, typeTokens, radii, colors.roles)) {
        out.push(`    ${line}`);
      }
    }
  }

  out.push('---');
  return out.join('\n');
}

/** 组件在 front matter 里的键名。按钮带主次变体，其余按类型 */
export function componentKey(spec: ComponentSpec): string {
  if (spec.kind === 'button' && spec.variant) return `button-${spec.variant}`;
  return spec.kind;
}

/**
 * 一个组件的子 token。
 *
 * 只输出能确定的值，拿不准的键直接不写。省略是安全的，写一个猜出来的值
 * 会让复刻的人当真。字号字重和圆角一律走引用，因为规范只允许这些键名。
 */
function componentTokenLines(
  spec: ComponentSpec,
  typeTokens: TypeToken[],
  radii: NamedValue[],
  roles: ColorRole[],
): string[] {
  const lines: string[] = [];

  const bgRef = colorRef(spec.backgroundColor, roles);
  if (bgRef) lines.push(`backgroundColor: ${yamlStr(bgRef)}`);
  else if (spec.backgroundColor) lines.push(`backgroundColor: ${yamlStr(upperHex(spec.backgroundColor))}`);

  // 文字色照实写，不套色板引用，理由见 colorRef 的说明
  if (spec.textColor) lines.push(`textColor: ${yamlStr(upperHex(spec.textColor))}`);

  const tRef = typeRef(spec.fontSize, spec.fontWeight, typeTokens);
  if (tRef) lines.push(`typography: ${yamlStr(tRef)}`);

  const rRef = radiusRef(spec.radius, radii);
  if (rRef) lines.push(`rounded: ${yamlStr(rRef)}`);

  // 规范里 padding 只给单值 Dimension，这里给的是 CSS 简写的两个值（上下在前，
  // 左右在后）。信息量和严格合规之间选了前者，理由写在 HANDOFF 的待议里。
  // 两个方向相等时退成单值，免得出现 "24px 24px" 这种冗余写法。
  if (spec.paddingX > 0 || spec.paddingY > 0) {
    const value =
      Math.abs(spec.paddingX - spec.paddingY) < 0.5
        ? px(spec.paddingX)
        : `${clean(spec.paddingY)}px ${clean(spec.paddingX)}px`;
    lines.push(`padding: ${yamlStr(value)}`);
  }

  if (spec.height > 0) lines.push(`height: ${yamlStr(px(spec.height))}`);

  return lines;
}

// ---------------------------------------------------------------------
// markdown 章节
// ---------------------------------------------------------------------

/**
 * 给编码 agent 的提示词。
 *
 * 用三级标题而不是新开一个二级章节。规范里二级章节的顺序是强制的、名单是
 * 封闭的，多一个属于越界（实测官方 linter 目前不报，但那是它的宽松，不是
 * 规范的许可）。三级标题不是章节，挂在 Overview 下面读起来也顺：这一节讲的
 * 本来就是「这份文件是什么、该怎么用」。
 *
 * 提示词里允许出现反引号，所以围栏用 ```text。也正因为这样，校验端禁止
 * 三连反引号，否则模型能自己把围栏提前关掉，后面的内容会漏到围栏外面去。
 */
function promptBlock(prose: AiSemantics | null): string {
  if (!prose || prose.prompt.length === 0) return '';
  return ['### 给编码 agent 的提示词', '', '```text', prose.prompt, '```'].join('\n');
}

function overviewSection(exported: SampleExport, prose: AiSemantics | null): string {
  const { analysis, viewport, coverage } = exported;
  const { colors, typography, spacing, effects, components } = analysis;

  const lines: string[] = [];

  // 用和 front matter 的 name 同一个来源。file:// 这类没有主机名的地址，
  // hostOf 会把整串路径兜回来，直接写进正文就是一行 file:///Users/...
  const head: string[] = [`从 ${designName(exported)} 提取`];
  head.push(`页面底色 ${upperHex(colors.canvasHex)}，${colors.isDark ? '深色' : '浅色'}主题`);

  const primary = colors.roles.find((r) => r.token === 'primary');
  if (primary) {
    head.push(`文字主色 ${upperHex(primary.hex)}，与底色对比 ${clean(primary.contrastWithCanvas)}:1`);
  }

  const mainFont = typography.families.find((f) => f.isPrimary);
  if (mainFont) head.push(`全站统一使用 ${mainFont.name}`);

  lines.push(head.join('，') + '。');

  const counts: string[] = [];
  if (colors.roles.length > 0) counts.push(`${colors.roles.length} 个颜色角色`);
  if (typography.steps.length > 0) counts.push(`${typography.steps.length} 级字号`);
  if (spacing.steps.length > 0) counts.push(`${spacing.steps.length} 档间距`);
  if (effects.radii.length > 0) counts.push(`${effects.radii.length} 类圆角`);
  if (components.specs.length > 0) counts.push(`${components.specs.length} 个组件`);
  if (counts.length > 0) lines.push(`本次共识别出 ${counts.join('、')}。`);

  // 综述紧跟在事实之后、口径说明之前。读的人先知道这套设计大概长什么样，
  // 再读到「这是某个视口下的值」这类限定条件，顺序才顺
  if (prose && prose.summary.length > 0) {
    lines.push('');
    lines.push(prose.summary);
  }

  if (viewport) {
    lines.push('');
    lines.push('**采样口径**');
    lines.push('');
    // 数字由这里给，性质由 viewport.lines 讲，两处不重复同一句话
    lines.push(`采样视口宽度 ${viewport.width}px。`);
    for (const l of viewport.lines) lines.push(l);
  }

  if (coverage) {
    lines.push('');
    lines.push('**覆盖范围**');
    lines.push('');
    for (const l of coverage.lines) lines.push(l);
  }

  const prompt = promptBlock(prose);
  if (prompt.length > 0) {
    lines.push('');
    for (const l of prompt.split('\n')) lines.push(l);
  }

  return `## Overview\n\n${lines.join('\n')}`;
}

/**
 * 色板。
 *
 * 补全文案集中放在小节末尾一块，不逐条挂到每个颜色下面。两个理由：一是
 * 本地的色卡条目结构保持一个字节不动，带 AI 和不带 AI 的两份文件摆在一起
 * 看 diff，只有新增的那一块是变量，数值那部分一眼能确认没被动过；二是
 * 事实和形容分开摆，读的人清楚哪一半是测出来的、哪一半是推断出来的。
 */
function colorsSection(exported: SampleExport, prose: AiSemantics | null): string {
  const { roles, isDark } = exported.analysis.colors;
  if (roles.length === 0) return '';

  const body: string[] = [
    `底色${isDark ? '偏深' : '偏浅'}，下面是本次提取出的 ${roles.length} 个颜色角色。` +
      `token 名按用途定，不按色相定，复刻时优先改值而不是改用途。`,
    '',
  ];

  for (const r of roles) {
    body.push(`- **\`${r.token}\` (${upperHex(r.hex)})**　${r.usage}`);
    if (r.nearCanvas) body.push(`  - ${r.nearCanvas.text}`);
  }

  // 逐条对照 token 名，模型补的那些名字一定在 roles 里，校验端已经筛过一遍。
  // 这里再兜一次是因为 roles 才是权威名单，模型的键万一漂了就静默跳过
  if (prose) {
    const notes = roles
      .map((r) => ({ token: r.token, text: prose.colors[r.token] }))
      .filter((x): x is { token: string; text: string } => typeof x.text === 'string' && x.text.length > 0);

    if (notes.length > 0) {
      body.push('');
      body.push('**语义补充**');
      body.push('');
      for (const n of notes) body.push(`- \`${n.token}\`　${n.text}`);
    }
  }

  return `## Colors\n\n${body.join('\n')}`;
}

function typographySection(tokens: TypeToken[], exported: SampleExport): string {
  if (tokens.length === 0) return '';

  const { typography } = exported.analysis;
  const body: string[] = [];

  if (typography.bodySize !== null) {
    body.push(`正文基准 ${typography.bodySize}px，其余各级都以它为参照。`);
    body.push('');
  }

  for (const t of tokens) {
    const s = t.step;
    const meta: string[] = [`${clean(s.size)}px`];
    const weight = s.weights[0];
    if (typeof weight === 'number') meta.push(`字重 ${weight}`);
    if (s.lineHeightRatio !== null) meta.push(`行高 ${s.lineHeightRatio}`);
    if (s.headingLevels.length > 0) {
      meta.push(`落在 ${s.headingLevels.map((n) => 'h' + n).join(' / ')}`);
    }

    body.push(`- **\`${t.key}\`**　${meta.join(' · ')}`);
    body.push(`  ${s.usage}`);
  }

  if (typography.families.length > 0) {
    body.push('');
    body.push('**页面用到的字体**');
    body.push('');
    for (const f of typography.families) {
      const origin =
        f.origin === 'font-face' ? '页面自带' : f.origin === 'unknown' ? '本地不保证有' : '系统字体';
      const roles = f.roles.length > 0 ? `承担${f.roles.map((r) => ROLE_LABEL[r]).join('、')}` : '';
      const sizes = f.sizes.length > 0 ? `${f.sizes.join(' / ')}px` : '';
      const bits = [origin, roles, sizes].filter((x) => x.length > 0);
      body.push(`- \`${f.name}\`　${bits.join('，')}`);
    }
  }

  for (const f of typography.fallbacks) {
    body.push('');
    body.push(`\`${f.family}\` 的替代栈：\`${f.stack}\``);
  }

  // 说明性的 note 留在这里，不进 Do's and Don'ts。那一节只放可执行的约束，
  // 把「样本偏少」这类自检信息混进去，会让护栏失去分量
  if (typography.notes.length > 0) {
    body.push('');
    body.push('**说明**');
    body.push('');
    for (const n of typography.notes) {
      body.push(n.text);
      body.push('');
    }
  }

  return `## Typography\n\n${body.join('\n').trimEnd()}`;
}

function layoutSection(exported: SampleExport): string {
  const s = exported.analysis.spacing;
  const body: string[] = [];

  if (s.baseUnit !== null) {
    body.push(
      `间距基础单位 ${s.baseUnit}px，覆盖 ${Math.round(s.baseCoverage * 100)}% 的间距。` +
        `下面的档位是它的整数倍，新增间距先往上取。`,
    );
  } else {
    body.push('页面没有推断出稳定的间距基础单位，下面列的是实测档位。');
  }

  if (s.contentMaxWidth !== null) {
    body.push('');
    body.push(`内容最大宽度 ${s.contentMaxWidth}px。`);
  }
  if (s.contentWidthNote) body.push(`  ${s.contentWidthNote}`);

  if (s.cardPadding) {
    body.push('');
    body.push(`卡片内边距水平 ${s.cardPadding.x}px、垂直 ${s.cardPadding.y}px。`);
  }
  if (s.sectionGap !== null) body.push(`区块之间的间距 ${s.sectionGap}px。`);

  const tokens = spacingTokens(exported);
  if (tokens.length > 0) {
    body.push('');
    for (const t of tokens) {
      body.push(`- **\`${t.key}\`**　${t.value}`);
    }
  }

  // 理由同 Typography：自检性质的说明留在本节，不占护栏的位置
  if (s.notes.length > 0) {
    body.push('');
    body.push('**说明**');
    body.push('');
    for (const n of s.notes) {
      body.push(n.text);
      body.push('');
    }
  }

  return `## Layout\n\n${body.join('\n').trimEnd()}`;
}

/**
 * 高度层次。
 *
 * 边框放在这一节而不是单独开一节，是跟着规范走的：规则里说扁平设计不用
 * 投影时，用色调层次或边框来表达高度，所以描边属于这一节的替代手段。
 */
function elevationSection(exported: SampleExport): string {
  const e = exported.analysis.effects;
  const body: string[] = [];

  if (!e.usesShadow) {
    body.push('页面不用投影，元素之间的层次靠底色明度差和描边来分。');
  }

  for (const g of e.shadows) {
    body.push(`- \`${g.css}\`　出现 ${g.count} 处`);
    body.push(`  ${g.usage}`);
  }

  if (e.borders.length > 0) {
    body.push('');
    body.push('**描边**');
    body.push('');
    for (const b of e.borders) {
      const color = b.color ? `，颜色 ${upperHex(b.color)}` : '';
      body.push(`- ${b.width}px ${b.style}，${b.sides >= 4 ? '四边' : `${b.sides} 边`}${color}，出现 ${b.count} 处`);
      body.push(`  ${b.usage}`);
    }
  }

  for (const n of e.notes) body.push(n.text);

  if (body.length === 0) return '';

  return `## Elevation & Depth\n\n${body.join('\n').trimEnd()}`;
}

function shapesSection(exported: SampleExport): string {
  const tokens = roundedTokens(exported);
  const byKind = exported.analysis.effects.radii;
  if (tokens.length === 0 && byKind.length === 0) return '';

  const body: string[] = [];

  if (tokens.length > 0) {
    for (const t of tokens) body.push(`- **\`${t.key}\`**　${t.value}`);
  }

  if (byKind.length > 0) {
    body.push('');
    body.push('**按元素类型**');
    body.push('');
    for (const r of byKind) body.push(`- ${r.label}用 ${clean(r.radius)}px，共 ${r.count} 个元素`);
  }

  return `## Shapes\n\n${body.join('\n')}`;
}

/**
 * 组件。
 *
 * 补全的那句话作为第二段接在本地说明之后，不替换它。本地说明是从实测数据
 * 推出来的（「四边有 1px 的描边」「圆角比按钮小一档」），模型写不出这种
 * 具体度，最多是换个说法。让它补的是本地推不出来的那部分：这类组件在整个
 * 界面里扮演什么角色，复刻时容易在哪里走样。
 */
function componentsSection(exported: SampleExport, prose: AiSemantics | null): string {
  const specs = exported.analysis.components.specs;
  const notes = exported.analysis.components.notes;
  if (specs.length === 0 && notes.length === 0) return '';

  const body: string[] = [];

  for (const spec of specs) {
    body.push(`### \`${componentKey(spec)}\``);
    body.push(spec.usage);
    const extra = prose?.components[componentKey(spec)];
    if (typeof extra === 'string' && extra.length > 0) {
      body.push('');
      body.push(extra);
    }
    body.push('');
  }

  if (notes.length > 0) {
    body.push('**说明**');
    body.push('');
    for (const n of notes) {
      body.push(n.text);
      body.push('');
    }
  }

  return `## Components\n\n${body.join('\n').trimEnd()}`;
}

/**
 * 祈使句的判据。
 *
 * 只认句式，不认内容。像「用于说明文字、辅助标签这类不该抢占注意力的内容」
 * 虽然含「不该」，但整句在描述这个色值用来做什么，不是一条可执行的约束。
 * 所以「不该」不在表内，「只用来」在。
 *
 * 导出给两处用：semantics.ts 拦模型写的护栏，design-md-check.ts 验最终产出。
 * 之前检查脚本里把这个正则抄了一份，那正是「同一判据两份」的开端。
 */
export const IMPERATIVE = /不要|只用于|只应该|只用来|不能再/;

/**
 * 自检口吻的判据。
 *
 * 「样本偏少，需要人工过一眼」这类句子说的是这次提取的质量，不是给复刻者的
 * 约束。它留在各自章节里是有用的，混进护栏会把一节可执行的规则冲淡成一份
 * 自检报告。判据同样导出共用。
 */
export const SELF_INSPECTION = /样本偏少|人工过一眼|人工再对一眼|仅供参考/;

/** 规范建议这一节控制在 4 到 8 条。超出的按顺序截断 */
const MAX_GUARDRAILS = 8;

/**
 * 从一句用途说明里挑出末尾的祈使句，作为护栏。
 *
 * 各模块的 usage 都是「描述事实。给出约束。」这个结构，最后那句往往正是
 * 复刻时最容易踩的坑。这里只做挑选，不重写也不拼接，挑不到就返回 null，
 * 宁可少一条也不自己编一句像模像样的规矩出来。
 */
function tailGuardrail(usage: string): string | null {
  const sentences = usage
    .split('。')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  for (let i = sentences.length - 1; i >= 0; i--) {
    const s = sentences[i] ?? '';
    if (IMPERATIVE.test(s)) return s + '。';
  }
  return null;
}

/**
 * 给复刻者的约束。
 *
 * 各模块的 notes 里混着两类东西：一类是约束（标题正文用同一套字体，复刻时
 * 不要再引入第二种），一类是关于这次提取质量的说明（样本偏少，需要人工过
 * 一眼）。后者是给用这个工具的人看的，对复刻没有指导意义，收进这一节只会
 * 把它冲淡成一份自检报告。所以用祈使句式过一遍筛，说明性的句子留在各自的
 * 章节里，不在这里重复。
 *
 * ── AI 条目为什么能挤掉本地条目 ──
 *
 * 本地条目排在前、AI 条目接在后，但总数封顶，所以 AI 那几条会顶掉末尾几条
 * 本地条目。反过来（本地优先、AI 有剩才补）在多数页面上会让 AI 这一项功能
 * 完全不可见——实测里本地条目经常已经占满八条。留出固定名额是有意的取舍：
 * AI 护栏是这个功能的卖点之一，整段消失比少两条本地约束更糟。
 */
function dosSection(exported: SampleExport, prose: AiSemantics | null): string {
  const { colors, typography, spacing, effects, components } = exported.analysis;
  const local: string[] = [];

  for (const r of colors.roles) {
    const g = tailGuardrail(r.usage);
    if (g) local.push(g);
  }

  const fromNotes = [
    ...typography.notes,
    ...spacing.notes,
    ...effects.notes,
    ...components.notes,
  ];
  for (const n of fromNotes) {
    if (IMPERATIVE.test(n.text)) local.push(n.text);
  }

  const ai = prose ? prose.guidelines : [];
  if (local.length === 0 && ai.length === 0) return '';

  const room = Math.max(0, MAX_GUARDRAILS - ai.length);
  const kept = [...local.slice(0, room), ...ai].slice(0, MAX_GUARDRAILS);
  if (kept.length === 0) return '';

  return `## Do's and Don'ts\n\n${kept.map((b) => `- ${b}`).join('\n')}`;
}

// ---------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------

/**
 * 渲染一份 DESIGN.md。
 *
 * 空的分区整节省略，不写空标题。规范允许省略章节，而一个没有内容的
 * 「## Shapes」读起来只会让人以为漏提取了。
 *
 * 各章节之间用一个空行分隔，front matter 后面也是。空行由这里统一给，
 * 章节自己不带尾部换行，这样「哪一段该省略」和「省略之后间距还在不在」
 * 是两件独立的事，不会因为某个章节返回空串就把空行一起吃掉。
 *
 * ── 第二个参数 ──
 *
 * prose 是 AI 补全出来的文案，可以整个不传。传 null 和完全不传的结果
 * 逐字节相同，检查脚本里有断言卡住这一点——「没有 Key 时能拿到一份完整可用的
 * 文件」这条验收标准，落地就是它。
 *
 * 文案只做叠加，不替换任何本地内容，也从不参与数值的生成。正文里出现的
 * 每一个数字都来自导出快照，模型的输出里连一个阿拉伯数字都不允许有
 * （校验在 semantics.ts）。所以「补全后的数值必须与提取结果一致」不是靠
 * 提示词祈祷出来的，是结构上做不到不一致。
 */
export function renderDesignMd(exported: SampleExport, prose: AiSemantics | null = null): string {
  const typeTokens = typographyTokens(exported.analysis.typography.steps);

  const parts = [
    frontMatter(exported, prose),
    overviewSection(exported, prose),
    colorsSection(exported, prose),
    typographySection(typeTokens, exported),
    layoutSection(exported),
    elevationSection(exported),
    shapesSection(exported),
    componentsSection(exported, prose),
    dosSection(exported, prose),
  ].filter((p) => p.length > 0);

  return parts.join('\n\n') + '\n';
}

// ---------------------------------------------------------------------
// 自查工具：给检查脚本用，和生成逻辑共用同一套格式约定
// ---------------------------------------------------------------------

/** 取出 front matter 的内容。没有 front matter 时返回 null */
export function frontMatterOf(md: string): string | null {
  if (!md.startsWith('---\n')) return null;
  const end = md.indexOf('\n---\n', 3);
  if (end < 0) return null;
  return md.slice(4, end + 1);
}

/**
 * 列出 front matter 里定义的全部 token 路径。
 *
 * 这是个针对本模块输出格式的解析器，不是通用 YAML 解析。输出格式由
 * frontMatter() 完全控制，缩进只有 0 / 2 / 4 三档，按行匹配就够，
 * 不必为此引入一个 YAML 库。
 *
 * 三档缩进的含义分别是：0 是 colors / typography 这类顶层分组，2 是分组下的
 * token（colors.tertiary、typography.headline-lg），4 是复合 token 内部的
 * 字段（typography.headline-lg.fontSize）。引用只会指向前两档，但第三档也
 * 收进来，将来要引 composite 值时不用再改这里。
 */
export function collectTokenPaths(md: string): string[] {
  const fm = frontMatterOf(md);
  if (!fm) return [];

  const paths: string[] = [];
  let top: string | null = null;
  let sub: string | null = null;

  for (const raw of fm.split('\n')) {
    if (raw.trim().length === 0) continue;

    const deep = /^ {4}([A-Za-z0-9_-]+):/.exec(raw);
    if (deep) {
      const key = deep[1];
      if (top && sub && key) paths.push(`${top}.${sub}.${key}`);
      continue;
    }

    const second = /^ {2}([A-Za-z0-9_-]+):(.*)$/.exec(raw);
    if (second) {
      const key = second[1] ?? '';
      const rest = (second[2] ?? '').trim();
      if (top && key) paths.push(`${top}.${key}`);
      // 二级键后面没值，说明它是个复合 token 的头部，下一层的字段挂在它下面
      sub = rest.length === 0 ? key : null;
      continue;
    }

    // 顶层。带值的（name / description / version）不是 token，不带值的才是分组
    const first = /^([A-Za-z0-9_-]+):(.*)$/.exec(raw);
    if (first) {
      const key = first[1] ?? '';
      const rest = (first[2] ?? '').trim();
      top = rest.length === 0 ? key : null;
      sub = null;
    }
  }

  return paths;
}

/** 列出 markdown 里出现的全部章节标题，按出现顺序 */
export function collectSections(md: string): string[] {
  const out: string[] = [];
  const re = /^## (.+)$/gm;
  let m = re.exec(md);
  while (m) {
    if (m[1]) out.push(m[1].trim());
    m = re.exec(md);
  }
  return out;
}

/** 列出文中出现的全部花括号引用路径 */
export function collectReferences(md: string): string[] {
  const out: string[] = [];
  const re = /\{([A-Za-z0-9_.-]+)\}/g;
  let m = re.exec(md);
  while (m) {
    if (m[1]) out.push(m[1]);
    m = re.exec(md);
  }
  return out;
}
