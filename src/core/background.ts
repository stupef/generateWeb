import type { BackgroundSummary, GradientKind } from './types';

/**
 * 把渐变与背景图的检测结果翻译成散文段要说的话。
 *
 * 这一层只产出文字，不改任何数值，也不产生颜色 token。它存在的意义是让
 * 生成的 DESIGN.md 里有一句诚实的说明：这一块视觉信息采不到，读文件的 AI
 * 不要用色板里的颜色去替代它，也不要自己编一个。
 *
 * 之所以单独一个模块而不是塞进弹窗的渲染代码，是因为这段文字最终要进
 * 生成的文件，属于产品输出而不是界面文案，需要能被单独测试和复用。
 */

const KIND_LABEL: Record<GradientKind, string> = {
  linear: '线性',
  radial: '径向',
  conic: '角度',
};

export interface BackgroundNote {
  /** 要写进散文段的句子，空数组表示这块没有需要说明的内容 */
  lines: string[];
  /** 原始值样本，供人工核对与复刻时参考 */
  samples: string[];
}

/**
 * 生成背景图像的说明文字。
 *
 * 措辞上刻意做了两件事。一是给出类型明细而不只是总数，因为线性渐变和
 * 角度渐变的复刻方式完全不同。二是给出面积量级，让 AI 能判断这块视觉
 * 是主视觉还是局部装饰，从而决定要不要重点处理。
 */
export function describeBackground(bg: BackgroundSummary): BackgroundNote {
  const lines: string[] = [];
  const gradient = bg.gradient;

  if (gradient.elementCount > 0) {
    const kinds = gradient.kinds.map((k) => `${KIND_LABEL[k.kind]}渐变 ${k.count} 处`).join('、');

    // 面积可能超过一屏，超过时用倍数表达比百分比直观
    const spread =
      gradient.viewportAreaRatio >= 1
        ? `合计面积约为视口的 ${gradient.viewportAreaRatio} 倍`
        : `合计面积约占视口的 ${Math.round(gradient.viewportAreaRatio * 100)}%`;

    lines.push(`本页有 ${gradient.elementCount} 处渐变背景（${kinds}），${spread}。`);
    lines.push(
      '渐变由多个色标插值而成，无法用单一色值表达，因此没有收录进上方色板。' +
        '复刻时请以页面上的实际渐变为准，不要用色板里的颜色替代，否则会丢掉这部分视觉特征。',
    );
  }

  if (bg.imageBackedCount > 0) {
    lines.push(
      `另有 ${bg.imageBackedCount} 处元素以图片作为背景，其颜色同样不在色板覆盖范围内。`,
    );
  }

  return { lines, samples: gradient.samples };
}

/** 是否有需要写进文件的内容，供调用方决定要不要输出这一段 */
export function hasBackgroundNote(bg: BackgroundSummary): boolean {
  return bg.gradient.elementCount > 0 || bg.imageBackedCount > 0;
}
