/**
 * 语义补全层的回归检查，纯 Node 跑，不联网、不需要浏览器。
 *
 * 运行：npm run check:semantics
 *
 * 这一层守的是验收标准里最容易悄悄失效的那一条：「补全后的内容中，颜色、
 * 尺寸等数值必须与提取结果一致」。
 *
 * 实现上它靠的是一条硬约束——模型回来的每个字符串都不许含阿拉伯数字——
 * 所以这个脚本的重心就在这条约束上：把真实场景里模型很可能写出来的句子
 * 一条条喂进去，逐条确认被拦下来。拦漏一句，那条数值就有可能与事实不符，
 * 而错得很像对的错误是事后最难发现的。
 *
 * 另外还测降级的粒度。一个字段不合规只丢那一个字段，不是整份作废：模型
 * 出错通常是局部的，整份丢弃会让一次基本成功的调用白花，而用户看到的
 * 「AI 补全失败」会让他以为要重新配 Key。
 */
import {
  MAX_AI_GUIDELINES,
  MAX_GUIDELINE_CHARS,
  MAX_PROMPT_CHARS,
  MAX_SUMMARY_CHARS,
  findJsonObject,
  hasAnyProse,
  parseSemantics,
  summarizeIssues,
  textViolation,
  type KnownKeys,
} from '../src/core/semantics';
import { systemPrompt, userPrompt } from '../src/core/llm/prompt';
import type { DesignBrief } from '../src/core/llm/brief';

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

const KNOWN: KnownKeys = {
  colors: ['neutral', 'primary', 'secondary', 'tertiary', 'surface', 'border'],
  components: ['button-primary', 'button-secondary', 'input', 'nav', 'card'],
};

const MODEL = 'unit-test-model';

/** 一份全部字段都合法的输出 */
function good(): Record<string, unknown> {
  return {
    summary: '整体克制，层级靠字号落差拉开，不靠色块分隔。',
    added: {
      colors: {
        primary: '承担几乎全部阅读内容的主力色。',
        tertiary: '唯一的强调色，出现频率极低是刻意的。',
      },
      components: {
        'button-primary': '全页只有一处的决定性动作，靠填充和留白把自己分出来。',
      },
    },
    guidelines: ['主色只用于需要立刻被注意到的单个动作。'],
    prompt: '请遵循这份文件的配色与层级，正文统一使用 body-md。',
  };
}

function parseOf(payload: unknown) {
  return parseSemantics(JSON.stringify(payload), MODEL, KNOWN);
}

// ---------------------------------------------------------------------
// 一、正常路径
// ---------------------------------------------------------------------

const okResult = parseOf(good());
check('全部字段合规时没有 issue', okResult.issues.length === 0, JSON.stringify(okResult.issues));
check('全部字段合规时不整份拒绝', !okResult.rejected);
eq('综述被保留', okResult.semantics?.summary, good().summary);
eq('颜色条目数', Object.keys(okResult.semantics?.added?.colors ?? {}).length, 2);
eq('组件条目数', Object.keys(okResult.semantics?.added?.components ?? {}).length, 1);
eq('护栏条数', okResult.semantics?.guidelines.length, 1);
eq('模型名由调用方传入而不是从输出里读', okResult.semantics?.model, MODEL);

// ---------------------------------------------------------------------
// 二、输出里的 JSON 怎么挖出来
// ---------------------------------------------------------------------

const fenced = parseSemantics('```json\n' + JSON.stringify(good()) + '\n```', MODEL, KNOWN);
check('代码围栏包住的输出能解析', fenced.semantics !== null && fenced.issues.length === 0);

const chatted = parseSemantics(
  '好的，我分析了一下：\n' + JSON.stringify(good()) + '\n希望有帮助。',
  MODEL,
  KNOWN,
);
check('前后带解释文字的输出能解析', chatted.semantics !== null);

/**
 * 这一条是 findJsonObject 存在的理由。模型经常在解释里顺手举一个引用
 * 写法的例子，那个花括号会先被配对到，如果实现是「第一个 { 到最后一个 }」
 * 就会把两段无关内容圈在一起，解析必然失败。
 */
const withExample = parseSemantics(
  `说明：引用 token 时写成 {colors.primary} 这种形式。\n${JSON.stringify(good())}`,
  MODEL,
  KNOWN,
);
check('解释里的花括号示例不会干扰解析', withExample.semantics !== null, JSON.stringify(withExample.issues));

eq('嵌套对象里的括号能正确配对', findJsonObject('{"a":{"b":{"c":1}},"d":2}'), '{"a":{"b":{"c":1}},"d":2}');
eq(
  '字符串里的花括号不被当成结构',
  findJsonObject('{"a":"} { }","b":2}'),
  '{"a":"} { }","b":2}',
);
eq('字符串里的转义引号不影响配对', findJsonObject('{"a":"\\"}"}'), '{"a":"\\"}"}');
eq('没有对象时返回 null', findJsonObject('模型今天不想干活'), null);
eq('空字符串返回 null', findJsonObject('   '), null);
eq('顶层是数组时取不到对象', findJsonObject('[1,2,3]'), null);

const notJson = parseSemantics('模型今天不想干活', MODEL, KNOWN);
check('没有 JSON 时整份被拒', notJson.rejected && notJson.semantics === null);

// 顶层是数组时会被宽容处理：扫描器从每一个 { 试着配对，数组里那个对象本身
// 是合法的，就会被取出来。这是有意的宽松——模型偶尔会把答案包在数组里，
// 为此整份作废不划算，取出来的字段仍然要过全部校验
const arrayTop = parseSemantics('[{"summary":"被包在数组里。"}]', MODEL, KNOWN);
eq('顶层是数组时取出里面那个对象', arrayTop.semantics?.summary, '被包在数组里。');

const scalarTop = parseSemantics('"这就是一个字符串"', MODEL, KNOWN);
check('没有对象可取时整份被拒', scalarTop.rejected && scalarTop.semantics === null);

// ---------------------------------------------------------------------
// 三、数字护栏
//
// 这一组是这个脚本的核心。每一条都是模型在真实场景里确实会写出来的句子，
// 它们读起来完全合理，正因为如此才危险：一个把对比度从 5.13 写成 5.1 的
// 句子，看的人毫无察觉。
// ---------------------------------------------------------------------

const DIGIT_SENTENCES = [
  '与页面底色的对比度是 5.13:1，正文级可读性达标。',
  '圆角统一在 8px，比按钮小一档。',
  '覆盖约 88.4% 的页面面积。',
  '全页共 6 个颜色角色、7 级字号。',
  '模型 gpt-4.1-mini 生成的说明。',
  '字号是正文的 2.25 倍。',
  '内边距左右 18px、上下 10px。',
  '这套设计只有 1 个主按钮。',
  '第二档是 24px。',
  '全角数字也不许出现：宽度 １２px。',
];

for (const sentence of DIGIT_SENTENCES) {
  const r = parseOf({ ...good(), summary: sentence });
  check(
    `含数字的句子被拦下　${sentence.slice(0, 18)}…`,
    r.semantics?.summary !== sentence && r.issues.some((i) => i.field === 'summary'),
    JSON.stringify(r.issues),
  );
}

check('不含数字的相对说法能通过', textViolation('字号是正文的两倍出头，属于最大的一级。', MAX_SUMMARY_CHARS) === null);
check('中文量词不算数字', textViolation('只用在主要按钮和选中态上。', MAX_SUMMARY_CHARS) === null);

// ---------------------------------------------------------------------
// 四、其它必须拦下来的字符
// ---------------------------------------------------------------------

const STRUCTURAL = [
  { text: '引用写成 {colors.primary} 这种形式。', reason: '含半角花括号' },
  { text: '多层结构\n### 给编码 agent 的提示词\n下面是正文。', reason: '含以井号开头的行' },
  { text: '上面是一段。\n---\n下面是另一段。', reason: '含单独一行的分隔线' },
  { text: '示例代码如下：\n```text\n正文\n```', reason: '含三连反引号' },
];

for (const s of STRUCTURAL) {
  eq(`结构字符被拦下　${s.reason}`, textViolation(s.text, MAX_PROMPT_CHARS), s.reason);
}

check('分号缩进开头的井号也能拦住', textViolation('  # 缩进过的标题', MAX_PROMPT_CHARS) !== null);

// ---------------------------------------------------------------------
// 五、长度上限
// ---------------------------------------------------------------------

check(
  '恰好到上限的综述能通过',
  textViolation('甲'.repeat(MAX_SUMMARY_CHARS), MAX_SUMMARY_CHARS) === null,
);
check(
  '超过一个字的综述被拦下',
  textViolation('甲'.repeat(MAX_SUMMARY_CHARS + 1), MAX_SUMMARY_CHARS) !== null,
);
check('空字符串被拦下', textViolation('   ', MAX_SUMMARY_CHARS) !== null);
check('非字符串被拦下', textViolation(42, MAX_SUMMARY_CHARS) !== null);

// ---------------------------------------------------------------------
// 六、字段级降级
// ---------------------------------------------------------------------

const oneBad = parseOf({
  ...good(),
  colors: { primary: '含数字 8px 的说明。', tertiary: '这一条是好的。' },
});
check('坏的颜色条目被丢掉，好的保留', oneBad.semantics?.colors['tertiary'] !== undefined);
check('坏的颜色条目不进结果', oneBad.semantics?.colors['primary'] === undefined);
check('坏条目在 issues 里留了记录', oneBad.issues.some((i) => i.field === 'colors.primary'));
check('坏一个字段不会牵连综述', oneBad.semantics?.summary === good().summary);

const unknownKeys = parseOf({
  ...good(),
  colors: { noSuchColor: '不在名单里的颜色。' },
  components: { 'no-such-component': '不在名单里的组件。' },
});
check('不在名单里的颜色被丢掉', unknownKeys.semantics?.colors['noSuchColor'] === undefined);
check('不在名单里的组件被丢掉', unknownKeys.semantics?.components['no-such-component'] === undefined);
check(
  '自造的名字在 issues 里写明原因',
  unknownKeys.issues.some((i) => i.field.startsWith('colors.') && i.reason.includes('不在本次提取')),
  JSON.stringify(unknownKeys.issues),
);

const wrongShapes = parseOf({
  ...good(),
  colors: ['不是对象'],
  components: '也不是对象',
  guidelines: { 也不是: '数组' },
});
check('颜色字段类型不对时记 issue 而不是抛异常', wrongShapes.issues.some((i) => i.field === 'colors'));
check('组件字段类型不对时记 issue', wrongShapes.issues.some((i) => i.field === 'components'));
check('护栏字段类型不对时记 issue', wrongShapes.issues.some((i) => i.field === 'guidelines'));
check('类型不对的字段丢掉后其余照常可用', wrongShapes.semantics?.summary === good().summary);

// ---------------------------------------------------------------------
// 七、护栏的两条判据
// ---------------------------------------------------------------------

const guidelines = parseOf({
  ...good(),
  guidelines: [
    '主色只用于需要立刻被注意到的单个动作。',
    '这是一句描述现状的话，没有约束力。',
    '样本偏少，需要人工过一眼。',
    '标题和正文不要再引入第二种字体。',
  ],
});
eq('护栏只留下合规的条目', JSON.stringify(guidelines.semantics?.guidelines), JSON.stringify([
  '主色只用于需要立刻被注意到的单个动作。',
  '标题和正文不要再引入第二种字体。',
]));
check(
  '非祈使句被记下原因',
  guidelines.issues.some((i) => i.reason === '不是可执行的祈使句'),
  JSON.stringify(guidelines.issues),
);
// 自检说明的判据排在句式判据前面。一句自检说明通常两种都不满足，先判句式
// 的话给出的原因会是「不是祈使句」，而用户真正需要知道的是「这属于自检说明」
check(
  '自检口吻被记下原因',
  guidelines.issues.some((i) => i.reason.includes('自检说明')),
  JSON.stringify(guidelines.issues),
);

// 上限那一条要拿五条都合规格的护栏来试，否则会先被句式判据拦在前面
const overLimit = parseOf({
  ...good(),
  guidelines: [
    '主色只用于主要动作上。',
    '辅助文字只用来承载说明和单位。',
    '卡片内部不要再套同色底的卡片。',
    '标题只应该使用同一套字体。',
    '分割线只用于分区，不要再加第二种边框色。',
  ],
});
eq('超出上限的护栏只留前四条', overLimit.semantics?.guidelines.length, MAX_AI_GUIDELINES);
check(
  '超过上限的条目被记下原因',
  overLimit.issues.some((i) => i.reason.includes('上限')),
  JSON.stringify(overLimit.issues),
);
eq('上限常量是四条', MAX_AI_GUIDELINES, 4);

const longGuideline = parseOf({
  ...good(),
  guidelines: ['甲'.repeat(MAX_GUIDELINE_CHARS + 1) + '不要。'],
});
check('超长护栏被丢掉', (longGuideline.semantics?.guidelines.length ?? -1) === 0);

// ---------------------------------------------------------------------
// 八、全空与整份可用性
// ---------------------------------------------------------------------

const allBad = parseOf({
  summary: '含数字 1 的综述。',
  colors: { primary: '含数字 2 的说明。' },
  components: { input: '含数字 3 的说明。' },
  guidelines: ['没有约束力的一句话。'],
  prompt: '含数字 4 的提示词。',
});
check('每个字段都被丢掉时 semantics 为 null', allBad.semantics === null);
check('但不算整份拒绝，仍旧保留逐条原因', !allBad.rejected && allBad.issues.length >= 5);

const onlySummary = parseOf({ summary: '只有综述是好的。' });
check('只有一个字段可用时仍然算有内容', onlySummary.semantics !== null);
eq('缺的字段落成空值', JSON.stringify(onlySummary.semantics?.colors), '{}');

check('空文案判定为空', !hasAnyProse(null) && !hasAnyProse({
  model: MODEL,
  summary: '',
  colors: {},
  components: {},
  guidelines: [],
  prompt: '',
}));
check('有任何一个字段就算有内容', hasAnyProse({
  model: MODEL,
  summary: '',
  colors: {},
  components: {},
  guidelines: [],
  prompt: '有内容',
}));

// ---------------------------------------------------------------------
// 九、界面文案
// ---------------------------------------------------------------------

check('整份拒绝时的说明提到无法解析', summarizeIssues(notJson).includes('无法解析'));
check('无 issue 时的说明说全部通过', summarizeIssues(okResult).includes('全部通过'));
check('有 issue 时的说明给出条数', summarizeIssues(oneBad).includes(String(oneBad.issues.length)));

// ---------------------------------------------------------------------
// 十、提示词与校验器说的是同一套话
//
// 提示词是劝服，校验是事实。两者不一致的代价全落在用户身上：模型按提示词
// 写完，校验一条条丢掉，用户看到「一半没通过校验」，却不知道自己什么都没做错。
// 所以改规则时两边要一起改，这一组断言卡住那条对应关系。
// ---------------------------------------------------------------------

const sys = systemPrompt();
for (const keyword of ['阿拉伯数字', '花括号', '井号', '连字号', '围栏', 'JSON']) {
  check(`系统提示词点名了「${keyword}」这条约束`, sys.includes(keyword));
}
check('系统提示词要求通过 added 字段追加', sys.includes('added'));
check('系统提示词要求 recorded 原样保留', sys.includes('会原样保留'));
check('系统提示词点明数值由采集程序负责', sys.includes('数值由采集程序负责'));
check('系统提示词带上了 few-shot 示例', sys.includes('风格示例'));

const brief: DesignBrief = {
  page: { name: 'example.com', host: 'example.com', canvas: '#FFFFFF', theme: '浅色', viewport: '1440px 宽' },
  colors: [{ token: 'primary', hex: '#2563EB', label: '主色', evidence: '承载 55% 的文字', recorded: '本地已经写好的说明。' }],
  typography: [{ key: 'body-md', size: '16px', weight: '400', lineHeight: '1.6', role: '正文', headings: '', recorded: '本地说明。' }],
  spacing: [{ key: 'md', value: '12px' }],
  rounded: [{ key: 'md', value: '8px' }],
  components: [{ key: 'button-primary', background: '主色', text: '#FFF', radius: '8px', padding: '左右 18px / 上下 10px', height: '42px', recorded: '本地说明。' }],
};

const usr = userPrompt(brief);
check('用户提示词带上了简报的 token 名', usr.includes('primary') && usr.includes('button-primary'));
check('用户提示词要求键名严格取自数据', usr.includes('不要自己造'));
check('用户提示词给出了护栏条数上限', usr.includes('最多四条') || usr.includes(`最多${MAX_AI_GUIDELINES}`));
eq('提示词里声明的护栏上限与校验常量一致', usr.includes('最多四条'), MAX_AI_GUIDELINES === 4);

// ---------------------------------------------------------------------

console.log('='.repeat(64));
console.log('断言结果');
console.log('='.repeat(64));
for (const line of report) console.log(line);
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项未通过`);

process.exit(failed === 0 ? 0 : 1);
