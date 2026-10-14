/**
 * 让 TS 认识 Vite 的 `?raw` 导入。
 *
 * WXT 基于 Vite，原生支持 `import x from './file?raw'` 拿到文件原文。
 * 但 .wxt/tsconfig 把 node_modules 排除在编译之外，vite/client 里的
 * `declare module '*?raw'` 不会被自动读进来，所以这里补一份全局声明。
 */
declare module '*?raw' {
  const content: string;
  export default content;
}
