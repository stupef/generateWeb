import type {
  BackgroundSummary,
  BoxObservation,
  ElementObservation,
  EmbeddedContentSummary,
  GradientStat,
  PageSample,
  Rgba,
  StyleElementKind,
  StyleObservation,
  TypeObservation,
} from './types';

/**
 * 采集当前页面的渲染样式观测。
 *
 * 重要约束：这个函数会被 chrome.scripting.executeScript 用 toString() 序列化后
 * 送进页面的隔离世界执行。因此它的函数体里不能引用任何模块级变量，
 * 所有常量、工具函数都必须定义在函数内部，否则注入后必然 ReferenceError。
 *
 * 这个函数只负责取数，不做任何分析和判断，也不修改页面。
 * 它不写 DOM、不注入样式、不监听事件，因此不会改变原页面的外观和功能。
 *
 * 唯一的例外是它在隔离世界的 globalThis 上留了一份元素注册表。那是
 * 溯源高亮用的：弹窗里点一个 token，要回到页面上的具体元素去描边，而
 * 两次 executeScript 之间只有隔离世界能留住东西（页面看不见这个环境，
 * 也就不受影响）。注册表里只有 Element 引用，没有动过页面本身。
 */
export function collectPageSample(): PageSample {
  const startedAt = performance.now();

  /**
   * 元素注册表的挂载键。
   *
   * 写成字面量而不是从模块里引常量，原因和这个函数不能引用外部变量
   * 是同一条。highlight.ts 里那个注入函数也写着同样一个字面量，两边
   * 必须一致；provenance-check 里有一条断言卡住这个对应关系。
   */
  const REGISTRY_KEY = '__designMdExtractorRegistry@1';

  /** 忽略旧版高亮浮层的残留节点 */
  const OVERLAY_ATTR = 'data-design-md-overlay';

  // 单页最多处理这么多元素，超出的截断并标记，避免超长页面卡死
  const MAX_ELEMENTS = 8000;

  // 不参与视觉统计的标签
  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'TEMPLATE',
    'HEAD', 'TITLE', 'BASE', 'BR', 'WBR', 'SOURCE', 'TRACK', 'PARAM',
  ]);

  // 严格意义上的可点击控件
  const CONTROL_TAGS = new Set(['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY', 'OPTION']);

  const CONTROL_ROLES = new Set([
    'button', 'link', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
    'checkbox', 'radio', 'switch', 'option', 'combobox', 'searchbox', 'textbox',
  ]);

  /**
   * 边框的四条边。
   *
   * 这里存的是连字符形式的边名，不是驼峰，因为最终要走
   * getPropertyValue 取值，而它只认 CSS 里的连字符写法。
   */
  const BORDER_SIDES = ['top', 'right', 'bottom', 'left'] as const;

  // 圆角的四个角，取最大值作为这个元素的圆角。
  // 同样必须是连字符写法，getPropertyValue('borderTopLeftRadius') 会返回空串。
  const RADIUS_CORNERS = [
    'border-top-left-radius',
    'border-top-right-radius',
    'border-bottom-right-radius',
    'border-bottom-left-radius',
  ] as const;

  // role=heading 没有配 aria-level 时，按 WAI-ARIA 规定的隐含级别算二级标题
  const DEFAULT_HEADING_LEVEL = 2;

  // 语义区块标签。区块之间的间距是布局参数里最该说清楚的一项，
  // 而只有这类标签能表达「这是一块独立的内容区」。
  const LANDMARK_TAGS = new Set([
    'HEADER', 'FOOTER', 'MAIN', 'SECTION', 'ARTICLE', 'NAV', 'ASIDE', 'FORM',
  ]);

  // role 给出的等价语义。用 div 配 role 而不是语义标签的页面同样常见
  const LANDMARK_ROLES = new Set([
    'banner', 'main', 'navigation', 'complementary', 'contentinfo', 'region',
    'article', 'form',
  ]);

  // 宽度只在这个比例以上才记。内容容器一定接近视口宽，小元素的宽度
  // 对推断内容最大宽度没有任何价值，记下来只是白占序列化带宽。
  const WIDTH_RECORD_RATIO = 0.35;

  // 组件角色判定用的语义名单。
  //
  // 输入类单独列出来，是因为它是最容易认也最需要认的一类：样式特征很集中
  // （描边加小圆角加固定的内边距），一旦认出来就能给出很确定的复刻参数。
  const INPUT_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);
  const INPUT_ROLES = new Set([
    'textbox', 'searchbox', 'combobox', 'spinbutton', 'listbox',
  ]);

  // 用 role 假装控件的写法。现代前端框架里 div 配 role=button 的按钮
  // 占比很高，只认 BUTTON 标签会漏掉一大片。
  const BUTTON_ROLES = new Set([
    'button', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
    'switch', 'checkbox', 'radio', 'option',
  ]);

  // 导航容器的判定。导航里的链接常常被样式化成按钮，正文里的链接多半
  // 只带颜色，两者必须分开，否则「按钮」这一类会被正文链接淹没。
  const NAV_ROLES = new Set(['navigation']);

  // 链接算不算「长成按钮」。判据是它有了自己的视觉外壳：背景、边框、
  // 圆角，或者像样的内边距。只有颜色的链接保持为链接。
  const LINK_AS_BUTTON_PADDING = 6;

  // 归一化的渐变类型。repeating-* 前缀会一并命中下面 substring 的判断，
  // 这是有意的，归属上属于同一族，不单独区分。
  const GRADIENT_KINDS = ['linear', 'radial', 'conic'] as const;

  // 原始值样本只留几条给人核对，留多了会挤占弹窗，也不解决任何问题
  const GRADIENT_SAMPLE_LIMIT = 3;
  const GRADIENT_SAMPLE_MAX_CHARS = 180;

  // frame 要大到这个比例才认为它承载了页面主体。小 iframe 多半是挂件，
  // 判进去会把正常页面误报成「只采到外壳」。
  const LARGE_FRAME_RATIO = 0.3;

  // 同源框架的遍历深度。绝大多数页面框架嵌套不超过两层，再深下去
  // 收益很小，而元素量会成倍增长。
  const MAX_FRAME_DEPTH = 2;

  // ------------------------------------------------------------------
  // 背景图像的累计器。
  //
  // 渐变和背景图都不进颜色通道，因为它们的可见颜色无法从声明值推导：
  // 渐变的色标位置可能整个落在元素框之外，背景图的颜色则不在样式系统里。
  // 这里只回答「有没有、有多少、什么类型」，说明文字由 core/background.ts 生成。
  // ------------------------------------------------------------------
  const gradientByKind: Record<string, { count: number; area: number }> = {
    linear: { count: 0, area: 0 },
    radial: { count: 0, area: 0 },
    conic: { count: 0, area: 0 },
  };
  let gradientElements = 0;
  let gradientArea = 0;
  let imageBackedCount = 0;
  const gradientSamples: string[] = [];

  const doc = document;

  // ------------------------------------------------------------------
  // 计算样式缓存。同一个元素只调用一次 getComputedStyle，
  // 否则向上追溯背景时会重复调用，在长页面上开销翻倍。
  // ------------------------------------------------------------------
  const styleCache = new WeakMap<Element, CSSStyleDeclaration>();

  function styleOf(el: Element): CSSStyleDeclaration {
    let s = styleCache.get(el);
    if (!s) {
      // 元素可能来自同源子框架，而 getComputedStyle 是挂在 window 上的。
      // 走元素自己文档的 view 才能保证拿到正确的计算样式，
      // 顶层窗口的引用对子框架元素不保证成立。
      const view = el.ownerDocument ? el.ownerDocument.defaultView : null;
      s = view ? view.getComputedStyle(el) : getComputedStyle(el);
      styleCache.set(el, s);
    }
    return s;
  }

  // ------------------------------------------------------------------
  // 颜色解析。计算样式在绝大多数情况下已经是 rgb()/rgba()，
  // 走正则快路径；其余格式（oklch、color-mix、具名色）用 canvas 像素回读，
  // 这样拿到的就是浏览器真正解析后的值。
  // ------------------------------------------------------------------
  const probe = doc.createElement('canvas');
  probe.width = 1;
  probe.height = 1;
  const probeCtx = probe.getContext('2d', { willReadFrequently: true });

  function parseFast(value: string): Rgba | null {
    const m = /^rgba?\(([^)]+)\)$/i.exec(value);
    if (!m) return null;
    const raw = m[1];
    if (!raw) return null;
    const parts = raw.split(',').map((s) => parseFloat(s.trim()));
    const r = parts[0];
    const g = parts[1];
    const b = parts[2];
    const a = parts[3];
    if (r === undefined || g === undefined || b === undefined) return null;
    if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return null;
    return { r, g, b, a: a === undefined || Number.isNaN(a) ? 1 : a };
  }

  function resolve(value: string | null | undefined): Rgba | null {
    if (!value) return null;
    const v = value.trim();
    if (!v || v === 'transparent' || v === 'none') return null;

    const fast = parseFast(v);
    if (fast) return fast.a <= 0 ? null : fast;

    if (!probeCtx || typeof CSS === 'undefined' || !CSS.supports('color', v)) return null;
    probeCtx.globalCompositeOperation = 'copy';
    probeCtx.clearRect(0, 0, 1, 1);
    probeCtx.fillStyle = v;
    probeCtx.fillRect(0, 0, 1, 1);
    const d = probeCtx.getImageData(0, 0, 1, 1).data;
    probeCtx.globalCompositeOperation = 'source-over';
    const dr = d[0] ?? 0;
    const dg = d[1] ?? 0;
    const db = d[2] ?? 0;
    const da = d[3] ?? 0;
    if (da === 0) return null;
    return { r: dr, g: dg, b: db, a: da / 255 };
  }

  function toHex(c: Rgba): string {
    const h = (n: number) =>
      Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
    return '#' + h(c.r) + h(c.g) + h(c.b);
  }

  /** 把 fg 合成到不透明的 bg 上，结果是视觉上真正看到的颜色 */
  function over(fg: Rgba, bg: Rgba): Rgba {
    const a = fg.a + bg.a * (1 - fg.a);
    if (a <= 0) return { r: 0, g: 0, b: 0, a: 0 };
    return {
      r: (fg.r * fg.a + bg.r * bg.a * (1 - fg.a)) / a,
      g: (fg.g * fg.a + bg.g * bg.a * (1 - fg.a)) / a,
      b: (fg.b * fg.a + bg.b * bg.a * (1 - fg.a)) / a,
      a,
    };
  }

  // ------------------------------------------------------------------
  // 页面底色兜底。如果整条祖先链都没设背景，用浏览器画布的颜色。
  // 深色配色方案下浏览器画布不是白色，这里要区分开。
  // ------------------------------------------------------------------
  const declaredScheme = styleOf(doc.documentElement).colorScheme || '';
  const prefersDark = declaredScheme.indexOf('dark') !== -1;
  const BASE: Rgba = prefersDark
    ? { r: 18, g: 18, b: 18, a: 1 }
    : { r: 255, g: 255, b: 255, a: 1 };

  interface Surface {
    /** 合成后的实际视觉背景，一定不透明 */
    solid: Rgba;
    /** 元素自己设的背景色的 alpha，0 表示它没定义表面 */
    ownAlpha: number;
  }

  const surfaceCache = new WeakMap<Element, Surface>();

  /**
   * 子文档 → 承载它的那个框架元素。
   *
   * 合成背景时，子框架里的元素沿着祖先链往上走会在 documentElement 处断掉，
   * 因为它的 parentElement 是 null。如果这时直接用顶层底色兜底，框架里
   * 半透明背景的合成基准就错了。正确做法是把承载它的框架元素本身的底色
   * 当作基准，因为框架内容默认是透明叠加在框架元素上的。
   */
  const frameOwner = new Map<Document, Element>();

  function surfaceOf(el: Element): Surface {
    const cached = surfaceCache.get(el);
    if (cached) return cached;

    const own = resolve(styleOf(el).backgroundColor);
    const ownAlpha = own ? own.a : 0;

    let result: Surface;
    if (own && own.a >= 0.999) {
      result = { solid: own, ownAlpha };
    } else {
      const parent = el.parentElement;
      let base: Rgba;
      if (parent) {
        base = surfaceOf(parent).solid;
      } else {
        // 走到文档根部了。如果这个文档属于某个子框架，基准就是那个框架元素；
        // 是顶层文档就用浏览器画布兜底。
        const owner = frameOwner.get(el.ownerDocument);
        base = owner ? surfaceOf(owner).solid : BASE;
      }
      result = { solid: own ? over(own, base) : base, ownAlpha };
    }

    surfaceCache.set(el, result);
    return result;
  }

  // ------------------------------------------------------------------
  // 结构层面的覆盖范围计数器。
  //
  // 这些跟颜色无关，但决定了这次采样的结果能不能用。顶层文档如果只是个空壳，
  // 真正的主体在 frame 或者嵌入式文档里，采集结果会呈现为「一片空白加一个白色」，
  // 用户会以为工具坏了。这里只记事实，怎么解释由 core/diagnose.ts 负责。
  // ------------------------------------------------------------------
  // 视口宽度在采集期间取一次。它既用于算框架的面积占比，也用于判断
  // 哪些元素宽到可能是内容容器。
  const viewportWidth = window.innerWidth;
  const viewportArea = viewportWidth * window.innerHeight;
  let largeFrames = 0;
  let largestFrameArea = 0;
  let pdfEmbeds = 0;
  let sameOriginFrames = 0;
  let blockedFrames = 0;
  const contentType = doc.contentType || '';

  // ------------------------------------------------------------------
  // 可读文档的收集。
  //
  // 采集不能只看顶层文档。像 IEEE 的取件页那种「外壳 + 框架」结构，
  // 顶层的 stamp.jsp 本身几乎不承载任何内容，真正的东西全在框架里，
  // 只采顶层就会得到一个孤零零的白色，看起来像工具坏了。
  //
  // 同源框架是可以正常读取的，所以这里递归进去一起采。跨域的在访问
  // contentDocument 时抛 SecurityError，捕获后计数跳过，不影响其余部分。
  // ------------------------------------------------------------------
  const docs: Document[] = [];

  function gatherDocs(win: Window, depth: number): void {
    let d: Document | null = null;
    try {
      d = win.document;
    } catch {
      return;
    }
    if (!d) return;
    // 同一个文档可能被多个引用指向，去重避免重复统计
    if (docs.indexOf(d) !== -1) return;
    docs.push(d);
    if (depth >= MAX_FRAME_DEPTH) return;

    let frames: Element[];
    try {
      frames = Array.from(d.querySelectorAll('iframe, frame'));
    } catch {
      return;
    }

    for (let i = 0; i < frames.length; i++) {
      const f = frames[i];
      if (!f) continue;

      // 尺寸为零或不可见的框架，里面的内容用户根本看不到，进去只会污染色板
      const fr = f.getBoundingClientRect();
      if (fr.width < 1 || fr.height < 1) continue;
      const fcs = styleOf(f);
      if (fcs.display === 'none' || fcs.visibility === 'hidden' || fcs.visibility === 'collapse') {
        continue;
      }
      const frameOpacity = parseFloat(fcs.opacity);
      if (!Number.isNaN(frameOpacity) && frameOpacity < 0.05) continue;

      let childWin: Window | null = null;
      try {
        childWin = (f as HTMLIFrameElement).contentWindow;
      } catch {
        childWin = null;
      }
      if (!childWin) {
        blockedFrames++;
        continue;
      }

      try {
        // 跨域时这一行会抛 SecurityError，这正是用来判定可读性的手段
        const childDoc = childWin.document;
        if (!childDoc) {
          blockedFrames++;
          continue;
        }

        // 空框架直接跳过，不计入任何一类。它的 contentDocument 是一份空的
        // about:blank，里面确实没东西可采，这不属于「被拦住」。
        //
        // 关键是不能靠 location.href 判断空不空。用 srcdoc 写入的框架、
        // 以及 JS 调 document.write 注入内容的框架，URL 同样是 about:blank，
        // 但内容是完整的，靠地址判断会把它们整片丢掉。
        let hasContent = false;
        const inner = childDoc.querySelectorAll('*');
        for (let k = 0; k < inner.length; k++) {
          const node = inner[k];
          if (!node) continue;
          const t = node.tagName;
          if (t !== 'HTML' && t !== 'HEAD' && t !== 'BODY') {
            hasContent = true;
            break;
          }
        }
        if (!hasContent) continue;

        sameOriginFrames++;
        frameOwner.set(childDoc, f);
        gatherDocs(childWin, depth + 1);
      } catch {
        blockedFrames++;
      }
    }
  }

  gatherDocs(window, 0);

  // ------------------------------------------------------------------
  // 页面自己带进来的字体族。
  //
  // document.fonts 里枚举得到的 FontFace 一定来自 @font-face 规则或
  // FontFace 构造函数，也就是页面连字体文件一起发过来的，系统预装字体
  // 不会出现在这个集合里。有了这份名单，判断「这个页面有没有用自定义字体」
  // 就不用靠字体名去猜，也不会把用户自己装过的字体误判成网页字体。
  //
  // 加载失败的条目照样收进来：字体名是真实的，只是文件没到位。这种情况
  // 下页面此刻显示的是回退字体，更该提醒使用者准备好替代方案。
  //
  // jsdom 没有实现 document.fonts，整段包起来，读不到就当作空名单，
  // 排版分析会退回到按字体名判断来源。
  // ------------------------------------------------------------------
  const webFontFamilies: string[] = [];

  try {
    const fontSet = doc.fonts;
    if (fontSet && typeof fontSet.forEach === 'function') {
      fontSet.forEach((face) => {
        const raw = face && face.family ? String(face.family) : '';
        // FontFace.family 在部分浏览器里带引号，统一去掉再比对
        const name = raw.replace(/^["']|["']$/g, '').trim();
        if (name && webFontFamilies.indexOf(name) === -1) webFontFamilies.push(name);
      });
    }
  } catch {
    // 枚举失败不影响其余采集
  }

  // ------------------------------------------------------------------
  // 排版字段的归一化。
  //
  // 计算样式里这几个属性各自都有多种写法，归一放在采集层做，
  // 分析层拿到的就是干净数字，不必在纯函数里重复处理字符串分支。
  // ------------------------------------------------------------------

  /**
   * 字重归一。计算样式在主流浏览器里直接给数字字符串，但 normal / bold
   * 这两个关键字仍然可能出现，统一折算成数字，免得下游同时处理三种写法。
   */
  function weightOf(value: string): number {
    if (value === 'normal') return 400;
    if (value === 'bold') return 700;
    const n = parseFloat(value);
    return Number.isNaN(n) ? 400 : n;
  }

  /**
   * px 长度归一。normal 和解析不出来的值一律返回 null。
   *
   * 这里刻意不给 normal 补一个默认数字。行高的 normal 对应多少倍
   * 取决于字体自身的度量，由浏览器按字体算，凭空写一个 1.2 出去
   * 会让生成的文件记下一个页面里根本不存在的值。
   */
  function lengthOf(value: string): number | null {
    if (!value || value === 'normal') return null;
    const n = parseFloat(value);
    return Number.isNaN(n) ? null : n;
  }

  /**
   * 标题级别的判定。标签语义优先，h1-h6 直接给出级别；
   * 不是标题标签时再看 ARIA，role=heading 配 aria-level 等同于对应级别，
   * 没写 aria-level 的按规范隐含的二级算。
   */
  function headingLevelOf(tagName: string, role: string | null): number {
    const m = /^H([1-6])$/.exec(tagName);
    if (m) {
      const n = parseInt(m[1] ?? '', 10);
      if (!Number.isNaN(n)) return n;
    }
    if (role && role.toLowerCase() === 'heading') return DEFAULT_HEADING_LEVEL;
    return 0;
  }

  // ------------------------------------------------------------------
  // 间距字段的解析。
  //
  // 和排版一样，字符串归一放在采集层做，分析层拿到的就是干净数字。
  // ------------------------------------------------------------------

  /**
   * 间距值归一，保留一位小数。
   *
   * 设计系统里的间距几乎全是整数，少数 rem 折算出来的值（0.875rem = 14px）
   * 也在一位小数以内。留更多位精度只会让同一个档位在聚合前裂成两条。
   */
  function round1(n: number): number {
    if (!Number.isFinite(n)) return 0;
    return Math.round(n * 10) / 10;
  }

  /** px 长度解析。auto、normal 这类关键字解析不出数字，一律当 0 */
  function pxOf(value: string): number {
    if (!value) return 0;
    const n = parseFloat(value);
    return Number.isNaN(n) ? 0 : round1(n);
  }

  /**
   * max-width 解析。
   *
   * 只有 px 结尾的计算值才代表一个确定的最大宽度。none 是不限制，
   * 百分比写法（max-width: 100%）要等布局完成才知道是多少，这里读到的
   * 是「100%」这个字符串本身，硬解析只会得到一个假的 100，必须挡掉。
   */
  function maxWidthOf(value: string): number | null {
    if (!value || value === 'none') return null;
    if (value.indexOf('px') === -1) return null;
    const n = parseFloat(value);
    return Number.isNaN(n) || n <= 0 ? null : round1(n);
  }

  /**
   * 圆角取四角最大值。
   *
   * 含 % 的值直接跳过。百分比写法（border-radius: 50%）解析出来的 50
   * 是「50%」而不是 50px，当成半径会得出一个荒唐的数字。
   */
  function radiusOf(cs: CSSStyleDeclaration): number {
    let max = 0;
    for (let i = 0; i < RADIUS_CORNERS.length; i++) {
      const name = RADIUS_CORNERS[i];
      if (!name) continue;
      const v = cs.getPropertyValue(name);
      if (!v || v.indexOf('%') !== -1) continue;
      const n = parseFloat(v);
      if (!Number.isNaN(n) && n > max) max = n;
    }
    return round1(max);
  }

  /**
   * 投影的原样读取。
   *
   * 这里不做任何归一，只把「没有投影」这一个状态挡成 null。原因是一条
   * 声明和它的计算值之间可能有空白、数值写法、颜色格式三处差异，
   * 归一化的规则需要靠单测反复校准，放在纯函数里做才靠谱；采集层只负责
   * 把原始串带出来。
   *
   * 一个元素可以有多层投影（用逗号分隔），原样保留整串，不拆开。
   */
  function shadowOf(value: string): string | null {
    if (!value) return null;
    const v = value.trim();
    if (!v || v === 'none') return null;
    return v;
  }

  /**
   * 元素在页面上扮演什么角色。
   *
   * 判定顺序是按「具体程度」排的，先判最好认的那一类，命中即止。
   * 输入框在标签和 role 上都最明确，放最前面；导航容器排在卡片前面，
   * 因为一条带背景的导航栏同时满足两者的判据，而它作为导航的价值
   * 远大于作为一个普通卡片。
   *
   * 返回 null 表示这个元素不构成组件，不进 styles 通道。
   */
  function kindOf(
    tagName: string,
    role: string | null,
    hasOwnSurface: boolean,
    borderW: number,
    padSum: number,
    radius: number,
    looksLikeCard: boolean,
    hasShadow: boolean,
  ): StyleElementKind | null {
    if (INPUT_TAGS.has(tagName)) return 'input';
    if (role !== null && INPUT_ROLES.has(role)) return 'input';
    if (role !== null && BUTTON_ROLES.has(role)) return 'button';
    if (tagName === 'BUTTON') return 'button';
    if (tagName === 'NAV' || (role !== null && NAV_ROLES.has(role))) return 'nav';
    if (tagName === 'A') {
      const styled = hasOwnSurface || borderW > 0 || radius > 0 || padSum >= LINK_AS_BUTTON_PADDING;
      return styled ? 'button' : null;
    }
    if (looksLikeCard) return 'card';
    // 带边框或投影的其余元素。分割线、表格、下拉浮层都落在这里，
    // 它们不是组件，但边框和投影的取值必须能统计到。
    if (borderW > 0 || hasShadow) return 'other';
    return null;
  }

  // 把各个可读文档的元素摊平成一个数组，主循环保持单层。
  // 元素额度是全局的，先到先得，超出部分截断并置位。
  const allElements: Element[] = [];
  let truncated = false;

  for (let di = 0; di < docs.length; di++) {
    const d = docs[di];
    if (!d) continue;
    let nodes: Element[];
    try {
      nodes = Array.from(d.querySelectorAll('*'));
    } catch {
      continue;
    }
    for (let i = 0; i < nodes.length; i++) {
      if (allElements.length >= MAX_ELEMENTS) {
        truncated = true;
        break;
      }
      const n = nodes[i];
      if (n) allElements.push(n);
    }
    if (truncated) break;
  }

  // ------------------------------------------------------------------
  // 主遍历
  // ------------------------------------------------------------------
  const elements: ElementObservation[] = [];
  const typography: TypeObservation[] = [];
  const boxes: BoxObservation[] = [];
  const styles: StyleObservation[] = [];
  let skipped = 0;
  let visited = 0;
  let textCharsTotal = 0;

  /**
   * 注册表。按采集顺序攒下元素引用，观测数据里只带下标。
   *
   * 每次采集都从空数组重新来过，所以下标永远是相对最近这一次采集的，
   * 不存在跨次累积导致错位的问题。
   */
  const registry: Element[] = [];

  for (let i = 0; i < allElements.length; i++) {
    const el = allElements[i];
    if (!el) continue;

    // 自己注入的浮层不算页面内容，也不该计入遍历数
    if (el.hasAttribute(OVERLAY_ATTR)) continue;

    visited++;
    const tag = el.tagName;

    if (SKIP_TAGS.has(tag)) {
      skipped++;
      continue;
    }

    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) {
      skipped++;
      continue;
    }

    const cs = styleOf(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') {
      skipped++;
      continue;
    }
    const opacity = parseFloat(cs.opacity);
    if (!Number.isNaN(opacity) && opacity < 0.05) {
      skipped++;
      continue;
    }

    // 折叠的 <details> 内容，以及 content-visibility: hidden 的子树，
    // 在 Chrome 里仍然会被排版。它们的 getBoundingClientRect 返回的是
    // 真实尺寸，display / visibility / opacity 也全是正常值，上面几条
    // 一条都拦不住，只有 checkVisibility() 认得出它不可见。
    //
    // 这一步漏掉的代价实测过：验收页把预期结果写在折叠区里，那几段小字
    // 被算进了字号统计，正文字号从 16px 被拽到 12px，整条层级跟着错位。
    // 真实页面上同样的形态是折叠面板、抽屉、未展开的菜单，里面往往是
    // 大段说明文字，污染面比这一处大得多。
    const canCheckVisibility = (
      el as unknown as { checkVisibility?: () => boolean }
    ).checkVisibility;
    if (typeof canCheckVisibility === 'function') {
      let visible = true;
      try {
        visible = canCheckVisibility.call(el) !== false;
      } catch {
        // 取值失败时按可见处理，宁可多采一点也不要整页采空
        visible = true;
      }
      if (!visible) {
        skipped++;
        continue;
      }
    }

    // 到这里这个元素就确定要记了。先领一个编号，下面四条通道共用它，
    // 这样「用了这个字号的那个元素」和「用了这个背景色的那个元素」
    // 才是同一个下标，可以互相对照。
    const ref = registry.length;
    registry.push(el);

    // 结构统计。必须放在可见性检查之后，只算用户真正看得见的框架。
    // display:none 的 iframe 在真实浏览器里尺寸就是 0，会被上面挡掉，
    // 但 visibility:hidden 的元素尺寸仍然在，漏过去就会被算成
    // 「页面主体在其中」，让正常页面平白多出一条误导性的提示。
    const boxArea = rect.width * rect.height;
    if (tag === 'FRAME' || tag === 'IFRAME') {
      if (viewportArea > 0 && boxArea >= viewportArea * LARGE_FRAME_RATIO) {
        largeFrames++;
        if (boxArea > largestFrameArea) largestFrameArea = boxArea;
      }
    } else if (tag === 'EMBED' || tag === 'OBJECT') {
      const embedType = (el.getAttribute('type') || '').toLowerCase();
      const embedSrc = (
        el.getAttribute('data') ||
        el.getAttribute('src') ||
        ''
      ).toLowerCase();
      if (embedType.indexOf('pdf') !== -1 || embedSrc.indexOf('.pdf') !== -1) {
        pdfEmbeds++;
      }
    }

    // 背景图像检测。一个 background-image 值里可能有多个图层，
    // 也可能混着 url()，所以整串扫描而不是只看开头。
    // 无背景图时计算样式返回 'none'，直接跳过。
    const bgImage = cs.backgroundImage;
    if (bgImage && bgImage !== 'none') {
      const lower = bgImage.toLowerCase();
      let matchedKinds = 0;
      for (let k = 0; k < GRADIENT_KINDS.length; k++) {
        const kind = GRADIENT_KINDS[k];
        if (kind === undefined || lower.indexOf(kind + '-gradient(') === -1) continue;
        const bucket = gradientByKind[kind];
        if (!bucket) continue;
        bucket.count++;
        bucket.area += rect.width * rect.height;
        matchedKinds++;
      }

      if (matchedKinds > 0) {
        gradientElements++;
        gradientArea += rect.width * rect.height;
        if (gradientSamples.length < GRADIENT_SAMPLE_LIMIT) {
          gradientSamples.push(bgImage.slice(0, GRADIENT_SAMPLE_MAX_CHARS));
        }
      } else if (lower.indexOf('url(') !== -1) {
        imageBackedCount++;
      }
    }

    // 只统计元素直接承载的文字。如果算上子孙的文字，
    // 所有容器都会变成「文字元素」，主要文字色会被容器稀释掉。
    let textChars = 0;
    for (let n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3 && n.textContent) {
        textChars += n.textContent.trim().length;
      }
    }

    const surface = surfaceOf(el);

    const textRgba = textChars > 0 ? resolve(cs.color) : null;
    const textColor = textRgba ? toHex(over(textRgba, surface.solid)) : null;

    const backgroundColor = surface.ownAlpha > 0 ? toHex(surface.solid) : null;

    let borderWidth = 0;
    let borderRgba: Rgba | null = null;
    let maxBorderWidth = 0;
    let borderSides = 0;
    let borderStyle = '';
    for (let s = 0; s < BORDER_SIDES.length; s++) {
      const side = BORDER_SIDES[s];
      const w = parseFloat(cs.getPropertyValue('border-' + side + '-width'));
      const st = cs.getPropertyValue('border-' + side + '-style');
      if (w > 0 && st && st !== 'none' && st !== 'hidden') {
        borderWidth += w;
        borderSides++;
        if (w > maxBorderWidth) maxBorderWidth = round1(w);
        if (!borderStyle) borderStyle = st;
        if (!borderRgba) {
          borderRgba = resolve(cs.getPropertyValue('border-' + side + '-color'));
        }
      }
    }
    const borderColor = borderRgba ? toHex(over(borderRgba, surface.solid)) : null;

    const roleAttr = el.getAttribute('role');
    const isControl =
      CONTROL_TAGS.has(tag) ||
      (!!roleAttr && CONTROL_ROLES.has(roleAttr.toLowerCase()));

    const fontSize = parseFloat(cs.fontSize);

    textCharsTotal += textChars;

    // ------------------------------------------------------------------
    // 组件样式。
    //
    // 这一段的取值顺序是刻意的：先算出判断「是不是组件」需要的量，
    // 再判角色，最后才决定要不要记。判角色要用到背景、边框、内边距、
    // 圆角四样，少一样就会把「只有描边的次按钮」或「只有填充的主按钮」
    // 判错方向。
    // ------------------------------------------------------------------
    const padT = pxOf(cs.paddingTop);
    const padR = pxOf(cs.paddingRight);
    const padB = pxOf(cs.paddingBottom);
    const padL = pxOf(cs.paddingLeft);
    const radiusAll = radiusOf(cs);
    const hasOwnSurface = surface.ownAlpha > 0;
    const shadow = shadowOf(cs.boxShadow);
    const looksLikeCard =
      hasOwnSurface || maxBorderWidth > 0 || radiusAll > 0;

    // 导航容器本身的 closest 会命中它自己，这是对的：它在导航里，
    // 只是我们只在区分链接时才用这个标记。
    let inNav = false;
    try {
      inNav = el.closest('nav, [role="navigation"]') !== null;
    } catch {
      inNav = false;
    }

    const kind = kindOf(
      tag,
      roleAttr ? roleAttr.toLowerCase() : null,
      hasOwnSurface,
      maxBorderWidth,
      padT + padR + padB + padL,
      radiusAll,
      looksLikeCard,
      shadow !== null,
    );

    if (kind !== null) {
      // 撑满父容器的判断。要去掉父元素的左右内边距再比，否则一个左右
      // 各留 48px 内边距的内容区里，真正的整宽区块会被判成没撑满，
      // 进而被当成卡片。
      let fillsParent = false;
      const parentEl = el.parentElement;
      if (parentEl) {
        const parentRect = parentEl.getBoundingClientRect();
        const parentStyle = styleOf(parentEl);
        const contentWidth =
          parentRect.width - pxOf(parentStyle.paddingLeft) - pxOf(parentStyle.paddingRight);
        fillsParent = contentWidth > 0 && rect.width >= contentWidth - 1;
      }

      // 这一条不按 textChars 判断有没有文字色。计算样式的 color 是继承来的，
      // 一个自己不带文字、只装内容的卡片读到的仍然是它内部文字的最终颜色，
      // 正是复刻卡片时需要的那个值。按 textChars 判断的话卡片会拿不到文字色。
      const inheritedRgba = resolve(cs.color);
      const inheritedTextColor = inheritedRgba ? toHex(over(inheritedRgba, surface.solid)) : null;

      styles.push({
        ref,
        tag,
        kind,
        inNav,
        textChars,
        childCount: el.children.length,
        fillsParent,
        backgroundColor,
        textColor: inheritedTextColor,
        padding: [padT, padR, padB, padL],
        radius: radiusAll,
        borderWidth: maxBorderWidth,
        borderSides,
        borderStyle,
        borderColor,
        shadow,
        width: round1(rect.width),
        height: round1(rect.height),
        fontSize: Number.isNaN(fontSize) ? 0 : fontSize,
        fontWeight: weightOf(cs.fontWeight),
        fontFamily: cs.fontFamily,
      });
    }

    // 排版观测只取直接承载文字的元素。没有文字就无所谓字体和层级，
    // 收进来只会让字号统计被空容器稀释掉。
    if (textChars > 0) {
      typography.push({
        ref,
        tag,
        headingLevel: headingLevelOf(tag, roleAttr),
        fontFamily: cs.fontFamily,
        fontWeight: weightOf(cs.fontWeight),
        fontSize: Number.isNaN(fontSize) ? 0 : fontSize,
        lineHeight: lengthOf(cs.lineHeight),
        letterSpacing: lengthOf(cs.letterSpacing),
        textChars,
        isControl,
      });
    }

    elements.push({
      ref,
      tag,
      textChars,
      fontSize: Number.isNaN(fontSize) ? 0 : fontSize,
      area: Math.round(rect.width * rect.height),
      isControl,
      definesSurface: surface.ownAlpha > 0,
      textColor,
      backgroundColor,
      borderColor,
      borderWidth,
    });

    // ------------------------------------------------------------------
    // 盒模型间距。
    //
    // 纯 inline 元素没有完整的盒模型：水平方向的 padding 虽然生效，
    // 上下方向读到的值却对版面毫无影响，采进来会污染间距体系。
    // display: contents 的元素干脆不生成盒子，同理跳过。
    // ------------------------------------------------------------------
    if (cs.display !== 'inline' && cs.display !== 'contents') {
      const marT = pxOf(cs.marginTop);
      const marR = pxOf(cs.marginRight);
      const marB = pxOf(cs.marginBottom);
      const marL = pxOf(cs.marginLeft);

      let layout: BoxObservation['layout'] = 'block';
      if (cs.display.indexOf('flex') !== -1) layout = 'flex';
      else if (cs.display.indexOf('grid') !== -1) layout = 'grid';

      let gap: number | null = null;
      if (layout !== 'block') {
        const rowGap = pxOf(cs.rowGap);
        const columnGap = pxOf(cs.columnGap);
        // 两者都非零时取 row-gap。垂直方向的节奏更能代表区块之间的间隔，
        // 水平方向常常只是控件之间的紧密排列。只有水平方向有值时用它。
        const picked = rowGap > 0 ? rowGap : columnGap;
        if (picked > 0) gap = picked;
      }

      const maxWidth = maxWidthOf(cs.maxWidth);
      const wide = rect.width >= viewportWidth * WIDTH_RECORD_RATIO;

      const hasSpacing =
        padT > 0 || padR > 0 || padB > 0 || padL > 0 ||
        marT !== 0 || marR !== 0 || marB !== 0 || marL !== 0 ||
        gap !== null || radiusAll > 0;

      // 没有间距特征、又不够宽的元素（满屏 div 里的绝大多数）直接跳过。
      // 除了宽到可能是内容容器的那几个，其余记下来对分析没有任何帮助。
      if (hasSpacing || wide) {
        boxes.push({
          ref,
          tag,
          padding: [padT, padR, padB, padL],
          margin: [marT, marR, marB, marL],
          gap,
          radius: radiusAll,
          width: wide ? round1(rect.width) : 0,
          maxWidth,
          looksLikeCard,
          isControl,
          isLandmark:
            LANDMARK_TAGS.has(tag) ||
            (!!roleAttr && LANDMARK_ROLES.has(roleAttr.toLowerCase())),
          layout,
        });
      }
    }
  }

  const bodyEl = doc.body || doc.documentElement;

  // 把注册表挂到隔离世界上，供后续的溯源高亮使用。放在最后统一挂，
  // 中途任何一步抛错都不会留下一份半截的注册表。
  (globalThis as unknown as Record<string, unknown>)[REGISTRY_KEY] = registry;

  const gradientKinds: GradientStat[] = [];
  for (let k = 0; k < GRADIENT_KINDS.length; k++) {
    const kind = GRADIENT_KINDS[k];
    if (kind === undefined) continue;
    const bucket = gradientByKind[kind];
    if (!bucket || bucket.count === 0) continue;
    gradientKinds.push({ kind, count: bucket.count, area: Math.round(bucket.area) });
  }
  gradientKinds.sort((x, y) => y.count - x.count);

  const background: BackgroundSummary = {
    gradient: {
      elementCount: gradientElements,
      viewportAreaRatio:
        viewportArea > 0 ? Math.round((gradientArea / viewportArea) * 100) / 100 : 0,
      kinds: gradientKinds,
      samples: gradientSamples,
    },
    imageBackedCount,
  };

  const embedded: EmbeddedContentSummary = {
    contentType,
    pdfEmbeds,
    largeFrames,
    largestFrameRatio:
      viewportArea > 0 ? Math.round((largestFrameArea / viewportArea) * 100) / 100 : 0,
    // frameset 文档没有 body，顶层自身一个内容都不承载
    framesetDocument: doc.body === null && !!doc.querySelector('frameset'),
    sameOriginFrames,
    blockedFrames,
  };

  return {
    url: doc.location.href,
    title: doc.title,
    viewportWidth,
    viewportHeight: window.innerHeight,
    canvasColor: toHex(surfaceOf(bodyEl).solid),
    prefersDark,
    elements,
    typography,
    boxes,
    styles,
    webFontFamilies,
    background,
    embedded,
    textCharsTotal,
    skipped,
    visited,
    truncated,
    elapsedMs: Math.round(performance.now() - startedAt),
  };
}
