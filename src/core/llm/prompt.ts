/**
 * 提示词。
 *
 * ── 提示词和校验器必须说同一套话 ──
 *
 * 这里写的每一条硬性要求，在 semantics.ts 里都有一条对应的校验。两边措辞
 * 尽量对齐，理由很实际：提示词是劝服，校验是事实，两者不一致的代价全落在
 * 用户身上——模型按提示词写完，校验一条条丢掉，用户看到的是「AI 补全有一半
 * 没通过校验」，却不知道自己什么都没做错。
 *
 * 所以改这里的规则时，要同步改 semantics.ts 的 TEXT_RULES 和长度上限；
 * 反之亦然。检查脚本里有断言卡住这条对应关系。
 *
 * ── 为什么反复强调「不要写数字」 ──
 *
 * 大模型的默认习惯就是给数字，而且给得很自然：「圆角统一在 8px」「对比度约
 * 5.1:1」。这些数字看着无害，但只要它出现，就有了与提取结果不一致的可能，
 * 而我们没有任何办法事后判断它写得对不对。禁掉数字之后，模型的输出不可能
 * 与事实冲突，这是唯一一条不依赖模型自觉的保证。
 */
import type { DesignBrief } from './brief';
import { briefToJson } from './brief';

/**
 * 提示词版本。
 *
 * 跟着产出走一遍，是为了在事后排查「为什么同一份页面两次结果差这么多」时
 * 能区分是换了提示词还是换了模型。它不进生成的文件，只在设置页的诊断信息里。
 */
export const PROMPT_VERSION = 'v1';

export function systemPrompt(): string {
  return [
    '你是一名设计系统工程师，任务是为一份已经提取好的设计 token 补充语义说明。',
    '输入数据来自真实网页的渲染结果，所有精确数值都已经由采集程序测定并存好了。',
    '你的产出会直接写进一份供编码 agent 阅读的 DESIGN.md 文件。',
    '',
    '以下每一条都是硬性要求，违反其中任何一条，对应的内容都会被程序丢弃：',
    '',
    '一、不许出现任何阿拉伯数字，半角和全角都不行。不要写像素值、比例、对比度倍数、',
    '    数量、版本号。数值由采集程序负责，你写数字只会和事实冲突。',
    '    需要表达程度时用「最大的一级」「略小一档」这类相对说法。',
    '二、不许出现半角花括号，这两个字符在这份文件里有特定含义。',
    '三、不许出现以井号开头的行，也不许出现单独一行的三个连字号，它们会被当成文件结构。',
    '四、不要复述输入里已经写好的 recorded 字段，那些内容会原样保留。',
    '    你只补充它没有说到的信息：这套设计为什么这样组织、复刻时最容易在哪里走样。',
    '五、只输出一个 JSON 对象。不要解释，不要前后加话，不要用代码围栏包起来。',
    '',
    '行文要求：中文，直白，具体，写给「照着这份文件复刻这套设计」的人看。',
    '不要用「现代感」「高级」「恰到好处」这类说了等于没说的形容。',
    '每一条控制在一两句话内，宁可短，不要凑字数。',
  ].join('\n');
}

export function userPrompt(brief: DesignBrief): string {
  const hasColors = brief.colors.length > 0;
  const hasComponents = brief.components.length > 0;

  const lines: string[] = [];

  lines.push(`以下是从 ${brief.page.host || brief.page.name} 采集到的设计系统数据：`);
  lines.push('');
  lines.push('```json');
  lines.push(briefToJson(brief));
  lines.push('```');
  lines.push('');
  lines.push('请输出一个 JSON 对象，包含下面这几个字段，缺哪一项就省略哪一项：');
  lines.push('');
  lines.push('summary　整体风格综述，两三句话。说清这套设计的倾向，是靠留白、靠字号落差、');
  lines.push('　　　　 还是靠色阶来拉开层次，视觉重心落在哪里。');

  if (hasColors) {
    lines.push('');
    lines.push('colors　一个对象，键是 colors 数组里的 token 名，值是这个颜色的语义角色');
    lines.push('　　　　 和使用边界。说明它在整套配色里承担什么职责，什么场合该用、什么场合不该用。');
  }

  if (hasComponents) {
    lines.push('');
    lines.push('components　一个对象，键是 components 数组里的 key，值是这类组件的形态特征');
    lines.push('　　　　 与复刻时的注意点。');
  }

  lines.push('');
  lines.push('guidelines　一个字符串数组，最多四条。写复刻这套设计时最容易犯的错，');
  lines.push('　　　　 必须是可执行的约束，用「不要」「只用于」「只应该」这类祈使句式开头或收尾。');

  lines.push('');
  lines.push('prompt　一段可以直接贴给编码 agent 的提示词，说明在这个项目里改界面时应当');
  lines.push('　　　　 遵循哪些视觉约定。可以引用 token 名，但不要写具体数值。');

  lines.push('');
  lines.push('键名必须严格取自上面的数据，不要自己造 token 名或组件名。');

  return lines.join('\n');
}

export function buildPrompt(brief: DesignBrief): { system: string; user: string } {
  return { system: systemPrompt(), user: userPrompt(brief) };
}
