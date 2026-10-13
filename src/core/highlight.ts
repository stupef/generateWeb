/**
 * 溯源高亮。把界面上看到的某个 token，画回页面上真正用了它的那些元素。
 *
 * 这个模块只负责「画」和「擦」。谁该被画，由 core/provenance.ts 算出来，
 * 因为那个判断要复用各分析模块的判据，属于分析层的事。
 *
 * 重要约束和 collector.ts 一样：highlightElements 会被
 * chrome.scripting.executeScript 用 toString() 序列化后送进页面的隔离世界，
 * 所以它的函数体里不能引用任何模块级变量。常量一律内联。
 *
 * ── 怎么做到「取消后页面恢复原样」 ──
 *
 * 只动三个属性，outline、outline-offset、box-shadow，都是纯绘制、不参与
 * 布局的，所以高亮前后元素的位置尺寸完全一样，页面不会抖。
 *
 * 恢复走的是整串备份，不是逐属性备份。画之前把元素的 style 属性整串存下来，
 * 擦的时候整个写回去，原本没有 style 属性的就删掉这个属性。这样恢复是字符串
 * 级等价的。之所以不逐属性存，是因为读回单属性时拿到的值已经过了浏览器的
 * 序列化规范化，未必还长得像写进去时的样子（box-shadow 的颜色位置就会变），
 * 而 style 属性本身是原样保留的字符串。代价是高亮期间页面若自己改了这个
 * 元素的内联样式，还原时会一并抹掉，而高亮是用户主动触发的短时动作。
 *
 * ── 写内联样式为什么走 setAttribute，不走 el.style ──
 *
 * 写 el.style 之后，那份声明不会立刻成为元素上真实的 style 属性，浏览器要等
 * 下一次读它才提交上去。这中间调 removeAttribute('style') 只会把声明里的属性
 * 清空，属性本身留在元素上变成一个空的 style=""。计算样式一模一样，界面和肉眼
 * 都看不出，但 DOM 已经不是原样了。
 *
 * 这不是偶发。一次画几十个元素时必定出现，而单独一个元素走同样几步反而干净，
 * 所以只有逐元素对账才打得出来：chrome 里跑 scripts/highlight-shot.mjs 就会看到
 * 「57 个元素不一致」。改走 setAttribute 写入，属性从头就是真实的，还原时
 * removeAttribute 一定摘得掉；备份与还原也就成了同一件事的两面，存属性串、
 * 写回属性串，中间不经过任何带惰性提交的对象。
 *
 * 顺带补掉另一个缺口：el.style 只存在于 HTMLElement 和 SVGElement 上，而采集走
 * querySelectorAll('*')，会带上别的命名空间的元素，那些元素原来会被当成「画不了」
 * 跳过。属性写入对所有 Element 都成立。
 *
 * 不碰 style 属性之外的任何东西，页面自己的 class、事件监听一律不动。
 * 不往页面里增加任何节点，也不覆盖页面内容。
 *
 * ── 为什么只描边加光晕，不给元素补底色 ──
 *
 * 补一层半透明的同色底看着更醒目，但会改掉元素自己的背景色，而这个功能存在的
 * 意义就是让用户核对颜色。改被核对的对象，等于把结论污染掉，所以不做。光晕画在
 * 元素外面，元素自身的背景、文字、边框一处不沾。唯一的外溢是光晕会压住相邻元素
 * 边缘三像素，半透明，且只在高亮期间存在。
 */
import type { HighlightCommand, HighlightResult } from './types';

/** 元素注册表的挂载键。必须与 collector.ts 里那个字面量一致 */
export const HIGHLIGHT_REGISTRY_KEY = '__designMdExtractorRegistry@1';

/** 高亮痕迹的挂载键。只有这个模块用它 */
export const HIGHLIGHT_PAINT_KEY = '__designMdExtractorPaint@1';

/** 描边宽度与内缩。两个数都不参与布局，改它们不会让页面位移 */
export const HIGHLIGHT_OUTLINE = '2px solid';
export const HIGHLIGHT_OUTLINE_OFFSET = '1px';

/**
 * 光晕。贴在描边外再向外扩一圈同色的半透明环，用 box-shadow 实现。
 *
 * 加这一圈是因为两像素的实线在深色页面和彩色背景上偏弱，也容易和元素自带的
 * 彩色边框贴在一起分不清。box-shadow 和 outline 一样是纯绘制属性。
 *
 * 半径取 6px 而不是 3px，是算出来的。box-shadow 从元素边界往外扩，描边占的是
 * 1px 到 3px 那一段，所以外扩半径必须越过 3px 才露得出来：6px 的外扩里，真正
 * 看得见的光晕是 3px 到 6px 那 3px。设成 3px 的话光晕整个躲在描边底下，
 * 等于没加。改描边宽度或内缩时，这个数要跟着重算。
 *
 * 透明度取 30%。再低在深色底上看不见，再高就会明显压住相邻元素——光晕是唯一
 * 溢出到元素外面的东西，这一层要克制。
 */
export const HIGHLIGHT_GLOW_SPREAD = '6px';
export const HIGHLIGHT_GLOW_ALPHA = '4d';

/**
 * 各渠道高亮的颜色。
 *
 * 刻意用三个差别明显的色相而不是同一色。一个颜色角色往往同时在背景、
 * 文字、边框三处出现，同色的话画上去是一片，看不出「这 12 个是拿它当
 * 背景的、那 8 个是拿它当文字色的」，而分清渠道正是核对时最想知道的事。
 * 这三个值在浅色和深色页面上都能看清，也都与被核对的设计本身无关。
 */
export const HIGHLIGHT_COLORS = {
  background: '#3d5afe',
  text: '#e0730d',
  border: '#8b5cf6',
  neutral: '#3d5afe',
} as const;

export function highlightElements(cmd: HighlightCommand): HighlightResult {
  /** 注入后模块作用域不存在，挂载键必须在函数体内写成字面量 */
  const REGISTRY_KEY = '__designMdExtractorRegistry@1';
  const PAINT_KEY = '__designMdExtractorPaint@1';

  // 移除旧版本遗留的说明卡；新版本不再向页面添加任何浮层
  const legacyOverlays = document.querySelectorAll('[data-design-md-overlay]');
  for (let i = 0; i < legacyOverlays.length; i++) legacyOverlays[i]?.remove();

  interface PaintedItem {
    el: Element;
    /**
     * 这个元素原本的 style 属性整串，没设过就是 null。
     *
     * 存整串而不是逐个属性，是因为读回单属性时拿到的值已经过浏览器的序列化
     * 规范化，写回去未必和原来长得一样。属性层面这一串是原样的，写回去就是原样。
     */
    styleAttr: string | null;
  }

  interface PaintState {
    doc: Document;
    items: PaintedItem[];
    host: Element | null;
    onKeyDown: ((ev: KeyboardEvent) => void) | null;
  }

  const store = globalThis as unknown as Record<string, unknown>;

  function failed(stale: boolean, reason: string): HighlightResult {
    return { ok: false, highlighted: 0, missing: 0, stale, reason };
  }

  /**
   * 从一串内联样式里取出现有的 box-shadow。
   *
   * 用一个脱离文档的元素来解析，不拿正则去拆 CSS 文本。url() 里面可以有分号，
   * 正则拆必然在某些值上拆错，而错法只是偶尔少拼一层投影，看不出来。
   * 探针元素不挂进文档，取完就丢，对页面没有任何影响。
   */
  function inlineShadowOf(cssText: string | null): string | null {
    if (!cssText) return null;
    const probe = doc.createElement('div');
    probe.setAttribute('style', cssText);
    const v = probe.style ? probe.style.getPropertyValue('box-shadow') : '';
    return v !== '' && v !== 'none' ? v : null;
  }

  /**
   * 把高亮那几条声明拼到元素原有的内联样式后面，返回整个 style 属性值。
   *
   * 拼在后面的原因同层叠：同一个属性写两次时后者胜，加上 !important 就压得住
   * 页面自己写的同名规则。内联 important 在层叠里高于任何选择器。
   *
   * 原有的 box-shadow 要并入我们这一条，不能各写一条——我们这条是 important，
   * 元素自己那条不是，两条并存时它会被整条丢掉，投影在高亮期间就没了。所以
   * 把它拼在光晕后面，共用一条声明。页面用类写的投影这里读不到（内联样式里
   * 只有内联那一份），那种情况下它的投影会在高亮期间暂时消失，随 style 整串
   * 一起回来的那一刻也就回来了。
   */
  function mergeInline(original: string | null, color: string): string {
    const parts: string[] = [];
    // 这几条只能内联，注入之后模块作用域不存在。provenance-check 里有断言
    // 卡住它们和导出出去的那几个常量写法一致
    parts.push('outline: 2px solid ' + color + ' !important');
    parts.push('outline-offset: 1px !important');

    const glow = withAlpha(color, '4d');
    if (glow) {
      const ring = '0 0 0 6px ' + glow;
      const prior = inlineShadowOf(original);
      parts.push('box-shadow: ' + (prior === null ? ring : ring + ', ' + prior) + ' !important');
    }

    const base = original === null ? '' : original.replace(/;\s*$/, '');
    return base === '' ? parts.join('; ') : base + '; ' + parts.join('; ');
  }

  /**
   * 给六位十六进制色补上透明度，变成八位形式。
   *
   * 光晕要用描边同一个色相的半透明版本。认不出的输入返回 null，调用方直接
   * 放弃光晕。宁可少画一圈，也不要写进一个浏览器解析不了的属性值——那种写法
   * setProperty 不报错，只是静默失效，排查起来很难。
   */
  function withAlpha(hex: string, alpha: string): string | null {
    return /^#[0-9a-fA-F]{6}$/.test(hex) ? hex + alpha : null;
  }

  /** 把上一次动过的元素还原。走 style 属性整串，写不回去的就当它本来没有 */
  function unpaint(state: PaintState): void {
    for (let i = 0; i < state.items.length; i++) {
      const it = state.items[i];
      if (!it) continue;
      if (it.styleAttr === null) it.el.removeAttribute('style');
      else it.el.setAttribute('style', it.styleAttr);
    }
    state.items.length = 0;
  }

  /** 还原描边、清理旧版浮层、解绑按键，把状态整个清空 */
  function teardown(state: PaintState): void {
    unpaint(state);
    if (state.onKeyDown) {
      state.doc.removeEventListener('keydown', state.onKeyDown, true);
      state.onKeyDown = null;
    }
    if (state.host) {
      state.host.remove();
      state.host = null;
    }
    store[PAINT_KEY] = null;
  }

  const previous = (store[PAINT_KEY] ?? null) as PaintState | null;

  /**
   * 把第一处已描边的元素滚进视口。
   *
   * 滚动是唯一的对外副作用，所以只在用户明确点了定位时才做。用 smooth
   * 而不是瞬时跳，页面上还有几十个描边框同时移动时，瞬跳会让人失去方位感。
   */
  function scrollToFirst(state: PaintState): boolean {
    const first = state.items[0];
    if (!first) return false;
    const target = first.el as unknown as { scrollIntoView?: (opts?: unknown) => void };
    if (typeof target.scrollIntoView !== 'function') return false;
    target.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
    return true;
  }

  if (cmd.action === 'clear') {
    if (previous) teardown(previous);
    return { ok: true, highlighted: 0, missing: 0, stale: false, reason: '' };
  }

  if (cmd.action === 'locate') {
    if (!previous || previous.items.length === 0) {
      return failed(false, '当前没有高亮的元素，先点一个 token。');
    }
    const moved = scrollToFirst(previous);
    return {
      ok: moved,
      highlighted: previous.items.length,
      missing: 0,
      stale: false,
      reason: moved ? '' : '第一个元素在当前页面上定位不到。',
    };
  }

  const registry = store[REGISTRY_KEY];
  if (!Array.isArray(registry)) {
    // 隔离世界是随文档一起重建的，读不到注册表就说明页面已经不是当初
    // 采集的那一份了。这时候画出来的位置全是错的，直接说清楚更好
    if (previous) teardown(previous);
    return failed(true, '这个页面已经刷新或跳转过，重新提取一次再点高亮。');
  }

  if (previous) teardown(previous);

  const doc = document;
  const groups = Array.isArray(cmd.groups) ? cmd.groups : [];

  const items: PaintedItem[] = [];
  const seen = new Set<Element>();
  let missing = 0;

  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi];
    if (!g) continue;
    const refs = Array.isArray(g.refs) ? g.refs : [];
    for (let ri = 0; ri < refs.length; ri++) {
      const ref = refs[ri];
      const el = typeof ref === 'number' ? (registry[ref] as Element | undefined) : undefined;
      if (!el || el.isConnected !== true) {
        missing++;
        continue;
      }
      // 同一个元素可能同时命中两条渠道（比如它的背景色和边框色是同一个值），
      // 画两次的话第二次会把第一次存下来的「原值」覆盖成描边本身，擦不干净
      if (seen.has(el)) continue;

      /**
       * 备份取的是 style 属性整串，没设过就是 null。
       *
       * 后面写入也走 setAttribute，两种写法都不碰 el.style，所以这里没有
       * 「先读属性还是先碰 .style」的顺序问题。这一点是修出来的：早先写的是
       * el.style.setProperty，读 .style 会让浏览器给元素补上一个空的 style
       * 属性，备份因此从 null 变成 ''，清除时按 '' 写回去就留下一个空属性。
       * 模块头里那段有完整说明。
       */
      const styleAttr = el.getAttribute('style');

      seen.add(el);
      items.push({ el, styleAttr });

      // 单个元素写不上样式不该拖垮整次高亮，单独兜一层。这个元素已经记进
      // items 了，清除时照常还原，所以这里跳过就行
      try {
        el.setAttribute('style', mergeInline(styleAttr, g.color));
      } catch (err) {
        missing++;
      }
    }
  }

  const state: PaintState = { doc, items, host: null, onKeyDown: null };

  state.onKeyDown = (ev: KeyboardEvent) => {
    if (ev.key !== 'Escape') return;
    // 拦下来不再往下传。用户按 Esc 的意图是关掉这个高亮，
    // 而这个键在页面上常常另有用途（关弹窗、退全屏），两边同时响应会很乱
    ev.stopPropagation();
    ev.preventDefault();
    teardown(state);
  };
  doc.addEventListener('keydown', state.onKeyDown, true);

  store[PAINT_KEY] = state;

  return { ok: true, highlighted: items.length, missing, stale: false, reason: '' };
}
