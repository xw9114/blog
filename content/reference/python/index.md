---
title: "python"
description: ""
type: reference
icon: ""
color: "#17c22d"
toc: false
date: 2026-06-07
---


## 基本语法结构

{{< ref-cols >}}

{{< ref-card filename="assert 基础判定" >}}
条件为 `False` 时抛出 `AssertionError`，但不会告知具体原因。

assert [条件]

{{< /ref-card >}}

{{< ref-card filename="assert 带提示信息（推荐）" >}}
条件为 `False` 时抛出 `AssertionError`，并附带提示语，方便快速定位问题。

assert [条件], [错误提示信息]

{{< /ref-card >}}

{{< /ref-cols >}}

{{< ref-cols >}}

{{< ref-card filename="plt 工具箱常用函数" >}}
| 函数 | 说明 |
|------|------|
| `plt.subplot()` | 划分图片显示区域 |
| `plt.imshow()` | 显示图片 |
| `plt.title()` | 添加标题 |
| `plt.xticks()` | 设置横坐标刻度 |
| `plt.yticks()` | 设置纵坐标刻度 |
| `plt.show()` | 显示整个绘图窗口 |
{{< /ref-card >}}

{{< /ref-cols >}}

{{< ref-cols >}}

{{< ref-card filename="subplot() 格式" >}}
`plt.subplot()` 的格式：

```python
plt.subplot(行数, 列数, 当前图片的位置)
```

| 参数 | 含义 |
|------|------|
| `2` | 表示一共两行 |
| `3` | 表示一共三列 |
| `i + 1` | 表示当前图片放在哪个位置 |
{{< /ref-card >}}

{{< ref-card filename="为什么用 i+1" >}}
`subplot()` 的位置编号从 `1` 开始，而不是从 `0` 开始。

但 `i` 从 `0` 开始，所以需要用 `i + 1`：

```
i:      0  1  2  3  4  5
i + 1:  1  2  3  4  5  6
```
{{< /ref-card >}}

{{< /ref-cols >}}
