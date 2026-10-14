/**
 * 真正的 LLM 提取 skill —— 直接用 PageSample 产出人读版 DESIGN.md。
 *
 * 当前阶段只让模型产出一份 DESIGN.md 文档，不做结构化 JSON、也不重渲侧栏卡片。
 * 侧栏卡片始终来自规则分析（见 sidepanel/main.ts 的 renderResult）；模型文案
 * 作为文档文本返回，供复制/下载。
 *
 * 早期的「结构化 JSON → 卡片」方案已临时禁用：模型一次吐完整 JSON + DESIGN.md
 * 常因输出上限被截断，且弱模型格式遵循不稳定。先退回纯文档生成，待截断/格式
 * 问题解决后再评估是否重开。
 */
import { callModel } from '../llm/client';
import { adapterOf } from '../llm/providers';
import type { LlmSettings } from '../llm/types';
import { hasOriginPermission } from '../settings';
import type { DesignSkill, SkillInput, SkillRun } from './types';
import skillPrompt from './page-sample-to-design-md/SKILL.md?raw';

/**
 * 把模型返回的原文完整保存下来，方便事后分析格式问题。
 *
 * 浏览器扩展运行在沙箱里写不了本地磁盘，最可靠的落盘方式是触发浏览器下载
 * 一个 JSON 到 Downloads 目录。Node 侧（回归脚本）没有 document，跳过下载
 * 只保留 console 输出。无论解析成功还是失败都调用，保存的是完整原文而非截断。
 */
function dumpRawModelOutput(
  text: string,
  info: { model: string; protocol: string; url: string; ok: boolean; reason?: string },
): void {
  const payload = {
    savedAt: new Date().toISOString(),
    model: info.model,
    protocol: info.protocol,
    pageUrl: info.url,
    parseOk: info.ok,
    failureReason: info.reason ?? null,
    rawText: text,
  };
  const json = JSON.stringify(payload, null, 2);
  if (typeof document !== 'undefined' && typeof URL !== 'undefined' && typeof Blob !== 'undefined') {
    try {
      const blob = new Blob([json], { type: 'application/json' });
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = `llm-extract-${Date.now()}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objectUrl);
    } catch {
      // 下载失败不应中断提取流程
    }
  }
  console.debug('[llm-extract] 模型返回原文（前 3000 字）：\n' + (text || '').slice(0, 3000));
}

/**
 * 把模型返回的文本整理成干净的 DESIGN.md。
 *
 * 提示词要求模型把文档放进单个 ```markdown 围栏，但模型偶尔会裸输出（直接以
 * YAML 的 --- 开头）。这里统一处理：整段被单个围栏包裹就去掉围栏，否则原样返回。
 */
function toDesignMd(text: string): string {
  const trimmed = (text || '').trim();
  const fence = trimmed.match(/^```(?:markdown|md)?\s*\n?([\s\S]*?)\n?```$/i);
  return fence && fence[1] !== undefined ? fence[1].trim() : trimmed;
}

export class LlmExtractSkill implements DesignSkill {
  readonly id = 'llm-extract';
  readonly label = 'LLM 提取（PageSample → DESIGN.md）';

  private settings: LlmSettings;

  constructor(settings: LlmSettings) {
    this.settings = settings;
  }

  async extract({ sample, signal }: SkillInput): Promise<SkillRun> {
    const { config } = this.settings;
    const model = config.model;
    const adapter = adapterOf(config.protocol);

    const user = `下面是本次页面采集到的 PageSample 原始数据（JSON）：\n\n${JSON.stringify(sample, null, 2)}`;

    const outcome = await callModel(adapter, config, skillPrompt, user, {
      hasPermission: hasOriginPermission,
      signal,
    });

    if (!outcome.ok) {
      return { exported: undefined, semantics: null, issues: [], failure: outcome.failure, elapsedMs: 0 };
    }

    const designMd = toDesignMd(outcome.value.text);

    // 无论成败，先把模型原文完整保存下来（浏览器里下载到 Downloads），方便事后分析
    dumpRawModelOutput(outcome.value.text, {
      model,
      protocol: config.protocol,
      url: sample.url,
      ok: designMd.length > 0,
      reason: designMd.length > 0 ? undefined : '模型未返回任何 DESIGN.md 文本',
    });

    if (!designMd) {
      return {
        exported: undefined,
        semantics: null,
        issues: [],
        failure: {
          kind: 'shape',
          title: '模型没有返回可用的 DESIGN.md',
          body: '重新提取一次，或检查模型是否可用；也可关掉 LLM 开关改用规则路径。',
          detail: '',
          status: null,
          retryable: true,
        },
        elapsedMs: outcome.value.elapsedMs,
      };
    }

    return {
      exported: undefined,
      semantics: null,
      issues: [],
      failure: null,
      designMd,
      elapsedMs: outcome.value.elapsedMs,
    };
  }
}
