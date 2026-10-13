/**
 * 设置页。
 *
 * 这一页要干的事里有一件是别的页面干不了的：申请网络权限。Chrome 只允许在
 * 用户手势里发起 chrome.permissions.request，所以「保存」和「测试连接」这两
 * 个按钮的处理函数第一件事都是申请权限，而且中间不能再插别的异步跳转。
 *
 * 界面上的取舍只有一条值得说：所有失败都原样展示服务商返回的原话。用户拿
 * 这句话去搜，通常比看我们翻译过的一句「调用失败」有用得多。
 */
import './style.css';
import {
  PROTOCOL_LABEL,
  LLM_PROTOCOLS,
  originPatternOf,
  requiresApiKey,
} from '@/core/llm/config';
import { PROVIDER_PRESETS, adapterOf, presetsOf } from '@/core/llm/providers';
import { listModels, probeModel } from '@/core/llm/client';
import { PROMPT_VERSION } from '@/core/llm/prompt';
import {
  clearLlmSettings,
  ensureOriginPermission,
  hasOriginPermission,
  loadLlmSettings,
  saveLlmSettings,
} from '@/core/settings';
import type { LlmConfig, LlmFailure, LlmProtocol, LlmSettings, ProviderPreset } from '@/core/llm/types';

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`设置页缺少节点 ${id}`);
  return node as T;
}

const protocolSelect = el<HTMLSelectElement>('protocol');
const presetSelect = el<HTMLSelectElement>('preset');
const baseInput = el<HTMLInputElement>('base-url');
const keyInput = el<HTMLInputElement>('api-key');
const modelInput = el<HTMLInputElement>('model');
const modelList = el<HTMLDataListElement>('model-list');
const autoCheck = el<HTMLInputElement>('auto');
const statusBox = el<HTMLElement>('status');

let settings: LlmSettings = {
  config: { protocol: 'openai', baseUrl: '', apiKey: '', model: '', maxTokens: 2048 },
  auto: true,
  savedAt: null,
};

/** 读取当前表单里的值。不读存储，存储只在下一次 load 时进表单 */
function formConfig(): LlmConfig {
  return {
    protocol: protocolSelect.value as LlmProtocol,
    baseUrl: baseInput.value.trim().replace(/\/+$/, ''),
    apiKey: keyInput.value.trim(),
    model: modelInput.value.trim(),
    maxTokens: settings.config.maxTokens,
  };
}

// ---------------------------------------------------------------------
// 状态块
// ---------------------------------------------------------------------

type StatusKind = 'ok' | 'warn' | 'bad' | 'busy';

function showStatus(kind: StatusKind, title: string, body = '', detail = '') {
  statusBox.hidden = false;
  statusBox.className = `status ${kind}`;
  statusBox.innerHTML = `
    <p class="status-title">${escapeHtml(title)}</p>
    ${body ? `<p class="status-body">${escapeHtml(body)}</p>` : ''}
    ${detail ? `<code class="status-detail">${escapeHtml(detail)}</code>` : ''}`;
}

function showFailure(failure: LlmFailure) {
  showStatus('bad', failure.title, failure.body, failure.detail);
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
}

// ---------------------------------------------------------------------
// 表单联动
// ---------------------------------------------------------------------

function fillProtocols() {
  protocolSelect.innerHTML = LLM_PROTOCOLS.map(
    (p) => `<option value="${p}">${PROTOCOL_LABEL[p]}</option>`,
  ).join('');
}

function fillPresets(protocol: LlmProtocol) {
  presetSelect.innerHTML = presetsOf(protocol)
    .map((p) => `<option value="${p.id}">${escapeHtml(p.label)}</option>`)
    .join('');
}

function currentPreset(): ProviderPreset | null {
  return PROVIDER_PRESETS.find((p) => p.id === presetSelect.value) ?? null;
}

function renderPresetHint() {
  const p = currentPreset();
  el('protocol-hint').textContent =
    protocolSelect.value === 'openai'
      ? '所有遵循 chat/completions 的服务商都走这一条，换服务商只需要换地址。'
      : protocolSelect.value === 'anthropic'
        ? 'Messages 协议，请求结构与前一条不同，system 是顶层字段。'
        : 'generateContent 协议，key 走 x-goog-api-key 请求头。';

  const hint = el('preset-hint');
  if (!p) {
    hint.textContent = '';
    return;
  }
  const link = p.consoleUrl
    ? `<a href="${p.consoleUrl}" target="_blank" rel="noreferrer">去这里拿 Key</a>`
    : '';
  hint.innerHTML = `${escapeHtml(p.note)}${link ? `　${link}` : ''}`;
}

function renderKeyHint() {
  const config = formConfig();
  const need = requiresApiKey(config.baseUrl);
  el('key-hint').textContent = need
    ? '只存在本机，不会同步到账号，也不参与导出。'
    : '这个地址是本机服务，服务端通常不校验 Key，随便填一个占位即可。';

  const pattern = originPatternOf(config.baseUrl);
  const permNote = el('base-hint');
  if (!pattern) {
    permNote.textContent = '填到版本段为止，路径由插件按协议补全。';
    return;
  }
  void hasOriginPermission(config.baseUrl).then((granted) => {
    permNote.textContent = granted
      ? `已获得 ${pattern} 的访问权限。`
      : `还没有 ${pattern} 的访问权限，保存或测试时会弹一次确认。`;
  });
}

/** 切换协议：重建预设列表，并把该协议第一个预设的地址与模型名填进去 */
function applyProtocolChange() {
  const protocol = protocolSelect.value as LlmProtocol;
  fillPresets(protocol);
  const first = presetsOf(protocol)[0];
  if (first) {
    presetSelect.value = first.id;
    applyPreset(first, true);
  }
  renderPresetHint();
  renderKeyHint();
}

/**
 * 套用某个预设。
 *
 * force 为 true 时覆盖用户已经填过的地址（切协议时用），否则只在字段为空时
 * 填。用户手工改过地址之后再点一下预设，不该把他改的内容擦掉。
 */
function applyPreset(preset: ProviderPreset, force: boolean) {
  if (preset.baseUrl.length > 0 && (force || baseInput.value.trim().length === 0)) {
    baseInput.value = preset.baseUrl;
  }
  if (preset.defaultModel.length > 0 && (force || modelInput.value.trim().length === 0)) {
    modelInput.value = preset.defaultModel;
  }
  renderKeyHint();
}

// ---------------------------------------------------------------------
// 动作
// ---------------------------------------------------------------------

/**
 * 申请权限，然后把配置落盘。
 *
 * 顺序不能反。权限申请必须在手势里发起，而落盘是一次 await；放到后面虽然
 * 通常也还能弹出来，但一旦弹不出来就变成一个很难复现的问题。
 */
async function onSave() {
  const config = formConfig();
  const pattern = originPatternOf(config.baseUrl);

  let granted = true;
  if (pattern) granted = await ensureOriginPermission(config.baseUrl);

  settings = { config, auto: autoCheck.checked, savedAt: new Date().toISOString() };
  await saveLlmSettings(settings);
  renderSavedAt();

  if (!pattern) {
    showStatus(
      'warn',
      '配置已保存，但地址还不完整',
      '接口地址不是一个合法的网址，补全之后才能测试连接。从上面的服务商列表里选一个会自动填好。',
    );
    return;
  }

  if (!granted) {
    showStatus(
      'warn',
      '配置已保存，但没有拿到网络权限',
      `${pattern} 的访问权限没有授予，调用会失败。可以再点一次「保存」重新弹确认框；` +
        '如果之前点过拒绝，需要去 chrome://extensions 里给本扩展重新授权。',
    );
    return;
  }

  showStatus('ok', '配置已保存', '回到插件弹窗重新提取一次，就会带上 AI 补全的内容。');
  renderKeyHint();
}

async function onTest() {
  const config = formConfig();
  const pattern = originPatternOf(config.baseUrl);
  if (pattern) await ensureOriginPermission(config.baseUrl);

  showStatus('busy', '正在测试连接…', '发一次极小的真实调用，验证地址、Key、模型名和权限四件事。');

  const adapter = adapterOf(config.protocol);
  const outcome = await probeModel(adapter, config, { hasPermission: hasOriginPermission });

  if (!outcome.ok) {
    showFailure(outcome.failure);
    return;
  }

  showStatus(
    'ok',
    '连接正常',
    `模型回了「${outcome.value.text}」，用时 ${outcome.value.elapsedMs} 毫秒。地址、Key、模型名都对得上。`,
  );
}

async function onFetchModels() {
  const config = formConfig();
  const pattern = originPatternOf(config.baseUrl);
  if (pattern) await ensureOriginPermission(config.baseUrl);

  showStatus('busy', '正在拉取模型列表…');

  const adapter = adapterOf(config.protocol);
  const outcome = await listModels(adapter, config, { hasPermission: hasOriginPermission });

  if (!outcome.ok) {
    showFailure(outcome.failure);
    return;
  }

  const models = outcome.value;
  modelList.innerHTML = models.map((m) => `<option value="${escapeHtml(m)}"></option>`).join('');
  showStatus(
    'ok',
    `拿到 ${models.length} 个模型名`,
    '模型名输入框现在带自动补全，点进去就能从列表里挑。',
    models.slice(0, 30).join('　'),
  );
}

async function onClear() {
  await clearLlmSettings();
  settings = {
    config: { protocol: 'openai', baseUrl: '', apiKey: '', model: '', maxTokens: settings.config.maxTokens },
    auto: true,
    savedAt: null,
  };
  protocolSelect.value = 'openai';
  fillPresets('openai');
  presetSelect.value = 'openai';
  baseInput.value = '';
  keyInput.value = '';
  modelInput.value = '';
  modelList.innerHTML = '';
  autoCheck.checked = true;
  statusBox.hidden = true;
  renderSavedAt();
  showStatus('ok', '配置已清空', '插件回到本地生成模式，后续提取不再调用模型。');
}

// ---------------------------------------------------------------------
// 初始化
// ---------------------------------------------------------------------

function renderSavedAt() {
  const t = settings.savedAt;
  el('saved-at').textContent = t ? `上次保存 ${new Date(t).toLocaleString('zh-CN')}` : '还没有保存过';
}

function wire() {
  protocolSelect.addEventListener('change', applyProtocolChange);

  presetSelect.addEventListener('change', () => {
    const p = currentPreset();
    if (p) applyPreset(p, true);
    renderPresetHint();
    renderKeyHint();
  });

  baseInput.addEventListener('input', renderKeyHint);

  el<HTMLButtonElement>('toggle-key').addEventListener('click', (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    const show = keyInput.type === 'password';
    keyInput.type = show ? 'text' : 'password';
    btn.textContent = show ? '隐藏' : '显示';
  });

  el<HTMLButtonElement>('save').addEventListener('click', () => void onSave());
  el<HTMLButtonElement>('test').addEventListener('click', () => void onTest());
  el<HTMLButtonElement>('fetch-models').addEventListener('click', () => void onFetchModels());
  el<HTMLButtonElement>('clear').addEventListener('click', () => void onClear());
}

/**
 * 猜当前配置对应哪个预设。
 *
 * 先按地址精确匹配；匹配不上说明用户手工改过地址，此时落到该协议下的
 * 「自定义」那一项。预设下拉是纯粹的表单辅助，猜错了不会影响已经填好的值，
 * 所以这里不追求多聪明的推断。
 */
function matchPreset(config: LlmConfig): ProviderPreset | null {
  const norm = config.baseUrl.replace(/\/+$/, '');
  const same = presetsOf(config.protocol);
  const exact = same.find((p) => p.baseUrl.replace(/\/+$/, '') === norm && norm.length > 0);
  if (exact) return exact;
  return same.find((p) => p.id.startsWith('custom-')) ?? same[0] ?? null;
}

async function init() {
  fillProtocols();

  settings = await loadLlmSettings();
  const c = settings.config;

  protocolSelect.value = c.protocol;
  fillPresets(c.protocol);

  const matched = matchPreset(c);
  if (matched) presetSelect.value = matched.id;

  baseInput.value = c.baseUrl;
  // 回显真实值，但输入框是 type=password，默认看不见。要看就点「显示」，
  // 不在这里预先打码——打码后的值一旦被保存下来，Key 就废了
  keyInput.value = c.apiKey;
  modelInput.value = c.model;
  autoCheck.checked = settings.auto;

  el('version-foot').textContent = `提示词版本 ${PROMPT_VERSION}　配置结构 v1`;
  renderPresetHint();
  renderKeyHint();
  renderSavedAt();
}

wire();
void init();
