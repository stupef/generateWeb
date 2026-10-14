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
 */
import { callModel } from '../llm/client';
import { adapterOf } from '../llm/providers';
import type { LlmConfig, LlmFailure } from '../llm/types';
import type { PageSample } from '../types';

export interface SkillStep {
  name: string;
  instruction: string;
}

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

/** 把单步模型输出去围栏、规整成一段可拼接的文本 */
function cleanStep(text: string): string {
  const t = text.trim();
  const fence = t.match(/^```(?:markdown|md)?\s*\n?([\s\S]*?)\n?```$/i);
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

export interface GenerateResult {
  designMd: string;
  failure: LlmFailure | null;
  elapsedMs: number;
}

/**
 * 按 SKILL.md 的步骤串行生成完整 DESIGN.md。
 *
 * @param hasPermission 宿主权限检查（extract 层传 hasOriginPermission；测试可传 stub）
 */
export async function generateDesignMd(
  skillPrompt: string,
  sample: PageSample,
  config: LlmConfig,
  signal: AbortSignal | undefined,
  hasPermission: (originPattern: string) => Promise<boolean>,
): Promise<GenerateResult> {
  const { base, steps } = parseSkillSteps(skillPrompt);
  const user = `下面是本次页面采集到的 PageSample 原始数据（JSON）：\n\n${JSON.stringify(sample, null, 2)}`;
  const adapter = adapterOf(config.protocol);

  // 没有 STEPS 块 → 单次调用（向后兼容，现有 SKILL.md 不改也能跑）
  if (steps.length === 0) {
    const outcome = await callModel(adapter, config, skillPrompt, user, { hasPermission, signal });
    if (!outcome.ok) return { designMd: '', failure: outcome.failure, elapsedMs: 0 };
    const designMd = cleanStep(outcome.value.text);
    if (!designMd) return { designMd: '', failure: shapeFailure(''), elapsedMs: outcome.value.elapsedMs };
    return { designMd, failure: null, elapsedMs: outcome.value.elapsedMs };
  }

  // 多步：串行，每步一次调用。每步都把 PageSample 作为 user 消息（模型无跨轮记忆）
  const parts: string[] = [];
  let elapsed = 0;
  for (let i = 0; i < steps.length; i++) {
    const system = `${base}\n\n本次任务（第 ${i + 1}/${steps.length} 步，共 ${steps.length} 步）：${steps[i]!.instruction}`;
    const outcome = await callModel(adapter, config, system, user, { hasPermission, signal });
    if (!outcome.ok) {
      // 第一步（front matter）失败 → 整体失败，卡片没了
      if (i === 0) return { designMd: '', failure: outcome.failure, elapsedMs: elapsed };
      // 后续 prose 步失败 → 跳过这步，保留已拿到的；文档不完整但卡片仍可用
      continue;
    }
    elapsed += outcome.value.elapsedMs;
    const text = cleanStep(outcome.value.text);
    if (i === 0 && !text) return { designMd: '', failure: shapeFailure('front matter 为空'), elapsedMs: elapsed };
    if (text) parts.push(text);
  }

  return { designMd: parts.join('\n\n'), failure: null, elapsedMs: elapsed };
}
