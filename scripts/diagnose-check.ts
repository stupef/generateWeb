/**
 * 页面可用性判定的回归检查，纯 Node 跑，不需要浏览器。
 *
 * 运行：npm run check:diagnose
 *
 * 这个脚本守的是三条已经发生过的真实缺陷，改判定逻辑之前先跑一遍。
 *
 * 第一条，读不到 tab.url 时不能做归因。扩展只申请了 activeTab 没有 tabs 权限，
 * 在 chrome:// 这类受限页面上 activeTab 不会被授予，url 就是 undefined。
 * 原实现把 undefined 当成「许可还没生效」并建议用户刷新，而刷新对内部页面
 * 永远无效；更糟的是它排在最前面，把正确的「这是浏览器内部页面」判成死代码。
 *
 * 第二条，PDF 判定不能靠整串地址做正则。旧写法
 * /^https?:\/\/[^/]*\.pdf($|[?#])/i 里的 [^/]* 跨不过斜杠，
 * \.pdf 只能贴在主机名末尾，真实 PDF 地址一条都拦不住。
 *
 * 第三条，本地文件不能无条件拦住。能不能读一个 file 地址不由地址决定，
 * 取决于用户有没有拨开「允许访问文件网址」，所以这个状态要由调用方传进来，
 * 只有确定没开时才拦。旧写法把开关早就打开的用户也挡在门口。
 */
import {
  describeCoverage,
  describeViewport,
  diagnoseInjectionError,
  diagnoseMissingSample,
  diagnoseUrl,
  type Diagnosis,
} from '../src/core/diagnose';
import type { EmbeddedContentSummary } from '../src/core/types';

/** 局部声明退出码用的 Node 全局，理由同 color-check.ts，不引入 @types/node */
declare const process: { exit(code?: number): never };

const report: string[] = [];
let failed = 0;

function check(name: string, ok: boolean) {
  if (!ok) failed++;
  report.push(`${ok ? '✓' : '✗'} ${name}`);
}

function structure(partial: Partial<EmbeddedContentSummary> = {}): EmbeddedContentSummary {
  return {
    contentType: 'text/html',
    pdfEmbeds: 0,
    largeFrames: 0,
    largestFrameRatio: 0,
    framesetDocument: false,
    sameOriginFrames: 0,
    blockedFrames: 0,
    ...partial,
  };
}

function kindOf(d: Diagnosis | null): string {
  return d ? `${d.kind}${d.retryable ? ' (可重试)' : ''}` : '—';
}

// ---------------------------------------------------------------------
// 用例一：URL 预判。核心是「读不到地址不做归因」
// ---------------------------------------------------------------------
const urlCases: Array<{
  url: string | undefined;
  expect: string | null;
  note: string;
  /** 本地文件专用。不写表示问不到开关状态，此时按未知处理 */
  fileAccess?: boolean;
}> = [
  { url: undefined, expect: null, note: '读不到地址，不做归因，交给注入报错' },
  { url: '', expect: null, note: '空串同理' },
  { url: 'https://example.com', expect: null, note: '普通网站，正常路径' },
  { url: 'https://example.com/page.html', expect: null, note: '带路径的普通网站' },
  { url: 'chrome://newtab/', expect: 'internal-page', note: '内部页面' },
  { url: 'chrome://extensions/', expect: 'internal-page', note: '扩展管理页' },
  { url: 'view-source:https://example.com/', expect: 'internal-page', note: '查看源码' },
  { url: 'about:blank', expect: 'internal-page', note: '空白页' },
  { url: 'chrome-extension://abcdef/x.html', expect: 'internal-page', note: '其他扩展的页面' },
  { url: 'https://chromewebstore.google.com/detail/abc', expect: 'web-store', note: '应用商店' },
  { url: 'https://chrome.google.com/webstore/detail/abc', expect: 'web-store', note: '商店旧域名' },
  // 本地文件这三种取值是同一件事的三面。地址一模一样，能不能读取决于
  // 「允许访问文件网址」这个用户开关，所以判据不是地址而是那个开关的状态。
  // 旧实现不看开关一律拦住，开关早打开的用户也被挡在门口
  {
    url: 'file:///Users/dqh/dqh/a.html',
    expect: 'file-url',
    note: '本地文件，开关确实没打开',
    fileAccess: false,
  },
  {
    url: 'file:///Users/dqh/dqh/a.html',
    expect: null,
    note: '本地文件，开关已打开，放它去注入',
    fileAccess: true,
  },
  {
    url: 'file:///Users/dqh/dqh/a.html',
    expect: null,
    note: '本地文件，开关状态问不到，按未知放行',
  },
  { url: 'filesystem:https://example.com/temporary/x', expect: 'file-url', note: 'filesystem 地址' },
  // 下面三条是刚修掉的 PDF 正则缺陷，旧实现全部未命中
  {
    url: 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf',
    expect: 'pdf-file',
    note: '路径里的 pdf（旧正则漏判）',
  },
  {
    url: 'https://arxiv.org/pdf/2401.00001.pdf',
    expect: 'pdf-file',
    note: '带查询前正常的 pdf 路径',
  },
  {
    url: 'https://example.com/report.pdf?download=1',
    expect: 'pdf-file',
    note: '带查询串的 pdf',
  },
  {
    url: 'https://ieeexplore.ieee.org/stamp/stamp.jsp?tp=&arnumber=10525068',
    expect: null,
    note: 'IEEE 取件地址，本身看不出问题，继续注入',
  },
  { url: 'https://example.com/pdf', expect: null, note: '只有 pdf 目录名，不是文件' },
  { url: 'https://foo.pdf', expect: null, note: '主机名以 pdf 结尾，pathname 是斜杠' },
  { url: 'data:text/html,hi', expect: 'opaque-url', note: 'data 地址' },
  { url: 'blob:https://example.com/uuid', expect: 'opaque-url', note: 'blob 地址' },
];

console.log('='.repeat(64));
console.log('用例一　URL 预判');
console.log('='.repeat(64));
for (const c of urlCases) {
  const got = diagnoseUrl(c.url, { fileAccess: c.fileAccess });
  const gotKind = got ? got.kind : null;
  const ok = gotKind === c.expect;
  if (!ok) failed++;
  report.push(
    `${ok ? '✓' : '✗'} [URL] ${String(c.url ?? '(undefined)').slice(0, 58)} → ${kindOf(got)}`,
  );
  console.log(
    `  ${ok ? '✓' : '✗'} ${String(c.expect ?? '—').padEnd(14)} ${String(c.url ?? '(undefined)').slice(0, 62)}`,
  );
}
console.log('');

// 关键断言单独列出来，避免混在批量里看不出来
{
  console.log('='.repeat(64));
  console.log('用例二　历史缺陷的定点回归');
  console.log('='.repeat(64));

  const missingUrl = diagnoseUrl(undefined);
  check('[缺陷一] 读不到地址时返回 null，不做归因', missingUrl === null);

  const legacyPdf = /^https?:\/\/[^/]*\.pdf($|[?#])/i;
  const realPdf = 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf';
  check('[缺陷二] 旧正则确实拦不住真实 PDF 地址', !legacyPdf.test(realPdf));
  check(
    '[缺陷二] 新判定能识别同一条地址',
    diagnoseUrl(realPdf)?.kind === 'pdf-file',
  );

  console.log(`  旧正则命中 dummy.pdf：${legacyPdf.test(realPdf)}（应为 false）`);
  console.log(`  新判定结果：${kindOf(diagnoseUrl(realPdf))}（应为 pdf-file）`);
  console.log('');
}

// ---------------------------------------------------------------------
// 用例二之二：本地文件的开关
//
// 缺陷三。本地文件能不能读不由地址决定，取决于用户在扩展详情页上拨的那个
// 开关。旧实现无条件拦住 file 地址，于是开关早就打开的用户也拿不到数据，
// 而注入一次都没执行过，报错归类里那条 file 规则永远走不到。
//
// 修完之后的硬约束是两条。一，只有确定知道开关没开时才拦。二，预判拦下
// 和注入报错接住这两条路必须给出同一处文案，否则同一件事在两条路上说法
// 不同，而用户看到哪一条取决于他有没有恰好绕过预判。
// ---------------------------------------------------------------------
{
  console.log('='.repeat(64));
  console.log('用例二之二　本地文件的读权限开关');
  console.log('='.repeat(64));

  const fileUrl = 'file:///Users/dqh/dqh/design-md-extractor/test/acceptance-b1.html';

  check('[缺陷三] 开关没打开时拦下', diagnoseUrl(fileUrl, { fileAccess: false })?.kind === 'file-url');
  check('[缺陷三] 开关已打开时放行', diagnoseUrl(fileUrl, { fileAccess: true }) === null);
  check('[缺陷三] 开关状态未知时放行', diagnoseUrl(fileUrl) === null);
  check(
    '[缺陷三] 显式传 undefined 与不传等价',
    diagnoseUrl(fileUrl, { fileAccess: undefined }) === null,
  );

  // 拦下时给的东西必须够用：一句解释、四条以内的步骤、一个能点的动作
  const denied = diagnoseUrl(fileUrl, { fileAccess: false }) as Diagnosis;
  check('[缺陷三] 拦下时不可重试', denied.retryable === false);
  check('[缺陷三] 拦下时带一个能点的动作', denied.action === 'open-extension-settings');
  check('[缺陷三] 步骤里点出那个开关的名字', (denied.hints ?? []).join(' ').includes('允许访问文件网址'));

  // 两条路必须同一处文案。这里逐字段比，不是看一眼像不像：
  // 各写一份的后果是有一处漏改，而漏改只会表现在用户偶发看到的那一条上
  const viaError = diagnoseInjectionError(
    new Error(
      'Cannot access contents of url "file:///Users/dqh/dqh/a.html". ' +
        'Extension manifest must request permission to access this host.',
    ),
  );
  check('[缺陷三] 报错归类也落到 file-url', viaError.kind === 'file-url');
  check('[缺陷三] 两条路标题一致', viaError.title === denied.title);
  check('[缺陷三] 两条路正文一致', viaError.body === denied.body);
  check(
    '[缺陷三] 两条路步骤一致',
    (viaError.hints ?? []).join('\n') === (denied.hints ?? []).join('\n'),
  );
  check('[缺陷三] 两条路动作一致', viaError.action === denied.action);

  console.log(`  开关关闭：${denied.title}`);
  console.log(`  开关打开：放行，交给注入`);
  console.log(`  动作按钮：${denied.action}`);
  console.log('');
}

// ---------------------------------------------------------------------
// 用例三：注入报错的归类
// ---------------------------------------------------------------------
const errorCases: Array<{ msg: string; expect: string; note: string }> = [
  { msg: 'Cannot access a chrome:// URL', expect: 'internal-page', note: '内部页面' },
  {
    msg: 'The extensions gallery cannot be scripted.',
    expect: 'web-store',
    note: '应用商店',
  },
  {
    msg: 'Cannot access a chrome-extension:// URL of different extension',
    expect: 'internal-page',
    note: '扩展页，不能被笼统规则抢走',
  },
  {
    msg: 'Cannot access contents of the page. Extension manifest must request permission to access the respective host.',
    expect: 'no-host-access',
    note: '没有站点权限',
  },
  {
    msg: 'Cannot access contents of url "file:///Users/dqh/a.html". Extension manifest must request permission to access this host.',
    expect: 'file-url',
    note: '本地文件（文件规则要排在笼统规则前）',
  },
  {
    msg: 'This page cannot be scripted due to an ExtensionsSettings policy.',
    expect: 'policy-blocked',
    note: '企业策略',
  },
  { msg: 'No tab with id: 12.', expect: 'tab-gone', note: '标签页没了' },
  { msg: 'Frame with ID 0 is showing error page', expect: 'error-page', note: '错误页' },
  { msg: 'The frame was removed.', expect: 'page-changed', note: '页面跳走了' },
  {
    msg: 'message port closed before a response was received',
    expect: 'interrupted',
    note: '弹窗被关掉',
  },
  { msg: 'Something nobody has seen before', expect: 'unknown', note: '没见过就照实说' },
];

console.log('='.repeat(64));
console.log('用例三　注入报错的归类');
console.log('='.repeat(64));
for (const c of errorCases) {
  const got = diagnoseInjectionError(new Error(c.msg));
  const ok = got.kind === c.expect;
  if (!ok) failed++;
  report.push(
    `${ok ? '✓' : '✗'} [报错] ${c.note} → ${got.kind}${got.retryable ? ' (可重试)' : ''}`,
  );
  console.log(`  ${ok ? '✓' : '✗'} ${got.kind.padEnd(15)} ${c.note}`);
}
console.log('');

{
  console.log('='.repeat(64));
  console.log('用例四　重试按钮的语义');
  console.log('='.repeat(64));

  // 这些页面重复点必然失败，不该把按钮摆出来
  const neverRetry: Array<[string, Diagnosis]> = [
    ['内部页面', diagnoseUrl('chrome://newtab/') as Diagnosis],
    ['应用商店', diagnoseUrl('https://chromewebstore.google.com/x') as Diagnosis],
    ['PDF 文件', diagnoseUrl('https://example.com/a.pdf') as Diagnosis],
    ['本地文件', diagnoseUrl('file:///a.html', { fileAccess: false }) as Diagnosis],
    ['没有站点权限', diagnoseInjectionError(new Error('Cannot access contents of the page.'))],
    ['企业策略', diagnoseInjectionError(new Error('cannot be scripted due to an ExtensionsSettings policy'))],
  ];
  for (const [name, d] of neverRetry) {
    check(`[重试] ${name} 不显示重试按钮`, d.retryable === false);
  }

  // 这两类重试真的有用
  check(
    '[重试] 页面跳走时重试有意义',
    diagnoseInjectionError(new Error('The frame was removed.')).retryable === true,
  );
  check('[重试] 未知错误时重试有意义', diagnoseInjectionError(new Error('???')).retryable === true);
  check('[重试] 没拿到数据时重试有意义', diagnoseMissingSample().retryable === true);

  const unknown = diagnoseInjectionError(new Error('Something nobody has seen before'));
  check('[未知] 保留原始错误原文', unknown.body.includes('Something nobody has seen before'));

  console.log(`  必失败的六类全部为不可重试：${neverRetry.every(([, d]) => !d.retryable)}`);
  console.log(`  页面跳走可重试：${diagnoseInjectionError(new Error('The frame was removed.')).retryable}`);
  console.log('');
}

// ---------------------------------------------------------------------
// 用例五：采到了但结果不可用
// ---------------------------------------------------------------------
{
  console.log('='.repeat(64));
  console.log('用例五　覆盖范围说明');
  console.log('='.repeat(64));

  const clean = describeCoverage(structure(), 6, 3000);
  check('[覆盖] 正常页面不输出说明', clean === null);

  const noField = describeCoverage(undefined, 1, 0);
  check('[覆盖] 字段缺失时不崩，返回 null', noField === null);

  const frameset = describeCoverage(structure({ framesetDocument: true }), 1, 0);
  const framesetText = frameset?.lines.join('\n') ?? '';
  check('[覆盖] frameset 文档给出说明', frameset !== null);
  check('[覆盖] 说明里点出框架结构', framesetText.includes('框架结构'));
  check('[覆盖] frameset 判为严重', frameset?.severe === true);

  const framed = describeCoverage(
    structure({ largeFrames: 2, largestFrameRatio: 0.98 }),
    1,
    30,
  );
  const framedText = framed?.lines.join('\n') ?? '';
  check('[覆盖] 大框架 + 顶层内容稀疏时给出说明', framed !== null);
  check('[覆盖] 报出框架处数 2', framedText.includes('2 处框架区域'));
  check('[覆盖] 报出最大框架占比 98%', framedText.includes('98%'));
  check('[覆盖] 提醒色板不代表整个页面', framedText.includes('主体内容在其中'));

  const framedButRich = describeCoverage(
    structure({ largeFrames: 1, largestFrameRatio: 0.6 }),
    6,
    5000,
  );
  check('[覆盖] 挂大框架但内容充足，不误报', framedButRich === null);

  const pdf = describeCoverage(structure({ pdfEmbeds: 2 }), 6, 5000);
  const pdfText = pdf?.lines.join('\n') ?? '';
  check('[覆盖] 嵌入 PDF 时给出说明', pdf !== null);
  check('[覆盖] 报出 PDF 处数 2', pdfText.includes('2 处 PDF'));
  check('[覆盖] 说明 PDF 不在色板覆盖范围', pdfText.includes('不在色板覆盖范围内'));

  console.log('  frameset 用例文字：');
  console.log(`    ${framesetText.replace(/\n/g, '\n    ')}`);
  console.log('  大框架用例文字：');
  console.log(`    ${framedText.replace(/\n/g, '\n    ')}`);
  console.log('  PDF 用例文字：');
  console.log(`    ${pdfText.replace(/\n/g, '\n    ')}`);
  console.log('');
}

// ---------------------------------------------------------------------
// 用例六：这一层绝不能产出颜色
// ---------------------------------------------------------------------
{
  const all = [
    describeCoverage(structure({ framesetDocument: true }), 1, 0),
    describeCoverage(structure({ largeFrames: 1, largestFrameRatio: 0.9 }), 0, 10),
    describeCoverage(structure({ pdfEmbeds: 3 }), 0, 10),
  ]
    .map((n) => n?.lines.join('\n') ?? '')
    .join('\n');

  const hexes = all.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];

  console.log('='.repeat(64));
  console.log('用例六　覆盖说明里不得出现色值');
  console.log('='.repeat(64));
  console.log(hexes.length === 0 ? '  (未出现任何十六进制色值，符合预期)' : `  出现了 ${hexes.join(', ')}`);
  console.log('');

  check('[不含色值] 覆盖说明里没有十六进制色值', hexes.length === 0);
}

// ---------------------------------------------------------------------
// 用例七：只采到外壳
//
// 这是本轮修掉的一条真实缺陷。IEEE 的取件地址是「外壳 + 框架」结构，
// 顶层几乎不承载内容，但照样有白色底和默认黑字，颜色角色轻松凑够两个。
// 旧判定要求 colorCount < 2 才提示，于是条件一进去就不成立，结果页
// 显示成一个完全正常的结果，色板里只有一个白，用户以为工具坏了。
//
// 修法是把判据从「颜色少」换成「顶层文字少」，因为承载内容的文档
// 直接文字轻松上千，而外壳页往往一个字都没有，两者差着数量级。
// ---------------------------------------------------------------------
{
  console.log('='.repeat(64));
  console.log('用例七　只采到外壳的页面');
  console.log('='.repeat(64));

  // 颜色数正常（白底 + 黑字），但顶层一个字都没有，框架还跨域
  const shellBlocked = describeCoverage(
    structure({ largeFrames: 1, largestFrameRatio: 0.95, blockedFrames: 1 }),
    2,
    0,
  );
  const shellBlockedText = shellBlocked?.lines.join('\n') ?? '';
  check('[缺陷三] 颜色数正常的外壳页面也要给出说明', shellBlocked !== null);
  check('[缺陷三] 外壳页面判为严重', shellBlocked?.severe === true);
  check('[缺陷三] 区分出框架跨域读不到', shellBlockedText.includes('不同域名'));

  // 同源框架已经读入，措辞必须不一样，否则用户以为扩展压根没试过
  const shellRead = describeCoverage(
    structure({ largeFrames: 1, largestFrameRatio: 0.9, sameOriginFrames: 1 }),
    2,
    40,
  );
  const shellReadText = shellRead?.lines.join('\n') ?? '';
  check('[覆盖] 同源框架读入后改用另一种措辞', shellReadText.includes('已经一并读入'));

  // 文字量字段缺失时按「不稀疏」处理，宁可不提示也不要凭不完整数据误报
  const noText = describeCoverage(
    structure({ largeFrames: 1, largestFrameRatio: 0.9 }),
    6,
    undefined,
  );
  check('[覆盖] 文字量缺失时不误判为外壳', noText === null);

  // 顶层文档本身就是 PDF 的兜底分支。正常会被地址预判拦下，这里防漏网
  const topPdf = describeCoverage(structure({ contentType: 'application/pdf' }), 1, 0);
  const topPdfText = topPdf?.lines.join('\n') ?? '';
  check('[覆盖] 顶层文档是 PDF 时给出说明', topPdfText.includes('顶层文档本身就是 PDF'));

  // 嵌入 PDF 和顶层是 PDF 是两回事，不能同时输出两段重复的解释
  const bothPdf = describeCoverage(
    structure({ contentType: 'application/pdf', pdfEmbeds: 2 }),
    1,
    0,
  );
  const bothText = bothPdf?.lines.join('\n') ?? '';
  check('[覆盖] 顶层是 PDF 时不再重复嵌入说明', !bothText.includes('本页嵌入了'));

  console.log('  跨域框架用例文字：');
  console.log(`    ${shellBlockedText.replace(/\n/g, '\n    ')}`);
  console.log('  同源已读入用例文字：');
  console.log(`    ${shellReadText.replace(/\n/g, '\n    ')}`);
  console.log('');
}

// ---------------------------------------------------------------------
// 用例八：采样口径
//
// 全部数值都是某个宽度下的渲染计算值，这个前提不写出来，读文件的人会把
// 一份 1440 宽下的结论当成站点的设计原值。这一组用例锁住说明说了什么、
// 以及宽度读不到时坚决不声明。
// ---------------------------------------------------------------------

console.log('='.repeat(64));
console.log('用例八　采样口径');
console.log('='.repeat(64));
{
  const vp = describeViewport(1440);
  const vpText = vp?.lines.join('\n') ?? '';

  check('[口径] 正常宽度给出说明', vp !== null);
  check('[口径] 宽度原样带出', vp?.width === 1440);
  check(
    '[口径] 点出数值是渲染计算值而非样式表声明值',
    vpText.includes('计算值') && vpText.includes('不是样式表'),
  );
  check('[口径] 点出响应式页面换宽度会变', vpText.includes('别的窗口宽度'));
  check('[口径] 给出换宽度再采一次这个动作', vpText.includes('再采一次'));
  // 数字只由 width 给，说明里不再重复一遍。两处都写早晚会分叉，
  // 而分叉在这里的表现是「说明里说 1440、字段里是 640」，几乎看不出来。
  check('[口径] 说明里不重复宽度数字', !vpText.includes('1440'));

  // 设备像素比折算出来的小数宽度不该原样写进说明
  check('[口径] 小数宽度取整', describeViewport(1439.5)?.width === 1440);

  // 读不到宽度时不声明，宁可不说，也不要给一份看起来可复现、实际不对的口径
  check('[口径] 宽度为 0 时不声明', describeViewport(0) === null);
  check('[口径] 宽度为负时不声明', describeViewport(-100) === null);
  check('[口径] 宽度缺失时不声明', describeViewport(undefined) === null);
  check('[口径] NaN 不声明', describeViewport(Number.NaN) === null);

  console.log('  口径说明文字：');
  console.log(`    ${vpText.replace(/\n/g, '\n    ')}`);
  console.log('');
}

console.log('='.repeat(64));
console.log('断言结果');
console.log('='.repeat(64));
for (const line of report) console.log(line);
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项未通过`);

process.exit(failed === 0 ? 0 : 1);
