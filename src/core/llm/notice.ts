/**
 * 结果来源的表述，以及失败之后该给用户哪个动作。
 *
 * 放在 core 而不是留在弹窗里，是因为这两件事都是判断，不是排版。
 * 「用户看得出手上这份是本地生成版还是 AI 补全版」是一条验收标准，
 * 而它完全落在下面这张标签表上；表一旦被改乱，界面照常渲染，
 * 只是用户再也分不出手上是什么。写在 core 里，断言才够得着。
 *
 * 这里只放判断，不放句子。具体一段提示怎么写仍然由界面决定，
 * 因为那是排版问题——句子怎么断、哪句加粗，和「给哪个结论」是两回事。
 */
import type { LlmFailure } from './types';

export type OriginState = 'local' | 'pending' | 'ai' | 'fallback';

/**
 * 徽标文字。
 *
 * local 和 fallback 故意用同一句话。两者对用户是同一件事——这份东西是本地
 * 生成的，可以放心用——区别只在于「有没有试过 AI」，而那属于说明块的细节，
 * 不该被抬到徽标上。pending 单独给一句，因为此刻结果还没变，写成
 * 「本地生成版」会让人以为补全已经跑完了。
 */
export const ORIGIN_LABEL: Record<OriginState, string> = {
  local: '本地生成版',
  pending: 'AI 补全中',
  ai: 'AI 补全版',
  fallback: '本地生成版',
};

/**
 * 徽标的样式类。
 *
 * ai 用强调色，是这一页里唯一一处「内容比默认多」的信号；warn 用警示色，
 * 因为它带着一条用户可能需要处理的失败信息；pending 保持中性，避免看起来
 * 像已经完成了。
 */
export const ORIGIN_CLASS: Record<OriginState, string> = {
  local: 'local',
  pending: 'busy',
  ai: 'ai',
  fallback: 'warn',
};

export type NoteAction = 'run' | 'options';

/**
 * 这个状态下该给用户哪个动作，null 表示不给。
 *
 * 只给一个，不给两个。失败时同时摆出「重试」和「去设置」，用户要先自己
 * 判断这次失败属于哪一类，而这件事我们比他清楚。判据就是 failure.retryable：
 * 超时、断网、服务端出错属于当时不巧，重试有效；Key 错、模型名不存在、
 * 额度用尽再点多少次都是同一个结果，只能去改配置。
 *
 * fallback 且没有 failure，指的是「调用成功了但内容一处都没过校验」。
 * 那一次是模型这次没写好，换一次可能就行，所以给重试。
 */
export function nextAction(state: OriginState, failure: LlmFailure | null): NoteAction | null {
  if (state === 'local') return 'options';
  if (state === 'fallback') return failure && !failure.retryable ? 'options' : 'run';
  return null;
}
