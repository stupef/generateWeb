import type { ElementObservation, PageSample } from './types';
import { contrastRatio, hexToRgb, srgbToLinear } from './color-math';

export { contrastRatio, hexToRgb } from './color-math';

/**
 * 色簇合并阈值，单位是 OKLab 空间的欧氏距离。
 *
 * 这是整个分析层最需要校准的旋钮。0.008 不是拍的，是用两组样本量出来的：
 *   必须合并的同色不同写法，最大距离 0.00434（#1a1a1a vs #1b1b1b）
 *   必须区分的不同层级，最小距离 0.01547（#ffffff vs #f9fafb）
 * 取 0.008 落在两者之间，距下限 1.84 倍、距上限 1.93 倍，两边余量对称。
 *
 * 调这个值之前先想清楚要往哪边偏：
 *   调大 → 更激进的降噪，但会把画布色和卡片色这种真实层级吞掉
 *   调小 → 保住所有层级，但同色不同写法会重复出现在结果里
 */
export const MERGE_THRESHOLD = 0.008;

/** 一个颜色至少承载这么多字符，才够格参与文字角色的竞争 */
const MIN_TEXT_CHARS = 12;
/** 至少被这么多元素用作背景，才算一层真实的表面 */
const MIN_SURFACE_COUNT = 2;
/** 至少被这么多元素用作边框，才算系统级的分隔线 */
const MIN_BORDER_COUNT = 3;
/** 背景面积占比低于这个值，且没有其他信号，判定为噪声 */
const MIN_BG_SHARE = 0.002;

/**
 * 与页面底色的对比度低于这个值，就认为屏幕上分不出差别，需要明确告知用户。
 *
 * 1.2 不是拍的。Linear 深色主题里存在 7 级近黑背景，从 #08090a 到 #191d20，
 * 整条阶梯首尾的对比度只有 1.175:1，1.2 正好把整条阶梯覆盖进来。
 */
export const NEAR_CANVAS_CONTRAST = 1.2;

export interface ColorEvidence {
  /** 作为背景出现的元素数 */
  backgroundCount: number;
  /** 作为背景覆盖的页面面积占比，0-1 */
  backgroundShare: number;
  /**
   * 拿这个颜色当文字色的元素数。
   *
   * 字符数回答的是「这层文字占多大比重」，元素数回答的是「有几个元素」。
   * 后者单独记一份，是为了让界面上的数字可核对：溯源高亮描出来的元素数
   * 必须和界面上写着的那个数相等，而只报字符占比的话，那种核对无从下手。
   */
  textCount: number;
  /** 作为文字承载的字符数 */
  textChars: number;
  /** 占全页文字的字符占比，0-1 */
  textShare: number;
  /** 作为边框出现的元素数 */
  borderCount: number;
  /** 出现在可点击控件上的次数 */
  controlCount: number;
  /** 被识别为按钮的填充背景色使用次数 */
  buttonBackgroundCount: number;
}

/**
 * 与页面底色几乎同色时的提示。
 *
 * 这个字段存在的理由是「调阈值」解决不了这类问题。OKLab 的明度取线性亮度的
 * 立方根，在近黑处导数发散，会把 #08090a 与 #101112 这种屏幕上分不出来的差别
 * 算成 0.03798 的距离——同一个距离落在中灰区就是 #808080 到 #8b8b8b，那是肉眼
 * 明显可见的一步。可是同一对浅色 #ffffff / #f9fafb 的 WCAG 对比度反而更小
 * （1.045 对 1.054），所以没有任何单一指标能同时做到「合并深色、保留浅色」。
 *
 * 指标本身就做不到，就不要去动阈值。上次把 #f9fafb 并进 #ffffff 正是阈值偏大
 * 造成的，层级丢失比多一个色值严重得多。改成把判据交给用户。
 */
export interface NearCanvasNote {
  /** 与页面底色的 WCAG 对比度 */
  ratio: number;
  /** 可直接渲染的解释文字，最终也会进入生成的文件 */
  text: string;
}

export interface ColorRole {
  /** DESIGN.md 里的 token 名 */
  token: string;
  /** 中文角色名，用在界面和说明文案里 */
  label: string;
  hex: string;
  /** 用途说明，这一层不接模型时由启发式句式生成 */
  usage: string;
  evidence: ColorEvidence;
  /** 这个色簇合并掉了哪些相近色 */
  mergedFrom: { hex: string; count: number }[];
  /** 与页面底色的 WCAG 对比度 */
  contrastWithCanvas: number;
  /** 与页面底色几乎同色时的提示。null 表示不需要提示 */
  nearCanvas: NearCanvasNote | null;
  confidence: 'high' | 'medium' | 'low';
}

export interface DiscardedColor {
  hex: string;
  count: number;
  reason: string;
}

export interface ColorAnalysis {
  canvasHex: string;
  isDark: boolean;
  roles: ColorRole[];
  discarded: DiscardedColor[];
  /** 合并后的色簇数 */
  clusterCount: number;
  /** 合并前的原始颜色数，两个数字的差距就是降噪效果 */
  rawColorCount: number;
}

// ---------------------------------------------------------------------
// 颜色数学
// ---------------------------------------------------------------------

interface Lab {
  L: number;
  a: number;
  b: number;
}

function relativeLuminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

function toOklab(hex: string): Lab {
  const { r, g, b } = hexToRgb(hex);
  const R = srgbToLinear(r);
  const G = srgbToLinear(g);
  const B = srgbToLinear(b);

  const l = 0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B;
  const m = 0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B;
  const s = 0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B;

  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);

  return {
    L: 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    a: 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    b: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
  };
}

function labDistance(x: Lab, y: Lab): number {
  const dL = x.L - y.L;
  const da = x.a - y.a;
  const db = x.b - y.b;
  return Math.sqrt(dL * dL + da * da + db * db);
}

/** token 名到「这一层到底是什么」的白话说法，只用于近色提示的措辞 */
const LAYER_WORD: Record<string, string> = {
  neutral: '页面基底本身',
  primary: '正文文字层级',
  secondary: '次要文字层级',
  tertiary: '强调层级',
  surface: '卡片与区块底色',
  border: '描边与分隔线',
};

/**
 * 判断某个角色是不是和页面底色几乎同色，是的话生成一段解释。
 *
 * 措辞刻意分成三句，因为用户看到两个近乎一样的色值时会问三个问题：
 * 差多少（给对比度数字）、为什么没合并（说明是真实层级）、要不要留（给动作）。
 * 只甩一个数字是不够的，1.05 摆在面前读不出「看不出差别」这层含义。
 */
export function describeNearCanvas(
  hex: string,
  canvasHex: string,
  token: string,
): NearCanvasNote | null {
  const ratio = Number(contrastRatio(hex, canvasHex).toFixed(2));
  // 页面底色跟自己比永远是 1:1，不需要提示
  if (ratio <= 1.01 || ratio > NEAR_CANVAS_CONTRAST) return null;

  const word = LAYER_WORD[token] ?? '这一层级';
  return {
    ratio,
    text:
      `与页面底色的对比度只有 ${ratio}:1，在多数显示器上看不出差别。` +
      `它没有跟底色合并，是因为这属于页面真实存在的层级关系（${word}）。` +
      `如果你不需要这一级细微层次，可以只保留一个。`,
  };
}

// ---------------------------------------------------------------------
// 通道判据
//
// 这三条判据定义一个元素有没有把某个颜色用在背景、文字、边框上，也就是
// 颜色通道的全部取样口径。导出给 provenance.ts 用，理由是界面上写着
// 「作背景 12 处」，点开之后描出来的也必须正好是那 12 个。判据各写一份
// 的话两边会在边缘情况上错开（少了直接文字的元素算不算、没有可见边框的
// 元素算不算），而错开的表现只是差一两个元素，看起来像漏了一处，
// 几乎不可能从结果上发现。
// ---------------------------------------------------------------------

/** 元素自己定义的背景色。null 表示它没定义表面，透明不算 */
export function backgroundHexOf(el: ElementObservation): string | null {
  return el.backgroundColor ? el.backgroundColor.toLowerCase() : null;
}

/**
 * 元素的文字色。只统计直接承载文字的元素。
 *
 * 容器也会读到继承来的 color，但把它算进文字色会把主要文字色的证据
 * 稀释成一堆没有文字的元素，所以这里要求这个元素自己有文字。
 */
export function textHexOf(el: ElementObservation): string | null {
  return el.textColor && el.textChars > 0 ? el.textColor.toLowerCase() : null;
}

/** 元素的可见边框色。没有可见边框宽度的不算 */
export function borderHexOf(el: ElementObservation): string | null {
  return el.borderColor && el.borderWidth > 0 ? el.borderColor.toLowerCase() : null;
}

// ---------------------------------------------------------------------
// 聚合与聚类
// ---------------------------------------------------------------------

interface Acc {
  bgCount: number;
  bgArea: number;
  controlBgCount: number;
  controlBgArea: number;
  textCount: number;
  textChars: number;
  borderCount: number;
  controlCount: number;
  buttonBackgroundCount: number;
  totalCount: number;
}

function emptyAcc(): Acc {
  return {
    bgCount: 0,
    bgArea: 0,
    controlBgCount: 0,
    controlBgArea: 0,
    textCount: 0,
    textChars: 0,
    borderCount: 0,
    controlCount: 0,
    buttonBackgroundCount: 0,
    totalCount: 0,
  };
}

interface Cluster {
  /** 代表色。取簇内权重最高的那个原始色，而不是均值，
   *  这样输出的色值就是页面真实用过的，不会被平均成没人用过的颜色 */
  hex: string;
  lab: Lab;
  weight: number;
  acc: Acc;
  members: { hex: string; count: number }[];
}

/**
 * 把页面上出现过的颜色按感知距离聚成若干簇。
 * 用 leader 聚类：按权重从高到低扫，能贴到已有簇代表色的就并入，否则自己开一簇。
 * 顺序确定，结果可复现。
 */
function cluster(acc: Map<string, Acc>, weights: Map<string, number>): Cluster[] {
  const entries = [...acc.entries()].map(([hex, a]) => ({
    hex,
    acc: a,
    weight: weights.get(hex) ?? 0,
    lab: toOklab(hex),
  }));
  entries.sort((x, y) => y.weight - x.weight);

  const clusters: Cluster[] = [];

  for (const entry of entries) {
    let target: Cluster | null = null;
    let best = Infinity;

    for (const c of clusters) {
      const d = labDistance(entry.lab, c.lab);
      if (d < MERGE_THRESHOLD && d < best) {
        best = d;
        target = c;
      }
    }

    if (target) {
      target.acc.bgCount += entry.acc.bgCount;
      target.acc.bgArea += entry.acc.bgArea;
      target.acc.controlBgCount += entry.acc.controlBgCount;
      target.acc.controlBgArea += entry.acc.controlBgArea;
      target.acc.textCount += entry.acc.textCount;
      target.acc.textChars += entry.acc.textChars;
      target.acc.borderCount += entry.acc.borderCount;
      target.acc.controlCount += entry.acc.controlCount;
      target.acc.buttonBackgroundCount += entry.acc.buttonBackgroundCount;
      target.acc.totalCount += entry.acc.totalCount;
      target.weight += entry.weight;
      target.members.push({ hex: entry.hex, count: entry.acc.totalCount });
    } else {
      clusters.push({
        hex: entry.hex,
        lab: entry.lab,
        weight: entry.weight,
        acc: { ...entry.acc },
        members: [{ hex: entry.hex, count: entry.acc.totalCount }],
      });
    }
  }

  return clusters;
}

// ---------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------

export function analyzeColors(sample: PageSample): ColorAnalysis {
  // --- 1. 按用途分通道累计证据 ---------------------------------------
  const acc = new Map<string, Acc>();

  const bump = (hex: string): Acc => {
    let a = acc.get(hex);
    if (!a) {
      a = emptyAcc();
      acc.set(hex, a);
    }
    return a;
  };

  let totalBgArea = 0;
  let totalChars = 0;
  let totalBorder = 0;
  let totalControl = 0;

  for (const el of sample.elements) {
    const background = backgroundHexOf(el);
    if (background) {
      const a = bump(background);
      a.bgCount++;
      a.bgArea += el.area;
      if (el.isControl) {
        a.controlBgCount++;
        a.controlBgArea += el.area;
      }
      a.totalCount++;
      totalBgArea += el.area;
      if (el.isControl) {
        a.controlCount++;
        totalControl++;
      }
    }

    const text = textHexOf(el);
    if (text) {
      const a = bump(text);
      a.textCount++;
      a.textChars += el.textChars;
      a.totalCount++;
      totalChars += el.textChars;
    }

    const border = borderHexOf(el);
    if (border) {
      const a = bump(border);
      a.borderCount++;
      a.totalCount++;
      totalBorder++;
      if (el.isControl) {
        a.controlCount++;
        totalControl++;
      }
    }
  }

  // 主操作色取按钮填充背景中出现次数最多的颜色。链接文字、边框和装饰色不参与。
  const buttonRefs = new Set(
    sample.styles.filter((style) => style.kind === 'button').map((style) => style.ref),
  );
  for (const el of sample.elements) {
    if (!buttonRefs.has(el.ref) || !el.backgroundColor) continue;
    bump(el.backgroundColor.toLowerCase()).buttonBackgroundCount++;
  }

  const canvasHex = sample.canvasColor ?? '#ffffff';
  if (totalBgArea === 0) {
    // 全页没有任何元素自设背景，把底色作为唯一背景证据补进去
    const a = bump(canvasHex);
    a.bgCount = 1;
    a.bgArea = sample.viewportWidth * sample.viewportHeight;
    a.totalCount = 1;
    totalBgArea = a.bgArea;
  }

  const safe = (n: number, d: number) => (d > 0 ? n / d : 0);

  // --- 2. 权重。只用于排序和挑簇代表色，不影响输出的色值 -------------
  const weights = new Map<string, number>();
  for (const [hex, a] of acc) {
    weights.set(
      hex,
      safe(a.bgArea, totalBgArea) * 1.0 +
        safe(a.textChars, totalChars) * 1.0 +
        safe(a.borderCount, totalBorder) * 0.4 +
        safe(a.controlCount, totalControl) * 0.6,
    );
  }

  const rawColorCount = acc.size;
  const clusters = cluster(acc, weights);

  // --- 3. 定位页面底色所在的簇 ---------------------------------------
  const canvasCluster =
    clusters.find((c) => c.members.some((m) => m.hex === canvasHex)) ??
    [...clusters].sort((x, y) => y.acc.bgArea - x.acc.bgArea)[0];

  const isDark = relativeLuminance(canvasHex) < 0.35;

  const evidenceOf = (c: Cluster, canvasRole = false): ColorEvidence => ({
    // The canvas token describes page surfaces, not a button that happens to reuse
    // the same fill. Keep control uses in palette evidence, but separate them from
    // the page-background role and its provenance count.
    backgroundCount: c.acc.bgCount - (canvasRole ? c.acc.controlBgCount : 0),
    backgroundShare: safe(c.acc.bgArea - (canvasRole ? c.acc.controlBgArea : 0), totalBgArea),
    textCount: c.acc.textCount,
    textChars: c.acc.textChars,
    textShare: safe(c.acc.textChars, totalChars),
    borderCount: c.acc.borderCount,
    controlCount: c.acc.controlCount,
    buttonBackgroundCount: c.acc.buttonBackgroundCount,
  });

  const makeRole = (
    token: string,
    label: string,
    c: Cluster,
    confidence: ColorRole['confidence'],
    usage: string,
    canvasRole = false,
  ): ColorRole => ({
    token,
    label,
    hex: c.hex,
    usage,
    evidence: evidenceOf(c, canvasRole),
    mergedFrom: c.members.filter((m) => m.hex !== c.hex),
    contrastWithCanvas: Number(contrastRatio(c.hex, canvasHex).toFixed(2)),
    nearCanvas: describeNearCanvas(c.hex, canvasHex, token),
    confidence,
  });

  const pct = (n: number) => `${(n * 100).toFixed(n < 0.01 ? 2 : 1)}%`;

  const roles: ColorRole[] = [];
  const used = new Set<Cluster>();

  /**
   * 先做噪声剔除，再分角色。
   *
   * 顺序很关键。如果先分角色、最后才过滤噪声，一个只出现一次的装饰色
   * 会因为没有竞争者而直接拿到 surface 这类角色，再想拿掉就晚了。
   * 所以必须在角色分配之前把噪声挡在候选集外面。
   */
  const isNoise = (c: Cluster): boolean => {
    // 按钮背景即使只出现一次也保留，后续按按钮使用频次判断主操作色。
    if (c.acc.buttonBackgroundCount > 0) return false;
    if (c.acc.controlCount > 0) return false;
    if (safe(c.acc.bgArea, totalBgArea) >= MIN_BG_SHARE) return false;
    if (c.acc.textChars >= MIN_TEXT_CHARS) return false;
    if (c.acc.borderCount >= MIN_BORDER_COUNT) return false;
    return true;
  };

  const noise: Cluster[] = [];
  const candidates: Cluster[] = [];

  for (const c of clusters) {
    if (c === canvasCluster) {
      candidates.push(c);
    } else if (isNoise(c)) {
      noise.push(c);
    } else {
      candidates.push(c);
    }
  }

  // --- 4. 页面底色 ---------------------------------------------------
  if (canvasCluster) {
    used.add(canvasCluster);
    roles.push(
      makeRole(
        'neutral',
        '页面底色',
        canvasCluster,
        'high',
        `页面基底色，覆盖约 ${pct(evidenceOf(canvasCluster, true).backgroundShare)} 的页面面积。` +
          `所有内容默认落在这个颜色上，新增区块时不要另起一个浅灰底，直接用这一层。`,
        true,
      ),
    );
  }

  // --- 5. 文字色。按承载的字符数排序，字符最多的就是主要文字色 --------
  const textCandidates = candidates
    .filter(
      (c) =>
        !used.has(c) &&
        c.acc.textChars >= MIN_TEXT_CHARS &&
        contrastRatio(c.hex, canvasHex) >= 1.5,
    )
    .sort((x, y) => y.acc.textChars - x.acc.textChars);

  const primaryCluster = textCandidates[0] ?? null;

  if (primaryCluster) {
    used.add(primaryCluster);
    const e = evidenceOf(primaryCluster);
    roles.push(
      makeRole(
        'primary',
        '主要文字色',
        primaryCluster,
        'high',
        `承载全页约 ${pct(e.textShare)} 的文字，与页面底色的对比度 ${contrastRatio(
          primaryCluster.hex,
          canvasHex,
        ).toFixed(2)}:1。标题、正文、导航文字统一用它，不要为了区分层级去改这个颜色的明度。`,
      ),
    );
  }

  // 次要文字色优先挑一个明显比主要文字色弱的，那才是真正的次要层级
  const secondaryCluster =
    textCandidates
      .filter((c) => !used.has(c))
      .sort((x, y) => y.acc.textChars - x.acc.textChars)
      .find(
        (c) =>
          contrastRatio(c.hex, canvasHex) <=
          contrastRatio(primaryCluster?.hex ?? canvasHex, canvasHex),
      ) ?? textCandidates.find((c) => !used.has(c)) ?? null;

  if (secondaryCluster && secondaryCluster !== primaryCluster) {
    used.add(secondaryCluster);
    const e = evidenceOf(secondaryCluster);
    roles.push(
      makeRole(
        'secondary',
        '次要文字色',
        secondaryCluster,
        'medium',
        `承载约 ${pct(e.textShare)} 的文字，与页面底色对比度 ${contrastRatio(
          secondaryCluster.hex,
          canvasHex,
        ).toFixed(2)}:1。用于说明文字、时间戳、单位、辅助标签这类不该抢占注意力的内容。`,
      ),
    );
  }

  // --- 6. 主操作色。只看所有按钮填充背景的出现频次 -------------------
  const buttonColorCandidates = candidates
    .filter((c) => c.acc.buttonBackgroundCount > 0)
    .sort((x, y) => y.acc.buttonBackgroundCount - x.acc.buttonBackgroundCount);
  const topButtonColor = buttonColorCandidates[0] ?? null;
  const topIsTied =
    topButtonColor !== null &&
    buttonColorCandidates[1]?.acc.buttonBackgroundCount === topButtonColor.acc.buttonBackgroundCount;
  const accentCluster = topIsTied ? null : topButtonColor;

  if (accentCluster) {
    used.add(accentCluster);
    const e = evidenceOf(accentCluster);
    const monochrome = accentCluster.hex === primaryCluster?.hex;

    const desc = monochrome
      ? `这套设计的主按钮背景色与主要文字色相同，强调完全靠尺寸、留白和字重实现，` +
        `不要额外引入一个彩色按钮。`
      : `它是按钮填充背景中出现次数最多的颜色，共用于 ${e.buttonBackgroundCount} 个按钮。` +
        `用于页面主要操作；链接文字和装饰色不参与主操作色判断。`;

    roles.push(
      makeRole(
        'tertiary',
        monochrome ? '主操作色（与文字同色）' : '主操作色',
        accentCluster,
        e.buttonBackgroundCount >= 2 ? 'high' : 'medium',
        desc,
      ),
    );
  }

  // --- 7. 卡片与区块底色 ---------------------------------------------
  const surfaceCluster =
    candidates
      .filter((c) => !used.has(c) && c.acc.bgCount >= MIN_SURFACE_COUNT)
      .sort((x, y) => y.acc.bgArea - x.acc.bgArea)[0] ?? null;

  if (surfaceCluster) {
    used.add(surfaceCluster);
    const e = evidenceOf(surfaceCluster);
    roles.push(
      makeRole(
        'surface',
        '卡片与区块底色',
        surfaceCluster,
        'medium',
        `出现 ${e.backgroundCount} 次，覆盖约 ${pct(e.backgroundShare)} 的页面面积。` +
          `与页面底色存在明度差，用来在不加阴影的前提下区分内容层次。`,
      ),
    );
  }

  // --- 8. 边框与分隔线 -----------------------------------------------
  const borderCluster =
    candidates
      .filter((c) => !used.has(c) && c.acc.borderCount >= MIN_BORDER_COUNT)
      .sort((x, y) => y.acc.borderCount - x.acc.borderCount)[0] ?? null;

  if (borderCluster) {
    used.add(borderCluster);
    roles.push(
      makeRole(
        'border',
        '边框与分隔线',
        borderCluster,
        'medium',
        `出现 ${borderCluster.acc.borderCount} 次，用于卡片描边、输入框边缘和区块分隔线。` +
          `整个页面共用一个边框色，不要再按场景微调明度。`,
      ),
    );
  }

  // --- 9. 没入选的颜色，逐条说明为什么被丢掉 -------------------------
  const noiseSet = new Set(noise);

  const discarded: DiscardedColor[] = clusters
    .filter((c) => !used.has(c))
    .map((c) => {
      let reason: string;
      if (noiseSet.has(c)) {
        reason =
          c.acc.totalCount <= 2
            ? `只出现在 ${c.acc.totalCount} 个元素上，判定为偶然色`
            : '面积、文字量和边框信号都很弱，判定为局部细节色';
      } else {
        reason = '未达到角色门槛，收录进色板但不参与角色分配';
      }
      return { hex: c.hex, count: c.acc.totalCount, reason };
    })
    .sort((x, y) => y.count - x.count)
    .slice(0, 12);

  return {
    canvasHex,
    isDark,
    roles,
    discarded,
    clusterCount: clusters.length,
    rawColorCount,
  };
}
