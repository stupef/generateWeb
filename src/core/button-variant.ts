import { contrastRatio } from './color-math';
import { numOf, strOf } from './observation';
import type { StyleObservation } from './types';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost';

const FILL_DISTINCT_CONTRAST = 1.2;
const BORDER_VISIBLE_CONTRAST = 1.1;

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

  if (borderVisible || !fillDistinct) return 'secondary';
  return 'primary';
}
