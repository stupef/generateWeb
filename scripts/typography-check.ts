/**
 * 排版分析层的回归检查，用合成数据跑，不需要浏览器。
 *
 * 运行：npm run check:typography
 *
 * 前面三组对得上 B3 的三条验收标准：
 *   一、页面用了不同字体时，能区分标题字体和正文字体
 *   二、字号层级与页面实际一致，一次性数值被挡在层级之外
 *   三、页面自带字体给出可直接粘贴的替代栈
 *
 * 后面几组补的是这几条判据的边界。只有两个字的 h1、rem 折算出来的
 * 小数偏差、五个挨在一起的中间字号，这三种情况都会让「按字符量
 * 一刀切」的简单做法出错，必须单独锁住。
 *
 * 每个断言里的期望值都是人工指定的。改分析逻辑之前先跑一遍这个脚本，
 * 改完必须让所有断言回到全绿。
 */
import { analyzeTypography, MIN_STEP_CHARS, SIZE_MERGE_RATIO } from '../src/core/typography';
import type { BackgroundSummary, EmbeddedContentSummary, PageSample, TypeObservation } from '../src/core/types';

/**
 * 局部声明退出码用的 Node 全局。
 *
 * 故意不装 @types/node：这个项目的源码只跑在浏览器里，
 * 一旦把 Node 的全局类型并进来，DOM 里同名的 setTimeout、fetch 这些
 * 就会被 Node 的重载覆盖，扩展代码会拿到错误的类型。
 */
declare const process: { exit(code?: number): never };

const report: string[] = [];
let failed = 0;

function check(name: string, ok: boolean): void {
  if (!ok) failed++;
  report.push(`${ok ? '✓' : '✗'} ${name}`);
}

/** 与颜色用例共用的空结构，排版用例不关心背景和框架 */
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

/** 用例里的元素编号。自增，理由见 color-check.ts 里同一处的说明 */
let refSeq = 0;

function t(partial: Partial<TypeObservation>): TypeObservation {
  return {
    ref: refSeq++,
    tag: 'P',
    headingLevel: 0,
    fontFamily: '"Inter", system-ui, sans-serif',
    fontWeight: 400,
    fontSize: 16,
    lineHeight: 24,
    letterSpacing: null,
    textChars: 10,
    isControl: false,
    ...partial,
  };
}

function sample(obs: TypeObservation[], webFonts: string[] = []): PageSample {
  return {
    url: 'https://example.com/',
    title: '合成样例',
    viewportWidth: 1440,
    viewportHeight: 900,
    canvasColor: '#ffffff',
    prefersDark: false,
    elements: [],
    typography: obs,
    // 排版用例不关心间距和组件，留给各自的脚本覆盖
    boxes: [],
    styles: [],
    webFontFamilies: webFonts,
    background: noBackground,
    embedded: plainStructure,
    textCharsTotal: obs.reduce((n, o) => n + o.textChars, 0),
    skipped: 0,
    visited: obs.length,
    truncated: false,
    elapsedMs: 12,
  };
}

/** 批量造同一档字号的正文字，让某一级在字符量上明显胜出 */
function paragraphs(
  count: number,
  chars: number,
  partial: Partial<TypeObservation>,
): TypeObservation[] {
  const out: TypeObservation[] = [];
  for (let i = 0; i < count; i++) out.push(t({ textChars: chars, ...partial }));
  return out;
}

// ---------------------------------------------------------------------
// 用例一：双字体页面
// 标题用 Playfair Display（衬线，页面自带），正文用 Inter。
// 另外混进两个只出现一次的字号、一个紧挨着 13 的 13.5，
// 以及两个 rem 折算出的 15.999999。
// ---------------------------------------------------------------------

const SERIF_HEAD = '"Playfair Display", Georgia, serif';

const dualFont: TypeObservation[] = [
  t({ tag: 'H1', headingLevel: 1, fontSize: 48, lineHeight: 52, fontWeight: 700, fontFamily: SERIF_HEAD, textChars: 24 }),
  t({ tag: 'H2', headingLevel: 2, fontSize: 32, lineHeight: 38, fontWeight: 700, fontFamily: SERIF_HEAD, textChars: 40 }),
  ...paragraphs(30, 80, { fontSize: 16, lineHeight: 24 }),
  // 同一个字号的另一种写法。rem 折算到小数位经常长这样，
  // 不归一就会在分类之前裂成两条，白白多出一级
  t({ fontSize: 15.999999, lineHeight: 24, textChars: 40 }),
  ...paragraphs(10, 20, { tag: 'SPAN', fontSize: 13, lineHeight: 18 }),
  // 下面三个都是一次性数值，各自只在一个元素上出现
  t({ fontSize: 13.5, lineHeight: 20, textChars: 3 }),
  t({ fontSize: 17.2, lineHeight: 26, textChars: 2 }),
  t({ fontSize: 21.7, lineHeight: 30, textChars: 4 }),
];

const dual = analyzeTypography(sample(dualFont, ['Playfair Display']));

{
  const sizes = dual.steps.map((s) => s.size).join(', ');
  check(`双字体页面应聚出 4 级字号，实际 ${dual.steps.length} 级（${sizes}）`, dual.steps.length === 4);
}

{
  const h1 = dual.steps[0];
  check(
    `最大一级应是 48px 标题，实际 ${h1 ? `${h1.size}px / ${h1.role}` : '缺失'}`,
    !!h1 && h1.size === 48 && h1.role === 'heading',
  );
  check(
    `48px 应标记为 h1 层级，实际 [${h1 ? h1.headingLevels.join(',') : ''}]`,
    !!h1 && h1.headingLevels.length === 1 && h1.headingLevels[0] === 1,
  );
}

{
  const body = dual.steps.find((s) => s.role === 'body');
  check(
    `正文应是字符量最大的 16px，实际 ${body ? `${body.size}px / ${body.chars} 字` : '缺失'}`,
    !!body && body.size === 16,
  );
  check(
    `正文行高应回填成 1.5 倍，实际 ${body && body.lineHeightRatio !== null ? body.lineHeightRatio : '未取到'}`,
    !!body && body.lineHeightRatio === 1.5,
  );
}

{
  // 15.999999 和 16 必须落在同一级里，不能各占一行
  const at16 = dual.steps.filter((s) => Math.abs(s.size - 16) < 0.5);
  check(`15.999999 应与 16 合并为一级，实际在 16 附近有 ${at16.length} 级`, at16.length === 1);
}

{
  // 13.5 和 13 只差 3.85%，低于聚类容差，本来就该并进 13 那一级；
  // 另外两个差值都超过容差，该被丢掉
  const dropped = dual.discarded.map((d) => d.size).join(', ');
  check(
    `差值超过容差的两个字号应被丢弃，实际丢弃 [${dropped}]`,
    dual.discarded.length === 2 &&
      dual.discarded.some((d) => d.size === 17.2) &&
      dual.discarded.some((d) => d.size === 21.7),
  );
  const at13 = dual.steps.find((s) => s.size === 13);
  check(
    `13.5 应并入 13 一级，该级字符数应为 203，实际 ${at13 ? at13.chars : '缺失'}`,
    !!at13 && at13.chars === 203,
  );
}

{
  const caption = dual.steps.find((s) => s.role === 'caption');
  check(
    `13px 应判为辅助文字，实际 ${caption ? `${caption.size}px / ${caption.role}` : '缺失'}`,
    !!caption && caption.size === 13,
  );
}

{
  // 验收一的核心：两套字体必须分别落到标题和正文上
  const head = dual.families.find((f) => f.name === 'Playfair Display');
  const bodyFam = dual.families.find((f) => f.name === 'Inter');
  check(`字体族应识别出两套，实际 ${dual.families.length} 套`, dual.families.length === 2);
  check(
    `Playfair Display 应只承担标题，实际角色 [${head ? head.roles.join(',') : ''}]`,
    !!head && head.roles.length === 1 && head.roles[0] === 'heading',
  );
  check(
    `Inter 应承担正文，实际角色 [${bodyFam ? bodyFam.roles.join(',') : ''}]`,
    !!bodyFam && bodyFam.roles.includes('body') && bodyFam.isPrimary,
  );
}

{
  const note = dual.notes.find((n) => n.kind === 'split-family');
  check('标题与正文分属两套字体时必须给出说明', !!note);
}

// ---------------------------------------------------------------------
// 用例二：单字体页面
// 标题和正文共用一套字体，这是绝大多数站点的真实情况。
// 这种情况不该强行拆出两套字体，而要说明层级是靠字号和字重拉开的。
// ---------------------------------------------------------------------

const monoFont: TypeObservation[] = [
  t({ tag: 'H1', headingLevel: 1, fontSize: 40, lineHeight: 44, fontWeight: 700, textChars: 20 }),
  t({ tag: 'H2', headingLevel: 2, fontSize: 24, lineHeight: 30, fontWeight: 600, textChars: 30 }),
  ...paragraphs(20, 90, { fontSize: 16, lineHeight: 26 }),
];

const single = analyzeTypography(sample(monoFont));

{
  check(`单字体页面应只识别出一套字体，实际 ${single.families.length} 套`, single.families.length === 1);
  const note = single.notes.find((n) => n.kind === 'same-family');
  check('标题与正文同字体时必须给出说明', !!note);
  check(
    `同字体页面不应产生替代建议，实际 ${single.fallbacks.length} 条`,
    single.fallbacks.length === 0,
  );
}

// ---------------------------------------------------------------------
// 用例三：页面自带字体的替代栈
// ---------------------------------------------------------------------

const sohneStack = '"Söhne", "Söhne Fallback", -apple-system, "Segoe UI", sans-serif';

const webfontCase: TypeObservation[] = [
  t({ tag: 'H1', headingLevel: 1, fontSize: 44, fontWeight: 700, fontFamily: sohneStack, textChars: 20 }),
  ...paragraphs(20, 90, { fontSize: 16, fontFamily: sohneStack }),
];

const webfont = analyzeTypography(sample(webfontCase, ['Söhne']));

{
  const f = webfont.fallbacks.find((x) => x.family === 'Söhne');
  check(`页面自带的 Söhne 应给出替代方案，实际 ${webfont.fallbacks.length} 条`, !!f);

  if (f) {
    check(`替代栈的首项应是具体字体，实际 ${f.stack.split(',')[0] ?? ''}`, f.stack.startsWith('Inter'));
    check(`替代栈不应再出现原字体，实际 ${f.stack}`, f.stack.indexOf('Söhne') === -1);
    check('伴生占位族 Söhne Fallback 应一并清掉', f.stack.indexOf('Fallback') === -1);
    check('原有的系统回退顺序应保留', f.stack.indexOf('Segoe UI') !== -1);
    check('末尾必须落到通用族', f.stack.trim().endsWith('sans-serif'));
  }

  const note = webfont.notes.find((n) => n.kind === 'webfont');
  check('使用页面自带字体时必须给出说明', !!note);
}

{
  // 中文页面：替换英文自定义字体时，栈里的中文字体要原样保住，
  // 否则中英文混排会掉到系统默认字体上
  const cjk = analyzeTypography(
    sample(
      paragraphs(20, 90, {
        fontSize: 16,
        fontFamily: '"HarmonyOS Sans", "PingFang SC", "Microsoft YaHei", sans-serif',
      }),
      ['HarmonyOS Sans'],
    ),
  );
  const f = cjk.fallbacks.find((x) => x.family === 'HarmonyOS Sans');
  check(
    `中文替代栈应保留 PingFang SC，实际 ${f ? f.stack : '缺失'}`,
    !!f && f.stack.indexOf('PingFang SC') !== -1 && f.stack.indexOf('Microsoft YaHei') !== -1,
  );
  check(
    `中文替代栈应说明中文字体已保留，实际 ${f ? f.reason : '缺失'}`,
    !!f && f.reason.indexOf('中文') !== -1,
  );
}

// ---------------------------------------------------------------------
// 用例四：等宽字体
// 正文用无衬线，代码块用页面自带的等宽字体。
// ---------------------------------------------------------------------

const codeCase: TypeObservation[] = [
  ...paragraphs(20, 90, { fontSize: 16, lineHeight: 26 }),
  ...paragraphs(6, 40, { tag: 'CODE', fontSize: 14, lineHeight: 22, fontFamily: '"JetBrains Mono", monospace' }),
];

const code = analyzeTypography(sample(codeCase, ['JetBrains Mono']));

{
  const step = code.steps.find((s) => s.size === 14);
  check(
    `14px 等宽字体应判为代码层级，实际 ${step ? step.role : '缺失'}`,
    !!step && step.role === 'code',
  );
  const f = code.fallbacks.find((x) => x.family === 'JetBrains Mono');
  check(`等宽字体应给出等宽类替代，实际 ${f ? f.stack : '缺失'}`, !!f && f.stack.startsWith('"SF Mono"'));
  check(
    `等宽字体应记录在 monoFamilies，实际 [${code.monoFamilies.join(',')}]`,
    code.monoFamilies.includes('JetBrains Mono'),
  );
}

{
  // 字体名里带 mono 的并不都是等宽字体。整串包含会踩这个坑
  const corsiva = analyzeTypography(
    sample(paragraphs(20, 90, { fontSize: 16, fontFamily: '"Monotype Corsiva", cursive' })),
  );
  const step = corsiva.steps[0];
  check(
    `Monotype Corsiva 不是等宽字体，实际角色 ${step ? step.role : '缺失'}`,
    !!step && step.role === 'body',
  );
  check(
    `Monotype Corsiva 不应进 monoFamilies，实际 [${corsiva.monoFamilies.join(',')}]`,
    corsiva.monoFamilies.length === 0,
  );
}

{
  // macOS 的等宽回退栈。ui-monospace 是关键字会被跳过，真正命中的
  // 主族是 SFMono-Regular，它是系统字体，不该冒出一条替代建议。
  // 这条是拿 test/acceptance-b3.html 实测时抓出来的
  const macMono = analyzeTypography(
    sample(
      paragraphs(20, 90, {
        fontSize: 13,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      }),
    ),
  );
  check(
    `macOS 系统等宽栈不应产生替代建议，实际 ${macMono.fallbacks.length} 条`,
    macMono.fallbacks.length === 0,
  );
  const f = macMono.families.find((x) => x.name === 'SFMono-Regular');
  check(
    `SFMono-Regular 应判为系统字体，实际 ${f ? f.origin : '缺失'}`,
    !!f && f.origin === 'system',
  );
}

// ---------------------------------------------------------------------
// 用例五：标题豁免与文字量门槛
// ---------------------------------------------------------------------

{
  // 只有两个字的 h1。按字符量算它低于门槛，但它是真实存在的层级，
  // 被丢掉的话整个页面的标题字号就没了
  const shortHeading = analyzeTypography(
    sample([
      t({ tag: 'H1', headingLevel: 1, fontSize: 56, lineHeight: 60, textChars: 2 }),
      ...paragraphs(20, 90, { fontSize: 16, lineHeight: 26 }),
    ]),
  );
  const h1 = shortHeading.steps.find((s) => s.size === 56);
  check(
    `只有两个字的 h1 必须保留为层级，实际 ${h1 ? `${h1.size}px / ${h1.role}` : '被丢弃'}`,
    !!h1 && h1.role === 'heading',
  );
}

{
  // 反过来，没有标题语义支撑的小字号该丢就丢
  const noise = analyzeTypography(
    sample([
      ...paragraphs(20, 90, { fontSize: 16, lineHeight: 26 }),
      t({ fontSize: 19.4, textChars: 3 }),
    ]),
  );
  check(
    `无标题语义的一次性字号应被丢弃，实际丢弃 ${noise.discarded.length} 个`,
    noise.discarded.length === 1 && noise.discarded[0]?.size === 19.4,
  );
}

{
  // 字符少但铺得开的仍然保留，比如一列每项四五个字的导航
  const nav = analyzeTypography(
    sample([
      ...paragraphs(20, 90, { fontSize: 16, lineHeight: 26 }),
      ...Array.from({ length: 6 }, () => t({ tag: 'A', fontSize: 15, textChars: 4, isControl: true })),
    ]),
  );
  const step = nav.steps.find((s) => s.size === 15);
  check(`铺开的导航字号应保留为层级，实际 ${step ? `${step.size}px / ${step.role}` : '被丢弃'}`, !!step);
}

// ---------------------------------------------------------------------
// 用例六：聚类不能链式传播
// 五个挨得很近的中间字号。如果按相邻值连线，13 一路连到 15
// 会全挤进同一簇，阶梯就整个没了。
// ---------------------------------------------------------------------

{
  const chained = analyzeTypography(
    sample([
      13, 13.4, 13.8, 14.2, 14.6, 15,
    ].flatMap((size) => paragraphs(2, 20, { fontSize: size, lineHeight: size * 1.5 }))),
  );
  const sizes = chained.steps.map((s) => s.size).join(', ');
  check(
    `13 到 15 的六个字号只应聚成 3 级，实际 ${chained.steps.length} 级（${sizes}）`,
    chained.steps.length === 3,
  );
}

// ---------------------------------------------------------------------
// 用例七：行高、字重、字间距的回填
// ---------------------------------------------------------------------

{
  // 主流行高按承载字符数投票，不能取平均值
  const lh = analyzeTypography(
    sample([
      ...paragraphs(2, 100, { fontSize: 16, lineHeight: 24 }),
      ...paragraphs(1, 10, { fontSize: 16, lineHeight: 40 }),
    ]),
  );
  const step = lh.steps[0];
  check(
    `行高应取承载字符最多的 24px，实际 ${step ? String(step.lineHeight) : '缺失'}`,
    !!step && step.lineHeight === 24 && step.lineHeightRatio === 1.5,
  );
  check(
    `字重应按使用量排序，实际 [${step ? step.weights.join(',') : ''}]`,
    !!step && step.weights[0] === 400,
  );
}

{
  // 整页没有显式行高时不能凭空补一个数字出来
  const allNormal = analyzeTypography(
    sample(paragraphs(20, 90, { fontSize: 16, lineHeight: null })),
  );
  const step = allNormal.steps[0];
  check(
    `行高为 normal 时应保持 null，实际 ${step ? String(step.lineHeight) : '缺失'}`,
    !!step && step.lineHeight === null && step.lineHeightRatio === null,
  );
  const note = allNormal.notes.find((n) => n.kind === 'no-explicit-line-height');
  check('整页无显式行高时必须给出说明', !!note);
}

{
  const spaced = analyzeTypography(
    sample(paragraphs(5, 40, { fontSize: 48, lineHeight: 52, letterSpacing: -1.2 })),
  );
  const step = spaced.steps[0];
  check(
    `负字间距应回填 1 位小数，实际 ${step ? String(step.letterSpacing) : '缺失'}`,
    !!step && step.letterSpacing === -1.2,
  );
}

// ---------------------------------------------------------------------
// 用例八：空输入与阈值边界
// ---------------------------------------------------------------------

{
  const empty = analyzeTypography(sample([], []));
  check(
    '空页面应返回空结果而不是抛错',
    empty.steps.length === 0 && empty.families.length === 0 && empty.bodySize === null,
  );
}

{
  // 阈值要待在两个常识边界之间：
  //   下界 5% 以内是 rem 折算和 em 继承的常见偏差，必须合并
  //   上界 12.5% 是设计系统里最小的相邻级差，必须区分
  // 这条是 SIZE_MERGE_RATIO 唯一该被改动的地方，想动它先看这条断言
  check(
    `聚类阈值 ${SIZE_MERGE_RATIO} 应落在 0.02 ~ 0.12 之间`,
    SIZE_MERGE_RATIO > 0.02 && SIZE_MERGE_RATIO < 0.12,
  );
  check(`层级字符量门槛应是 ${MIN_STEP_CHARS}`, MIN_STEP_CHARS === 12);
}

// ---------------------------------------------------------------------

console.log('='.repeat(56));
console.log(`断言结果（聚类容差 ${SIZE_MERGE_RATIO}）`);
console.log('='.repeat(56));
for (const line of report) console.log(line);
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项未通过`);

process.exit(failed === 0 ? 0 : 1);
