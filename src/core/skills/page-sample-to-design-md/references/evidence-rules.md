# PageSample 证据规则

## 输入与记录

输入是一份描述单个 URL、单个视口的 PageSample JSON。字段可能缺省；以实际输入为准。无效 JSON、非 PageSample 或证据不足时，报告输入不足，不编造文档。

使用 `ref` 合并 `elements`、`typography`、`boxes`、`styles`。通道缺少某 ref 表示采样阈值未收录，不代表值为零或属性不存在。优先使用 `styles` 描述组件外观，以 `typography` 和 `boxes` 补充；用 `elements` 与画布字段描述整体背景和颜色。

采集器只提供 `textChars`，不提供实际文字。不得猜按钮文案、页面文案、业务目的或颜色含义。根据 tag、kind、导航/控制/表面标记、几何和重复样式，谨慎归纳角色；证据不足时使用中性命名。

## 数值与空值

- 所有尺寸均为 CSS px，`area` 为平方像素，`fontWeight` 为无单位整数，radius 百分比已换算为 px。
- `null` 表示不适用或无法表示该数值；不是采样失败。`styles[].shadow: null` 表示该组件未观察到阴影；`elements[].backgroundColor: null` 表示元素透明。画布颜色另行描述。
- `fontSize: 0` 是解析失败标记；优先取同一 ref 的 typography 值，否则省略。不要输出 `0px`。
- `letterSpacing: null` 表示 CSS `normal`。`maxWidth: null` 不得转换或猜成固定像素值。
- 不得发明、归一化、插值或静默四舍五入数值。可将相近值归为同一语义角色，但列出的数值必须是输入中的精确值。不得从样本推算未观察到的间距基数或断点。

## 颜色、组件与限制

- 颜色语义必须有使用证据。不可仅凭颜色称为品牌色、成功色或错误色。
- 只描述 `styles` 中出现的组件种类和可见属性。缺失的组件种类不得补造。
- 当前采样不含交互状态。不得声称检查了 hover、菜单、弹窗或其他交互状态。
- `visited`、`skipped`、`truncated`、`elapsedMs`、`embedded` 仅作采样背景。若采样被截断或跳过大量内容，避免称为完整的全站设计系统，并在确有必要时简述限制。
