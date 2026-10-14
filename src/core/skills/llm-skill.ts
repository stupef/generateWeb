/**
 * 默认 LLM skill —— 语义增强占位实现。
 *
 * 这是当前版本唯一真正会发网络请求的 skill，但它是「过渡占位」，不是真正的
 * LLM 提取。它把 sidepanel 里原本嵌着的 enhanceWithAi 逻辑抽出来，包成一个
 * 符合 DesignSkill 接口的类，让 UI 层只关心“用哪个 skill”。
 *
 * 为什么是占位：二选一架构要求 skill 能绕过规则分析直接从 PageSample 产出
 * SampleExport。这个实现做不到——它复用 ruleExported 里的 token 写 prose，
 * 数值仍然来自规则分析。它的存在只是让“打开 LLM 开关”现在就有效果，避免
 * 改造期间功能回退到零。
 *
 * 真正的 LLM 提取 skill 应该怎么写：实现 extract，从 input.sample 直接产出
 * SampleExport（颜色聚类、字号层级、组件识别全部由模型或你的提取逻辑完成），
 * 把它写进 SkillRun.exported 返回，并可选地带上 semantics。pipeline 会优先用
 * 你返回的 exported 渲染，规则分析只在你没返回时作为回退。那时这个文件可以
 * 整份替换掉，调用方一行都不用改。
 */
import { callModel } from '../llm/client';
import { buildDesignBrief, knownKeysOf } from '../llm/brief';
import { buildPrompt } from '../llm/prompt';
import { adapterOf } from '../llm/providers';
import type { LlmSettings } from '../llm/types';
import { parseSemantics } from '../semantics';
import { hasOriginPermission } from '../settings';
import type { DesignSkill, SkillInput, SkillRun } from './types';

export class LlmSkill implements DesignSkill {
  readonly id = 'llm';
  readonly label = 'LLM 语义增强（占位）';

  private settings: LlmSettings;

  constructor(settings: LlmSettings) {
    this.settings = settings;
  }

  async extract({ ruleExported, signal }: SkillInput): Promise<SkillRun> {
    // 过渡实现：数值仍来自规则分析（ruleExported 已算好），这里只补语义。
    // 真正的提取 skill 应忽略 ruleExported，自行从 sample 产出 exported。
    if (!ruleExported) {
      return { exported: undefined, semantics: null, issues: [], failure: null };
    }

    const { config } = this.settings;
    const model = config.model;
    const adapter = adapterOf(config.protocol);
    const { system, user } = buildPrompt(buildDesignBrief(ruleExported));

    const outcome = await callModel(adapter, config, system, user, {
      hasPermission: hasOriginPermission,
      signal,
    });

    if (!outcome.ok) {
      return { exported: undefined, semantics: null, issues: [], failure: outcome.failure };
    }

    const result = parseSemantics(outcome.value.text, model, knownKeysOf(ruleExported));

    return {
      exported: undefined,
      semantics: result.semantics,
      issues: result.issues,
      failure: null,
      elapsedMs: outcome.value.elapsedMs,
    };
  }
}
