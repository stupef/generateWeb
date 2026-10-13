/**
 * 入口契约检查。
 *
 * 这一条守的是「点图标之后还会不会发生事情」。
 *
 * Chrome 有一条不成文的规矩：action 上只要挂着弹窗，chrome.action.onClicked
 * 就不再触发。这个扩展现在把提取放在点图标那一刻——能用 activeTab 的只有那
 * 一瞬间，所以整个功能都吊在这条链路上。哪天要是有人为了别的目的给 action
 * 加回一个 default_popup，onClicked 会静默失效，扩展装上去看不出任何异常，
 * 点图标只是弹出个框。
 *
 * 这件事没有编译错误、没有运行时报错，也没有哪条现有断言会响，所以单独守。
 *
 * 分两层。
 *
 * 第一层看产物清单：default_path 指向不存在的文件、permissions 里少写
 * sidePanel、最低版本低于 116，症状一律是「点图标没反应」，查起来要翻文档。
 *
 * 第二层把打包好的背景脚本放进一个**故意没有 DOM** 的沙箱里执行，再手动点
 * 一次。service worker 里没有 document 和 window，被 import 进来的采集器或
 * 分析模块只要在顶层碰一下它们，扩展就会加载即崩，而这件事类型检查看不出来
 * （它有 DOM 类型）。点那一下是为了证明「开面板、采集、存结果」这条链真的
 * 连在一起——这一段是侧边栏改造的核心，而它偏偏是 playwright 够不着的地方，
 * 侧边栏属于浏览器 UI，没有可以点的地方。
 *
 * 面板的作用域也守在这里。面板是窗口级的东西，切到别的标签页它不会自己消失，
 * 所以由面板自己判断手上这份结果属不属于当前页。
 *
 * 这一层里有一条是反着写的，也是整个文件最贵的一条：不许出现全局的
 * setOptions({ enabled: false })。那一版真做过，看着是最接近「按标签页管面板」
 * 的写法，实际把扩展弄瘫了——某个标签页的侧边栏被禁用之后，那个标签页上的图标
 * 会跟着变灰，onClicked 不再触发，点图标彻底没反应。它没有编译错误、没有运行
 * 时报错，只是整个功能消失，所以用源码和冒烟两条把它封住。
 *
 * 同一颗雷还有另一头，也封在这里：不许把点图标交给 Chrome 接管
 * （openPanelOnActionClick: true）。它会吞掉 chrome.action.onClicked，症状是
 * 「面板出现但是空的、点第二下还会关掉」。这一版比上面那条更难查——它是浏览器
 * 持久化保存的，把代码删干净、重载扩展都不够，必须显式设回 false，所以除了封住
 * true，还要求背景脚本留着那条拨回 false 的自愈动作，并且冒烟里要真的调到。
 *
 * 运行：npm run check:entry（需要先构建，用的是产物）
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const OUTPUT_DIR = path.resolve(process.cwd(), '.output/chrome-mv3');
const MANIFEST = path.join(OUTPUT_DIR, 'manifest.json');
const SRC_DIR = path.resolve(process.cwd(), 'src/entrypoints');

/** 侧边栏靠这个接口打开，它从 Chrome 116 才有 */
const MIN_CHROME = 116;

/** 冒烟里假造的那个标签页，断言时按这两个数对 */
const SMOKE_TAB = { id: 11, windowId: 22, url: 'https://example.com/', title: '示例页面' };

let passed = 0;
let failed = 0;

function check(name, ok, detail = '') {
  if (ok) {
    passed++;
    console.log(`✓ ${name}`);
  } else {
    failed++;
    console.error(`✗ ${name}${detail ? `　${detail}` : ''}`);
  }
}

if (!fs.existsSync(MANIFEST)) {
  console.error(`找不到产物清单 ${MANIFEST}，先运行一次 npm run build。`);
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));

// ---------------------------------------------------------------------
// 产物清单
// ---------------------------------------------------------------------

console.log('产物清单');

check(
  'action 上没有弹窗',
  !manifest.action?.default_popup,
  `挂了 ${manifest.action?.default_popup}，chrome.action.onClicked 就不会触发，点图标将不再提取`,
);

const panelPath = manifest.side_panel?.default_path;
check(
  '侧边栏面板已声明且产物在',
  Boolean(panelPath) && fs.existsSync(path.join(OUTPUT_DIR, panelPath)),
  `default_path=${panelPath ?? '（未声明）'}`,
);

const required = ['sidePanel', 'activeTab', 'scripting', 'storage'];
const granted = new Set(manifest.permissions ?? []);
const missing = required.filter((p) => !granted.has(p));
check('权限齐全', missing.length === 0, `缺 ${missing.join('、')}`);

const min = Number.parseInt(manifest.minimum_chrome_version ?? '0', 10);
check(
  `最低版本不低于 ${MIN_CHROME}`,
  min >= MIN_CHROME,
  `当前 ${manifest.minimum_chrome_version ?? '（未声明）'}，sidePanel.open 从 ${MIN_CHROME} 才有`,
);

const worker = manifest.background?.service_worker;
check(
  '背景脚本已注册且产物在',
  Boolean(worker) && fs.existsSync(path.join(OUTPUT_DIR, worker)),
  `service_worker=${worker ?? '（未声明）'}`,
);

// ---------------------------------------------------------------------
// 源码约束
//
// 下面两条是文字匹配，不是执行验证。它们守的是一个语法上正确、跑起来也不
// 报错、只是功能失效的写法：手势被 await 吃掉之后，侧边栏打不开，而 open()
// 的 promise 拒绝被我们主动吞掉了，所以控制台也是干净的。
// ---------------------------------------------------------------------

console.log('');
console.log('源码约束');

const background = fs.readFileSync(path.join(SRC_DIR, 'background.ts'), 'utf8');

/**
 * 剥掉注释之后再匹配。
 *
 * 这个文件里的注释会大段讨论「哪一种写法不能用」，被禁的写法本身就会原样出现在
 * 注释里。直接拿源码匹配的话，解释性注释会把断言打红，逼着人把注释写含糊——那正好
 * 把最该留下的推理赶走了。所以判禁用写法前先剥注释。
 *
 * 行注释那段要求 `//` 前面不是冒号，免得把 https:// 这类地址当成注释截掉。
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const backgroundCode = stripComments(background);

const clickStart = background.indexOf('chrome.action.onClicked.addListener');

// 只取回调体那一段。从 addListener 切到第一个 `});`，这样下面那些函数定义
// 和它们注释里出现的 await 字样都不会被算进来
const handler = clickStart >= 0 ? background.slice(clickStart).split('});')[0] ?? '' : '';
const firstAwait = handler.indexOf('await');
const openCall = handler.indexOf('openPanel(');
check(
  '开面板排在第一个 await 之前',
  openCall >= 0 && (firstAwait < 0 || openCall < firstAwait),
  '中间夹了 await，手势就没了，侧边栏会打不开而且不报错',
);

const fnStart = background.indexOf('function openPanel(');
const fnEnd = fnStart >= 0 ? background.indexOf('\n}', fnStart) : -1;
const fnBody = fnEnd > fnStart ? background.slice(fnStart, fnEnd) : '';
check(
  '开面板的函数体里没有 await',
  fnStart >= 0 && !fnBody.includes('await'),
  '这个函数必须整段同步，await 会把手势耗掉',
);

/*
 * 下面几条守的是面板的作用域，属于「语法上正确、跑起来也不报错、只是结果不对」
 * 的那一类写法。
 *
 * 第一条是反着写的，理由见文件头。全局禁用侧边栏曾经是这里的主力写法，现在它
 * 必须一直是「不存在」。
 */
check(
  '没有把侧边栏全局关掉',
  !/setOptions\(\s*\{\s*enabled:\s*false\s*\}\s*\)/.test(backgroundCode),
  '全局禁用了侧边栏，那个标签页的图标会跟着变灰，点图标不再触发回调',
);

/*
 * 下面两条守的是同一个方向的另一头：点图标这件事不能被 Chrome 接管。
 *
 * openPanelOnActionClick: true 让 Chrome 自己打开侧边栏，代价是这次点击被整个消费掉，
 * chrome.action.onClicked 不再触发。采集只能发生在那一个回调里，所以症状是「面板出来了
 * 但是空的、点第二下还会把它关掉」。它和全局禁用一样属于「编译、构建、断言全绿，功能
 * 静默失效」，而且更阴——这个值是浏览器持久化的，删掉代码也带不走，得显式设回 false。
 *
 * 所以一头封住 true（源码里不许出现），一头要求有把 false 写回去的自愈动作。
 */
check(
  '没有把点图标交给 Chrome 接管',
  !/openPanelOnActionClick:\s*true/.test(backgroundCode),
  'openPanelOnActionClick: true 会吞掉 chrome.action.onClicked，采集不跑，面板开出来是空的',
);

check(
  '有把侧边栏行为拨回手动模式的自愈',
  /setPanelBehavior\(\s*\{\s*openPanelOnActionClick:\s*false\s*\}\s*\)/.test(backgroundCode),
  '缺少这条自愈，浏览器里残留的 openPanelOnActionClick: true 会一直吞点击，重载扩展也清不掉',
);

const panelMain = fs.readFileSync(path.join(SRC_DIR, 'sidepanel', 'main.ts'), 'utf8');
check(
  '面板里不做采集',
  !panelMain.includes('executeScript'),
  '面板里注入拿不到 activeTab，会静默失败。采集只该发生在点图标那一刻',
);

check(
  '面板会跟着当前标签页换内容',
  panelMain.includes('chrome.tabs.onActivated.addListener') &&
    panelMain.includes('activeTabId'),
  '少了它，切到别的页面时面板还挂着上一页的结果，看着像是这一页的数据',
);

// ---------------------------------------------------------------------
// 背景脚本冒烟
// ---------------------------------------------------------------------

/**
 * 在没有 DOM 的沙箱里把背景脚本跑起来，再手动点一次图标。
 *
 * 沙箱里只给 service worker 真正有的东西。document、window、localStorage
 * 一概不放——碰一下就是 ReferenceError，这正是要验的。
 */
async function smokeBackground() {
  const calls = { open: [], execute: [], set: [], panelOptions: [], panelBehavior: [] };
  let clickHandler = null;

  const event = (capture) => ({
    addListener: (fn) => {
      if (capture) capture(fn);
    },
    removeListener: () => {},
    hasListener: () => false,
  });

  const chrome = {
    action: { onClicked: event((fn) => (clickHandler = fn)) },
    runtime: {
      onInstalled: event(),
      onMessage: event(),
      onStartup: event(),
      getManifest: () => ({ version: '0.0.0' }),
      id: 'smoke',
      getURL: (p) => `chrome-extension://smoke/${p}`,
    },
    sidePanel: {
      open: (opts) => {
        calls.open.push(opts);
        return Promise.resolve();
      },
      close: () => Promise.resolve(),
      setPanelBehavior: (opts) => {
        calls.panelBehavior.push(opts);
        return Promise.resolve();
      },
      setOptions: (opts) => {
        calls.panelOptions.push(opts);
        return Promise.resolve();
      },
      getOptions: async () => ({}),
    },
    storage: {
      session: {
        get: async () => ({}),
        set: async (value) => {
          calls.set.push(value);
        },
      },
      local: { get: async () => ({}), set: async () => {} },
      onChanged: event(),
    },
    tabs: { query: async () => [], create: () => {}, onActivated: event() },
    windows: { getCurrent: async () => ({ id: SMOKE_TAB.windowId }) },
    // 返回空数组，让采集走到「没拿到数据」那一条提示分支。这里验的是控制流
    // 有没有连上，分析链本身在端到端检查里有 985 条断言守着
    scripting: {
      executeScript: (opts) => {
        calls.execute.push(opts);
        return Promise.resolve([]);
      },
    },
    extension: { isAllowedFileSchemeAccess: async () => false },
    permissions: { request: async () => true, contains: async () => true },
  };

  const sandbox = {
    chrome,
    console,
    performance,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    structuredClone,
    AbortController,
    AbortSignal,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    crypto: globalThis.crypto,
    fetch: () => Promise.reject(new Error('冒烟不发网络请求')),
  };

  const file = path.join(OUTPUT_DIR, manifest.background?.service_worker ?? 'background.js');
  const code = fs.readFileSync(file, 'utf8');

  try {
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox, { filename: 'background.js' });
  } catch (err) {
    return { loaded: false, error: err.message, calls, hasClickHandler: false };
  }

  if (!clickHandler) return { loaded: true, error: '', calls, hasClickHandler: false };

  clickHandler({ ...SMOKE_TAB });
  // 等采集那条线跑完。它内部是 await 链，这里给一轮宏任务足够
  await new Promise((r) => setTimeout(r, 50));

  return { loaded: true, error: '', calls, hasClickHandler: true };
}

console.log('');
console.log('背景脚本冒烟');

const smoke = await smokeBackground();
check('在没有 DOM 的环境里能加载', smoke.loaded, smoke.error);
check('加载时注册了点图标事件', smoke.hasClickHandler);

const opened = smoke.calls.open[0];
check(
  '点一次图标会打开面板，且带的是标签页号',
  smoke.calls.open.length === 1 && opened?.tabId === SMOKE_TAB.id,
  `open 调用 ${JSON.stringify(smoke.calls.open)}`,
);

check(
  '整个流程一次都没有碰 setOptions',
  smoke.calls.panelOptions.length === 0,
  `setOptions 调用 ${JSON.stringify(smoke.calls.panelOptions)}。一旦全局禁用，图标就会变灰，点不动`,
);

// 启动这一下必须真的调到。源码里写着不算数——它可能被放在一个走不到的分支里
const behavior = smoke.calls.panelBehavior;
check(
  '启动时把侧边栏行为拨回手动模式',
  behavior.length >= 1 && behavior.every((b) => b?.openPanelOnActionClick === false),
  `setPanelBehavior 调用 ${JSON.stringify(behavior)}。为 true 时点击被 Chrome 接管，采集不会发生`,
);

const injected = smoke.calls.execute[0];
check(
  '点一次图标会发起采集',
  smoke.calls.execute.length === 1 && injected?.target?.tabId === SMOKE_TAB.id,
  `executeScript 调用 ${JSON.stringify(smoke.calls.execute)}`,
);

check(
  '结果会写进面板状态',
  smoke.calls.set.length >= 1 && Object.keys(smoke.calls.set[0] ?? {})[0] === 'panelState',
  `set 调用 ${smoke.calls.set.length} 次`,
);

console.log('');
console.log(`${passed}/${passed + failed} 条通过`);
process.exit(failed === 0 ? 0 : 1);
