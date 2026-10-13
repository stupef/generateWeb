/**
 * 大模型补全内容的形状、解析与校验。
 *
 * ── 这份文件守的是验收标准里的那一条 ──
 *
 * 「补全后的内容中，颜色、尺寸等数值必须与提取结果一致」。
 *
 * 常规做法是把提取结果连同数值一起给模型，让它写一段包含数值的文字，然后
 * 祈祷它别抄错。这个做法不可靠：模型会四舍五入、会换算单位、会把 5.13 写成
 * 5.2，而且错得很不像错，读的人根本发现不了。
 *
 * 这里换了一条路：**模型永远不写数值**。发给它的简报里有全部数值（它需要
 * 上下文才能写出有用的语义），但它回来的每一个字符串都不允许出现阿拉伯
 * 数字，违规的字段直接丢掉。于是「数值一致」不再是一条需要祈祷的性质，
 * 而是一个结构性结论：正文里的数字全部来自本地分析层，模型没有任何途径
 * 改动它们。
 *
 * 这条约束能被机器验证，而且验证成本极低：把带 AI 文案和不带 AI 文案的两份
 * 输出放在一起比，front matter 的 token 块应当逐字节相同，正文里的数字多重集
 * 应当完全一致。检查脚本里就是这两条断言。
 *
 * ── 字段级降级 ──
 *
 * 一个字段不合规只丢那一个字段，其余照用。整份解析不出来（不是 JSON、
 * 顶层不是对象）才整体退到本地版。理由是模型出错通常是局部的：颜色的语义
 * 命名写飞了，不代表风格综述也没用。整份丢弃会让一次基本成功的调用白花。
 */
import { IMPERATIVE, SELF_INSPECTION } from './design-md';

/*
 * 上面这个 import 的依赖方向是刻意的，说明一下，免得后人以为写反了。
 *
 * 护栏的两条判据（祈使句式、自检口吻）由生成器定义，因为生成器是它们的
 * 使用现场，检查脚本原本也是从那边引的。校验端要用同一份判据，只能反过来
 * 引生成器。两个模块不能互相引值，会成环，所以设计成单向：
 *
 *   semantics.ts  --值-->  design-md.ts
 *   design-md.ts  --类型--> semantics.ts     （import type，编译期擦除）
 *
 * 值只往一个方向流，运行时就不存在循环。design-md.ts 那边用的是
 * `import type { AiSemantics }`，加任何新的跨模块引用时请保持这条约定。
 */

/** 模型补出来的文案。全部字段都是「可以缺」的 */
export interface AiSemantics {
  /** 产出这份文案的模型名。只用于界面标注和 front matter 的来源说明 */
  model: string;
  /** 风格综述，两三句话 */
  summary: string;
  /** 颜色 token 名到语义短句。键必须来自本次实际生成的 token */
  colors: Record<string, string>;
  /** 组件名到形态描述。键同上 */
  components: Record<string, string>;
  /** 追加的护栏条目，与本地条目合并 */
  guidelines: string[];
  /** 给编码 agent 的提示词示例 */
  prompt: string;
}

export interface SemanticsIssue {
  /** 出问题的字段，形如 summary 或 colors.tertiary */
  field: string;
  /** 为什么丢掉它 */
  reason: string;
}

/** 本次实际生成出来的 token 名。模型提到别的名字一律不算 */
export interface KnownKeys {
  colors: string[];
  components: string[];
}

export interface SemanticsResult {
  /** 可用的部分。所有字段都被丢掉时为 null，等价于回退本地版 */
  semantics: AiSemantics | null;
  /** 逐条被丢掉的原因，界面上原样展示，让用户知道 AI 只补上了一部分 */
  issues: SemanticsIssue[];
  /** 整份不可用（不是 JSON，或顶层不是对象） */
  rejected: boolean;
}

// ---------------------------------------------------------------------
// 尺寸上限
//
// 全部按「超出即丢弃」处理，不做截断。截断会留下半句话，而半句话比缺这一条
// 更难读，还容易把「丢字段」这件事从界面上抹掉——用户看到一句读不通的话，
// 不会想到是校验拦下来的。
// ---------------------------------------------------------------------

export const MAX_SUMMARY_CHARS = 400;
export const MAX_COLOR_NOTE_CHARS = 120;
export const MAX_COMPONENT_NOTE_CHARS = 200;
export const MAX_GUIDELINE_CHARS = 160;
export const MAX_PROMPT_CHARS = 1200;

/**
 * 追加护栏的条数上限。
 *
 * 生成器那边总共只放 8 条，本地条目优先占位，给 AI 留出的是这部分。定 4 是
 * 让本地条目至少还能保留 4 条，两边的分量不至于反过来。
 */
export const MAX_AI_GUIDELINES = 4;

// ---------------------------------------------------------------------
// 文本规则
// ---------------------------------------------------------------------

/**
 * 逐条禁止项。
 *
 * 数字这条是核心，理由见文件头。其余三条都是为了让这段文字能安全地嵌进
 * 一份 markdown 里：花括号会被当成 token 引用，以 # 开头的行会被当成章节
 * 标题，单独一行的 --- 会被当成 front matter 围栏，这三样任何一样漏进去
 * 都会让生成的文件结构变形。
 *
 * 数字这条同时挡掉全角数字。全角数字在中文输入法下很容易打出来，而且读起来
 * 和半角没区别，只挡半角等于留了半个口子。
 */
const TEXT_RULES: readonly { reason: string; test: (t: string) => boolean }[] = [
  { reason: '含阿拉伯数字', test: (t) => /[0-9０-９]/.test(t) },
  { reason: '含半角花括号', test: (t) => /[{}]/.test(t) },
  { reason: '含以井号开头的行', test: (t) => /^[ \t]*#/m.test(t) },
  { reason: '含单独一行的分隔线', test: (t) => /^[ \t]*-{3,}[ \t]*$/m.test(t) },
  // 提示词是用代码围栏包起来放进文件的。模型要是自己写一段三连反引号，
  // 就能把这个围栏提前关掉，后面的文字漏到围栏外面变成正文
  { reason: '含三连反引号', test: (t) => /```/.test(t) },
];

/**
 * 一段文本合不合规。合规返回 null，否则返回原因。
 *
 * 空字符串按不合规处理：模型偶尔会用空串占位，当成「这条没有」比当成
 * 「这条写完了」更贴近实际。
 */
export function textViolation(text: unknown, maxChars: number): string | null {
  if (typeof text !== 'string') return '不是字符串';
  const t = text.trim();
  if (t.length === 0) return '空内容';
  if (t.length > maxChars) return `超过 ${maxChars} 字`;
  for (const rule of TEXT_RULES) {
    if (rule.test(t)) return rule.reason;
  }
  return null;
}

// ---------------------------------------------------------------------
// 从模型输出里挖出 JSON
// ---------------------------------------------------------------------

/**
 * 找出第一个能解析成对象的 JSON 片段。
 *
 * 不能简单取「第一个 { 到最后一个 }」。模型经常在 JSON 前后各写一段解释，
 * 解释里还带着花括号示例（比如引用写法 `{colors.primary}`），取最外层会
 * 把两段无关内容一起圈进来，解析必然失败。
 *
 * 所以逐个候选扫：从每一个 { 出发，向后配对花括号，配对归零时得到一个
 * 候选片段就试着解析，第一个解析成对象的就返回。扫描过程中要跳过字符串
 * 内部的括号，否则一段文案里的引号会把配对算乱。
 *
 * 这个函数是纯的，检查脚本可以直接拿各种畸形输出来试。
 */
export function findJsonObject(raw: string): string | null {
  const text = raw.trim();
  if (text.length === 0) return null;

  // 整体就是 JSON 的话直接过，省掉后面的扫描
  const direct = tryParseObject(text);
  if (direct) return text;

  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let j = i; j < text.length; j++) {
      const c = text[j] as string;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (c === '\\' && inString) {
        escaped = true;
        continue;
      }
      if (c === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;

      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          const candidate = text.slice(i, j + 1);
          if (tryParseObject(candidate)) return candidate;
          break;
        }
      }
    }
  }

  return null;
}

function tryParseObject(text: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === 'object' && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * 把模型的原文收成一份可用的文案。
 *
 * model 由调用方传入而不是从输出里读：模型自报的身份不可信，而这一项要写进
 * front matter 的来源说明，写错了比不写更糟。
 */
export function parseSemantics(raw: string, model: string, known: KnownKeys): SemanticsResult {
  const issues: SemanticsIssue[] = [];

  const jsonText = findJsonObject(raw);
  if (jsonText === null) {
    return { semantics: null, issues: [{ field: '整体', reason: '输出里没有可解析的 JSON 对象' }], rejected: true };
  }

  const root = tryParseObject(jsonText);
  if (!root) {
    return { semantics: null, issues: [{ field: '整体', reason: '顶层不是一个 JSON 对象' }], rejected: true };
  }

  let summary = '';
  if (root.summary !== undefined) {
    const bad = textViolation(root.summary, MAX_SUMMARY_CHARS);
    if (bad) issues.push({ field: 'summary', reason: bad });
    else summary = (root.summary as string).trim();
  }

  const colors = collectNotes(root.colors, known.colors, MAX_COLOR_NOTE_CHARS, 'colors', issues);
  const components = collectNotes(root.components, known.components, MAX_COMPONENT_NOTE_CHARS, 'components', issues);

  const guidelines: string[] = [];
  if (root.guidelines !== undefined) {
    const list = Array.isArray(root.guidelines) ? root.guidelines : null;
    if (!list) {
      issues.push({ field: 'guidelines', reason: '不是数组' });
    } else {
      for (let i = 0; i < list.length; i++) {
        const item = list[i];
        if (guidelines.length >= MAX_AI_GUIDELINES) {
          issues.push({ field: `guidelines[${i}]`, reason: `超过 ${MAX_AI_GUIDELINES} 条上限` });
          continue;
        }
        const bad = textViolation(item, MAX_GUIDELINE_CHARS);
        if (bad) {
          issues.push({ field: `guidelines[${i}]`, reason: bad });
          continue;
        }
        const text = (item as string).trim();
        // 判据从生成器那边引，不在这里另写一份。护栏的格式约定只有一处定义，
        // 两边分叉的表现是「生成器写进去一条检查脚本判定不合格的护栏」。
        //
        // 两条判据的顺序有讲究：先判自检口吻，再判祈使句式。一句「样本偏少，
        // 需要人工过一眼」通常两种都不满足，先判句式的话给出的原因是「不是
        // 祈使句」，而真正该说的是「这是自检说明，不属于护栏」。后者才能让
        // 用户明白为什么这句话被拿掉了
        if (SELF_INSPECTION.test(text)) {
          issues.push({ field: `guidelines[${i}]`, reason: '是提取质量的自检说明，不属于护栏' });
          continue;
        }
        if (!IMPERATIVE.test(text)) {
          issues.push({ field: `guidelines[${i}]`, reason: '不是可执行的祈使句' });
          continue;
        }
        guidelines.push(text);
      }
    }
  }

  let prompt = '';
  if (root.prompt !== undefined) {
    const bad = textViolation(root.prompt, MAX_PROMPT_CHARS);
    if (bad) issues.push({ field: 'prompt', reason: bad });
    else prompt = (root.prompt as string).trim();
  }

  const empty =
    summary.length === 0 &&
    Object.keys(colors).length === 0 &&
    Object.keys(components).length === 0 &&
    guidelines.length === 0 &&
    prompt.length === 0;

  if (empty) return { semantics: null, issues, rejected: false };

  return { semantics: { model, summary, colors, components, guidelines, prompt }, issues, rejected: false };
}

/**
 * 收一张「名字到短句」的表。
 *
 * 只接受本次实际生成出来的名字。模型很容易顺手补一个自己觉得该有的 token，
 * 比如色板里只有 surface 却写了一条 background。这类键如果不拦，文案会
 * 出现在一个不存在的条目上，读的人找不到对应项，比缺这一条更糟。
 */
function collectNotes(
  raw: unknown,
  allowed: string[],
  maxChars: number,
  field: string,
  issues: SemanticsIssue[],
): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw === undefined) return out;

  const rec = asRecord(raw);
  if (!rec) {
    issues.push({ field, reason: '不是对象' });
    return out;
  }

  for (const key of Object.keys(rec)) {
    if (allowed.indexOf(key) === -1) {
      issues.push({ field: `${field}.${key}`, reason: '不在本次提取出的名字里' });
      continue;
    }
    const bad = textViolation(rec[key], maxChars);
    if (bad) {
      issues.push({ field: `${field}.${key}`, reason: bad });
      continue;
    }
    out[key] = (rec[key] as string).trim();
  }

  return out;
}

/** 空文案。语义层没有被启用时用它占位，省掉处处判空 */
export function emptySemantics(model = ''): AiSemantics {
  return { model, summary: '', colors: {}, components: {}, guidelines: [], prompt: '' };
}

/** 这份文案里有没有真内容 */
export function hasAnyProse(s: AiSemantics | null): boolean {
  if (!s) return false;
  return (
    s.summary.length > 0 ||
    Object.keys(s.colors).length > 0 ||
    Object.keys(s.components).length > 0 ||
    s.guidelines.length > 0 ||
    s.prompt.length > 0
  );
}

/** 界面上一句话概括 AI 这次补上了多少、丢了多少 */
export function summarizeIssues(result: SemanticsResult): string {
  if (result.rejected) return 'AI 返回的内容无法解析，这份是纯本地生成版。';
  if (result.issues.length === 0) return 'AI 补全内容全部通过校验。';
  return `AI 补全有 ${result.issues.length} 处未通过校验，已逐条丢弃，其余照常采用。`;
}
