/**
 * 注入脚本与扩展本体之间共享的数据结构。
 *
 * 这里只放类型，不放任何运行时值。因为注入脚本会被序列化成字符串送进页面，
 * 任何运行时的模块级引用都会在页面里变成未定义。
 */

/** 各通道 0-255，alpha 0-1 */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/**
 * 单个元素的一条样式观测。
 * 所有数值都来自 getComputedStyle，也就是浏览器实际渲染用的值，
 * 不是样式表里写的值。
 */
export interface ElementObservation {
  /**
   * 指向采集时那份元素注册表的下标。界面上的「溯源高亮」靠它回到页面上的
   * 具体元素：注册表在隔离世界里按同一个顺序攒着 Element 引用，这里的
   * 数字就是那份数组的下标。
   *
   * 四条观测通道共用同一个编号空间，同一个元素在 elements、typography、
   * boxes、styles 里出现的 ref 是同一个值。不同通道的元素序列本来各不
   * 重合，给了统一编号之后才能回答「用了这个字号的那个元素，是不是也用了
   * 这个背景色」。
   */
  ref: number;
  tag: string;
  /** 元素直接承载的文字字符数。0 表示它不直接显示文字，只是容器 */
  textChars: number;
  /** 元素自身的字号，px */
  fontSize: number;
  /** 渲染面积，px²。用来判断这个颜色覆盖了多大一块画面 */
  area: number;
  /** 严格的可点击控件：button / a / input / [role=button] 这一类 */
  isControl: boolean;
  /** 元素自己设置了不透明背景，说明它定义了一层表面 */
  definesSurface: boolean;
  /** 视觉上的文字颜色，已把半透明文字合成到底色上。仅 textChars > 0 时有值 */
  textColor: string | null;
  /** 视觉上的背景色，已向上穿透并合成所有半透明层。仅 definesSurface 时有值 */
  backgroundColor: string | null;
  /** 可见边框的颜色，四边取第一个有宽度的 */
  borderColor: string | null;
  /** 四边可见边框宽度之和，px */
  borderWidth: number;
}

/**
 * 一个文字元素在排版维度上的观测。
 *
 * 与 ElementObservation 分开存放，理由是两者的取样范围不一样。
 * 颜色分析要用到每一个元素，背景和边框都可能不带文字；排版分析只关心
 * 直接显示文字的那部分，在一份普通页面上通常只占两三成。合在一张表里
 * 会让每次注入都多传几千条排版上用不到的字段，而这两个数组加起来要
 * 穿过一次 executeScript 的序列化边界，白传的代价是实打实的。
 *
 * 另外这样切分之后，颜色模块和排版模块各自的字段只在自己那半边演进，
 * 不会互相牵扯。
 */
export interface TypeObservation {
  /** 元素在注册表里的下标，四条通道共用一个编号空间，见 ElementObservation.ref */
  ref: number;
  tag: string;
  /**
   * 标题语义级别 1-6。来自 h1-h6 标签，或 role=heading 配合 aria-level。
   * 非标题为 0。这个字段是「少数字符也要立为独立层级」的豁免依据，
   * 因为一个只有两个字的 h1 是真实存在的层级，不能按字符量把它当噪声丢掉。
   */
  headingLevel: number;
  /**
   * font-family 计算值的原始字符串。
   * 计算样式会把字体栈完整展开，CSS 变量也已解析成最终值，
   * 所以这里读到的是浏览器真正拿去匹配字体的那一串。
   */
  fontFamily: string;
  /** 字重。normal / bold 已经在采集时归一成 400 / 700 */
  fontWeight: number;
  /** 字号，px */
  fontSize: number;
  /** 行高像素值。计算值为 normal 时是 null，不臆造一个默认比例出来 */
  lineHeight: number | null;
  /** 字间距像素值。计算值为 normal 时是 null */
  letterSpacing: number | null;
  /** 元素直接承载的文字字符数，恒大于 0 */
  textChars: number;
  /** 文字是否落在可点击控件上。用来区分正文字体和界面控件字体 */
  isControl: boolean;
}

/**
 * 一个元素的盒模型间距观测。
 *
 * 和颜色、排版一样单独成一条通道，理由还是取样范围不同。间距只对真正
 * 参与版面排布的元素有意义，纯 inline 元素的上下方向 padding 根本不占位，
 * 采进来只会污染间距体系。
 *
 * 收录门槛见 collector 里对应的那段判断。满屏的 div 里绝大多数四个方向
 * 都是零，挡掉之后这条数组能比元素总数小一个量级，而穿一次 executeScript
 * 的序列化边界，少传几条是实打实的。
 */
export interface BoxObservation {
  /** 元素在注册表里的下标，四条通道共用一个编号空间，见 ElementObservation.ref */
  ref: number;
  tag: string;
  /** padding 四边，px，顺序上右下左 */
  padding: [number, number, number, number];
  /**
   * margin 四边，px，顺序上右下左。
   * auto 会被浏览器解析成实际使用的像素值，所以居中容器读到的也是真数字。
   */
  margin: [number, number, number, number];
  /**
   * 子项间距，px。只对 flex / grid 容器有意义，其余为 null。
   *
   * row-gap 与 column-gap 同时非零时取 row-gap。理由是垂直方向的节奏
   * 更能代表区块之间的间隔，而水平方向常常只是控件之间的紧密排列；
   * 只有水平方向有值时（flex row 容器的常见写法）才取那个值。
   */
  gap: number | null;
  /** 四角圆角的最大值，px。百分比写法解析不出真实半径，不计入 */
  radius: number;
  /**
   * 元素外边宽度，px。只在宽到可能是内容容器时才记，否则为 0。
   * 小元素的宽度对推断内容最大宽度没有价值，全记下来只是白占带宽。
   */
  width: number;
  /** 计算样式的 max-width，px。none 和百分比写法为 null */
  maxWidth: number | null;
  /** 有背景、边框或圆角，视觉上构成一个卡片或面板 */
  looksLikeCard: boolean;
  /**
   * 按钮、链接、输入框这一类可交互控件。
   *
   * looksLikeCard 只回答「视觉上像不像一块表面」，导航链接和按钮同样
   * 有底色和圆角，也会命中它。但它们的「内边距」是控件内边距，跟卡片
   * 内边距完全不是一回事：一个 12px 内边距的导航链接会把卡片的结论
   * 从 24 拽到 12。推断卡片参数时必须按这个标记把控件排除掉。
   */
  isControl: boolean;
  /** 语义区块元素：header / main / section 这一类 */
  isLandmark: boolean;
  /** 布局模式粗分类。纯 inline 的元素已经被挡在外面 */
  layout: 'flex' | 'grid' | 'block';
}

/**
 * 元素在页面上扮演的角色粗分类。
 *
 * 由采集层判定而不是分析层，因为判据全是 DOM 语义（标签、role、aria），
 * 采集时手上正好有这些属性；分析层拿到的是一个已经归好类的标签，
 * 不必把整套 DOM 判据再搬一遍。
 *
 * 分类刻意只做到这个粒度。再细下去（主按钮 / 危险按钮 / 图标按钮）就需要
 * 判断颜色关系，那属于分析层的事，放在这里会把「只观测不判断」这条线破掉。
 */
export type StyleElementKind =
  /** 按钮类控件：button 标签、role=button，以及带按钮外观的链接 */
  | 'button'
  /** 输入类控件：input / textarea / select，以及对应的 role */
  | 'input'
  /** 视觉上构成一块独立表面的容器 */
  | 'card'
  /** 导航容器本身，不是导航里的链接 */
  | 'nav'
  /** 其余带边框或投影的元素，例如分割线、表格、浮层 */
  | 'other';

/**
 * 一个元素的完整视觉样式观测。
 *
 * 单独开一条通道的理由和排版、间距那两个不一样。那两条是因为取样范围
 * 不同才分开，这一条是因为要「把关联的参数记在一起」。
 *
 * 组件风格的判断必须同时看到背景色、文字色、圆角、内边距和字体，
 * 缺一项就分不出主按钮和次按钮（差别只在填充和描边），也说不清
 * 一个卡片的内边距是多少。而这几类参数现在分散在三条通道里：
 * 颜色在 elements、间距在 boxes、字体在 typography，三者的元素序列
 * 各不重合，事后无法对齐回同一个元素。所以这里必须按元素重新记一份。
 *
 * 取样范围限定在可能构成组件的元素上，也就是带边框、带投影、带圆角
 * 背景的控件和容器。普通正文段落不进这条通道，一份页面上它通常只有
 * 几十到几百条，比 elements 小一个量级。
 */
export interface StyleObservation {
  /** 元素在注册表里的下标，四条通道共用一个编号空间，见 ElementObservation.ref */
  ref: number;
  tag: string;
  kind: StyleElementKind;
  /**
   * 祖先里有导航容器（nav 或 role=navigation）。
   * 用来把「导航里的链接」和「正文里的链接」分开，两者外观常常完全不同。
   */
  inNav: boolean;
  /**
   * 只统计元素自身的文字，不含子孙。
   * 判断一个按钮有没有可见文字标签，是分「图标按钮」和「文字按钮」的依据。
   */
  textChars: number;
  /**
   * 直接子元素个数。
   *
   * 这是「容器」和「叶子」的分水岭。一个带背景又有圆角的小东西，如果
   * 一个子元素都没有，它是徽标或头像；如果有子元素，它才可能是一个
   * 装着内容的卡片。光看尺寸分不开这两者，一个 200×40 的标签和
   * 一个 200×40 的卡片在数值上完全一样。
   */
  childCount: number;
  /**
   * 这个元素是不是把自己的父容器撑满了。
   *
   * 这是分开「卡片」和「版面容器」的唯一可靠判据。两者都可能有底色、
   * 圆角和内边距，尺寸也都能很大，光看自身数值完全区分不了。差别在于
   * 位置关系：版面容器（内容区外壳、整宽区块）总是撑满父容器，
   * 而卡片是排在一行里的其中一块，横向一定窄于父容器的内容区。
   *
   * 特殊写法占满整行的一行卡片，会被这里判成容器而漏掉，这是已知的
   * 取舍：宁可漏报，也不要把页面外壳报成卡片。漏报只会少说一句，
   * 误报会让复刻的人给整个内容区加上卡片背景。
   */
  fillsParent: boolean;
  /**
   * 合成后的背景色。null 表示元素完全透明、没有自己的表面，
   * 也就是通常说的「幽灵按钮」那种只有描边和文字的形态。
   */
  backgroundColor: string | null;
  /** 合成后的文字色。null 表示计算样式里没有可解析的颜色 */
  textColor: string | null;
  /** padding 四边，px，顺序上右下左 */
  padding: [number, number, number, number];
  /** 四角圆角的最大值，px。百分比写法解析不出真实半径，记 0 */
  radius: number;
  /**
   * 可见边框的最大边宽，px。0 表示没有边框。
   *
   * 取最大值而不是四边之和。这条通道上的判断几乎都在问「有没有描边」，
   * 四边之和会把 1px 的四边描边记成 4，与同样是 4px 的单边粗线混为一谈。
   */
  borderWidth: number;
  /**
   * 有一条可见边框的边的数量，1 到 4。
   *
   * 这个字段是分开「分割线」和「输入框」的关键。两者都只有 1px 的线，
   * 宽度和颜色完全一样，差别全在边上：分割线只有一条边，输入框四条边都有。
   * 少了这个字段，输入框会被当成一根粗一点的分割线。
   */
  borderSides: number;
  /** 边框样式，取可见边里第一条的写法。无边框时为空串 */
  borderStyle: string;
  /** 边框颜色，已合成到底色上。无边框时为 null */
  borderColor: string | null;
  /**
   * 投影的计算样式原始值。无投影为 null。
   *
   * 这里存原始串不存解析结果，因为解析和归一属于分析层，要能单测。
   * 计算样式里同一条声明在不同浏览器上可能带着不同的空白和数值写法，
   * 直接按字符串分组会把同一个投影拆成好几条，归一化交给 effects.ts 做。
   */
  shadow: string | null;
  /** 元素外边宽度，px */
  width: number;
  /** 元素外边高度，px。按钮和输入框的高度是很有价值的一档参数 */
  height: number;
  /** 字号，px */
  fontSize: number;
  fontWeight: number;
  fontFamily: string;
}

/** 归一化之后的渐变类型。repeating-* 变体归入同一类，不单独区分 */
export type GradientKind = 'linear' | 'radial' | 'conic';

/** 某一类渐变的出现情况 */
export interface GradientStat {
  kind: GradientKind;
  /** 使用该类渐变的元素数 */
  count: number;
  /** 这些元素的渲染面积合计，px² */
  area: number;
}

/**
 * 背景图像的检测摘要。
 *
 * 这里只做检测和计数，不提取颜色，这是刻意的范围界定而不是能力不足。
 * 原因有三条，都在真实站点上验证过。
 *
 * 一是色标位置可能整个落在元素框之外。Stripe 的招牌渐变写作
 * linear-gradient(270deg, #ffd601 -15%, #ee30fb 315%, #635bff 490%)，
 * 三个色标全部超出 0-100%，元素框只截到中间一段，所以真正看到的颜色
 * 与声明的色标颜色并不一致，取色标会得到页面上根本不存在的值。
 *
 * 二是同一处视觉可能是多个渐变图层叠出来的，还带 blur 和 mix-blend-mode，
 * 声明值到渲染值的映射完全断裂。
 *
 * 三是 canvas 绘制、SVG 涂料服务器、视频背景这几类，在计算样式里
 * 一个颜色声明都没有，getComputedStyle 读到的只是 url(#...) 这种引用。
 *
 * 所以这一层只回答「有没有、有多少、什么类型」，由生成层在散文段把它注明，
 * 让读文件的 AI 知道这块区域不能靠颜色 token 复刻，也不要自己编一个颜色出来。
 */
export interface BackgroundSummary {
  gradient: {
    /** 使用渐变背景的元素数 */
    elementCount: number;
    /**
     * 渐变元素的渲染面积合计，单位是视口面积的倍数，1 表示铺满一屏。
     * 单个元素可以高于一屏，所以这个值可以大于 1。
     */
    viewportAreaRatio: number;
    /** 按类型明细，只含出现过的类型，按出现次数降序 */
    kinds: GradientStat[];
    /** 原始 background-image 值样本，最多 3 条，已截断，用于人工核对 */
    samples: string[];
  };
  /**
   * 以 url() 图片作背景的元素数。与渐变互斥计数，同时具备两者时只记入渐变。
   * 这类背景同样无法从颜色 token 复刻，但它不是本次要解决的问题，只留一个计数。
   */
  imageBackedCount: number;
}

/**
 * 页面结构层面的覆盖范围摘要。
 *
 * 有些页面顶层文档里几乎没有内容，主体在一个 frame 里，或者干脆以嵌入式
 * 文档的形式呈现。这种情况下采集器读到的东西接近于零，结果会是一片空白
 * 加一个白色，看起来像工具坏了，实际是覆盖范围到不了。
 *
 * 这一层只记录结构事实，不解释原因。翻成给用户看的说明由 core/diagnose.ts 负责，
 * 这样判定逻辑可以在 Node 里单测，不必开浏览器。
 */
export interface EmbeddedContentSummary {
  /** 顶层文档的 MIME 类型。正常网页是 text/html */
  contentType: string;
  /**
   * 顶层文档里声明为 PDF 的嵌入对象数。
   * <embed> / <object> 的 type 或 src 指向 pdf 时计入。
   * 这类内容由浏览器内置阅读器渲染，不在网页文档树里。
   */
  pdfEmbeds: number;
  /**
   * 面积达到视口 30% 以上的 frame / iframe 数量。
   * 低于这个量的多半是挂件，不影响主体，不参与「只采到外壳」的判定。
   */
  largeFrames: number;
  /** 上述框架里最大一处的面积占视口的比例，1 表示铺满一屏 */
  largestFrameRatio: number;
  /**
   * 文档是 frameset 结构（用 <frameset> 而不是 <body>）。
   * 这类文档 document.body 为 null，顶层自身不承载任何内容。
   */
  framesetDocument: boolean;
  /**
   * 成功进入并遍历过的同源框架数，含嵌套多层。
   *
   * 同源框架的内容是可以读的，所以这些框架里的元素算在本次采集范围内，
   * 颜色也照常参与统计。这个计数用来区分两种完全不同的处境：
   * 框架读得到但里面也没东西，和框架压根读不到。
   */
  sameOriginFrames: number;
  /**
   * 因为跨域或尚未加载完成而读不到内容的框架数。
   * 这些框架里的内容不在采集范围内，配色也无法参与统计。
   */
  blockedFrames: number;
}

/** 一次页面采集的完整结果，由注入脚本返回给弹窗 */
export interface PageSample {
  url: string;
  title: string;
  viewportWidth: number;
  viewportHeight: number;
  /**
   * 页面底色。取自首屏里绘制面积最大的那个表面，也就是肉眼看到的底色。
   *
   * 它不一定等于 body 上的背景色。很多站点在 body 上声明了不透明底色，
   * 首屏却被一个整屏区块整个盖住，那时两者正好相反。下一步的对比度、
   * 深色浅色判断都以这个值为基准，所以这里必须给视觉结果而不是 DOM 事实。
   */
  canvasColor: string | null;
  /**
   * 文档画布色，也就是 body 上合成出来的那个颜色，什么都不盖时看到的就是它。
   *
   * 和 canvasColor 不一致时，说明首屏被别的色块盖住了。留这个值是为了把
   * 「为什么 body 是白而页面是黑」讲清楚，不要拿它当对比度的基准。
   */
  documentCanvasColor?: string | null;
  /** 文档是否声明了深色配色方案，影响底色兜底值 */
  prefersDark: boolean;
  elements: ElementObservation[];
  /**
   * 直接承载文字的元素，逐条记录排版观测。只含 textChars > 0 的元素。
   * 字段的取样范围和用途见 TypeObservation 的说明。
   */
  typography: TypeObservation[];
  /**
   * 有盒模型间距特征的元素，逐条记录间距观测。只含真正参与版面排布的元素，
   * 收录门槛见 BoxObservation 的说明。
   */
  boxes: BoxObservation[];
  /**
   * 可能构成组件的元素，逐条记录完整的视觉样式。
   * 取样范围和「为什么必须单独一条通道」见 StyleObservation 的说明。
   */
  styles: StyleObservation[];
  /**
   * 页面通过 @font-face 或 FontFace API 显式注册的字体族名。
   *
   * 这是判断「页面用了自定义字体」最直接的证据。浏览器里枚举得到的
   * FontFace 一定来自样式表或脚本，系统预装字体不会出现在这里，
   * 所以有了这个列表就不必靠字体名去猜，也不会把用户自装的字体
   * 误当成网页字体。自定义字体在别人机器上不保证存在，需要配替代方案。
   */
  webFontFamilies: string[];
  /** 渐变与背景图的检测结果。只做检测，不进颜色通道 */
  background: BackgroundSummary;
  /** 结构层面的覆盖范围。采样结果看起来为空时，用来说明原因 */
  embedded: EmbeddedContentSummary;
  /**
   * 全页元素直接承载的文字总字符数。
   *
   * 这是识别「空壳页面」最直接的证据。一个真正承载内容的页面，
   * 直接文字轻松上千；而纯框架的包装页顶层往往一个字都没有。
   * 光看颜色数不够，因为空壳页面照样会有白色底和默认黑字两个角色。
   */
  textCharsTotal: number;
  /** 因为不可见或零面积被跳过的元素数 */
  skipped: number;
  /** 实际遍历到的元素数 */
  visited: number;
  /** 命中元素上限，结果可能不完整 */
  truncated: boolean;
  elapsedMs: number;
}

/**
 * 一次高亮的请求参数。
 *
 * 分组的理由是最上面的那个用例：一个颜色角色同时在背景、文字、边框三个
 * 渠道上有证据，按渠道分成三组之后，画上去的颜色不同，用户一眼就能看出
 * 「这 12 个是把它当背景的，那 8 个是拿它当文字色的」。单独点某一条渠道
 * 时只有一组，走的是同一条路径。
 */
export interface HighlightGroup {
  /** 这一组的说明，例如「作背景」 */
  label: string;
  /** 这一组画什么颜色，十六进制 */
  color: string;
  /** 元素在采集注册表里的下标 */
  refs: number[];
}

export interface HighlightCommand {
  /**
   * apply 描边，clear 擦掉，locate 把已描边的第一处滚进视口。
   *
   * locate 单独成一个动作而不是由弹窗自己去滚页面，是因为滚动必须发生在
   * 页面里，而元素引用只存在于页面的隔离世界。定位到哪一处也只能由那边
   * 决定，否则弹窗得自己拿一份元素列表，那份列表不可能和页面上的同步。
   */
  action: 'apply' | 'clear' | 'locate';
  /** action 为 apply 时必填 */
  groups?: HighlightGroup[];
  /** 浮层上第一行的结论，例如「主色 #2563EB」 */
  title?: string;
  /** 浮层上第二行的明细，例如「作背景 12 处 · 作文字 8 处」 */
  subtitle?: string;
}

/**
 * 高亮的结果。
 *
 * missing 单独报出来而不是并进 highlighted，因为「注册表里有 12 个，
 * 但只有 10 个还挂在页面上」是一件必须让用户知道的事。页面在弹出面板
 * 打开之后仍然会继续变化，单页应用路由一跳，原来那些元素就都不在了，
 * 这时候如果只说「已高亮 10 处」，用户会以为工具数错了。
 */
export interface HighlightResult {
  ok: boolean;
  /** 实际画上去的元素数 */
  highlighted: number;
  /** 已经不在页面上的元素数 */
  missing: number;
  /** 拿不到上一次采集留下的元素注册表，通常意味着页面已经刷新过 */
  stale: boolean;
  /** 出错时的说明，ok 为 true 时为空串 */
  reason: string;
}
