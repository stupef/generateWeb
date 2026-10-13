/**
 * 导出快照的回归检查，用合成数据跑，不需要浏览器。
 *
 * 运行：npm run check:export
 *
 * 这一块守的是「按了导出，拿到的文件里有什么」。它有三条容易在改动里
 * 悄悄丢掉的保证。
 *
 * 第一条，原始观测必须全量带出去。导出模块容易写着写着就变成只挑几个
 * 「看起来有用」的字段，那种裁剪在文件小的时候不会有人发现，等需要拿
 * 旧数据重跑分析时才暴露，而那时候页面早就变了。
 *
 * 第二条，界面上显示的结论和文件里写的必须是同一份。覆盖范围的说明文字
 * 尤其容易分叉，因为它在界面上渲染一次、在文件里再写一次，两处逻辑
 * 各写各的就会说不一样的话。
 *
 * 第三条，采样口径必须跟数值一起出去。文件里只有数字没有口径，读的人
 * 就会把一份 1440 宽下的结论当成站点的设计原值。
 *
 * 除此之外还锁住文件名。文件名出错的代价比想象中大：非法字符会让下载
 * 直接失败，端口留在名字里会把同一套设计的不同环境拆成两组。
 */
import { analyzeColors } from '../src/core/color';
import { analyzeComponents } from '../src/core/components';
import { analyzeEffects } from '../src/core/effects';
import {
  EXPORT_SCHEMA,
  buildSampleExport,
  exportFileName,
  filenameHost,
  hostOf,
  serializeExport,
  type SampleExport,
} from '../src/core/export';
import { analyzeSpacing } from '../src/core/spacing';
import { analyzeTypography } from '../src/core/typography';
import type {
  BackgroundSummary,
  BoxObservation,
  ElementObservation,
  EmbeddedContentSummary,
  PageSample,
  StyleObservation,
  TypeObservation,
} from '../src/core/types';

/**
 * 局部声明退出码用的 Node 全局，理由同 color-check.ts，不引入 @types/node。
 */
declare const process: { exit(code?: number): void };

const report: string[] = [];
let failed = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failed++;
  report.push(`${ok ? '✓' : '✗'} ${name}${!ok && detail ? `　→ 实际 ${detail}` : ''}`);
}

/** 两边都是可序列化的普通数据，直接比字符串最省事，失败时也看得清 */
function eq(name: string, actual: unknown, expected: unknown): void {
  const a = typeof actual === 'string' ? actual : JSON.stringify(actual);
  const e = typeof expected === 'string' ? expected : JSON.stringify(expected);
  check(name, a === e, `${a}（期望 ${e}）`);
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

/** 页面主体在一个跨域框架里，顶层几乎没内容 */
const shellStructure: EmbeddedContentSummary = {
  contentType: 'text/html',
  pdfEmbeds: 0,
  largeFrames: 1,
  largestFrameRatio: 0.88,
  framesetDocument: false,
  sameOriginFrames: 0,
  blockedFrames: 1,
};

/*
 * 下面几条观测的 ref 刻意按「同一个元素在不同通道里用同一个编号」来写：
 * 按钮在 elements 和 styles 里都是 0，正文段落在 elements 和 typography
 * 里都是 1。真实采集就是这个关系，对齐之后这些用例才和线上形状一致。
 */

const elButton: ElementObservation = {
  ref: 0,
  tag: 'BUTTON',
  textChars: 4,
  fontSize: 15,
  area: 19800,
  isControl: true,
  definesSurface: true,
  textColor: '#ffffff',
  backgroundColor: '#3d5afe',
  borderColor: null,
  borderWidth: 0,
};

const elParagraph: ElementObservation = {
  ref: 1,
  tag: 'P',
  textChars: 82,
  fontSize: 16,
  area: 96000,
  isControl: false,
  definesSurface: false,
  textColor: '#1f1f1c',
  backgroundColor: null,
  borderColor: null,
  borderWidth: 0,
};

const tyParagraph: TypeObservation = {
  ref: 1,
  tag: 'P',
  headingLevel: 0,
  fontFamily: 'Inter, sans-serif',
  fontWeight: 400,
  fontSize: 16,
  lineHeight: 26,
  letterSpacing: null,
  textChars: 82,
  isControl: false,
};

const bxCard: BoxObservation = {
  ref: 2,
  tag: 'DIV',
  padding: [24, 24, 24, 24],
  margin: [0, 0, 0, 0],
  gap: null,
  radius: 12,
  width: 720,
  maxWidth: 1200,
  looksLikeCard: true,
  isControl: false,
  isLandmark: false,
  layout: 'block',
};

const stButton: StyleObservation = {
  ref: 0,
  tag: 'BUTTON',
  kind: 'button',
  inNav: false,
  textChars: 4,
  childCount: 0,
  fillsParent: false,
  backgroundColor: '#3d5afe',
  textColor: '#ffffff',
  padding: [10, 16, 10, 16],
  radius: 8,
  borderWidth: 0,
  borderSides: 0,
  borderStyle: '',
  borderColor: null,
  shadow: null,
  width: 96,
  height: 40,
  fontSize: 15,
  fontWeight: 600,
  fontFamily: 'Inter, sans-serif',
};

function sampleA(): PageSample {
  return {
    url: 'https://shop.example.com/products/1?ref=nav',
    title: '合成商店首页',
    viewportWidth: 1440,
    viewportHeight: 900,
    canvasColor: '#ffffff',
    prefersDark: false,
    elements: [elButton, elParagraph],
    typography: [tyParagraph],
    boxes: [bxCard],
    styles: [stButton],
    webFontFamilies: ['Inter'],
    background: noBackground,
    embedded: plainStructure,
    textCharsTotal: 1200,
    skipped: 37,
    visited: 512,
    truncated: false,
    elapsedMs: 214,
  };
}

/** 生成时刻固定在一个已知时刻，文件名断言才不依赖跑测试的时间 */
const FIXED_TIME = new Date(2026, 9, 12, 22, 54, 38);

function exportOf(sample: PageSample, at: Date = FIXED_TIME) {
  return buildSampleExport({
    sample,
    colors: analyzeColors(sample),
    typography: analyzeTypography(sample),
    spacing: analyzeSpacing(sample),
    effects: analyzeEffects(sample),
    components: analyzeComponents(sample),
    extractorVersion: '0.1.0',
    generatedAt: at,
  });
}

const base = sampleA();
const exported = exportOf(base);

// ---------------------------------------------------------------------
// 一、顶层结构
// ---------------------------------------------------------------------

check('schema 取项目约定值', exported.schema === EXPORT_SCHEMA);
check('schema 带版本后缀', /@\d+$/.test(exported.schema), exported.schema);
eq('extractor 名称固定', exported.extractor.name, 'design-md-extractor');
eq('extractor 版本取自入参', exported.extractor.version, '0.1.0');
eq(
  '顶层分区齐全',
  Object.keys(exported).sort().join(','),
  'analysis,coverage,extractor,generatedAt,page,raw,schema,stats,viewport',
);

const parsedTime = new Date(exported.generatedAt);
check(
  '生成时间是合法 ISO',
  !Number.isNaN(parsedTime.getTime()) && exported.generatedAt.includes('T'),
  exported.generatedAt,
);
eq('生成时间往返不丢精度', parsedTime.getTime(), FIXED_TIME.getTime());

// ---------------------------------------------------------------------
// 二、页面身份
// ---------------------------------------------------------------------

eq('网址原样带出', exported.page.url, base.url);
eq('标题原样带出', exported.page.title, base.title);
eq('主机名不带路径与查询', exported.page.host, 'shop.example.com');
eq('视口宽度带出', exported.page.viewportWidth, 1440);
eq('视口高度带出', exported.page.viewportHeight, 900);
eq('底色带出', exported.page.canvasColor, '#ffffff');
eq('深色偏好带出', exported.page.prefersDark, false);
eq('直接文字量带出', exported.page.textCharsTotal, 1200);
eq('遍历元素数带出', exported.page.visited, 512);
eq('跳过元素数带出', exported.page.skipped, 37);
eq('截断标记带出', exported.page.truncated, false);
eq('采集耗时带出', exported.page.elapsedMs, 214);

// 地址解析失败时不能把整次导出打断，宁可原样带出去
eq('端口保留在主机名里', hostOf('https://localhost:8080/a'), 'localhost:8080');
eq('非法地址原样返回', hostOf('not a url'), 'not a url');
// 本地文件地址能解析但没有主机名，这时退回整串，文件名里至少还有东西可认
eq('无主机名的地址退回整串', hostOf('file:///Users/dqh/a.html'), 'file:///Users/dqh/a.html');

// ---------------------------------------------------------------------
// 三、原始观测全量带出
// ---------------------------------------------------------------------

eq('元素观测条数一致', exported.stats.elements, base.elements.length);
eq('排版观测条数一致', exported.stats.typography, base.typography.length);
eq('间距观测条数一致', exported.stats.boxes, base.boxes.length);
eq('样式观测条数一致', exported.stats.styles, base.styles.length);
eq('自定义字体条数一致', exported.stats.webFontFamilies, base.webFontFamilies.length);

eq('raw 元素条数一致', exported.raw.elements.length, 2);
eq('raw 排版条数一致', exported.raw.typography.length, 1);
eq('raw 间距条数一致', exported.raw.boxes.length, 1);
eq('raw 样式条数一致', exported.raw.styles.length, 1);
eq('自定义字体带出', exported.raw.webFontFamilies, ['Inter']);
check('背景摘要带出', exported.raw.background === base.background);
check('结构摘要带出', exported.raw.embedded === base.embedded);

// 大样本可能有几 MB，透传引用省掉一次深拷贝。这条同时锁住了
// 「原始观测是按引用给的」，将来谁改成复制一份，这里会红。
check('原始观测透传引用不做深拷贝', exported.raw.elements === base.elements);

// 字段一个不少。挑字段的写法在这里会立刻暴露
eq(
  '元素观测字段未被裁剪',
  Object.keys(exported.raw.elements[0] ?? {}).sort().join(','),
  'area,backgroundColor,borderColor,borderWidth,definesSurface,fontSize,isControl,ref,tag,textChars,textColor',
);
eq(
  '间距观测字段未被裁剪',
  Object.keys(exported.raw.boxes[0] ?? {}).sort().join(','),
  'gap,isControl,isLandmark,layout,looksLikeCard,margin,maxWidth,padding,radius,ref,tag,width',
);
eq(
  '样式观测字段未被裁剪',
  Object.keys(exported.raw.styles[0] ?? {}).sort().join(','),
  [
    'backgroundColor',
    'borderColor',
    'borderSides',
    'borderStyle',
    'borderWidth',
    'childCount',
    'fillsParent',
    'fontFamily',
    'fontSize',
    'fontWeight',
    'height',
    'inNav',
    'kind',
    'padding',
    'radius',
    'ref',
    'shadow',
    'tag',
    'textChars',
    'textColor',
    'width',
  ].join(','),
);

// ---------------------------------------------------------------------
// 四、分析结论
// ---------------------------------------------------------------------

eq(
  '五条分析线齐全',
  Object.keys(exported.analysis).sort().join(','),
  'colors,components,effects,spacing,typography',
);
eq('颜色结论与界面同源', exported.analysis.colors.roles.length, analyzeColors(base).roles.length);
eq('排版结论与界面同源', exported.analysis.typography.steps.length, analyzeTypography(base).steps.length);
eq('间距结论与界面同源', exported.analysis.spacing.steps.length, analyzeSpacing(base).steps.length);
eq('效果结论与界面同源', exported.analysis.effects.borders.length, analyzeEffects(base).borders.length);
eq(
  '组件结论与界面同源',
  exported.analysis.components.specs.length,
  analyzeComponents(base).specs.length,
);

// ---------------------------------------------------------------------
// 五、覆盖范围
// ---------------------------------------------------------------------

check('覆盖正常时不给说明', exported.coverage === null, JSON.stringify(exported.coverage));

const shell = exportOf({ ...sampleA(), embedded: shellStructure, textCharsTotal: 0, elements: [elButton] });
check('主体在框架里时给出说明', shell.coverage !== null);
check('主体在框架里时判定为严重', shell.coverage?.severe === true);
check('说明至少有一句话', (shell.coverage?.lines.length ?? 0) >= 2, String(shell.coverage?.lines.length));
check(
  '说明里点出框架区域',
  (shell.coverage?.lines ?? []).some((l) => l.includes('框架')),
);

// 字段为 null 和被省略是两件事，读数据的人要靠它区分「没提示」和「没这个字段」
const shellJson = JSON.parse(serializeExport(exported));
check('无提示时 coverage 字段仍在且为 null', 'coverage' in shellJson && shellJson.coverage === null);

// ---------------------------------------------------------------------
// 六、采样口径
// ---------------------------------------------------------------------
//
// 全部数值都是某个宽度下的渲染计算值，这个前提必须随文件一起走。少了它，
// 读文件的人会把一份 1440 宽下的结论当成站点的设计原值，照着复刻整片偏掉。

check('视口可用时给出采样口径', exported.viewport !== null);
eq('口径里的宽度与页面同源', exported.viewport?.width, exported.page.viewportWidth);
check(
  '口径说明点出数值是渲染计算值',
  (exported.viewport?.lines ?? []).some((l) => l.includes('计算值')),
);
check(
  '口径说明点出换宽度会变',
  (exported.viewport?.lines ?? []).some((l) => l.includes('别的窗口宽度')),
);
// 宽度数字只由 width 给，说明里不再重复一遍。两处都写早晚会分叉，
// 而分叉在这里的表现是「说明里说 1440、字段里是 640」，几乎看不出来。
check(
  '口径说明里不重复宽度数字',
  (exported.viewport?.lines ?? []).every((l) => !l.includes(String(exported.viewport?.width))),
);

// 宽度读不到时宁可不声明，也不要凑一个默认值，那等于给出一份
// 看起来可复现、实际不对的口径
const noViewport = exportOf({ ...sampleA(), viewportWidth: 0 });
check('宽度不可用时不给口径', noViewport.viewport === null);
check('无口径时字段仍在且为 null', 'viewport' in JSON.parse(serializeExport(noViewport)));

// ---------------------------------------------------------------------
// 七、序列化
// ---------------------------------------------------------------------

let text = '';
try {
  text = serializeExport(exported);
  check('可序列化成 JSON', true);
} catch (err) {
  check('可序列化成 JSON', false, String(err));
}

check('缩进两格', text.includes('\n  "schema"'), text.slice(0, 40));
check('末尾留换行', text.endsWith('}\n'));

let roundTrip: SampleExport | null = null;
try {
  roundTrip = JSON.parse(text) as SampleExport;
} catch {
  roundTrip = null;
}
eq('往返后内容不变', roundTrip, exported);
eq('往返后原始观测条数不变', roundTrip?.raw.elements.length, 2);

check('同一输入两次导出逐字节相同', serializeExport(exported) === serializeExport(exportOf(sampleA())));

// ---------------------------------------------------------------------
// 八、文件名
// ---------------------------------------------------------------------

eq('文件名格式', exportFileName(exported), 'design-md-shop.example.com-20261012-225438.json');
check('文件名以 design-md- 开头', exportFileName(exported).startsWith('design-md-'));
check('文件名以 .json 结尾', exportFileName(exported).endsWith('.json'));
check('文件名不含路径分隔符', !/[/\\]/.test(exportFileName(exported)));

eq('端口从文件名里去掉', filenameHost('localhost:8080'), 'localhost');
eq('大小写归一', filenameHost('SHOP.Example.COM'), 'shop.example.com');
eq('非法字符折成连字符', filenameHost('not a url'), 'not-a-url');
eq('协议头折成连字符', filenameHost('chrome://newtab/'), 'chrome-newtab');
eq('空主机名退回固定词', filenameHost(''), 'page');
eq('全是符号也退回固定词', filenameHost(':::'), 'page');

// 同一站点不同时刻导两次，文件名必须能分开，否则第二次会覆盖第一次
const later = exportOf(sampleA(), new Date(2026, 9, 12, 23, 5, 1));
check('不同时刻文件名不同', exportFileName(later) !== exportFileName(exported));
eq('时间戳按本地时间写', exportFileName(later), 'design-md-shop.example.com-20261012-230501.json');

// 下载用的是这个字符串，文件名的合法性和序列化结果一起构成了「能不能落盘」
const fullName = exportFileName(exported);
check(
  '文件名里没有 Windows 禁用字符',
  !/[<>:"/\\|?*\x00-\x1f]/.test(fullName.replace('design-md-', '').replace('.json', '')),
  fullName,
);

// =====================================================================
// 收尾
// =====================================================================

console.log('='.repeat(64));
console.log('断言结果');
console.log('='.repeat(64));
for (const line of report) console.log(line);
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项未通过`);

process.exit(failed === 0 ? 0 : 1);
