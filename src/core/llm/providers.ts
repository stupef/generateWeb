/**
 * 三条协议的适配器，以及一份预置端点表。
 *
 * ── 请求体里什么都不多塞 ──
 *
 * 三家都只发「模型名 + 提示词 + 输出上限」这三样，不传 temperature、
 * 不传 response_format、不传 top_p。原因是这些参数在兼容实现里的支持度
 * 参差不齐：temperature 被新一代推理模型拒收，response_format 只有一部分
 * 服务商实现了 json_object 模式，而拿到 400 的用户看到的是服务商返回的
 * 一句英文，很难联想到是自己选的模型不支持某个参数。
 *
 * 代价是少了一层「强制 JSON」的保障，所以取值那一步做得很宽：从响应文本里
 * 剥代码围栏、找最外层花括号、再解析，具体见 semantics.ts。
 *
 * OpenAI 兼容这一条以前**不发输出上限**：max_tokens 和
 * max_completion_tokens 两代参数适用模型不重叠，发哪个都会在某些推理模型上
 * 报 400。但「不发」的代价是服务端默认上限常太小，把本 skill 要的大产出
 * 截断成半个 JSON，报错看着像模型不会用 JSON。现在改为带上 max_tokens，
 * 普通 chat 模型都接受；少数推理模型仍只认 max_completion_tokens，撞上会
 * 回 400，换模型即可。Anthropic 那边 max_tokens 一直是必填的。
 */
import type { LlmAdapter, LlmConfig, LlmProtocol, ProviderPreset } from './types';
import { PROBE_MAX_TOKENS, joinUrl } from './config';

// ---------------------------------------------------------------------
// 预置端点
// ---------------------------------------------------------------------

/**
 * 预置表的选取标准。
 *
 * 一、OpenAI 兼容这一条要能覆盖住国内能直连、且中文效果够用的几家，
 *     因为它们都不需要额外网络条件，而用户手里多半已经有其中一把 Key。
 * 二、要留一个「本地部署」的入口。Ollama 和 LM Studio 都开 OpenAI 兼容面，
 *     这条通路不联网、不花钱，是验证整条链路最省事的方式。
 * 三、默认模型名会过期。所以每个预置都配了「拉取模型列表」按钮，模型名
 *     填错时的提示也会直接引导用户去点那个按钮，让陈旧默认值有自愈路径。
 */
export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4.1-mini',
    consoleUrl: 'https://platform.openai.com/api-keys',
    note: '官方协议。默认选的是非推理的小模型，便宜且请求体参数限制少',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    protocol: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    consoleUrl: 'https://platform.deepseek.com/api_keys',
    note: '中文语感好，单价低，适合这类短文案生成',
  },
  {
    id: 'moonshot',
    label: '月之暗面 Kimi',
    protocol: 'openai',
    baseUrl: 'https://api.moonshot.cn/v1',
    defaultModel: 'kimi-k2.5',
    consoleUrl: 'https://platform.moonshot.cn/console/api-keys',
    note: '长上下文，页面数据偏大时也更从容',
  },
  {
    id: 'zhipu',
    label: '智谱 GLM',
    protocol: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-4-plus',
    consoleUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    note: '注意基址路径是 /api/paas/v4，不是常见的 /v1',
  },
  {
    id: 'dashscope',
    label: '通义千问',
    protocol: 'openai',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen3-max',
    consoleUrl: 'https://bailian.console.aliyun.com/',
    note: '走百炼的兼容模式端点',
  },
  {
    id: 'siliconflow',
    label: '硅基流动',
    protocol: 'openai',
    baseUrl: 'https://api.siliconflow.cn/v1',
    defaultModel: '',
    consoleUrl: 'https://cloud.siliconflow.cn/account/ak',
    note: '聚合推理站，模型名变化快，点拉取列表后再选',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    protocol: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: '',
    consoleUrl: 'https://openrouter.ai/keys',
    note: '聚合站，一把 Key 能同时调到 Claude 和 Gemini 等',
  },
  {
    id: 'ollama',
    label: '本地 Ollama',
    protocol: 'openai',
    baseUrl: 'http://localhost:11434/v1',
    defaultModel: '',
    consoleUrl: 'https://ollama.com/download',
    note: '本机部署，不联网不花钱。Key 随便填，服务端不校验',
  },
  {
    id: 'anthropic',
    label: 'Anthropic Claude',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    defaultModel: 'claude-sonnet-5-5',
    consoleUrl: 'https://console.anthropic.com/settings/keys',
    note: '官方为浏览器直连开了白名单请求头，不需要自建代理',
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    protocol: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    defaultModel: 'gemini-2.5-flash',
    consoleUrl: 'https://aistudio.google.com/apikey',
    note: '有免费额度，零成本验证整条链路',
  },
  {
    id: 'custom-openai',
    label: '自定义（OpenAI 兼容）',
    protocol: 'openai',
    baseUrl: '',
    defaultModel: '',
    consoleUrl: '',
    note: '自建代理、OneAPI、LiteLLM、vLLM 等，手动填基址',
  },
  {
    id: 'custom-anthropic',
    label: '自定义（Anthropic 兼容）',
    protocol: 'anthropic',
    baseUrl: '',
    defaultModel: '',
    consoleUrl: '',
    note: '手动填基址，路径按 /messages 拼',
  },
  {
    id: 'custom-gemini',
    label: '自定义（Gemini 兼容）',
    protocol: 'gemini',
    baseUrl: '',
    defaultModel: '',
    consoleUrl: '',
    note: '手动填基址，路径按 /models/{模型}:generateContent 拼',
  },
];

/** 某个协议下的预置，设置页切换协议时用来过滤下拉项 */
export function presetsOf(protocol: LlmProtocol): ProviderPreset[] {
  return PROVIDER_PRESETS.filter((p) => p.protocol === protocol);
}

/** 按预置的基址反查是哪一个。找不到返回 null，表示用户手工改过地址 */
export function presetByBaseUrl(baseUrl: string): ProviderPreset | null {
  const norm = baseUrl.trim().replace(/\/+$/, '');
  if (norm.length === 0) return null;
  return PROVIDER_PRESETS.find((p) => p.baseUrl.replace(/\/+$/, '') === norm) ?? null;
}

// ---------------------------------------------------------------------
// 取值小工具
//
// 响应体来自网络，形状不可信，一律走 unknown 加逐层判型，不用 any 断言
// 直接点属性。服务商偶尔会在预期字段缺失时返回一个「成功但没内容」的
// 响应，直接点属性会抛异常，异常会被当成网络错误，归因整个错掉。
// ---------------------------------------------------------------------

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function asArray(v: unknown): unknown[] | null {
  return Array.isArray(v) ? v : null;
}

function textOf(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v : null;
}

/** 从 { data: [{ id }] } 这种形状里取名字列表 */
function namesFromDataArray(payload: unknown, key: string): string[] | null {
  const root = asRecord(payload);
  const list = root ? asArray(root.data) : null;
  if (!list) return null;
  const out: string[] = [];
  for (const item of list) {
    const rec = asRecord(item);
    const name = rec ? textOf(rec[key]) : null;
    if (name) out.push(name);
  }
  return out.length > 0 ? out : null;
}

// ---------------------------------------------------------------------
// OpenAI 兼容
// ---------------------------------------------------------------------

const openai: LlmAdapter = {
  protocol: 'openai',

  chat(config: LlmConfig, system: string, user: string) {
    return {
      method: 'POST',
      url: joinUrl(config.baseUrl, 'chat/completions'),
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: config.maxTokens,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    };
  },

  probe(config: LlmConfig) {
    return {
      method: 'POST',
      url: joinUrl(config.baseUrl, 'chat/completions'),
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: 'user', content: '回复「ok」两个字符即可。' }],
        max_tokens: PROBE_MAX_TOKENS,
      }),
    };
  },

  models(config: LlmConfig) {
    return {
      method: 'GET',
      url: joinUrl(config.baseUrl, 'models'),
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${config.apiKey}`,
      },
      body: null,
    };
  },

  extractText(payload) {
    const root = asRecord(payload);
    const choices = root ? asArray(root.choices) : null;
    const first = choices && choices.length > 0 ? asRecord(choices[0]) : null;
    const message = first ? asRecord(first.message) : null;
    return message ? textOf(message.content) : null;
  },

  extractModels(payload) {
    return namesFromDataArray(payload, 'id');
  },
};

// ---------------------------------------------------------------------
// Anthropic Messages
// ---------------------------------------------------------------------

/**
 * Anthropic 的浏览器直连白名单头。
 *
 * 官方默认拒绝来自浏览器上下文的请求，防的是 CSRF：恶意页面可以诱导用户
 * 浏览器带着已附加的凭据发请求。这个头是官方给 BYOK 类工具开的正式口子，
 * 名字里的 dangerous 是认真的，含义是「你知道这个 Key 在浏览器里能被
 * devtools 读到」。
 *
 * 在这个场景里 Key 本来就是用户自己的、存在自己的浏览器里，没有额外泄露。
 * 而且真要生效还得靠扩展的 host permission，光有这个头也不够。
 *
 * 加这个头不是多余的：扩展页虽然有 host permission 可以绕过 CORS，但
 * 服务端那一侧的 CSRF 判定独立于浏览器的 CORS 检查，不带这个头服务端
 * 照样可能拒绝。
 */
const ANTHROPIC_BROWSER_HEADER = 'anthropic-dangerous-direct-browser-access';

/** Messages 协议要求的版本号，写死。换版本会改响应结构，得跟着改解析 */
const ANTHROPIC_VERSION = '2023-06-01';

function anthropicHeaders(config: LlmConfig, withBrowserOptIn: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-api-key': config.apiKey,
    'anthropic-version': ANTHROPIC_VERSION,
  };
  if (withBrowserOptIn) headers[ANTHROPIC_BROWSER_HEADER] = 'true';
  return headers;
}

/**
 * 从 content 块数组里拼出文本。
 *
 * content 是块数组而不是字符串，因为同一字段还要装工具调用和思考过程。
 * 这里只取 type 为 text 的块并按顺序拼接，其余块直接跳过而不是报错：
 * 带思考的模型会先回一个 thinking 块，那不是异常。
 */
function anthropicText(payload: unknown): string | null {
  const root = asRecord(payload);
  const blocks = root ? asArray(root.content) : null;
  if (!blocks) return null;
  const parts: string[] = [];
  for (const b of blocks) {
    const rec = asRecord(b);
    if (!rec || rec.type !== 'text') continue;
    const t = textOf(rec.text);
    if (t) parts.push(t);
  }
  const joined = parts.join('').trim();
  return joined.length > 0 ? joined : null;
}

const anthropic: LlmAdapter = {
  protocol: 'anthropic',

  chat(config: LlmConfig, system: string, user: string) {
    return {
      method: 'POST',
      url: joinUrl(config.baseUrl, 'messages'),
      headers: anthropicHeaders(config, true),
      body: JSON.stringify({
        model: config.model,
        max_tokens: config.maxTokens,
        // system 在 Messages 协议里是顶层字段，不是 messages 里的一条
        system,
        messages: [{ role: 'user', content: user }],
      }),
    };
  },

  probe(config: LlmConfig) {
    return {
      method: 'POST',
      url: joinUrl(config.baseUrl, 'messages'),
      headers: anthropicHeaders(config, true),
      body: JSON.stringify({
        model: config.model,
        max_tokens: PROBE_MAX_TOKENS,
        messages: [{ role: 'user', content: '回复「ok」两个字符即可。' }],
      }),
    };
  },

  models(config: LlmConfig) {
    return {
      method: 'GET',
      url: joinUrl(config.baseUrl, 'models'),
      headers: {
        accept: 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: null,
    };
  },

  extractText: anthropicText,
  extractModels: (payload) => namesFromDataArray(payload, 'id'),
};

// ---------------------------------------------------------------------
// Google Gemini
// ---------------------------------------------------------------------

/**
 * generateContent 的请求体。
 *
 * 结构与前两家都不同：内容放在 contents 里，每一轮是 { role, parts }，
 * 文本要再包一层 parts；system 是独立的 systemInstruction，而不是
 * messages 里的一条；生成上限也不是顶层字段，要放进 generationConfig。
 *
 * role 用 user。Gemini 的 role 取值是 user 和 model，没有 system，
 * 所以即使是探测请求也只能挂在 user 上。
 */
function geminiBody(config: LlmConfig, system: string | null, user: string, maxTokens: number) {
  const body: Record<string, unknown> = {
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig: { maxOutputTokens: maxTokens },
  };
  if (system !== null) body.systemInstruction = { parts: [{ text: system }] };
  return JSON.stringify(body);
}

function geminiText(payload: unknown): string | null {
  const root = asRecord(payload);
  const candidates = root ? asArray(root.candidates) : null;
  const first = candidates && candidates.length > 0 ? asRecord(candidates[0]) : null;
  const content = first ? asRecord(first.content) : null;
  const parts = content ? asArray(content.parts) : null;
  if (!parts) return null;
  const texts: string[] = [];
  for (const p of parts) {
    const rec = asRecord(p);
    const t = rec ? textOf(rec.text) : null;
    if (t) texts.push(t);
  }
  const joined = texts.join('').trim();
  return joined.length > 0 ? joined : null;
}

const gemini: LlmAdapter = {
  protocol: 'gemini',

  chat(config: LlmConfig, system: string, user: string) {
    return {
      method: 'POST',
      url: joinUrl(config.baseUrl, `models/${config.model}:generateContent`),
      // key 走请求头而不是查询串。查询串会进浏览器历史、日志和错误上报，
      // 请求头不会
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': config.apiKey,
      },
      body: geminiBody(config, system, user, config.maxTokens),
    };
  },

  probe(config: LlmConfig) {
    return {
      method: 'POST',
      url: joinUrl(config.baseUrl, `models/${config.model}:generateContent`),
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': config.apiKey,
      },
      body: geminiBody(config, null, '回复「ok」两个字符即可。', PROBE_MAX_TOKENS),
    };
  },

  models(config: LlmConfig) {
    return {
      method: 'GET',
      url: joinUrl(config.baseUrl, 'models'),
      headers: { accept: 'application/json', 'x-goog-api-key': config.apiKey },
      body: null,
    };
  },

  extractText: geminiText,

  /**
   * Gemini 的列表项是 { name: 'models/gemini-2.5-flash' }，带一个固定前缀。
   * 拼请求时会把模型名再拼回路径，前缀留着就会变成 models/models/xxx，
   * 所以这里剥掉。不然用户从列表里选一个可用模型，反而拿到 404。
   */
  extractModels(payload) {
    const root = asRecord(payload);
    const list = root ? asArray(root.models) : null;
    if (!list) return null;
    const out: string[] = [];
    for (const item of list) {
      const rec = asRecord(item);
      const name = rec ? textOf(rec.name) : null;
      if (name) out.push(name.replace(/^models\//, ''));
    }
    return out.length > 0 ? out : null;
  },
};

const ADAPTERS: Record<LlmProtocol, LlmAdapter> = { openai, anthropic, gemini };

/** 取某个协议的适配器。协议值在归一化那一步已经收窄过 */
export function adapterOf(protocol: LlmProtocol): LlmAdapter {
  return ADAPTERS[protocol];
}
