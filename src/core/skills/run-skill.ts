/**
 * skill 驱动的多步生成：从 SKILL.md 里读出步骤，串行多次调用模型，
 * 把各步输出拼成一个完整 DESIGN.md。
 *
 * 为什么多步：单次让模型回整份 DESIGN.md 常因输出上限被截断（Nike 这种
 * 大页面即使 8192 也不够）。把生成拆成「先 front matter、再分章节」几步，
 * 每步内容小，基本不会触顶。下游 toDesignMd + parseDesignMdToExport 不变。
 *
 * 步骤声明格式（写在 SKILL.md 里，用 HTML 注释包住，不会混进发给模型的提示）：
 *   <!-- STEPS
 *   - frontmatter: 只输出 YAML front matter（colors/typography/spacing/rounded/components）
 *   - overview-colors: 只输出 ## Overview 和 ## Colors
 *   - rest: 输出剩余所有章节
 *   -->
 * 第一条必须是 front matter（要解析的结构，必须一次完整）。没有 STEPS 块时
 * 退回单次调用，现有 SKILL.md 不改也能跑。
 *
 * 格式校验与重试：弱模型常返回不合法格式（front matter 没正常闭合、prose 步
 * 混入 ```yaml 块、拒绝执行等）。每步调用后做一次校验，不通过就按 MAX_STEP_RETRIES
 * 重试该步（只重跑坏的那步，front matter 不会跟着重生成）。front matter 步重试
 * 耗尽 → 整体失败（卡片没了）；prose 步重试耗尽 → 丢弃这步输出（文档不完整但
 * 干净），卡片不受影响。
 */
import { callModel } from '../llm/client';
import { adapterOf } from '../llm/providers';
import type { LlmConfig, LlmFailure } from '../llm/types';
import type { PageSample } from '../types';
import { frontMatterOf, collectTokenPaths } from '../design-md';

export interface SkillStep {
  name: string;
  instruction: string;
}

/** 每步最大重试次数（不含首次）。即每步最多 1 + MAX_STEP_RETRIES 次尝试 */
export const MAX_STEP_RETRIES = 2;

const STEPS_RE = /<!--\s*STEPS\s*([\s\S]*?)-->/i;

/** 从 SKILL.md 原文里取出 STEPS 块，解析成有序步骤；同时返回去掉 STEPS 块的 base 提示 */
export function parseSkillSteps(skillPrompt: string): { base: string; steps: SkillStep[] } {
  const m = STEPS_RE.exec(skillPrompt);
  if (!m || !m[1]) return { base: skillPrompt, steps: [] };
  const base = skillPrompt.replace(STEPS_RE, '').trim();
  const steps: SkillStep[] = [];
  for (const raw of m[1].split('\n')) {
    const line = raw.trim();
    if (!line || !/^[-*]\s+/.test(line)) continue;
    const body = line.replace(/^[-*]\s+/, '').trim();
    const colon = body.indexOf(':');
    // "- name: instruction" → name + instruction；"- instruction" → 空名 + instruction
    const name = colon > 0 ? body.slice(0, colon).trim() : '';
    const instruction = colon > 0 ? body.slice(colon + 1).trim() : body;
    if (instruction) steps.push({ name, instruction });
  }
  return { base, steps };
}

/** 把单步模型输出去围栏、规整成一段可拼接的文本。兼容 markdown / md / yaml / yml 围栏 */
function cleanStep(text: string): string {
  const t = text.trim();
  const fence = t.match(/^```(?:markdown|md|ya?ml)?\s*\n?([\s\S]*?)\n?```$/i);
  return (fence && fence[1] !== undefined ? fence[1].trim() : t).trim();
}

function shapeFailure(detail: string): LlmFailure {
  return {
    kind: 'shape',
    title: '模型没有返回可用的 DESIGN.md',
    body: '重新提取一次，或检查模型是否可用；也可关掉 LLM 开关改用规则路径。',
    detail,
    status: null,
    retryable: true,
  };
}

/**
 * front matter 步校验：必须能被 frontMatterOf 正确识别（--- 独立成行闭合），
 * 且至少解析到一个 token 分组。仅校验结构合法性，不校验字段是否和解析器期望的
 * schema 一致（schema 错位属于 skill 示例问题，不在此重试）。
 */
function validateFrontmatterStep(text: string): { ok: true } | { ok: false; reason: string } {
  const fm = frontMatterOf(text);
  if (!fm) return { ok: false, reason: 'YAML front matter 未以独立一行的 --- 正确闭合' };
  if (collectTokenPaths(text).length === 0) {
    return { ok: false, reason: 'front matter 内未解析到任何 token 分组（colors/typography/spacing/rounded/components）' };
  }
  return { ok: true };
}

/** prose 步校验：非空、非拒绝、不混入代码围栏、不出现游离的 --- front matter */
const REFUSAL_RE =
  /cannot proceed|please provide|i am unable|i cannot|无法继续|需要提供|无法处理|拒绝执行|拒绝/i;

function validateProseStep(text: string): { ok: true } | { ok: false; reason: string } {
  if (!text.trim()) return { ok: false, reason: '输出为空' };
  if (REFUSAL_RE.test(text)) return { ok: false, reason: '模型拒绝执行（要求补充 references 等文件）' };
  if (text.includes('```')) return { ok: false, reason: '输出中混入了代码围栏（如 yaml 块）' };
  if (text.startsWith('---') || text.includes('\n---\n')) {
    return { ok: false, reason: '输出中出现游离的 --- front matter' };
  }
  return { ok: true };
}

interface StepAttempt {
  text: string;
  ok: boolean;
  reason: string;
  failure: LlmFailure | null;
  elapsedMs: number;
}

/** 一次模型调用 + 去围栏 + 校验，返回结构化结果（不含重试循环） */
async function callAndValidate(
  adapter: ReturnType<typeof adapterOf>,
  config: LlmConfig,
  system: string,
  user: string,
  signal: AbortSignal | undefined,
  hasPermission: (originPattern: string) => Promise<boolean>,
  isFrontmatter: boolean,
): Promise<StepAttempt> {
  const outcome = await callModel(adapter, config, system, user, { hasPermission, signal });
  if (!outcome.ok) {
    return { text: '', ok: false, reason: '模型调用失败', failure: outcome.failure, elapsedMs: 0 };
  }
  const text = cleanStep(outcome.value.text);
  const v = isFrontmatter ? validateFrontmatterStep(text) : validateProseStep(text);
  return { text, ok: v.ok, reason: v.ok ? '' : v.reason, failure: null, elapsedMs: outcome.value.elapsedMs };
}

export interface GenerateResult {
  designMd: string;
  failure: LlmFailure | null;
  elapsedMs: number;
}

/**
 * 按 SKILL.md 的步骤串行生成完整 DESIGN.md。
 *
 * 每步调用后做格式校验，不通过就重试（最多 MAX_STEP_RETRIES 次）。front matter
 * 步重试耗尽 → 整体 shape 失败；prose 步重试耗尽 → 丢弃该步（文档可能不完整但干净）。
 *
 * @param hasPermission 宿主权限检查（extract 层传 hasOriginPermission；测试可传 stub）
 */
export async function generateDesignMd(
  skillPrompt: string,
  sample: PageSample,
  config: LlmConfig,
  signal: AbortSignal | undefined,
  hasPermission: (originPattern: string) => Promise<boolean>,
  referencesText?: string,
): Promise<GenerateResult> {
  const { base, steps } = parseSkillSteps(skillPrompt);
  // 把 SKILL.md 在 references/ 里引用的规则文件（output-format / evidence-rules /
  // design-evidence 等）拼进系统提示。此前这些文件从未被读取，模型读不到格式约束，
  // 才会自由发挥出不兼容解析器的 schema。拼进 base 后每步都会带上，约束生效。
  const sysBase = referencesText
    ? `${base}\n\n# 参考规则（生成时必须严格遵循，优先级等同本提示）\n${referencesText}`
    : base;
  const user = `下面是本次页面采集到的 PageSample 原始数据（JSON）：\n\n${JSON.stringify(sample, null, 2)}`;
  const adapter = adapterOf(config.protocol);
  let elapsed = 0;

  // 没有 STEPS 块 → 单次调用（向后兼容），同样做 front matter 校验 + 重试
  if (steps.length === 0) {
    let last: StepAttempt = { text: '', ok: false, reason: '未执行', failure: null, elapsedMs: 0 };
    for (let attempt = 0; attempt <= MAX_STEP_RETRIES; attempt++) {
      const retryNote =
        attempt > 0
          ? `\n\n（第 ${attempt} 次重试）上一次返回的 DESIGN.md 无法解析：请严格以独立一行的 --- 开始和结束 YAML front matter，之后才是 prose 章节，不要加代码围栏或前言。`
          : '';
      last = await callAndValidate(adapter, config, sysBase + retryNote, user, signal, hasPermission, true);
      elapsed += last.elapsedMs;
      if (last.ok) break;
      if (last.failure) return { designMd: '', failure: last.failure, elapsedMs: elapsed };
      console.debug(`[llm-extract] 单次调用第 ${attempt + 1} 次返回不合法：${last.reason}`);
    }
    if (!last.ok) {
      return { designMd: '', failure: shapeFailure(`重试 ${MAX_STEP_RETRIES} 次仍无法解析 DESIGN.md：${last.reason}`), elapsedMs: elapsed };
    }
    return { designMd: last.text, failure: null, elapsedMs: elapsed };
  }

  // 多步：串行，每步一次调用 + 校验 + 重试。每步都把 PageSample 作为 user 消息（模型无跨轮记忆）
  const parts: string[] = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const isFrontmatter = i === 0;
    let last: StepAttempt = { text: '', ok: false, reason: '未执行', failure: null, elapsedMs: 0 };
    for (let attempt = 0; attempt <= MAX_STEP_RETRIES; attempt++) {
      const retryNote =
        attempt > 0
          ? `\n\n（第 ${attempt} 次重试）上一次返回不符合格式：${last.reason}。请严格只输出本步要求的内容，不要加代码围栏、前言、总结、步骤说明或 HTML 注释。`
          : '';
      const system = `${sysBase}\n\n本次任务（第 ${i + 1}/${steps.length} 步，共 ${steps.length} 步）：${step.instruction}${retryNote}`;
      last = await callAndValidate(adapter, config, system, user, signal, hasPermission, isFrontmatter);
      elapsed += last.elapsedMs;
      if (last.ok) break;
      if (last.failure) {
        // 调用级失败：front matter 步直接整体失败；prose 步跳出重试、后面丢弃该步
        if (isFrontmatter) return { designMd: '', failure: last.failure, elapsedMs: elapsed };
        break;
      }
      console.debug(`[llm-extract] 步骤「${step.name}」第 ${attempt + 1} 次返回不合法：${last.reason}`);
    }

    if (isFrontmatter) {
      if (!last.ok) {
        return {
          designMd: '',
          failure: shapeFailure(`front matter 步重试 ${MAX_STEP_RETRIES} 次仍不合法：${last.reason}`),
          elapsedMs: elapsed,
        };
      }
      parts.push(last.text);
    } else if (last.ok && last.text) {
      // prose 步通过 → 拼接；不通过（重试耗尽或调用失败）→ 丢弃，文档不完整但干净
      parts.push(last.text);
    }
  }

  return { designMd: parts.join('\n\n'), failure: null, elapsedMs: elapsed };
}
