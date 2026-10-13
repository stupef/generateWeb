/**
 * 采集层的真实文档树回归。
 *
 * 运行：npm run check:frame
 *
 * 为什么单独需要这个脚本。
 *
 * 采集函数是整条链路里唯一无法用纯函数测试覆盖的部分，它直接操作 DOM，
 * 只能在真实文档树里跑。而它又是最脆弱的一环，靠 toString() 序列化送进页面，
 * 任何模块级引用到了页面里都会静默变成 undefined。
 *
 * 本轮新增的同源框架遍历是这段代码里分支最多的一块，光靠构造数据测不到，
 * 所以这里用 jsdom 搭一棵真实的文档树来跑。
 *
 * 已知局限，写清楚免得误读结果。
 * 一是 jsdom 不做布局，getBoundingClientRect 一律返回 0，而采集器会跳过
 * 零面积的元素，不打桩就什么都采不到，所以下面手工给了固定尺寸。
 * 二是颜色解析的兜底路径依赖 canvas 回读，jsdom 没装 canvas 时拿不到值，
 * 因此断言只覆盖结构事实，颜色由 scripts/color-check.ts 负责。
 */

import { createJiti } from 'jiti';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// jsdom 是 CommonJS，用默认导入再解构，避免具名导出解析不到
import jsdomPkg from 'jsdom';

const { JSDOM, VirtualConsole } = jsdomPkg;

/**
 * jsdom 没装 canvas 包，每次 getContext 都会吐一条 not implemented。
 * 颜色解析的快路径能处理 rgb()，走不到 canvas 兜底，所以这条噪音与本轮
 * 断言无关，滤掉即可。其他 jsdom 报错照常打出来，免得掩盖真问题。
 */
const quiet = new VirtualConsole();
quiet.on('jsdomError', (err) => {
  if (String(err && err.message).includes('getContext')) return;
  console.error(err && err.message);
});

const here = path.dirname(fileURLToPath(import.meta.url));
const jiti = createJiti(import.meta.url);

const collectorPath = path.join(here, '../src/core/collector.ts');
const diagnosePath = path.join(here, '../src/core/diagnose.ts');

const { collectPageSample } = jiti(collectorPath);
const { describeCoverage } = jiti(diagnosePath);

const report = [];
let failed = 0;

function check(name, ok) {
  if (!ok) failed++;
  report.push(`${ok ? '✓' : '✗'} ${name}`);
}

// ---------------------------------------------------------------------
// 环境搭建
// ---------------------------------------------------------------------

/** 给一个窗口的元素打尺寸桩。jsdom 不做布局，不打桩采集器会全部跳过 */
function stubLayout(win) {
  const proto = win.Element.prototype;
  proto.getBoundingClientRect = function () {
    const isFrame = this.tagName === 'IFRAME' || this.tagName === 'FRAME';
    const w = isFrame ? 1200 : 120;
    const h = isFrame ? 800 : 40;
    return {
      x: 0,
      y: 0,
      width: w,
      height: h,
      top: 0,
      left: 0,
      right: w,
      bottom: h,
      toJSON() {
        return { x: 0, y: 0, width: w, height: h };
      },
    };
  };
}

/**
 * 把某个窗口挂成全局，采集函数是独立作用域，靠全局查找这些名字。
 *
 * 注意这里刻意不覆盖 performance。jsdom 的 Performance 实现内部会去读
 * 全局 performance，把它指回 jsdom 自己会造成无限递归。Node 自带
 * performance.now()，采集器只拿它算耗时，用原生那个完全等价。
 */
function installGlobals(win) {
  globalThis.window = win;
  globalThis.document = win.document;
  globalThis.getComputedStyle = win.getComputedStyle.bind(win);
}

function build(html) {
  const dom = new JSDOM(html, { pretendToBeVisual: true, virtualConsole: quiet });
  stubLayout(dom.window);
  return dom;
}

/** 让某个框架的 contentWindow 抛错，模拟浏览器里跨域访问的真实行为 */
function makeCrossOrigin(doc, id) {
  const frame = doc.getElementById(id);
  Object.defineProperty(frame, 'contentWindow', {
    configurable: true,
    get() {
      throw new Error(
        'Blocked a frame with origin from accessing a cross-origin frame.',
      );
    },
  });
}

/** 往同源框架里写入一份文档 */
function fillFrame(doc, id, html) {
  const innerDoc = doc.getElementById(id).contentDocument;
  innerDoc.open();
  innerDoc.write(html);
  innerDoc.close();
  stubLayout(innerDoc.defaultView);
  return innerDoc;
}

const PAGE_CSS = 'body { background: rgb(255,255,255); color: rgb(17,17,17); margin: 0; }';

// ---------------------------------------------------------------------
// 用例一：同源框架、跨域框架、隐藏框架混在一个页面里
// ---------------------------------------------------------------------
console.log('='.repeat(64));
console.log('用例一　框架可读性的三种情形');
console.log('='.repeat(64));

const caseA = build(`<!DOCTYPE html><html><head><style>${PAGE_CSS}</style></head><body>
  <div id="shell">外壳文字</div>
  <iframe id="same" style="width:600px;height:400px"></iframe>
  <iframe id="cross" style="width:600px;height:400px"></iframe>
  <iframe id="hidden" style="display:none"></iframe>
</body></html>`);

fillFrame(
  caseA.window.document,
  'same',
  `<!DOCTYPE html><html><head><style>
     body { background: rgb(15,23,42); color: rgb(226,232,240); margin: 0; }
   </style></head><body>
     <h1>框架内标题</h1>
     <p>框架内的正文段落，用来验证文字统计确实把框架内容算了进来。</p>
   </body></html>`,
);

makeCrossOrigin(caseA.window.document, 'cross');

installGlobals(caseA.window);
const sampleA = collectPageSample();

check('同源框架被读入并计数', sampleA.embedded.sameOriginFrames === 1);
check('跨域框架被记为读不到', sampleA.embedded.blockedFrames === 1);
check(
  '隐藏框架不算可读也不算被拦',
  sampleA.embedded.sameOriginFrames + sampleA.embedded.blockedFrames === 2,
);
check('隐藏框架不计入大框架', sampleA.embedded.largeFrames === 2);

const tagsA = sampleA.elements.map((e) => e.tag);
check('框架内的 h1 被采到', tagsA.includes('H1'));
check('框架内的 p 被采到', tagsA.includes('P'));
check('顶层元素同时被采到', tagsA.includes('DIV'));
check('文字总量包含框架内文字', sampleA.textCharsTotal >= 25);
check('顶层文字量远大于 0', sampleA.textCharsTotal > 4);

console.log(`  同源读入 ${sampleA.embedded.sameOriginFrames} 处`);
console.log(`  跨域拦下 ${sampleA.embedded.blockedFrames} 处`);
console.log(`  大框架 ${sampleA.embedded.largeFrames} 处`);
console.log(`  采到元素 ${sampleA.visited} 个，标签 ${[...new Set(tagsA)].join(' ')}`);
console.log(`  文字总量 ${sampleA.textCharsTotal} 字`);
console.log('');

caseA.window.close();

// ---------------------------------------------------------------------
// 用例二：普通单文档页面，不能误报出框架
// ---------------------------------------------------------------------
console.log('='.repeat(64));
console.log('用例二　普通单文档页面');
console.log('='.repeat(64));

const caseB = build(`<!DOCTYPE html><html><head><style>${PAGE_CSS}</style></head><body>
  <h1>普通页面标题</h1>
  <p>这是一段足够长的正文，用来让文字总量跨过稀疏判定的门槛，避免被误判成外壳页面。</p>
  <button style="background:rgb(37,99,235);color:rgb(255,255,255)">主要操作</button>
</body></html>`);

installGlobals(caseB.window);
const sampleB = collectPageSample();

check('普通页面没有大框架', sampleB.embedded.largeFrames === 0);
check(
  '普通页面不产生任何框架计数',
  sampleB.embedded.sameOriginFrames === 0 && sampleB.embedded.blockedFrames === 0,
);
check('普通页面文字总量被正常统计', sampleB.textCharsTotal > 30);
check('普通页面不是 frameset 结构', sampleB.embedded.framesetDocument === false);

console.log(`  大框架 ${sampleB.embedded.largeFrames} 处`);
console.log(`  文字总量 ${sampleB.textCharsTotal} 字`);
console.log('');

caseB.window.close();

// ---------------------------------------------------------------------
// 用例三：只采到外壳的页面，直接对着用户报的那个问题
//
// 页面里只有一个跨域框架，顶层除了框架什么都没有。这正是 IEEE 取件页
// 那类「外壳 + 框架」结构，采到的结果是一个孤零零的白色。
// ---------------------------------------------------------------------
console.log('='.repeat(64));
console.log('用例三　只采到外壳的页面');
console.log('='.repeat(64));

const caseC = build(`<!DOCTYPE html><html><head><style>${PAGE_CSS}</style></head><body>
  <iframe id="only" style="width:1000px;height:700px"></iframe>
</body></html>`);

makeCrossOrigin(caseC.window.document, 'only');

installGlobals(caseC.window);
const sampleC = collectPageSample();

check('外壳页面有跨域框架', sampleC.embedded.blockedFrames === 1);
check('外壳页面顶层文字为零', sampleC.textCharsTotal === 0);

// 颜色角色数按「白底加默认黑字」模拟，这两个角色是外壳页面必然会有的
const noteC = describeCoverage(sampleC.embedded, 2, sampleC.textCharsTotal);
const textC = noteC ? noteC.lines.join('\n') : '';

check('外壳页面触发覆盖说明', noteC !== null);
check('外壳页面判为严重', noteC !== null && noteC.severe === true);
check('说明里点出框架跨域读不到', textC.includes('不同域名'));
check('说明里给出框架占比', textC.includes('%'));

// 反向对照：同样是外壳结构，但框架读得进来，措辞必须不一样，
// 否则用户会以为扩展压根没尝试过读框架
const noteD = describeCoverage(
  { ...sampleC.embedded, sameOriginFrames: 1, blockedFrames: 0 },
  2,
  0,
);
const textD = noteD ? noteD.lines.join('\n') : '';
check('同源已读入时换用另一种措辞', textD.includes('已经一并读入'));

// 正常页面不能出现任何说明
const noteE = describeCoverage(sampleB.embedded, 6, sampleB.textCharsTotal);
check('普通页面不产生覆盖说明', noteE === null);

console.log('  外壳页面说明文字：');
console.log(`    ${textC.replace(/\n/g, '\n    ')}`);
console.log('  同源已读入时：');
console.log(`    ${textD.replace(/\n/g, '\n    ')}`);
console.log('');

caseC.window.close();

// ---------------------------------------------------------------------
console.log('='.repeat(64));
console.log('断言结果');
console.log('='.repeat(64));
for (const line of report) console.log(line);
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项未通过`);

process.exit(failed === 0 ? 0 : 1);
