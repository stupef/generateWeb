/**
 * 发给大模型的那份「设计简报」。
 *
 * ── 简报里给什么，不给什么 ──
 *
 * 给：数值、统计、以及本地已经写好的用法文案。
 * 不给：原始观测。
 *
 * 原始观测是几百 KB 的元素级采样，对写文案这件事没有帮助，塞进去只会让
 * 提示词变长、变贵、变慢，还会把模型的注意力从结论上引开。简报是分析层的
 * 结论压缩成的一小段 JSON，几 KB 量级。
 *
 * 把本地已写好的用法文案一并给过去，是为了让「不要复述已有内容」这条要求
 * 有可执行的含义。不说清楚已经有什么，模型只会把同一件事换个说法再说一遍，
 * 读起来就成了重言。
 *
 * ── token 名从哪来 ──
 *
 * 全部走 design-md.ts 导出的命名函数，不在这个模块里另起一套。模型看到的
 * 名字必须和最终写进文件的键完全一致，否则它补的语义会挂在一个不存在的
 * 条目上。命名规则只能有一份，这个项目里已经因为两份判据分叉吃过亏。
 */
import { componentKey, designName, roundedTokens, spacingTokens, typographyTokens } from '../design-md';
import type { SampleExport } from '../export';
import type { KnownKeys } from '../semantics';

export interface BriefColor {
  token: string;
  hex: string;
  /** 本地给的中文角色名 */
  label: string;
  /** 证据摘要，一行 */
  evidence: string;
  /** 本地已经写好的用法说明。模型不得复述这一段 */
  recorded: string;
}

export interface BriefType {
  key: string;
  size: string;
  weight: string;
  lineHeight: string;
  role: string;
  /** 落在哪些标题级别上 */
  headings: string;
  recorded: string;
}

export interface BriefComponent {
  key: string;
  background: string;
  text: string;
  radius: string;
  padding: string;
  height: string;
  recorded: string;
}

export interface DesignBrief {
  page: {
    name: string;
    host: string;
    canvas: string;
    theme: string;
    viewport: string;
  };
  colors: BriefColor[];
  typography: BriefType[];
  spacing: { key: string; value: string }[];
  rounded: { key: string; value: string }[];
  components: BriefComponent[];
}

function pct(n: number): string {
  return `${(n * 100).toFixed(n < 0.01 ? 2 : 1)}%`;
}

/** 一个颜色角色在页面上的存在感，压成一行。模型据此判断它的分量 */
function colorEvidence(role: SampleExport['analysis']['colors']['roles'][number]): string {
  const e = role.evidence;
  const bits: string[] = [];
  if (e.textChars > 0) bits.push(`承载 ${pct(e.textShare)} 的文字`);
  if (e.backgroundCount > 0) bits.push(`作背景 ${e.backgroundCount} 处、覆盖 ${pct(e.backgroundShare)} 面积`);
  if (e.borderCount > 0) bits.push(`作边框 ${e.borderCount} 处`);
  if (e.controlCount > 0) bits.push(`出现在 ${e.controlCount} 个可点击控件上`);
  if (bits.length === 0) bits.push('仅少量出现');
  return bits.join('，');
}

export function buildDesignBrief(exported: SampleExport): DesignBrief {
  const { page, analysis, viewport } = exported;
  const { colors, typography, components } = analysis;

  const types = typographyTokens(typography.steps);

  const brief: DesignBrief = {
    page: {
      name: designName(exported),
      host: page.host,
      canvas: colors.canvasHex.toUpperCase(),
      theme: colors.isDark ? '深色' : '浅色',
      viewport: viewport ? `${viewport.width}px 宽` : '未记录',
    },
    colors: colors.roles.map((r) => ({
      token: r.token,
      hex: r.hex.toUpperCase(),
      label: r.label,
      evidence: colorEvidence(r),
      recorded: r.usage,
    })),
    typography: types.map((t) => ({
      key: t.key,
      size: `${t.step.size}px`,
      weight: t.step.weights.length > 0 ? String(t.step.weights[0]) : '未读出',
      lineHeight: t.step.lineHeightRatio !== null ? String(t.step.lineHeightRatio) : 'normal',
      role: t.step.label,
      headings: t.step.headingLevels.length > 0 ? t.step.headingLevels.map((n) => 'h' + n).join('/') : '',
      recorded: t.step.usage,
    })),
    spacing: spacingTokens(exported).map((t) => ({ key: t.key, value: t.value })),
    rounded: roundedTokens(exported).map((t) => ({ key: t.key, value: t.value })),
    components: components.specs.map((c) => ({
      key: componentKey(c),
      background: c.backgroundColor ?? '无填充',
      text: c.textColor ?? '未读出',
      radius: c.radius > 0 ? `${c.radius}px` : '无圆角',
      padding: `左右 ${c.paddingX}px / 上下 ${c.paddingY}px`,
      height: `${c.height}px`,
      recorded: c.usage,
    })),
  };

  return brief;
}

/**
 * 模型被允许提到哪些名字。
 *
 * 校验端拿它来拦「模型自己造 token」。和简报同源，都是从实际生成的命名里取的，
 * 所以模型只要照着简报里的名字写就一定能过。
 */
export function knownKeysOf(exported: SampleExport): KnownKeys {
  return {
    colors: exported.analysis.colors.roles.map((r) => r.token),
    components: exported.analysis.components.specs.map(componentKey),
  };
}

/** 简报的序列化形式。缩进两格，出问题时日志里也读得下去 */
export function briefToJson(brief: DesignBrief): string {
  return JSON.stringify(brief, null, 2);
}
