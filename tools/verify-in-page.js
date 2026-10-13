/**
 * 页面自检脚本 —— 手动核对提取结果用，不参与自动化检查链。
 *
 * 用法
 *   1. 打开要验的网页
 *   2. F12 打开控制台，第一次粘贴时 Chrome 会要求先手打一遍 "allow pasting"
 *   3. 把本文件整段复制粘贴进去，回车
 *
 * 它和扩展的关系
 *   取样范围刻意写得和扩展一致（同样的跳过规则、同样只统计元素直接承载的
 *   文字），这样两边读的是同一批元素。但读取方式是自己重写的一遍，没有复用
 *   扩展里的任何函数。所以如果两边的结论对不上，问题就落在「分析」上，而
 *   不是「取样范围不同」这种解释得通的差别上。
 *
 *   字体栈、OKLab 聚类、置信度、组件识别这些扩展特有的推理，这里不做。
 *   这个脚本只回答「页面上的原始事实是什么」，让你拿事实去对结论。
 *
 * 已知对不上的地方（正常，不是 bug）
 *   - 半透明颜色。扩展会把文字色、边框色按底色合成成不透明色再报出来，
 *     合成逻辑这里也实现了一遍，但遇到复杂叠层可能仍有出入。带 alpha 的
 *     那几条对不上时，以屏幕上取色器的结果为准。
 *   - 没算同源 iframe 里的元素，扩展算。页面把主体放在 iframe 里时差别会很大。
 *   - 元素超过 8000 个时两边都会截断，但截断点未必一样。
 *   - 间距这一块，扩展只收「有间距特征，或者宽到可能是内容容器」的元素，
 *     这里收全部元素。所以同一个间距值的证据数这里会偏大，看相对顺序和
 *     有哪些值，别看绝对数。
 *
 * 怎么对着合并后的色值核
 *   扩展报的每个颜色的次数是该颜色所在簇的合计。核的时候拿
 *   「这里该色值的次数 + mergedFrom 里每个色值的次数」，应该等于导出文件里
 *   那个角色的 evidence 计数。linear.app 上六个角色实测全部吻合。
 *
 * 怎么对 CSS Overview 的数字
 *   CSS Overview 摘要里的 Elements 数的是「有布局盒子的节点」，元素和文本节点
 *   都算（实现见 devtools-frontend 的 CSSOverviewModel.getNodeStyleStats，取的
 *   是 DOMSnapshot 的 layout.nodeIndex）。它不看 DOM 里有多少元素，只看渲染树
 *   里有多少个节点。所以：
 *     本脚本的「遍历」= DOM 里的元素总数，换视口宽度基本不变
 *     本脚本的「布局树口径」= CSS Overview 那个数，换视口宽度变化很大
 *   响应式页面窄屏时桌面布局整片 display:none，DOM 一个不少、渲染树塌掉大半，
 *   两者能差一倍以上。linear.app 实测 1440px 时布局树 4872，640px 时只剩 2135，
 *   而同一时刻 DOM 里的元素始终是 4763 个。
 */
(() => {
  const MAX_ELEMENTS = 8000;
  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'TEMPLATE',
    'HEAD', 'TITLE', 'BASE', 'BR', 'WBR', 'SOURCE', 'TRACK', 'PARAM',
  ]);
  const CONTROL_TAGS = new Set(['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY', 'OPTION']);
  const CONTROL_ROLES = new Set([
    'button', 'link', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
    'checkbox', 'radio', 'switch', 'option', 'combobox', 'searchbox', 'textbox',
  ]);

  // --- 颜色工具 -------------------------------------------------------

  const parseRgba = (v) => {
    const m = /rgba?\(([^)]+)\)/.exec(v || '');
    if (!m) return null;
    const p = m[1].split(',').map((s) => parseFloat(s));
    if (p.length < 3 || p.slice(0, 3).some((n) => Number.isNaN(n))) return null;
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };

  /** 把 top 盖在 bottom 上，得到不透明的结果 */
  const over = (top, bottom) => ({
    r: top.r * top.a + bottom.r * (1 - top.a),
    g: top.g * top.a + bottom.g * (1 - top.a),
    b: top.b * top.a + bottom.b * (1 - top.a),
    a: 1,
  });

  const toHex = (c) =>
    '#' +
    [c.r, c.g, c.b]
      .map((n) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0'))
      .join('');

  /** 这个元素实际呈现出来的底色：从根往下逐层合成 */
  const surfaceOf = (el) => {
    const chain = [];
    for (let n = el; n; n = n.parentElement) {
      const bg = parseRgba(getComputedStyle(n).backgroundColor);
      if (bg && bg.a > 0) chain.push(bg);
    }
    let acc = { r: 255, g: 255, b: 255, a: 1 };
    for (let i = chain.length - 1; i >= 0; i--) acc = over(chain[i], acc);
    return acc;
  };

  // --- 累加器 ---------------------------------------------------------

  const bump = (map, k, n = 1) => map.set(k, (map.get(k) ?? 0) + n);
  /** 按出现次数从多到少取前 n 条。weight 用来从非数字的值里取出计数 */
  const topN = (map, n, weight = (v) => v) =>
    [...map.entries()].sort((a, b) => weight(b[1]) - weight(a[1])).slice(0, n);

  const bgCount = new Map();      // 背景色 → 元素数
  const textChars = new Map();    // 文字色 → 字符数
  const borderCount = new Map();  // 边框色 → 元素数
  const sizeHist = new Map();     // 字号 → { 字符, 元素, 标题标签 }
  const spacingHist = new Map();  // 间距值 → { 总数, padding, gap, margin }
  const radiusHist = new Map();   // 圆角值 → 元素数

  let visited = 0;
  let skipped = 0;
  let truncated = false;
  let totalChars = 0;
  let shadowCount = 0;
  let gradientCount = 0;
  let controlCount = 0;

  // --- 主遍历 ---------------------------------------------------------

  const nodes = Array.from(document.querySelectorAll('*'));

  for (const el of nodes) {
    if (visited >= MAX_ELEMENTS) { truncated = true; break; }
    visited++;

    if (SKIP_TAGS.has(el.tagName)) { skipped++; continue; }

    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) { skipped++; continue; }

    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') {
      skipped++; continue;
    }
    const opacity = parseFloat(cs.opacity);
    if (!Number.isNaN(opacity) && opacity < 0.05) { skipped++; continue; }

    // 折叠的 details、content-visibility:hidden 的子树，只有这一个判据认得出
    if (el.checkVisibility && !el.checkVisibility()) { skipped++; continue; }

    const surface = surfaceOf(el);

    // --- 背景色 ---
    const ownBg = parseRgba(cs.backgroundColor);
    if (ownBg && ownBg.a > 0) bump(bgCount, toHex(surface));

    // --- 文字：只算这个元素直接承载的文本节点，不含子孙 ---
    let chars = 0;
    for (let n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3 && n.textContent) chars += n.textContent.trim().length;
    }
    if (chars > 0) {
      totalChars += chars;
      const tc = parseRgba(cs.color);
      if (tc) bump(textChars, toHex(over(tc, surface)), chars);
    }

    // --- 边框色：一个元素只记一次，即使四边都带描边。
    //     扩展那边也是按元素数记的，这里跟随，否则数字会差四倍。
    let borderHex = null;
    for (const side of ['top', 'right', 'bottom', 'left']) {
      const w = parseFloat(cs.getPropertyValue('border-' + side + '-width'));
      const st = cs.getPropertyValue('border-' + side + '-style');
      if (w > 0 && st && st !== 'none' && st !== 'hidden') {
        const bc = parseRgba(cs.getPropertyValue('border-' + side + '-color'));
        if (bc && bc.a > 0) borderHex = toHex(over(bc, surface));
      }
    }
    if (borderHex) bump(borderCount, borderHex);

    // --- 排版 ---
    const size = Math.round(parseFloat(cs.fontSize) * 100) / 100;
    if (chars > 0 && size > 0) {
      const h1to6 = /^H([1-6])$/.exec(el.tagName);
      const roleAttr = (el.getAttribute('role') || '').toLowerCase();
      let level = 0;
      if (h1to6) level = +h1to6[1];
      else if (roleAttr === 'heading') level = +(el.getAttribute('aria-level') || 2) || 2;

      const cur = sizeHist.get(size) ?? { chars: 0, els: 0, heads: new Set() };
      cur.chars += chars;
      cur.els++;
      if (level > 0) cur.heads.add(level);
      sizeHist.set(size, cur);

      const isControl =
        CONTROL_TAGS.has(el.tagName) || (roleAttr && CONTROL_ROLES.has(roleAttr));
      if (isControl) controlCount++;
    }

    // --- 间距 ---
    // padding 四边、margin 四边、再加一个 gap。gap 只在非 block 布局里取，
    // 且行间距优先于列间距，水平和垂直都有值时用行间距。
    //
    // 同一个元素里出现多次的同一个值只算一次。不这么做的话，一句
    // padding: 16px 会被记成四条证据，把别的值全压下去，档位就看不出来了。
    const spacing = [];
    for (const side of ['top', 'right', 'bottom', 'left']) {
      spacing.push(['padding', cs.getPropertyValue('padding-' + side)]);
      spacing.push(['margin', cs.getPropertyValue('margin-' + side)]);
    }
    if (/(flex|grid)/.test(cs.display)) {
      const rg = parseFloat(cs.rowGap);
      const cg = parseFloat(cs.columnGap);
      const picked = rg > 0 ? rg : cg;
      if (picked > 0) spacing.push(['gap', String(picked)]);
    }

    const seenSpacing = new Set();
    for (const [source, raw] of spacing) {
      const val = parseFloat(raw);
      if (!Number.isFinite(val) || Math.abs(val) < 2) continue;
      const key = Math.round(val * 10) / 10;
      if (seenSpacing.has(key)) continue;
      seenSpacing.add(key);
      const cur = spacingHist.get(key) ?? { count: 0, padding: 0, gap: 0, margin: 0 };
      cur.count++;
      cur[source]++;
      spacingHist.set(key, cur);
    }

    // --- 圆角：四角取最大值 ---
    const radii = ['border-top-left-radius', 'border-top-right-radius',
                   'border-bottom-right-radius', 'border-bottom-left-radius']
      .map((p) => parseFloat(cs.getPropertyValue(p)) || 0);
    const maxR = Math.max(...radii);
    if (maxR > 0) bump(radiusHist, Math.round(maxR * 100) / 100);

    // --- 其他 ---
    if (cs.boxShadow && cs.boxShadow !== 'none') shadowCount++;
    if ((cs.backgroundImage || '').indexOf('gradient') !== -1) gradientCount++;
  }

  // --- 和 CSS Overview 对齐的第二个口径 ------------------------------
  //
  // 这个非常容易和上面那个数混淆，所以单独算一份出来。
  //
  // CSS Overview 摘要里的 Elements 来自 DOMSnapshot 的 layout.nodeIndex，
  // 也就是「真正生成了布局盒子的节点」，元素和文本节点都算在内。它不看 DOM
  // 里有多少元素，只看渲染树里有多少个节点。差别在响应式页面上非常大：
  // 窄屏时桌面布局被 display:none 藏起来，DOM 一个不少，渲染树却塌掉大半。
  //
  // 下面这段是它的近似实现。比真值少几个百分点，因为 DOM 接口看不到影子树
  // 里的节点，而 DOMSnapshot 看得到。用来判断量级足够。
  const layoutTree = (() => {
    const noneOf = (e) => getComputedStyle(e).display === 'none';
    const inLayout = (e) => {
      for (let n = e; n; n = n.parentElement) if (noneOf(n)) return false;
      return true;
    };
    let els = 0;
    for (const e of nodes) if (inLayout(e)) els++;
    let texts = 0;
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      if (n.parentElement && inLayout(n.parentElement)) texts++;
    }
    return { els, texts, total: els + texts };
  })();

  // --- 输出 -----------------------------------------------------------

  const htmlBg = getComputedStyle(document.documentElement).backgroundColor;
  const bodyBg = getComputedStyle(document.body).backgroundColor;

  // 顺手挂一份原始结果到全局，想拿去做对比或者复制出去都方便
  globalThis.__designVerify = {
    url: location.href,
    viewport: [innerWidth, innerHeight],
    visited,
    skipped,
    truncated,
    totalChars,
    layoutTree,
    canvas: toHex(surfaceOf(document.body)),
    backgrounds: topN(bgCount, 200).map(([hex, n]) => [hex, n]),
    texts: topN(textChars, 200).map(([hex, n]) => [hex, n]),
    borders: topN(borderCount, 200).map(([hex, n]) => [hex, n]),
    sizes: [...sizeHist.entries()]
      .map(([size, v]) => ({ size, chars: v.chars, els: v.els, heads: [...v.heads].sort() }))
      .sort((a, b) => b.chars - a.chars),
    paddings: topN(spacingHist, 200, (a) => a.count).map(([v, a]) => [v, a.count, a.padding, a.gap, a.margin]),
    radii: topN(radiusHist, 200).map(([v, n]) => [v, n]),
    shadows: shadowCount,
    gradients: gradientCount,
  };

  console.log('');
  console.log('%c设计稿提取 · 页面自检', 'font-size:14px;font-weight:600');
  console.log('网址         ', location.href);
  console.log('视口         ', innerWidth + ' × ' + innerHeight);
  console.log('遍历 / 跳过  ', visited, '/', skipped, truncated ? '（已达上限截断）' : '');
  console.log('直接文字总数 ', totalChars, '字');
  console.log('布局树口径   ', layoutTree.total, `（有布局的元素 ${layoutTree.els} + 有布局的文本 ${layoutTree.texts}）`);
  console.log('             ', '↑ 这个才和 CSS Overview 摘要里的 Elements 可比，它随视口宽度变化');
  console.log('html 底色    ', htmlBg);
  console.log('body 底色    ', bodyBg);
  console.log('合成后底色   ', toHex(surfaceOf(document.body)));
  console.log('');

  const tbl = (title, rows) => {
    console.log('%c' + title, 'font-weight:600');
    if (rows.length === 0) { console.log('  （无）'); console.log(''); return; }
    console.table(rows);
  };

  tbl('背景色（元素自己有不透明底色）',
    topN(bgCount, 12).map(([hex, n]) => ({ 色值: hex, 元素数: n })));

  tbl('文字色（按承载字符数排序）',
    topN(textChars, 12).map(([hex, n]) => ({ 色值: hex, 字符数: n })));

  tbl('边框色',
    topN(borderCount, 12).map(([hex, n]) => ({ 色值: hex, 带此边框的元素数: n })));

  tbl('字号（按承载字符数排序）',
    topN(new Map([...sizeHist].map(([k, v]) => [k, v.chars])), 16).map(([k]) => {
      const v = sizeHist.get(k);
      return {
        字号: k,
        字符数: v.chars,
        元素数: v.els,
        标题标签: v.heads.size ? [...v.heads].sort().map((n) => 'h' + n).join('/') : '',
      };
    }));

  tbl('间距值（px → 证据数，同一元素内同值只算一次）',
    topN(spacingHist, 16, (a) => a.count).map(([k]) => {
      const a = spacingHist.get(k);
      return { 值: k, 证据数: a.count, 来自内边距: a.padding, 来自间距: a.gap, 来自外边距: a.margin };
    }));

  tbl('圆角（px → 元素数）',
    topN(radiusHist, 12).map(([v, n]) => ({ 值: v, 元素数: n })));

  console.log('%c其他', 'font-weight:600');
  console.log('  带阴影的元素     ', shadowCount);
  console.log('  带渐变背景的元素 ', gradientCount);
  console.log('  命中控件候选     ', controlCount, '（按钮/链接/输入/表单角色的元素数）');
  console.log('');
  console.log('%c对照方式', 'font-weight:600');
  console.log('  底色        → 导出里的 page.canvasColor，以及色板里 neutral 那个角色');
  console.log('  背景色      → 色板里 surface / neutral 角色，次数看该角色的 evidence.backgroundCount');
  console.log('  文字色      → 色板里 primary / secondary 角色，字符数看 evidence.textChars');
  console.log('  边框色      → 色板里 border 角色，次数看 evidence.borderCount');
  console.log('  字号        → analysis.typography.steps，逐级对 size 和 headingLevels');
  console.log('  间距值      → analysis.spacing.steps，看哪些值落进了档位；被丢掉的在 discarded 里');
  console.log('  圆角 / 边框 → analysis.effects，按元素类型分组的那几档');
  console.log('');
  console.log('%c别忘了半透明色对不上是正常的，以屏幕取色器为准。', 'color:#888');
})();
