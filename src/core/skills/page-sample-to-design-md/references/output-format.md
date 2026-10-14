# DESIGN.md 输出格式

## Front matter

全文只在开头使用一次 YAML。开头和结尾的分隔符 `---` 必须各自独占一行，该行不能有其他字符。包含 `version: alpha`、非空 `name`、`description` 和必需的 `colors.primary`。仅使用支持的 token 组：`colors`、`typography`、`spacing`、`rounded`、`components`；没有证据的组省略，不留空映射。正文不得再出现 YAML 或 YAML 代码块。

## 正文

只输出有证据支持的章节，按以下顺序排列，不重复标题：

1. `## Overview`
2. `## Colors`
3. `## Typography`
4. `## Layout`
5. `## Elevation & Depth`
6. `## Shapes`
7. `## Components`
8. `## Do's and Don'ts`

正文用简洁的 Markdown 说明或列表。文中数值须与 front matter 或 PageSample 一致。

## 分步映射

- `frontmatter`：只输出 YAML front matter。
- `overview-colors`：Overview、Colors。
- `typography-layout`：Typography、Layout。
- `elevation-shapes`：Elevation & Depth、Shapes。
- `components-rules`：Components、Do's and Don'ts。
- `ai-prompt`：只输出 AI prompt。

除 `frontmatter` 外，各步都输出 Markdown，不输出 YAML。最终按步骤顺序拼接；无证据的章节省略。

## AI prompt

在最后一个正文步骤之后输出 `### AI Prompt`，再用 `text` 代码块写 1–3 句自然语言页面生成提示。不要在代码块中写 YAML。
