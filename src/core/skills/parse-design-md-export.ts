/**
 * 从模型产出的 DESIGN.md 反解结构化分析数据，喂给右侧栏卡片。
 *
 * 这是「B 方案」：模型只产一份人读版 DESIGN.md（由 SKILL.md 约束，含
 * YAML front matter 与各 prose 章节），这里把 front matter 里的结构化
 * token（colors / typography / spacing / rounded / components）反解成
 * 和规则路径相同的五线对象，能解到哪条线就用哪条线，解不出或解不全的
 * 那条线回退到规则分析（rule 参数）。
 *
 * 为什么只信 front matter、不解析 prose 章节：prose 是自由文本，结构化
 * 程度低、易误读；front matter 的 token 是规范值，字段固定、可机器解析。
 * 模型若弱到连 front matter 都没写（只吐散文），这里返回 null，卡片就
 * 保持规则版，只把文档文本更新——也就是「能提取到哪些就哪些」。
 *
 * 反解出的对象里，凡是模型 front matter 给不出的派生量（证据计数、对比度
 * 之外的 things、baseUnit、来源列表等）一律用规则版或保守默认值兜底，保证
 * 卡片渲染不崩、且和规则路径同构。数值类字段（颜色 hex、字号、圆角、间距、
 * padding）如果模型给了，就如实采用。
 *
 * 这个模块是纯逻辑，不碰浏览器 API，可在 Node 侧直接测。
 */
import { frontMatterOf } from '../design-md';
import { contrastRatio, describeNearCanvas, type ColorRole, type ColorEvidence, type ColorAnalysis } from '../color';
import { ROLE_LABEL, type TypeRole, type TypeStep, type TypographyAnalysis } from '../typography';
import { KIND_LABEL } from '../kinds';
import {
  VARIANT_LABEL,
  type ButtonVariant,
  type ComponentKind,
  type ComponentSpec,
  type ComponentsAnalysis,
} from '../components';
import type {
  SpacingStep,
  SpacingSource,
  RadiusStep,
  SpacingAnalysis,
} from '../spacing';
import type { RadiusByKind, EffectsAnalysis } from '../effects';
import type { SampleExport } from '../export';
import type { StyleElementKind } from '../types';

// ---------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------

function unquote(s: string): string {
  const t = s.trim();
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'"))
  ) {
    return t.slice(1, -1);
  }
  return t;
}

/** 把 `{colors.primary}` 这类引用还原成 `colors.primary` 路径；不是引用则原样返回 */
function deref(token: string): string {
  const t = token.trim();
  const m = /^\{([\w.-]+)\.([\w.-]+)\}$/.exec(t);
  if (m) return `${m[1]}.${m[2]}`;
  return t;
}

/** 解析 "16px" / "9999px" / "16" 为数字，解析不了返回 null */
function parsePx(s: string): number | null {
  const t = unquote(s).trim();
  if (!t) return null;
  const m = /^([\d.]+)\s*px$/.exec(t) ?? /^([\d.]+)$/.exec(t);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function parseNum(s: string): number | null {
  const n = Number(unquote(s).trim());
  return Number.isFinite(n) ? n : null;
}

/** 归一化十六进制色值，非法返回 null */
function normalizeHex(s: string): string | null {
  const m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(s.trim());
  if (!m) return null;
  return m[0].toUpperCase();
}

// ---------------------------------------------------------------------
// front matter 解析（只认本项目生成的缩进结构：0 / 2 / 4 三档）
// ---------------------------------------------------------------------

interface FmGroups {
  colors: Record<string, string>;
  typography: Record<string, Record<string, string>>;
  spacing: Record<string, string>;
  rounded: Record<string, string>;
  components: Record<string, Record<string, string>>;
}

type GroupName = 'colors' | 'typography' | 'spacing' | 'rounded' | 'components';

function parseFrontMatter(fm: string): FmGroups {
  const out: FmGroups = { colors: {}, typography: {}, spacing: {}, rounded: {}, components: {} };
  let group: GroupName | null = null;
  let composite: string | null = null;

  for (const raw of fm.split('\n')) {
    if (raw.trim() === '') continue;
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();
    const m = /^([\w.-]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1] ?? '';
    const rest = (m[2] ?? '').trim();

    if (indent === 0) {
      if (
        key === 'colors' ||
        key === 'typography' ||
        key === 'spacing' ||
        key === 'rounded' ||
        key === 'components'
      ) {
        group = key;
        composite = null;
      } else {
        group = null;
        composite = null;
      }
    } else if (indent === 2) {
      if (!group) continue;
      if (rest === '') {
        composite = key;
        if (group === 'typography') out.typography[composite] = {};
        else if (group === 'components') out.components[composite] = {};
      } else {
        const val = unquote(rest);
        if (group === 'colors') out.colors[key] = val;
        else if (group === 'spacing') out.spacing[key] = val;
        else if (group === 'rounded') out.rounded[key] = val;
      }
    } else if (indent >= 4) {
      if (!group || !composite) continue;
      const val = unquote(rest);
      if (group === 'typography' && out.typography[composite]) out.typography[composite]![key] = val;
      else if (group === 'components' && out.components[composite])
        out.components[composite]![key] = val;
    }
  }
  return out;
}

// ---------------------------------------------------------------------
// 各线反解
// ---------------------------------------------------------------------

const COLOR_LABEL: Record<string, string> = {
  neutral: '页面底色',
  primary: '主要文字色',
  secondary: '次要文字色',
  tertiary: '主操作色',
  surface: '卡片与区块底色',
  border: '边框与分隔线',
};

function emptyEvidence(): ColorEvidence {
  return {
    backgroundCount: 0,
    backgroundShare: 0,
    textCount: 0,
    textChars: 0,
    textShare: 0,
    borderCount: 0,
    controlCount: 0,
    buttonBackgroundCount: 0,
  };
}

/** 解析一个颜色字段（可能直接是 hex，也可能引用 {colors.x}）为 hex，无效返回 null */
function resolveColor(raw: string, colors: Record<string, string>): string | null {
  const v = deref(raw).trim();
  if (v.startsWith('colors.')) {
    const target = colors[v.slice('colors.'.length)];
    if (!target) return null;
    return normalizeHex(target);
  }
  return normalizeHex(raw);
}

function buildColors(colors: Record<string, string>, rule: SampleExport): ColorAnalysis {
  const canvasHex = rule.analysis.colors.canvasHex;
  const roles: ColorRole[] = [];
  for (const [token, raw] of Object.entries(colors)) {
    const hex = resolveColor(raw, colors);
    if (!hex) continue;
    roles.push({
      token,
      label: COLOR_LABEL[token] ?? token,
      hex,
      usage: '由模型 DESIGN.md 反解得到（无详细用途说明）。',
      evidence: emptyEvidence(),
      mergedFrom: [],
      contrastWithCanvas: Number(contrastRatio(hex, canvasHex).toFixed(2)),
      nearCanvas: describeNearCanvas(hex, canvasHex, token),
      confidence: 'medium',
    });
  }
  if (roles.length === 0) return rule.analysis.colors;
  return {
    ...rule.analysis.colors,
    roles,
    discarded: [],
    clusterCount: roles.length,
    rawColorCount: roles.length,
  };
}

function roleFromKey(key: string): TypeRole {
  const k = key.toLowerCase();
  if (k.startsWith('headline') || k.includes('display') || k.includes('title')) return 'heading';
  if (k.startsWith('code')) return 'code';
  if (k.startsWith('caption')) return 'caption';
  if (k.startsWith('label') || k.startsWith('ui')) return 'ui';
  if (k.startsWith('body')) return 'body';
  return 'ui';
}

/** 行高有两种写法：px 值（lineHeight 字段）或倍数（lineHeightRatio）。各取其一 */
function parseLineHeight(v: string): [number | null, number | null] {
  const s = unquote(v).trim();
  if (!s) return [null, null];
  if (s.toLowerCase().endsWith('px')) {
    const n = parsePx(s);
    return n ? [n, null] : [null, null];
  }
  const n = Number(s);
  if (Number.isFinite(n) && n > 0) return [null, n];
  return [null, null];
}

/** 字间距：0 视为 normal（null），其余取 px 值 */
function parseLetterSpacing(v: string): number | null {
  const s = unquote(v).trim();
  if (!s) return null;
  if (s.toLowerCase() === 'normal') return null;
  const n = parsePx(s);
  if (n === null) return null;
  return n === 0 ? null : n;
}

function buildTypography(
  typo: Record<string, Record<string, string>>,
  rule: SampleExport,
): TypographyAnalysis {
  const steps: TypeStep[] = [];
  for (const [key, fields] of Object.entries(typo)) {
    const role = roleFromKey(key);
    const size = parsePx(fields.fontSize ?? '') || 0;
    const weight = parseNum(fields.fontWeight ?? '') ?? 400;
    const [lh, lhr] = parseLineHeight(fields.lineHeight ?? '');
    const ls = parseLetterSpacing(fields.letterSpacing ?? '');
    const family = fields.fontFamily ? [unquote(fields.fontFamily)] : [];
    steps.push({
      size,
      sizes: [size],
      role,
      label: ROLE_LABEL[role],
      chars: 0,
      elementCount: 0,
      weights: [weight],
      lineHeight: lh,
      lineHeightRatio: lhr,
      letterSpacing: ls,
      families: family,
      headingLevels: [],
      usage: '由模型 DESIGN.md 反解得到（无详细用途说明）。',
      confidence: 'medium',
    });
  }
  if (steps.length === 0) return rule.analysis.typography;
  const bodyStep = steps.find((s) => s.role === 'body');
  return {
    ...rule.analysis.typography,
    steps,
    bodySize: bodyStep ? bodyStep.size : rule.analysis.typography.bodySize,
    rawSizeCount: steps.length,
  };
}

function buildSpacing(spacing: Record<string, string>, rule: SampleExport): SpacingAnalysis {
  const steps: SpacingStep[] = [];
  for (const raw of Object.values(spacing)) {
    const value = parsePx(raw);
    if (!value) continue;
    steps.push({
      value,
      mergedFrom: [],
      units: 0,
      count: 0,
      sources: [] as SpacingSource[],
      usage: '由模型 DESIGN.md 反解得到（无详细来源说明）。',
      confidence: 'medium',
    });
  }
  if (steps.length === 0) return rule.analysis.spacing;
  return {
    ...rule.analysis.spacing,
    steps,
    rawValueCount: steps.length,
  };
}

function buildRounded(rounded: Record<string, string>): {
  spacingRadii: RadiusStep[];
  effectsRadii: RadiusByKind[];
} {
  const spacingRadii: RadiusStep[] = [];
  const effectsRadii: RadiusByKind[] = [];
  for (const raw of Object.values(rounded)) {
    const value = parsePx(raw);
    if (!value) continue;
    spacingRadii.push({ value, count: 1, usage: '模型 DESIGN.md 标注的圆角档位。' });
    effectsRadii.push({
      kind: 'card' as StyleElementKind,
      label: KIND_LABEL.card,
      radius: value,
      others: [],
      count: 1,
      usage: '模型 DESIGN.md 标注的圆角档位。',
    });
  }
  return { spacingRadii, effectsRadii };
}

function kindFromKey(key: string): ComponentKind | null {
  const k = key.toLowerCase();
  if (k.startsWith('button') || k.includes('button')) return 'button';
  if (k.startsWith('input') || k.includes('input')) return 'input';
  if (k.startsWith('nav') || k.includes('nav')) return 'nav';
  if (k.startsWith('card') || k.includes('card')) return 'card';
  return null;
}

function variantFromKey(key: string): ButtonVariant | null {
  const k = key.toLowerCase();
  if (k.includes('primary')) return 'primary';
  if (k.includes('secondary')) return 'secondary';
  if (k.includes('ghost')) return 'ghost';
  return null;
}

/** 解析 "12px 16px"（上下 12 / 左右 16）或 "16px" 为 [padX, padY] */
function parsePadding(v: string): [number, number] {
  const t = unquote(v).trim();
  if (!t) return [0, 0];
  const parts = t.split(/\s+/).map((p) => parsePx(p)).filter((n): n is number => n !== null);
  if (parts.length === 0) return [0, 0];
  if (parts.length === 1) return [parts[0] ?? 0, parts[0] ?? 0];
  // CSS 两值写法：第一是上下、第二是左右
  return [parts[1] ?? 0, parts[0] ?? 0];
}

function buildComponents(
  comps: Record<string, Record<string, string>>,
  groups: FmGroups,
  rule: SampleExport,
): ComponentsAnalysis {
  const specs: ComponentSpec[] = [];
  const colorHexOf = (t: string): string | null => resolveColor(groups.colors[t] ?? '', groups.colors);
  const roundedValueOf = (t: string): number => parsePx(groups.rounded[t] ?? '') ?? 0;
  const typeMap: Record<string, { fontSize: number; fontWeight: number; fontFamily: string }> = {};
  for (const [k, fields] of Object.entries(groups.typography)) {
    typeMap[k] = {
      fontSize: parsePx(fields.fontSize ?? '') || 0,
      fontWeight: parseNum(fields.fontWeight ?? '') ?? 400,
      fontFamily: fields.fontFamily ? unquote(fields.fontFamily) : '',
    };
  }

  for (const [key, fields] of Object.entries(comps)) {
    const kind = kindFromKey(key);
    if (!kind) continue;
    const variant = kind === 'button' ? variantFromKey(key) : null;

    const bgRaw = (fields.backgroundColor ?? '').trim();
    const bg =
      bgRaw === '' || bgRaw.toLowerCase() === 'transparent'
        ? null
        : resolveColor(bgRaw, groups.colors);

    const tcRaw = (fields.textColor ?? '').trim();
    const textColor =
      tcRaw === '' || tcRaw.toLowerCase() === 'transparent'
        ? null
        : resolveColor(tcRaw, groups.colors);

    const textContrast =
      bg && textColor ? Number(contrastRatio(textColor, bg).toFixed(2)) : null;

    const radius = fields.rounded ? roundedValueOf(deref(fields.rounded).slice('rounded.'.length)) : 0;
    const [padX, padY] = parsePadding(fields.padding ?? '');
    const typeRef = fields.typography ? typeMap[deref(fields.typography).slice('typography.'.length)] : null;
    const height = fields.height ? parsePx(fields.height) ?? 0 : 0;

    specs.push({
      kind,
      label: variant ? VARIANT_LABEL[variant] : KIND_LABEL[kind],
      variant,
      count: 1,
      backgroundColor: bg,
      textColor,
      textContrast,
      radius,
      paddingX: padX,
      paddingY: padY,
      borderWidth: 0,
      borderSides: 0,
      borderColor: null,
      borderStyle: 'solid',
      shadow: null,
      fontSize: typeRef ? typeRef.fontSize : 0,
      fontWeight: typeRef ? typeRef.fontWeight : 400,
      fontFamily: typeRef ? typeRef.fontFamily : '',
      height,
      signatureCount: 1,
      usage: '由模型 DESIGN.md 反解得到（无详细用途说明）。',
      confidence: 'low',
    });
  }

  if (specs.length === 0) return rule.analysis.components;
  return {
    ...rule.analysis.components,
    specs,
    sampleCount: rule.analysis.components.sampleCount,
    kindCount: new Set(specs.map((s) => s.kind)).size,
  };
}

// ---------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------

/**
 * 把模型产出的 DESIGN.md 反解成一份可驱动卡片的 SampleExport。
 *
 * 逐线兜底：模型 front matter 里有哪条线的 token，就用反解结果替换那条线
 * 的相关字段；没有的那条线保持规则版的整条分析。任何一条线都没解析到
 * 有效 token 时返回 null（调用方据此保持规则卡片、只更新文档）。
 *
 * 不修改传入的 rule，返回的是浅拷贝拼装的新对象。
 */
export function parseDesignMdToExport(md: string, rule: SampleExport): SampleExport | null {
  const fm = frontMatterOf(md);
  if (!fm) return null;

  const groups = parseFrontMatter(fm);

  const hasColors = Object.keys(groups.colors).length > 0;
  const hasType = Object.keys(groups.typography).length > 0;
  const hasSpacing = Object.keys(groups.spacing).length > 0;
  const hasRounded = Object.keys(groups.rounded).length > 0;
  const hasComponents = Object.keys(groups.components).length > 0;

  if (!hasColors && !hasType && !hasSpacing && !hasRounded && !hasComponents) return null;

  const merged: SampleExport = { ...rule, analysis: { ...rule.analysis } };

  if (hasColors) merged.analysis.colors = buildColors(groups.colors, rule);
  if (hasType) merged.analysis.typography = buildTypography(groups.typography, rule);
  if (hasSpacing) merged.analysis.spacing = buildSpacing(groups.spacing, rule);
  if (hasRounded) {
    const rounded = buildRounded(groups.rounded);
    merged.analysis.spacing = { ...merged.analysis.spacing, radii: rounded.spacingRadii };
    merged.analysis.effects = { ...merged.analysis.effects, radii: rounded.effectsRadii };
  }
  if (hasComponents) {
    merged.analysis.components = buildComponents(groups.components, groups, rule);
  }

  return merged;
}
