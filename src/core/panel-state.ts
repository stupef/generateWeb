/**
 * 面板状态。点图标那一次采集的结果，从这里过一手交给侧边栏。
 *
 * 为什么中间要隔一层存储：点图标和面板打开是两件事，谁先就绪没有保证。
 * 采集发生在背景脚本里，面板是被它顺带打开的另一个页面，等面板的脚本跑起来
 * 时，采集可能已经结束、也可能还没开始。存一层，两边就各自独立了——面板
 * 什么时候起来都能读到当下的状态。
 *
 * 为什么用会话存储而不是本地存储：这份数据的有效期就是这一次浏览器会话。
 * 过了这次它只是一张过期的页面快照，留着没有意义，还要额外写清理逻辑。
 * 会话存储在关浏览器时自己就没了，正好对上这个生命周期。
 *
 * 体积上留了一手。会话存储的上限是 10MB，绝大多数页面用不到十分之一，但
 * 元素数接近采集上限的页面能把明细撑到几 MB。写入失败时丢掉元素明细再存
 * 一次，分析结果本身照常显示，只是溯源那一项用不了。丢掉这件事记在 dropped
 * 上如实交给界面去说，不在这里悄悄吞掉。
 */

import type { PageSample } from './types';
import type { Diagnosis } from './diagnose';
import type { ColorAnalysis } from './color';
import type { TypographyAnalysis } from './typography';
import type { SpacingAnalysis } from './spacing';
import type { EffectsAnalysis } from './effects';
import type { ComponentsAnalysis } from './components';

export const PANEL_STATE_KEY = 'panelState';

/**
 * 面板是不是折叠成了窄条。
 *
 * 和结果放在同一个存储里，但各占一个键。面板被折叠这件事和面板显示的是哪一份
 * 数据没有关系，混在一个键里的话，折叠一次就等于改一次结果，界面会跟着重渲染
 * 一遍，白费一次分析快照的组装。
 */
const COLLAPSED_KEY = 'panelCollapsed';

/**
 * 这份结果对应的页面。
 *
 * tabId 有两个用处，界面里说清「这是哪一页提取的」，以及溯源时把高亮注入回
 * 去。地址和标题只用于显示，拿不到就是空串，不影响结果本身。
 */
export interface PanelSource {
  tabId: number | null;
  url: string;
  title: string;
}

/** 一次成功采集的全部产物。数值来自同一次采集，界面和导出共用这一份 */
export interface PanelResult extends PanelSource {
  sample: PageSample;
  colors: ColorAnalysis;
  typography: TypographyAnalysis;
  spacing: SpacingAnalysis;
  effects: EffectsAnalysis;
  components: ComponentsAnalysis;
  /** 元素明细因体积被丢弃。为真时溯源不可用，界面要说明 */
  dropped: boolean;
  /** 采集完成的时刻 */
  at: number;
}

export type PanelState =
  | { status: 'loading'; source: PanelSource; at: number }
  | { status: 'notice'; notice: Diagnosis; source: PanelSource; at: number }
  | ({ status: 'result' } & PanelResult);

/** 存储里那份数据穿过了一次序列化边界，认不出来的就当没有 */
function isPanelState(raw: unknown): raw is PanelState {
  if (typeof raw !== 'object' || raw === null) return false;
  const status = (raw as { status?: unknown }).status;
  return status === 'loading' || status === 'notice' || status === 'result';
}

async function write(state: PanelState): Promise<void> {
  await chrome.storage.session.set({ [PANEL_STATE_KEY]: state });
}

/**
 * 存一份状态，必要时降级。
 *
 * 返回真正落进去的那一份，而不是传进来的那一份。降级之后两者不一样，调用方
 * 需要知道究竟是哪一种，否则「明细已丢弃」这件事传不到界面上。
 */
export async function savePanelState(state: PanelState): Promise<PanelState> {
  try {
    await write(state);
    return state;
  } catch (err) {
    // 提示页和加载页都很小，走到降级这一步只可能是结果太大。
    // 明细本来就是空的就无从再降，让它把原始错误抛出去
    if (state.status !== 'result' || state.sample.elements.length === 0) throw err;

    const slim: PanelState = {
      ...state,
      dropped: true,
      // 只清明细。visited、skipped、elapsedMs 这几个计数和背景摘要都留在原处，
      // 统计行与渐变说明照常显示，掉的那块严格限定在元素明细上
      sample: { ...state.sample, elements: [] },
    };
    await write(slim);
    return slim;
  }
}

export async function loadPanelState(): Promise<PanelState | null> {
  const bag = await chrome.storage.session.get(PANEL_STATE_KEY);
  const raw = bag[PANEL_STATE_KEY];
  return isPanelState(raw) ? raw : null;
}

/**
 * 面板的折叠状态。默认展开，读不到就是展开。
 *
 * 为什么它也要落存储：面板被关掉再打开是一次销毁重建，切标签页时内容跟着换
 * 也会重渲染一遍。不存的话，用户折好了窄条，一趟回来又弹成一整屏，等于没折。
 */
export async function loadCollapsed(): Promise<boolean> {
  const bag = await chrome.storage.session.get(COLLAPSED_KEY);
  return bag[COLLAPSED_KEY] === true;
}

export async function saveCollapsed(collapsed: boolean): Promise<void> {
  await chrome.storage.session.set({ [COLLAPSED_KEY]: collapsed });
}
