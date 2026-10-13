/**
 * 接入配置的取值、归一化与地址工具。
 *
 * 这个模块也是纯的，但它守的是一条容易被忽略的边界：配置来自 chrome.storage，
 * 而 storage 里的东西可能是任意形状。用户可能装过旧版本、可能手动改过存储、
 * 也可能上一次保存写了一半就被杀掉。把这些脏数据直接喂给适配器，表现是
 * 「请求 URL 变成 undefined/chat/completions」这种没法从报错里看出原因的东西。
 *
 * 所以读写路径上强制过一次 normalize：认识的字段留下并规范化，不认识的丢掉，
 * 类型不对的回落到默认值。归一化本身是纯函数，能在 Node 里用任意脏输入测。
 */
import type { LlmConfig, LlmProtocol, LlmSettings } from './types';

/**
 * 默认单次生成上限。
 *
 * 这份产出是一小段 JSON（十来句短文案），两千 token 有充分余量。上限的意义
 * 不在于够不够，而在于失控时有个止损：模型偶尔会跑进复读循环，不设上限
 * 会一路烧到上下文窗口再截断，账单和等待时间都不可预期。
 *
 * 注意这个值只在真正支持它的协议上生效。Anthropic 必填、Gemini 用得上，
 * 而 OpenAI 兼容那一条是**故意不发**的，理由写在 providers.ts 顶上：两代
 * 上限参数的适用模型不重叠，发哪个都会在某些模型上报 400。
 */
export const DEFAULT_MAX_TOKENS = 2048;

/** 探测请求只要求回一个词，给足余量也不到一百 token */
export const PROBE_MAX_TOKENS = 32;

export const LLM_PROTOCOLS: readonly LlmProtocol[] = ['openai', 'anthropic', 'gemini'];

export const PROTOCOL_LABEL: Record<LlmProtocol, string> = {
  openai: 'OpenAI 兼容',
  anthropic: 'Anthropic Messages',
  gemini: 'Google Gemini',
};

export function isLlmProtocol(v: unknown): v is LlmProtocol {
  return typeof v === 'string' && (LLM_PROTOCOLS as readonly string[]).indexOf(v) !== -1;
}

/** 完全空白的配置。界面上「清空配置」也回到这里 */
export function blankConfig(): LlmConfig {
  return {
    protocol: 'openai',
    baseUrl: '',
    apiKey: '',
    model: '',
    maxTokens: DEFAULT_MAX_TOKENS,
  };
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

/**
 * 把任意输入收成一份能用的配置。
 *
 * maxTokens 做了上下夹取。上限太大等于没设；太小会让模型把 JSON 截断成
 * 半个对象，而截断后的报错是「JSON 解析失败」，看起来很像是模型不会用 JSON，
 * 实际原因是这里配错了，很难从现象倒推回来。
 */
export function normalizeLlmConfig(raw: unknown): LlmConfig {
  const src = (raw ?? {}) as Record<string, unknown>;
  const base = blankConfig();

  const size =
    typeof src.maxTokens === 'number' && Number.isFinite(src.maxTokens)
      ? Math.round(src.maxTokens)
      : base.maxTokens;

  return {
    protocol: isLlmProtocol(src.protocol) ? src.protocol : base.protocol,
    // 末尾斜杠在这里就去掉，后面 joinUrl 只处理这一种情况，不用两处都防
    baseUrl: str(src.baseUrl).trim().replace(/\/+$/, ''),
    apiKey: str(src.apiKey).trim(),
    model: str(src.model).trim(),
    maxTokens: Math.min(Math.max(size, 256), 8192),
  };
}

/**
 * 把任意输入收成一份能用的设置。
 *
 * auto 默认开。验收标准里写的是「配置好后，插件调用大模型补充语义内容」，
 * 默认关掉的话配完 Key 还得再想一步才会看到效果。反向的顾虑是每打开一次
 * 插件都要花钱，这一点在设置页上明确写出来了，用户能自己关。
 */
export function normalizeLlmSettings(raw: unknown): LlmSettings {
  const src = (raw ?? {}) as Record<string, unknown>;
  return {
    config: normalizeLlmConfig(src.config),
    auto: typeof src.auto === 'boolean' ? src.auto : true,
    savedAt: typeof src.savedAt === 'string' ? src.savedAt : null,
  };
}

/** 从来没配过的初始状态 */
export function defaultLlmSettings(): LlmSettings {
  return { config: blankConfig(), auto: true, savedAt: null };
}

/** 有没有配到「能发起调用」的程度。读取路径上用它决定要不要自动跑补全 */
export function settingsReady(s: LlmSettings): boolean {
  return configProblem(s.config) === null;
}

/**
 * 把基址和路径拼起来。
 *
 * 归一化时已经去过末尾斜杠，这里再去一次是因为适配器可能被单独调用，
 * 比如检查脚本直接构造配置。重复一次的成本是一行，收益是
 * 「https://host//v1//chat/completions」这类地址不会从任何一条路径漏出去。
 */
export function joinUrl(base: string, path: string): string {
  const b = base.trim().replace(/\/+$/, '');
  const p = path.trim().replace(/^\/+/, '');
  return `${b}/${p}`;
}

/** 本机地址。这类端点通常不校验 Key，界面上也就不强制填 */
export function isLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]' || h.endsWith('.localhost');
}

/**
 * Base URL 对应的权限匹配串。
 *
 * 只取到端口那一层，不管路径。Chrome 的 host permission 最小粒度就是
 * 「协议 + 主机 + 端口」，路径部分写了也会被忽略，不如显式只留这三段，
 * 免得看的人以为权限被限制到了某个路径上。
 *
 * 地址非法时返回 null，调用方据此报 bad-url，而不是抛一个解析异常上去。
 */
export function originPatternOf(baseUrl: string): string | null {
  try {
    const u = new URL(baseUrl.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (u.hostname.length === 0) return null;
    return `${u.protocol}//${u.host}/*`;
  } catch {
    return null;
  }
}

/**
 * 这个地址还需不需要 Key。本机端点不需要，其余一律要
 */
export function requiresApiKey(baseUrl: string): boolean {
  try {
    return !isLocalHost(new URL(baseUrl.trim()).hostname);
  } catch {
    return true;
  }
}

/**
 * 配置是否足够发起一次调用。
 *
 * 顺序是有讲究的：先地址、再 Key、最后模型名。用户按界面上从上到下的顺序
 * 填，报错也该按这个顺序出现，先报「地址不合法」比先报「没填模型名」更贴近
 * 他此刻在做的事。
 *
 * 返回 null 表示可用；否则返回失败种类，交给 client 换成文案。
 */
export function configProblem(config: LlmConfig): 'bad-url' | 'no-key' | 'no-model' | null {
  if (originPatternOf(config.baseUrl) === null) return 'bad-url';
  if (requiresApiKey(config.baseUrl) && config.apiKey.length === 0) return 'no-key';
  if (config.model.length === 0) return 'no-model';
  return null;
}
