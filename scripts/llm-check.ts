/**
 * 大模型接入层的回归检查，纯 Node 跑，不联网。
 *
 * 运行：npm run check:llm
 *
 * ── 为什么这一层要测得这么细 ──
 *
 * 这一层里绝大多数代码是错误分支：401、404、429、超时、断网、没授权、
 * 返回结构不对。这些分支在真实网络里一个都不好造，靠手工点着试基本覆盖
 * 不到，而它们恰恰是用户最常撞上的那部分。验收标准里的「Key 错误时给出
 * 明确提示」就落在这些分支上。
 *
 * 所以这里用一个假的 fetch 把全部失败逐条造出来，每条都断言两件事：归因
 * 对不对，以及给出的说明够不够具体。后者用长度卡一个下限——一条只有
 * 「调用失败」四个字的提示，用户拿它什么都做不了。
 *
 * 另外还卡住「请求体是三家的形状」：三种协议的 URL、鉴权头、消息结构都
 * 不一样，写错了在单测里能一眼看出来，放到真实调用里只会得到一个含糊的
 * 400。
 */
import {
  blankConfig,
  configProblem,
  joinUrl,
  normalizeLlmConfig,
  normalizeLlmSettings,
  originPatternOf,
  requiresApiKey,
  settingsReady,
  LLM_PROTOCOLS,
  PROTOCOL_LABEL,
} from '../src/core/llm/config';
import {
  PROVIDER_PRESETS,
  adapterOf,
  presetByBaseUrl,
  presetsOf,
} from '../src/core/llm/providers';
import {
  callModel,
  failureOf,
  listModels,
  probeModel,
  send,
  type FetchLike,
  type ResponseLike,
} from '../src/core/llm/client';
import type { LlmConfig, LlmFailureKind } from '../src/core/llm/types';

declare const process: { exit(code?: number): void };

const report: string[] = [];
let failed = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failed++;
  report.push(`${ok ? '✓' : '✗'} ${name}${!ok && detail ? `　→ 实际 ${detail}` : ''}`);
}

function eq(name: string, actual: unknown, expected: unknown): void {
  const a = typeof actual === 'string' ? actual : JSON.stringify(actual);
  const e = typeof expected === 'string' ? expected : JSON.stringify(expected);
  check(name, a === e, `${a}（期望 ${e}）`);
}

function cfg(over: Partial<LlmConfig> = {}): LlmConfig {
  return {
    protocol: 'openai',
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-test',
    model: 'test-model',
    maxTokens: 2048,
    ...over,
  };
}

function jsonResponse(status: number, payload: unknown): ResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
  };
}

function stubFetch(res: ResponseLike): FetchLike {
  return async () => res;
}

function throwingFetch(err: unknown): FetchLike {
  return async () => {
    throw err;
  };
}

/** 永不 resolve，只在收到取消信号时拒绝。用来造超时 */
const neverFetch: FetchLike = (_url, init) =>
  new Promise((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => {
      reject(new DOMException('aborted', 'AbortError'));
    });
  });

const abortErr = () => new DOMException('The user aborted a request.', 'AbortError');
const netErr = () => new TypeError('Failed to fetch');

// ---------------------------------------------------------------------
// 一、预置端点表
// ---------------------------------------------------------------------

check('协议清单与适配器一一对应', LLM_PROTOCOLS.length === 3 && LLM_PROTOCOLS.every((p) => PROTOCOL_LABEL[p] !== undefined));
check('预置数量足以覆盖常用服务商', PROVIDER_PRESETS.length >= 10, String(PROVIDER_PRESETS.length));
check('预置 id 唯一', new Set(PROVIDER_PRESETS.map((p) => p.id)).size === PROVIDER_PRESETS.length);
check('三个协议各有预置', LLM_PROTOCOLS.every((p) => presetsOf(p).length > 0));
check(
  '预置要么是可用的 https 地址，要么留空让用户自己填',
  PROVIDER_PRESETS.every((p) => p.baseUrl === '' || /^https?:\/\//.test(p.baseUrl)),
  PROVIDER_PRESETS.filter((p) => p.baseUrl !== '' && !/^https?:\/\//.test(p.baseUrl)).map((p) => p.id).join(','),
);
check(
  '预置地址不带末尾斜杠',
  PROVIDER_PRESETS.every((p) => p.baseUrl === p.baseUrl.replace(/\/+$/, '')),
);
check(
  '自定义预置的地址是空的',
  PROVIDER_PRESETS.filter((p) => p.id.startsWith('custom-')).every((p) => p.baseUrl === ''),
);
check(
  '每个预置都有一句说明',
  PROVIDER_PRESETS.every((p) => p.note.length > 4),
  PROVIDER_PRESETS.filter((p) => p.note.length <= 4).map((p) => p.id).join(','),
);
check(
  '非自定义预置给了拿 Key 的地址',
  PROVIDER_PRESETS.filter((p) => !p.id.startsWith('custom-')).every((p) => /^https:\/\//.test(p.consoleUrl)),
);
// 本地部署那一条必须走明文 http，否则本机服务根本连不上
check(
  '本地部署的预置用 http',
  PROVIDER_PRESETS.some((p) => p.id === 'ollama' && p.baseUrl.startsWith('http://')),
);
check(
  '预设反查能按地址找回服务商',
  presetByBaseUrl('https://api.deepseek.com/v1/')?.id === 'deepseek',
);
eq('认不出的地址返回 null', presetByBaseUrl('https://my-proxy.internal/v1'), null);
eq('空地址返回 null', presetByBaseUrl('  '), null);

// ---------------------------------------------------------------------
// 二、配置归一化
// ---------------------------------------------------------------------

const dirty = normalizeLlmConfig({
  protocol: '不存在的协议',
  baseUrl: '  https://api.example.com/v1///  ',
  apiKey: '  sk-abc  ',
  model: '  m1  ',
  maxTokens: 999999,
});
eq('未知协议回落到默认值', dirty.protocol, 'openai');
eq('地址去掉首尾空白和末尾斜杠', dirty.baseUrl, 'https://api.example.com/v1');
eq('Key 去掉首尾空白', dirty.apiKey, 'sk-abc');
eq('模型名去掉首尾空白', dirty.model, 'm1');
eq('过大的生成上限被夹到上限', dirty.maxTokens, 32768);

const tiny = normalizeLlmConfig({ maxTokens: 1 });
eq('过小的生成上限被夹到下限', tiny.maxTokens, 256);
eq('缺失字段落成空值', JSON.stringify(normalizeLlmConfig({})), JSON.stringify(blankConfig()));
eq('null 输入不会抛异常', JSON.stringify(normalizeLlmConfig(null)), JSON.stringify(blankConfig()));
eq('数组输入不会抛异常', normalizeLlmConfig([]).protocol, 'openai');
eq('数字输入不会抛异常', normalizeLlmConfig(7).model, '');

const settings = normalizeLlmSettings({ config: { apiKey: 'k' }, useLlm: 'yes', savedAt: 5 });
eq('设置里的 useLlm 类型不对时回落到默认开', settings.useLlm, true);
eq('设置里的 savedAt 类型不对时回落到 null', settings.savedAt, null);
eq('设置里的 config 也会被归一化', settings.config.apiKey, 'k');
eq('旧 auto=true 兼容到 useLlm=true', normalizeLlmSettings({ auto: true }).useLlm, true);
eq('旧 auto=false 兼容到 useLlm=false', normalizeLlmSettings({ auto: false }).useLlm, false);
eq('useLlm 显式为 false 时保留', normalizeLlmSettings({ useLlm: false }).useLlm, false);

// ---------------------------------------------------------------------
// 三、地址工具
// ---------------------------------------------------------------------

eq('拼接去掉重复斜杠', joinUrl('https://h/v1/', '/chat'), 'https://h/v1/chat');
eq('拼接时基址无斜杠也正确', joinUrl('https://h/v1', 'chat'), 'https://h/v1/chat');
eq('权限串只到端口那一层', originPatternOf('https://api.example.com/v1/chat'), 'https://api.example.com/*');
eq('权限串保留端口', originPatternOf('http://localhost:11434/v1'), 'http://localhost:11434/*');
eq('非法地址拿不到权限串', originPatternOf('api.example.com'), null);
eq('非 http 协议拿不到权限串', originPatternOf('ftp://example.com'), null);
eq('空地址拿不到权限串', originPatternOf(''), null);

check('本机地址不强制填 Key', !requiresApiKey('http://localhost:11434/v1') && !requiresApiKey('http://127.0.0.1:1234/v1'));
check('远程地址要求填 Key', requiresApiKey('https://api.openai.com/v1'));
check('非法地址按要求填 Key 处理', requiresApiKey('不是地址'));

// 三种问题的判定顺序要和界面上字段从上到下的顺序一致，
// 用户按顺序填，报错也该按这个顺序出现
eq('先报地址问题', configProblem(cfg({ baseUrl: '', apiKey: '', model: '' })), 'bad-url');
eq('地址没问题再报 Key', configProblem(cfg({ apiKey: '', model: '' })), 'no-key');
eq('地址和 Key 都没问题再报模型名', configProblem(cfg({ model: '' })), 'no-model');
eq('本机地址跳过 Key 直接报模型名', configProblem(cfg({ baseUrl: 'http://localhost:11434/v1', apiKey: '', model: '' })), 'no-model');
eq('都齐了返回 null', configProblem(cfg()), null);
check('配置齐全时算就绪', settingsReady(normalizeLlmSettings({ config: cfg() })));
check('配置不全时不算就绪', !settingsReady(normalizeLlmSettings({})));

// ---------------------------------------------------------------------
// 四、三家的请求形状
// ---------------------------------------------------------------------

const openai = adapterOf('openai');
const anthropic = adapterOf('anthropic');
const gemini = adapterOf('gemini');

const oaChat = openai.chat(cfg(), 'SYS', 'USER');
eq('OpenAI 兼容的对话走到 chat/completions', oaChat.url, 'https://api.example.com/v1/chat/completions');
eq('OpenAI 兼容用 Bearer 鉴权', oaChat.headers['authorization'], 'Bearer sk-test');
eq('OpenAI 兼容的对话是 POST', oaChat.method, 'POST');

const oaBody = JSON.parse(oaChat.body ?? '{}') as Record<string, unknown>;
eq('OpenAI 兼容的请求体带模型名', oaBody.model, 'test-model');
check(
  'OpenAI 兼容的请求体有 system 和 user 两条消息',
  Array.isArray(oaBody.messages) && (oaBody.messages as unknown[]).length === 2,
  JSON.stringify(oaBody.messages),
);
eq(
  'OpenAI 兼容把 system 放在消息串里',
  JSON.stringify((oaBody.messages as { role: string }[])[0]?.role),
  '"system"',
);
// 现在带上 max_tokens：早期为躲推理模型对 max_tokens 的 400 而故意不发，
// 代价是服务端默认上限常太小、把大产出截断成半个 JSON。普通 chat 模型都接受。
check('OpenAI 兼容的对话带上 max_tokens', typeof oaBody.max_tokens === 'number' && oaBody.max_completion_tokens === undefined);
eq('OpenAI 兼容带上的是配置里的生成上限', oaBody.max_tokens, cfg().maxTokens);
eq('OpenAI 兼容的探测请求发一个很小的上限', JSON.parse(openai.probe(cfg()).body ?? '{}').max_tokens, 32);
eq('OpenAI 兼容的模型列表是 GET', openai.models(cfg())?.method, 'GET');
eq('OpenAI 兼容的模型列表地址', openai.models(cfg())?.url, 'https://api.example.com/v1/models');

const anChat = anthropic.chat(cfg({ protocol: 'anthropic' }), 'SYS', 'USER');
eq('Anthropic 的对话走到 messages', anChat.url, 'https://api.example.com/v1/messages');
eq('Anthropic 用 x-api-key 鉴权', anChat.headers['x-api-key'], 'sk-test');
eq('Anthropic 带上版本号', anChat.headers['anthropic-version'], '2023-06-01');
eq('Anthropic 带上浏览器直连白名单头', anChat.headers['anthropic-dangerous-direct-browser-access'], 'true');
check('Anthropic 不发 authorization 头', anChat.headers['authorization'] === undefined);

const anBody = JSON.parse(anChat.body ?? '{}') as Record<string, unknown>;
check('Anthropic 必填的 max_tokens 有给', typeof anBody.max_tokens === 'number' && anBody.max_tokens > 0);
eq('Anthropic 的 system 是顶层字段', anBody.system, 'SYS');
check(
  'Anthropic 的消息只有一条 user',
  Array.isArray(anBody.messages) && (anBody.messages as { role: string }[]).length === 1 &&
    (anBody.messages as { role: string }[])[0]?.role === 'user',
  JSON.stringify(anBody.messages),
);

const gmChat = gemini.chat(cfg({ protocol: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-x' }), 'SYS', 'USER');
eq('Gemini 的路径带模型名和方法', gmChat.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-x:generateContent');
eq('Gemini 用 x-goog-api-key 鉴权', gmChat.headers['x-goog-api-key'], 'sk-test');
check('Gemini 不把 Key 放进查询串', !gmChat.url.includes('key=') && !gmChat.url.includes('sk-test'));
check('Gemini 不发 authorization 头', gmChat.headers['authorization'] === undefined);

const gmBody = JSON.parse(gmChat.body ?? '{}') as Record<string, unknown>;
check('Gemini 的内容在 contents 里', Array.isArray(gmBody.contents));
eq('Gemini 的 system 是 systemInstruction', JSON.stringify(gmBody.systemInstruction).includes('SYS'), true);
check('Gemini 的输出上限在 generationConfig 里', gmBody.generationConfig !== undefined);

for (const [name, adapter] of [
  ['OpenAI 兼容', openai],
  ['Anthropic', anthropic],
  ['Gemini', gemini],
] as const) {
  const req = adapter.chat(cfg({ protocol: adapter.protocol }), 'S', 'U');
  check(`${name} 的请求体是合法 JSON`, (() => {
    try {
      JSON.parse(req.body ?? '');
      return true;
    } catch {
      return false;
    }
  })());
  check(`${name} 提供了模型列表接口`, adapter.models(cfg({ protocol: adapter.protocol })) !== null);
}

// ---------------------------------------------------------------------
// 五、取文本与取列表
// ---------------------------------------------------------------------

eq(
  'OpenAI 兼容取 choices 第一条的 content',
  openai.extractText({ choices: [{ message: { content: '答案' } }] }),
  '答案',
);
eq('OpenAI 兼容缺 choices 时返回 null', openai.extractText({}), null);
eq('OpenAI 兼容 content 为空串时返回 null', openai.extractText({ choices: [{ message: { content: '   ' } }] }), null);
eq('OpenAI 兼容 choices 为空数组时返回 null', openai.extractText({ choices: [] }), null);
eq('OpenAI 兼容拿到 null 载荷时不抛异常', openai.extractText(null), null);

// 带思考的模型会先回 thinking 块，那不是异常，跳过它取后面的文本块
eq(
  'Anthropic 只取 text 块并按顺序拼接',
  anthropic.extractText({
    content: [
      { type: 'thinking', thinking: '想一下' },
      { type: 'text', text: '第一段。' },
      { type: 'text', text: '第二段。' },
    ],
  }),
  '第一段。第二段。',
);
eq('Anthropic 只有非文本块时返回 null', anthropic.extractText({ content: [{ type: 'tool_use', id: 'x' }] }), null);
eq('Anthropic 缺 content 时返回 null', anthropic.extractText({}), null);

eq(
  'Gemini 拼接 parts 里的文本',
  gemini.extractText({ candidates: [{ content: { parts: [{ text: '前半' }, { text: '后半' }] } }] }),
  '前半后半',
);
eq('Gemini 被内容策略拦下时返回 null', gemini.extractText({ promptFeedback: { blockReason: 'SAFETY' } }), null);
eq('Gemini 缺 candidates 时返回 null', gemini.extractText({}), null);

eq(
  'OpenAI 兼容取模型列表',
  JSON.stringify(openai.extractModels({ data: [{ id: 'a' }, { id: 'b' }] })),
  JSON.stringify(['a', 'b']),
);
eq('形状不对时取不到模型列表', openai.extractModels({ models: [{ id: 'a' }] }), null);
eq('Gemini 的模型名剥掉 models/ 前缀', JSON.stringify(gemini.extractModels({ models: [{ name: 'models/gemini-x' }] })), JSON.stringify(['gemini-x']));
eq('Gemini 列表为空时返回 null', gemini.extractModels({ models: [] }), null);

// ---------------------------------------------------------------------
// 六、失败归因
// ---------------------------------------------------------------------

const CASES: { name: string; res: ResponseLike; kind: LlmFailureKind; status: number }[] = [
  { name: '401 归到 Key 无效', res: jsonResponse(401, { error: { message: 'Invalid API key' } }), kind: 'auth', status: 401 },
  { name: '403 归到 Key 无权限', res: jsonResponse(403, { error: { message: 'Forbidden' } }), kind: 'auth', status: 403 },
  { name: '402 归到额度不足', res: jsonResponse(402, { error: { message: 'Insufficient Balance' } }), kind: 'quota', status: 402 },
  { name: '404 归到地址或模型名不对', res: jsonResponse(404, { error: { message: 'not found' } }), kind: 'not-found', status: 404 },
  { name: '429 归到限流', res: jsonResponse(429, { error: { message: 'rate limit' } }), kind: 'quota', status: 429 },
  { name: '500 归到服务商故障', res: jsonResponse(500, 'Internal Server Error'), kind: 'server', status: 500 },
  { name: '503 归到服务商故障', res: jsonResponse(503, 'unavailable'), kind: 'server', status: 503 },
  { name: '408 归到超时', res: jsonResponse(408, 'timeout'), kind: 'timeout', status: 408 },
  { name: '504 归到超时', res: jsonResponse(504, 'gateway timeout'), kind: 'timeout', status: 504 },
  {
    name: '400 里提到 model 时归到模型名不对',
    res: jsonResponse(400, { error: { message: 'The model `x` does not exist' } }),
    kind: 'not-found',
    status: 400,
  },
  {
    name: '400 里没提 model 时归到请求被拒',
    res: jsonResponse(400, { error: { message: 'Unsupported parameter' } }),
    kind: 'request',
    status: 400,
  },
  { name: '418 归到其它 4xx', res: jsonResponse(418, 'teapot'), kind: 'request', status: 418 },
];

for (const c of CASES) {
  const outcome = await send(openai.chat(cfg(), 's', 'u'), { fetchImpl: stubFetch(c.res) });
  check(c.name, !outcome.ok && outcome.failure.kind === c.kind, outcome.ok ? '居然成功了' : outcome.failure.kind);
  if (!outcome.ok) {
    eq(`　└ 状态码带上了　${c.kind}`, outcome.failure.status, c.status);
    check(`　└ 服务商原话带上了　${c.kind}`, outcome.failure.detail.length > 0);
  }
}

// 2xx 但取不到输出，是最难从现象倒推的一类：网络、鉴权、模型名全对，
// 只是拿回来的东西不是预期的形状
const emptyShape = await callModel(openai, cfg(), 's', 'u', {
  fetchImpl: stubFetch(jsonResponse(200, { choices: [{ message: { content: '' } }] })),
});
check('响应里没有模型输出时归到结构不对', !emptyShape.ok && emptyShape.failure.kind === 'shape');

const notJsonShape = await callModel(openai, cfg(), 's', 'u', {
  fetchImpl: stubFetch({ ok: true, status: 200, text: async () => '<html>502 Bad Gateway</html>' }),
});
check('响应不是 JSON 时归到结构不对', !notJsonShape.ok && notJsonShape.failure.kind === 'shape');

// ---------------------------------------------------------------------
// 七、请求根本没发出去的情况
// ---------------------------------------------------------------------

const netFail = await callModel(openai, cfg(), 's', 'u', { fetchImpl: throwingFetch(netErr()) });
check('网络层面失败归到发不出去', !netFail.ok && netFail.failure.kind === 'unreachable', netFail.ok ? '' : netFail.failure.kind);

const denied = await callModel(openai, cfg(), 's', 'u', {
  fetchImpl: throwingFetch(netErr()),
  hasPermission: async () => false,
});
check('没授权时归到权限问题而不是网络问题', !denied.ok && denied.failure.kind === 'permission', denied.ok ? '' : denied.failure.kind);

const permQueryBroken = await callModel(openai, cfg(), 's', 'u', {
  fetchImpl: throwingFetch(netErr()),
  hasPermission: async () => {
    throw new Error('权限接口本身挂了');
  },
});
check('权限查询失败时退回网络归因', !permQueryBroken.ok && permQueryBroken.failure.kind === 'unreachable');

const aborted = await callModel(openai, cfg(), 's', 'u', { fetchImpl: throwingFetch(abortErr()) });
check('主动取消归到已取消', !aborted.ok && aborted.failure.kind === 'aborted', aborted.ok ? '' : aborted.failure.kind);

const timedOut = await callModel(openai, cfg(), 's', 'u', { fetchImpl: neverFetch, timeoutMs: 40 });
check('到点没响应归到超时', !timedOut.ok && timedOut.failure.kind === 'timeout', timedOut.ok ? '' : timedOut.failure.kind);

// 超时和主动取消都要走 abort 分支，必须先判是不是我们掐的
const outer = new AbortController();
setTimeout(() => outer.abort(), 20);
const outerAbort = await callModel(openai, cfg(), 's', 'u', { fetchImpl: neverFetch, timeoutMs: 5000, signal: outer.signal });
check('调用方取消时不会被误报成超时', !outerAbort.ok && outerAbort.failure.kind === 'aborted', outerAbort.ok ? '' : outerAbort.failure.kind);

// ---------------------------------------------------------------------
// 八、配置不全时不发请求
//
// 这几种情况都在发请求之前就该拦下来：发出去只会拿到一个更难解释的错误，
// 而且白花一次额度
// ---------------------------------------------------------------------

let sentCount = 0;
const countingFetch: FetchLike = async () => {
  sentCount++;
  return jsonResponse(200, { choices: [{ message: { content: 'ok' } }] });
};

sentCount = 0;
const noKey = await callModel(openai, cfg({ apiKey: '' }), 's', 'u', { fetchImpl: countingFetch });
check('没填 Key 时直接报错', !noKey.ok && noKey.failure.kind === 'no-key');
eq('没填 Key 时没有发出请求', sentCount, 0);

sentCount = 0;
const noModel = await callModel(openai, cfg({ model: '' }), 's', 'u', { fetchImpl: countingFetch });
check('没填模型名时直接报错', !noModel.ok && noModel.failure.kind === 'no-model');
eq('没填模型名时没有发出请求', sentCount, 0);

sentCount = 0;
const badUrl = await callModel(openai, cfg({ baseUrl: 'api.example.com' }), 's', 'u', { fetchImpl: countingFetch });
check('地址非法时直接报错', !badUrl.ok && badUrl.failure.kind === 'bad-url');
eq('地址非法时没有发出请求', sentCount, 0);

// ---------------------------------------------------------------------
// 九、测试连接与模型列表
// ---------------------------------------------------------------------

const probeOk = await probeModel(openai, cfg(), { fetchImpl: stubFetch(jsonResponse(200, { choices: [{ message: { content: 'ok' } }] })) });
check('测试连接成功时回内容', probeOk.ok && probeOk.value.text === 'ok');
check('测试连接带回耗时', probeOk.ok && probeOk.value.elapsedMs >= 0);

const probeBad = await probeModel(openai, cfg(), { fetchImpl: stubFetch(jsonResponse(401, { error: { message: 'bad key' } })) });
check('测试连接把 Key 错误原样报出来', !probeBad.ok && probeBad.failure.kind === 'auth');

const modelsOk = await listModels(openai, cfg({ model: '' }), {
  fetchImpl: stubFetch(jsonResponse(200, { data: [{ id: 'm1' }, { id: 'm2' }] })),
});
check('拉取模型列表时不要求填模型名', modelsOk.ok && modelsOk.value.length === 2, modelsOk.ok ? '' : modelsOk.failure.kind);

const modelsNoKey = await listModels(openai, cfg({ apiKey: '', model: '' }), { fetchImpl: countingFetch });
check('拉取模型列表仍然要求 Key', !modelsNoKey.ok && modelsNoKey.failure.kind === 'no-key');

for (const [name, adapter, payload] of [
  ['OpenAI 兼容', openai, { data: [{ id: 'x' }] }],
  ['Anthropic', anthropic, { data: [{ id: 'x' }] }],
  ['Gemini', gemini, { models: [{ name: 'models/x' }] }],
] as const) {
  const got = await listModels(adapter, cfg({ protocol: adapter.protocol }), {
    fetchImpl: stubFetch(jsonResponse(200, payload)),
  });
  check(`${name} 的模型列表能解析出来`, got.ok && got.value[0] === 'x', got.ok ? JSON.stringify(got.value) : got.failure.kind);
}

// ---------------------------------------------------------------------
// 十、每一种失败都必须说清楚
//
// 「明确提示」这条验收标准在这里被机器化：每一种失败都要有非空的结论句，
// 以及一段够长的、能指导下一步动作的说明。只写「调用失败」的用户拿它
// 什么都做不了，所以用长度卡一个下限。
// ---------------------------------------------------------------------

const ALL_KINDS: LlmFailureKind[] = [
  'no-key',
  'no-model',
  'bad-url',
  'permission',
  'auth',
  'not-found',
  'quota',
  'request',
  'server',
  'timeout',
  'unreachable',
  'shape',
  'aborted',
];

for (const kind of ALL_KINDS) {
  const f = failureOf(kind, '服务商原话');
  check(`${kind} 有结论句`, f.title.trim().length >= 4, f.title);
  check(`${kind} 的说明足够具体`, f.body.trim().length >= 20, f.body);
  eq(`${kind} 的 kind 字段原样带回`, f.kind, kind);
}

check(
  '不可重试的失败被标成不可重试',
  !failureOf('auth').retryable && !failureOf('no-key').retryable && !failureOf('bad-url').retryable,
);
check(
  '临时性失败被标成可重试',
  failureOf('server').retryable && failureOf('timeout').retryable && failureOf('unreachable').retryable,
);
check('服务商原话会进 detail', failureOf('auth', 'Invalid API key').detail === 'Invalid API key');
check('没有原话时 detail 是空串', failureOf('auth').detail === '');
// 有些实现会把整个请求体回显在错误里，不截断会把提示块撑爆
check(
  '过长的原话被截断',
  failureOf('auth', 'x'.repeat(1000)).detail.length <= 301,
  String(failureOf('auth', 'x'.repeat(1000)).detail.length),
);

console.log('='.repeat(64));
console.log('断言结果');
console.log('='.repeat(64));
for (const line of report) console.log(line);
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项未通过`);

process.exit(failed === 0 ? 0 : 1);
