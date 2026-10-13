/**
 * 观测值的读取，以及元素角色的细分。
 *
 * 单独成一个模块有两个原因，都在真实页面上踩过。
 *
 * 一是字段读取。采集结果穿过一次 executeScript 的序列化边界，字段可能
 * 整体缺失、可能是 null、也可能变成 undefined。这几行取值放在一处，
 * 分析模块就不必各自写一份「先判类型再兜底」的样板；更要紧的是颜色
 * 字段会参与对比度计算，而对比度函数内部按十六进制解析，任一处漏判
 * 就会让整条链路在一个残缺字段上崩掉。
 *
 * 二是元素角色的细分。采集层给出的分类是粗的，它只知道「这个元素
 * 看起来像一块表面」，分不出那是卡片还是徽标。而这个区别直接决定
 * 两处的结论对不对：圆角按元素类型归组时，徽标几乎必然是胶囊而卡片
 * 不是，混在一组会把卡片的圆角结论带偏；组件识别时，把徽标报成卡片
 * 等于让复刻的人给整个内容区加上底色。
 *
 * 所以判据放在这里共用，不各写一份。两份判据早晚会分叉，而分叉之后
 * 的表现是「同一个元素在圆角那一块算卡片、在组件那一块不算」，
 * 很难从结果上看出来。
 */
import { PILL_RADIUS } from './spacing';
import type { StyleElementKind, StyleObservation } from './types';

/**
 * 卡片的下限。
 *
 * 卡片是「装着一组内容的独立表面」，所以要求它至少有一个子元素、
 * 两个方向都有内边距、并且有块像样的面积。少了这几条，页面上的徽标、
 * 头像、色块、状态点都会被算成卡片，而它们的参数完全不同。
 */
const MIN_CARD_CHILDREN = 1;
const MIN_CARD_WIDTH = 160;
const MIN_CARD_HEIGHT = 48;

// ---------------------------------------------------------------------
// 字段读取
// ---------------------------------------------------------------------

/** 四边数值的安全读取，顺序上右下左 */
export function sidesOf(input: unknown): [number, number, number, number] {
  const arr = Array.isArray(input) ? input : [];
  const num = (i: number): number => {
    const n = arr[i];
    return typeof n === 'number' && Number.isFinite(n) ? n : 0;
  };
  return [num(0), num(1), num(2), num(3)];
}

export function numOf(input: unknown, fallback = 0): number {
  return typeof input === 'number' && Number.isFinite(input) ? input : fallback;
}

export function strOf(input: unknown): string | null {
  return typeof input === 'string' && input.length > 0 ? input : null;
}

/** 水平内边距。左右不等时取大的那一边，它更能代表视觉上的内边距 */
export function padXOf(s: StyleObservation): number {
  const [, right, , left] = sidesOf(s.padding);
  return Math.round(Math.max(right, left));
}

export function padYOf(s: StyleObservation): number {
  const [top, , bottom] = sidesOf(s.padding);
  return Math.round(Math.max(top, bottom));
}

/**
 * 圆角归一。
 *
 * 胶囊的三种写法（999 / 9999 / 99999）语义完全相同，归到同一档，
 * 不归一会在结果里出现三个视觉上没有区别的圆角。
 */
export function radiusKeyOf(input: unknown): number {
  const v = numOf(input, 0);
  return v >= PILL_RADIUS ? PILL_RADIUS : Math.round(v);
}

export function radiusTextOf(value: number): string {
  return value >= PILL_RADIUS ? '胶囊' : `${value}px`;
}

// ---------------------------------------------------------------------
// 元素角色的细分
// ---------------------------------------------------------------------

/**
 * 这个「像表面一样的元素」是不是真的卡片。
 *
 * 判据里最要紧的一条是「没有撑满父容器」。一个整宽的内容区外壳和一个
 * 排在一行里的卡片，底色、圆角、内边距可以完全一样，尺寸也都很大，
 * 唯一的差别是位置关系：外壳总是撑满父容器，卡片横向一定窄于父容器的
 * 内容区。
 *
 * 特殊写法占满整行的一行卡片会被判成容器而漏掉，这是有意的取舍：
 * 宁可漏报一张卡片，也不要把页面外壳报成卡片，后者会让复刻的人给
 * 整个内容区加上底色。原因是一行卡片通常有固定的 max-width，实测时
 * 它们多数也不会真的撑满。
 */
export function isCardLike(s: StyleObservation, viewportWidth: number): boolean {
  if (numOf(s.childCount) < MIN_CARD_CHILDREN) return false;
  if (padXOf(s) <= 0 || padYOf(s) <= 0) return false;
  if (numOf(s.width) < MIN_CARD_WIDTH) return false;
  if (numOf(s.height) < MIN_CARD_HEIGHT) return false;
  if (s.fillsParent) return false;
  // 铺满整屏的更不可能是卡片
  if (viewportWidth > 0 && numOf(s.width) >= viewportWidth - 1) return false;
  return true;
}

/**
 * 把采集层的粗分类细分一档。
 *
 * 只细分卡片这一类。按钮和输入框在采集层就是按语义判的（标签和 role），
 * 本来就准；导航栏是唯一一个「一个页面上最多一个」的元素，误判也无从发生。
 * 卡片是唯一一个靠外观推出来的分类，也正因为如此它最需要细分。
 */
export function refineKind(s: StyleObservation, viewportWidth: number): StyleElementKind {
  const kind = s.kind;
  if (kind !== 'card') return kind;
  return isCardLike(s, viewportWidth) ? 'card' : 'other';
}
