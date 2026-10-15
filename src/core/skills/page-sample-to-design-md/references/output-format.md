# DESIGN.md 输出格式

## Front matter（填空骨架）

文档开头只输出下面这段 YAML，前后各用单独一行的 `---` 包裹。把 `<...>` 占位值替换为 PageSample 实测值；不新增/重命名单词字段、不改变缩进、不嵌套、不写说明文字/注释/代码围栏。

```yaml
---
name: <site-name>
version: alpha
description: <一句话：视觉气质 + 主要结构>
colors:
  primary: "<#hex>"
  secondary: "<#hex>"
  surface: "<#hex>"
  border: "<#hex>"
typography:
  display:
    fontSize: "<Npx>"
    fontWeight: <100-900>
    lineHeight: <ratio 或 Npx>
    fontFamily: "<font stack>"
  title:
    fontSize: "<Npx>"
    fontWeight: <100-900>
    lineHeight: <ratio 或 Npx>
    fontFamily: "<font stack>"
  body:
    fontSize: "<Npx>"
    fontWeight: <100-900>
    lineHeight: <ratio 或 Npx>
    fontFamily: "<font stack>"
spacing:
  sm: "<Npx>"
  md: "<Npx>"
  lg: "<Npx>"
rounded:
  sm: <N>
  md: <N>
  lg: <N>
components:
  button-primary:
    backgroundColor: "<#hex 或 {colors.primary}>"
    textColor: "<#hex 或 {colors.primary}>"
    rounded: "{rounded.sm}"
    padding: "<上下px 左右px，如 16px 12px>"
    typography: "{typography.body}"
    height: "<Npx>"
  card:
    backgroundColor: "<#hex 或 {colors.surface}>"
    textColor: "<#hex 或 {colors.primary}>"
    rounded: "{rounded.md}"
    padding: "<Npx>"
    typography: "{typography.body}"
    height: "<Npx>"
---
```

## 填空规则（违反即触发重试重生成）

1. 字段名与缩进逐字符照抄骨架，只允许改 `<...>` 值。颜色/排版/间距/圆角/组件按需整块复制（连 2 空格缩进）改键名，不引入骨架外的字段或分组。**各分组内档位数量不固定**：字号档位页面有几个就写几个（不要只填示例里的 3 个），间距/圆角档位同样按需增删，不止 `sm`/`md`/`lg`。
2. 颜色：裸键 + 引号 hex（`primary: "#111111"`）。禁止对象/列表，禁止 `evidence`/`frequency`/`context`/`role`/`quantity` 等任何嵌套子键。
3. 排版：每档用角色词做键，角色由键名决定——`display` / `title`（含 subtitle）/ `headline`（含 headline-lg）/ `heading`（含 heading2、heading3）/ `h1`~`h6` 归**标题**；`body`（含 body-md）归**正文**；`caption` 归**辅助文字**；`label`/`ui` 归**界面文字**；`code` 归**代码**；其余归**界面文字（ui）**。**禁止用 `heading2`/`heading3`/`h1`/`h2` 以外的模糊写法去表达标题**——解析器只认上面列举的词根，写错会归到 ui 而非标题。字段只用 `fontSize`/`fontWeight`/`lineHeight`/`fontFamily`，禁止 `size`/`weight`/`scale` 改名。尺寸写带单位字符串 `"16px"`，`lineHeight` 可用比例或 px。
4. 间距/圆角：扁平 `键: 值`，禁止 `padding.xs`/`gap.*` 嵌套。圆角值用数字（如 `8`）。
5. 组件：用 `button-`/`input-`/`nav-`/`card-` 前缀的复合键（不是 `- name:` 列表），只填 `backgroundColor`/`textColor`/`rounded`/`padding`/`typography`/`height` 六字段。`rounded`/`typography` 必须引用已定义的 token（`"{rounded.sm}"`、`"{typography.body}"`），禁止裸数字圆角。
6. 数值必须 PageSample 实测、不得编造；解释不足时省略该行，不猜测补齐。

## 输出前自检

- [ ] 单独一行 `---` 起止，无前后说明文字、无代码围栏包裹。
- [ ] 含 `name`、`version: alpha`、`description`、`colors.primary`。
- [ ] 无嵌套子键、无自创分组、无注释、无空映射。
- [ ] 色值/尺寸均实测，未编造。

## 正文章节

Front matter 结束后，正文用简洁 Markdown 段落或列表，不得再输出 YAML。按以下顺序写有证据支持的章节，无证据时省略：

1. `## Overview`：页面整体视觉特征与主要结构。
2. `## Colors`：各颜色实测色值与页面用途。
3. `## Typography`：字体角色、层级与使用方式。
4. `## Layout`：关键宽度、间距与布局关系。
5. `## Elevation & Depth`：阴影或扁平层次表现。
6. `## Shapes`：圆角与边框处理。
7. `## Components`：组件 token 对应外观与用途。
8. `## Do's and Don'ts`：由样本证据支持的具体实现规则。

正文禁止：
- 在 `##` 下加 `###` 子章节；写 `Evidence:`/`Plan:`/`Recommendations:` 等推理块。
- `Do's and Don'ts` 写任务描述或训练指令（如「识别某官网布局」），须是具体可执行规则。
- 用表格罗列组件属性；猜测未观察到的语义标签或交互状态。
- 正文数值与 front matter/PageSample 不一致；解释不足时省略，不猜测补齐。
