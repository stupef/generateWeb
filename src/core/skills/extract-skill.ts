/**
 * 真正的 LLM 提取 skill —— 直接用 PageSample 产出人读版 DESIGN.md，
 * 再从 DESIGN.md 的 front matter 反解出结构化分析，覆盖到右侧栏卡片。
 *
 * 走的是「B 方案」：模型只产一份 DESIGN.md（含 YAML front matter 与各 prose
 * 章节），`parse-design-md-export.ts` 把 front matter 里的 token 反解成和规则
 * 路径同构的五线对象，能解到哪条线就用哪条线，解不出或不完整的那条线回退
 * 到规则分析（`ruleExported`）。这样侧栏卡片与规则路径形态完全一致，只是
 * 数值可能来自模型观察到的结论。
 *
 * 早期「直接让模型吐完整 JSON」的方案已放弃：模型一次吐 JSON + DESIGN.md
 * 常因输出上限被截断，且弱模型格式遵循不稳定。改成只产 DESIGN.md、再由
 * 这里做确定性的反解，既不会被截断炸掉整份结构，也把「格式遵循」的责任
 * 从模型身上挪回了本地代码。
 */
import type { LlmSettings } from '../llm/types';
import { hasOriginPermission } from '../settings';
import type { DesignSkill, SkillInput, SkillRun } from './types';
import { parseDesignMdToExport } from './parse-design-md-export';
import { generateDesignMd } from './run-skill';
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
  // 自动下载模型原文到 Downloads 已暂时关闭（每次提取都会落一个文件，调试完格式问题后再恢复）。
  // 后续要调试模型返回格式时，把下面这段取消注释即可重新下载完整原文。
  // const payload = {
  //   savedAt: new Date().toISOString(),
  //   model: info.model,
  //   protocol: info.protocol,
  //   pageUrl: info.url,
  //   parseOk: info.ok,
  //   failureReason: info.reason ?? null,
  //   rawText: text,
  // };
  // const json = JSON.stringify(payload, null, 2);
  // if (typeof document !== 'undefined' && typeof URL !== 'undefined' && typeof Blob !== 'undefined') {
  //   try {
  //     const blob = new Blob([json], { type: 'application/json' });
  //     const objectUrl = URL.createObjectURL(blob);
  //     const a = document.createElement('a');
  //     a.href = objectUrl;
  //     a.download = `llm-extract-${Date.now()}.json`;
  //     document.body.appendChild(a);
  //     a.click();
  //     a.remove();
  //     URL.revokeObjectURL(objectUrl);
  //   } catch {
  //     // 下载失败不应中断提取流程
  //   }
  // }
  console.debug('[llm-extract] 模型返回原文（前 3000 字）：\n' + (text || '').slice(0, 3000));
}

/**
 * 把模型返回的文本整理成干净的 DESIGN.md 的逻辑已移到 run-skill.ts 的
 * cleanStep（多步拼接时每步都要去围栏）。这里只保留原始文本下载（已注释，
 * 调试时按需恢复）。
 */
export class LlmExtractSkill implements DesignSkill {
  readonly id = 'llm-extract';
  readonly label = 'LLM 提取（PageSample → DESIGN.md）';

  private settings: LlmSettings;

  constructor(settings: LlmSettings) {
    this.settings = settings;
  }

  async extract({ sample, ruleExported, signal }: SkillInput): Promise<SkillRun> {
    const { config } = this.settings;

    // 按 SKILL.md 的步骤串行生成完整 DESIGN.md（无 STEPS 块时退回单次调用）。
    // 多步是为了绕开单次生成的输出上限截断；每步输出先去围栏再拼接。
    const { designMd, failure, elapsedMs } = await generateDesignMd(
      skillPrompt,
      sample,
      config,
      signal,
      hasOriginPermission,
    );

    if (failure) {
      return { exported: undefined, semantics: null, issues: [], failure, elapsedMs };
    }

    // 无论成败，先把模型原文完整保存下来（浏览器里下载到 Downloads），方便事后分析。
    // 当前已注释关闭，调试模型返回格式时取消注释即可（见 dumpRawModelOutput）。
    // dumpRawModelOutput(designMd, { ... });

    // 从 DESIGN.md 反解结构化分析。逐线兜底：模型 front matter 有哪条线就用哪条，
    // 没有的线保持规则版。ruleExported 缺失时无法兜底，直接当没有结构化结果。
    const exported = ruleExported
      ? parseDesignMdToExport(designMd, ruleExported) ?? undefined
      : undefined;

    return {
      exported,
      semantics: null,
      issues: [],
      failure: null,
      designMd,
      elapsedMs,
    };
  }
}
