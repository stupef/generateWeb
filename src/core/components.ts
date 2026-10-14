import { buttonVariantOf, type ButtonVariant } from './button-variant';
import { contrastRatio } from './color-math';
import { KIND_LABEL } from './kinds';
import { numOf, padXOf, padYOf, radiusKeyOf, radiusTextOf, refineKind, strOf } from './observation';
import type { PageSample, StyleObservation } from './types';

/** 同一个组件的外观写法达到几种就该提醒一句 */
const SPREAD_NOTE_AT = 2;

/** 样本少于这个数时，结论要打折扣并告知使用者 */
const THIN_SAMPLE = 6;

// ---------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------

export type ComponentKind = 'button' | 'input' | 'card' | 'nav';

/** 组件类别的排列顺序，界面上按这个顺序铺 */
export const COMPONENT_ORDER: ComponentKind[] = ['button', 'input', 'nav', 'card'];

export { buttonVariantOf };
export type { ButtonVariant };

export const VARIANT_LABEL: Record<ButtonVariant, string> = {
  primary: '主按钮',
  secondary: '次按钮',
  ghost: '幽灵按钮',
};

/**
 * 一个组件在视觉上要用到的全部参数。
 *
 * 单独提出来是因为四类组件（三种按钮、输入框、导航栏、卡片）都要这一套，
 * 各写一遍会出现四处几乎相同的二十行取值，改一个字段要改四遍。
 */
export interface ComponentStyle {
  backgroundColor: string | null;
  textColor: string | null;
  /** 文字与底色的对比度。两者有一个缺失时为 null */
  textContrast: number | null;
  radius: number;
  paddingX: number;
  paddingY: number;
  borderWidth: number;
  borderSides: number;
  borderColor: string | null;
  borderStyle: string;
  shadow: string | null;
  fontSize: number;
  fontWeight: number;
  fontFamily: string;
  /** 元素高度，px */
  height: number;
}

export interface ComponentSpec extends ComponentStyle {
  kind: ComponentKind;
  /** 展示用名字。按钮会带上主次变体 */
  label: string;
  /** 按钮的主次变体，其它类型为 null */
  variant: ButtonVariant | null;
  /** 页面上命中的元素数 */
  count: number;
  /** 这个组件的外观在页面上有几种写法 */
  signatureCount: number;
  /** 用途与使用规则，会直接写进生成的文件 */
  usage: string;
  confidence: 'high' | 'medium' | 'low';
}

export type ComponentsNoteKind =
  | 'variant-spread'
  | 'few-kinds'
  | 'thin-sample'
  | 'nav-links'
  | 'inherited-text';

export interface ComponentsNote {
  kind: ComponentsNoteKind;
  text: string;
}

export interface ComponentsAnalysis {
  /** 识别出的组件，顺序是按钮（主、次、幽灵）、输入框、导航栏、卡片 */
  specs: ComponentSpec[];
  notes: ComponentsNote[];
  /** 进入候选通道的元素总数 */
  sampleCount: number;
  /** 识别出的组件类别数，按钮的三种变体算同一类 */
  kindCount: number;
}

/** 取出现次数最多的字符串，平票时取先出现的那个 */
function modeOf(values: string[]): string {
  const count = new Map<string, number>();
  for (const v of values) count.set(v, (count.get(v) ?? 0) + 1);
  let best = '';
  let bestCount = -1;
  for (const [v, c] of count) {
    if (c > bestCount) {
      best = v;
      bestCount = c;
    }
  }
  return best;
}

/** 中位数。取中位数而不是平均数，个别极端的元素不会把代表值拽走 */
function medianOf(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  const lo = sorted[mid - 1] ?? 0;
  const hi = sorted[mid] ?? 0;
  return Math.round((lo + hi) / 2);
}

/**
 * 按钮签名组的视觉重量分。
 *
 * 单纯比人数会把导航里一堆小图标按钮抬成主按钮。真正主按钮通常
 * 带文字、尺寸大、不在导航里；把这三条量化之后，1 个 CTA 也能赢过
 * 一堆图标。
 */
function buttonGroupScore(list: StyleObservation[]): number {
  const first = list[0];
  if (!first) return 0;
  const sizeScore = Math.min(numOf(first.height) / 32, 1.5) + Math.min(padYOf(first) / 10, 1);
  const textScore = list.some((x) => numOf(x.textChars) > 0) ? 2.5 : 0;
  const navPenalty = first.inNav ? 1.5 : 0;
  return sizeScore + textScore - navPenalty + Math.min(list.length, 4) * 0.25;
}

/**
 * 一组元素的外观签名。
 *
 * 用法是先把完全同款式的元素聚在一起，再取人数最多的那一组当代表。
 * 不按单个字段各取众数，因为那样会拼出一个页面上不存在的组合
 * （底色来自一个按钮、圆角来自另一个），而这份参数是要拿去照抄的。
 */
function signatureOf(s: StyleObservation, variant: ButtonVariant | null): string {
  return [
    variant ?? '-',
    strOf(s.backgroundColor) ?? 'none',
    radiusKeyOf(s.radius),
    padXOf(s),
    padYOf(s),
    numOf(s.borderWidth),
    numOf(s.borderSides),
    strOf(s.borderColor) ?? 'none',
    strOf(s.shadow) ?? 'none',
    numOf(s.fontSize),
    numOf(s.fontWeight, 400),
  ].join('|');
}

/**
 * 从同款式的这一组元素上取出一套参数。
 *
 * 取值时区分两种情况：写进签名的字段在这一组里必然完全一致，直接取
 * 第一个元素的值；没写进签名的字段（字体族、高度）则要再取一次众数
 * 和中位数，否则会因为取到了组里那个极端值而失真。
 */
function styleOf(group: StyleObservation[]): ComponentStyle | null {
  const first = group[0];
  if (!first) return null;

  const backgroundColor = strOf(first.backgroundColor);
  const textColor = strOf(first.textColor);
  const borderColor = strOf(first.borderColor);

  return {
    backgroundColor,
    textColor,
    textContrast:
      textColor && backgroundColor
        ? Number(contrastRatio(textColor, backgroundColor).toFixed(2))
        : null,
    radius: radiusKeyOf(first.radius),
    paddingX: padXOf(first),
    paddingY: padYOf(first),
    borderWidth: numOf(first.borderWidth),
    borderSides: numOf(first.borderSides),
    borderColor,
    borderStyle: strOf(first.borderStyle) ?? 'solid',
    shadow: strOf(first.shadow),
    fontSize: numOf(first.fontSize),
    fontWeight: numOf(first.fontWeight, 400),
    fontFamily: modeOf(group.map((x) => String(x.fontFamily ?? ''))),
    height: medianOf(group.map((x) => Math.round(numOf(x.height)))),
  };
}

/**
 * 从一组元素里挑出人数最多的那个款式。
 *
 * 返回整组而不只是挑出的那一个：字体族和高度不在签名里，要在同款式的
 * 这几个元素上再取一次众数和中位数才稳。
 */
function pickRepresentative(
  group: StyleObservation[],
): { style: ComponentStyle; count: number; signatureCount: number; hasOwnText: boolean } | null {
  if (group.length === 0) return null;

  const bySignature = new Map<string, StyleObservation[]>();
  for (const s of group) {
    const key = signatureOf(s, null);
    const list = bySignature.get(key);
    if (list) list.push(s);
    else bySignature.set(key, [s]);
  }

  let rep: StyleObservation[] | null = null;
  for (const list of bySignature.values()) {
    if (!rep || list.length > rep.length) rep = list;
  }
  if (!rep) return null;

  const style = styleOf(rep);
  if (!style) return null;

  let hasOwnText = false;
  for (const x of rep) {
    if (numOf(x.textChars) > 0) {
      hasOwnText = true;
      break;
    }
  }

  return { style, count: rep.length, signatureCount: bySignature.size, hasOwnText };
}

// ---------------------------------------------------------------------
// 按钮变体
// ---------------------------------------------------------------------

// ---------------------------------------------------------------------
// 用途说明
// ---------------------------------------------------------------------

/**
 * 文字与底色对比度的一句话结论。
 *
 * 这一条是复刻时最容易照抄出错的地方：一个按钮的底色和文字色单独看都
 * 没问题，配在一起却读不清。把数字和结论直接写进说明里，比留给使用者
 * 自己去算要可靠。
 */
function contrastNote(textColor: string | null, backgroundColor: string | null): string {
  if (!textColor || !backgroundColor) return '';
  const v = Number(contrastRatio(textColor, backgroundColor).toFixed(2));
  if (v >= 4.5) return `文字和底色的对比度是 ${v}:1，正文级可读性达标。`;
  if (v >= 3) return `文字和底色的对比度是 ${v}:1，达到大字号的最低要求，正文字号下会偏吃力。`;
  return `文字和底色的对比度只有 ${v}:1，低于 3:1，这个组合在小字号下几乎读不清，复刻时先解决这一条。`;
}

function describeButton(variant: ButtonVariant, c: ComponentStyle): string {
  const size = `圆角${radiusTextOf(c.radius)}，内边距左右 ${c.paddingX}px、上下 ${c.paddingY}px，高约 ${c.height}px。`;
  const contrast = contrastNote(c.textColor, c.backgroundColor);

  if (variant === 'primary') {
    return (
      `页面最主要的那一个动作按钮，实心填充、没有看得见的描边，全页视觉最重。` +
      size +
      `全页只应该有一个主按钮，用在最想让用户点的那个动作上。` +
      contrast
    );
  }
  if (variant === 'secondary') {
    return (
      `次要动作按钮，填充贴着页面底色或者另有一圈看得见的描边，视觉重量比主按钮轻一档。` +
      size +
      `用在和主操作并列、但不希望被优先点的位置，比如取消、返回、次要筛选。` +
      contrast
    );
  }
  return (
    `没有填充的按钮，只靠文字或一圈描边存在，视觉重量最轻。` +
    size +
    `用在工具栏、列表行内、导航项这类重复出现且不需要强调的地方，和主按钮挨着放也不会抢。` +
    contrast
  );
}

function describeInput(c: ComponentStyle): string {
  const borderText =
    c.borderWidth > 0 && c.borderSides >= 4
      ? `四边有 ${c.borderWidth}px 的描边`
      : c.borderWidth > 0
        ? `只有 ${c.borderSides} 条边有描边，不是完整的框`
        : '没有描边，只靠底色和页面底色区分';

  return (
    `输入框，${borderText}，圆角${radiusTextOf(c.radius)}，内边距左右 ${c.paddingX}px、上下 ${c.paddingY}px，高约 ${c.height}px。` +
    `输入框的圆角通常比按钮小一档，长条形的框用大圆角会显得松。` +
    contrastNote(c.textColor, c.backgroundColor)
  );
}

function describeCard(c: ComponentStyle): string {
  const separation =
    c.shadow !== null
      ? '靠投影和底色一起从页面底上分出来'
      : c.borderWidth > 0
        ? '靠描边和底色从页面底上分出来，没有用投影'
        : '只靠底色和页面底色的差别分出来，没有描边也没有投影';

  return (
    `卡片，${separation}。圆角${radiusTextOf(c.radius)}，内边距左右 ${c.paddingX}px、上下 ${c.paddingY}px。` +
    `卡片内部不要再套一层同色底的卡片，层级一多整套样式会糊成一片。`
  );
}

function describeNav(c: ComponentStyle): string {
  const separation =
    c.shadow !== null
      ? '靠投影和下方内容分开'
      : c.borderWidth > 0
        ? '靠一条底边线和下方内容分开'
        : '没有分界线，靠底色差别和留白分开';

  return (
    `导航栏，高约 ${c.height}px，上下内边距 ${c.paddingY}px，${separation}。` +
    `导航栏的高度决定整站页面的顶部留白，复刻时先把这个值定下来，其余区块的位置都好推。`
  );
}

// ---------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------

function confidenceOf(signatureCount: number, count: number): 'high' | 'medium' | 'low' {
  if (signatureCount === 1 && count >= 3) return 'high';
  if (count >= 2) return 'medium';
  return 'low';
}

/**
 * 组件风格识别。
 *
 * 只输出页面上真实存在的组件。这不是一句口号，实现上体现为整段逻辑
 * 都是「先找元素，再按找到的元素生成结论」，没有任何一处是「先准备
 * 一份默认参数，没找到就用默认值填」。找不到就是没有，不填。
 */
export function analyzeComponents(sample: PageSample): ComponentsAnalysis {
  const styles = Array.isArray(sample.styles) ? sample.styles : [];
  const canvasColor = strOf(sample.canvasColor);
  const viewportWidth = numOf(sample.viewportWidth, 0);

  const specs: ComponentSpec[] = [];
  const notes: ComponentsNote[] = [];

  if (styles.length === 0) {
    return {
      specs,
      notes: [
        {
          kind: 'few-kinds',
          text: '这一页没有读到任何可能构成组件的元素。页面主体可能渲染在图片或 canvas 里，或者内容全在跨域框架中，样式读不到。',
        },
      ],
      sampleCount: 0,
      kindCount: 0,
    };
  }

  // --- 1. 按钮，先分主次，再按外观聚组 ---------------------------------
  // 导航栏和卡片是容器，本身通常一个字都不带，报出来的文字色是按继承
  // 规则算的。这不是错，但必须说明，否则读的人会把页面正文色当成导航
  // 链接的颜色照抄过去，而链接色往往是另一回事。
  const inheritedTextLabels: string[] = [];

  const buttonGroups = new Map<ButtonVariant, StyleObservation[]>();
  for (const s of styles) {
    if (!s || s.kind !== 'button') continue;
    const variant = buttonVariantOf(s, canvasColor);
    const list = buttonGroups.get(variant);
    if (list) list.push(s);
    else buttonGroups.set(variant, [s]);
  }

  const buttonOrder: ButtonVariant[] = ['primary', 'secondary', 'ghost'];

  for (const variant of buttonOrder) {
    const group = buttonGroups.get(variant);
    if (!group || group.length === 0) continue;

    const bySignature = new Map<string, StyleObservation[]>();
    for (const s of group) {
      const key = signatureOf(s, variant);
      const list = bySignature.get(key);
      if (list) list.push(s);
      else bySignature.set(key, [s]);
    }
    // 取视觉上最像主按钮的那一组当代表。人数多不代表权重高，
    // 带文字、尺寸大、不在导航里的组优先，否则导航图标按钮会淹没真实 CTA。
    let rep: StyleObservation[] | null = null;
    let bestScore = -Infinity;
    for (const list of bySignature.values()) {
      const score = buttonGroupScore(list);
      if (!rep || score > bestScore) {
        rep = list;
        bestScore = score;
      }
    }
    if (!rep) continue;
    const style = styleOf(rep);
    if (!style) continue;

    specs.push({
      kind: 'button',
      label: VARIANT_LABEL[variant],
      variant,
      count: group.length,
      ...style,
      signatureCount: bySignature.size,
      usage: describeButton(variant, style),
      confidence: confidenceOf(bySignature.size, group.length),
    });

    if (bySignature.size >= SPREAD_NOTE_AT) {
      notes.push({
        kind: 'variant-spread',
        text: `${VARIANT_LABEL[variant]}在页面上有 ${bySignature.size} 种不同的样式写法，下面列的是出现最多的那一种。另一种多半是状态（悬停、禁用）或者不同区块里的微调，复刻时先照下面这套来。`,
      });
    }

    // 导航里的链接常常被样式化成按钮的样子。它们确实是按钮形态，
    // 但角色不是「页面里的一个动作」。混在一起报出去，复刻的人会
    // 以为页面上有好几个主操作按钮
    let inNavCount = 0;
    for (const s of group) if (s.inNav) inNavCount++;
    if (inNavCount / group.length >= 0.6) {
      notes.push({
        kind: 'nav-links',
        text: `${VARIANT_LABEL[variant]}里有一大半（${inNavCount} 个）出现在导航栏内，它们的实际角色是导航项而不是页面里的独立按钮。复刻时按导航项的用法处理，不要当成主操作按钮。`,
      });
    }
  }

  // --- 2. 输入框 -------------------------------------------------------
  const inputs = styles.filter((s) => s && s.kind === 'input');
  const inputRep = pickRepresentative(inputs);
  if (inputRep) {
    specs.push({
      kind: 'input',
      label: KIND_LABEL.input,
      variant: null,
      count: inputs.length,
      ...inputRep.style,
      signatureCount: inputRep.signatureCount,
      usage: describeInput(inputRep.style),
      confidence: confidenceOf(inputRep.signatureCount, inputs.length),
    });

    if (inputRep.signatureCount >= SPREAD_NOTE_AT) {
      notes.push({
        kind: 'variant-spread',
        text: `输入框在页面上有 ${inputRep.signatureCount} 种写法，下面列的是出现最多的那一种。搜索框、多行文本框和普通输入框的参数常常不同，复刻时按用途分别取。`,
      });
    }
  }

  // --- 3. 导航栏 -------------------------------------------------------
  const navs = styles.filter((s) => s && s.kind === 'nav');
  const navRep = pickRepresentative(navs);
  if (navRep) {
    specs.push({
      kind: 'nav',
      label: KIND_LABEL.nav,
      variant: null,
      count: navs.length,
      ...navRep.style,
      signatureCount: navRep.signatureCount,
      usage: describeNav(navRep.style),
      confidence: confidenceOf(navRep.signatureCount, navs.length),
    });
    if (!navRep.hasOwnText) inheritedTextLabels.push(KIND_LABEL.nav);
  }

  // --- 4. 卡片 ---------------------------------------------------------
  //
  // 卡片这一类的判据不在这里写。采集层给的是「看起来像一块表面」这个
  // 宽口径，里面混着徽标、头像、状态点，而圆角按元素类型归组时用的是
  // 同一条通道。判据写成两份早晚会分叉，分叉之后的表现是「同一个元素
  // 在圆角那一块算卡片、在组件这一块不算」，从结果上很难看出来。
  // 所以两组都走 observation.ts 里的那一条。
  const cards = styles.filter((s) => s && refineKind(s, viewportWidth) === 'card');

  const cardRep = pickRepresentative(cards);
  if (cardRep) {
    specs.push({
      kind: 'card',
      label: KIND_LABEL.card,
      variant: null,
      count: cards.length,
      ...cardRep.style,
      signatureCount: cardRep.signatureCount,
      usage: describeCard(cardRep.style),
      confidence: confidenceOf(cardRep.signatureCount, cards.length),
    });
    if (!cardRep.hasOwnText) inheritedTextLabels.push(KIND_LABEL.card);

    if (cardRep.signatureCount >= SPREAD_NOTE_AT) {
      notes.push({
        kind: 'variant-spread',
        text: `卡片在页面上有 ${cardRep.signatureCount} 种写法，下面列的是数量最多的那一种。不同区块的卡片内边距常常不一样，复刻时按内容密度挑。`,
      });
    }
  }

  // --- 5. 需要主动说明的情况 -------------------------------------------
  if (inheritedTextLabels.length > 0) {
    notes.push({
      kind: 'inherited-text',
      text:
        `${inheritedTextLabels.join('和')}是容器，自己不带文字，上面给它们的文字色是按继承规则算出来的，` +
        '也就是里面的文字最终会显示成什么颜色。它不等于这个容器里各类内容的颜色：' +
        '导航栏里的链接、卡片里的标题和正文往往各自有各自的颜色。复刻时这一项只用来定容器的默认文字色，' +
        '容器内部的具体文字颜色要按各自的组件和层级另定。',
    });
  }

  const kinds = new Set<ComponentKind>();
  for (const s of specs) kinds.add(s.kind);
  const kindCount = kinds.size;

  if (kindCount === 0) {
    notes.push({
      kind: 'few-kinds',
      text: '没有识别出可描述的组件。这一页可能本身是一篇纯文字内容，也可能是样式全部来自图片，没有可读的组件参数。',
    });
  } else if (kindCount < 3) {
    notes.push({
      kind: 'few-kinds',
      text: `只识别出 ${kindCount} 类组件。这不一定说明页面缺组件，也可能只是这个页面的类型比较单一（比如一篇文档只有正文和链接）。复刻前先确认页面上确实没有其余几类。`,
    });
  }

  if (styles.length < THIN_SAMPLE) {
    notes.push({
      kind: 'thin-sample',
      text: `候选元素只有 ${styles.length} 个，样本偏少，组件的代表参数需要人工再对一眼。`,
    });
  }

  return { specs, notes, sampleCount: styles.length, kindCount };
}
