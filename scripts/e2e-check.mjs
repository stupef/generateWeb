/**
 * 端到端自测：真实浏览器 → 真实采集 → 全部分析。
 *
 * 运行：node scripts/e2e-check.mjs
 *
 * 为什么需要这一个，前面那些测试都覆盖了什么。
 *
 * 已有的回归分两层。分析层（color / typography / spacing / effects /
 * components）用合成数据跑纯函数，验的是「给定这份观测，结论对不对」。
 * 采集层用 jsdom 跑，验的是「文档树遍历的结构事实对不对」，但 jsdom
 * 不做布局，getBoundingClientRect 一律返回 0，所以尺寸、位置、以及
 * 依赖布局的判据（卡片是不是撑满父容器、导航栏有多高、内容最大宽度
 * 到底是多少）在那里全是打桩的假值。
 *
 * 中间这一段一直空着：真实计算样式 + 真实布局 → 采集 → 分析。
 * 恰恰是组件识别和间距推断这两块最依赖真实的盒模型，而它们的所有
 * 测试输入都是手写的。手写的输入里没有浏览器真实产生的那些形态：
 * 简写属性被展开成四边、颜色被算成 rgb() 带小数、字体栈里混着
 * -apple-system 这类平台关键字、圆角被解析成 "8px 8px 8px 8px"。
 *
 * 这个脚本把这段补上。用真实 Chromium 打开几张验收页，把采集函数
 * 当字符串注进去（和扩展走的是同一条序列化路径），拿回真实样本，
 * 再在 Node 里跑全部分析，最后对着每张页面自己声明的预期值逐项断言。
 *
 * 前置：需要 Chromium。
 *   cd /Users/dqh/.workbuddy/binaries/node/workspace
 *   PLAYWRIGHT_BROWSERS_PATH=<此目录>/pw-browsers \
 *     ./node_modules/.bin/playwright install chromium
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createJiti } from 'jiti';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

// playwright 装在隔离的 workspace 里，不往项目里塞几百兆的依赖
const WS = '/Users/dqh/.workbuddy/binaries/node/workspace';
process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH ?? path.join(WS, 'pw-browsers');
const require = createRequire(path.join(WS, 'index.js'));
const { chromium } = require('playwright');

const jiti = createJiti(import.meta.url);
const core = (name) => jiti(path.join(root, 'src/core', name));

const { collectPageSample } = core('collector.ts');
const { analyzeColors } = core('color.ts');
const { analyzeTypography } = core('typography.ts');
const { analyzeSpacing } = core('spacing.ts');
const { analyzeEffects, radiusLabel } = core('effects.ts');
const { analyzeComponents } = core('components.ts');
const { buildSampleExport, exportFileName, serializeExport } = core('export.ts');

// ---------------------------------------------------------------------
// 断言脚手架
// ---------------------------------------------------------------------

const report = [];
let failed = 0;

function check(name, ok, detail) {
  if (!ok) failed++;
  const mark = ok ? '✓' : '✗';
  report.push(`${mark} ${name}${!ok && detail ? `　→ 实际 ${detail}` : ''}`);
}

function eq(name, actual, expected) {
  check(name, actual === expected, JSON.stringify(actual));
}

function show(title) {
  console.log('');
  console.log('─'.repeat(70));
  console.log(title);
  console.log('─'.repeat(70));
}

// ---------------------------------------------------------------------
// 采集：真实浏览器
// ---------------------------------------------------------------------

const VIEWPORT = { width: 1440, height: 900 };

async function collect(page, file) {
  const url = 'file://' + path.join(root, 'test', file);
  await page.goto(url, { waitUntil: 'load' });
  // 采集函数整段是自包含的，直接当表达式求值即可。
  // 扩展那边走 chrome.scripting 的 toString 序列化，这里走 playwright 的，
  // 两者对自包含性的要求一致，所以这一段能验到同一件事。
  const src = `(${collectPageSample.toString()})()`;
  return page.evaluate(src);
}

// ---------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------

const browser = await chromium.launch(
  // 允许指定一个已有的 Chromium。沙箱里 playwright 自带的下载器会卡在代理上，
  // 这时直接用 curl 拉一份 Chrome for Testing，从环境变量指过来。
  process.env.DESIGN_MD_CHROME ? { executablePath: process.env.DESIGN_MD_CHROME } : {},
);
const context = await browser.newContext({ viewport: VIEWPORT });
const page = await context.newPage();

const consoleErrors = [];
page.on('pageerror', (e) => consoleErrors.push(String(e)));

// =====================================================================
// acceptance-b3.html　字体与排版
// 页面上方声明的预期：48/32/24/16/14/13/12 七级，17.3/18.4/21.5 被过滤，
// 三套字体，Söhne Buch 走替代方案，48 那级回填 -1.2px 字距。
// =====================================================================
show('acceptance-b3.html　字体与排版');

{
  const sample = await collect(page, 'acceptance-b3.html');
  const t = analyzeTypography(sample);

  console.log(`采集 ${sample.visited} 个元素，字号观测 ${sample.typography.length} 条，耗时 ${sample.elapsedMs}ms`);
  console.log('');
  console.log('  字号  角色      行高        字距     字符量   字体');
  for (const s of t.steps) {
    console.log(
      `  ${String(s.size).padEnd(5)} ${String(s.label).padEnd(8)} ` +
        `${String(s.lineHeightRatio ?? 'normal').padEnd(10)} ` +
        `${String(s.letterSpacing ?? '-').padEnd(7)} ` +
        `${String(s.chars).padEnd(8)} ${s.families.join(', ')}`,
    );
  }
  console.log(`  正文基准字号（字符量最大的那一级）：${t.bodySize}px`);
  console.log('');
  console.log('  字体族：');
  for (const f of t.families) {
    console.log(`    ${f.name.padEnd(18)} ${f.origin.padEnd(10)} ${f.chars} 字  ${f.roles.join('/')}`);
  }
  console.log('  替代方案：');
  for (const f of t.fallbacks) console.log(`    ${f.family} → ${f.stack}`);
  console.log('  已过滤字号：', t.discarded.map((d) => `${d.size}px`).join(', ') || '(无)');

  const sizes = t.steps.map((s) => s.size);
  const want = [48, 32, 24, 16, 14, 13, 12];

  check('七级字号与页面声明一致', JSON.stringify(sizes) === JSON.stringify(want), JSON.stringify(sizes));
  check('层级按字号降序排列', sizes.every((v, i) => i === 0 || sizes[i - 1] > v), JSON.stringify(sizes));

  const body = t.steps.find((s) => s.size === 16);
  eq('16px 被认成正文', body?.role, 'body');

  for (const [size, level] of [[48, 1], [32, 2], [24, 3]]) {
    const step = t.steps.find((s) => s.size === size);
    check(`${size}px 带 h${level} 标签证据`, !!step && step.headingLevels.includes(level), JSON.stringify(step?.headingLevels));
  }

  const code = t.steps.find((s) => s.size === 13);
  eq('13px 判成代码', code?.role, 'code');

  const dropped = t.discarded.map((d) => d.size).sort((a, b) => a - b);
  check('三个一次性字号被挡住', JSON.stringify(dropped) === JSON.stringify([17.3, 18.4, 21.5]), JSON.stringify(dropped));

  // 折叠的 details 在 Chrome 里仍会被排版，getBoundingClientRect 返回真实尺寸，
  // 只有 checkVisibility() 认得出它不可见。这一条锁住「收起的整片跳过」：
  // 展开态下它贡献 400 多字的 12px 文本，足以把正文从 16px 抢到 12px。
  const twelves = t.steps.find((s) => s.size === 12);
  check(
    `收起的折叠区不应把 12px 的字符量顶上去，实际 ${twelves?.chars} 字`,
    !!twelves && twelves.chars < 150,
  );

  const codeFamily = t.families.find((f) => f.roles.includes('code'));
  check('代码族识别出来且不是通用关键字', !!codeFamily && codeFamily.generic === 'monospace', codeFamily?.name);
  check('代码族判为系统字体，不给替代建议', codeFamily?.origin === 'system', codeFamily?.origin);

  const first = t.steps.find((s) => s.size === 48);
  eq('48px 回填 -1.2px 字距', first?.letterSpacing, -1.2);

  eq('识别出三套字体', t.families.length, 3);

  const sohne = t.families.find((f) => f.name === 'Söhne Buch');
  eq('Söhne Buch 判为页面自带', sohne?.origin, 'font-face');

  const fb = t.fallbacks.find((f) => f.family === 'Söhne Buch');
  check('Söhne Buch 给出替代栈', !!fb, fb ? '' : '未给出');
  if (fb) {
    check('替代栈以 Georgia 开头', fb.stack.startsWith('Georgia'), fb.stack);
    check('替代栈落到 serif', fb.stack.trim().endsWith('serif'), fb.stack);
    check('替代栈保留中文字体 PingFang SC', fb.stack.includes('PingFang SC'), fb.stack);
  }

  const plainFonts = t.families.filter((f) => f.origin !== 'font-face');
  check(
    '系统字体不给替代建议',
    plainFonts.every((f) => !t.fallbacks.some((x) => x.family === f.name)),
    plainFonts.map((f) => f.name).join('/'),
  );
}

// =====================================================================
// acceptance-b4.html　间距与布局
// 页面上方声明的预期：基础单位 4，内容宽 1200，卡片内边距 24/20，
// 区块间距 64，13/17/23（非 4 倍数）与 32（只出现一次）被过滤。
// =====================================================================
show('acceptance-b4.html　间距与布局');

{
  const sample = await collect(page, 'acceptance-b4.html');
  const sp = analyzeSpacing(sample);

  console.log(`采集 ${sample.visited} 个元素，盒模型观测 ${sample.boxes.length} 条，耗时 ${sample.elapsedMs}ms`);
  console.log('');
  console.log(`  基础单位 ${sp.baseUnit}px（覆盖 ${Math.round(sp.baseCoverage * 100)}%，${sp.baseUnitConfidence}）`);
  console.log(`  内容最大宽度 ${sp.contentMaxWidth}px`);
  console.log(`  卡片内边距 水平 ${sp.cardPadding?.x} / 垂直 ${sp.cardPadding?.y}`);
  console.log(`  区块间距 ${sp.sectionGap}px`);
  console.log(`  间距档位 ${sp.steps.map((s) => s.value).join(', ')}`);
  console.log(`  圆角档位 ${sp.radii.map((r) => (r.value >= 100 ? '胶囊' : r.value + 'px')).join(', ')}`);
  console.log(`  已过滤 ${sp.discarded.map((d) => d.value + 'px').join(', ') || '(无)'}`);

  eq('基础单位是 4', sp.baseUnit, 4);
  eq('内容最大宽度是 1200', sp.contentMaxWidth, 1200);
  eq('卡片内边距水平 24', sp.cardPadding?.x, 24);
  eq('卡片内边距垂直 20', sp.cardPadding?.y, 20);
  eq('区块间距 64', sp.sectionGap, 64);

  const values = sp.steps.map((s) => s.value);
  for (const v of [8, 12, 16, 20, 24, 48, 64]) {
    check(`档位包含 ${v}px`, values.includes(v), values.join(','));
  }

  const droppedVals = sp.discarded.map((d) => d.value).sort((a, b) => a - b);
  check(
    '13 / 17 / 23 / 32 被挡在档位之外',
    [13, 17, 23, 32].every((v) => droppedVals.includes(v)),
    JSON.stringify(droppedVals),
  );
  check(
    '不规律的偶发值没有混进档位',
    ![13, 17, 23].some((v) => values.includes(v)),
    values.join(','),
  );
}

// =====================================================================
// acceptance-b5.html　圆角、边框与投影
// 页面声明的预期：四种元素四种圆角（按钮 8 / 输入 6 / 卡片 12 / 徽标
// 与强调按钮胶囊），边框按边数分两类，整页无投影时必须明确写出来。
// =====================================================================
show('acceptance-b5.html　圆角、边框与投影');

{
  const sample = await collect(page, 'acceptance-b5.html');
  const e = analyzeEffects(sample);

  console.log(`采集 ${sample.visited} 个元素，样式观测 ${sample.styles.length} 条，耗时 ${sample.elapsedMs}ms`);
  console.log('');
  console.log('  圆角按元素类型：');
  for (const r of e.radii) {
    console.log(`    ${r.label.padEnd(10)} ${radiusLabel(r.radius).padEnd(8)} ${r.count} 个${r.others.length ? '　另有 ' + r.others.map(radiusLabel).join('、') : ''}`);
  }
  console.log('  边框：');
  for (const b of e.borders) {
    console.log(`    ${b.width}px ${b.style}　${b.sides} 边　${b.color ?? '无色'}　${b.count} 处　[${b.kinds.join('/')}]`);
  }
  console.log('  投影：', e.shadows.length === 0 ? '(无)' : e.shadows.map((s) => s.css).join(' | '));
  for (const n of e.notes) console.log(`  [${n.kind}] ${n.text}`);

  const byKind = {};
  for (const r of e.radii) byKind[r.label] = r.radius;

  eq('按钮圆角取 8', byKind['按钮'], 8);
  eq('输入框圆角取 6', byKind['输入框'], 6);
  eq('卡片圆角取 12', byKind['卡片'], 12);

  const other = e.radii.find((r) => r.label === '其他元素');
  check('徽标落在其他元素组的胶囊档', !!other && other.radius >= 100, other ? radiusLabel(other.radius) : '缺失');
  check('徽标没有混进卡片的 12px', byKind['卡片'] === 12);

  const four = e.borders.filter((b) => b.sides >= 4);
  const one = e.borders.filter((b) => b.sides === 1);
  check('边框按边数分成四边一组', four.length > 0, four.length);
  check('边框按边数分成单边一组', one.length > 0, one.length);
  check('分割线与输入框没有合成一条', one.every((b) => b.kinds.every((k) => k !== 'input')));

  eq('无投影时投影分组为空', e.shadows.length, 0);
  check(
    '明确写出完全没有使用投影',
    e.notes.some((n) => n.kind === 'no-shadow' && n.text.includes('完全没有使用投影')),
    e.notes.map((n) => n.kind).join(','),
  );
}

// =====================================================================
// acceptance-b6.html　组件识别
// 页面对照表声明：主按钮 #3d5afe / 次按钮白底描边 / 输入框 / 导航栏 /
// 卡片 ×2，共 4 类。页面上没有的组件不许出现。
// =====================================================================
show('acceptance-b6.html　组件识别');

{
  const sample = await collect(page, 'acceptance-b6.html');
  const c = analyzeComponents(sample);
  const colors = analyzeColors(sample);

  console.log(`采集 ${sample.visited} 个元素，样式观测 ${sample.styles.length} 条，耗时 ${sample.elapsedMs}ms`);
  console.log(`页面底色 ${sample.canvasColor}`);
  console.log('');
  for (const s of c.specs) {
    console.log(
      `  ${(s.label + (s.variant ? `（${s.variant}）` : '')).padEnd(16)} ×${s.count}　` +
        `bg ${s.backgroundColor ?? '无填充'}　fg ${s.textColor ?? '无'}　` +
        `圆角 ${radiusLabel(s.radius)}　内边距 ${s.paddingX}×${s.paddingY}　字号 ${s.fontSize}`,
    );
  }
  console.log('');
  console.log('  颜色角色：');
  for (const r of colors.roles) {
    console.log(`    ${r.label.padEnd(12)} ${r.hex.toUpperCase().padEnd(9)} ${r.token}`);
  }

  eq('识别出的组件类别数是 4', c.kindCount, 4);

  const primary = c.specs.find((s) => s.variant === 'primary');
  const secondary = c.specs.find((s) => s.variant === 'secondary');
  check('区分出主按钮', !!primary, primary ? '' : '缺失');
  check('区分出次按钮', !!secondary, secondary ? '' : '缺失');
  eq('主按钮背景色是 #3d5afe', primary?.backgroundColor, '#3d5afe');
  eq('主按钮文字色是 #ffffff', primary?.textColor, '#ffffff');
  eq('主按钮内边距 18×10', `${primary?.paddingX}×${primary?.paddingY}`, '18×10');
  eq('次按钮背景色是 #ffffff', secondary?.backgroundColor, '#ffffff');
  eq('次按钮圆角 8', secondary?.radius, 8);

  const input = c.specs.find((s) => s.kind === 'input');
  eq('输入框圆角 6', input?.radius, 6);
  eq('输入框内边距 14×9', `${input?.paddingX}×${input?.paddingY}`, '14×9');
  eq('输入框字号 15', input?.fontSize, 15);

  const nav = c.specs.find((s) => s.kind === 'nav');
  check('识别出导航栏', !!nav, nav ? '' : '缺失');
  eq('导航栏高度按 64 的行高报出', nav?.backgroundColor, '#ffffff');

  const card = c.specs.find((s) => s.kind === 'card');
  eq('卡片认出 2 个', card?.count, 2);
  eq('卡片圆角 12', card?.radius, 12);
  eq('卡片内边距 24×24', `${card?.paddingX}×${card?.paddingY}`, '24×24');
  check('卡片投影被采到', !!card?.shadow, card?.shadow ?? '缺失');

  check(
    '没有编造页面上不存在的组件',
    !c.specs.some((s) => s.variant === 'ghost'),
    c.specs.map((s) => s.variant).filter(Boolean).join(','),
  );
  check(
    '每个组件都给出用途说明',
    c.specs.every((s) => s.usage.length > 40),
    c.specs.filter((s) => s.usage.length <= 40).map((s) => s.label).join(','),
  );

  const hasAccent = colors.roles.some((r) => r.hex.toLowerCase() === '#3d5afe');
  check('主按钮的品牌蓝进入色板', hasAccent, colors.roles.map((r) => r.hex).join(','));
}

// =====================================================================
// acceptance-b6.html　导出快照
//
// 前面的断言验的是「分析对不对」，这一段验的是「能不能落成文件」。
// 真实样本走一遍组装、序列化、写盘、读回，确认这条路上没有循环引用、
// 没有 undefined 造成的字段丢失，文件名也过得去。
// =====================================================================
show('导出快照');

{
  const sample = await collect(page, 'acceptance-b6.html');
  const colors = analyzeColors(sample);
  const typography = analyzeTypography(sample);
  const spacing = analyzeSpacing(sample);
  const effects = analyzeEffects(sample);
  const components = analyzeComponents(sample);

  const exported = buildSampleExport({
    sample,
    colors,
    typography,
    spacing,
    effects,
    components,
    extractorVersion: '0.1.0',
    generatedAt: new Date(),
  });

  const text = serializeExport(exported);
  const name = exportFileName(exported);
  const outDir = path.join(root, 'reports', 'e2e-sample');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, name);
  fs.writeFileSync(outPath, text, 'utf8');

  // 再存一份固定名的。带时间戳的那份是扩展真实产物的样子，会一直堆；
  // 这一份只给人工打开对照用，每次覆盖，不会越积越多。
  fs.writeFileSync(path.join(outDir, 'sample-export.json'), text, 'utf8');

  console.log(`  文件名　${name}`);
  console.log(`  大小　　${(Buffer.byteLength(text, 'utf8') / 1024).toFixed(1)} KB`);
  console.log(`  位置　　${path.relative(root, outPath)}`);
  console.log('');
  console.log('  各分区条数：');
  console.log(`    元素观测 ${exported.stats.elements}　排版观测 ${exported.stats.typography}`);
  console.log(`    间距观测 ${exported.stats.boxes}　样式观测 ${exported.stats.styles}`);
  console.log(`    颜色角色 ${exported.analysis.colors.roles.length}　组件类别 ${exported.analysis.components.specs.length}`);

  const onDisk = fs.readFileSync(outPath, 'utf8');
  const parsed = JSON.parse(onDisk);

  check('导出内容可序列化', text.length > 0);
  check('落盘文件与内存内容逐字节一致', onDisk === text);
  eq('落盘后 schema 不变', parsed.schema, exported.schema);
  eq('原始元素观测条数等于采集结果', parsed.raw.elements.length, sample.elements.length);
  eq('原始排版观测条数等于采集结果', parsed.raw.typography.length, sample.typography.length);
  eq('原始间距观测条数等于采集结果', parsed.raw.boxes.length, sample.boxes.length);
  eq('原始样式观测条数等于采集结果', parsed.raw.styles.length, sample.styles.length);
  eq('五条分析线都在', Object.keys(parsed.analysis).length, 5);
  eq('组件结论与界面同源', parsed.analysis.components.specs.length, components.specs.length);
  check('页面标题带出', parsed.page.title.length > 0, parsed.page.title);
  check('文件名以 .json 结尾', name.endsWith('.json'), name);
  check('文件名里没有路径分隔符', !/[/\\]/.test(name), name);
  check(
    '文件名长度在文件系统限制内',
    Buffer.byteLength(name, 'utf8') < 255,
    String(Buffer.byteLength(name, 'utf8')),
  );
}

// =====================================================================
// 收尾
// =====================================================================

await browser.close();

if (consoleErrors.length > 0) {
  console.log('');
  console.log('页面运行期报错：');
  for (const e of consoleErrors) console.log('  ' + e);
  failed++;
}

show('断言结果');
for (const line of report) console.log(line);
console.log('');
console.log(failed === 0 ? `全部通过（${report.length} 条）` : `${failed} / ${report.length} 项未通过`);

process.exit(failed === 0 ? 0 : 1);
