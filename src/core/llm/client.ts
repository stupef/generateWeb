/**
 * 真正发请求的那一层，以及失败归因。
 *
 * ── 为什么把 fetch 做成可注入的 ──
 *
 * 这一层里绝大多数代码是错误分支：401、404、429、超时、断网、返回结构不对。
 * 这些分支在真实网络里一个都不好造，靠手工点着试基本覆盖不到，而它们恰恰
 * 是用户最常撞上的那部分。把 fetch 抽成参数之后，检查脚本可以拿一个 stub
 * 把这些分支全部跑一遍，包括「永远不 resolve」这种只能靠假实现制造的情况。
 *
 * ── 归因按「下一步做什么」切，不按状态码切 ──
 *
 * 401 和 403 合并成 auth，因为两者都指向同一个动作：去检查 Key。404 单独
 * 拎出来，因为它指向的是另一个动作：检查地址和模型名。429 和 402 合并成
 * quota，DeepSeek 余额不足返回的正是 402，而用户要做的事和 429 一样，
 * 都是去账户里看额度。
 *
 * 验收标准里「Key 错误时给出明确提示」的「明确」，落地就是这个区分：
 * 每一条失败都必须给出非空的一句话结论和一段可操作的排查说明，
 * 检查脚本会逐条断言这两样都不为空、且足够具体。
 */
import type { HttpRequest, LlmAdapter, LlmConfig, LlmFailure, LlmFailureKind, LlmOutcome } from './types';
import { PROBE_MAX_TOKENS, configProblem, originPatternOf } from './config';

// ---------------------------------------------------------------------
// 传输层的注入点
// ---------------------------------------------------------------------

/**
 * 结构化的响应接口。
 *
 * 不直接用 DOM 的 Response，是为了让检查脚本不需要构造一个真的 Response
 * 对象就能跑。这一层真正用到的只有 ok / status / text 三样。
 */
export interface ResponseLike {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export interface FetchInitLike {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export type FetchLike = (url: string, init: FetchInitLike) => Promise<ResponseLike>;

export interface TransportOptions {
  fetchImpl?: FetchLike;
  /** 单次请求的墙钟上限 */
  timeoutMs?: number;
  /** 调用方的取消信号，弹窗关闭时用得上 */
  signal?: AbortSignal;
  /**
   * 宿主提供的权限检查。
   *
   * 浏览器在「没授权这个域名」和「网络不通」两种情况下抛的是同一个
   * TypeError，错误文本也一样。不额外查一次权限，这两种就分不开，而它们
   * 要用户做的事完全不同：一个是点授权，一个是查网络。查不了就报后者，
   * 至少不会把用户引到一个不存在的授权按钮上。
   */
  hasPermission?: (originPattern: string) => Promise<boolean>;
}

/** 对话默认 45 秒。慢模型配长提示词，30 秒会误杀 */
export const CHAT_TIMEOUT_MS = 45_000;
/** 探测只回两个字，超过 15 秒基本可以断定这条链路有问题 */
export const PROBE_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------
// 失败文案表
//
// 每一条都要回答两个问题：出了什么事，以及我该去哪里改。
// ---------------------------------------------------------------------

const RETRYABLE: Record<LlmFailureKind, boolean> = {
  'no-key': false,
  'no-model': false,
  'bad-url': false,
  permission: false,
  auth: false,
  'not-found': false,
  quota: false,
  request: false,
  server: true,
  timeout: true,
  unreachable: true,
  shape: true,
  aborted: false,
};

/**
 * 服务商原话统一在这里截断，不在各个调用点分别处理。
 *
 * 有些实现会把整个请求体回显在错误响应里，那段文字能到几千字符，直接铺进
 * 提示块会把界面撑爆。收口在构造这一处，任何路径进来的 detail 都过一遍，
 * 不用指望每个调用方都记得。
 */
function makeFailure(kind: LlmFailureKind, title: string, body: string, detail = '', status: number | null = null): LlmFailure {
  return { kind, title, body, detail: clip(detail), status, retryable: RETRYABLE[kind] };
}

/** 按种类取一条说清楚的话。detail 是服务商自己给的原话，可能为空 */
export function failureOf(kind: LlmFailureKind, detail = '', status: number | null = null): LlmFailure {
  switch (kind) {
    case 'no-key':
      return makeFailure(
        kind,
        '还没有填 API Key',
        'AI 补全需要用户自己的 Key。打开设置页填入后保存即可。' +
          '这份 DESIGN.md 已经按本地规则生成好了，不配 Key 也能正常导出。',
      );
    case 'no-model':
      return makeFailure(
        kind,
        '还没有填模型名',
        '同一个服务商下往往有多个模型，需要指定用哪一个。' +
          '不确定叫什么的话，在设置页点「拉取模型列表」，从返回的名单里选一个。',
      );
    case 'bad-url':
      return makeFailure(
        kind,
        '接口地址不是合法网址',
        '检查协议是不是漏了 http:// 或 https://，以及有没有把路径拼错。' +
          '从预置服务商里选一个会自动填好地址。',
      );
    case 'permission':
      return makeFailure(
        kind,
        '还没有授予这个域名的网络权限',
        '扩展只会在你实际填写的域名上申请权限。回到设置页重新点一次「保存」或「测试连接」，' +
          'Chrome 会弹出授权确认。如果之前点过拒绝，去 chrome://extensions 里给本扩展重新授权。',
      );
    case 'auth':
      return makeFailure(
        kind,
        'API Key 无效或没有权限',
        'Key 可能复制不完整、已被撤销，或者这把 Key 没有开通该模型的调用权限。' +
          '去服务商控制台确认 Key 的状态，然后重新粘贴一次。',
        detail,
        status,
      );
    case 'not-found':
      return makeFailure(
        kind,
        '接口地址或模型名不对',
        '服务商说找不到。两类常见原因：一类是基址少了版本段，很多兼容实现的地址要以 /v1 结尾；' +
          '另一类是模型名拼错或已经下线，点「拉取模型列表」看看现在有哪些可用。',
        detail,
        status,
      );
    case 'quota':
      return makeFailure(
        kind,
        '额度不足或请求太频繁',
        '这次调用被服务商拒了。去控制台看账户余额、免费额度是否用完，或者当前是否触发了速率限制。' +
          '稍后重试通常也能过去。',
        detail,
        status,
      );
    case 'request':
      return makeFailure(
        kind,
        '请求被服务商拒绝',
        '参数或模型名不被接受。常见的一种是本插件发出的请求体里有该模型不支持的字段；' +
          '换一个模型试，或把服务商返回的原话一并拿去搜。',
        detail,
        status,
      );
    case 'server':
      return makeFailure(
        kind,
        '服务商侧出错',
        '这是对方服务器的临时故障，不是配置问题。过一会儿重试即可。',
        detail,
        status,
      );
    case 'timeout':
      return makeFailure(
        kind,
        '请求超时',
        '在规定时间内没有等到响应。网络慢、模型排队、或者提示词太长都会这样。' +
          '换一个响应更快的模型试试。',
        detail,
        status,
      );
    case 'unreachable':
      return makeFailure(
        kind,
        '请求没能发出去',
        '浏览器层面就失败了，常见原因有三个：域名写错；本机网络或代理不通；' +
          '或者这个地址不允许浏览器直连，需要换成支持直连的端点。' +
          '本地部署的服务端还有一个可能，是它没有在运行。',
        detail,
        status,
      );
    case 'shape':
      return makeFailure(
        kind,
        '返回内容不是预期的结构',
        '拿到了响应，但里面没有模型输出。可能这个地址不是所选协议对应的端点，' +
          '也可能模型把 JSON 写了一半就被输出上限截断了。检查协议和地址是否配套。',
        detail,
        status,
      );
    case 'aborted':
      return makeFailure(kind, '调用已取消', '本次 AI 补全被主动中止，不影响导出。', detail, status);
  }
}

// ---------------------------------------------------------------------
// 发送
// ---------------------------------------------------------------------

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** 截断服务商原话。有些实现会把整个请求体回显在错误里 */
function clip(s: string, max = 300): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max) + '…' : t;
}

/**
 * 从错误响应里挖出服务商自己的说明。
 *
 * 三家都把说明放在 error.message 里，但兼容实现五花八门，有的放在顶层
 * message，有的干脆返回一段纯文本。挖不到就退回原始报文，再不济也有个
 * 状态码可看。这一段是直接给用户看的，所以清洗掉换行和多余空白。
 */
function detailOf(payload: unknown, rawText: string): string {
  const root = asRecord(payload);
  if (root) {
    const err = asRecord(root.error);
    if (err) {
      const msg = typeof err.message === 'string' ? err.message : '';
      const type = typeof err.type === 'string' ? err.type : '';
      const joined = [type, msg].filter((x) => x.length > 0).join('　');
      if (joined.length > 0) return clip(joined);
    }
    const top = typeof root.message === 'string' ? root.message : '';
    if (top.length > 0) return clip(top);
  }
  return clip(rawText);
}

/**
 * 按状态码归类。
 *
 * 400 单独判一次：同一个状态码既能是「模型名不存在」，也能是「参数不被
 * 支持」，而这两件事用户要做的事不一样。判定依据只有一个，就是错误文本里
 * 有没有出现 model 这个词，命中就归到 not-found。
 */
function httpFailureKind(status: number, detail: string): LlmFailureKind {
  if (status === 400) return /model/i.test(detail) ? 'not-found' : 'request';
  if (status === 401 || status === 403) return 'auth';
  if (status === 402) return 'quota';
  if (status === 404) return 'not-found';
  if (status === 408 || status === 504) return 'timeout';
  if (status === 429) return 'quota';
  if (status >= 500) return 'server';
  if (status >= 400) return 'request';
  return 'server';
}

export interface RawSuccess {
  ok: true;
  status: number;
  payload: unknown;
  rawText: string;
  elapsedMs: number;
}

export type RawOutcome = RawSuccess | { ok: false; failure: LlmFailure };

/**
 * 发一个请求并把各种失败翻译成带说明的对象。
 *
 * 超时用 AbortController 加定时器实现，不用 AbortSignal.timeout，因为需要
 * 区分「是我们自己掐的」和「调用方取消的」：两者都会走到 abort 分支，
 * 而提示文案完全不同，一个说换模型，一个说本次已取消。
 */
export async function send(req: HttpRequest, opts: TransportOptions = {}): Promise<RawOutcome> {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike | undefined);
  if (typeof fetchImpl !== 'function') {
    return {
      ok: false,
      failure: makeFailure('unreachable', '当前环境不支持发起网络请求', '需要能访问 fetch 的运行环境。'),
    };
  }

  const timeoutMs = opts.timeoutMs ?? CHAT_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const forwardAbort = () => controller.abort();
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener('abort', forwardAbort);
  }

  const t0 = Date.now();

  try {
    const res = await fetchImpl(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body ?? undefined,
      signal: controller.signal,
    });

    const rawText = await res.text();
    const elapsedMs = Date.now() - t0;

    let payload: unknown = null;
    let parsed = true;
    try {
      payload = rawText.trim().length > 0 ? JSON.parse(rawText) : null;
    } catch {
      parsed = false;
    }

    if (!res.ok) {
      const detail = detailOf(payload, rawText);
      return { ok: false, failure: failureOf(httpFailureKind(res.status, detail), detail, res.status) };
    }

    if (!parsed) {
      return {
        ok: false,
        failure: failureOf('shape', clip(rawText, 160), res.status),
      };
    }

    return { ok: true, status: res.status, payload, rawText, elapsedMs };
  } catch (err) {
    return { ok: false, failure: await transportFailure(err, timedOut, req, opts) };
  } finally {
    clearTimeout(timer);
    if (opts.signal) opts.signal.removeEventListener('abort', forwardAbort);
  }
}

/**
 * 请求根本没发出去时的归因。
 *
 * 判断顺序是固定的：先看是不是我们自己超时掐的，再看是不是调用方取消的，
 * 最后才去查权限。前两种能从本地状态直接判定，不需要问宿主；把它们排前面
 * 可以少一次异步查询，也让分支更好读。
 */
async function transportFailure(
  err: unknown,
  timedOut: boolean,
  req: HttpRequest,
  opts: TransportOptions,
): Promise<LlmFailure> {
  if (timedOut) return failureOf('timeout');

  const name = asRecord(err)?.name ?? (err instanceof Error ? err.name : '');
  if (name === 'AbortError') return failureOf('aborted');

  const message = err instanceof Error ? err.message : String(err);
  const pattern = originPatternOf(req.url);
  if (opts.hasPermission && pattern) {
    let granted = true;
    try {
      granted = await opts.hasPermission(pattern);
    } catch {
      // 权限查询本身失败，当作查不出来处理，继续往网络方向归因
      granted = true;
    }
    if (!granted) return failureOf('permission', `未授权 ${pattern}`);
  }

  return failureOf('unreachable', clip(message));
}

// ---------------------------------------------------------------------
// 三个对外动作
// ---------------------------------------------------------------------

/** 配置不够就先把问题说清楚，不要发出一个注定失败的请求 */
function precondition(config: LlmConfig): LlmFailure | null {
  const problem = configProblem(config);
  return problem ? failureOf(problem) : null;
}

export interface ChatValue {
  text: string;
  elapsedMs: number;
  status: number;
}

/** 发起一次对话，返回模型的原文 */
export async function callModel(
  adapter: LlmAdapter,
  config: LlmConfig,
  system: string,
  user: string,
  opts: TransportOptions = {},
): Promise<LlmOutcome<ChatValue>> {
  const pre = precondition(config);
  if (pre) return { ok: false, failure: pre };

  const raw = await send(adapter.chat(config, system, user), { timeoutMs: CHAT_TIMEOUT_MS, ...opts });
  if (!raw.ok) return { ok: false, failure: raw.failure };

  const text = adapter.extractText(raw.payload);
  if (text === null) {
    return {
      ok: false,
      failure: failureOf('shape', clip(raw.rawText, 160), raw.status),
    };
  }
  return { ok: true, value: { text, elapsedMs: raw.elapsedMs, status: raw.status } };
}

export interface ProbeValue {
  /** 模型回了什么。内容不重要，能回就说明整条链路是通的 */
  text: string;
  elapsedMs: number;
}

/**
 * 测试连接。
 *
 * 走一次极小的真实对话，而不是只打列表接口。列表接口只能证明 Key 有效，
 * 证明不了模型名对不对、这个 Key 有没有对话权限、以及服务端会不会因为
 * 来源是浏览器而拒绝。而这三种恰好是最容易出问题的地方。
 */
export async function probeModel(
  adapter: LlmAdapter,
  config: LlmConfig,
  opts: TransportOptions = {},
): Promise<LlmOutcome<ProbeValue>> {
  const pre = precondition(config);
  if (pre) return { ok: false, failure: pre };

  const raw = await send(adapter.probe(config), { timeoutMs: PROBE_TIMEOUT_MS, ...opts });
  if (!raw.ok) return { ok: false, failure: raw.failure };

  const text = adapter.extractText(raw.payload);
  if (text === null) {
    return { ok: false, failure: failureOf('shape', clip(raw.rawText, 160), raw.status) };
  }
  return { ok: true, value: { text: text.slice(0, 40), elapsedMs: raw.elapsedMs } };
}

/** 拉取可用模型名。协议不支持列表接口时给出明确说法，而不是静默失败 */
export async function listModels(
  adapter: LlmAdapter,
  config: LlmConfig,
  opts: TransportOptions = {},
): Promise<LlmOutcome<string[]>> {
  const req = adapter.models(config);
  if (!req) {
    return { ok: false, failure: failureOf('shape', '该协议不提供模型列表接口') };
  }

  // 列表请求不需要模型名，把这一项从必填里摘出去
  const problem = configProblem({ ...config, model: config.model || 'placeholder' });
  if (problem && problem !== 'no-model') return { ok: false, failure: failureOf(problem) };

  const raw = await send(req, { timeoutMs: PROBE_TIMEOUT_MS, ...opts });
  if (!raw.ok) return { ok: false, failure: raw.failure };

  const models = adapter.extractModels(raw.payload);
  if (models === null || models.length === 0) {
    return { ok: false, failure: failureOf('shape', clip(raw.rawText, 160), raw.status) };
  }
  return { ok: true, value: models };
}

export { PROBE_MAX_TOKENS };
