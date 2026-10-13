/**
 * 大模型接入层的公共类型。
 *
 * ── 为什么这里只做两件事 ──
 *
 * 接入层的职责边界划得很窄：把「一次模型调用」抽象成「构造 HTTP 请求」和
 * 「从响应里取文本」两个纯动作，再加上一层失败归因。它不知道提示词长什么样，
 * 也不知道返回的 JSON 该怎么校验，那些分别属于 prompt.ts 和 semantics.ts。
 *
 * 划这么窄是因为这一层最容易写成一团糨糊：三家协议各写一遍请求构造，顺手
 * 把重试、解析、校验都塞进去，最后想单独测「429 该报什么」得先把网络起起来。
 * 现在这三样都是纯函数，注入一个假的 fetch 就能把全部分支跑完。
 *
 * ── 为什么是这三家 ──
 *
 * 选家的依据不是「谁家模型强」，而是「协议结构是否真的不同」。只做一家
 * OpenAI 兼容协议的话，接入层看起来支持十来个服务商，实际上只是换了个
 * Base URL，抽象层有没有写对根本测不出来。
 *
 *   openai     所有遵循 chat/completions 的服务商，含 OpenAI、DeepSeek、
 *              Kimi、GLM、通义、豆包、硅基流动、OpenRouter 以及本地
 *              Ollama、LM Studio、OneAPI、LiteLLM 这类自建代理
 *   anthropic  Messages 协议。鉴权头、system 的位置、响应结构全都不同
 *   gemini     generateContent 协议。key 走请求头、内容是 contents/parts、
 *              响应在 candidates 里，又是另一套
 *
 * 三家覆盖了「换 Base URL 就够」「换请求结构」「换整个信封」三个层次，
 * 接入层是不是真的抽象出来的，看这三段代码就知道。
 */

/** 协议类型。决定用哪个适配器，与具体服务商无关 */
export type LlmProtocol = 'openai' | 'anthropic' | 'gemini';

export interface LlmConfig {
  protocol: LlmProtocol;
  /** 端点基址，末尾有没有斜杠都行，由 joinUrl 统一收口 */
  baseUrl: string;
  /** 用户的 Key。本地部署的服务端通常不校验，允许留空 */
  apiKey: string;
  /** 模型名。聚合类服务商的模型名变化快，界面上提供拉取按钮 */
  model: string;
  /** 单次生成上限。Anthropic 必填，另两家也照传，取值统一 */
  maxTokens: number;
}

/**
 * 落盘的那一份设置。
 *
 * auto 和 config 放在一起存，是因为它们的生命周期一样：用户配完 Key 接着
 * 就会决定要不要每次都自动跑。分两个键存只会多一次读写和一处可能不同步。
 */
export interface LlmSettings {
  config: LlmConfig;
  /** 提取完成后自动做一次补全。关掉就只在手动点按钮时调用 */
  auto: boolean;
  /** 上次保存的时刻，界面上用来显示「已保存」。ISO 字符串，没存过为 null */
  savedAt: string | null;
}

/**
 * 失败的种类。
 *
 * 分这么细不是为了好看，是因为验收标准要求「Key 错误时给出明确提示」，
 * 而「明确」的前提是能区分到底错在哪。401 和 404 混成一句「调用失败」，
 * 用户只能靠猜。
 *
 * 分类的边界按「用户下一步该做什么」来切，不按 HTTP 状态码切：401 和 403
 * 合并成 auth 是因为两者都指向「去检查 Key」；404 单独成 not-found 是因为
 * 它指向「检查地址和模型名」，是完全不同的动作。
 */
export type LlmFailureKind =
  /** 还没填 Key */
  | 'no-key'
  /** 还没填模型名 */
  | 'no-model'
  /** Base URL 不是合法地址 */
  | 'bad-url'
  /** 浏览器层面就发出去了，但扩展没有该域名的网络权限 */
  | 'permission'
  /** 401 / 403，Key 无效或没有权限 */
  | 'auth'
  /** 404，地址或模型名不对 */
  | 'not-found'
  /** 402 / 429，余额不足或被限流 */
  | 'quota'
  /** 400 及其它 4xx，请求本身被拒 */
  | 'request'
  /** 5xx，服务商侧故障 */
  | 'server'
  /** 超时 */
  | 'timeout'
  /** 网络不通、DNS 解析失败、或该地址不允许浏览器直连 */
  | 'unreachable'
  /** 拿到了响应，但不是预期结构，取不到模型输出 */
  | 'shape'
  /** 调用方主动取消 */
  | 'aborted';

export interface LlmFailure {
  kind: LlmFailureKind;
  /** 一句话说清是什么问题，显示在提示块的标题位置 */
  title: string;
  /** 怎么排查，给出可操作的下一步 */
  body: string;
  /** 服务商自己给的说明，可能为空 */
  detail: string;
  /** HTTP 状态码。请求没发出去时为 null */
  status: number | null;
  /** 重试有没有意义。Key 错了重试一百次也是错的 */
  retryable: boolean;
}

export type LlmOutcome<T> = { ok: true; value: T } | { ok: false; failure: LlmFailure };

/** 适配器的产出：一个可以直接交给 fetch 的请求 */
export interface HttpRequest {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  /** GET 时为 null */
  body: string | null;
}

/**
 * 协议适配器。
 *
 * chat 构造对话请求，probe 构造探测请求，models 构造列表请求。三者分开是
 * 因为「测试连接」不该真的消耗一次对话：OpenAI 系有轻量的 /models 可以打，
 * 而 Anthropic 和 Gemini 的 /models 只列名字，测不出 Key 有没有对话权限，
 * 所以那两家用一次极小的真实对话来探。
 */
export interface LlmAdapter {
  readonly protocol: LlmProtocol;
  /** 对话请求。system 和 user 分开传，由适配器决定往哪儿塞 */
  chat(config: LlmConfig, system: string, user: string): HttpRequest;
  /** 测试连接。要求极小的开销，但不要求所有协议都用同一种端点 */
  probe(config: LlmConfig): HttpRequest;
  /** 列出可用模型。取不到列表的协议返回 null 表示不支持 */
  models(config: LlmConfig): HttpRequest | null;
  /** 从响应体里取出模型的文本输出。取不到返回 null */
  extractText(payload: unknown): string | null;
  /** 从响应体里取出模型名列表。取不到返回 null */
  extractModels(payload: unknown): string[] | null;
}

/** 一个预置端点 */
export interface ProviderPreset {
  id: string;
  label: string;
  protocol: LlmProtocol;
  /** 留空表示需要用户自己填，界面上会提示 */
  baseUrl: string;
  /** 预填的模型名。留空表示模型名变化快，让用户点拉取按钮 */
  defaultModel: string;
  /** 在哪拿 Key，设置页给个直达链接 */
  consoleUrl: string;
  /** 一句话说明，比如「本地部署，不联网」 */
  note: string;
}
