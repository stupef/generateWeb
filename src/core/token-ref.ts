/**
 * 界面上一个可点 token 的引用编码。
 *
 * 弹窗把每个 token 行标成 data-tok="color:3:background" 这种形式，点击时
 * 再解回 ProvenanceToken。中间过了一道 HTML 属性，所以有两条硬约束：
 *
 *   编码结果只能含属性值里安全的字符。token 里本来有个 hex 字段带着 `#`，
 *   直接拼进去虽然大多数浏览器能容忍，但属性值里出现 `#` 是不该依赖的写法，
 *   所以这里只放行一小撮字符，并在解码时用正则重新校验一遍。
 *
 *   解码对残缺输入要有明确态度。属性是能从外部改的（用户自己改 DOM、
 *   另一个扩展、页面上注入的脚本），解不出来就返回 null 让点击变成无操作，
 *   不猜一个近似的下标出来。猜错的后果是点亮一组不相干的元素，而用户
 *   正拿着这个功能核对提取结果，看到一组错的比看到没反应糟糕得多。
 *
 * 放在 core 而不是弹窗目录里，理由和别处一样：一段纯函数，能在 Node 里
 * 直接跑断言。这里错了的表现是「点了没反应」或者「高亮错的那一组」，
 * 两种都不会在界面上留下痕迹，所以往返转换必须逐类 token 对一遍。
 */
import type { ColorChannel, ProvenanceToken } from './provenance';

/** 承载编码结果的属性名。弹窗按它取，检查脚本按它断言 */
export const TOKEN_ATTR = 'data-tok';

type Channel = ColorChannel | 'all';

/** 只放行一小撮字符，属性值里不需要转义，解码时也不用处理转义序列 */
const SAFE = /^[A-Za-z0-9#.:-]*$/;
const INDEX = /^\d+$/;
const HEX = /^#[0-9a-fA-F]{3,8}$/;

/** 一个 token 编成属性值。空串表示这个 token 编不出来，调用方应放弃做成可点行 */
export function encodeToken(token: ProvenanceToken): string {
  if (token.kind === 'color') {
    const idx = indexOf(token.index);
    if (idx === null || !isChannel(token.channel)) return '';
    return `color:${idx}:${token.channel}`;
  }

  if (token.kind === 'color-hex') {
    const hex = token.hex.toLowerCase();
    return HEX.test(hex) ? `color-hex:${hex}` : '';
  }

  const idx = indexOf(token.index);
  if (idx === null) return '';

  // 逐类列出来而不是拼一个 `${token.kind}:${idx}`。这样往 ProvenanceToken
  // 里加一类 token 时，这里会是一个编译错误而不是一个编得出来却解不回去的串
  switch (token.kind) {
    case 'color-discard':
    case 'type-step':
    case 'type-discard':
    case 'family':
    case 'spacing-step':
    case 'spacing-discard':
    case 'radius':
    case 'radius-kind':
    case 'border':
    case 'shadow':
    case 'component':
      return `${token.kind}:${idx}`;
    default:
      return '';
  }
}

/**
 * 属性值解回 token。解不出来返回 null。
 *
 * 只认自己编出来的那几种形状，多一段少一段都拒。宽松解析在这里没有好处：
 * 属性值不是人写的，凡是不符合形状的都说明它已经被改过。
 */
export function decodeToken(raw: string | null | undefined): ProvenanceToken | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  if (!SAFE.test(raw)) return null;

  const parts = raw.split(':');

  if (parts[0] === 'color') {
    if (parts.length !== 3) return null;
    const index = readIndex(parts[1]);
    const channel = parts[2];
    if (index === null || channel === undefined || !isChannel(channel)) return null;
    return { kind: 'color', index, channel };
  }

  if (parts[0] === 'color-hex') {
    if (parts.length !== 2) return null;
    const hex = parts[1];
    if (hex === undefined || !HEX.test(hex)) return null;
    return { kind: 'color-hex', hex: hex.toLowerCase() };
  }

  if (parts.length !== 2) return null;
  const index = readIndex(parts[1]);
  if (index === null) return null;

  switch (parts[0]) {
    case 'color-discard':
    case 'type-step':
    case 'type-discard':
    case 'family':
    case 'spacing-step':
    case 'spacing-discard':
    case 'radius':
    case 'radius-kind':
    case 'border':
    case 'shadow':
    case 'component':
      return { kind: parts[0], index };
    default:
      return null;
  }
}

function isChannel(v: string): v is Channel {
  return v === 'text' || v === 'background' || v === 'border' || v === 'all';
}

function indexOf(n: number): string | null {
  if (!Number.isInteger(n) || n < 0) return null;
  return String(n);
}

function readIndex(raw: string | undefined): number | null {
  if (raw === undefined || !INDEX.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 0) return null;
  return n;
}
