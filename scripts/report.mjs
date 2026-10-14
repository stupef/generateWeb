/**
 * 一键跑完全部回归检查，把结果落成可归档的文件。
 *
 * 运行：npm run report
 *
 * 为什么单独做一个 runner。已有的检查散在 scripts/ 下十来个脚本里，
 * 每个都把结果打到 stdout，跑完就滚掉了。想复盘「这次改了什么、哪几条
 * 断言守着它」，只能往上翻终端回滚缓冲，翻不到就重跑一遍，而重跑一遍
 * 又要等几十秒。
 *
 * 这个脚本按固定顺序把每个检查跑一遍，捕获完整输出、退出码和耗时，汇总成
 *
 *     reports/check-report.md   人看的，总览表 + 逐条断言
 *     reports/check-report.json 机器读的，给后续对比或看板用
 *     reports/raw/<id>.log      每个脚本的原始 stdout + stderr
 *
 * 前两份每次覆盖，想按时间留档加 --keep，会另外存一份带时间戳的 md。
 *
 * 它不改变任何检查脚本的行为，只是把它们包起来。每条断言怎么算、
 * 什么算通过，仍然由脚本自己说了算；这里只负责转发和记录。
 *
 * 有两个步骤是被跳过而不是失败：
 *   · 端到端需要一份 Chromium，找不到就跳过（可用 DESIGN_MD_CHROME 指定）
 *   · 注入自包含校验需要先有构建产物，.output 不存在就跳过
 * 跳过会在总览里单独标出来，不计入未通过。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
process.chdir(root);

const NODE = process.execPath;
const JITI = path.join(root, 'node_modules', 'jiti', 'lib', 'jiti-cli.mjs');
const TSC = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');

const OUT_DIR = path.join(root, 'reports');
const RAW_DIR = path.join(OUT_DIR, 'raw');

// ---------------------------------------------------------------------
// 步骤表
// ---------------------------------------------------------------------
// 顺序基本沿用 npm run check，端到端和注入校验排到最后，因为它们最慢、
// 也最容易因为环境原因跳过。
//
//   assertions: 这个脚本是否产出「逐条断言」，false 的只记录原始输出
//   needs:      前置条件，不满足就跳过
//   group:      报告里的分组标题

const STEPS = [
  {
    id: 'diagnose',
    name: '页面可用性判定',
    group: '分析层',
    about: '读不到页面时给出的归因是否正确，含受限页面、PDF、跨域框架三类误判的防回归。',
    cmd: [NODE, JITI, 'scripts/diagnose-check.ts'],
    assertions: true,
  },
  {
    id: 'color',
    name: '色板与对比度',
    group: '分析层',
    about: 'OKLab 聚类是否把该合的合了、该分的分开了，角色分配和对比度提示是否成立。',
    cmd: [NODE, JITI, 'scripts/color-check.ts'],
    assertions: true,
  },
  {
    id: 'typography',
    name: '字体与排版层级',
    group: '分析层',
    about: '字号聚类不产生冗余档位，标题与正文的字体族区分得开，自定义字体给出替代建议。',
    cmd: [NODE, JITI, 'scripts/typography-check.ts'],
    assertions: true,
  },
  {
    id: 'spacing',
    name: '间距档位与内容宽度',
    group: '分析层',
    about: '基准间距推断合理，档位吸附不退化，内容最大宽度与页面实测一致，卡片内边距不被控件污染。',
    cmd: [NODE, JITI, 'scripts/spacing-check.ts'],
    assertions: true,
  },
  {
    id: 'effects',
    name: '圆角、边框与阴影',
    group: '分析层',
    about: '圆角按元素类型分开归纳，胶囊形单独识别，无阴影时明确说明而不是留空。',
    cmd: [NODE, JITI, 'scripts/effects-check.ts'],
    assertions: true,
  },
  {
    id: 'components',
    name: '基础组件识别',
    group: '分析层',
    about: '每个组件同时给出背景色、文字色、圆角、内边距和字体；页面上没有的组件不凭空输出。',
    cmd: [NODE, JITI, 'scripts/components-check.ts'],
    assertions: true,
  },
  {
    id: 'background',
    name: '页面底色与近色判定',
    group: '分析层',
    about: '底色识别与近乎同色的表面区分，避免把刻意做浅的层次压成一层。',
    cmd: [NODE, JITI, 'scripts/background-check.ts'],
    assertions: true,
  },
  {
    id: 'export',
    name: '导出快照组装',
    group: '分析层',
    about:
      '按导出拿到的文件里有什么。原始观测必须全量带出去，字段不许挑；界面上的结论和文件里写的必须同源；' +
      '文件名不能带非法字符，端口不能留在名字里。',
    cmd: [NODE, JITI, 'scripts/export-check.ts'],
    assertions: true,
  },
  {
    id: 'provenance',
    name: '界面数字与溯源高亮',
    group: '分析层',
    about:
      '界面上每一个数字都要能在页面上描出同样多的元素。把分析结果里每一个 token 都过一遍，' +
      '逐组断言「界面上印的数」等于「描出来的元素数」，并卡住字号簇、被吸附的间距值、' +
      '同一元素跨渠道重叠这几个边界。末了还验一遍界面上那个可点属性的编码往返。',
    cmd: [NODE, JITI, 'scripts/provenance-check.ts'],
    assertions: true,
  },
  {
    id: 'design-md',
    name: 'DESIGN.md 生成',
    group: '生成层',
    about:
      '生成出来的文件能不能过 Google 那份规范的 lint。引用不许断、章节不许乱序、顶层键不许超纲、' +
      '组件子 token 不许用白名单外的名字，护栏必须是可执行的约束而不是提取质量的自检说明。',
    cmd: [NODE, JITI, 'scripts/design-md-check.ts'],
    assertions: true,
  },
  {
    id: 'semantics',
    name: '语义补全的校验',
    group: 'AI 补全层',
    about:
      '模型回来的文案必须不含任何阿拉伯数字，这是「补全后的数值与提取结果一致」的落地方式。' +
      '另外测字段级降级：一个字段不合规只丢那一个，不牵连其余，也不整份作废。',
    cmd: [NODE, JITI, 'scripts/semantics-check.ts'],
    assertions: true,
  },
  {
    id: 'llm',
    name: '模型接入与失败归因',
    group: 'AI 补全层',
    about:
      '三种协议的请求形状、响应取值，以及全部失败分支的归因。用一个假的 fetch 把 401、404、' +
      '402、429、超时、断网、没授权、返回结构不对逐条造出来，确认每种都给出了够具体的说明。',
    cmd: [NODE, JITI, 'scripts/llm-check.ts'],
    assertions: true,
  },
  {
    id: 'notice',
    name: '结果来源与失败动作',
    group: 'AI 补全层',
    about:
      '「界面上分得清本地生成版和 AI 补全版」这条验收标准落在两张标签表上，这里逐条卡住。' +
      '另外按失败种类对一遍「该给重试还是该去设置」，并把产物的文件名钉死在规范约定的那个上。',
    cmd: [NODE, JITI, 'scripts/notice-check.ts'],
    assertions: true,
  },
  {
    id: 'frame',
    name: '文档树遍历与框架归因',
    group: '采集层',
    about: 'jsdom 跑文档树，验的是「遍历到的结构事实」对不对，含跨域框架与同源框架的分别处理。',
      cmd: [NODE, 'scripts/frame-check.mjs'],
      assertions: true,
    },
    {
      id: 'canvas',
      name: '页面底色口径',
      group: '采集层',
      about:
        'jsdom 跑真实文档树，验的是「底色取哪个值」对不对。body 声明了不透明底色、首屏却被整屏区块盖住时，' +
        '两者正好相反，这是合成数据构造不出来的一类；这里用真实采集函数跑出样本，再串上颜色分析，' +
        '确认底色、深浅判断和主要文字色三处都跟着翻过来。',
      cmd: [NODE, 'scripts/canvas-check.mjs'],
      assertions: true,
    },
  {
    id: 'e2e',
    name: '端到端采集与分析',
    group: '端到端',
    about:
      '真实 Chromium 打开验收页，按扩展同一条序列化路径注入采集函数，拿回真实样本再跑全部分析。' +
      '这一段是合成数据和 jsdom 都覆盖不到的：真实计算样式加真实布局。',
    cmd: [NODE, 'scripts/e2e-check.mjs'],
    assertions: true,
    needs: 'chromium',
  },
  {
    id: 'highlight',
    name: '高亮的真机注入与还原',
    group: '端到端',
    about:
      '把高亮函数注进真实 Chromium，逐 token 画上再擦掉，对每个元素的几何、计算样式与内联属性逐一对账。' +
      '这一段是溯源验收里唯一走真实浏览器的一段：描边和光晕画没画上、擦完是不是一字节不差，' +
      '只有这里能证。上一版就是在这里抓到「批量清除留下空 style 属性」的。',
    cmd: [NODE, 'scripts/highlight-shot.mjs'],
    assertions: true,
    needs: 'chromium',
  },
  {
    id: 'design-md-sample',
    name: '真实样本的 DESIGN.md 样例',
    group: '生成层',
    about:
      '把端到端采到的真实样本渲染成 DESIGN.md，落到 reports/design-md-sample/。这一步不产出断言，' +
      '产物是拿来人工看效果的，同时也是跑官方 linter 的输入。',
    cmd: [NODE, JITI, 'scripts/design-md-sample.ts'],
    assertions: false,
    needs: 'e2e-sample',
  },
  {
    id: 'injection',
    name: '注入函数自包含校验',
    group: '构建',
    about: '构建产物里的注入函数不含函数体外引用，在页面里不会变成 ReferenceError。',
    cmd: [NODE, 'scripts/verify-injection.mjs'],
    assertions: false,
    needs: 'build-output',
  },
  {
    id: 'entry',
    name: '入口契约',
    group: '构建',
    about:
      '点图标之后还会不会发生事情。action 上一旦挂回弹窗，chrome.action.onClicked 就不再触发，' +
      '而这件事没有编译错误、没有运行时报错，也没有哪条现有断言会响。同时卡住侧边栏的几项声明，' +
      '以及「开面板必须发在点击的同步阶段」这条手势要求。',
    cmd: [NODE, 'scripts/entry-check.mjs'],
    assertions: true,
    needs: 'build-output',
  },
  {
    id: 'compile',
    name: '类型检查',
    group: '构建',
    about: 'tsc --noEmit，不产出文件，只确认类型成立。',
    cmd: [NODE, TSC, '--noEmit'],
    assertions: false,
  },
];

// ---------------------------------------------------------------------
// 运行环境探测
// ---------------------------------------------------------------------

/** 在某个目录下找 Chrome 系可执行文件，只往 .app 结构里探一层 */
function scanChromeUnder(dir, depth = 4) {
  const found = [];
  const walk = (d, level) => {
    if (level > depth) return;
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const full = path.join(d, e.name);
      if (e.name.endsWith('.app')) {
        const macos = path.join(full, 'Contents', 'MacOS');
        let bins = [];
        try {
          bins = fs.readdirSync(macos);
        } catch {
          continue;
        }
        for (const b of bins) {
          if (/^(Google Chrome|Chromium)/.test(b)) found.push(path.join(macos, b));
        }
      } else if (!e.name.startsWith('.')) {
        walk(full, level + 1);
      }
    }
  };
  walk(dir, 0);
  return found;
}

/**
 * 找一份能用的 Chromium。先认显式指定，再认系统安装，最后认临时目录里
 * 那份用 curl 拉的 Chrome for Testing。
 *
 * 临时目录会被系统定期清理，所以它排最后；真清掉了重新拉一份即可，
 * 或者把 DESIGN_MD_CHROME 指到任何一份 Chromium 上。
 */
function findChrome() {
  const explicit = process.env.DESIGN_MD_CHROME;
  if (explicit) {
    if (fs.existsSync(explicit)) return explicit;
    console.warn(`DESIGN_MD_CHROME 指向的路径不存在：${explicit}`);
  }

  const fixed = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  for (const p of fixed) {
    if (fs.existsSync(p)) return p;
  }

  const scanned = [
    ...scanChromeUnder('/tmp/pwdl'),
    ...scanChromeUnder(path.join(process.env.HOME ?? '', '.cache', 'ms-playwright'), 3),
  ];
  if (scanned.length > 0) return scanned[0];

  return null;
}

/** 前置条件是否满足，返回 null 表示满足，返回字符串表示跳过原因 */
function skipReason(needs) {
  if (needs === 'chromium') {
    const chrome = findChrome();
    if (chrome) return null;
    return '找不到 Chromium（可用 DESIGN_MD_CHROME 指定路径）';
  }
  if (needs === 'build-output') {
    if (fs.existsSync(path.join(root, '.output'))) return null;
    return '还没有构建产物（先跑一次 npm run build）';
  }
  if (needs === 'e2e-sample') {
    if (fs.existsSync(path.join(root, 'reports', 'e2e-sample', 'sample-export.json'))) return null;
    return '还没有端到端样本（先跑一次 npm run check:e2e）';
  }
  return null;
}

// ---------------------------------------------------------------------
// 输出解析
// ---------------------------------------------------------------------

/**
 * 从脚本输出里数断言。判定标准是 report 行的首字符：
 * 十来个脚本都按 `✓ 描述` / `✗ 描述` 的形式推，只是缩进和前缀不一，
 * 所以这里先 trim 再看首字符。
 */
function parseAssertions(output) {
  const passed = [];
  const failed = [];
  for (const raw of output.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('✓')) passed.push(line.slice(1).trim());
    else if (line.startsWith('✗')) failed.push(line.slice(1).trim());
  }
  return { passed, failed, total: passed.length + failed.length };
}

const now = () => new Date();

function stamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

function slugStamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// ---------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------

fs.mkdirSync(RAW_DIR, { recursive: true });

const startedAt = now();
const chrome = findChrome();
const keepSnapshot = process.argv.includes('--keep');
const results = [];

console.log(`design-md-extractor 回归检查　${stamp(startedAt)}`);
console.log(`Node ${process.version}　产物目录 ${OUT_DIR}`);
console.log('');

for (const step of STEPS) {
  const skip = step.needs ? skipReason(step.needs) : null;

  if (skip) {
    results.push({ ...step, status: 'skip', reason: skip, output: '', ms: 0, passed: [], failed: [] });
    console.log(`○ ${step.name}　跳过：${skip}`);
    continue;
  }

  const env = { ...process.env };
  if (step.id === 'e2e' || step.id === 'highlight') {
    if (chrome) env.DESIGN_MD_CHROME = chrome;
  }

  const t0 = Date.now();
  const proc = spawnSync(step.cmd[0], step.cmd.slice(1), {
    cwd: root,
    env,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: 300_000,
  });
  const ms = Date.now() - t0;

  const output = [proc.stdout ?? '', proc.stderr ?? ''].filter(Boolean).join('\n').trimEnd();
  const code = proc.status ?? (proc.error ? 1 : 0);
  const parsed = step.assertions ? parseAssertions(output) : { passed: [], failed: [], total: 0 };

  // 超时或启动失败时 proc.stdout 可能是空的，补一句进去，不然报告里是一片空白
  let note = '';
  if (proc.error) note = `进程未能正常结束：${proc.error.message}`;
  else if (proc.signal) note = `进程被信号终止：${proc.signal}`;

  const ok = code === 0 && parsed.failed.length === 0 && !note;
  const status = ok ? 'pass' : 'fail';

  const result = { ...step, status, reason: note, output, ms, code, ...parsed };
  results.push(result);

  fs.writeFileSync(path.join(RAW_DIR, `${step.id}.log`), `${output}\n`, 'utf8');

  const mark = status === 'pass' ? '✓' : '✗';
  const tally = step.assertions ? `　${parsed.passed.length}/${parsed.total} 条` : '';
  console.log(`${mark} ${step.name}${tally}　${(ms / 1000).toFixed(1)}s${note ? `　${note}` : ''}`);
}

const endedAt = now();
const elapsed = (endedAt - startedAt) / 1000;

// ---------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------

const ran = results.filter((r) => r.status !== 'skip');
const failedSteps = results.filter((r) => r.status === 'fail');
const totalAssertions = results.reduce((n, r) => n + r.passed.length + r.failed.length, 0);
const totalPassed = results.reduce((n, r) => n + r.passed.length, 0);
const totalFailed = results.reduce((n, r) => n + r.failed.length, 0);
const allGreen = failedSteps.length === 0;

// ---------------------------------------------------------------------
// 落盘：JSON
// ---------------------------------------------------------------------

const json = {
  generatedAt: endedAt.toISOString(),
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  elapsedSeconds: Number(elapsed.toFixed(1)),
  chrome: chrome ?? null,
  summary: {
    steps: results.length,
    ran: ran.length,
    passed: ran.length - failedSteps.length,
    failed: failedSteps.length,
    skipped: results.length - ran.length,
    assertions: totalAssertions,
    assertionsPassed: totalPassed,
    assertionsFailed: totalFailed,
    allGreen,
  },
  steps: results.map((r) => ({
    id: r.id,
    name: r.name,
    group: r.group,
    status: r.status,
    reason: r.reason || null,
    elapsedMs: r.ms,
    exitCode: r.code ?? null,
    assertionTotal: r.passed.length + r.failed.length,
    assertionPassed: r.passed.length,
    assertionFailed: r.failed.length,
    passed: r.passed,
    failed: r.failed,
  })),
};

fs.writeFileSync(path.join(OUT_DIR, 'check-report.json'), JSON.stringify(json, null, 2) + '\n', 'utf8');

// ---------------------------------------------------------------------
// 落盘：Markdown
// ---------------------------------------------------------------------

const esc = (s) => String(s).replace(/\|/g, '\\|');

const lines = [];
lines.push('# design-md-extractor 回归检查报告');
lines.push('');
lines.push(`生成时间 ${stamp(endedAt)}　总耗时 ${elapsed.toFixed(1)} 秒`);
lines.push('');
lines.push(`运行环境 Node ${process.version}　${process.platform}-${process.arch}`);
if (chrome) lines.push('');
if (chrome) lines.push(`端到端所用浏览器 ${chrome}`);
lines.push('');

lines.push('## 结果总览');
lines.push('');
lines.push(
  allGreen
    ? `全部通过。${ran.length} 个检查、${totalAssertions} 条断言，无一失败。`
    : `${failedSteps.length} 个检查未通过，共 ${totalFailed} 条断言失败。`,
);
lines.push('');

lines.push('| 检查 | 分组 | 断言 | 通过 | 失败 | 用时 | 结果 |');
lines.push('| --- | --- | ---: | ---: | ---: | ---: | --- |');
for (const r of results) {
  const n = r.passed.length + r.failed.length;
  const badge = r.status === 'pass' ? '通过' : r.status === 'fail' ? '未通过' : '跳过';
  lines.push(
    `| ${esc(r.name)} | ${r.group} | ${n || '—'} | ${n ? r.passed.length : '—'} | ` +
      `${r.failed.length || '—'} | ${(r.ms / 1000).toFixed(1)}s | ${badge} |`,
  );
}
lines.push(
  `| **合计** |  | **${totalAssertions}** | **${totalPassed}** | **${totalFailed}** | ` +
    `**${elapsed.toFixed(1)}s** | ${allGreen ? '**全绿**' : '**有失败**'} |`,
);
lines.push('');

// 每个检查守的是什么，集中列一份。总结时不用往下翻几十屏去拼
lines.push('## 覆盖范围');
lines.push('');
for (const r of results) {
  const tag = r.status === 'skip' ? '（本次跳过）' : '';
  lines.push(`- **${r.name}**　${r.about ?? ''}${tag}`);
}
lines.push('');

// 未通过明细放前面，要查的时候第一眼就能看到
if (failedSteps.length > 0) {
  lines.push('## 未通过明细');
  lines.push('');
  for (const r of failedSteps) {
    lines.push(`### ${r.name}`);
    lines.push('');
    if (r.reason) lines.push(`执行异常 ${r.reason}`);
    if (r.reason) lines.push('');
    if (r.failed.length > 0) {
      for (const f of r.failed) lines.push(`- ${f}`);
      lines.push('');
    }
    if (r.failed.length === 0) {
      lines.push('该检查不逐条记断言，或断言在进程启动前就断了。详情见该模块的原始输出。');
      lines.push('');
    }
  }
}

// 跳过项也单独说一声，免得看的人以为漏跑了
const skipped = results.filter((r) => r.status === 'skip');
if (skipped.length > 0) {
  lines.push('## 已跳过');
  lines.push('');
  for (const r of skipped) lines.push(`- ${r.name}　${r.reason}`);
  lines.push('');
}

lines.push('## 各模块详细输出');
lines.push('');
lines.push('下面是每个检查的原始输出，逐条断言都在里面。需要复盘某一条为什么这么判，看这里。');
lines.push('');

const groups = [...new Set(results.map((r) => r.group))];
let stepNo = 0;
for (const g of groups) {
  lines.push(`### ${g}`);
  lines.push('');
  for (const r of results.filter((x) => x.group === g)) {
    stepNo++;
    const n = r.passed.length + r.failed.length;
    const head =
      r.status === 'pass'
        ? `通过${n ? `（${n} 条）` : ''}`
        : r.status === 'fail'
          ? `未通过${r.failed.length ? `（失败 ${r.failed.length} 条）` : ''}`
          : `跳过`;
    lines.push(`#### ${stepNo}. ${r.name}　${head}　${(r.ms / 1000).toFixed(1)}s`);
    lines.push('');
    if (r.about) {
      lines.push(r.about);
      lines.push('');
    }
    if (r.status === 'skip') {
      lines.push(`跳过原因 ${r.reason}`);
      lines.push('');
      continue;
    }
    const body = r.output || '(无输出)';
    lines.push('<details>');
    lines.push(`<summary>展开 ${n ? `${n} 条断言` : '原始输出'}</summary>`);
    lines.push('');
    lines.push('```text');
    lines.push(body);
    lines.push('```');
    lines.push('');
    lines.push('</details>');
    lines.push('');
  }
}

lines.push('---');
lines.push('');
lines.push(
  `原始输出另存于 reports/raw/，本报告与 reports/check-report.json 由 ` +
    `\`npm run report\` 于 ${stamp(endedAt)} 生成。`,
);
lines.push('');

fs.writeFileSync(path.join(OUT_DIR, 'check-report.md'), lines.join('\n'), 'utf8');

// 带时间戳的那一份，方便多次运行之间横向对比，要留档才写
if (keepSnapshot) {
  fs.copyFileSync(
    path.join(OUT_DIR, 'check-report.md'),
    path.join(OUT_DIR, `check-report-${slugStamp(endedAt)}.md`),
  );
}

console.log('');
console.log(
  allGreen
    ? `全部通过：${ran.length} 个检查、${totalAssertions} 条断言，用时 ${elapsed.toFixed(1)}s`
    : `${failedSteps.length} 个检查未通过（共 ${totalFailed} 条断言失败），用时 ${elapsed.toFixed(1)}s`,
);
console.log(`报告已写入 reports/check-report.md（总耗时 ${elapsed.toFixed(1)}s）`);

process.exit(allGreen ? 0 : 1);
