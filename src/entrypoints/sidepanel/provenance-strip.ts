/**
 * 弹窗底部的溯源状态条，以及把点击变成页面高亮的那条链路。
 *
 * ── 为什么状态条不是唯一的信息出口 ──
 *
 * 扩展弹窗在失焦时会立刻被销毁。用户点完一个 token 之后想看页面上的高亮，
 * 鼠标一移到页面上弹窗就没了，这条状态条也跟着消失。所以「描了多少处」这
 * 件事必须在页面上也说得出来，那是 core/highlight.ts 里那张浮层卡负责的；
 * 这条状态条是弹窗还在时的镜像，不是权威来源。两处都要印得对，理由就在这。
 *
 * ── 两处数字要对得上 ──
 *
 * 状态条上的总数和浮层卡上的「N 处」必须是同一个口径，也就是跨渠道去重后
 * 的元素个数。直接累加各组的长度会偏大，因为一个元素可能同时被两条渠道
 * 命中（背景和边框同色）。去重之后两边就都是页面上的实际元素数。
 *
 * 唯一的例外是 missing：页面在弹窗打开后还会继续变化，已经摘掉的元素画不
 * 上去，浮层卡上那个数会比这里小。这种情况浮层卡会单独说一句，状态条这边
 * 也照说，不把差额藏起来。
 *
 * ── 每次都是重新描，不会叠加 ──
 *
 * 描之前 highlight.ts 会把上一次描的擦干净，所以连点几个 token 的结果是
 * 最后一次那个，不会留下几层描边。这里也就不需要在切换前先发一次 clear。
 */
import { highlightElements } from '@/core/highlight';
import { provenanceOf, type ProvenanceInput, type ProvenanceResult } from '@/core/provenance';
import { decodeToken, encodeToken, TOKEN_ATTR } from '@/core/token-ref';
import type { HighlightCommand, HighlightResult, PageSample } from '@/core/types';

/**
 * 把一个 token 编成可以贴在行上的属性片段。编不出来返回空串。
 *
 * 返回的是带前导空格的整段，调用方直接接在标签名后面。这样「能不能点」
 * 这件事只有一处判断，某个 token 编不出属性时那一行自然就不是可点行，
 * 不需要每个渲染函数各写一遍 if。
 */
export function tokAttr(token: Parameters<typeof encodeToken>[0]): string {
  const raw = encodeToken(token);
  return raw === '' ? '' : ` ${TOKEN_ATTR}="${raw}"`;
}

// ---------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------

let tabId: number | null = null;
let input: ProvenanceInput | null = null;
let activeAttr: string | null = null;

let strip: HTMLElement | null = null;
let host: HTMLElement | null = null;
let onEscape: ((ev: KeyboardEvent) => void) | null = null;

// ---------------------------------------------------------------------
// 与页面之间那一跳
// ---------------------------------------------------------------------

/**
 * 发一条指令给页面。
 *
 * 失败一律折成 HighlightResult 而不是抛出去。能走到这里的失败只有两种：
 * 标签页已经关掉或换了地址，扩展没拿到那个站点的注入许可。两种都要给用户
 * 一句话，而不是让点击静默失败。
 */
async function send(cmd: HighlightCommand): Promise<HighlightResult> {
  if (tabId === null) {
    return { ok: false, highlighted: 0, missing: 0, stale: false, reason: '还没有定位到标签页。' };
  }
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: highlightElements,
      args: [cmd],
    });
    const got = results?.[0]?.result as HighlightResult | undefined;
    if (!got) {
      return { ok: false, highlighted: 0, missing: 0, stale: false, reason: '页面没有返回结果。' };
    }
    return got;
  } catch {
    return {
      ok: false,
      highlighted: 0,
      missing: 0,
      stale: false,
      reason: '这个标签页现在注入不了脚本。切到网页本身再点一次。',
    };
  }
}

// ---------------------------------------------------------------------
// 数量口径
// ---------------------------------------------------------------------

/** 跨渠道去重后的元素个数。状态条和浮层卡印的都是它 */
function distinctRefs(result: ProvenanceResult): number {
  const seen = new Set<number>();
  for (let i = 0; i < result.groups.length; i++) {
    const g = result.groups[i];
    if (!g) continue;
    for (let j = 0; j < g.refs.length; j++) {
      const ref = g.refs[j];
      if (typeof ref === 'number') seen.add(ref);
    }
  }
  return seen.size;
}

/**
 * 命中元素的标签构成。
 *
 * 一行 `div 15 · span 8 · button 5`，回答的是「这一组里都是些什么元素」。
 * 它不替代页面上的描边，但能在不看页面的时候闻出问题：一个字号档位如果
 * 描出十几个 div，判据多半串到了容器上。
 */
function describeMix(sample: PageSample, result: ProvenanceResult): string {
  const refs = new Set<number>();
  for (let i = 0; i < result.groups.length; i++) {
    const g = result.groups[i];
    if (!g) continue;
    for (let j = 0; j < g.refs.length; j++) {
      const ref = g.refs[j];
      if (typeof ref === 'number') refs.add(ref);
    }
  }

  const elements = Array.isArray(sample.elements) ? sample.elements : [];
  const tally = new Map<string, number>();
  for (let i = 0; i < elements.length; i++) {
    const item = elements[i];
    if (!item || !refs.has(item.ref)) continue;
    const tag = typeof item.tag === 'string' && item.tag ? item.tag.toLowerCase() : '?';
    tally.set(tag, (tally.get(tag) ?? 0) + 1);
  }

  const sorted = [...tally.entries()].sort((a, b) => b[1] - a[1]);
  const shown = sorted.slice(0, 4).map(([tag, n]) => `${tag} ${n}`);
  if (sorted.length > shown.length) shown.push(`等 ${sorted.length} 种`);
  return shown.join(' · ');
}

/** 浮层卡第二行的明细，例如「作背景 12 处 · 作文字 8 处」 */
function subtitleOf(result: ProvenanceResult): string {
  const parts: string[] = [];
  for (let i = 0; i < result.groups.length; i++) {
    const g = result.groups[i];
    if (!g) continue;
    parts.push(`${g.label} ${g.refs.length} 处`);
  }
  return parts.join(' · ');
}

// ---------------------------------------------------------------------
// 状态条渲染
// ---------------------------------------------------------------------

function node(tag: string, cls: string, text?: string): HTMLElement {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function proveButton(action: 'locate' | 'clear', label: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'prove-btn';
  b.dataset.prove = action;
  b.textContent = label;
  return b;
}

/**
 * 按一次解析结果重建状态条。
 *
 * 全部用 DOM 节点加 textContent 而不是拼 HTML 串。这里的文字有页面标题、
 * 元素类型这些来自外部页面的内容，走 innerHTML 就要再过一遍转义，而转义
 * 漏一个字符就是一个注入点。用 textContent 之后这个问题不存在。
 */
function render(result: ProvenanceResult, outcome: HighlightResult): void {
  if (!strip) return;

  strip.textContent = '';
  strip.hidden = false;
  strip.className = outcome.ok && outcome.reason === '' ? 'prove' : 'prove prove-bad';

  const head = node('div', 'prove-head');
  head.appendChild(node('span', 'prove-title', result.title));
  head.appendChild(node('span', 'prove-total', `${distinctRefs(result)} 处`));

  const close = proveButton('clear', '×');
  close.className = 'prove-x';
  close.title = '取消高亮';
  head.appendChild(close);
  strip.appendChild(head);

  // 每条渠道各自的数量，色点的颜色和页面上那一圈描边是同一个值，
  // 这样页面上三种颜色的描边各属于哪条渠道，看这一行就能对上
  if (result.groups.length > 0) {
    const groups = node('div', 'prove-groups');
    for (let i = 0; i < result.groups.length; i++) {
      const g = result.groups[i];
      if (!g) continue;
      const item = node('span', 'prove-group');
      const dot = node('i', 'prove-dot');
      dot.style.background = g.color;
      item.appendChild(dot);
      item.appendChild(document.createTextNode(`${g.label} ${g.refs.length} 处`));
      groups.appendChild(item);
    }
    strip.appendChild(groups);
  }

  if (result.detail) strip.appendChild(node('div', 'prove-detail', result.detail));

  if (input) {
    const mix = describeMix(input.sample, result);
    if (mix) strip.appendChild(node('div', 'prove-mix', `元素构成　${mix}`));
  }

  // 三句警告各有各的成因，合起来说会让人分不清该做什么：
  //   note     解析层自己发现某组的数和界面上的数字对不上
  //   stale    页面刷新过，注册表没了，一处都没画上
  //   missing  画上了，但有几个元素已经不在页面上
  const warns = node('div', 'prove-warns');
  if (result.note) warns.appendChild(node('div', 'prove-warn', result.note));
  if (outcome.stale) {
    warns.appendChild(node('div', 'prove-warn', outcome.reason || '这个页面已经刷新过，重新提取一次。'));
  } else if (outcome.missing > 0) {
    warns.appendChild(
      node(
        'div',
        'prove-warn',
        `另有 ${outcome.missing} 处元素已经不在页面上，页面上的浮层只会显示还在的那 ${outcome.highlighted} 处。`,
      ),
    );
  } else if (!outcome.ok && outcome.reason) {
    warns.appendChild(node('div', 'prove-warn', outcome.reason));
  }
  if (warns.childNodes.length > 0) strip.appendChild(warns);

  const acts = node('div', 'prove-acts');
  acts.appendChild(proveButton('locate', '定位第一处'));
  acts.appendChild(proveButton('clear', '取消高亮'));
  acts.appendChild(node('span', 'prove-hint', 'Esc 也可以取消'));
  strip.appendChild(acts);
}

function hide(): void {
  if (!strip) return;
  strip.hidden = true;
  strip.textContent = '';
}

/** 画一条「正在做」的提示。页面往返通常只有几十毫秒，但慢的时候要有交代 */
function renderPending(title: string): void {
  if (!strip) return;
  strip.textContent = '';
  strip.hidden = false;
  strip.className = 'prove';
  const head = node('div', 'prove-head');
  head.appendChild(node('span', 'prove-title', title));
  head.appendChild(node('span', 'prove-total', '正在标出…'));
  strip.appendChild(head);
}

// ---------------------------------------------------------------------
// 对外
// ---------------------------------------------------------------------

/**
 * 挂上状态条并绑好它自己的按钮和 Esc。只在启动时调一次。
 *
 * 状态条挂在结果容器的末尾而不是 body 上，并且用 sticky 贴底。用 fixed 的话
 * 它会一直盖住弹窗底部那一条内容，而弹窗总共只有五百多像素高；sticky 占着
 * 版面，滚到底时自然落位，中间不会遮住任何东西。代价是它得跟着容器一起被
 * 重建，所以还要有一个 reattach。
 *
 * Esc 绑在弹窗文档上。这和页面里那一个不是同一个文档：用户在弹窗里按 Esc
 * 走的是这条，在页面上按走的是 highlight.ts 里那条，两边各管各的，不会重复
 * 触发。事件目标落在输入框上时让出去，将来弹窗若加了输入框，Esc 该由它自己
 * 处理。
 */
export function mount(container: HTMLElement): void {
  if (strip) return;
  host = container;

  strip = document.createElement('div');
  strip.id = 'prove';
  strip.className = 'prove';
  strip.hidden = true;
  host.appendChild(strip);

  // 状态条内部每次重建，所以按钮走委托，不在每次渲染时重新绑
  strip.addEventListener('click', (ev) => {
    const t = ev.target;
    if (!(t instanceof HTMLElement)) return;
    const action = t.dataset.prove;
    if (action === 'locate') locate();
    else if (action === 'clear') clear();
  });

  onEscape = (ev: KeyboardEvent) => {
    if (ev.key !== 'Escape' || activeAttr === null) return;
    const t = ev.target;
    if (
      t instanceof HTMLElement &&
      (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
    ) {
      return;
    }
    ev.preventDefault();
    clear();
  };
  document.addEventListener('keydown', onEscape, true);
}

/**
 * 把状态条重新挂回容器末尾。
 *
 * 容器的内容每次重渲染是整个替换掉的，状态条作为它的子节点会被一起换掉，
 * 手上这个引用就悬空了。重新挂一次即可，节点上的监听随节点本身还在，不需要
 * 重绑。
 */
export function reattach(): void {
  if (!strip || !host) return;
  if (strip.parentElement !== host) host.appendChild(strip);
}

/**
 * 重新提取之前把状态条收起来。
 *
 * 只收起来，不给页面发 clear。上一次描的还在页面上，而它自己带着浮层卡，
 * 卡上写着点的是哪个 token，不会变成一团无主的描边；这里顺手擦掉反而会把
 * 用户正在看的东西抹掉。同时清掉 activeAttr，因为重新采集之后元素注册表
 * 已经换了一份，再拿这个键去比对「是不是同一个 token」已经没有意义。
 */
export function reset(): void {
  activeAttr = null;
  hide();
}

/**
 * 每次重新提取之后，把这一份分析结果交给它。
 *
 * 只换上下文，不动页面上的高亮。理由和 reset 一样。
 */
export function setContext(nextTabId: number, next: ProvenanceInput): void {
  tabId = nextTabId;
  input = next;
  activeAttr = null;
  hide();
}

/**
 * 点一个 token。再点同一个就取消。
 *
 * 做成开关是因为核对本身就是来回的动作：点开看一眼、取消、再点下一个。
 * 取消必须能由同一个位置完成，否则用户得去找另一条路。
 *
 * 先判「是不是同一个」再判在途，因为点同一个 token 的意思是取消，
 * 和有没有请求在飞没有关系。
 */
export function toggle(attr: string): void {
  if (attr === activeAttr) submit({ kind: 'clear' });
  else submit({ kind: 'apply', attr });
}

/** 把第一处描过的元素滚进视口。没有高亮时不做任何事 */
export function locate(): void {
  if (activeAttr === null) return;
  submit({ kind: 'locate' });
}

/** 擦掉页面上的描边和浮层，收起状态条 */
export function clear(): void {
  submit({ kind: 'clear' });
}

// ---------------------------------------------------------------------
// 请求排队
//
// 一次点击要往页面发一趟 executeScript 才能知道结果。正常页面上这一趟只有
// 几毫秒，但重页面上可能几百毫秒，而用户在这个窗口里多半已经点了下一个。
//
// 丢掉后来的点击看着最省事，代价是「点了没反应」——而这个功能是拿来核对
// 提取结果的，一次没反应就足以让人怀疑它是不是坏了。所以不丢，改成只保留
// 最后一个意向，等这一趟回来接着做。
//
// 也必须是串行的，不能并发发出去。两趟同时在飞的话，页面那边谁先落地没有
// 保证，可能出现弹窗显示 B 而页面上描的是 A。
// ---------------------------------------------------------------------

type Intent = { kind: 'apply'; attr: string } | { kind: 'clear' } | { kind: 'locate' };

let busy = false;
let queued: Intent | null = null;

function submit(intent: Intent): void {
  if (busy) {
    queued = intent;
    return;
  }
  // send 自己会把失败折成结果返回，所以走到这里的抛出只可能是这段代码本身的
  // 错。仍然接住它，是为了不在弹窗控制台留下一个未处理的拒绝——那种日志会把
  // 真正的问题埋起来。接住之后照原样打出来，不吞
  run(intent).catch((err) => {
    console.error('[溯源] 这一趟没有跑完', err);
  });
}

/** 这一趟做完了，把期间攒下的那个意向接着做掉 */
function drain(): void {
  const next = queued;
  queued = null;
  if (next) submit(next);
}

async function run(intent: Intent): Promise<void> {
  busy = true;
  try {
    if (intent.kind === 'clear') {
      const had = activeAttr !== null;
      activeAttr = null;
      hide();
      if (had) await send({ action: 'clear' });
      return;
    }

    if (intent.kind === 'locate') {
      if (activeAttr !== null) await send({ action: 'locate' });
      return;
    }

    if (!input) return;

    const token = decodeToken(intent.attr);
    if (!token) return;

    const result = provenanceOf(token, input);
    // 解不出结果只有下标越界一种：界面上那份结果和手上这份分析结果不是同一
    // 份。这种错属于调用方，不猜一个近似结果出来
    if (!result) return;

    activeAttr = intent.attr;
    renderPending(result.title);

    const outcome = await send({
      action: 'apply',
      groups: result.groups.map((g) => ({ label: g.label, color: g.color, refs: g.refs })),
      title: result.title,
      subtitle: subtitleOf(result),
    });

    // 画失败时不要把这个 token 记成「当前高亮」，否则用户再点它会走取消
    // 分支，而页面上根本没有东西可取消，表现成「点了没反应」
    if (!outcome.ok) activeAttr = null;

    render(result, outcome);
  } finally {
    busy = false;
    drain();
  }
}
