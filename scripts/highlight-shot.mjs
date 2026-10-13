/**
 * 高亮的真机验证：把高亮函数注进真实浏览器，截图，并逐元素对账。
 *
 * 运行：DESIGN_MD_CHROME=<chrome 可执行文件> node scripts/highlight-shot.mjs
 *
 * 为什么需要这一个。
 *
 * provenance-check 里的 20 多条断言，验的是「该描哪些元素」和「编进代码里的
 * 字面量两侧一致」，全部建立在源码之上。而高亮真正的产出是页面上的像素，
 * 那段路一次也没走过：executeScript 送进页面之后描边画没画上、光晕露不露得
 * 出来、浮层长什么样、Esc 会不会被页面吃掉、擦完是不是真的一字节不差。
 *
 * 这个脚本把那段补上。三件事。
 *
 * 一、几何不变。高亮前后对每个元素取一次 boundingRect，两次必须逐元素相等。
 *     「只改纯绘制属性所以页面不抖」这句话，这是它唯一的证据。
 *
 * 二、擦除彻底。高亮前、清除后各取一次全元素的计算样式快照，两次必须完全
 *     一致。注意这里的快照取的是计算样式而不是内联样式：计算样式包含了
 *     页面自己的类、继承、伪类，所以它比「内联样式恢复没有」严格得多。
 *
 * 三、画对了。命中元素的 outline 与 box-shadow 必须变成期望值，没命中的元素
 *     一个字都不许变。这一条是防止「画是画了，画到了隔壁」。
 *
 * 截图落到 reports/highlight-shot/，用来人眼确认光晕到底看不看得见。
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
const { analyzeEffects } = core('effects.ts');
const { analyzeComponents } = core('components.ts');
const { provenanceOf } = core('provenance.ts');
const { highlightElements, HIGHLIGHT_OUTLINE, HIGHLIGHT_GLOW_SPREAD, HIGHLIGHT_GLOW_ALPHA } = core(
  'highlight.ts',
);

const OUT_DIR = path.join(root, 'reports/highlight-shot');
const VIEWPORT = { width: 1440, height: 900 };

// ---------------------------------------------------------------------
// 断言脚手架（与其余检查脚本同一套写法）
// ---------------------------------------------------------------------

const report = [];
let failed = 0;

function check(name, ok, detail) {
  if (!ok) failed++;
  const mark = ok ? '✓' : '✗';
  report.push(`${mark} ${name}${!ok && detail ? `　→ ${detail}` : ''}`);
}

function show(title) {
  console.log('');
  console.log('─'.repeat(70));
  console.log(title);
  console.log('─'.repeat(70));
}

// ---------------------------------------------------------------------
// 页面里的两个探针
// ---------------------------------------------------------------------

/** 每个元素的几何。高亮前后各取一次，用来证明布局没被碰到 */
const RECT_PROBE = `(() => {
  const reg = globalThis['__designMdExtractorRegistry@1'];
  return reg.map((el) => {
    const r = el.getBoundingClientRect();
    return [r.x, r.y, r.width, r.height].join(',');
  });
})()`;

/**
 * 每个元素的计算样式快照。
 *
 * 取计算样式而不是内联样式，是因为计算样式把页面自己的类、继承、层叠
 * 全都算进去了。清除之后它对得上，才说明页面真的回去了，而不是只把
 * 内联那一份擦干净了。
 *
 * 选的这几项覆盖「我们动过的」和「我们声称没动的」两类：outline 和
 * box-shadow 会变，背景、文字、边框、内外边距、尺寸一项都不该变。
 */
const STYLE_PROBE = `(() => {
  const reg = globalThis['__designMdExtractorRegistry@1'];
  const keys = ['outline', 'outlineOffset', 'boxShadow', 'backgroundColor', 'color',
    'borderTopColor', 'borderTopWidth', 'paddingTop', 'paddingLeft', 'marginTop',
    'fontSize', 'fontFamily', 'opacity', 'width', 'height'];
  return reg.map((el) => {
    const cs = getComputedStyle(el);
    let s = '';
    for (const k of keys) s += k + ':' + cs[k] + ';';
    return s;
  });
})()`;

/** 每个元素的内联 style 字符串，清空之后要逐字节回到原样 */
const INLINE_PROBE = `(() => {
  const reg = globalThis['__designMdExtractorRegistry@1'];
  return reg.map((el) => el.getAttribute('style'));
})()`;

async function apply(page, cmd) {
  return page.evaluate(`(${highlightElements.toString()})(${JSON.stringify(cmd)})`);
}

// ---------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------

fs.mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch(
  process.env.DESIGN_MD_CHROME ? { executablePath: process.env.DESIGN_MD_CHROME } : {},
);
const context = await browser.newContext({ viewport: VIEWPORT });
const page = await context.newPage();

const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));

const url = 'file://' + path.join(root, 'test', 'acceptance-b1.html');
await page.goto(url, { waitUntil: 'load' });

show('采集与解析');

const sample = await page.evaluate(`(${collectPageSample.toString()})()`);
const input = {
  sample,
  colors: analyzeColors(sample),
  typography: analyzeTypography(sample),
  spacing: analyzeSpacing(sample),
  effects: analyzeEffects(sample),
  components: analyzeComponents(sample),
};

console.log(`采集 ${sample.visited} 个元素，注册表 ${sample.elements.length} 项`);
console.log(`颜色角色 ${input.colors.roles.length} 个，组件 ${input.components.specs.length} 个`);

// 挑三个 token 出来画：一个背景渠道、一个文字渠道、一个组件。
// 三个渠道各一种颜色，一次看全渠道配色是否真的分得开
function pickToken() {
  for (let i = 0; i < input.colors.roles.length; i++) {
    const r = input.colors.roles[i];
    if (r.evidence.backgroundCount >= 3) return { label: `颜色 ${r.hex} 作背景`, token: { kind: 'color', index: i, channel: 'background' } };
  }
  for (let i = 0; i < input.colors.roles.length; i++) {
    const r = input.colors.roles[i];
    if (r.evidence.textCount >= 3) return { label: `颜色 ${r.hex} 作文字`, token: { kind: 'color', index: i, channel: 'text' } };
  }
  return null;
}

const colorPick = pickToken();
const componentPick =
  input.components.specs.length > 0
    ? { label: `组件 ${input.components.specs[0].name ?? input.components.specs[0].kind}`, token: { kind: 'component', index: 0 } }
    : null;

const picks = [colorPick, componentPick].filter(Boolean);
check('在样例页面上取到了可画的 token', picks.length > 0, '一个都取不到');

// ---------------------------------------------------------------------
// 逐 token 走一遍：快照 → 画 → 对账 → 截图 → 擦 → 再对账
// ---------------------------------------------------------------------

const geometryBefore = await page.evaluate(RECT_PROBE);
const styleBefore = await page.evaluate(STYLE_PROBE);
const inlineBefore = await page.evaluate(INLINE_PROBE);

for (const pick of picks) {
  show(`画 ${pick.label}`);

  const result = provenanceOf(pick.token, input);
  if (!result) {
    check(`${pick.label} 解析得出元素`, false, 'provenanceOf 返回 null');
    continue;
  }

  const refs = [];
  for (const g of result.groups) for (const r of g.refs) refs.push(r);
  const unique = [...new Set(refs)];

  console.log(`  分组 ${result.groups.length} 个，元素 ${refs.length} 个，去重 ${unique.length} 个`);

  const outcome = await apply(page, {
    action: 'apply',
    groups: result.groups.map((g) => ({ label: g.label, color: g.color, refs: g.refs })),
    title: result.title,
    subtitle: '真机验证',
  });

  check(
    `${pick.label} 在页面里画上了`,
    outcome.ok === true && outcome.highlighted === unique.length,
    JSON.stringify(outcome),
  );

  // 命中元素身上必须出现我们的描边与光晕，两者都要在
  const painted = await page.evaluate(
    `(() => {
      const reg = globalThis['__designMdExtractorRegistry@1'];
      const refs = ${JSON.stringify(unique)};
      const out = { outline: 0, glow: 0, total: 0, sample: null };
      for (const r of refs) {
        const el = reg[r];
        if (!el) continue;
        out.total++;
        const cs = getComputedStyle(el);
        if (cs.outlineWidth === '2px' && cs.outlineStyle === 'solid') out.outline++;
        if (cs.boxShadow.indexOf('6px') >= 0) {
          out.glow++;
          if (!out.sample) out.sample = cs.boxShadow;
        }
      }
      return out;
    })()`,
  );

  check(
    `${pick.label} 每个命中元素都有一条 2px 实线描边`,
    painted.outline === painted.total,
    `${painted.outline}/${painted.total}`,
  );
  check(
    `${pick.label} 每个命中元素都带上了光晕`,
    painted.glow === painted.total,
    `${painted.glow}/${painted.total}`,
  );
  if (painted.sample) console.log(`  光晕实际值：${painted.sample}`);

  // 几何必须一动不动。这一条是「页面不抖」的唯一证据
  const geometryAfter = await page.evaluate(RECT_PROBE);
  let movedCount = 0;
  for (let i = 0; i < geometryBefore.length; i++) {
    if (geometryBefore[i] !== geometryAfter[i]) movedCount++;
  }
  check(`${pick.label} 画完之后所有元素的位置尺寸一个都没动`, movedCount === 0, `${movedCount} 个元素位移`);

  // 没命中的元素，计算样式一个字都不许变
  const stylePainted = await page.evaluate(STYLE_PROBE);
  const hit = new Set(unique);
  let strayCount = 0;
  for (let i = 0; i < styleBefore.length; i++) {
    if (hit.has(i)) continue;
    if (styleBefore[i] !== stylePainted[i]) strayCount++;
  }
  check(`${pick.label} 没有牵连到任何没命中的元素`, strayCount === 0, `${strayCount} 个元素被改到`);

  // 截图。整页一张，中弹元素放大一张
  // 擦掉，然后比最初那两份快照
  const cleared = await apply(page, { action: 'clear' });
  check(`${pick.label} 清除动作返回成功`, cleared.ok === true, JSON.stringify(cleared));

  const styleRestored = await page.evaluate(STYLE_PROBE);
  const inlineRestored = await page.evaluate(INLINE_PROBE);

  let styleDiff = 0;
  for (let i = 0; i < styleBefore.length; i++) {
    if (styleBefore[i] !== styleRestored[i]) {
      styleDiff++;
      if (styleDiff === 1) {
        console.log(`  第一处样式差异（元素 ${i}）：`);
        console.log(`    之前 ${styleBefore[i].slice(0, 160)}`);
        console.log(`    之后 ${styleRestored[i].slice(0, 160)}`);
      }
    }
  }
  check(`${pick.label} 清除后所有元素的计算样式回到原样`, styleDiff === 0, `${styleDiff} 个元素不一致`);

  let inlineDiff = 0;
  for (let i = 0; i < inlineBefore.length; i++) {
    if (inlineBefore[i] !== inlineRestored[i]) {
      inlineDiff++;
      if (inlineDiff <= 2) {
        console.log(`  内联差异（元素 ${i}）：`);
        console.log(`    之前 ${JSON.stringify(inlineBefore[i])}`);
        console.log(`    之后 ${JSON.stringify(inlineRestored[i])}`);
      }
    }
  }
  check(`${pick.label} 清除后内联 style 属性逐字节回到原样`, inlineDiff === 0, `${inlineDiff} 个元素不一致`);

  // 浮层必须摘掉，且不留空壳
  const overlayLeft = await page.evaluate(
    `document.querySelectorAll('[data-design-md-overlay]').length`,
  );
  check(`${pick.label} 清除后页面上不留浮层`, overlayLeft === 0, `还剩 ${overlayLeft} 个`);
}

// ---------------------------------------------------------------------
// 取证：单独一轮，只为截图
//
// 截图刻意不混在上面那一轮里。playwright 的整页截图会临时把 viewport 撑到
// 整页高度，这个动作本身会给页面上几个元素留下空的 style 属性——不是高亮
// 写的，是截图流程的副作用。夹在中间会把「清除得干不干净」那条断言污染掉：
// 有一条就是这么红的，查了几轮才落到截图头上。所以断言归断言，取证归取证。
// ---------------------------------------------------------------------

show('截图');

for (const pick of picks) {
  const result = provenanceOf(pick.token, input);
  if (!result) continue;

  await apply(page, {
    action: 'apply',
    groups: result.groups.map((g) => ({ label: g.label, color: g.color, refs: g.refs })),
    title: result.title,
    subtitle: '真机验证',
  });

  const slug = pick.token.kind + '-' + (pick.token.index ?? 0);
  await page.screenshot({ path: path.join(OUT_DIR, `full-${slug}.png`), fullPage: true });

  const refs = [];
  for (const g of result.groups) for (const r of g.refs) refs.push(r);
  const first = [...new Set(refs)][0];

  const box = await page.evaluate(
    `(() => {
      const reg = globalThis['__designMdExtractorRegistry@1'];
      const el = reg[${JSON.stringify(first)}];
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    })()`,
  );
  if (box && box.width > 0) {
    const pad = 40;
    const clip = {
      x: Math.max(0, box.x - pad),
      y: Math.max(0, box.y - pad),
      width: Math.min(VIEWPORT.width - Math.max(0, box.x - pad), box.width + pad * 2),
      height: box.height + pad * 2,
    };
    if (clip.width > 8 && clip.height > 8) {
      await page.screenshot({ path: path.join(OUT_DIR, `zoom-${slug}.png`), clip });
    }
  }

  console.log(`  已截 ${slug}（${[...new Set(refs)].length} 处）`);
  await apply(page, { action: 'clear' });
}

// ---------------------------------------------------------------------
// 内联样式的往返
//
// 上面那一轮命中的元素原本都没有 style 属性，验的是「本来没有、擦完也要没有」。
// 另一半是「本来有一串、擦完要一模一样」，包括浏览器会不会把属性值重新序列化
// 成另一种写法。这一轮用造出来的元素把它补上。
// ---------------------------------------------------------------------

show('内联样式的往返');

const roundTrip = await page.evaluate(`(() => {
  const reg = globalThis['__designMdExtractorRegistry@1'];
  const fn = ${highlightElements.toString()};
  const el = reg[3];
  const original = el.getAttribute('style');

  el.setAttribute('style', 'color: #010203; padding-top: 7px');
  el.setAttribute('data-probe', 'keep');

  const before = el.getAttribute('style');
  const r1 = fn({ action: 'apply', groups: [{ label: '测试', color: '#e0730d', refs: [3] }] });
  const during = el.getAttribute('style');
  const outlineDuring = getComputedStyle(el).outline;
  fn({ action: 'clear' });
  const after = el.getAttribute('style');
  const probe = el.getAttribute('data-probe');

  if (original === null) el.removeAttribute('style');
  else el.setAttribute('style', original);
  el.removeAttribute('data-probe');

  return { before, during, after, probe, outlineDuring, painted: r1.highlighted };
})()`);

check('原本带内联样式的元素也能画上', roundTrip.painted === 1, JSON.stringify(roundTrip));
check(
  '绘制期间描边确实写进了内联样式',
  roundTrip.outlineDuring === 'rgb(224, 115, 13) solid 2px',
  JSON.stringify(roundTrip.outlineDuring),
);
check(
  '清除后内联样式逐字节回到原来那一串',
  roundTrip.after === roundTrip.before,
  `${JSON.stringify(roundTrip.before)} 变成了 ${JSON.stringify(roundTrip.after)}`,
);
check('清除时没有顺手动别的属性', roundTrip.probe === 'keep', JSON.stringify(roundTrip.probe));

// ---------------------------------------------------------------------
// 边界：没有高亮时按 Esc、日志里不留错
// ---------------------------------------------------------------------

show('边界');

const escNoop = await apply(page, { action: 'locate' });
check('没有高亮时点定位不会炸', escNoop.ok === false && escNoop.reason.length > 0, JSON.stringify(escNoop));

const staleResult = await page.evaluate(
  `(() => {
    delete globalThis['__designMdExtractorRegistry@1'];
    return (${highlightElements.toString()})({ action: 'apply', groups: [] });
  })()`,
);
check('注册表没了会明确说过期，而不是静默画空', staleResult.stale === true && staleResult.ok === false, JSON.stringify(staleResult));

check('整轮下来页面没有抛错', pageErrors.length === 0, pageErrors.join(' | '));

await browser.close();

console.log('');
console.log('─'.repeat(70));
for (const line of report) console.log(line);
console.log('─'.repeat(70));
console.log(`截图落在 ${path.relative(root, OUT_DIR)}/`);
console.log('');

if (failed > 0) {
  console.log(`${failed} 条没过`);
  process.exit(1);
}
console.log('全部通过');
