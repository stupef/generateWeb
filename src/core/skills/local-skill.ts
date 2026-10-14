/**
 * 本地规则 skill。
 *
 * 这是一个“空”的 skill 实现：它永远不发起外部调用，直接返回 null semantics，
 * 也不产出 exported。它的作用是让用户在没有配置 LLM、或显式选择“只走规则”时，
 * 仍然能用同一个 pipeline 接口跑完整流程。
 *
 * 后面要接入别的 skill 时，把它替换掉即可，不需要改调用方的逻辑。
 */
import type { DesignSkill, SkillInput, SkillRun } from './types';

export const localSkill: DesignSkill = {
  id: 'local',
  label: '本地规则',
  async extract(_input: SkillInput): Promise<SkillRun> {
    return { exported: undefined, semantics: null, issues: [], failure: null };
  },
};
