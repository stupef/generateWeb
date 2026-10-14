/**
 * 生成 DESIGN.md 的两条路径。
 *
 * 这个模块把「提取 → 渲染」流程显式拆成两条「二选一」的路：
 *
 * 1. 规则路径：renderRuleOnly(exported)
 *    完全由本地规则生成 DESIGN.md，不调用任何 skill。无 Key、无网络也能用。
 *    exported 由调用方在界面渲染前算好（规则分析的结果），这里只负责渲染。
 *
 * 2. Skill 路径：renderWithSkill(sample, skill, ruleExported)
 *    skill 拿到原始采集样本 sample，自己决定怎么提取。真正的提取 skill 会直接
 *    从 sample 产出 SampleExport 写进 SkillRun.exported；语义增强型 skill 只
 *    返回 prose。渲染时优先用 skill 返回的 exported，没有就退回 ruleExported
 *    （规则分析结果）。这样规则提取错了，只要 skill 自己能提取，就不会被
 *    错误结论带偏。
 *
 * 这样的拆分让规则路径成为一条不依赖 LLM 的独立完整链路；LLM 只是 skill 接口
 * 下的一个默认实现，后面可以换成任意实现（真正的 LLM 提取、多模态、本地小模型）
 * 而不动提取和渲染层。
 */
import { renderDesignMd } from './design-md';
import type { SampleExport } from './export';
import type { PageSample } from './types';
import type { AiSemantics } from './semantics';
import type { DesignSkill, SkillRun } from './skills';

/**
 * 纯规则路径。
 *
 * 输入一次提取快照，直接输出 DESIGN.md 字符串。不发起网络请求，不依赖 LLM。
 */
export function renderRuleOnly(exported: SampleExport): string {
  return renderDesignMd(exported, null);
}

/**
 * 用 skill 提取/增强后的路径。
 *
 * 返回的 md 已经用 skill 给出的结果渲染好：skill 返回了 exported 就用 skill 的，
 * 否则退回 ruleExported；semantics 始终叠加。调用方从返回的 SkillRun 里拿到
 * 失败归因和校验 issues，用于更新 UI。
 */
export async function renderWithSkill(
  sample: PageSample,
  skill: DesignSkill,
  ruleExported: SampleExport,
  signal?: AbortSignal,
): Promise<{ md: string; run: SkillRun }> {
  const run = await skill.extract({ sample, ruleExported, signal });
  // 真正的提取 skill 直接产出 DESIGN.md，优先原样采用；否则退回规则版 + 语义叠加。
  // 这样规则提取即使提错，只要 skill 自己能独立产出文档，就不会被错误结论带偏。
  if (run.designMd && run.designMd.trim().length > 0) {
    return { md: run.designMd, run };
  }
  const base = run.exported ?? ruleExported;
  const semantics: AiSemantics | null = run.semantics ?? null;
  return { md: renderDesignMd(base, semantics), run };
}

/**
 * 直接把一段语义文案渲染成 DESIGN.md。
 *
 * 当 skill 调用和渲染不在同一处时，可以用这个函数把分开拿到的 semantics 合回去。
 */
export function renderWithProse(
  exported: SampleExport,
  semantics: AiSemantics | null,
): string {
  return renderDesignMd(exported, semantics);
}
