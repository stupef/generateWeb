/**
 * 把端到端采到的真实样本渲染成 DESIGN.md，落到 reports/design-md-sample/。
 *
 * 运行：npm run sample:design-md
 * 前置：先跑过一次端到端，产物在 reports/e2e-sample/sample-export.json
 *
 * 单独做这一步，而不并进 design-md-check.ts，是因为那个检查脚本跑的是合成
 * 数据。合成数据的职责是卡边界，它连颜色都是手写的十六进制串；要看真实页面
 * 生成出来长什么样，必须用真实样本。
 *
 * 生成两份：
 *
 *   DESIGN.md           本地版。这才是插件在不配 Key 时会产出的东西
 *   DESIGN.ai-sample.md 带 AI 文案的版式样例，用来肉眼确认补全之后的排版
 *
 * ── 关于第二份里的文案 ──
 *
 * 它是**手写的占位文本**，不是任何一次真实的模型输出。写这一份的目的只是把
 * 补全之后文件的版式摆出来看：综述插在哪、语义补充块长什么样、提示词那段
 * 怎么排。真实调用要有 Key，不可能进自动化流程，但「补全后的文件能不能过
 * 官方 lint」这件事必须有个可重复的验证入口，这一份就是那个入口。
 *
 * 两份产物都是跑官方 linter 的输入：
 *
 *   npx @google/design.md lint reports/design-md-sample/DESIGN.md
 *   npx @google/design.md lint reports/design-md-sample/DESIGN.ai-sample.md
 *
 * 它们写在 reports/ 下，跟其它检查产物一样属于可重建的中间物，不是要被提交的
 * 原始文件。
 */
import { renderDesignMd } from '../src/core/design-md';
import type { SampleExport } from '../src/core/export';
import { collectReferences, collectSections, collectTokenPaths } from '../src/core/design-md';
import type { AiSemantics } from '../src/core/semantics';

/** 局部声明 Node 全局，理由同其它检查脚本，不为一个脚本引入 @types/node */
declare const require: (id: string) => {
  readFileSync(p: string, enc: string): string;
  mkdirSync(p: string, o: { recursive: boolean }): void;
  writeFileSync(p: string, s: string): void;
  existsSync(p: string): boolean;
};
declare const process: { exit(code?: number): void };

const fs = require('node:fs');

const SOURCE = 'reports/e2e-sample/sample-export.json';
const OUT_DIR = 'reports/design-md-sample';
const OUT_FILE = `${OUT_DIR}/DESIGN.md`;
const OUT_AI_FILE = `${OUT_DIR}/DESIGN.ai-sample.md`;

if (!fs.existsSync(SOURCE)) {
  console.error(`找不到端到端样本 ${SOURCE}，先跑一次 npm run check:e2e。`);
  process.exit(1);
}

const sample = JSON.parse(fs.readFileSync(SOURCE, 'utf8')) as SampleExport;
const md = renderDesignMd(sample);

/**
 * 版式样例用的占位文案。
 *
 * 全部不含阿拉伯数字，所以它能通过和真实模型输出同一套校验——这一点很重要，
 * 一份手写样例如果靠绕过校验才成立，那它证明不了任何事。
 */
const sampleSemantics: AiSemantics = {
  model: '样例文案（非模型输出）',
  summary:
    '整体走的是低对比、重留白的方向：层级几乎全部靠字号落差和间距拉开，色块只承担分区，不承担强调。' +
    '全页只有一个饱和色，也只出现在一个地方，视觉重心因此非常集中。' +
    '复刻时最容易走样的是把低对比理解成弱化，从而给次要内容也加上颜色。',
  colors: {
    neutral: '整套配色的底，其余颜色都是在它之上做出的层级。不要为新增区块另起一个浅灰底。',
    primary: '承担全部阅读内容的主力色，改动它的明度会同时影响每一个层级，是牵一发动全身的一项。',
    secondary: '承载说明性质的文字，出现频率不低，但刻意压住存在感，不让它和正文抢注意力。',
    tertiary: '全页唯一的强调色，出现次数极少是刻意的。它的价值来自稀缺，一旦扩散就会立刻失效。',
    surface: '靠极小的明度差和底色分开，用来在不加阴影的前提下区分内容层次。',
    border: '分区和描边共用同一个色，靠的是形态而不是颜色深浅来区分这两种用途。',
  },
  components: {
    input: '承载用户输入的地方，四个方向都封了边，是页面上少数边界明确的形态。',
  },
  guidelines: [
    '强调色只用于需要立刻被注意到的单个动作，不要扩散到图标、标签或装饰块上。',
    '内容区块只应该使用同一套底色，新增一层浅灰底会让本来靠留白拉开的层次糊在一起。',
    '辅助文字只用来承载说明和单位，不要为了区分层级去调这一层的字体颜色。',
    '标题和正文只应该共用同一套字体，引入第二种字体会让层级判断变模糊。',
  ],
  prompt:
    '改这个项目的界面时，请遵循这份 DESIGN.md 描述的配色与排版层级。\n' +
    '正文统一使用正文那一级的字号和字重，标题按标题族逐级取用，不要临时改字号或字重。\n' +
    '强调色只允许出现在需要用户立刻做决定的单个动作上，同一屏内不要出现两个以上的强调色元素。\n' +
    '需要区分内容层次时优先用间距和留白，其次才考虑加描边，不要新增底色层。',
};

const aiMd = renderDesignMd(sample, sampleSemantics);

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT_FILE, md);
fs.writeFileSync(OUT_AI_FILE, aiMd);

/**
 * 两份文件的主要差异应当只有补全的那几块，token 块必须一字未动，正文里的
 * 数字也必须一个不多一个不少。这里把它们摆出来，是因为这一步不产出断言，
 * 是给人看的最后一道肉眼防线。
 */
function summarize(label: string, file: string, text: string): void {
  const paths = new Set(collectTokenPaths(text));
  const broken = collectReferences(text).filter((r) => !paths.has(r));
  console.log(`已生成 ${file}　（${label}）`);
  console.log(`  行数 ${text.split('\n').length}`);
  console.log(`  章节 ${collectSections(text).join(' > ')}`);
  console.log(`  引用 ${collectReferences(text).length} 处，断引用 ${broken.length === 0 ? '无' : broken.join(', ')}`);
}

summarize('本地版，真实产物', OUT_FILE, md);
summarize('补全版，文案为手写占位', OUT_AI_FILE, aiMd);

const digits = (text: string) => (text.match(/\d+/g) ?? []).length;
const bodyOf = (text: string) => {
  const end = text.indexOf('\n---\n', 3);
  return end < 0 ? text : text.slice(end + 5);
};
const tokenBlockOf = (text: string) => {
  const fm = text.startsWith('---\n') ? text.slice(4, text.indexOf('\n---\n', 3)) : '';
  return fm
    .split('\n')
    .filter((l) => !l.startsWith('description:'))
    .join('\n');
};

console.log(
  `  两版的 token 块${tokenBlockOf(md) === tokenBlockOf(aiMd) ? '逐字节相同' : '不一致，需要检查'}，` +
    `正文数字个数 ${digits(bodyOf(md))} 对 ${digits(bodyOf(aiMd))}`,
);
