/**
 * 校验注入函数在打包压缩后是否仍然自包含。
 *
 * 为什么需要这个脚本：
 * 采样的那个函数和溯源高亮的那个函数，都会被 chrome.scripting.executeScript
 * 用 Function.prototype.toString() 序列化后送进页面执行。toString() 只带函数体，
 * 不带模块作用域。所以一旦函数体内引用了任何模块级的变量，注入后必然是
 * ReferenceError。开发时看不出来，打包压缩改了变量名之后更容易踩到，只能靠
 * 静态检查兜住。
 *
 * 两个都要查。高亮那个尤其容易踩：它要从 core/highlight.ts 里取挂载键、描边
 * 宽度、渠道颜色这几个常量，而这几个常量偏偏又是模块级导出的，写起来顺手就
 * 用了。所以那边把常量在函数体里又写了一遍字面量，这里就是验证那件事到底
 * 做没做的地方。
 *
 * 做法是把产物里每个注入函数都抠出来，用 acorn 解析成 AST，
 * 收集所有标识符引用，减去函数内部声明的绑定，剩下的就是自由变量。
 * 自由变量里只允许出现浏览器全局对象。
 */
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'acorn';

const OUTPUT_DIR = path.resolve(process.cwd(), '.output/chrome-mv3');
const CHUNK_DIR = path.join(OUTPUT_DIR, 'chunks');

/**
 * 项目里应当存在的注入函数个数。
 *
 * 写死这个数是为了让「少查了一个」变成一次失败而不是一次静默通过。上面那
 * 段定位逻辑靠 executeScript 调用里的 func 参数认人，一旦某次改动把这个参数
 * 换成了别的形式（比如改用 files），定位就会配不上，检查会一条不报地过掉，
 * 而它本该守着的东西一个都没守。所以配不上时这里要出声。
 */
const EXPECTED_INJECTIONS = 2;

/** 允许在注入函数里出现的全局标识符 */
const ALLOWED_GLOBALS = new Set([
  'undefined', 'NaN', 'Infinity', 'globalThis',
  'Object', 'Array', 'String', 'Number', 'Boolean', 'Math', 'JSON', 'Date',
  'RegExp', 'Error', 'TypeError', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Symbol',
  'Promise', 'Proxy', 'Reflect', 'Intl', 'isNaN', 'parseInt', 'parseFloat',
  'document', 'window', 'self', 'performance', 'getComputedStyle', 'CSS',
  'console', 'requestAnimationFrame', 'structuredClone', 'URL', 'Element',
  'HTMLElement', 'Node', 'NodeList', 'DOMRect', 'CSSStyleDeclaration',
]);

function walk(node, visit, parentKey = null, parent = null) {
  if (!node || typeof node.type !== 'string') return;
  visit(node, parent, parentKey);
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'start' || key === 'end') continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) walk(child, visit, key, node);
    } else if (value && typeof value.type === 'string') {
      walk(value, visit, key, node);
    }
  }
}

function bindPattern(node, out) {
  if (!node) return;
  switch (node.type) {
    case 'Identifier':
      out.add(node.name);
      break;
    case 'ObjectPattern':
      for (const p of node.properties) {
        if (p.type === 'RestElement') bindPattern(p.argument, out);
        else bindPattern(p.value, out);
      }
      break;
    case 'ArrayPattern':
      for (const el of node.elements) bindPattern(el, out);
      break;
    case 'AssignmentPattern':
      bindPattern(node.left, out);
      break;
    case 'RestElement':
      bindPattern(node.argument, out);
      break;
    default:
      break;
  }
}

/** 从源码中抠出某个函数声明的完整文本 */
function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) return null;
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const c = source[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * 找出产物里每一处 executeScript 调用，以及它 func 参数指向的函数名。
 *
 * 不能只取第一处。这个脚本最早只认第一个，而弹窗里加进第二个注入点之后
 * 它照样报「通过」，因为第二个压根没被看过——一条守着注入安全的检查，一旦
 * 漏看一个注入点就等于没守。
 *
 * 同一个函数可能被多处调用（比如采样和高亮各有一次），所以返回去重后的名字。
 * 截取窗口只到下一个 executeScript 为止，避免把后面那个调用的 func 认成
 * 前面那个的。
 */
function findInjectedFunctionNames(source) {
  const marker = 'executeScript(';
  const names = new Set();
  let at = source.indexOf(marker);

  while (at >= 0) {
    const next = source.indexOf(marker, at + marker.length);
    const window = source.slice(at, next < 0 ? at + 600 : next);
    const m = /func:\s*([A-Za-z_$][\w$]*)/.exec(window);
    if (m) names.add(m[1]);
    at = next;
  }

  return [...names];
}

/** 检查一个注入函数，返回它声明的绑定数和自由变量。不自包含时直接终止 */
function checkOne(source, name, file) {
  const fnSource = extractFunction(source, name);
  if (!fnSource) {
    console.error(`✗ ${file}：定位到注入函数 ${name}，但无法抠出源码`);
    process.exit(1);
  }

  const ast = parse(fnSource, { ecmaVersion: 'latest' });

  const declared = new Set();
  const refs = new Set();

  walk(ast, (n, parent, key) => {
    if (n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression') {
      if (n.id) declared.add(n.id.name);
      for (const p of n.params) bindPattern(p, declared);
    }
    if (n.type === 'VariableDeclarator') bindPattern(n.id, declared);
    if (n.type === 'ClassDeclaration' && n.id) declared.add(n.id.name);
    if (n.type === 'CatchClause' && n.param) bindPattern(n.param, declared);
  });

  walk(ast, (n, parent, key) => {
    if (n.type !== 'Identifier' || !parent) return;

    if (parent.type === 'MemberExpression' && key === 'property' && !parent.computed) return;
    if (parent.type === 'Property' && key === 'key' && !parent.computed && !parent.shorthand) return;
    if (parent.type === 'MethodDefinition' && key === 'key' && !parent.computed) return;
    if (parent.type === 'LabeledStatement' && key === 'label') return;
    if ((parent.type === 'BreakStatement' || parent.type === 'ContinueStatement') && key === 'label') return;

    if (
      parent.type === 'FunctionDeclaration' ||
      parent.type === 'FunctionExpression' ||
      parent.type === 'ArrowFunctionExpression'
    ) {
      if (key === 'id' || key === 'params') return;
    }
    if (parent.type === 'VariableDeclarator' && key === 'id') return;
    if (parent.type === 'ClassDeclaration' && key === 'id') return;
    if (parent.type === 'CatchClause' && key === 'param') return;
    if (
      parent.type === 'ArrayPattern' ||
      parent.type === 'ObjectPattern' ||
      parent.type === 'RestElement' ||
      parent.type === 'AssignmentPattern'
    ) {
      return;
    }

    refs.add(n.name);
  });

  const free = [...refs].filter((n) => !declared.has(n));
  const offenders = free.filter((n) => !ALLOWED_GLOBALS.has(n));

  if (offenders.length > 0) {
    console.error(`\n✗ 注入函数 ${name}（${file}）不自包含，引用了函数体外的东西：`);
    for (const o of offenders) console.error(`    · ${o}`);
    console.error(
      '\n  这些名字会在页面里变成 ReferenceError。' +
        '把对应的常量或工具函数移进那个函数的函数体内部。\n',
    );
    process.exit(1);
  }

  const globals = free.filter((n) => ALLOWED_GLOBALS.has(n));
  console.log(`✓ 注入函数 ${name} 自包含（${fnSource.length} 字节）`);
  console.log(`  函数内声明 ${declared.size} 个绑定，自由变量仅剩浏览器全局：${globals.join(', ') || '无'}`);
}

/**
 * 产物里所有可能装着注入函数的脚本。
 *
 * 两处都要扫。注入函数现在分居两地：采集那个跟着背景脚本进了根目录的
 * background.js，溯源高亮那个留在 chunks 里。只扫 chunks 会漏掉采集那个，
 * 而这条检查写死了「应当有 2 个」，所以漏掉会被发现——那个数字的用处正在这里。
 */
function scriptFiles() {
  const out = [];
  for (const dir of [OUTPUT_DIR, CHUNK_DIR]) {
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir)) {
      if (file.endsWith('.js')) out.push(path.join(dir, file));
    }
  }
  return out;
}

function main() {
  const files = scriptFiles();
  if (files.length === 0) {
    console.error(`找不到产物里的脚本，先运行一次构建。预期的位置是 ${OUTPUT_DIR}`);
    process.exit(1);
  }

  const seen = new Set();
  let calls = 0;

  for (const full of files) {
    const file = path.basename(full);
    const source = fs.readFileSync(full, 'utf8');
    for (const name of findInjectedFunctionNames(source)) {
      calls++;
      // 同一个函数可能被多个调用点引用，但只该查一次
      if (seen.has(name)) continue;
      seen.add(name);
      checkOne(source, name, file);
    }
  }

  if (seen.size === 0) {
    console.error('✗ 没有在产物里找到任何注入函数，检查 executeScript 的调用是否存在。');
    process.exit(1);
  }

  if (seen.size < EXPECTED_INJECTIONS) {
    console.error(
      `\n✗ 只找到 ${seen.size} 个注入函数，应当有 ${EXPECTED_INJECTIONS} 个。` +
        '\n  少查的那个没有被这条检查守到。多半是它的调用换成了不带 func 参数的写法，' +
        '\n  这个脚本的定位逻辑认不出来，于是静默跳过。定位逻辑在 findInjectedFunctionNames。\n',
    );
    process.exit(1);
  }

  console.log('');
  console.log(`注入点 ${calls} 处，去重后 ${seen.size} 个函数，全部通过。`);
}

main();
