/**
 * 页面底色口径的回归，采集层用 jsdom 跑真实文档树，分析层接真函数。
 *
 * 运行：npm run check:canvas
 *
 * 为什么单独需要这个脚本。
 *
 * 底色原先取的是 body 上合成出来的那个颜色。这在大多数页面成立，因为
 * body 自己就是画布。但只要 body 声明了不透明底色、首屏又被一个整屏区块
 * 盖住，这个取值就和肉眼看到的正好相反。about.nike.com 就是这样，body 是
 * 白底，首屏整屏全黑，于是报告写「页面底色 #FFFFFF，浅色主题」，而所有
 * 「与底色的对比度」都按白底算，白色正文连主要文字色都拿不到。
 *
 * 这一类构不成合成数据的用例。分析层的 sample() 是把 canvasColor 当参数
 * 手喂的，写用例的人自然会让它等于页面底色，构造不出「两者不一致」的
 * 情形；真机那一段又只在验收页上跑，验收页里没有这种结构。所以补这一个。
 *
 * 已知局限，写清楚免得误读结果。
 * 一是 jsdom 不做布局，矩形全靠元素上的 data-box 属性打桩，读作文档坐标。
 * 二是配色只用 rgb() 写法，走颜色解析的快路径，不依赖 canvas 回读。
 */
import { createJiti } from 'jiti';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// jsdom 是 CommonJS，用默认导入再解构，避免具名导出解析不到
import jsdomPkg from 'jsdom';

const { JSDOM, VirtualConsole } = jsdomPkg;

/** jsdom 没装 canvas 包，每次 getContext 都会吐一条 not implemented，与断言无关 */
const quiet = new VirtualConsole();
quiet.on('jsdomError', (err) => {
  if (String(err && err.message).includes('getContext')) return;
  console.error(err && err.message);
});

const here = path.dirname(fileURLToPath(import.meta.url));
const jiti = createJiti(import.meta.url);

const { collectPageSample } = jiti(path.join(here, '../src/core/collector.ts'));
const { analyzeColors } = jiti(path.join(here, '../src/core/color.ts'));
const { analyzeTypography } = jiti(path.join(here, '../src/core/typography.ts'));
const { analyzeSpacing } = jiti(path.join(here, '../src/core/spacing.ts'));
const { analyzeEffects } = jiti(path.join(here, '../src/core/effects.ts'));
const { analyzeComponents } = jiti(path.join(here, '../src/core/components.ts'));
const { buildSampleExport } = jiti(path.join(here, '../src/core/export.ts'));
const { renderDesignMd } = jiti(path.join(here, '../src/core/design-md.ts'));

/** 把真实采到的样本串上全部分析线，再渲染成 DESIGN.md，取颜色那一节 */
function colorsSectionOf(sample, colors) {
  const exported = buildSampleExport({
    sample,
    colors,
    typography: analyzeTypography(sample),
    spacing: analyzeSpacing(sample),
    effects: analyzeEffects(sample),
    components: analyzeComponents(sample),
    extractorVersion: '0.0.0-canvas-check',
    generatedAt: new Date('2026-10-13T12:00:00Z'),
  });
  const md = renderDesignMd(exported, null);
  const start = md.indexOf('## Colors');
  const end = md.indexOf('## Typography');
  return md.slice(start, end < 0 ? md.length : end);
}

const report = [];
let failed = 0;

function check(name, ok, detail) {
  if (!ok) failed++;
  report.push(`${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `　→ ${detail}`}`);
}

/** 断言两个值相等，不一致时把实际值带进报告，免得只看到一个叉 */
function eq(name, actual, expected) {
  check(name, actual === expected, `实际 ${JSON.stringify(actual)}，应为 ${JSON.stringify(expected)}`);
}

// ---------------------------------------------------------------------
// 环境搭建
// ---------------------------------------------------------------------

/**
 * 给窗口打布局桩。jsdom 不做布局，getBoundingClientRect 一律返回 0，
 * 不打桩采集器会把每个元素都当成零面积跳过。
 *
 * 矩形写在元素自己的 data-box 上，格式 "left,top,width,height"，按文档
 * 坐标给。这里再减掉当前滚动量换算成视口坐标，和浏览器里的口径一致，
 * 这样滚动相关的行为才测得出来。不写 data-box 的元素落到默认值。
 */
function stubLayout(win, scrollY) {
  const proto = win.Element.prototype;
  proto.getBoundingClientRect = function () {
    let left = 0;
    let docTop = 0;
    let width = 200;
    let height = 40;

    const raw = this.getAttribute && this.getAttribute('data-box');
    if (raw) {
      const parts = raw.split(',').map((n) => Number(n.trim()));
      if (parts.length === 4 && parts.every((n) => Number.isFinite(n))) {
        left = parts[0];
        docTop = parts[1];
        width = parts[2];
        height = parts[3];
      }
    }

    const top = docTop - scrollY;
    return {
      x: left,
      y: top,
      width,
      height,
      left,
      top,
      right: left + width,
      bottom: top + height,
      toJSON() {
        return { x: left, y: top, width, height };
      },
    };
  };
}

/** 视口尺寸与滚动量。采集器读的是 window 上这几个值 */
function setViewport(win, width, height, scrollY) {
  for (const [key, value] of [
    ['innerWidth', width],
    ['innerHeight', height],
    ['scrollY', scrollY],
  ]) {
    Object.defineProperty(win, key, { value, configurable: true, writable: true });
  }
}

/**
 * 把某个窗口挂成全局，采集函数是独立作用域，靠全局查找这些名字。
 *
 * 刻意不覆盖 performance：jsdom 的 Performance 实现内部会去读全局
 * performance，把它指回 jsdom 自己会造成无限递归。
 */
function installGlobals(win) {
  globalThis.window = win;
  globalThis.document = win.document;
  globalThis.getComputedStyle = win.getComputedStyle.bind(win);
}

/** 建页面、打桩、装全局，然后跑一次真实采集 */
function collect(html, { width = 1126, height = 700, scrollY = 0 } = {}) {
  const dom = new JSDOM(html, { pretendToBeVisual: true, virtualConsole: quiet });
  setViewport(dom.window, width, height, scrollY);
  stubLayout(dom.window, scrollY);
  installGlobals(dom.window);
  const sample = collectPageSample();
  return { dom, sample };
}

// ---------------------------------------------------------------------
// 用例一：常规浅色页，回归用
//
// 首屏里一块浅灰区块盖住了七成面积，底色不该因此从白变成浅灰。白底
// 还露在屏幕上，它就是底色。这条守着「不用比例阈值」这个选择。
// ---------------------------------------------------------------------
console.log('='.repeat(64));
console.log('用例一　常规浅色页不回归');
console.log('='.repeat(64));

const caseA = collect(`<!DOCTYPE html><html><head><style>
  body { background-color: rgb(255,255,255); color: rgb(17,17,17); margin: 0; }
</style></head><body data-box="0,0,1126,2400">
  <header data-box="0,0,1126,80" style="background-color: rgb(255,255,255)">
    <p data-box="40,20,400,24" style="color: rgb(17,17,17)">浅色页的导航文字</p>
  </header>
  <section data-box="0,80,1126,500" style="background-color: rgb(250,250,250)">
    <p data-box="80,140,900,120" style="color: rgb(17,17,17)">浅色页的正文段落，用来占住首屏的面积。</p>
  </section>
  <button data-box="80,600,140,44" style="background-color: rgb(17,17,17); color: rgb(255,255,255)">按钮</button>
</body></html>`);

eq('文档画布色是白', caseA.sample.documentCanvasColor, '#ffffff');
eq('底色仍是白，没被浅灰区块顶掉', caseA.sample.canvasColor, '#ffffff');
check(
  '底色与文档画布一致时是同一个值',
  caseA.sample.canvasColor === caseA.sample.documentCanvasColor,
);
check(
  '浅灰区块确实被采到了，只是不算底色',
  caseA.sample.elements.some((e) => e.backgroundColor === '#fafafa'),
);

// ---------------------------------------------------------------------
// 用例二：body 白底，首屏被整屏深色区块盖住
//
// about.nike.com 的形态。底色必须是黑的，且下游的深浅判断和主要文字色
// 都要跟着翻过来，否则就是「报对了底色、色板还是错的」。
// ---------------------------------------------------------------------
console.log('');
console.log('='.repeat(64));
console.log('用例二　body 白底、首屏整屏深色');
console.log('='.repeat(64));

const caseB = collect(`<!DOCTYPE html><html><head><style>
  body { background-color: rgb(255,255,255); color: rgb(17,17,17); margin: 0; }
</style></head><body data-box="0,0,1126,6000">
  <nav data-box="0,0,1126,60" style="background-color: rgb(17,17,17)">
    <p data-box="24,18,300,24" style="color: rgb(255,255,255)">导航项</p>
  </nav>
  <div data-box="0,0,1126,700" style="background-color: rgb(17,17,17)">
    <p data-box="40,180,700,120" style="color: rgb(255,255,255)">整屏深色区块上的白色正文，占的面积最大。</p>
    <p data-box="40,320,700,120" style="color: rgb(255,255,255)">第二段白色正文，同样是首屏可见的文字。</p>
    <p data-box="40,460,700,60" style="color: rgb(153,153,153)">一段次级灰字，用来验证主要文字色不会落到它头上。</p>
    <button data-box="40,560,140,48" style="background-color: rgb(17,17,17); color: rgb(255,255,255)">按钮</button>
  </div>
  <footer data-box="0,700,1126,300" style="background-color: rgb(17,17,17)">
    <p data-box="40,760,600,24" style="color: rgb(255,255,255)">页脚</p>
  </footer>
</body></html>`);

eq('文档画布色仍是白', caseB.sample.documentCanvasColor, '#ffffff');
eq('底色翻成黑', caseB.sample.canvasColor, '#111111');

const colorsB = analyzeColors(caseB.sample);
eq('分析层也拿到黑底', colorsB.canvasHex, '#111111');
eq('判为深色主题', colorsB.isDark, true);

const primaryB = colorsB.roles.find((r) => r.token === 'primary');
eq('主要文字色是白', primaryB ? primaryB.hex : null, '#ffffff');

const canvasRoleB = colorsB.roles.find((r) => r.token === 'neutral');
eq('页面底色角色也是黑', canvasRoleB ? canvasRoleB.hex : null, '#111111');

check(
  '白色正文没有被当成页面底色吃掉',
  canvasRoleB !== undefined && canvasRoleB.hex !== '#ffffff',
);

// 生成层也要把这件事讲清楚。读的人只要去 body 上看一眼背景色就会发现
// 两个值对不上，报告里不写，看起来就是工具报错了。
const colorsSectionB = colorsSectionOf(caseB.sample, colorsB);
check(
  'DESIGN.md 写明了两个底色为什么不同',
  colorsSectionB.includes('文档 body 上声明的是 #FFFFFF'),
);
check('DESIGN.md 里底色角色是黑', colorsSectionB.includes('`neutral` (#111111)'));
check('DESIGN.md 判为深色', colorsSectionB.includes('底色偏深'));
check(
  '两个口径一致时不加这一句',
  !colorsSectionOf(caseA.sample, analyzeColors(caseA.sample)).includes('文档 body 上声明的是'),
);

// 手里还留着上次采集的样本文件时不带这个字段，生成这一步不能因此报错，
// 也不能凭空多出一句「body 上声明的是 undefined」
const legacy = { ...caseA.sample };
delete legacy.documentCanvasColor;
const legacySection = colorsSectionOf(legacy, analyzeColors(legacy));
check('旧样本缺这个字段也不加这一句', !legacySection.includes('文档 body 上声明的是'));
check('旧样本的底色仍然照常输出', legacySection.includes('`neutral` (#FFFFFF)'));

// ---------------------------------------------------------------------
// 用例三：深色区块在首屏之下
//
// 区块在文档 y=900 起，首屏只到 700。它不该影响底色，否则任何长页面
// 只要往下有一块深色就会被判成深色页面。
// ---------------------------------------------------------------------
console.log('');
console.log('='.repeat(64));
console.log('用例三　深色区块在首屏之下');
console.log('='.repeat(64));

const caseC = collect(`<!DOCTYPE html><html><head><style>
  body { background-color: rgb(255,255,255); color: rgb(17,17,17); margin: 0; }
</style></head><body data-box="0,0,1126,4000">
  <section data-box="0,0,1126,700" style="background-color: rgb(255,255,255)">
    <p data-box="80,120,800,120" style="color: rgb(17,17,17)">首屏是白的</p>
  </section>
  <section data-box="0,900,1126,1200" style="background-color: rgb(17,17,17)">
    <p data-box="80,960,800,120" style="color: rgb(255,255,255)">首屏之外的深色区块</p>
  </section>
</body></html>`);

eq('首屏之下的深色不参与', caseC.sample.canvasColor, '#ffffff');
check(
  '深色区块确实被采到了，只是不算底色',
  caseC.sample.elements.some((e) => e.backgroundColor === '#111111'),
);

// ---------------------------------------------------------------------
// 用例四：首屏只有一半深色
//
// 深色盖住上半屏，下半屏是白的。文档画布在白底那一半露着，就不该翻。
// 一个只占半屏的色块是区块，不是底色。
// ---------------------------------------------------------------------
console.log('');
console.log('='.repeat(64));
console.log('用例四　首屏只有一半深色');
console.log('='.repeat(64));

const caseD = collect(`<!DOCTYPE html><html><head><style>
  body { background-color: rgb(255,255,255); color: rgb(17,17,17); margin: 0; }
</style></head><body data-box="0,0,1126,3000">
  <div data-box="0,0,1126,340" style="background-color: rgb(17,17,17)">
    <p data-box="40,120,700,60" style="color: rgb(255,255,255)">半屏高的深色区块</p>
  </div>
  <section data-box="0,340,1126,600" style="background-color: rgb(255,255,255)">
    <p data-box="80,420,800,120" style="color: rgb(17,17,17)">下面这半屏是白的</p>
  </section>
</body></html>`);

eq('半屏色块不夺走底色', caseD.sample.canvasColor, '#ffffff');

// ---------------------------------------------------------------------
// 用例五：滚动位置不改变取样点
//
// 用户滚到页面下半段再点扩展，取到的仍该是文档第一屏的颜色，否则同一张
// 页面在不同滚动位置会给出不同的底色。深色区块在文档 y=0 到 700，这里
// 滚到 y=2000，它的视口坐标已经是负数，不做滚动校正就会被漏掉。
// ---------------------------------------------------------------------
console.log('');
console.log('='.repeat(64));
console.log('用例五　滚动位置不改变取样点');
console.log('='.repeat(64));

const caseE = collect(
  `<!DOCTYPE html><html><head><style>
  body { background-color: rgb(255,255,255); color: rgb(17,17,17); margin: 0; }
</style></head><body data-box="0,0,1126,6000">
  <div data-box="0,0,1126,700" style="background-color: rgb(17,17,17)">
    <p data-box="40,200,700,120" style="color: rgb(255,255,255)">文档第一屏的深色区块</p>
  </div>
  <section data-box="0,700,1126,5000" style="background-color: rgb(255,255,255)">
    <p data-box="80,2400,800,120" style="color: rgb(17,17,17)">滚动之后看到的浅色内容</p>
  </section>
</body></html>`,
  { scrollY: 2000 },
);

eq('滚到下半段仍取文档第一屏', caseE.sample.canvasColor, '#111111');

// ---------------------------------------------------------------------
// 用例六：窄视口下的取样范围
//
// 网格按视口宽度铺，视口变了取样范围要跟着变。这里把宽度收到 420，
// 深色区块只盖住左半边（0 到 200），占比不到三分之二，底色不该翻。
// ---------------------------------------------------------------------
console.log('');
console.log('='.repeat(64));
console.log('用例六　窄视口下按视口宽度取样');
console.log('='.repeat(64));

const caseF = collect(
  `<!DOCTYPE html><html><head><style>
  body { background-color: rgb(255,255,255); color: rgb(17,17,17); margin: 0; }
</style></head><body data-box="0,0,420,2000">
  <div data-box="0,0,200,700" style="background-color: rgb(17,17,17)">
    <p data-box="10,200,180,60" style="color: rgb(255,255,255)">左半边的深色</p>
  </div>
  <section data-box="200,0,220,700" style="background-color: rgb(255,255,255)">
    <p data-box="220,240,180,60" style="color: rgb(17,17,17)">右半边的浅色</p>
  </section>
</body></html>`,
  { width: 420, height: 700 },
);

eq('窄视口下量到的是左半屏', caseF.sample.viewportWidth, 420);
eq('左半边深色不夺走底色', caseF.sample.canvasColor, '#ffffff');

// ---------------------------------------------------------------------
// 用例七：三个色块平分首屏
//
// 文档画布被盖得一点不剩，但顶上来的三个色块各占三分之一，谁也不是
// 多数。这时认定底色是拿不准的，宁可留着文档画布色不动，也不要随便
// 挑一边当基准，否则对比度会跟着整排数字一起偏。
// ---------------------------------------------------------------------
console.log('');
console.log('='.repeat(64));
console.log('用例七　三个色块平分首屏');
console.log('='.repeat(64));

const caseG = collect(`<!DOCTYPE html><html><head><style>
  body { background-color: rgb(255,255,255); color: rgb(17,17,17); margin: 0; }
</style></head><body data-box="0,0,1126,3000">
  <div data-box="0,0,375,700" style="background-color: rgb(26,26,26)">
    <p data-box="20,200,300,60" style="color: rgb(255,255,255)">左</p>
  </div>
  <div data-box="375,0,376,700" style="background-color: rgb(42,42,42)">
    <p data-box="400,200,300,60" style="color: rgb(255,255,255)">中</p>
  </div>
  <div data-box="751,0,375,700" style="background-color: rgb(58,58,58)">
    <p data-box="780,200,300,60" style="color: rgb(255,255,255)">右</p>
  </div>
</body></html>`);

eq('平分首屏时不硬挑一个当底色', caseG.sample.canvasColor, '#ffffff');
check(
  '三个色块都采到了',
  ['#1a1a1a', '#2a2a2a', '#3a3a3a'].every((hex) =>
    caseG.sample.elements.some((e) => e.backgroundColor === hex),
  ),
);

// ---------------------------------------------------------------------
for (const c of [caseA, caseB, caseC, caseD, caseE, caseF, caseG]) c.dom.window.close();

console.log('');
console.log('='.repeat(64));
console.log('断言结果');
console.log('='.repeat(64));
for (const line of report) console.log(line);
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项未通过`);

process.exit(failed === 0 ? 0 : 1);
