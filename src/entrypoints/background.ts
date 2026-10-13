/**
 * 背景脚本。点插件图标这件事全部落在这里。
 *
 * 为什么提取要在这个文件里发起，而不是像原来那样在界面里：activeTab 是
 * 「用户直接作用于扩展」那一刻才授予的权限，点图标、右键菜单、快捷键、
 * 地址栏建议这四种。在侧边栏里点按钮不在其中，官方文档专门提醒过这一点。
 * 所以侧边栏自己注入不了脚本，能用这个权限的只有这里，也就是点击发生的那
 * 个回调。
 *
 * 于是点图标这一个动作要连着做完三件事：开面板、采集、把结果存下来给面板读。
 * 第一件必须发生在手势里，第二件只有这里做得了，第三件是前两件的交接。
 *
 * 面板始终保持可用，作用域由侧边栏自己按当前 tabId 判断。不能用 tab-specific
 * enabled:false 隐藏无结果页：那会让该页的 action 变灰，点击回调不再触发，整套提取
 * 都无法从那些页面开始。
 *
 * 同样不能改用 setPanelBehavior({ openPanelOnActionClick: true }) 让 Chrome 自己开面板。
 * 那一项会让 Chrome 把这次点击整个消费掉，onClicked 不再触发，而采集只能发生在这个
 * 回调里，于是面板开出来是空的、点第二下还会把它关掉，看着和「彻底坏了」没有区别。
 *
 * 这一项还是浏览器持久化保存的。所以光把它从代码里删掉不够：某个历史版本设过的 true
 * 会一直留在浏览器里继续吞点击，重载扩展也带不走，必须显式设回 false。这个拨回来的
 * 动作交给 healPanelBehavior 在每次启动时做一遍，装上就自愈，不必再让人去翻控制台。
 * 这份「和残留状态对着干」的活儿这里只留这一处——它关的是一个我们从来不用的行为
 * 开关，不碰任何标签页的可点状态，和当初那版拿 setOptions 管作用域是两码事。
 */

import { defineBackground } from 'wxt/utils/define-background';
import { collectPageSample } from '@/core/collector';
import { analyzeColors } from '@/core/color';
import { analyzeTypography } from '@/core/typography';
import { analyzeSpacing } from '@/core/spacing';
import { analyzeEffects } from '@/core/effects';
import { analyzeComponents } from '@/core/components';
import {
  diagnoseInjectionError,
  diagnoseMissingSample,
  diagnoseUrl,
} from '@/core/diagnose';
import { savePanelState, type PanelSource, type PanelState } from '@/core/panel-state';
import type { PageSample } from '@/core/types';

export default defineBackground(() => {
  // 每次 worker 起来先拨一遍。这里有两条路：顶层这一次覆盖「扩展被重载」，
  // 另一个监听覆盖「装完」和「开机」。点图标那一刻的冷启动赶不上它——事件是在
  // 顶层脚本跑完之后才派发的——但那一次本来就已经因为残留状态被吞掉了，只能靠
  // 以上任一条路先把状态清掉，之后才恢复正常
  healPanelBehavior();
  chrome.runtime.onInstalled.addListener(healPanelBehavior);
  chrome.runtime.onStartup.addListener(healPanelBehavior);

  chrome.action.onClicked.addListener((tab) => {
    openPanel(tab);
    void extract(tab);
  });
});

/**
 * 把浏览器替我们存着的侧边栏行为拨回手动模式。
 *
 * 只有这一个方向：openPanelOnActionClick 必须是 false。它为 true 时 Chrome 会自己
 * 接管点图标这个动作，onClicked 不再触发，而采集只能发生在那个回调里，于是面板开
 * 出来是空的。这个值由浏览器持久化保存，重载扩展清不掉，只能显式改写。
 *
 * 拨不回去的后果只是面板空着，那件事界面自己会说明，所以这里任何失败都不往上抛。
 */
function healPanelBehavior(): void {
  // 这一句在顶层同步跑。它要是抛出去，整个 worker 加载失败，onClicked 连注册都
  // 到不了，症状比它要修的那个还要重，所以同步异常和异步拒绝都要接住。
  // 拨不回去只意味着面板会空着，那已经由界面自己说明，不值得再赔上整条链路
  try {
    if (typeof chrome.sidePanel?.setPanelBehavior !== 'function') return;
    void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
  } catch {
    // 见上
  }
}

/**
 * 把侧边栏打开在点图标的这个标签页上。
 *
 * 不在这里先 await 任何配置调用，以免耗掉点击手势、导致 open() 被拒绝。这里先同步
 * 打开面板，然后立刻开始采集。
 */
function openPanel(tab: chrome.tabs.Tab): void {
  if (typeof chrome.sidePanel?.open !== 'function' || tab.id === undefined) return;

  void chrome.sidePanel.open({ tabId: tab.id }).catch(() => {
    // 面板本来就开着，或者这一页不允许开。两种都不需要用户知道
  });
}

/**
 * 落一次状态。
 *
 * 写失败只意味着这一轮没能留给面板，采集本身可能已经成功了，所以这里不往外
 * 抛。面板读不到新状态会停在加载态，那已经是当下能给出的准确说明，不必再往
 * 用户那儿叠一层错误。
 */
async function publish(state: PanelState): Promise<void> {
  try {
    await savePanelState(state);
  } catch {
    // 会话存储满了又降不了级。留白好过编一句不知道对不对的话
  }
}

async function extract(tab: chrome.tabs.Tab): Promise<void> {
  const source: PanelSource = {
    tabId: tab.id ?? null,
    url: tab.url ?? '',
    title: tab.title ?? '',
  };

  const tabId = tab.id;
  if (tabId === undefined) {
    await publish({
      status: 'notice',
      source,
      at: Date.now(),
      notice: {
        kind: 'no-data',
        title: '没有找到当前标签页',
        body: '请选中一个网页标签页后再点插件图标。',
        retryable: true,
      },
    });
    return;
  }

  await publish({ status: 'loading', source, at: Date.now() });

  // 本地文件是唯一一项地址里问不出来的事——同一个 file 地址，开关开着能读、
  // 关着不能读，长得一模一样。所以先把开关的当前位置查清楚再交给预判。
  // 查不到就当未知传下去，猜错的代价是把这个本来能采的页面判成不能采，
  // 而按未知处理只会多绕一次注入，失败也由报错归类接住
  let fileAccess: boolean | undefined;
  try {
    fileAccess = await chrome.extension.isAllowedFileSchemeAccess();
  } catch {
    fileAccess = undefined;
  }

  const blocked = diagnoseUrl(tab.url, { fileAccess });
  if (blocked) {
    await publish({ status: 'notice', source, at: Date.now(), notice: blocked });
    return;
  }

  let sample: PageSample | undefined;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: collectPageSample,
    });
    sample = results?.[0]?.result as PageSample | undefined;
  } catch (err) {
    await publish({
      status: 'notice',
      source,
      at: Date.now(),
      notice: diagnoseInjectionError(err),
    });
    return;
  }

  if (!sample || !Array.isArray(sample.elements)) {
    await publish({
      status: 'notice',
      source,
      at: Date.now(),
      notice: diagnoseMissingSample(),
    });
    return;
  }

  // 分析放在这里而不是面板里，是为了让降级路径成立。元素明细超限被丢掉之后
  // 就没法再从它算出任何东西，所以结果必须在丢之前算好、跟着一起存下来。
  // 顺带也省掉了面板每次重开都要重算一遍
  try {
    await publish({
      status: 'result',
      ...source,
      sample,
      colors: analyzeColors(sample),
      typography: analyzeTypography(sample),
      spacing: analyzeSpacing(sample),
      effects: analyzeEffects(sample),
      components: analyzeComponents(sample),
      dropped: false,
      at: Date.now(),
    });
  } catch (err) {
    await publish({
      status: 'notice',
      source,
      at: Date.now(),
      notice: diagnoseInjectionError(err),
    });
  }
}
