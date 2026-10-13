/**
 * 元素角色的中文名和排列顺序。
 *
 * 单独成一个模块，是因为这组标签同时被两个分析模块和弹窗用到：圆角、
 * 边框、投影要说清楚「用在哪些元素上」，组件识别要说清楚「这是哪一类」，
 * 弹窗要把两者渲染成同一批词。任一处各写一份，改一个词就要改三处，
 * 而且很容易改漏，让同一个概念在界面上出现两种叫法。
 */
import type { StyleElementKind } from './types';

/** 元素角色在界面和生成文件里的名字 */
export const KIND_LABEL: Record<StyleElementKind, string> = {
  button: '按钮',
  input: '输入框',
  nav: '导航栏',
  card: '卡片',
  other: '其他元素',
};

/**
 * 输出顺序，按「用户最关心的程度」排。
 *
 * 不按字母也不按枚举定义顺序，因为这份列表会直接铺在界面上给人看，
 * 按钮和输入框是复刻时最先要照抄的两类，排在最前面；「其他元素」是
 * 兜底分类，永远排在最后。
 */
export const KIND_ORDER: StyleElementKind[] = ['button', 'input', 'nav', 'card', 'other'];

/** 把一组角色名压成「按钮、输入框」这样的短语，按 KIND_ORDER 排序 */
export function describeKinds(kinds: StyleElementKind[]): string {
  const unique: StyleElementKind[] = [];
  for (const k of KIND_ORDER) {
    if (kinds.indexOf(k) !== -1) unique.push(k);
  }
  return unique.map((k) => KIND_LABEL[k]).join('、');
}
