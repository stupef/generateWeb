/**
 * Skill 扩展接口。
 *
 * 规则路径与 LLM 路径是「二选一」，不是「规则先跑、LLM 叠加」。
 *
 * 规则路径在 src/core/pipeline.ts 的 renderRuleOnly 里一步完成，不依赖任何
 * skill。LLM 路径则通过这里定义的 DesignSkill 接口注入，skill 拿到的是页面
 * 采集的原始样本 PageSample，自己决定怎么从中提取，可以完全不碰规则分析。
 *
 * 这是和早期「规则分析完再让 LLM 补语义」做法的根本区别：早期 skill 接收的是
 * 已经规则分析好的 SampleExport，规则一旦提错，传给 LLM 的也是错的，LLM 救不
 * 回来。现在 skill 接收 PageSample，真正的提取 skill 能直接从原始数据产出
 * SampleExport（写进 SkillRun.exported），从而绕开规则分析；规则分析只在
 * skill 没返回 exported 时作为渲染回退。
 *
 * 当前内置的 LlmSkill 是一个「语义增强」占位实现：它复用规则分析得到的 token
 * 写 prose，并不真正做提取。等以后写出真正的 LLM 提取 skill，让它实现 extract
 * 直接从 PageSample 产出 exported 即可，调用方一行都不用改。
 */
import type { PageSample } from '../types';
import type { SampleExport } from '../export';
import type { LlmFailure } from '../llm/types';
import type { AiSemantics, SemanticsIssue } from '../semantics';

/** 传给 skill 的输入 */
export interface SkillInput {
  /** 本次页面采集的原始样本。skill 自己决定怎么从中提取，可完全不碰规则分析 */
  sample: PageSample;
  /**
   * 规则路径已经算好的分析结果，供「语义增强型」skill 复用，避免重复分析。
   * 真正的提取 skill 应该忽略它，直接从 sample 产出自己的 exported。
   */
  ruleExported?: SampleExport;
  /** 调用方提供的取消信号 */
  signal?: AbortSignal;
}

/** Skill 一次运行的结果 */
export interface SkillRun {
  /**
   * skill 自己提取出的分析结果。真正的 LLM 提取 skill 应该在这里返回从
   * sample 直接产出的 SampleExport，从而完全绕过规则分析。
   * 省略（undefined）时，渲染层退回调用方传入的规则版 exported。
   */
  exported?: SampleExport;
  /**
   * skill 直接产出的 DESIGN.md 全文。真正的 LLM 提取 skill 走这条路：模型
   * 从 PageSample 直接生成整份文档，pipeline 优先原样采用，完全不经过本地
   * 渲染器。designMd 和 exported / semantics 同时出现时，designMd 优先。
   */
  designMd?: string;
  /**
   * 语义文案。语义增强型 skill（如占位的 LlmSkill）不产出 exported / designMd，
   * 只在这里返回 prose，叠加到规则版上。真正的提取 skill 也可以同时返回它。
   */
  semantics: AiSemantics | null;
  /** 校验不通过被丢弃的项，供 UI 展示 */
  issues: SemanticsIssue[];
  /** 调用失败时的归因。成功时为 null */
  failure: LlmFailure | null;
  /** 调用耗时，毫秒。本地 skill 可为 0 */
  elapsedMs?: number;
}

/** 一个 skill 实现需要满足的契约 */
export interface DesignSkill {
  /** 唯一标识 */
  readonly id: string;
  /** 给人看的名字 */
  readonly label: string;
  /**
   * 从原始样本提取（或增强）出一份设计描述。
   *
   * 失败时不抛异常，而是把归因写进 run.failure。调用方据此决定 UI 状态。
   */
  extract(input: SkillInput): Promise<SkillRun>;
}
