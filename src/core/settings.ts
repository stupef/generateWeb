/**
 * 设置与网络权限的读写。
 *
 * 这是接入层里唯一碰 chrome API 的文件。切得这么干净，是为了让上面所有模块
 * 都能在 Node 里直接跑：检查脚本要覆盖的失败分支（401、超时、截断、脏数据）
 * 一条都不需要浏览器或真实网络。
 *
 * ── Key 存在哪 ──
 *
 * chrome.storage.local。三个候选都考虑过：
 *
 *   storage.sync   会把用户的 Key 同步到他的 Google 账号，多一份不该有的副本
 *   内存           关掉插件就没了，而验收标准明确要求重启后保留
 *   storage.local  存在本机 profile 目录里，不加密但也不出本机
 *
 * 选第三个，代价是它没有加密。这一点不藏着，设置页上直接写出来：任何能读到
 * 这个 profile 目录的人都能看到 Key。这是 BYOK 类工具的通行取舍，用户拿自己
 * 的 Key 换掉「把 Key 交给第三方服务」。
 *
 * 另外这个 Key 不会进导出快照。快照里只有分析结论和原始观测，没有任何配置项，
 * 所以导出的 JSON 是可以直接分享的。
 */
import type { LlmSettings } from './llm/types';
import { defaultLlmSettings, normalizeLlmSettings, originPatternOf } from './llm/config';

/** 存储键。带版本后缀，将来形状变了可以并存而不是就地覆盖 */
export const LLM_SETTINGS_KEY = 'design-md-extractor/llm@1';

export async function loadLlmSettings(): Promise<LlmSettings> {
  try {
    const bag = await chrome.storage.local.get(LLM_SETTINGS_KEY);
    const raw = bag?.[LLM_SETTINGS_KEY];
    if (raw === undefined) return defaultLlmSettings();
    // 存储里的东西可能是任意形状：装过旧版本、被手工改过、上次写到一半被杀。
    // 一律过一遍归一化，脏数据回落到默认值，而不是让一个 undefined 渗到
    // 适配器里拼出 "undefined/chat/completions" 这种没法排查的地址
    return normalizeLlmSettings(raw);
  } catch {
    // 存储读不出来（极少见，权限被撤销或 profile 损坏）时当作没配过。
    // 这条路径必须能走通，否则用户连本地版都用不了
    return defaultLlmSettings();
  }
}

export async function saveLlmSettings(settings: LlmSettings): Promise<void> {
  await chrome.storage.local.set({ [LLM_SETTINGS_KEY]: settings });
}

/** 清空配置。只删这一个键，不碰存储里的其它东西 */
export async function clearLlmSettings(): Promise<void> {
  await chrome.storage.local.remove(LLM_SETTINGS_KEY);
}

/**
 * 这个基址当前有没有网络权限。
 *
 * 地址非法时返回 true。调用方拿到 true 不会去申请权限，也就不会把一个
 * 「地址本身就不对」的情况错报成「权限没给」。
 */
export async function hasOriginPermission(baseUrl: string): Promise<boolean> {
  const pattern = originPatternOf(baseUrl);
  if (!pattern) return true;
  try {
    return await chrome.permissions.contains({ origins: [pattern] });
  } catch {
    return true;
  }
}

/**
 * 按需申请网络权限。
 *
 * 必须在用户手势里调用，也就是直接从按钮的点击处理函数里走下来，中间不能
 * 夹 await 之外的异步跳转。Chrome 在非手势上下文里会静默拒绝，表现是弹窗
 * 不出现、权限拿不到，而代码这边只看到返回 false。
 *
 * 只申请这一个域名，而不是一次性把整个 https 段全要下来。扩展安装提示里
 * 因此不会出现「读取你在所有网站上的数据」这一条——项目之前为了不加
 * downloads 权限宁愿走 blob 下载，同一个取舍。
 *
 * 返回 true 也可能是「本来就有了」，两种情况调用方都不用区分。
 */
export async function ensureOriginPermission(baseUrl: string): Promise<boolean> {
  const pattern = originPatternOf(baseUrl);
  if (!pattern) return false;
  if (await hasOriginPermission(baseUrl)) return true;
  try {
    return await chrome.permissions.request({ origins: [pattern] });
  } catch {
    return false;
  }
}
