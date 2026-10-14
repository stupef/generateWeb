/**
 * 把 LLM 提取 skill 的返回文本解析成结构化 SampleExport。
 *
 * 模型按 SKILL.md 的约定返回两块：一个 ```json 分析块（五线结构化数据）
 * 和一个 ```markdown DESIGN.md 块。这里负责把 json 块解析成
 * SampleExport.analysis 的五条线，并把 markdown 块当作 DESIGN.md 文本。
 *
 * 设计上的两条硬约束：
 *
 * 1. 模型只给「能从样本观测到」的原始值；对比度、文字底色对比、置信度、
 *    证据计数这些派生量在这里算，模型给了反而可能因为算错而带偏卡片。
 * 2. 逐通道回退到规则分析。模型哪条线没给、给空、给畸形，那条线直接用
 *    ruleExported.analysis 的对应线，其余仍用模型的。这样弱模型漏几线
 *    也不会崩，屏幕上始终有完整卡片。
 *
 * 解析失败（连 json 都解析不出来、或五条线全空）时 exported 返回 null，
 * 调用方据此把整次提取判为失败、退回规则版。
 */
import { contrastRatio } from '../color-math';
import { KIND_LABEL } from '../kinds';
import type { StyleElementKind } from '../types';
import type { ColorAnalysis, ColorRole, DiscardedColor } from '../color';
import type {
  TypographyAnalysis,
  TypeStep,
  TypeRole,
  FontFamilyStat,
} from '../typography';
import type {
  SpacingAnalysis,
  SpacingStep,
  SpacingSource,
  RadiusStep,
  CardPadding,
} from '../spacing';
import type {
  EffectsAnalysis,
  RadiusByKind,
  BorderGroup,
  ShadowGroup,
  EffectsNote,
} from '../effects';
import type {
  ComponentsAnalysis,
  ComponentSpec,
  ComponentsNote,
  ComponentKind,
  ButtonVariant,
} from '../components';
import type { SampleExport } from '../export';
import type { SemanticsIssue } from '../semantics';

// ---------------------------------------------------------------------
// 模型给的「宽松」结构。字段基本都可省，解析时逐个校验。
// ---------------------------------------------------------------------

interface LlmRole {
  token: string;
  label?: string;
  hex: string;
  usage?: string;
}
interface LlmTypeStep {
  size: number;
  role?: string;
  label?: string;
  weights?: number[];
  lineHeight?: number;
  lineHeightRatio?: number;
  letterSpacing?: number;
  families?: string[];
  headingLevels?: number[];
  usage?: string;
}
interface LlmSpacingStep {
  value: number;
  units?: string;
  count?: number;
  sources?: string[];
  usage?: string;
}
interface LlmRadius {
  value: number;
  count?: number;
  usage?: string;
}
interface LlmRadiusByKind {
  kind: string;
  label?: string;
  radius: number;
  others?: number[];
  count?: number;
  usage?: string;
}
interface LlmBorder {
  width: number;
  sides: number;
  style: string;
  color?: string;
  count?: number;
  kinds?: string[];
  usage?: string;
}
interface LlmShadow {
  css?: string;
  layers?: unknown[];
  count?: number;
  kinds?: string[];
  usage?: string;
}
interface LlmComponentSpec {
  kind: string;
  label?: string;
  variant?: string;
  count?: number;
  backgroundColor?: string;
  textColor?: string;
  radius?: number;
  paddingX?: number;
  paddingY?: number;
  borderWidth?: number;
  borderSides?: number;
  borderColor?: string;
  borderStyle?: string;
  shadow?: string;
  fontSize?: number;
  fontWeight?: number;
  fontFamily?: string;
  height?: number;
  usage?: string;
}
interface LlmAnalysis {
  colors?: {
    canvasHex?: string;
    isDark?: boolean;
    roles?: LlmRole[];
    discarded?: { hex: string; reason: string }[];
  };
  typography?: {
    families?: { family: string; note?: string }[];
    steps?: LlmTypeStep[];
    bodySize?: number;
    monoFamilies?: string[];
    rawSizeCount?: number;
  };
  spacing?: {
    baseUnit?: number;
    baseUnitConfidence?: string;
    baseCoverage?: number;
    steps?: LlmSpacingStep[];
    contentMaxWidth?: number;
    cardPadding?: { x: number; y: number; sampleCount?: number };
    sectionGap?: number;
    radii?: LlmRadius[];
    rawValueCount?: number;
  };
  effects?: {
    radii?: LlmRadiusByKind[];
    borders?: LlmBorder[];
    shadows?: LlmShadow[];
    usesShadow?: boolean;
    notes?: string[];
  };
  components?: {
    specs?: LlmComponentSpec[];
    notes?: string[];
    sampleCount?: number;
  };
}

// ---------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------

const NEAR_CANVAS_CONTRAST = 1.2;

const TYPE_ROLES = new Set(['heading', 'body', 'caption', 'code', 'ui']);

const SPACING_SOURCES = new Set(['padding', 'gap', 'margin']);

function isHex(s: unknown): s is string {
  return typeof s === 'string' && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(s.trim());
}

function upperHex(s: string): string {
  return s.trim().toUpperCase();
}

function asStyleKind(k: string): StyleElementKind {
  return (k === 'button' || k === 'input' || k === 'nav' || k === 'card' ? k : 'other') as StyleElementKind;
}

/** 从模型文本里抠出 ```json 块；没有就尝试整段当 JSON */
function extractJson(text: string): string | null {
  const fence = text.match(/```\s*json\s*([\s\S]*?)```/i);
  if (fence && fence[1]) return fence[1].trim();
  const plain = text.match(/```\s*([\s\S]*?)```/);
  if (plain && plain[1]) return plain[1].trim();
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) return trimmed;
  return null;
}

/** 从模型文本里抠出 ```markdown 块（没有就返回 null，由调用方决定回退） */
function extractMarkdown(text: string): string | null {
  const fence = text.match(/```markdown\s*([\s\S]*?)```/i);
  if (fence && fence[1]) return fence[1].trim();
  return null;
}

// ---------------------------------------------------------------------
// 逐通道 coerce
// ---------------------------------------------------------------------

function coerceColors(
  raw: LlmAnalysis['colors'] | undefined,
  rule: ColorAnalysis,
  issues: SemanticsIssue[],
): ColorAnalysis {
  if (!raw || !Array.isArray(raw.roles) || raw.roles.length === 0) {
    issues.push({ field: 'colors', reason: '模型未提供颜色角色，已用规则分析兜底' });
    return rule;
  }
  const canvas = raw.canvasHex && isHex(raw.canvasHex) ? upperHex(raw.canvasHex) : rule.canvasHex;
  const roles: ColorRole[] = [];
  for (const r of raw.roles) {
    if (!r || typeof r.token !== 'string' || !isHex(r.hex)) continue;
    const hex = upperHex(r.hex);
    const ratio = Number(contrastRatio(hex, canvas).toFixed(2));
    roles.push({
      token: r.token,
      label: typeof r.label === 'string' && r.label ? r.label : r.token,
      hex,
      usage: typeof r.usage === 'string' ? r.usage : '',
      evidence: {
        backgroundCount: 0,
        backgroundShare: 0,
        textCount: 0,
        textChars: 0,
        textShare: 0,
        borderCount: 0,
        controlCount: 0,
        buttonBackgroundCount: 0,
      },
      mergedFrom: [],
      contrastWithCanvas: ratio,
      nearCanvas:
        ratio > 1.01 && ratio <= NEAR_CANVAS_CONTRAST
          ? {
              ratio,
              text: `与页面底色的对比度只有 ${ratio}:1，多数显示器上看不出差别。它没有跟底色合并，因为属于页面真实存在的层级关系。`,
            }
          : null,
      confidence: 'medium',
    });
  }
  if (roles.length === 0) {
    issues.push({ field: 'colors', reason: '模型给出的颜色角色均无效，已用规则分析兜底' });
    return rule;
  }
  const discarded: DiscardedColor[] = Array.isArray(raw.discarded)
    ? raw.discarded
        .filter((d) => d && isHex(d.hex))
        .map((d) => ({ hex: upperHex(d.hex), count: 0, reason: typeof d.reason === 'string' ? d.reason : '模型标注为过滤色' }))
    : rule.discarded;
  return {
    canvasHex: canvas,
    isDark: typeof raw.isDark === 'boolean' ? raw.isDark : rule.isDark,
    roles,
    discarded,
    clusterCount: roles.length,
    rawColorCount: rule.rawColorCount,
  };
}

function coerceTypography(
  raw: LlmAnalysis['typography'] | undefined,
  rule: TypographyAnalysis,
  issues: SemanticsIssue[],
): TypographyAnalysis {
  if (!raw || !Array.isArray(raw.steps) || raw.steps.length === 0) {
    issues.push({ field: 'typography', reason: '模型未提供字号层级，已用规则分析兜底' });
    return rule;
  }
  const steps: TypeStep[] = [];
  for (const s of raw.steps) {
    if (!s || typeof s.size !== 'number' || !Number.isFinite(s.size)) continue;
    steps.push({
      size: s.size,
      sizes: [s.size],
      role: (typeof s.role === 'string' && TYPE_ROLES.has(s.role) ? (s.role as TypeRole) : 'body'),
      label: typeof s.label === 'string' ? s.label : '',
      chars: 0,
      elementCount: 0,
      weights: Array.isArray(s.weights) ? s.weights.filter((w) => typeof w === 'number') : [],
      lineHeight: typeof s.lineHeight === 'number' ? s.lineHeight : 0,
      lineHeightRatio: typeof s.lineHeightRatio === 'number' ? s.lineHeightRatio : 0,
      letterSpacing: typeof s.letterSpacing === 'number' ? s.letterSpacing : null,
      families: Array.isArray(s.families) ? s.families.filter((f) => typeof f === 'string') : [],
      headingLevels: Array.isArray(s.headingLevels) ? s.headingLevels.filter((h) => typeof h === 'number') : [],
      usage: typeof s.usage === 'string' ? s.usage : '',
      confidence: 'medium',
    });
  }
  if (steps.length === 0) {
    issues.push({ field: 'typography', reason: '模型给出的字号层级均无效，已用规则分析兜底' });
    return rule;
  }
  // 字体族完整统计（name/origin/generic/roles/sizes 等）只能从样本算，
  // 模型只给名字给不出这些派生量，直接用规则分析的版本，不覆盖。
  const families: FontFamilyStat[] = rule.families;
  return {
    families,
    steps,
    bodySize: typeof raw.bodySize === 'number' ? raw.bodySize : rule.bodySize,
    monoFamilies: Array.isArray(raw.monoFamilies) ? raw.monoFamilies.filter((x) => typeof x === 'string') : rule.monoFamilies,
    discarded: rule.discarded,
    fallbacks: rule.fallbacks,
    notes: rule.notes,
    rawSizeCount: typeof raw.rawSizeCount === 'number' ? raw.rawSizeCount : rule.rawSizeCount,
  };
}

function coerceSpacing(
  raw: LlmAnalysis['spacing'] | undefined,
  rule: SpacingAnalysis,
  issues: SemanticsIssue[],
): SpacingAnalysis {
  if (!raw || !Array.isArray(raw.steps) || raw.steps.length === 0) {
    issues.push({ field: 'spacing', reason: '模型未提供间距档位，已用规则分析兜底' });
    return rule;
  }
  const steps: SpacingStep[] = [];
  for (const s of raw.steps) {
    if (!s || typeof s.value !== 'number' || !Number.isFinite(s.value)) continue;
    steps.push({
      value: s.value,
      mergedFrom: [],
      // 折合几个基础单位只能从 baseUnit 推断，模型给不出，置 0
      units: 0,
      count: typeof s.count === 'number' ? s.count : 0,
      sources: Array.isArray(s.sources)
        ? s.sources.filter((x): x is SpacingSource => typeof x === 'string' && SPACING_SOURCES.has(x))
        : [],
      usage: typeof s.usage === 'string' ? s.usage : '',
      confidence: 'medium',
    });
  }
  if (steps.length === 0) {
    issues.push({ field: 'spacing', reason: '模型给出的间距档位均无效，已用规则分析兜底' });
    return rule;
  }
  const radii: RadiusStep[] = Array.isArray(raw.radii)
    ? raw.radii.filter((r) => r && typeof r.value === 'number').map((r) => ({ value: r.value, count: typeof r.count === 'number' ? r.count : 0, usage: typeof r.usage === 'string' ? r.usage : '' }))
    : rule.radii;
  const cardPadding: CardPadding | null =
    raw.cardPadding && typeof raw.cardPadding.x === 'number' && typeof raw.cardPadding.y === 'number'
      ? { x: raw.cardPadding.x, y: raw.cardPadding.y, sampleCount: typeof raw.cardPadding.sampleCount === 'number' ? raw.cardPadding.sampleCount : 0 }
      : rule.cardPadding;
  return {
    baseUnit: typeof raw.baseUnit === 'number' ? raw.baseUnit : rule.baseUnit,
    baseUnitConfidence: (raw.baseUnitConfidence as SpacingAnalysis['baseUnitConfidence']) ?? rule.baseUnitConfidence,
    baseCoverage: typeof raw.baseCoverage === 'number' ? raw.baseCoverage : rule.baseCoverage,
    steps,
    discarded: rule.discarded,
    contentMaxWidth: typeof raw.contentMaxWidth === 'number' ? raw.contentMaxWidth : rule.contentMaxWidth,
    cardPadding,
    sectionGap: typeof raw.sectionGap === 'number' ? raw.sectionGap : rule.sectionGap,
    radii,
    notes: rule.notes,
    rawValueCount: typeof raw.rawValueCount === 'number' ? raw.rawValueCount : rule.rawValueCount,
    contentWidthNote: rule.contentWidthNote,
  };
}

function coerceEffects(
  raw: LlmAnalysis['effects'] | undefined,
  rule: EffectsAnalysis,
  issues: SemanticsIssue[],
): EffectsAnalysis {
  if (!raw) {
    issues.push({ field: 'effects', reason: '模型未提供圆角/边框/投影，已用规则分析兜底' });
    return rule;
  }
  const radii: RadiusByKind[] = Array.isArray(raw.radii)
    ? raw.radii
        .filter((r) => r && typeof r.kind === 'string' && typeof r.radius === 'number')
        .map((r) => {
          const kind = asStyleKind(r.kind);
          return {
            kind,
            label: typeof r.label === 'string' && r.label ? r.label : KIND_LABEL[kind] ?? r.kind,
            radius: r.radius,
            others: Array.isArray(r.others) ? r.others.filter((x) => typeof x === 'number') : [],
            count: typeof r.count === 'number' ? r.count : 0,
            usage: typeof r.usage === 'string' ? r.usage : '',
          };
        })
    : rule.radii;
  const borders: BorderGroup[] = Array.isArray(raw.borders)
    ? raw.borders
        .filter((b) => b && typeof b.width === 'number' && typeof b.sides === 'number' && typeof b.style === 'string')
        .map((b) => ({
          width: b.width,
          sides: b.sides,
          style: b.style,
          color: typeof b.color === 'string' ? b.color : null,
          count: typeof b.count === 'number' ? b.count : 0,
          kinds: Array.isArray(b.kinds) ? b.kinds.filter((k) => typeof k === 'string').map(asStyleKind) : [],
          usage: typeof b.usage === 'string' ? b.usage : '',
        }))
    : rule.borders;
  const shadows: ShadowGroup[] = Array.isArray(raw.shadows)
    ? raw.shadows.filter((s) => s && (typeof s.css === 'string' || Array.isArray(s.layers))).map((s) => ({
        css: typeof s.css === 'string' ? s.css : '',
        layers: Array.isArray(s.layers) ? (s.layers as ShadowGroup['layers']) : [],
        count: typeof s.count === 'number' ? s.count : 0,
        kinds: Array.isArray(s.kinds) ? s.kinds.filter((k) => typeof k === 'string').map(asStyleKind) : [],
        usage: typeof s.usage === 'string' ? s.usage : '',
      }))
    : rule.shadows;
  if (radii.length === 0 && borders.length === 0 && shadows.length === 0) {
    issues.push({ field: 'effects', reason: '模型给出的圆角/边框/投影均无效，已用规则分析兜底' });
    return rule;
  }
  const notes: EffectsNote[] = Array.isArray(raw.notes)
    ? raw.notes.filter((t) => typeof t === 'string').map((t) => ({ kind: 'thin-sample', text: t }))
    : rule.notes;
  return {
    radii,
    borders,
    shadows,
    usesShadow: typeof raw.usesShadow === 'boolean' ? raw.usesShadow : rule.usesShadow,
    notes,
    sampleCount: rule.sampleCount,
  };
}

function coerceComponents(
  raw: LlmAnalysis['components'] | undefined,
  rule: ComponentsAnalysis,
  issues: SemanticsIssue[],
): ComponentsAnalysis {
  if (!raw || !Array.isArray(raw.specs) || raw.specs.length === 0) {
    issues.push({ field: 'components', reason: '模型未提供组件参数，已用规则分析兜底' });
    return rule;
  }
  const specs: ComponentSpec[] = [];
  for (const s of raw.specs) {
    if (!s || typeof s.kind !== 'string') continue;
    const kind = s.kind as ComponentKind;
    const backgroundColor = typeof s.backgroundColor === 'string' ? s.backgroundColor : null;
    const textColor = typeof s.textColor === 'string' ? s.textColor : null;
    const textContrast =
      backgroundColor && textColor ? Number(contrastRatio(textColor, backgroundColor).toFixed(2)) : null;
    const count = typeof s.count === 'number' ? s.count : 0;
    // 模型不提供「外观有几种写法」这个派生量，按单一样式处理；
    // 置信度沿用规则分析的口径：单样式且出现 >=3 次算 high，>=2 算 medium。
    const signatureCount = 1;
    const confidence: ComponentSpec['confidence'] =
      signatureCount === 1 && count >= 3 ? 'high' : count >= 2 ? 'medium' : 'low';
    specs.push({
      kind,
      label: typeof s.label === 'string' && s.label ? s.label : KIND_LABEL[kind] ?? s.kind,
      variant: kind === 'button' ? ((s.variant as ButtonVariant) ?? null) : null,
      count,
      signatureCount,
      usage: typeof s.usage === 'string' ? s.usage : '',
      confidence,
      backgroundColor,
      textColor,
      textContrast,
      radius: typeof s.radius === 'number' ? s.radius : 0,
      paddingX: typeof s.paddingX === 'number' ? s.paddingX : 0,
      paddingY: typeof s.paddingY === 'number' ? s.paddingY : 0,
      borderWidth: typeof s.borderWidth === 'number' ? s.borderWidth : 0,
      borderSides: typeof s.borderSides === 'number' ? s.borderSides : 4,
      borderColor: typeof s.borderColor === 'string' ? s.borderColor : null,
      borderStyle: typeof s.borderStyle === 'string' ? s.borderStyle : 'solid',
      shadow: typeof s.shadow === 'string' ? s.shadow : null,
      fontSize: typeof s.fontSize === 'number' ? s.fontSize : 0,
      fontWeight: typeof s.fontWeight === 'number' ? s.fontWeight : 400,
      fontFamily: typeof s.fontFamily === 'string' ? s.fontFamily : '',
      height: typeof s.height === 'number' ? s.height : 0,
    });
  }
  if (specs.length === 0) {
    issues.push({ field: 'components', reason: '模型给出的组件参数均无效，已用规则分析兜底' });
    return rule;
  }
  const kinds = new Set<ComponentKind>();
  for (const s of specs) kinds.add(s.kind);
  const notes: ComponentsNote[] = Array.isArray(raw.notes)
    ? raw.notes.filter((t) => typeof t === 'string').map((t) => ({ kind: 'thin-sample', text: t }))
    : rule.notes;
  return {
    specs,
    notes,
    sampleCount: typeof raw.sampleCount === 'number' ? raw.sampleCount : rule.sampleCount,
    kindCount: kinds.size,
  };
}

// ---------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------

export interface ParsedLlmSkill {
  /** 合入规则外壳后的完整导出；解析失败时为 null */
  exported: SampleExport | null;
  /** 模型写的人读 DESIGN.md；可能为空 */
  designMd: string | null;
  /** 逐通道回退与解析问题的通知 */
  issues: SemanticsIssue[];
}

/**
 * 解析模型返回文本。
 *
 * @param text 模型原始返回
 * @param rule 规则分析已经算好的导出，作为外壳与逐通道兜底基准
 */
export function parseLlmSkillOutput(text: string, rule: SampleExport): ParsedLlmSkill {
  const issues: SemanticsIssue[] = [];
  const jsonText = extractJson(text);

  if (!jsonText) {
    // 连 JSON 都抠不出来：如果还有 markdown 文档就退而求其次当 DESIGN.md 用，
    // 但结构化分析没有，整次提取算失败。
    const md = extractMarkdown(text);
    return {
      exported: null,
      designMd: md,
      issues: [{ field: 'parse', reason: '模型返回中未找到可解析的 JSON 分析块' }],
    };
  }

  let obj: { analysis?: LlmAnalysis } & Partial<LlmAnalysis>;
  try {
    obj = JSON.parse(jsonText) as typeof obj;
  } catch {
    const truncated =
      /```\s*json\b/i.test(text) && !/```\s*json[\s\S]*?```/i.test(text);
    return {
      exported: null,
      designMd: extractMarkdown(text),
      issues: [
        {
          field: 'parse',
          reason: truncated
            ? '模型返回的 JSON 被输出上限截断（不完整），请在设置里调大生成上限'
            : '模型返回的 JSON 分析块无法解析',
        },
      ],
    };
  }

  const analysis = obj.analysis ?? obj;
  // 既不是 { analysis: ... } 也不是直接铺开的五线对象时，obj 上没有五线键，
  // 各 coerce 会全部回退到规则，最终等于没提取——判为失败更诚实。
  const hasAnyKey =
    analysis.colors || analysis.typography || analysis.spacing || analysis.effects || analysis.components;
  if (!hasAnyKey) {
    return {
      exported: null,
      designMd: extractMarkdown(text),
      issues: [{ field: 'parse', reason: '模型返回的 JSON 不含任何分析字段' }],
    };
  }

  const merged = {
    ...rule,
    analysis: {
      colors: coerceColors(analysis.colors, rule.analysis.colors, issues),
      typography: coerceTypography(analysis.typography, rule.analysis.typography, issues),
      spacing: coerceSpacing(analysis.spacing, rule.analysis.spacing, issues),
      effects: coerceEffects(analysis.effects, rule.analysis.effects, issues),
      components: coerceComponents(analysis.components, rule.analysis.components, issues),
    },
  };

  // designMd：只从模型返回的 ```markdown 块里取，json 块不承载文档文本
  const md = extractMarkdown(text);

  return { exported: merged, designMd: md, issues };
}
