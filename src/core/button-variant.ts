import { contrastRatio } from './color-math';
import { numOf, padXOf, padYOf, strOf } from './observation';
import type { StyleObservation } from './types';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost';

const FILL_DISTINCT_CONTRAST = 1.2;
const BORDER_VISIBLE_CONTRAST = 1.1;
/** 填充贴着画布时，靠文字/填充对比度和尺寸兜底判为主按钮的门槛 */
const TEXT_FILL_PROMINENCE = 4.5;
const MIN_BUTTON_PAD_Y = 8;
const MIN_BUTTON_PAD_X = 12;

function isProminentTextButton(s: StyleObservation): boolean {
  if (numOf(s.textChars) <= 0) return false;
  const bg = strOf(s.backgroundColor);
  if (!bg || !s.textColor) return false;
  if (contrastRatio(s.textColor, bg) < TEXT_FILL_PROMINENCE) return false;
  if (padYOf(s) < MIN_BUTTON_PAD_Y) return false;
  if (padXOf(s) < MIN_BUTTON_PAD_X) return false;
  return true;
}

/** Components and color roles must classify the same button variants. */
export function buttonVariantOf(s: StyleObservation, canvasColor: string | null): ButtonVariant {
  const bg = strOf(s.backgroundColor);
  if (bg === null) return 'ghost';

  const borderC = strOf(s.borderColor);
  const borderVisible =
    numOf(s.borderWidth) > 0 &&
    borderC !== null &&
    contrastRatio(borderC, bg) >= BORDER_VISIBLE_CONTRAST;

  const fillDistinct =
    canvasColor !== null && contrastRatio(bg, canvasColor) >= FILL_DISTINCT_CONTRAST;

  if (borderVisible) return 'secondary';
  if (fillDistinct) return 'primary';
  if (isProminentTextButton(s)) return 'primary';
  return 'secondary';
}
