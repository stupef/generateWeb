/**
 * 一次提取结果的可落盘快照。
 *
 * 弹窗里那些结论关掉就没了，再打开要重新采集一遍。采集本身要几百毫秒到
 * 几秒，页面改版之后更是再也抓不回同一份。所以每提取一次就留一份数据，
 * 既能事后回看，也能在两次之间做对比。
 *
 * 存的是全量，既有一层层的分析结论，也有结论所依据的原始观测。只存结论
 * 的话，日后想验证某个判断对不对，或者改了分析逻辑想拿旧页面重跑一遍，
 * 会发现没有输入可用。原始观测保留全部字段，不裁剪，因为被裁掉的往往
 * 正是「事后才发现需要」的那部分。代价是文件大一些，普通页面在几百 KB
 * 量级，元素接近上限的大页面会到几 MB，这个量级下载还是顺手。
 *
 * 这个模块不碰 chrome API，只做纯数据组装，所以能在 Node 里直接测。
 * 下载动作留在 popup 里。
 */
import { describeCoverage, describeViewport } from './diagnose';
import type { ColorAnalysis } from './color';
import type { ComponentsAnalysis } from './components';
import type { EffectsAnalysis } from './effects';
import type { SpacingAnalysis } from './spacing';
import type { TypographyAnalysis } from './typography';
import type { PageSample } from './types';

/**
 * 快照的格式版本。
 *
 * 字段增删不改这个串，读的人按需取字段即可；只有含义变了、或者有了
 * 不兼容的重排才递增，那时读的人需要按版本号分流解析。
 */
export const EXPORT_SCHEMA = 'design-md-extractor/sample@1';

export interface ExportInput {
  sample: PageSample;
  colors: ColorAnalysis;
  typography: TypographyAnalysis;
  spacing: SpacingAnalysis;
  effects: EffectsAnalysis;
  components: ComponentsAnalysis;
  /** 插件版本，取自 manifest */
  extractorVersion: string;
  /**
   * 生成时刻。由调用方传进来而不是在这里取当前时间，
   * 这样同一份输入跑两次能得到逐字节相同的输出，便于比对。
   */
  generatedAt: Date;
}

/** 页面身份与本次采集的规模 */
export interface ExportPage {
  url: string;
  title: string;
  /** 仅主机名，文件名和横向对比按它分组 */
  host: string;
  viewportWidth: number;
  viewportHeight: number;
    /**
     * 页面底色，取自首屏绘制面积最大的表面，也就是肉眼看到的那个颜色。
     * 所有对比度与深浅判断都拿它当基准。
     */
    canvasColor: string | null;
    /**
     * 文档画布色，即 body 上合成出来的颜色。
     *
     * 与 canvasColor 不一致时说明首屏被别的色块盖住了，比如 body 声明白底
     * 而首屏被一个整屏深色区块盖成黑。这个值只用来解释差异，不要拿去算对比度。
     */
    documentCanvasColor?: string | null;
  prefersDark: boolean;
  textCharsTotal: number;
  /** 实际遍历到的元素数 */
  visited: number;
  /** 因为不可见或零面积被跳过的元素数 */
  skipped: number;
  /** 命中元素上限，为 true 时结果不完整 */
  truncated: boolean;
  elapsedMs: number;
}

/** 原始观测的规模，用来一眼判断这次采到了多少东西 */
export interface ExportStats {
  elements: number;
  typography: number;
  boxes: number;
  styles: number;
  webFontFamilies: number;
}

export interface ExportCoverage {
  severe: boolean;
  lines: string[];
}

/**
 * 本次采样的口径。
 *
 * 宽度和 page 里的 viewportWidth 是同一个数，重复一次是有意的：这一块的
 * 用途是让读文件的人单独拿走就能明白结论的适用边界，不必回头去 page 里
 * 找数再自己拼。代价是两处可能不同步，但两处都由 buildSampleExport 写，
 * 不存在各自演化的余地。
 *
 * lines 只讲口径的性质，不带具体数字，数字统一由 width 给出。同一件事
 * 写两遍早晚会分叉，而分叉在这里的表现是「说明里说 1440、字段里是 640」，
 * 极难一眼看出来。
 */
export interface ExportViewport {
  /** 采样时的视口宽度，px */
  width: number;
  /** 口径说明。会逐字写进生成的文件 */
  lines: string[];
}

/** 五条分析线的结论，逐字保留，与弹窗里显示的完全一致 */
export interface ExportAnalysis {
  colors: ColorAnalysis;
  typography: TypographyAnalysis;
  spacing: SpacingAnalysis;
  effects: EffectsAnalysis;
  components: ComponentsAnalysis;
}

/** 结论所依据的原始观测，四条通道加背景与结构摘要 */
export interface ExportRaw {
  elements: PageSample['elements'];
  typography: PageSample['typography'];
  boxes: PageSample['boxes'];
  styles: PageSample['styles'];
  webFontFamilies: string[];
  background: PageSample['background'];
  embedded: PageSample['embedded'];
}

export interface SampleExport {
  schema: string;
  generatedAt: string;
  extractor: { name: string; version: string };
  page: ExportPage;
  /** 色板覆盖范围说明。全都在可读范围内时为 null */
  coverage: ExportCoverage | null;
  /** 采样口径说明。宽度读不到时为 null */
  viewport: ExportViewport | null;
  stats: ExportStats;
  analysis: ExportAnalysis;
  raw: ExportRaw;
}

/**
 * 取主机名。
 *
 * 传入的值来自页面，可能是一个非法地址，此时原样返回。宁可文件名里
 * 出现一串怪字符，也不要因为解析失败把整次导出打断。
 */
export function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/**
 * 把提取结果组装成快照。
 *
 * 覆盖范围说明在这里重新算一次，而不是由调用方传进来。它有明确的
 * 输入（板块摘要、色板规模、文字量），算出来的结果和界面上显示的
 * 必然一致，多传一个参数的收益抵不上两处可能不同步的风险。
 */
export function buildSampleExport(input: ExportInput): SampleExport {
  const {
    sample,
    colors,
    typography,
    spacing,
    effects,
    components,
    extractorVersion,
    generatedAt,
  } = input;

  const coverage = describeCoverage(
    sample.embedded,
    colors.roles.length,
    sample.textCharsTotal,
  );
  const viewport = describeViewport(sample.viewportWidth);

  return {
    schema: EXPORT_SCHEMA,
    generatedAt: generatedAt.toISOString(),
    extractor: { name: 'design-md-extractor', version: extractorVersion },
    page: {
      url: sample.url,
      title: sample.title,
      host: hostOf(sample.url),
      viewportWidth: sample.viewportWidth,
      viewportHeight: sample.viewportHeight,
        canvasColor: sample.canvasColor,
        documentCanvasColor: sample.documentCanvasColor ?? null,
        prefersDark: sample.prefersDark,
      textCharsTotal: sample.textCharsTotal,
      visited: sample.visited,
      skipped: sample.skipped,
      truncated: sample.truncated,
      elapsedMs: sample.elapsedMs,
    },
    coverage: coverage ? { severe: coverage.severe, lines: [...coverage.lines] } : null,
    viewport: viewport ? { width: viewport.width, lines: [...viewport.lines] } : null,
    stats: {
      elements: sample.elements.length,
      typography: sample.typography.length,
      boxes: sample.boxes.length,
      styles: sample.styles.length,
      webFontFamilies: sample.webFontFamilies.length,
    },
    analysis: { colors, typography, spacing, effects, components },
    raw: {
      elements: sample.elements,
      typography: sample.typography,
      boxes: sample.boxes,
      styles: sample.styles,
      webFontFamilies: sample.webFontFamilies,
      background: sample.background,
      embedded: sample.embedded,
    },
  };
}

/** 缩进两格，方便直接打开读，也方便 diff */
export function serializeExport(exported: SampleExport): string {
  return JSON.stringify(exported, null, 2) + '\n';
}

/**
 * 把主机名收拾成能进文件名的样子。
 *
 * 端口去掉，因为同一台主机不同端口多半是同一套设计的不同环境，留在
 * 文件名里只会让同一组的文件散开。其余非字母数字的点划一律折成连字符，
 * 顺带避开 Windows 上不允许出现在文件名里的那些符号。全被折没了就退回
 * 一个固定词，保证扩展名前面总有东西。
 */
export function filenameHost(host: string): string {
  const cleaned = host
    .toLowerCase()
    .replace(/:\d+$/, '')
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+/, '')
    .replace(/[-.]+$/, '');
  return cleaned.length > 0 ? cleaned : 'page';
}

/**
 * 文件名。
 *
 * 用主机名加时间戳，不用页面标题。标题里什么都可能有，换行、斜杠、
 * 两百个字，清理规则怎么写都会漏掉一种；而主机名加时间戳既短又唯一，
 * 同一站点多次导出的顺序在文件名上直接排好。按本地时间写，因为看文件
 * 名的是人，不是程序。
 */
export function exportFileName(exported: SampleExport): string {
  const d = new Date(exported.generatedAt);
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp =
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `design-md-${filenameHost(exported.page.host)}-${stamp}.json`;
}
