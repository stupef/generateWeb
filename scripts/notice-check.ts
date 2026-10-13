/**
 * 结果来源与失败动作的回归检查，纯 Node 跑，不联网、不需要浏览器。
 *
 * 运行：npm run check:notice
 *
 * 这一层守的是 B9 里最难自证的一条验收标准：「界面能让用户分辨当前结果是
 * 本地生成版还是 AI 补全版」。它不像「能导出」那样点一下就知道，界限一旦
 * 模糊，界面照常渲染，只是用户再也分不清手上是什么，而这种失效不会有人
 * 报错。所以把判断从弹窗里提到 core/llm/notice.ts，在这里逐条卡住。
 *
 * 另一件是失败之后给哪个动作。它有个具体的失效方式：把「重试」和「去设置」
 * 同时摆出来，用户得先自己判断这次失败属于哪一类，而这件事我们比他清楚；
 * 反过来只给一个但给错了，用户会陷在无效重试里。判据只有一条，就是
 * 这次失败再点一次有没有意义，所以按失败种类逐条对一遍。
 */
import { nextAction, ORIGIN_CLASS, ORIGIN_LABEL } from '../src/core/llm/notice';
import type { OriginState } from '../src/core/llm/notice';
import { failureOf } from '../src/core/llm/client';
import type { LlmFailureKind } from '../src/core/llm/types';
import { DESIGN_MD_FILENAME } from '../src/core/design-md';

declare const process: { exit(code?: number): void };

const report: string[] = [];
let failed = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failed++;
  report.push(`${ok ? '✓' : '✗'} ${name}${!ok && detail ? `　→ 实际 ${detail}` : ''}`);
}

function eq(name: string, actual: unknown, expected: unknown): void {
  const a = typeof actual === 'string' ? actual : JSON.stringify(actual);
  const e = typeof expected === 'string' ? expected : JSON.stringify(expected);
  check(name, a === e, `${a}（期望 ${e}）`);
}

const STATES: OriginState[] = ['local', 'pending', 'ai', 'fallback'];

// ---------------------------------------------------------------------
// 一、徽标分得清「本地生成版」和「AI 补全版」
// ---------------------------------------------------------------------

for (const s of STATES) {
  check(`状态 ${s} 有徽标文字`, typeof ORIGIN_LABEL[s] === 'string' && ORIGIN_LABEL[s].length > 0);
  check(`状态 ${s} 有样式类`, typeof ORIGIN_CLASS[s] === 'string' && ORIGIN_CLASS[s].length > 0);
}

// 这一对是验收标准本身：两个标签必须能被人区分开
check('补全版的徽标点名了 AI', ORIGIN_LABEL.ai.includes('AI'));
check('本地生成版的徽标不含 AI 字样', !ORIGIN_LABEL.local.includes('AI'));
check('本地生成版的徽标点名了本地', ORIGIN_LABEL.local.includes('本地'));
check('两个标签不是同一句话', ORIGIN_LABEL.ai !== ORIGIN_LABEL.local);

// 补全没跑完时不能写成「本地生成版」。此刻结果还是本地版没错，但这么写会让
// 用户以为补全已经结束、没有下文了
check('补全中的徽标没有宣称已完成', !ORIGIN_LABEL.pending.includes('AI 补全版'));
check('补全中的徽标与补全完成不是同一句话', ORIGIN_LABEL.pending !== ORIGIN_LABEL.ai);

// 试过但没成功的两份，对用户是同一件事：这份东西是本地生成的，可以放心用。
// 区别只在说明块的细节里，不该被抬到徽标上，否则同一个结论有两个说法
eq('失败退回时的徽标与本地版一致', ORIGIN_LABEL.fallback, ORIGIN_LABEL.local);

// 样式类要跟着区分度走。ai 用强调色、fallback 用警示色，两者必须不同
check('补全版与退回版用不同的样式类', ORIGIN_CLASS.ai !== ORIGIN_CLASS.fallback);
check('补全中与补全完成用不同的样式类', ORIGIN_CLASS.pending !== ORIGIN_CLASS.ai);
eq('退回到本地版时挂警示类', ORIGIN_CLASS.fallback, 'warn');

// ---------------------------------------------------------------------
// 二、失败之后给哪个动作
//
// 判据是「再点一次有没有意义」。逐类对一遍，不按 retryable 反推——
// 反推等于把被测对象自己当标准，断言会跟着实现一起错。
// ---------------------------------------------------------------------

/** 期望值按人话写：这些再点多少次都是同一个结果，只能去改配置 */
const NEEDS_SETTINGS: LlmFailureKind[] = [
  'no-key',
  'no-model',
  'bad-url',
  'permission',
  'auth',
  'not-found',
  'quota',
  'request',
  'aborted',
];

/** 这些属于当时不巧，重试是有意义的动作 */
const RETRY_MAKES_SENSE: LlmFailureKind[] = ['server', 'timeout', 'unreachable', 'shape'];

for (const kind of NEEDS_SETTINGS) {
  eq(`「${kind}」引导去设置而不是重试`, nextAction('fallback', failureOf(kind)), 'options');
}

for (const kind of RETRY_MAKES_SENSE) {
  eq(`「${kind}」引导重试而不是去设置`, nextAction('fallback', failureOf(kind)), 'run');
}

check(
  '两类不重叠且覆盖全部失败种类',
  NEEDS_SETTINGS.every((k) => !RETRY_MAKES_SENSE.includes(k)),
  JSON.stringify([NEEDS_SETTINGS, RETRY_MAKES_SENSE]),
);

// 一次只给一个动作。同时摆出两个，就等于把「这次属于哪一类」推给用户判断
for (const kind of [...NEEDS_SETTINGS, ...RETRY_MAKES_SENSE]) {
  const action = nextAction('fallback', failureOf(kind));
  check(`「${kind}」只给出一个动作`, action === 'run' || action === 'options', String(action));
}

// 调用成功但内容一处都没过校验，属于模型这次没写好，换一次可能就行
eq('内容没过校验时给重试', nextAction('fallback', null), 'run');

// 其余状态不给动作：已经拿到补全结果，或者正在等，都没有可点的下一步
eq('补全成功时不给动作', nextAction('ai', null), null);
eq('补全进行中不给动作', nextAction('pending', null), null);
// 本地版给的是「怎么开启补全」，这是唯一有意义的下一步
eq('本地版引导去设置', nextAction('local', null), 'options');
check(
  '本地版不会因为带了个失败对象就改给重试',
  nextAction('local', failureOf('timeout')) === 'options',
  String(nextAction('local', failureOf('timeout'))),
);

// ---------------------------------------------------------------------
// 三、产物的文件名
//
// B10 的验收标准是「下载的文件可以直接放进项目根目录」。这句话落在一个
// 字面量上：编码 agent 是照约定的固定路径读文件的，名字差一个字符就读不到。
// ---------------------------------------------------------------------

eq('文件名正好是规范约定的那个', DESIGN_MD_FILENAME, 'DESIGN.md');
check('文件名不含路径分隔符', !/[/\\]/.test(DESIGN_MD_FILENAME));
check('文件名没带主机名或时间戳', !/[0-9]/.test(DESIGN_MD_FILENAME));
// 大小写敏感：规范里就是 DESIGN.md，写成 design.md 在 Linux 上读不到
eq('大小写按规范写', DESIGN_MD_FILENAME, DESIGN_MD_FILENAME.toUpperCase().replace('.MD', '.md'));

// ---------------------------------------------------------------------
// 四、没有动作的那些状态
//
// 上面按失败种类覆盖了 fallback，这里补上其余状态，确认没有一个会平白多出
// 按钮。多出来比少一个更糟：用户在补全成功之后看到「重试」，会以为结果有问题。
// ---------------------------------------------------------------------

for (const s of STATES) {
  if (s === 'fallback' || s === 'local') continue;
  eq(`状态 ${s} 不带任何动作`, nextAction(s, null), null);
}

// ---------------------------------------------------------------------
// 弹窗为什么不在这个脚本里扫
//
// 「界面用的是这张表，不是自己另写一份」这条，原本想读弹窗源码去卡。
// 没做成，后来也不再需要。
//
// 没做成是因为项目没装 @types/node，tsconfig 里 types 只放了 chrome，脚本要读
// 文件得先解决 node 内建模块的类型，为一条断言去动安装配置不划算。
//
// 不需要则是因为编译器卡得更死：弹窗 import 了 ORIGIN_LABEL，它再写一个同名
// 的 const 就是 Import declaration conflicts with local declaration，tsc 直接
// 不过，而 tsc --noEmit 本来就在回归链里。拿编译期报错去替扫源码找字符串，
// 是更强的那种保障。
// ---------------------------------------------------------------------

console.log('='.repeat(64));
console.log('断言结果');
console.log('='.repeat(64));
for (const line of report) console.log(line);
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项未通过`);

process.exit(failed === 0 ? 0 : 1);
