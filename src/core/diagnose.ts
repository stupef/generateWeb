import type { EmbeddedContentSummary } from './types';

/**
 * 页面可用性判定。
 *
 * 这个模块回答一个问题：这次采集为什么没成功，或者虽然成功了但结果为什么不能用。
 * 它只产出文字，不碰 DOM、不碰 chrome API，纯函数，所以可以在 Node 里直接单测。
 *
 * 之所以从弹窗里搬出来单独成模块，是因为原先的判定有两个真实缺陷，都源于
 * 把「读不到地址」当成了可以下结论的信号。
 *
 * 一是归因错误。扩展只申请了 activeTab 没有 tabs 权限，而在 chrome:// 这类受限
 * 页面上 activeTab 不会被授予，tab.url 就是 undefined。原代码把 undefined 直接
 * 当成了「许可还没生效」，给出的建议是刷新页面。这条建议从根上就不成立，
 * activeTab 是点击图标那一刻授予的，不存在「刚安装还没生效」这个状态。
 *
 * 二是它把正确分支变成了死代码。只要 url 读不到就提前返回，后面那条判定
 * 「这是浏览器内部页面」的规则永远执行不到。
 *
 * 所以现在的口径是：URL 只用来做正向预判，读不到就交给注入的真实报错来判。
 *
 * 后来按同一条口径又修了第三处。本地文件原先是无条件拦住的，但「能不能读
 * 一个本地文件」并不由地址决定，它取决于用户有没有拨开「允许访问文件网址」
 * 那个开关。于是开关早就打开的用户照样被拦在门口，注入一次都没跑。现在
 * 这一项改成由调用方把这个开关的状态传进来（见 `UrlPrecheckContext`），
 * 只有确定没开时才拦。
 */

export type FailureKind =
  | 'internal-page'
  | 'web-store'
  | 'file-url'
  | 'pdf-file'
  | 'opaque-url'
  | 'no-host-access'
  | 'policy-blocked'
  | 'tab-gone'
  | 'error-page'
  | 'page-changed'
  | 'interrupted'
  | 'no-data'
  | 'unknown';

export interface Diagnosis {
  kind: FailureKind;
  title: string;
  body: string;
  hints?: string[];
  /**
   * 在当前状态下点「重新提取」有没有意义。
   * 内部页面、应用商店、PDF 这些重试必然失败，就不该把按钮摆出来，
   * 摆出来等于在引导用户做一件注定无效的事。
   */
  retryable: boolean;
  /**
   * 这条提示附带一个能直接点的动作。没有就不给按钮。
   *
   * 只存一个符号，不存地址。跳到哪儿由界面层补，因为 `chrome://extensions`
   * 那条要带上扩展自己的 id，而这个模块是纯函数，既拿不到也不该去碰
   * chrome API。符号到地址的映射在弹窗里。
   */
  action?: NoticeAction;
}

/** 提示里可以带的动作。目前只有一个，将来有第二个再往这里加 */
export type NoticeAction = 'open-extension-settings';

// ---------------------------------------------------------------------
// 一、URL 预判
//
// 只处理能凭地址就确定的类别，命中即返回。这些判断比注入失败的报错
// 更早、更具体，也能省掉一次注定失败的注入。
// ---------------------------------------------------------------------

const INTERNAL_SCHEME =
  /^(chrome|edge|brave|opera|vivaldi|about|devtools|view-source|chrome-untrusted|chrome-search|chrome-extension|moz-extension|edge-extension):/i;

const WEB_STORE = /^https?:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com)/i;

/**
 * 判断 URL 是否指向一个 PDF 文件。
 *
 * 只看 pathname 的后缀，不看整串地址。上一版用正则在整串上匹配，
 * 写成 /^https?:\/\/[^/]*\.pdf($|[?#])/i，其中 [^/]* 跨不过斜杠，
 * 于是 \.pdf 只能贴在主机名末尾，真实地址一条都拦不住：
 * https://www.w3.org/.../dummy.pdf、https://arxiv.org/pdf/2401.00001.pdf
 * 全部未命中，只有 https://foo.pdf 这种不存在的地址能匹配。
 */
function isPdfUrl(url: string): boolean {
  try {
    return new URL(url).pathname.toLowerCase().endsWith('.pdf');
  } catch {
    return false;
  }
}

/**
 * 预判需要的、地址里读不出来的事实。
 *
 * 目前只有一项。本地文件能不能读取决于「允许访问文件网址」这个用户开关，
 * 地址长得一样，能读和不能读都是 `file:///…`，所以必须由调用方问出来传进来。
 */
export interface UrlPrecheckContext {
  /**
   * 用户有没有打开那个开关。三种取值各有含义：
   *
   * - `true`   确定打开了，放它去注入
   * - `false`  确定没打开，就地拦下并给出开启步骤
   * - 不传     问不到，按未知处理，同样放它去注入
   *
   * 未知为什么也放行。因为拦对了只是少绕一次注入，拦错了却是把一个本来
   * 能采的页面判成不能采，代价不对等；而放行之后真读不到，注入会抛出
   * `Cannot access contents of url "file://…"`，由 ERROR_RULES 里那条
   * file 规则接住，给出的说明和这里一模一样。两条路在这里汇合，
   * 所以忘了传不会导致错误结论，只会多绕一次注入。
   */
  fileAccess?: boolean;
}

/**
 * 本地文件读不到时的说明。
 *
 * 两个入口共用这一处文案。一个是地址预判（明确知道开关没开），一个是
 * ERROR_RULES（注入真的抛了 file 的错）。两处指向的是同一个开关，所以
 * 句子和动作必须一模一样，各写一份早晚有一处漏改，而漏改的表现是
 * 「同一件事在两条路上说法不同」。
 */
function fileUrlDiagnosis(): Diagnosis {
  return {
    kind: 'file-url',
    title: '这是本地文件，扩展还没拿到读取它的权限',
    body:
      '读本地文件不由扩展自己决定。Chrome 要求用户单独拨一个开关，' +
      '而这个开关只影响本地文件，不影响扩展在普通网站上的工作。',
    hints: [
      '点下面的按钮，直接跳到这个扩展的设置页',
      '打开「允许访问文件网址」',
      '回到这个本地文件页面，重新点一次插件图标',
    ],
    action: 'open-extension-settings',
    // 开关没打开时重试必然失败，这一步要用户自己去开，不是点一下按钮能解决的
    retryable: false,
  };
}

/**
 * 凭地址预判。返回 null 表示这个地址本身看不出问题，应该继续尝试注入。
 *
 * 注意 url 为空时同样返回 null。读不到地址只能说明读不到，不能说明原因，
 * 所以不做任何归因，把判断权交给注入的真实报错。
 */
export function diagnoseUrl(
  url: string | undefined,
  context: UrlPrecheckContext = {},
): Diagnosis | null {
  if (!url) return null;

  if (INTERNAL_SCHEME.test(url)) {
    return {
      kind: 'internal-page',
      title: '这是浏览器内部页面',
      body:
        'Chrome 从内核层面禁止任何扩展在内部页面上注入脚本，这不是权限设置能打开的开关，所有扩展都一样。',
      hints: ['切换到一个普通网站（地址以 http 或 https 开头）再试'],
      retryable: false,
    };
  }

  if (WEB_STORE.test(url)) {
    return {
      kind: 'web-store',
      title: '这是 Chrome 应用商店',
      body:
        '应用商店页面禁止扩展读取和修改，防止扩展在商店里刷评价或篡改安装按钮。所有扩展都受这条策略限制。',
      hints: ['换一个普通网站再试'],
      retryable: false,
    };
  }

  // 本地文件是唯一一类「能不能读不由地址决定」的类别。能读和不能读都是
  // `file:///…`，决定权在「允许访问文件网址」这个用户开关上，开关在
  // chrome://extensions 的详情页，扩展改不了。
  //
  // 所以这里只在明确知道开关没开时才下结论，其余一律放它去注入。原来的
  // 写法是无条件拦住，于是开关早就打开的用户也被这张提示页挡在门口，
  // 注入一次都没执行过。那条预判违反的正是本模块自己的口径——能凭地址
  // 确定的类别才在这里返回，判不准的交给注入的真实报错。
  if (/^file:/i.test(url) && context.fileAccess !== false) return null;

  if (/^file:/i.test(url) || /^filesystem:/i.test(url)) {
    return fileUrlDiagnosis();
  }

  if (isPdfUrl(url)) {
    return {
      kind: 'pdf-file',
      title: '这是 PDF 文件',
      body:
        'PDF 由 Chrome 内置阅读器渲染，阅读器跑在自己的扩展上下文里，任何扩展都进不去。内容不在网页文档树里，读不到任何样式信息。',
      hints: ['如果 PDF 是以网页形式打开的单页应用，可以正常提取'],
      retryable: false,
    };
  }

  if (/^(data|blob):/i.test(url)) {
    return {
      kind: 'opaque-url',
      title: '这类页面没有标准网址',
      body: '页面地址是临时生成的，扩展无法向它注入脚本。',
      retryable: false,
    };
  }

  return null;
}

// ---------------------------------------------------------------------
// 二、注入失败的报错归类
//
// 注入抛出的错误是最终权威，因为厂商会不断新增受保护的页面，
// URL 白名单永远追不上。下面这些串都是 Chrome 实际会返回的原文。
//
// 规则顺序有讲究：拆分的规则必须排在笼统的规则前面。比如
// "Cannot access a chrome-extension:// URL of different extension"
// 会被 "cannot access a chrome" 抢先命中，所以扩展页那条要先判。
// ---------------------------------------------------------------------

interface ErrorRule {
  re: RegExp;
  make: () => Diagnosis;
}

const ERROR_RULES: ErrorRule[] = [
  {
    re: /extensions gallery cannot be scripted/i,
    make: () => ({
      kind: 'web-store',
      title: '这是 Chrome 应用商店',
      body: '应用商店页面禁止扩展读取和修改，防止扩展在商店里刷评价或篡改安装按钮。',
      hints: ['换一个普通网站再试'],
      retryable: false,
    }),
  },
  {
    re: /cannot be scripted due to an ExtensionsSettings policy/i,
    make: () => ({
      kind: 'policy-blocked',
      title: '这台机器的策略禁止了扩展',
      body:
        '系统或企业策略把这个扩展限制在了某些站点之外，这不是扩展自身的设置能改的。',
      hints: ['换一个普通网站再试', '如果这是公司电脑，需要联系管理员放行'],
      retryable: false,
    }),
  },
  {
    // chrome-extension:// 这条单独排在笼统规则前面，否则会被
    // "cannot access a chrome" 抢先命中，丢掉「是内置组件」这个信息。
    //
    // 措辞刻意不写死成某一种：Chrome 会把 PDF 交给内置阅读器渲染，而阅读器
    // 本身是一个组件扩展，报错时不会告诉你它到底是阅读器还是别的什么。
    // 与其猜一个具体名字，不如把可能性说清楚，两种情况都不算说错。
    re: /cannot access a (chrome-extension|moz-extension|edge-extension)/i,
    make: () => ({
      kind: 'internal-page',
      title: '这是浏览器内部组件渲染的页面',
      body:
        '这个页面由浏览器内部的组件承载，最常见的是 Chrome 内置的 PDF 阅读器，' +
        '也可能是另一个扩展的页面。它们都跑在独立的扩展上下文里，任何扩展都读不到内容。',
      hints: ['如果是 PDF，直接打开原始下载链接没有用，这类内容采不到样式'],
      retryable: false,
    }),
  },
  {
    re: /cannot access a (chrome|edge|about|devtools|view-source)/i,
    make: () => ({
      kind: 'internal-page',
      title: '这是浏览器内部页面',
      body:
        'Chrome 从内核层面禁止任何扩展在内部页面上注入脚本，这不是权限设置能打开的开关，所有扩展都一样。',
      hints: ['切换到一个普通网站（地址以 http 或 https 开头）再试'],
      retryable: false,
    }),
  },
  {
    re: /cannot access contents of url "?file:|file:\/\/|access to file URLs/i,
    // 和地址预判共用同一处文案。这条路径是「开关没开」时的实际落点：
    // 预判按未知放行，注入抛错，归到这里，用户看到的和预判拦下时一字不差
    make: fileUrlDiagnosis,
  },
  {
    re: /cannot access contents of|manifest must request permission/i,
    make: () => ({
      kind: 'no-host-access',
      title: '扩展没有这个网站的访问权限',
      body:
        '扩展靠点击图标时的临时授权读取页面，这次授权没有生效，或者站点访问被单独限制过。',
      hints: [
        '打开 chrome://extensions，在「详情」里把「网站访问权限」设为「在点击时」',
        '然后重新点一次插件图标',
      ],
      retryable: false,
    }),
  },
  {
    re: /No tab with id|Invalid tab ID|tab was closed/i,
    make: () => ({
      kind: 'tab-gone',
      title: '标签页已经关闭',
      body: '采集开始前这个标签页被关掉了。',
      hints: ['重新打开目标页面再点一次插件图标'],
      retryable: false,
    }),
  },
  {
    re: /showing error page|Frame with ID/i,
    make: () => ({
      kind: 'error-page',
      title: '页面没有正常加载',
      body: '这个标签页显示的是浏览器的错误页，里面没有可读取的内容。',
      hints: ['确认网址能正常打开后再试'],
      retryable: false,
    }),
  },
  {
    re: /The frame was removed/i,
    make: () => ({
      kind: 'page-changed',
      title: '页面在采集中跳走了',
      body: '目标页面在读取的过程中发生了跳转或重绘，读到一半的数据作废。',
      hints: ['等页面稳定下来再点一次，这条重试通常有效'],
      // 这条重试真的有用，页面稳定后就能成功
      retryable: true,
    }),
  },
  {
    re: /message port closed|Extension context invalidated/i,
    make: () => ({
      kind: 'interrupted',
      title: '采集被中断',
      body: '采集过程中弹窗被关掉了，任务随之中止。',
      hints: ['重新点开插件图标即可，期间不要点别处'],
      retryable: false,
    }),
  },
];

/** 把注入抛出的错误翻成给用户看的说明 */
export function diagnoseInjectionError(err: unknown): Diagnosis {
  const msg = err instanceof Error ? err.message : String(err);

  for (const rule of ERROR_RULES) {
    if (rule.re.test(msg)) return rule.make();
  }

  // 认不出来就把原文摆出来，比编一个解释诚实
  return {
    kind: 'unknown',
    title: '提取失败',
    body: msg || '未知错误。',
    hints: ['这条错误没有被识别，把这段文字反馈一下可以补进规则里'],
    retryable: true,
  };
}

/** 注入成功但没拿到合法结果 */
export function diagnoseMissingSample(): Diagnosis {
  return {
    kind: 'no-data',
    title: '脚本没有返回数据',
    body: '页面可能在采集中途发生了跳转，或者被其他扩展拦截了。',
    hints: ['等页面完全加载后重试'],
    retryable: true,
  };
}

// ---------------------------------------------------------------------
// 三、采到了但结果不可用
//
// 这一类不是失败，采集本身是成功的，只是页面主体不在扩展能读到的范围内。
// 所以不拦成错误页，而是在结果页上诚实说明覆盖范围，让读文件的 AI
// 知道色板为什么不完整，不要拿它去代表整个页面。
// ---------------------------------------------------------------------

export interface CoverageNote {
  /** 要展示、并最终写进生成文件的句子 */
  lines: string[];
  /** 色板基本失效时为 true，界面用更醒目的样式呈现 */
  severe: boolean;
}

/** 有效颜色少于这个数，就认为这次采集没取到有意义的色板 */
const USABLE_COLOR_THRESHOLD = 3;

/**
 * 顶层文档直接承载的文字少于这个数，就认为它是个空壳。
 *
 * 这个信号比「颜色数少」可靠得多。外壳页面照样会有白色底和默认黑字，
 * 颜色数轻松就有两三个，所以仅凭颜色数判断会漏掉一整类页面。
 * 而真正承载内容的文档，光是直接文字就轻松上千，两者差着数量级。
 */
const SPARSE_TEXT_CHARS = 200;

/**
 * 把框架的可读性翻成一句话。
 *
 * 「读了但里面没东西」和「压根读不到」是完全不同的两件事，对用户的
 * 下一步动作影响也不同，所以不能合成一句笼统的「框架内容不可见」。
 */
function frameAccessLines(embedded: EmbeddedContentSummary): string[] {
  const read = embedded.sameOriginFrames;
  const blocked = embedded.blockedFrames;

  if (read === 0 && blocked > 0) {
    return ['这些框架来自不同域名，浏览器禁止扩展读取里面的内容，因此完全采集不到。'];
  }
  if (blocked > 0) {
    return [
      `其中 ${read} 处同源框架的内容已经读入，另 ${blocked} 处来自不同域名读不到，不在采集范围内。`,
    ];
  }
  if (read > 0) {
    return ['框架内容已经一并读入，但没有从中取到可用的背景、文字或边框色。'];
  }
  return ['框架内的内容不在本次采集范围内。'];
}

/**
 * 生成覆盖范围说明。返回 null 表示没有需要说明的，正常页面走这条路。
 *
 * 判定主体是否藏在框架里靠两个证据，第一是有个够大的框架，第二是顶层
 * 文档几乎没内容。两个都成立才提示。只看框架大小不行，页面里挂一个
 * 地图或视频 iframe 是常见做法，主站内容照样采得到，那种情况不该提示。
 */
export function describeCoverage(
  embedded: EmbeddedContentSummary | undefined,
  colorCount: number,
  textCharsTotal: number | undefined,
): CoverageNote | null {
  // 采集结果会穿过一次序列化边界，字段缺失时宁可少说一句也不要整屏崩掉
  if (!embedded) return null;

  const lines: string[] = [];

  // 文字总量缺失时按「不稀疏」处理，避免凭不完整的数据误报
  const textChars =
    typeof textCharsTotal === 'number' ? textCharsTotal : Number.POSITIVE_INFINITY;
  const sparse = textChars < SPARSE_TEXT_CHARS;
  const barren = colorCount < USABLE_COLOR_THRESHOLD;

  const shellLike = embedded.largeFrames > 0 && (sparse || barren);

  if (embedded.framesetDocument) {
    lines.push('本页是框架结构，顶层文档自身不承载任何内容，可见内容全部在框架里。');
    lines.push(...frameAccessLines(embedded));
  } else if (shellLike) {
    lines.push(
      `本页有 ${embedded.largeFrames} 处框架区域，最大一处占视口的 ` +
        `${Math.round(embedded.largestFrameRatio * 100)}%，页面主体内容在其中。`,
    );
    lines.push(...frameAccessLines(embedded));
  }

  if (embedded.contentType && embedded.contentType.indexOf('pdf') !== -1) {
    // 顶层文档本身就是 PDF。正常情况这类页面注入不进去，会在地址预判或
    // 注入报错阶段就被拦下，这里是兜底，防止漏网时给出一个没有解释的空白结果。
    lines.push(
      '这个页面的顶层文档本身就是 PDF 文档，内容由浏览器内置阅读器渲染，' +
        '不在网页文档树里，读不到任何样式信息。',
    );
  } else if (embedded.pdfEmbeds > 0) {
    lines.push(
      `本页嵌入了 ${embedded.pdfEmbeds} 处 PDF 文档。PDF 由浏览器内置阅读器渲染，` +
        '内容不在网页文档树里，读不到任何样式信息，它的颜色同样不在色板覆盖范围内。',
    );
  }

  if (lines.length === 0) return null;

  lines.push('复刻这一页时需要另外提供上述部分的视觉参考，不要用色板里的颜色替代。');

  // 严重程度说的是色板还能不能用。页面主体没采到、顶层又几乎没内容，
  // 这种情况下的色板只是外壳的默认色，拿去复刻会得到完全不相干的结果。
  return { lines, severe: barren || (shellLike && sparse) };
}

// ---------------------------------------------------------------------
// 四、采样口径
//
// 这一类回答的不是「采到了什么」，而是「在哪采的」。
//
// 全部数值都来自 getComputedStyle，也就是当前视口下浏览器实际渲染用的值，
// 不是样式表里写的原值。对一份不随窗口变化的静态页面，两者差不多；对响应式
// 页面，同一个标题在 1440 宽下是 32px、在 640 宽下可能只有 24px，各档之间的
// 比例也会跟着改。不把这个前提写出来，读生成文件的人会把一份 1440 宽下的
// 结论当成站点的设计原值，照着复刻就会整片偏掉。
//
// 只声明宽度不声明高度，因为宽度才是决定因素，高度几乎不影响结论——全部
// 判据里只有渐变面积比例用到它，而那个比例本身是相对的。宽度缺失时宁可不
// 声明，也不要凑一个默认值，那等于给出一份看起来可复现、实际不对的口径。
//
// 和覆盖范围说明一样，这里只产出文字，不碰 DOM、不碰 chrome API。
// ---------------------------------------------------------------------

export interface ViewportNote {
  /** 采样时的视口宽度，px */
  width: number;
  /** 要展示、并最终写进生成文件的句子 */
  lines: string[];
}

/** 有效视口宽度的下限。低于它说明这个字段没读到，而不是窗口真的那么窄 */
const MIN_VIEWPORT_WIDTH = 1;

/**
 * 生成采样口径说明。返回 null 表示宽度不可用，此时不声明口径。
 *
 * 宽度由调用方传进来而不是在这里读，理由和覆盖范围那边一样：这个模块
 * 要在 Node 里单测，不能依赖 window。
 */
export function describeViewport(width: number | undefined): ViewportNote | null {
  // 采集结果穿过一次序列化边界，字段可能整体缺失
  if (typeof width !== 'number' || !Number.isFinite(width) || width < MIN_VIEWPORT_WIDTH) {
    return null;
  }

  return {
    width: Math.round(width),
    lines: [
      '本次全部数值取自这个视口宽度下的渲染结果，读的是浏览器实际使用的计算值，不是样式表里写的原值。',
      '响应式页面在别的窗口宽度下会换用另一组值，字号层级、间距和组件形态都可能整体不同，' +
        '所以这份结论只对应这个宽度下的呈现，不代表同一个页面在其他宽度下的样子。',
      '需要别的宽度下的值，把窗口调到那个宽度再采一次；单次采样只覆盖当前这一档。',
    ],
  };
}
