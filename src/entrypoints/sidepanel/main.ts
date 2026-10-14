import { describeBackground } from '@/core/background';
import type { ColorAnalysis, ColorRole } from '@/core/color';
import type { ComponentSpec, ComponentsAnalysis } from '@/core/components';
import { type Diagnosis, type NoticeAction } from '@/core/diagnose';
import {
  radiusLabel,
  type BorderGroup,
  type EffectsAnalysis,
  type RadiusByKind,
  type ShadowGroup,
} from '@/core/effects';
import {
  loadCollapsed,
  loadPanelState,
  PANEL_STATE_KEY,
  saveCollapsed,
  type PanelResult,
  type PanelSource,
  type PanelState,
} from '@/core/panel-state';
import {
  PILL_RADIUS,
  SOURCE_LABEL,
  type RadiusStep,
  type SpacingAnalysis,
  type SpacingStep,
} from '@/core/spacing';
import {
  ROLE_LABEL,
  type FontFamilyStat,
  type TypeStep,
  type TypographyAnalysis,
} from '@/core/typography';
import type { ProvenanceToken } from '@/core/provenance';
import { TOKEN_ATTR } from '@/core/token-ref';
import {
  mount as mountStrip,
  reattach as reattachStrip,
  reset as resetStrip,
  setContext as setProvenanceContext,
  tokAttr,
  toggle as toggleHighlight,
} from './provenance-strip';
import { DESIGN_MD_FILENAME } from '@/core/design-md';
import { describeKinds } from '@/core/kinds';
import {
  buildSampleExport,
  exportFileName,
  hostOf,
  serializeExport,
  type ExportViewport,
  type SampleExport,
} from '@/core/export';
import { settingsReady } from '@/core/llm/config';
import {
  nextAction,
  ORIGIN_CLASS,
  ORIGIN_LABEL,
  type NoteAction,
  type OriginState,
} from '@/core/llm/notice';
import { hasOriginPermission, loadLlmSettings } from '@/core/settings';
import { summarizeIssues, type AiSemantics, type SemanticsIssue } from '@/core/semantics';
import { renderRuleOnly, renderWithProse, renderWithSkill } from '@/core/pipeline';
import { LlmExtractSkill, localSkill } from '@/core/skills';
import type { LlmFailure, LlmSettings } from '@/core/llm/types';
import type { PageSample } from '@/core/types';
import './style.css';

function mustRoot(): HTMLElement {
  const el = document.getElementById('app');
  if (!el) throw new Error('popup 根节点缺失');
  return el;
}

const root = mustRoot();

// ---------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------

/** 页面标题和网址来自外部，一律转义后再拼进 HTML */
function esc(input: string): string {
  return input.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
}

function pct(n: number): string {
  return `${(n * 100).toFixed(n < 0.01 ? 2 : 1)}%`;
}

// ---------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------

/**
 * 触发一次文件下载。
 *
 * 用 a[download] 加 blob 地址，不为这件事申请 downloads 权限。插件现在
 * 只要了 activeTab、scripting、storage，为了下载再加一条，安装提示里会
 * 多出一行「管理下载」，而这里要做的事根本用不上那个权限。
 *
 * 地址延迟释放。点完立刻撤销的话，几 MB 的样本有可能还没读完就被掐断，
 * 下载到一半失败。定时器挂在 window 上，弹窗关掉会一起销毁，但那时
 * 下载已经交给浏览器了，不受影响。
 */
function downloadFile(name: string, text: string, mime = 'application/json;charset=utf-8') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * 把一个按钮接上一个动作。
 *
 * 点完给一个短暂的文字反馈。扩展里的复制和下载都没有系统提示，按钮如果毫无
 * 变化，用户看不出到底点没点上，多半会再点一次。
 */
function bindButton(
  id: string,
  label: string,
  done: string,
  run: () => void | Promise<void>,
) {
  const btn = document.getElementById(id);
  if (!(btn instanceof HTMLButtonElement)) return;

  btn.addEventListener('click', () => {
    void (async () => {
      await run();
      btn.textContent = done;
      btn.disabled = true;
      window.setTimeout(() => {
        btn.textContent = label;
        btn.disabled = false;
      }, 1600);
    })();
  });
}

/**
 * 写剪贴板。
 *
 * 主路走 navigator.clipboard。它在扩展页里通常可用，但文档失焦或用户拒绝过
 * 剪贴板权限时会抛异常。抛了就退回临时 textarea 加 execCommand 的老办法，
 * 后者已经废弃，不过在只剩这一条路的时候总比直接失败强。
 *
 * 返回是否成功，调用方据此决定按钮上写「已复制」还是「复制失败」。
 */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

/**
 * 当前这份产物的文字。
 *
 * 存成模块级变量而不是闭包里的常量，因为 AI 补全会在这之后把内容换掉一次。
 * 按钮只在页面渲染时绑一次，它们读的必须是「此刻的产物」，不能是绑定时捕获
 * 的那一份，否则用户在补全完成后点导出，导出的还是旧的本地版。
 */
interface Artifacts {
  designMd: string;
  json: string;
  jsonName: string;
}

let artifacts: Artifacts | null = null;

function publishArtifacts(exported: SampleExport, prose: AiSemantics | null): void {
  artifacts = {
    designMd: renderWithProse(exported, prose),
    json: serializeExport(exported),
    jsonName: exportFileName(exported),
  };
}

/**
 * 三个产物动作。
 *
 * 复制和下载共用同一个 artifacts，所以「复制到的」和「下载到的」永远是同一份
 * 内容。文件名上，DESIGN.md 走固定名，因为它就是要放进项目根目录给编码 agent
 * 读的，带主机名和时间戳反而要多改一次名；JSON 是留档，同一站点会导出多次，
 * 所以照旧按主机名加时间戳区分。
 */
function bindExport() {
  bindButton('copy-md', '复制', '已复制', async () => {
    if (artifacts && !(await copyText(artifacts.designMd))) {
      const btn = document.getElementById('copy-md');
      if (btn) btn.textContent = '复制失败';
    }
  });

  bindButton('export-md', 'DESIGN.md', '已导出', () => {
    // 文件名从 core 取，不在这里写第二份字面量。这个名字是有约定的，
    // 差了字符号，编码 agent 就找不到这份文件
    if (artifacts) {
      downloadFile(DESIGN_MD_FILENAME, artifacts.designMd, 'text/markdown;charset=utf-8');
    }
  });

  bindButton('export', 'JSON', '已导出', () => {
    if (artifacts) downloadFile(artifacts.jsonName, artifacts.json, 'application/json;charset=utf-8');
  });
}

// ---------------------------------------------------------------------
// AI 补全
//
// 这一段的顺序是刻意的：先出本地版，再谈补全。补全永远发生在产物已经可用
// 之后，失败了也只是把提示写出来，不回滚任何东西。验收标准里「不配置 Key
// 时可以完成完整流程」「调用失败时仍能拿到一份可用的 DESIGN.md」两条，
// 落地就是这个先后关系——不是靠 catch 兜出来的，是本来就没有依赖。
//
// 徽标文字和「给哪个按钮」两条判断不在这里，在 core/llm/notice.ts。它们是
// 判断不是排版，且直接对应验收标准里那条「界面上分得清本地版和补全版」，
// 放在 core 里断言才够得着。
// ---------------------------------------------------------------------

/** 一行说明文字。strong 用于结论句，让它跟排查说明区分开 */
function noteLine(text: string, strong = false): string {
  return `<p class="usage">${strong ? `<b>${esc(text)}</b>` : esc(text)}</p>`;
}

function issuesNote(issues: SemanticsIssue[]): string {
  if (issues.length === 0) return '';
  const shown = issues.slice(0, 8);
  const extra = issues.length - shown.length;
  const rows = shown.map((i) => noteLine(`${i.field}　${i.reason}`)).join('');
  const tail = extra > 0 ? noteLine(`另有 ${extra} 处未列出`) : '';
  return `<details><summary>${esc(`已丢弃 ${issues.length} 处不合规内容`)}</summary>${rows}${tail}</details>`;
}

const ACTION_LABEL: Record<NoteAction, string> = {
  run: '重试补全',
  options: '去设置',
};

/** 说明块里的动作按钮。用事件委托绑，因为它每次都被重建 */
function actionButton(action: NoteAction): string {
  return (
    `<button class="ai-action" type="button" data-ai-action="${action}">` +
    `${esc(ACTION_LABEL[action])}</button>`
  );
}

/**
 * 动作行。给哪个动作由 notice.ts 的 nextAction 判，四个调用点都走这里，
 * 不在各自那里写一遍——同一件事写四遍，早晚会出现两种口径。
 */
function actionRow(state: OriginState, failure: LlmFailure | null = null): string {
  const action = nextAction(state, failure);
  return action === null ? '' : `<div class="ai-actions">${actionButton(action)}</div>`;
}

/** 失败说明。句子怎么写在这里，给哪个按钮由 notice.ts 判 */
function failureNote(failure: LlmFailure): string {
  const detail = failure.detail ? `<code class="stack">${esc(failure.detail)}</code>` : '';
  return (
    noteLine('AI 补全没有成功，这一份仍然是完整的本地生成版，可以直接复制或导出。', true) +
    noteLine(`原因　${failure.title}。${failure.body}`) +
    detail +
    actionRow('fallback', failure)
  );
}

/** 当前状态下这个按钮该干什么。null 表示不显示按钮 */
let pendingAction: (() => void) | null = null;

/** 更新版本徽标和说明块。说明块为空时整块收起来 */
function setOrigin(state: OriginState, html: string): void {
  const badge = document.getElementById('origin');
  if (badge) {
    badge.textContent = ORIGIN_LABEL[state];
    badge.className = `origin ${ORIGIN_CLASS[state]}`;
  }

  const note = document.getElementById('ai-note');
  if (!note) return;
  if (html.length === 0) {
    note.hidden = true;
    note.innerHTML = '';
    return;
  }
  note.hidden = false;
  note.className = state === 'fallback' ? 'bg-note ai-note ai-warn' : 'bg-note ai-note';
  note.innerHTML = html;
}

/**
 * 说明块里的按钮走事件委托。
 *
 * 说明块的内容每次状态变化都整个重建，逐个绑会一路漏；而后一种状态该干什么
 * 是挂在 pendingAction 上的，不需要按钮自己携带参数。
 */
function bindAiNote(): void {
  const note = document.getElementById('ai-note');
  if (!note) return;
  note.addEventListener('click', (e) => {
    const t = e.target;
    if (!(t instanceof HTMLElement)) return;
    const action = t.dataset.aiAction;
    if (!action) return;
    if (action === 'options') void chrome.runtime.openOptionsPage();
    else pendingAction?.();
  });
}

let aiAbort: AbortController | null = null;

async function enhanceWithAi(
  sample: PageSample,
  ruleExported: SampleExport,
  settings: LlmSettings,
  dropped: boolean,
): Promise<void> {
  const model = settings.config.model;
  // 失败之后要能就地再试一次。配错 Key 再改、额度刚充上、刚才只是网络抖了一下，
  // 这几种情况都只差一次重试，让用户为此去设置页绕一圈没有道理
  pendingAction = () => void enhanceWithAi(sample, ruleExported, settings, dropped);

  setOrigin(
    'pending',
    noteLine(`正在调用 ${model} 从页面采样生成 DESIGN.md。下面这份是本地生成版，此刻已经可以直接导出。`, true),
  );

  aiAbort = new AbortController();
  const skill = new LlmExtractSkill(settings);

  const { md, run } = await renderWithSkill(sample, skill, ruleExported, aiAbort.signal);
  aiAbort = null;

  if (run.failure) {
    setOrigin('fallback', failureNote(run.failure));
    return;
  }

  // 当前阶段 LLM 只产出 DESIGN.md 文档，侧栏卡片保持规则版（已在本次提取时渲染）。
  // 模型文案作为文档文本返回，供复制/下载；卡片与左侧留档 JSON 始终来自本地规则。
  if (artifacts) artifacts.designMd = md;

  if (!run.designMd) {
    // 模型没返回任何可用的 DESIGN.md，这次补全等于没发生，退回规则版并给重试
    setOrigin(
      'fallback',
      noteLine('模型没有返回可用的 DESIGN.md，这一份是纯本地生成版。', true) +
        noteLine(summarizeIssues(run)) +
        issuesNote(run.issues) +
        actionRow('fallback'),
    );
    return;
  }

  const seconds = run.elapsedMs ? `，用时 ${(run.elapsedMs / 1000).toFixed(1)} 秒` : '';
  setOrigin(
    'ai',
    noteLine(
      `DESIGN.md 由 ${model} 从页面采样生成${seconds}。`,
      true,
    ) +
      noteLine('侧栏卡片与左侧留档 JSON 始终来自本地规则分析；模型只补充了人读版的 DESIGN.md 文档。') +
      noteLine(summarizeIssues(run)) +
      issuesNote(run.issues),
  );
}

/**
 * 决定走哪条路。
 *
 * 两条「二选一」的路：本地规则（localSkill）和 LLM 提取（LlmExtractSkill）。
 * 用户关闭 LLM 开关、或开关开着但配置不完整时，都走 localSkill；
 * 开关打开且配置完整时走 LlmSkill。
 *
 * 两条路都从原始采集样本 sample 进；ruleExported 是规则路径已经算好的结果，
 * 用作 LLM 路径的回退基准，也供语义增强型 skill 复用 token 信息。
 */
async function maybeEnhance(
  sample: PageSample,
  ruleExported: SampleExport,
  dropped: boolean,
): Promise<void> {
  let settings: LlmSettings;
  try {
    settings = await loadLlmSettings();
  } catch {
    return;
  }

  if (!settings.useLlm) {
    await renderWithSkill(sample, localSkill, ruleExported);
    setOrigin(
      'local',
      noteLine('这一份完全由本地规则生成。', true) +
        noteLine('设置里关掉了 LLM 提取，需要时在设置页重新打开即可。') +
        actionRow('local'),
    );
    return;
  }

  if (!settingsReady(settings)) {
    await renderWithSkill(sample, localSkill, ruleExported);
    setOrigin(
      'local',
      noteLine('这一份由本地规则生成。', true) +
        noteLine('LLM 提取已打开，但配置不完整，补好地址、Key 和模型名后再试。') +
        actionRow('local'),
    );
    return;
  }

  await enhanceWithAi(sample, ruleExported, settings, dropped);
}

// ---------------------------------------------------------------------
// 折叠
// ---------------------------------------------------------------------

/**
 * 折叠成一条窄条，以及展开回来。
 *
 * 先把「折叠」在这里的含义说死，因为它和「关闭」不是一回事。面板本身的宽度由
 * 浏览器管，扩展没有接口去改，地板在 320px 上下，Chrome 团队从 2024 年起就在
 * 讨论放开，至今没有动作。所以这里收起来的是面板里的内容，那 320px 还在，窄条
 * 右侧会留出一片同色空白。要连面板一起收、把那 320px 还给页面，走头部的关闭。
 *
 * 窄条挂在 body 上，不住在 #app 里。前面每一处渲染都会把 #app 整块 innerHTML
 * 换掉，住在里面的话，折叠之后只要状态变一次，窄条自己就先被换没了。
 */

/** 折叠时内容收向右边，右侧窄条的按钮指回内容区 */
const TRI_LEFT =
  '<svg width="8" height="10" viewBox="0 0 8 10" aria-hidden="true"><path d="M7 0.6 L1 5 L7 9.4 Z" fill="currentColor"/></svg>';
const TRI_RIGHT =
  '<svg width="8" height="10" viewBox="0 0 8 10" aria-hidden="true"><path d="M1 0.6 L7 5 L1 9.4 Z" fill="currentColor"/></svg>';

/** 当前是不是折着。初值展开，真实值在启动时从存储读一次 */
let collapsed = false;

/** 最近一次渲染对应的是哪一页。窄条上要写一行「这是哪一页」 */
let lastSource: PanelSource | null = null;

let rail: HTMLElement | null = null;

function ensureRail(): HTMLElement {
  if (rail) return rail;

  const box = document.createElement('div');
  box.className = 'rail';
  box.hidden = true;

  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'rail-open';
  open.id = 'rail-open';
  open.title = '展开面板';
  open.setAttribute('aria-label', '展开面板');
  open.innerHTML = TRI_LEFT;
  open.addEventListener('click', () => {
    void setCollapsed(false);
  });

  const label = document.createElement('div');
  label.className = 'rail-label';
  label.id = 'rail-label';

  box.appendChild(open);
  box.appendChild(label);
  document.body.appendChild(box);
  rail = box;
  return box;
}

/** 窄条上那一行字。没有结果时留空，不编一句没有信息量的话 */
function railLabel(): string {
  if (!lastSource) return '';
  return lastSource.title || hostOf(lastSource.url) || '';
}

/**
 * 切一下折叠状态，然后落盘。
 *
 * 存不下只影响下次打开面板时先显示成什么样，这一次的折叠照常生效，所以失败
 * 不吭声，也不回滚。
 */
async function setCollapsed(next: boolean): Promise<void> {
  collapsed = next;
  paintCollapsed();
  try {
    await saveCollapsed(next);
  } catch {
    // 落盘失败，见上
  }
}

function paintCollapsed(): void {
  const box = ensureRail();
  box.hidden = !collapsed;
  document.body.classList.toggle('is-collapsed', collapsed);
  const label = document.getElementById('rail-label');
  if (label) label.textContent = railLabel();
}

/** 结果状态里源信息是摊平的，加载和提示两种包在 source 里，这里统一一下 */
function sourceOf(state: PanelState | null): PanelSource | null {
  if (!state) return null;
  return state.status === 'result' ? state : state.source;
}

// ---------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------

/**
 * 面板头部。
 *
 * 三种状态各自渲染一次头部，所以标题和地址都由参数给，只有按钮固定。
 * 地址可以不传，加载中和提示页都还没有确切的页面身份可写。
 *
 * 右边三个按钮分两类。折叠和关闭是「把面板本身收起来」，设置是「换个地方」，
 * 都留在头部不混进下面的产物条。
 */
function headerHtml(title: string, url?: string): string {
  return `
    <div class="hd">
      <div class="hd-mark"></div>
      <div class="hd-text">
        <p class="hd-title">${esc(title)}</p>
        ${url ? `<div class="hd-url">${esc(hostOf(url))}</div>` : ''}
      </div>
      <button class="icon-btn tri" id="fold" type="button" title="折叠到右侧" aria-label="折叠到右侧">${TRI_RIGHT}</button>
      ${collapseButtonHtml()}
      <button class="icon-btn" id="open-options" type="button">设置</button>
    </div>`;
}

/**
 * 关闭侧边栏。
 *
 * 只有 Chrome 141 起才有 close()，更早的版本上不摆这个按钮。摆出来却点不动，
 * 比它不出现更让人困惑。
 *
 * 它和左边那个三角形是两件事。三角形是把面板里的内容收成一条窄条，面板还在；
 * 这个是连面板一起关掉，那 320px 全部还给页面。要收回屏幕空间得用这个。
 */
function collapseButtonHtml(): string {
  if (typeof chrome.sidePanel?.close !== 'function') return '';
  return '<button class="icon-btn tri" id="collapse" type="button" title="关闭面板" aria-label="关闭面板">✕</button>';
}

/**
 * 头部那几个按钮。三种状态各自渲染一遍头部，所以绑定统一走这里，
 * 少一处漏绑。
 */
function bindHeader(): void {
  document.getElementById('open-options')?.addEventListener('click', () => {
    void chrome.runtime.openOptionsPage();
  });

  document.getElementById('fold')?.addEventListener('click', () => {
    void setCollapsed(true);
  });

  document.getElementById('collapse')?.addEventListener('click', () => {
    void collapsePanel();
  });
}

/**
 * 关闭面板。
 *
 * close() 要求指明收哪一个，这里问的是当前窗口。当前窗口就是面板所在的那
 * 一个，面板挂在窗口上，用户看的也是这个窗口，两者是同一个。
 *
 * 给 windowId 而不是 tabId 是有讲究的。面板是窗口级的东西，带 tabId 去关一个
 * 全局面板会被拒绝（官方原话是「如果仅打开了全局面板，则对 close() 的调用返回
 * 的 promise 将拒绝」）。windowId 两种都收，所以这一句不会因为面板挂在哪一层
 * 而失效。
 */
async function collapsePanel(): Promise<void> {
  if (typeof chrome.sidePanel?.close !== 'function') return;
  try {
    const win = await chrome.windows.getCurrent();
    if (win.id === undefined) return;
    await chrome.sidePanel.close({ windowId: win.id });
  } catch {
    // 已经收起来了，或者这个版本不给关。两种都不必再对用户说什么
  }
}

/**
 * 产物动作条。
 *
 * 徽标和三个按钮同一行，而不是把按钮塞进标题右边。标题长度不可控，挤在
 * 一起时长标题会把按钮压扁；单独一行之后，徽标负责回答「这是哪一版」，
 * 按钮负责「拿走它」，各自的位置都稳定。
 */
function actionBarHtml(): string {
  return `
    <div class="bar">
      <span class="origin local" id="origin">${esc(ORIGIN_LABEL.local)}</span>
      <span class="bar-actions">
        <button class="export" id="copy-md" type="button">复制</button>
        <button class="export" id="export-md" type="button">DESIGN.md</button>
        <button class="export" id="export" type="button">JSON</button>
      </span>
    </div>
    <div class="bg-note ai-note" id="ai-note" hidden></div>`;
}

/**
 * 点 token 行，把这一行对应的元素在页面上描出来。
 *
 * 绑在 root 上做事件委托，而不是逐行去绑。行是每次重渲染整个换掉的，逐个
 * 绑会在每次渲染之后漏掉一批；而 root 本身贯穿弹窗的整个生命周期。所以这
 * 个函数只在启动时调一次，不能放进 renderResult 里。
 *
 * closest 取的是最里面那个带 data-tok 的祖先，所以色卡里的 chip 命中 chip
 * 自己而不是外面那张卡。卡片和 chip 是两层嵌套的可点目标，各按各的走。
 */
function bindTokenClicks(): void {
  root.addEventListener('click', (ev) => {
    const t = ev.target;
    if (!(t instanceof HTMLElement)) return;
    const hit = t.closest(`[${TOKEN_ATTR}]`);
    if (!(hit instanceof HTMLElement)) return;
    const attr = hit.getAttribute(TOKEN_ATTR);
    if (!attr) return;
    void toggleHighlight(attr);
  });
}

function renderLoading(source: PanelSource | null) {
  root.innerHTML = `
    ${headerHtml(source?.title || '正在读取页面渲染样式', source?.url)}
    <div class="state"><div class="spinner"></div>遍历元素并读取计算样式…</div>`;
  bindHeader();
  // 上一次的状态条到这里已经过期了：元素注册表马上要重采一份，
  // 上面那个数字不再对应任何东西
  resetStrip();
  reattachStrip();
}

/**
 * 提示里那个能点的动作。判断在 core/diagnose.ts 出，文案和地址留在这一层，
 * 和 notice.ts 那张标签表一个口径。
 *
 * 地址里那个 id 是本扩展自己的，纯函数拿不到也不该去碰 chrome API，所以
 * 只能在这里拼。带上 `?id=` 之后 Chrome 会把这一项直接展开，用户不用在
 * 几十个扩展里翻着找。写成懒取的函数，是因为这个 map 在模块加载时求值，
 * 那时候不必急着读 runtime.id。
 */
const NOTICE_ACTION: Record<NoticeAction, { label: string; href: () => string }> = {
  'open-extension-settings': {
    label: '打开扩展设置',
    href: () => `chrome://extensions/?id=${chrome.runtime.id}`,
  },
};

/**
 * 渲染一张提示页。
 *
 * 「重试有意义」这一条原先落成一个重试按钮，搬到侧边栏之后不能这么做了。
 * 重试要重新走一遍注入，而注入要的 activeTab 只在点图标那一刻授予，在面板里
 * 点按钮拿不到它。所以它现在落成一句指路的文字，接在排查步骤后面。判据本身
 * 没变，还是「再点一次有没有意义」，只是出口从按钮换成了指路。
 *
 * 动作按钮是另一回事，它出现就意味着「这一步得你自己去做」，只有诊断明确
 * 给了 action 才摆出来。
 */
function renderNotice(notice: Diagnosis, source: PanelSource | null) {
  const steps = [...(notice.hints ?? [])];
  if (notice.retryable) steps.push('点一下工具栏上的插件图标可以重试。');

  const hints = steps.length
    ? `<ul class="error-hint">${steps.map((h) => `<li>${esc(h)}</li>`).join('')}</ul>`
    : '';

  const action = notice.action ? NOTICE_ACTION[notice.action] : null;

  root.innerHTML = `
    ${headerHtml('无法提取这个页面', source?.url)}
    <div class="error">
      <p class="error-title">${esc(notice.title)}</p>
      <p class="error-body">${esc(notice.body)}</p>
      ${hints}
    </div>
    ${action ? `<button class="retry" id="notice-action">${esc(action.label)}</button>` : ''}`;

  bindHeader();
  resetStrip();
  reattachStrip();

  document.getElementById('notice-action')?.addEventListener('click', () => {
    if (action) void chrome.tabs.create({ url: action.href() });
  });
}

/**
 * 可点的 chip。
 *
 * 编不出属性时退回普通 chip，而不是留一个点了没反应的控件。属性的形状只有
 * core/token-ref.ts 知道，这里不自己拼串。
 */
function tokChip(token: ProvenanceToken, text: string): string {
  const attr = tokAttr(token);
  if (attr === '') return `<span class="chip">${esc(text)}</span>`;
  return `<span class="chip tk"${attr} title="点一下，在页面上标出用了它的元素">${esc(text)}</span>`;
}

function chipList(role: ColorRole, index: number): string {
  const e = role.evidence;
  const chips: string[] = [];

  // 文字这一条原本只印字符占比。补上元素数是必须的：溯源高亮描的是元素，
  // 占比回答不了「点下去该亮几个」，而界面上的数字必须和描出来的个数同口径，
  // 否则用户拿到两个数也没法互相核对
  if (e.textChars > 0) {
    chips.push(
      tokChip(
        { kind: 'color', index, channel: 'text' },
        `作文字 ${e.textCount} 处 · 承载 ${pct(e.textShare)} 文字`,
      ),
    );
  }
  if (e.backgroundCount > 0) {
    chips.push(
      tokChip(
        { kind: 'color', index, channel: 'background' },
        `作背景 ${e.backgroundCount} 处 · 面积 ${pct(e.backgroundShare)}`,
      ),
    );
  }
  if (e.borderCount > 0) {
    chips.push(
      tokChip({ kind: 'color', index, channel: 'border' }, `作边框 ${e.borderCount} 处`),
    );
  }
  if (e.controlCount > 0) {
    chips.push(`<span class="chip">命中 ${e.controlCount} 个控件</span>`);
  }
  // 近色提示里已经带了对比度数字，这里就不再重复一个标签
  if (role.contrastWithCanvas > 1.01 && !role.nearCanvas) {
    chips.push(`<span class="chip">对比底色 ${role.contrastWithCanvas}:1</span>`);
  }
  if (role.mergedFrom.length > 0) {
    chips.push(`<span class="chip">合并 ${role.mergedFrom.length} 个相近色</span>`);
  }

  return chips.join('');
}

function mergedRow(role: ColorRole): string {
  if (role.mergedFrom.length === 0) return '';
  const dots = role.mergedFrom
    .slice(0, 8)
    .map((m) => {
      // 合并掉的色值界面上只是一个小色点，没有印数字，所以它那一行点开
      // 只有「有哪几个元素」这一件事，数量由状态条和浮层卡当场算给你看
      const attr = tokAttr({ kind: 'color-hex', hex: m.hex });
      const title = `${m.hex}（${m.count} 个元素），点一下标出来`;
      const style = `background:${esc(m.hex)}`;
      const head = attr === '' ? '<span class="merged-dot"' : '<span class="merged-dot tk"';
      return `${head} ${attr} style="${style}" title="${esc(title)}"></span>`;
    })
    .join('');
  return `<div class="merged">${dots}<span class="chip">已与主色合并</span></div>`;
}

/**
 * 近色提示。
 *
 * 单独渲染一块而不是塞进 chips，是因为「对比底色 X:1」那个标签只有数字，
 * 读不出「看不出差别」这层含义。文字由 core/color.ts 生成，同一段话最终
 * 也会写进生成的文件，所以它属于产品输出，不是界面文案。
 */
function nearCanvasBlock(role: ColorRole): string {
  if (!role.nearCanvas) return '';
  return `<div class="near-note">${esc(role.nearCanvas.text)}</div>`;
}

function roleCard(role: ColorRole, index: number): string {
  const badgeClass =
    role.confidence === 'high' ? 'high' : role.confidence === 'low' ? 'low' : '';
  const badgeText =
    role.confidence === 'high' ? '高置信' : role.confidence === 'low' ? '需人工确认' : '中等置信';

  // 页面底色卡只描页面表面；其它色卡点开是三条渠道一起描，卡片里的 chip 各自只描一条渠道。
  // 嵌套点击由事件委托的 closest 取到最里面那个，所以点 chip 走 chip
  const cardAttr = tokAttr({
    kind: 'color',
    index,
    channel: role.token === 'neutral' ? 'background' : 'all',
  });

  return `
    <div class="role${cardAttr === '' ? '' : ' tk'}"${cardAttr}>
      <div class="swatch" style="background:${esc(role.hex)}"></div>
      <div class="role-body">
        <div class="role-head">
          <span class="role-label">${esc(role.label)}</span>
          <code class="token">${esc(role.token)}</code>
          <span class="badge ${badgeClass}">${badgeText}</span>
          <code class="hex">${esc(role.hex.toUpperCase())}</code>
        </div>
        <p class="usage">${esc(role.usage)}</p>
        <div class="chips">${chipList(role, index)}</div>
        ${nearCanvasBlock(role)}
        ${mergedRow(role)}
      </div>
    </div>`;
}

/**
 * 排版阶梯。
 *
 * 这一块和色板分开渲染，因为两者的读法不一样。色板是「挑一个值拿去用」，
 * 排版阶梯是「确认层级对不对」，所以要按字号从大到小顺序铺下来，
 * 让层级关系和落差一眼能看出来。
 */
function typeStepRow(step: TypeStep, index: number): string {
  const meta: string[] = [];
  if (step.headingLevels.length > 0) meta.push(step.headingLevels.map((n) => 'h' + n).join('/'));
  if (step.weights.length > 0) meta.push(`字重 ${step.weights.join('/')}`);
  meta.push(step.lineHeightRatio !== null ? `行高 ${step.lineHeightRatio}` : '行高 normal');
  if (step.letterSpacing !== null) meta.push(`字距 ${step.letterSpacing}px`);

  const families = step.families.length
    ? `<div class="chips">${step.families
        .map((f) => `<span class="chip">${esc(f)}</span>`)
        .join('')}</div>`
    : '';

  const attr = tokAttr({ kind: 'type-step', index });

  return `
    <div class="type-step${attr === '' ? '' : ' tk'}"${attr}>
      <div class="type-size">${step.size}<span>px</span></div>
      <div class="type-body">
        <div class="type-head">
          <span class="role-label">${esc(step.label)}</span>
          <span class="badge ${
            step.confidence === 'high' ? 'high' : step.confidence === 'low' ? 'low' : ''
          }">${
            step.confidence === 'high' ? '高置信' : step.confidence === 'low' ? '需人工确认' : '中等置信'
          }</span>
          <span class="type-meta">${esc(meta.join(' · '))}</span>
        </div>
        <p class="usage">${esc(step.usage)}</p>
        ${families}
      </div>
    </div>`;
}

/**
 * 字体来源的标签。
 *
 * 「页面自带」和「本地不保证有」都用警示色，因为这两种情况在别人的机器上
 * 都会掉到回退字体，是真正需要用户处理的状态；系统字体则不需要任何动作。
 */
function originBadge(origin: FontFamilyStat['origin']): string {
  if (origin === 'font-face') return '<span class="badge low">页面自带</span>';
  if (origin === 'system') return '<span class="badge">系统字体</span>';
  return '<span class="badge low">本地不保证有</span>';
}

function fontRow(f: FontFamilyStat, index: number): string {
  const meta = [
    f.roles.map((r) => ROLE_LABEL[r]).join('、'),
    f.sizes.length > 0 ? `${f.sizes.join(', ')}px` : '',
    `${f.chars} 字`,
  ]
    .filter((s) => s.length > 0)
    .join(' · ');

  const attr = tokAttr({ kind: 'family', index });

  return `
    <div class="font-row${attr === '' ? '' : ' tk'}"${attr}>
      <div class="font-head">
        <span class="font-name">${esc(f.name)}</span>
        ${originBadge(f.origin)}
        ${f.isPrimary ? '<span class="badge high">主要字体</span>' : ''}
      </div>
      <div class="font-meta">${esc(meta)}</div>
    </div>`;
}

/**
 * 自定义字体的替代方案。
 *
 * 给出的是完整可直接粘贴的字体栈，不是一个孤零零的字体名。
 * 只给名字的话，用户还得自己把那串系统回退补回去，而原作者的
 * 回退顺序里带着信息（先试哪个平台字体），不该被丢掉。
 */
function fallbackBlock(analysis: TypographyAnalysis): string {
  if (analysis.fallbacks.length === 0) return '';

  const rows = analysis.fallbacks
    .map(
      (f) => `
      <div class="fallback">
        <p class="usage"><b>${esc(f.family)}</b>　${esc(f.reason)}</p>
        <code class="stack">${esc(f.stack)}</code>
      </div>`,
    )
    .join('');

  return `<p class="section-label">替代方案</p>${rows}`;
}

function typographyNotes(analysis: TypographyAnalysis): string {
  if (analysis.notes.length === 0) return '';
  return `
    <p class="section-label">排版说明</p>
    <div class="bg-note">
      ${analysis.notes.map((n) => `<p class="usage">${esc(n.text)}</p>`).join('')}
    </div>`;
}

function typographySection(analysis: TypographyAnalysis): string {
  if (analysis.steps.length === 0) {
    return `
      <p class="section-label">排版阶梯</p>
      <div class="error">
        <p class="error-title">没有读到可用的字号层级</p>
        <p class="error-body">页面里带文字的元素太少，或者文字渲染在图片和 canvas 里，样式信息读不到。</p>
      </div>`;
  }

  const fonts = analysis.families.length
    ? `<p class="section-label">字体</p>${analysis.families.map((f, i) => fontRow(f, i)).join('')}`
    : '';

  const discarded = analysis.discarded.length
    ? `
    <details>
      <summary>已过滤 ${analysis.discarded.length} 个一次性字号</summary>
      ${analysis.discarded
        .map((d, i) => {
          const attr = tokAttr({ kind: 'type-discard', index: i });
          return `
        <div class="discard-row${attr === '' ? '' : ' tk'}"${attr}>
          <code>${d.size}px</code>
          <span class="discard-reason">${esc(d.reason)}</span>
        </div>`;
        })
        .join('')}
    </details>`
    : '';

  return `
    <p class="section-label">排版阶梯</p>
    ${analysis.steps.map((s, i) => typeStepRow(s, i)).join('')}
    ${fonts}
    ${fallbackBlock(analysis)}
    ${typographyNotes(analysis)}
    ${discarded}`;
}

// ---------------------------------------------------------------------
// 间距与布局
// ---------------------------------------------------------------------

function confidenceBadge(level: 'high' | 'medium' | 'low'): string {
  if (level === 'high') return '<span class="badge high">高置信</span>';
  if (level === 'low') return '<span class="badge low">需人工确认</span>';
  return '<span class="badge">中等置信</span>';
}

function specRow(key: string, val: string): string {
  return `<div class="spec-row"><span class="spec-key">${esc(key)}</span><span class="spec-val">${esc(
    val,
  )}</span></div>`;
}

/**
 * 关键布局参数的汇总。
 *
 * 这几项放进同一张表而不是各占一块，是因为它们要对照着看：基础单位
 * 解释间距档位是怎么来的，内容宽度决定版面骨架，卡片内边距和区块间距
 * 是两处最常用的具体落值。拆成四个区块反而要多滚几屏才能对齐。
 */
function layoutSpec(a: SpacingAnalysis): string {
  const rows: string[] = [];

  if (a.baseUnit === null) {
    rows.push(specRow('间距基础单位', '未能确定'));
  } else {
    rows.push(
      '<div class="spec-row">' +
        '<span class="spec-key">间距基础单位</span>' +
        `<span class="spec-val">${a.baseUnit}px</span>` +
        `<span class="spec-meta">覆盖 ${Math.round(a.baseCoverage * 100)}%</span>` +
        confidenceBadge(a.baseUnitConfidence) +
        '</div>',
    );
  }

  if (a.contentMaxWidth !== null) rows.push(specRow('内容最大宽度', `${a.contentMaxWidth}px`));
  if (a.cardPadding) {
    rows.push(specRow('卡片内边距', `水平 ${a.cardPadding.x}px · 垂直 ${a.cardPadding.y}px`));
  }
  if (a.sectionGap !== null) rows.push(specRow('区块之间的间距', `${a.sectionGap}px`));

  return `<div class="spec">${rows.join('')}</div>`;
}

function spacingStepRow(step: SpacingStep, index: number): string {
  const chips: string[] = [];
  if (step.units > 0) chips.push(`<span class="chip">${step.units} 单位</span>`);
  for (const s of step.sources) chips.push(`<span class="chip">${esc(SOURCE_LABEL[s])}</span>`);

  const conf =
    step.confidence === 'high' ? '高置信' : step.confidence === 'low' ? '需人工确认' : '中等置信';

  const attr = tokAttr({ kind: 'spacing-step', index });

  return `
    <div class="space-step${attr === '' ? '' : ' tk'}"${attr}>
      <div class="space-value">${step.value}<span>px</span></div>
      <div class="space-body">
        <div class="space-head">
          ${chips.join('')}
          <span class="space-meta">${conf}</span>
        </div>
        <p class="usage">${esc(step.usage)}</p>
      </div>
    </div>`;
}

function radiusRow(r: RadiusStep, index: number): string {
  const attr = tokAttr({ kind: 'radius', index });
  return `
    <div class="radius-row${attr === '' ? '' : ' tk'}"${attr}>
      <code class="radius-val">${r.value >= PILL_RADIUS ? '胶囊' : `${r.value}px`}</code>
      <span class="radius-desc">${esc(r.usage)}</span>
      <span class="radius-count">${r.count} 处</span>
    </div>`;
}

function spacingNotes(a: SpacingAnalysis): string {
  if (a.notes.length === 0) return '';
  return `
    <p class="section-label">布局说明</p>
    <div class="bg-note">
      ${a.notes.map((n) => `<p class="usage">${esc(n.text)}</p>`).join('')}
    </div>`;
}

function spacingSection(a: SpacingAnalysis): string {
  if (a.steps.length === 0 && a.contentMaxWidth === null && a.radii.length === 0) {
    return `
      <p class="section-label">间距与布局</p>
      <div class="error">
        <p class="error-title">没有读到可用的间距</p>
        <p class="error-body">页面里没有一个元素带内边距、外边距或子项间距。
        样式可能全部来自图片，或者内容渲染在 canvas 里。</p>
      </div>`;
  }

  const widthNote = a.contentWidthNote ? `<p class="usage">${esc(a.contentWidthNote)}</p>` : '';

  const steps = a.steps.length
    ? `<p class="section-label">间距档位</p>${a.steps.map((s, i) => spacingStepRow(s, i)).join('')}`
    : '';

  const radii = a.radii.length
    ? `<p class="section-label">圆角</p><div class="radius-list">${a.radii
        .map(radiusRow)
        .join('')}</div>`
    : '';

  const discarded = a.discarded.length
    ? `
    <details>
      <summary>已过滤 ${a.discarded.length} 个不规律间距</summary>
      ${a.discarded
        .map((d, i) => {
          const attr = tokAttr({ kind: 'spacing-discard', index: i });
          return `
        <div class="discard-row${attr === '' ? '' : ' tk'}"${attr}>
          <code>${d.value}px</code>
          <span class="discard-reason">${esc(d.reason)}</span>
        </div>`;
        })
        .join('')}
    </details>`
    : '';

  return `
    <p class="section-label">间距与布局</p>
    ${layoutSpec(a)}
    ${widthNote}
    ${steps}
    ${radii}
    ${spacingNotes(a)}
    ${discarded}`;
}

// ---------------------------------------------------------------------
// 圆角、边框与投影
// ---------------------------------------------------------------------

function radiusKindRow(r: RadiusByKind, index: number): string {
  const others = r.others.length
    ? `<span class="effect-extra">另有 ${r.others.map(radiusLabel).join('、')}</span>`
    : '';
  // 这一行右边写的「N 个」是这一类里所有带圆角的元素，不只是主档那几个，
  // 所以点开描的是整类。主档和其余档的差别由「另有」那句话交代
  const attr = tokAttr({ kind: 'radius-kind', index });
  return `
    <div class="effect-row${attr === '' ? '' : ' tk'}"${attr}>
      <span class="effect-kind">${esc(r.label)}</span>
      <code class="effect-val">${esc(radiusLabel(r.radius))}</code>
      ${others}
      <span class="effect-count">${r.count} 个</span>
    </div>`;
}

function borderRow(b: BorderGroup, index: number): string {
  const sideText = b.sides >= 4 ? '四边' : `${b.sides} 边`;
  const dot = b.color ? `<span class="merged-dot" style="background:${esc(b.color)}"></span>` : '';
  const kinds = b.kinds.length ? ` 出现在${esc(describeKinds(b.kinds))}上。` : '';
  const attr = tokAttr({ kind: 'border', index });
  return `
    <div class="effect-row${attr === '' ? '' : ' tk'}"${attr}>
      <code class="effect-val">${b.width}px ${esc(b.style)}</code>
      <span class="effect-kind">${esc(sideText)}</span>
      ${dot}
      <span class="effect-count">${b.count} 处</span>
    </div>
    <p class="usage">${esc(b.usage)}${kinds}</p>`;
}

function shadowRow(g: ShadowGroup, index: number): string {
  const kinds = g.kinds.length ? ` 出现在${esc(describeKinds(g.kinds))}上。` : '';
  const attr = tokAttr({ kind: 'shadow', index });
  return `
    <div class="effect-row${attr === '' ? '' : ' tk'}"${attr}>
      <code class="stack">${esc(g.css)}</code>
      <span class="effect-count">${g.count} 处</span>
    </div>
    <p class="usage">${esc(g.usage)}${kinds}</p>`;
}

/**
 * 圆角、边框与投影。
 *
 * 和间距那一块分开渲染，因为两者回答的问题不同。间距给的是「有哪几档」，
 * 这一块给的是「哪一档用在哪些元素上」。圆角在两处都会出现，但一处是
 * 取值阶梯，一处是按元素类型的归属，读的时候不会混。
 *
 * 没有投影的说明放在最前面。这一条是必须交代的结论，不能被当成
 * 「这一块没有数据」而沉到下面去。
 */
function effectsSection(e: EffectsAnalysis): string {
  const blocks: string[] = [];

  const noShadow = e.notes.filter((n) => n.kind === 'no-shadow');
  if (noShadow.length > 0) {
    blocks.push(`
      <div class="bg-note">
        ${noShadow.map((n) => `<p class="usage">${esc(n.text)}</p>`).join('')}
      </div>`);
  }

  if (e.radii.length > 0) {
    blocks.push(`<p class="section-label">圆角按元素类型</p>
      <div class="effect-list">${e.radii.map((r, i) => radiusKindRow(r, i)).join('')}</div>`);
  }

  if (e.borders.length > 0) {
    blocks.push(`<p class="section-label">边框</p>
      <div class="effect-list">${e.borders.map((b, i) => borderRow(b, i)).join('')}</div>`);
  }

  if (e.shadows.length > 0) {
    blocks.push(`<p class="section-label">投影</p>
      <div class="effect-list">${e.shadows.map((g, i) => shadowRow(g, i)).join('')}</div>`);
  }

  const rest = e.notes.filter((n) => n.kind !== 'no-shadow');
  if (rest.length > 0) {
    blocks.push(`<p class="section-label">说明</p>
      <div class="bg-note">
        ${rest.map((n) => `<p class="usage">${esc(n.text)}</p>`).join('')}
      </div>`);
  }

  if (blocks.length === 0) {
    return `
      <p class="section-label">圆角、边框与投影</p>
      <div class="error">
        <p class="error-title">没有读到圆角、边框或投影</p>
        <p class="error-body">页面上没有元素带这三项中的任何一项。样式可能全部来自图片，
        或者内容渲染在 canvas 里。</p>
      </div>`;
  }

  return `<p class="section-label">圆角、边框与投影</p>${blocks.join('')}`;
}

// ---------------------------------------------------------------------
// 组件
// ---------------------------------------------------------------------

function componentCard(c: ComponentSpec, index: number): string {
  const rows: string[] = [];

  rows.push(specRow('背景色', c.backgroundColor ?? '无填充'));
  rows.push(specRow('文字色', c.textColor ?? '未能读到'));
  rows.push(specRow('圆角', radiusLabel(c.radius)));
  rows.push(specRow('内边距', `左右 ${c.paddingX}px · 上下 ${c.paddingY}px`));
  rows.push(specRow('字号 / 字重', `${c.fontSize}px / ${c.fontWeight}`));
  rows.push(specRow('字体', c.fontFamily || '未能读到'));
  if (c.borderWidth > 0) {
    const color = c.borderColor ?? '';
    rows.push(specRow('边框', `${c.borderWidth}px ${c.borderStyle} ${color} (${c.borderSides} 边)`));
  }
  rows.push(specRow('高度', `${c.height}px`));
  if (c.textContrast !== null) rows.push(specRow('文字对比度', `${c.textContrast}:1`));

  // 投影串比较长，放在参数表下面单独一行，整段可复制
  const shadow = c.shadow ? `<code class="stack">${esc(c.shadow)}</code>` : '';

  // 同一种组件在页面上有几种写法，读的人需要知道下面这套的覆盖比例
  const spread =
    c.signatureCount > 1 ? `<span class="effect-extra">共 ${c.signatureCount} 种写法</span>` : '';

  // 按钮这一类在溯源里还要再分主次，判据和识别时那条是同一个函数，
  // 否则点开主按钮会把次按钮一起描出来
  const attr = tokAttr({ kind: 'component', index });

  return `
    <div class="comp${attr === '' ? '' : ' tk'}"${attr}>
      <div class="comp-head">
        <span class="comp-name">${esc(c.label)}</span>
        ${confidenceBadge(c.confidence)}
        ${spread}
        <span class="effect-count">${c.count} 个</span>
      </div>
      <div class="spec">${rows.join('')}</div>
      ${shadow}
      <p class="usage">${esc(c.usage)}</p>
    </div>`;
}

function componentsSection(a: ComponentsAnalysis): string {
  if (a.specs.length === 0) {
    const why = a.notes.length
      ? a.notes.map((n) => `<p class="usage">${esc(n.text)}</p>`).join('')
      : '<p class="usage">页面上没有识别出可描述的组件。</p>';
    return `
      <p class="section-label">组件</p>
      <div class="bg-note">${why}</div>`;
  }

  const list = a.specs.map((c, i) => componentCard(c, i)).join('');

  // 说明里已经包含「只有几类」和「有几种写法」，都是关于覆盖面的，
  // 放在组件列表后面才不会打断「先看参数再看备注」的顺序
  const notes = a.notes.length
    ? `<p class="section-label">组件说明</p>
       <div class="bg-note">
         ${a.notes.map((n) => `<p class="usage">${esc(n.text)}</p>`).join('')}
       </div>`
    : '';

  return `<p class="section-label">组件</p>${list}${notes}`;
}

/**
 * 采样口径。
 *
 * 这一块处理的是「数值本身没错，但得按什么口径读」。全部数值都来自
 * 当前视口下的渲染计算值，响应式页面换个窗口宽度就换一组值，字号层级
 * 的比例关系也会跟着变。不把前提摆出来，读的人会把一份 1440 宽下的
 * 结论当成站点的设计原值，照着复刻就会整片偏掉。
 *
 * 它排在统计行之后、所有结论之前，因为下面每一个数字都要按这个口径读，
 * 放到后面等于让人先把结论看完再回头重看一遍。
 */
function viewportBlock(v: ExportViewport): string {
  return `
    <p class="section-label">采样口径</p>
    <div class="bg-note">
      <p class="usage"><b>视口宽度 ${v.width}px</b></p>
      ${v.lines.map((l) => `<p class="usage">${esc(l)}</p>`).join('')}
    </div>`;
}

/**
 * 覆盖范围说明。
 *
 * 这一块处理的是「采集成功了，但页面主体不在能读到的范围内」，比如内容
 * 全在一个 frame 里，或者嵌了 PDF。这类不是失败，所以不拦成错误页，
 * 而是在结果旁边说清楚色板为什么不完整。
 *
 * 句子直接取自导出快照，不在这里另算一遍。界面和导出文件里说的是不是
 * 同一段话，靠共用一份数据保证，而不是靠两处逻辑写得一样。
 */
function coverageBlock(note: { severe: boolean; lines: string[] }): string {
  return `
    <p class="section-label">覆盖范围</p>
    <div class="bg-note${note.severe ? ' coverage-severe' : ''}">
      ${note.lines.map((l) => `<p class="usage">${esc(l)}</p>`).join('')}
    </div>`;
}

/**
 * 渐变与背景图的检测结果。这一块不进颜色通道，只作为说明展示，
 * 让用户能确认「工具确实看到了渐变」，而不是以为漏采了。
 */
function backgroundSection(sample: PageSample): string {
  // 采集结果穿过一次序列化边界，字段缺失时宁可少显示一块也不要整屏崩掉
  if (!sample.background?.gradient) return '';

  const note = describeBackground(sample.background);
  if (note.lines.length === 0) return '';

  const samples = note.samples.length
    ? `<details>
        <summary>查看 ${note.samples.length} 条原始渐变值</summary>
        ${note.samples.map((s) => `<div class="bg-sample"><code>${esc(s)}</code></div>`).join('')}
      </details>`
    : '';

  return `
    <p class="section-label">无法用色值表达的部分</p>
    <div class="bg-note">
      ${note.lines.map((l) => `<p class="usage">${esc(l)}</p>`).join('')}
    </div>
    ${samples}`;
}

function renderResult(
  sample: PageSample,
  analysis: ColorAnalysis,
  typography: TypographyAnalysis,
  spacing: SpacingAnalysis,
  effects: EffectsAnalysis,
  components: ComponentsAnalysis,
  exported: SampleExport,
  dropped: boolean,
) {
  const stats = [
    `遍历 <b>${sample.visited}</b> 个元素`,
    `跳过 <b>${sample.skipped}</b> 个不可见`,
    `原始色 <b>${analysis.rawColorCount}</b> → 合并后 <b>${analysis.clusterCount}</b>`,
    `字号 <b>${typography.rawSizeCount}</b> → 层级 <b>${typography.steps.length}</b>`,
    `间距 <b>${spacing.rawValueCount}</b> → 档位 <b>${spacing.steps.length}</b>`,
    `组件 <b>${components.kindCount}</b> 类`,
    `耗时 <b>${sample.elapsedMs}ms</b>`,
  ];

  const roleHtml = analysis.roles.length
    ? analysis.roles.map((r, i) => roleCard(r, i)).join('')
    : `<div class="error"><p class="error-title">没有读到任何颜色</p>
       <p class="error-body">页面元素数 ${sample.visited}，但都没有可读取的背景、文字或边框色。
       可能是这个页面靠图片或 canvas 渲染，样式信息不在 DOM 里。</p></div>`;

  const discarded = analysis.discarded.length
    ? `
    <details>
      <summary>已过滤 ${analysis.discarded.length} 个未入选颜色</summary>
      ${analysis.discarded
        .map((d, i) => {
          // 这一行的「出现次数」是按渠道累计的，同一元素的多条渠道在其中
          // 重复计入，所以它和元素数本来就不是一个口径。点开看的是元素数
          const attr = tokAttr({ kind: 'color-discard', index: i });
          return `
        <div class="discard-row${attr === '' ? '' : ' tk'}"${attr}>
          <span class="merged-dot" style="background:${esc(d.hex)}"></span>
          <code>${esc(d.hex.toUpperCase())}</code>
          <span class="discard-reason">${esc(d.reason)}</span>
        </div>`;
        })
        .join('')}
    </details>`
    : '';

  const truncatedWarn = sample.truncated
    ? `<div class="stat" style="border-color:var(--danger-border);color:var(--danger-text)">页面过大，只采集了前 8000 个元素</div>`
    : '';

  // 元素明细因体积被丢弃时，色板、字号、间距这些都还在，唯独点 token 指不出
  // 元素。这件事必须写在结果里，否则用户点了没反应会以为是功能坏了
  const droppedWarn = dropped
    ? `<div class="stat" style="border-color:var(--danger-border);color:var(--danger-text)">元素明细太大，没有留档，点颜色和字号不会在页面上标出元素</div>`
    : '';

  // 色板严重不完整时，提示必须出现在色板前面。否则用户先看到一屏看似正常的
  // 色卡，往下滚才看到「这些颜色其实不代表这个页面」，顺序是反的。
  const coverage = exported.coverage;
  const coverageHtml = coverage ? coverageBlock(coverage) : '';
  const coverageFirst = coverage?.severe ? coverageHtml : '';
  const coverageAfter = coverage && !coverage.severe ? coverageHtml : '';
  const roleLabel = coverage?.severe ? '颜色用途（色板可能不完整）' : '颜色用途';

  // 口径说明取自导出快照，和写进文件的是同一份数据，不在这里另算一遍
  const viewportHtml = exported.viewport ? viewportBlock(exported.viewport) : '';

  root.innerHTML = `
    ${headerHtml(sample.title, sample.url)}
    ${actionBarHtml()}
    <div class="stats">
      ${stats.map((s) => `<span class="stat">${s}</span>`).join('')}
      ${truncatedWarn}
      ${droppedWarn}
    </div>
    ${viewportHtml}
    ${coverageFirst}
    <p class="section-label">${roleLabel}</p>
    ${roleHtml}
    ${coverageAfter}
    ${backgroundSection(sample)}
    ${typographySection(typography)}
    ${spacingSection(spacing)}
    ${effectsSection(effects)}
    ${componentsSection(components)}
    ${discarded}
    <div class="foot">
      合计 ${analysis.roles.length} 个颜色角色、${typography.steps.length} 级字号、${spacing.steps.length} 档间距、
      ${components.kindCount} 类组件。
      采集与分析已经覆盖颜色、排版、间距、边缘与组件五条线。产物条上的三个按钮依次是复制、
      下载 DESIGN.md、下载 JSON 留档。DESIGN.md 可以直接放进项目根目录给编码 agent 读。
      配好模型之后，其中的人读部分会由模型补上风格综述与语义说明，数值始终来自本次采集。
    </div>`;

  bindHeader();
  bindExport();
  bindAiNote();
  // 上面那句 innerHTML 把状态条一起换掉了，这里挂回末尾。不动它的显隐，
  // 所以用户如果点着高亮又重新提取，条还在，只是重新对上了新的一份结果
  reattachStrip();
}

// ---------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------

/**
 * 已经为哪一份结果发起过模型补全。
 *
 * 记 at 而不是一个布尔值，因为每次点图标都是一份新结果。只看「补过没有」
 * 的话，第二次提取会被当成已经补过而跳过。
 */
let enhancedFor: number | null = null;

/**
 * 面板自己不做采集，所以这里也没有「提取」这个动作，只有把当下的状态画出来。
 *
 * 采集全程在背景脚本里，能用 activeTab 的只有点图标那一刻，这是官方定下的
 * 规矩，绕不过去。面板要做的就两件事：打开时读一次已经存下的状态，以及在它
 * 变化时跟着变。
 */
function renderState(state: PanelState | null, tabId: number | null): void {
  const source = sourceOf(state);

  // 面板是窗口级的东西，切到别的标签页它不会自己消失。这一页没有提取过，就不该
  // 把上一页的结果摆在它旁边——那会让人以为这份数据是这一页的，而这个扩展的全部
  // 价值就在于「界面上的数字确实是这一页的」。
  //
  // 判据只取「两边都认得出是哪一页、且对不上」。任一边为空时放行：读不到当前页
  // 只说明读不到，不能据此否掉一份真数据。
  if (
    state &&
    source &&
    source.tabId !== null &&
    tabId !== null &&
    source.tabId !== tabId
  ) {
    lastSource = null;
    paintCollapsed();
    renderIdle();
    return;
  }

  // 源信息先记下来再渲染。窄条上那行字取自这里，而窄条不走 #app 的重渲染，
  // 它得知道这是哪一页
  lastSource = source;
  paintCollapsed();

  if (!state) {
    renderIdle();
    return;
  }

  if (state.status === 'loading') {
    renderLoading(state.source);
    return;
  }

  if (state.status === 'notice') {
    renderNotice(state.notice, state.source);
    return;
  }

  renderResultState(state);
}

/** 面板被直接打开、还没点过图标时的样子 */
function renderIdle(): void {
  root.innerHTML = `
    ${headerHtml('还没有提取过')}
    <div class="state">点一下工具栏上的插件图标，读取当前页面的渲染样式。</div>`;
  bindHeader();
  resetStrip();
  reattachStrip();
}

function renderResultState(state: PanelResult): void {
  const { sample, colors, typography, spacing, effects, components } = state;

  // 快照先组出来，界面再照着它渲染。这样导出的内容和屏幕上看到的是同一批
  // 数据，不会出现「界面上有、文件里没有」这种错位。
  //
  // 时间戳取采集那一刻，不取此刻。面板关掉再打开会重新走一遍这里，用此刻的话
  // 同一个页面每看一次文件名就换一次
  const exported = buildSampleExport({
    sample,
    colors,
    typography,
    spacing,
    effects,
    components,
    extractorVersion: chrome.runtime.getManifest().version,
    generatedAt: new Date(state.at),
  });

  // 溯源要拿到这一份分析结果，才能把界面上点中的那个 token 还原成元素。
  // 交给它的是同一批对象，不是重新算一遍：重算一次就多一份可能和界面上
  // 不一致的数据，而「界面上的数字和描出来的元素数相等」这件事正是这个
  // 功能要保证的。
  //
  // tabId 为空说明那一轮连标签页都没认出来，那种情况走的是提示页，到不了这里；
  // 判一下是为了让类型收窄，不是真有这一支
  if (state.tabId !== null) {
    setProvenanceContext(state.tabId, {
      sample,
      colors,
      typography,
      spacing,
      effects,
      components,
    });
  }

  // 产物先按本地版组装好并且绑上按钮，AI 补全再在此之后尝试。
  // 顺序不能反：补全要等网络，而用户不该为了等一个可能要半分钟的请求
  // 才能导出。这里先让他能拿走东西，再谈锦上添花
  publishArtifacts(exported, null);
  renderResult(sample, colors, typography, spacing, effects, components, exported, state.dropped);

  // 同一份结果只补一次。存储每变一次这里就跑一遍，不设这道闸的话，第二次
  // 提取会把上一次的补全重来一遍
  if (enhancedFor !== state.at) {
    enhancedFor = state.at;
    void maybeEnhance(sample, exported, state.dropped);
  }
}

async function refresh(): Promise<void> {
  try {
    renderState(await loadPanelState(), await activeTabId());
  } catch {
    // 读不到状态和没有状态画出来是同一个样子，不必分成两种
    renderIdle();
  }
}

/**
 * 面板所在窗口当前选中的是哪个标签页。
 *
 * 用来判手上这份结果是不是这一页的。读不到返回 null，那边按「放行」处理——
 * 读不到只说明读不到，不能据此否掉一份真数据。
 */
async function activeTabId(): Promise<number | null> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * 切换标签页时重新判一遍手上这份结果是不是这一页的。
 *
 * 面板是窗口级的，切走它不会自己关，只有我们自己知道该不该继续显示。这件事没有
 * 交给 tabs 权限判断，onActivated 不需要任何权限就能拿到标签页编号，而编号正是
 * 这里唯一用得上的东西。
 */
chrome.tabs.onActivated.addListener(() => {
  void refresh();
});

/**
 * 面板已经开着时，靠存储变化跟上新的结果。
 *
 * 用存储变化而不是运行消息当信号，是因为两边谁先就绪没有保证。点图标那一刻
 * 面板可能还没加载完，发过去的那条消息就丢了；而状态已经落在存储里，晚起的
 * 面板读得到。两种时机各配一条路径，就没有漏的。
 */
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'session' || !(PANEL_STATE_KEY in changes)) return;
  void refresh();
});

/**
 * 面板被关掉时把在途的模型调用掐掉。
 *
 * 不掐也不会出错，页面销毁本来就会连带取消请求。显式取消是为了让那次
 * 调用的 Promise 走到 aborted 分支而不是悬着，避免在控制台留下一串
 * 未处理的拒绝。
 */
window.addEventListener('pagehide', () => {
  aiAbort?.abort();
});

// 状态条和点击委托都只挂一次。它们挂在 body 和 root 上，这两个节点不会
// 被重渲染换掉，所以放在这里而不是每渲染一次就绑一遍
mountStrip(root);
bindTokenClicks();

/**
 * 起飞。
 *
 * 折叠状态要在第一次渲染之前读出来。不先读的话，每次切回这个标签页，面板都会
 * 先铺满一整屏再啪地收成窄条。读失败按展开处理，那是有内容可选的一边。
 */
async function boot(): Promise<void> {
  try {
    collapsed = await loadCollapsed();
  } catch {
    collapsed = false;
  }
  paintCollapsed();
  await refresh();
}

void boot();
