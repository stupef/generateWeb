/**
 * 渐变与背景图说明文字的回归检查，用合成数据跑，不需要浏览器。
 *
 * 运行：npm run check:background
 *
 * 这一层只产出文字，不产出颜色。所以除了检查句子内容，
 * 还有一条硬性断言：生成的文字里不允许出现任何十六进制色值。
 * 一旦有人往后加了「顺手把渐变色标也提出来」的逻辑，这条会立刻失败。
 *
 * 采集侧的渐变检测跑在浏览器里，没法在这里覆盖，那部分靠真实站点人工核对。
 */
import { describeBackground, hasBackgroundNote } from '../src/core/background';
import type { BackgroundSummary } from '../src/core/types';

/** 局部声明退出码用的 Node 全局，理由同 color-check.ts，不引入 @types/node */
declare const process: { exit(code?: number): never };

function bg(partial: Partial<BackgroundSummary['gradient']>, imageBackedCount = 0): BackgroundSummary {
  return {
    gradient: {
      elementCount: 0,
      viewportAreaRatio: 0,
      kinds: [],
      samples: [],
      ...partial,
    },
    imageBackedCount,
  };
}

const report: string[] = [];
let failed = 0;

function check(name: string, ok: boolean) {
  if (!ok) failed++;
  report.push(`${ok ? '✓' : '✗'} ${name}`);
}

// ---------------------------------------------------------------------
// 用例一：干净页面，没有渐变也没有背景图，不该输出任何内容
// ---------------------------------------------------------------------
{
  const note = describeBackground(bg({}));
  console.log('='.repeat(56));
  console.log('用例一　干净页面');
  console.log('='.repeat(56));
  console.log(note.lines.length === 0 ? '(不输出任何说明，符合预期)' : note.lines.join('\n'));
  console.log('');

  check('[干净页面] 不输出说明文字', note.lines.length === 0);
  check('[干净页面] hasBackgroundNote 为 false', !hasBackgroundNote(bg({})));
}

// ---------------------------------------------------------------------
// 用例二：Stripe 式渐变，面积超过一屏，应当用倍数表达
// ---------------------------------------------------------------------
const stripeLike = bg(
  {
    elementCount: 12,
    viewportAreaRatio: 1.8,
    kinds: [
      { kind: 'linear', count: 9, area: 1_800_000 },
      { kind: 'conic', count: 2, area: 120_000 },
      { kind: 'radial', count: 1, area: 60_000 },
    ],
    samples: [
      'linear-gradient(270deg, #ffd601 -15%, #ee30fb 315%, #635bff 490%)',
      'conic-gradient(from 0deg, #7232f1 0, #fb76fa 33%, #ffcf5e 66%, #7232f1 100%)',
    ],
  },
  4,
);

{
  const note = describeBackground(stripeLike);
  const text = note.lines.join('\n');

  console.log('='.repeat(56));
  console.log('用例二　Stripe 式渐变 + 背景图');
  console.log('='.repeat(56));
  console.log(text);
  console.log('');

  check('[Stripe 式] 说明渐变元素总数 12', text.includes('12 处'));
  check('[Stripe 式] 列出线性渐变 9 处', text.includes('线性渐变 9 处'));
  check('[Stripe 式] 列出角度渐变 2 处', text.includes('角度渐变 2 处'));
  check('[Stripe 式] 列出径向渐变 1 处', text.includes('径向渐变 1 处'));
  check('[Stripe 式] 面积超过一屏用倍数表达', text.includes('1.8 倍'));
  check('[Stripe 式] 说明渐变未进色板', text.includes('没有收录进上方色板'));
  check('[Stripe 式] 提醒不要用色板颜色替代', text.includes('不要用色板里的颜色替代'));
  check('[Stripe 式] 说明背景图元素数 4', text.includes('4 处元素以图片作为背景'));
  check('[Stripe 式] 原样透出 2 条样本', note.samples.length === 2);
  check('[Stripe 式] hasBackgroundNote 为 true', hasBackgroundNote(stripeLike));
}

// ---------------------------------------------------------------------
// 用例三：渐变面积不足一屏，应当换成百分比表达
// ---------------------------------------------------------------------
{
  const note = describeBackground(
    bg({
      elementCount: 2,
      viewportAreaRatio: 0.07,
      kinds: [{ kind: 'linear', count: 2, area: 90_000 }],
      samples: ['linear-gradient(to bottom, transparent 0%, transparent 4px, #e5e7eb 100%)'],
    }),
  );
  const text = note.lines.join('\n');

  console.log('='.repeat(56));
  console.log('用例三　面积不足一屏');
  console.log('='.repeat(56));
  console.log(text);
  console.log('');

  check('[小面积] 不足一屏用百分比表达', text.includes('7%'));
  check('[小面积] 不出现倍数措辞', !text.includes('倍'));
  check('[小面积] 无背景图时不提图片', !text.includes('以图片作为背景'));
}

// ---------------------------------------------------------------------
// 用例四：只有背景图，没有渐变
// ---------------------------------------------------------------------
{
  const note = describeBackground(bg({}, 6));
  const text = note.lines.join('\n');

  console.log('='.repeat(56));
  console.log('用例四　只有背景图');
  console.log('='.repeat(56));
  console.log(text);
  console.log('');

  check('[仅背景图] 输出图片计数 6', text.includes('6 处元素以图片作为背景'));
  check('[仅背景图] 不提渐变', !text.includes('渐变背景'));
  check('[仅背景图] hasBackgroundNote 为 true', hasBackgroundNote(bg({}, 6)));
}

// ---------------------------------------------------------------------
// 用例五：这一层绝不能产出颜色
// ---------------------------------------------------------------------
{
  const all = [
    describeBackground(stripeLike).lines.join('\n'),
    describeBackground(
      bg({ elementCount: 1, viewportAreaRatio: 0.5, kinds: [{ kind: 'linear', count: 1, area: 1 }] }),
    ).lines.join('\n'),
  ].join('\n');

  const hexes = all.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];

  console.log('='.repeat(56));
  console.log('用例五　说明文字里不得出现色值');
  console.log('='.repeat(56));
  console.log(hexes.length === 0 ? '(未出现任何十六进制色值，符合预期)' : `出现了 ${hexes.join(', ')}`);
  console.log('');

  check('[不含色值] 说明文字里没有十六进制色值', hexes.length === 0);
}

console.log('='.repeat(56));
console.log('断言结果');
console.log('='.repeat(56));
for (const line of report) console.log(line);
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项未通过`);

process.exit(failed === 0 ? 0 : 1);
