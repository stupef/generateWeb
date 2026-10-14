/**
 * Skill 扩展层的统一出口。
 *
 * 规则路径与 LLM 路径是「二选一」，不是「规则先跑、LLM 叠加」。
 * skill 拿到的是原始采集样本 PageSample，可以自己从 sample 产出 SampleExport
 * （真正的 LLM 提取），也可以直接产出整份 DESIGN.md（LlmExtractSkill）。
 *
 * 这里暴露接口和已实现 skill：
 * - localSkill：永远返回空，对应「只走规则路径」
 * - LlmExtractSkill：真正的 LLM 提取，直接用 PageSample 生成 Google 格式
 *   DESIGN.md，对应 src/core/skills/page-sample-to-design-md/SKILL.md
 * - LlmSkill：早期的「语义增强」占位实现，数值仍来自规则分析，作为对照保留
 *
 * 新增 skill 时，实现 DesignSkill 接口后在这里导出即可。
 */
export type { DesignSkill, SkillInput, SkillRun } from './types';
export { localSkill } from './local-skill';
export { LlmExtractSkill } from './extract-skill';
export { LlmSkill } from './llm-skill';
