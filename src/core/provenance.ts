/**
 * 数值溯源。把界面上点中的那个 token 还原成「页面上到底有哪几个元素用了它」。
 *
 * 这个模块只算「谁该被描边」，不画画。画的部分在 core/highlight.ts。分开的
 * 理由和别处一样：这一层是纯函数，能在 Node 里直接跑断言；而画那一步要碰
 * DOM，只能在页面里验。
 *
 * ── 它解决的是什么问题 ──
 *
 * 界面上每一个数字都是分析层算出来的，用户没有别的办法确认它对不对。
 * 比如「主操作按钮色 #2563EB · 作背景 3 处 · 命中 3 个控件」，那三处具体是
 * 哪几个元素，光看数字看不出来。而提取要是错了，错得最隐蔽的恰恰是这类
 * 计数：色值一眼能看出来不对，计数差了没人知道。点一下就描出来，是
 * 「确认每个 token 都对」这件事唯一可行的做法。
 *
 * ── 关键约束：数字要逐条对得上 ──
 *
 * 所以这里每一组 refs 都不是「大致相关的一批元素」，而是分析层当时数进去
 * 的那一批的精确还原。做法是判据一律不重写，全部复用分析层导出的那几条：
 *
 *   背景、文字、边框三条通道的判据   color.ts
 *   字体主族、字号归一               typography.ts
 *   间距归一、圆角归一               spacing.ts
 *   卡片细分、内边距取值             observation.ts
 *   按钮主次                         components.ts
 *   边框分组、投影归一               effects.ts
 *
 * 任何一条在这里重写一遍，两边早晚会在某个边界上错开（少算一批没有直接
 * 文字的元素、把 15.999 归到 15.9 而不是 16），而错开的表现只是差一两个
 * 元素，看着像漏了一处，几乎不可能从结果上发现。
 *
 * ProvenanceGroup.displayed 就是把这件事写成可断言的形式：它填的是界面上
 * 已经印出来的那个数字，refs 是算出来的元素。scripts/provenance-check.ts
 * 逐组断言两者相等，这是这个功能的验收口径。
 */
import { backgroundHexOf, borderHexOf, textHexOf, type ColorAnalysis } from './color';
import { buttonVariantOf, type ComponentsAnalysis } from './components';
import {
  borderKeyOf,
  borderKeyOfGroup,
  shadowKeyOfGroup,
  shadowSignatureOf,
  type EffectsAnalysis,
} from './effects';
import { HIGHLIGHT_COLORS } from './highlight';
import { numOf, radiusKeyOf, refineKind, sidesOf, strOf } from './observation';
import { radiusBucketOf, spacingKeyOf, type SpacingAnalysis } from './spacing';
import { normalizeSize, primaryFamilyOf, type TypographyAnalysis } from './typography';
import type { BoxObservation, ElementObservation, PageSample, TypeObservation } from './types';

/** 一个颜色角色的三条用途渠道 */
export type ColorChannel = 'text' | 'background' | 'border';

/**
 * 界面上一个可点的 token。
 *
 * 用下标而不是把 token 本身传进来，是因为请求要穿过一次 executeScript
 * 的边界（高亮指令只能带元素下标和字符串）。下标加分析结果这一侧的组合，
 * 恰好是那边能拿到的最小信息量。
 */
export type ProvenanceToken =
  | { kind: 'color'; index: number; channel: ColorChannel | 'all' }
  | { kind: 'color-hex'; hex: string }
  | { kind: 'color-discard'; index: number }
  | { kind: 'type-step'; index: number }
  | { kind: 'type-discard'; index: number }
  | { kind: 'family'; index: number }
  | { kind: 'spacing-step'; index: number }
  | { kind: 'spacing-discard'; index: number }
  | { kind: 'radius'; index: number }
  | { kind: 'radius-kind'; index: number }
  | { kind: 'border'; index: number }
  | { kind: 'shadow'; index: number }
  | { kind: 'component'; index: number };

/** 一组要描成同一个颜色的元素 */
export interface ProvenanceGroup {
  /** 这一组的说明，例如「作背景」 */
  label: string;
  /** 画什么颜色，十六进制 */
  color: string;
  /** 元素在采集注册表里的下标 */
  refs: number[];
  /**
   * 界面上为这一组已经印出来的那个数字。
   *
   * null 表示界面上没有对应的数字，这类情况只有两处：整张色卡（三条渠道
   * 一起，界面上印的是每条渠道各自的数，没有总数），以及未入选颜色的那一行
   * （它印的是按渠道累计的出现次数，同一元素的多条渠道在其中重复计入，
   * 和元素数本来就不是一回事，硬凑一个相等只会让断言变成自证）。
   *
   * 带值的那些是这一层的验收口径：refs 的长度必须等于它。
   */
  displayed: number | null;
}

export interface ProvenanceResult {
  /** 页面上那个说明浮层的第一行，例如「主操作按钮色 #2563EB」 */
  title: string;
  /** 补充说明，没什么可说时是空串 */
  detail: string;
  groups: ProvenanceGroup[];
  /** 数字对不上时的说明，正常是空串 */
  note: string;
}

export interface ProvenanceInput {
  sample: PageSample;
  colors: ColorAnalysis;
  typography: TypographyAnalysis;
  spacing: SpacingAnalysis;
  effects: EffectsAnalysis;
  components: ComponentsAnalysis;
}

/**
 * 渠道的展示顺序与颜色。
 *
 * 顺序与色卡上的 chip 一致（文字、背景、边框），这样浮层图例和 chip 是
 * 同一眼扫过去的顺序。颜色按渠道分开，是因为一个品牌色往往同时出现在
 * 背景、文字、边框三处，同色的话画上去是一片，分不清哪些是背景、哪些是文字。
 */
const CHANNEL_ORDER: ColorChannel[] = ['text', 'background', 'border'];

const CHANNEL_LABEL: Record<ColorChannel, string> = {
  text: '作文字',
  background: '作背景',
  border: '作边框',
};

const CHANNEL_COLOR: Record<ColorChannel, string> = {
  text: HIGHLIGHT_COLORS.text,
  background: HIGHLIGHT_COLORS.background,
  border: HIGHLIGHT_COLORS.border,
};

// ---------------------------------------------------------------------
// 元素挑选
// ---------------------------------------------------------------------

/** 从任意一条观测数组里挑出命中的元素下标 */
function refsWhere<T extends { ref: number }>(list: T[], hit: (item: T) => boolean): number[] {
  const out: number[] = [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (item && hit(item)) out.push(item.ref);
  }
  return out;
}

/** 色簇覆盖的全部原始色值，含代表色。簇的成员集是溯源能不能数对的前提 */
function memberHexesOf(hex: string, mergedFrom: { hex: string }[]): Set<string> {
  const set = new Set<string>();
  set.add(hex.toLowerCase());
  for (let i = 0; i < mergedFrom.length; i++) {
    const m = mergedFrom[i];
    if (m) set.add(String(m.hex).toLowerCase());
  }
  return set;
}

/** 这个元素有没有把颜色用在这条渠道上。判据取自 color.ts，不在这里重写 */
function usedInChannel(el: ElementObservation, channel: ColorChannel): string | null {
  if (channel === 'text') return textHexOf(el);
  if (channel === 'background') return backgroundHexOf(el);
  return borderHexOf(el);
}

/**
 * 字号是否属于这一簇。
 *
 * 带上 textChars > 0 是为了和分析层完全一致：分析层在累计前会挡掉没有
 * 文字的元素，虽然采集层本来就不会把那种元素放进这条通道，但两边的
 * 门槛必须写全，否则一份残缺的观测输入会让两边的数字分叉。
 */
function sizeHit(o: TypeObservation, sizes: Set<number>): boolean {
  return o.textChars > 0 && sizes.has(normalizeSize(o.fontSize));
}

/**
 * 这个元素的间距有没有落在这一档上。
 *
 * 归一和门槛都走 spacing.ts 的 spacingKeyOf，与累计时用的是同一个函数。
 * 四边加 gap 一共九个位置里命中任意一个就算，和累计时「同一元素内同值
 * 只算一次」的写法一一对应：那边是先记后去重，这边只关心有没有。
 */
function spacingHit(b: BoxObservation, members: Set<number>): boolean {
  const hit = (raw: number): boolean => {
    const key = spacingKeyOf(raw);
    return key !== null && members.has(key);
  };

  // 拆成四边再逐个试，与累计时的取值顺序一致：那边是 padding 四条、
  // margin 四条、最后一个 gap 记进同一批证据
  const [padTop, padRight, padBottom, padLeft] = sidesOf(b.padding);
  const [marTop, marRight, marBottom, marLeft] = sidesOf(b.margin);
  const all = [padTop, padRight, padBottom, padLeft, marTop, marRight, marBottom, marLeft];

  for (let i = 0; i < all.length; i++) {
    const v = all[i];
    if (v !== undefined && hit(v)) return true;
  }
  if (typeof b.gap === 'number' && hit(b.gap)) return true;
  return false;
}

/** 把「一档值加它吸收进来的那些原始值」变成一个集合 */
function valueMembers(value: number, mergedFrom: number[]): Set<number> {
  const set = new Set<number>();
  set.add(value);
  for (let i = 0; i < mergedFrom.length; i++) {
    const v = mergedFrom[i];
    if (typeof v === 'number') set.add(v);
  }
  return set;
}

// ---------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------

/**
 * 把一个 token 还原成页面上的元素。
 *
 * 返回 null 只在这种情况下发生：下标越界。那意味着界面上显示的那份结果
 * 和手上这份分析结果不是同一份，属于调用方的错，不该猜一个近似结果出来。
 *
 * 这里不导出，导出的是下面那层包装。分开是因为自检要在唯一的出口做，
 * 而这个函数有十几个出口（每类 token 一个），逐个补 note 迟早漏一个。
 */
function resolveProvenance(
  token: ProvenanceToken,
  input: ProvenanceInput,
): ProvenanceResult | null {
  const sample = input.sample;

  // 四条通道都是穿过 executeScript 序列化边界过来的，字段可能整个缺失
  const elements = Array.isArray(sample.elements) ? sample.elements : [];
  const types = Array.isArray(sample.typography) ? sample.typography : [];
  const boxes = Array.isArray(sample.boxes) ? sample.boxes : [];
  const styles = Array.isArray(sample.styles) ? sample.styles : [];

  const viewportWidth = numOf(sample.viewportWidth, 0);
  const canvasColor = strOf(sample.canvasColor);

  const one = (
    label: string,
    color: string,
    refs: number[],
    displayed: number | null,
  ): ProvenanceGroup => ({ label, color, refs, displayed });

  /** 取某个渠道的一组。渠道名和颜色都按渠道给，图例和描边才对得上 */
  const channelGroup = (channel: ColorChannel, refs: number[], displayed: number | null): ProvenanceGroup =>
    one(CHANNEL_LABEL[channel], CHANNEL_COLOR[channel], refs, displayed);

  /**
   * 一条渠道上的命中元素。
   *
   * 页面底色兜底：color.ts 在全页没有任何元素自设背景时，会把底色当成一条
   * 背景证据补进去，界面上于是写着「作背景 1 处」。那 1 处在 DOM 里指的是
   * 文档根元素（底色画在整块画布上，由 html 承载）。不回退到它的话，界面说
   * 1 处、点开一处都描不出来，用户只会认为工具数错了。
   */
  const channelRefs = (
    members: Set<string>,
    channel: ColorChannel,
    excludeControls = false,
  ): number[] => {
    const refs = refsWhere(elements, (el) => {
      if (excludeControls && el.isControl) return false;
      const hex = usedInChannel(el, channel);
      return hex !== null && members.has(hex);
    });
    if (refs.length > 0 || channel !== 'background') return refs;
    if (excludeControls && elements.some((el) => backgroundHexOf(el) !== null)) return refs;

    // 兜底只在底色自己那一档上用。它的判据是「全页一个背景色都没有读到」，
    // 也就是这个颜色恰好等于页面底色却没有任何元素命中
    const isCanvas = members.has(String(sample.canvasColor ?? '').toLowerCase());
    if (!isCanvas) return refs;
    return refsWhere(elements, (el) => el.tag === 'HTML');
  };

  switch (token.kind) {
    // -----------------------------------------------------------------
    // 颜色
    // -----------------------------------------------------------------
    case 'color': {
      const role = input.colors.roles[token.index];
      if (!role) return null;

      const members = memberHexesOf(role.hex, role.mergedFrom);
      const e = role.evidence;
      const order = token.channel === 'all' ? CHANNEL_ORDER : [token.channel];

      const groups: ProvenanceGroup[] = [];
      for (let i = 0; i < order.length; i++) {
        const channel = order[i];
        if (!channel) continue;
        const refs = channelRefs(
          members,
          channel,
          role.token === 'neutral' && channel === 'background',
        );
        const displayed =
          channel === 'text' ? e.textCount : channel === 'background' ? e.backgroundCount : e.borderCount;
        // 整张色卡上一条渠道都没命中就不摆出来，和 chip 的取舍一致；
        // 但单独点某一条 chip 时，0 也是答案，必须照样说
        if (token.channel === 'all' && refs.length === 0) continue;
        groups.push(channelGroup(channel, refs, displayed));
      }

      return {
        title: `${role.label} ${role.hex.toUpperCase()}`,
        detail:
          groups.length > 1 ? '同一个元素可能同时命中两条渠道，页面上按元素去重' : '',
        groups,
        note: '',
      };
    }

    case 'color-hex': {
      const hex = token.hex.toLowerCase();
      const members = new Set<string>([hex]);
      const groups: ProvenanceGroup[] = [];
      for (let i = 0; i < CHANNEL_ORDER.length; i++) {
        const channel = CHANNEL_ORDER[i];
        if (!channel) continue;
        const refs = channelRefs(members, channel);
        // 这个是色簇里的一个原始色值，界面上它只是个色点，没有印数字。
        // 不挂 displayed 而不是填 refs.length：填自己的长度是一条自证，
        // 断言会永远通过，而它本该验的是「和界面上的数对得上」
        if (refs.length === 0) continue;
        groups.push(channelGroup(channel, refs, null));
      }
      return {
        title: `合并掉的色值 ${hex.toUpperCase()}`,
        detail: '这个色值和主色在感知上几乎同色，所以并成了一档',
        groups,
        note: '',
      };
    }

    case 'color-discard': {
      const d = input.colors.discarded[token.index];
      if (!d) return null;
      const members = new Set<string>([d.hex.toLowerCase()]);
      const groups: ProvenanceGroup[] = [];
      for (let i = 0; i < CHANNEL_ORDER.length; i++) {
        const channel = CHANNEL_ORDER[i];
        if (!channel) continue;
        const refs = channelRefs(members, channel);
        // 这一行的数字是「出现次数」，按渠道累计，同一元素的多条渠道在其中
        // 重复计入，和元素数不是一回事（一个元素既是背景又是边框时，界面写
        // 2 次而页面上只有一个元素），所以这里不挂 displayed
        if (refs.length === 0) continue;
        groups.push(channelGroup(channel, refs, null));
      }
      return {
        title: `未入选的色值 ${d.hex.toUpperCase()}`,
        detail: d.reason,
        groups,
        note: '',
      };
    }

    // -----------------------------------------------------------------
    // 排版
    // -----------------------------------------------------------------
    case 'type-step': {
      const step = input.typography.steps[token.index];
      if (!step) return null;
      const sizes = new Set<number>(step.sizes);
      return {
        title: `${step.label} ${step.size}px`,
        detail:
          step.sizes.length > 1
            ? `这一级实际覆盖 ${step.sizes.join(' / ')}px，是聚类合成的`
            : '',
        groups: [
          one('用这个字号的元素', HIGHLIGHT_COLORS.neutral, refsWhere(types, (o) => sizeHit(o, sizes)), step.elementCount),
        ],
        note: '',
      };
    }

    case 'type-discard': {
      const d = input.typography.discarded[token.index];
      if (!d) return null;
      const sizes = new Set<number>(d.sizes);
      return {
        title: `一次性字号 ${d.size}px`,
        detail: d.reason,
        groups: [
          one('用这个字号的元素', HIGHLIGHT_COLORS.neutral, refsWhere(types, (o) => sizeHit(o, sizes)), d.elementCount),
        ],
        note: '',
      };
    }

    case 'family': {
      const f = input.typography.families[token.index];
      if (!f) return null;
      const key = f.name.toLowerCase();
      const refs = refsWhere(
        types,
        (o) =>
          o.textChars > 0 &&
          normalizeSize(o.fontSize) > 0 &&
          primaryFamilyOf(o.fontFamily).toLowerCase() === key,
      );
      return {
        title: `字体 ${f.name}`,
        detail: `承载 ${f.chars} 个字`,
        groups: [one('用这个字体的元素', HIGHLIGHT_COLORS.neutral, refs, f.elementCount)],
        note: '',
      };
    }

    // -----------------------------------------------------------------
    // 间距与圆角
    // -----------------------------------------------------------------
    case 'spacing-step': {
      const step = input.spacing.steps[token.index];
      if (!step) return null;
      const members = valueMembers(step.value, step.mergedFrom);
      return {
        title: `间距 ${step.value}px`,
        detail:
          step.mergedFrom.length > 0
            ? `${step.value}px 这一档还吸收了 ${step.mergedFrom.join(' / ')}px`
            : '',
        groups: [
          one(
            '用了这个间距的元素',
            HIGHLIGHT_COLORS.neutral,
            refsWhere(boxes, (b) => spacingHit(b, members)),
            step.count,
          ),
        ],
        note: '',
      };
    }

    case 'spacing-discard': {
      const d = input.spacing.discarded[token.index];
      if (!d) return null;
      const members = valueMembers(d.value, d.mergedFrom);
      return {
        title: `未立为档位的间距 ${d.value}px`,
        detail: d.reason,
        groups: [
          one(
            '用了这个间距的元素',
            HIGHLIGHT_COLORS.neutral,
            refsWhere(boxes, (b) => spacingHit(b, members)),
            d.count,
          ),
        ],
        note: '',
      };
    }

    case 'radius': {
      const r = input.spacing.radii[token.index];
      if (!r) return null;
      const refs = refsWhere(boxes, (b) => radiusBucketOf(numOf(b.radius)) === r.value);
      return {
        title: `圆角 ${r.value >= 100 ? '胶囊' : `${r.value}px`}`,
        detail: r.usage,
        groups: [one('这个圆角的元素', HIGHLIGHT_COLORS.neutral, refs, r.count)],
        note: '',
      };
    }

    case 'radius-kind': {
      const r = input.effects.radii[token.index];
      if (!r) return null;

      // 这一组装的是这一类里所有带圆角的元素，不只是主档那几个。界面上
      // 右边写的「N 个」就是这一类的总数，usage 里也是这么说的；只描主档
      // 的话数字对不上，而主档和其余档的差别由 detail 讲清楚
      const refs = refsWhere(
        styles,
        (s) => numOf(s.radius) > 0 && refineKind(s, viewportWidth) === r.kind,
      );
      const others = r.others.map((v) => (v >= 100 ? '胶囊' : `${v}px`));
      return {
        title: `${r.label}的圆角`,
        detail:
          others.length > 0
            ? `主档 ${r.radius >= 100 ? '胶囊' : `${r.radius}px`}，另有 ${others.join('、')}`
            : `主档 ${r.radius >= 100 ? '胶囊' : `${r.radius}px`}`,
        groups: [one('这一类元素', HIGHLIGHT_COLORS.neutral, refs, r.count)],
        note: '',
      };
    }

    // -----------------------------------------------------------------
    // 边框与投影
    // -----------------------------------------------------------------
    case 'border': {
      const b = input.effects.borders[token.index];
      if (!b) return null;
      const key = borderKeyOfGroup(b);
      const refs = refsWhere(styles, (s) => borderKeyOf(s)?.key === key);
      return {
        title: `边框 ${b.width}px ${b.style}`,
        detail:
          b.sides >= 4
            ? '四边都有描边，是一个完整的框'
            : b.sides === 1
              ? '只有一条边，实际上是分割线'
              : `只有 ${b.sides} 条边有描边`,
        groups: [one('用这个边框的元素', HIGHLIGHT_COLORS.neutral, refs, b.count)],
        note: '',
      };
    }

    case 'shadow': {
      const g = input.effects.shadows[token.index];
      if (!g) return null;
      const key = shadowKeyOfGroup(g.layers);
      const refs = refsWhere(styles, (s) => {
        const raw = strOf(s.shadow);
        return raw !== null && shadowSignatureOf(raw)?.key === key;
      });
      return {
        title: '投影',
        detail: g.css,
        groups: [one('用这个投影的元素', HIGHLIGHT_COLORS.neutral, refs, g.count)],
        note: '',
      };
    }

    // -----------------------------------------------------------------
    // 组件
    // -----------------------------------------------------------------
    case 'component': {
      const spec = input.components.specs[token.index];
      if (!spec) return null;

      // 按钮要先按主次分档，判据和识别时那条完全一致，否则点开主按钮
      // 会把次按钮也一起描出来
      let refs: number[];
      if (spec.kind === 'button') {
        refs = refsWhere(
          styles,
          (s) => s.kind === 'button' && buttonVariantOf(s, canvasColor) === spec.variant,
        );
      } else if (spec.kind === 'input') {
        refs = refsWhere(styles, (s) => s.kind === 'input');
      } else if (spec.kind === 'nav') {
        refs = refsWhere(styles, (s) => s.kind === 'nav');
      } else {
        refs = refsWhere(styles, (s) => refineKind(s, viewportWidth) === 'card');
      }

      return {
        title: spec.label,
        detail: spec.usage,
        groups: [one(`${spec.label}这一类`, HIGHLIGHT_COLORS.neutral, refs, spec.count)],
        note: '',
      };
    }

    default:
      return null;
  }
}

/**
 * 出口处的自检。
 *
 * 每一组的 refs 长度本该等于界面上印的那个数（displayed）。normal 情况下
 * 必然相等，scripts/provenance-check.ts 也是这么断言的。但那是拿合成样本
 * 和一份固定的分析结果在断言；真页面上还可能出别的事，比如采集到的观测
 * 被截断、某条通道的字段整个缺失。那种时候描出来的元素会比界面上少，
 * 而用户看到的现象只是「高亮得不太全」，没有任何提示。
 *
 * 所以这里当场对一遍，对不上就把差多少写进 note。宁可让功能自己说出
 * 「这个数对不上」，也不要让它安静地描错。
 */
function mismatchNote(groups: ProvenanceGroup[]): string {
  const lines: string[] = [];
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    if (!g || g.displayed === null) continue;
    if (g.refs.length === g.displayed) continue;
    lines.push(
      `${g.label}：界面上写 ${g.displayed} 处，页面上只数到 ${g.refs.length} 处`,
    );
  }
  if (lines.length === 0) return '';
  return `${lines.join('；')}。这一组对不上，先重新提取一次再看。`;
}

/**
 * 溯源入口。resolveProvenance 的包装，只多做一件事：把数字对不上的情况
 * 挂到 note 上。
 */
export function provenanceOf(
  token: ProvenanceToken,
  input: ProvenanceInput,
): ProvenanceResult | null {
  const result = resolveProvenance(token, input);
  if (!result) return null;
  return { ...result, note: mismatchNote(result.groups) };
}
