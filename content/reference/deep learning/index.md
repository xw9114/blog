---
title: "深度学习"
description: ""
type: reference
icon: ""
color: "#17c48a"
toc: false
date: 2026-06-07
---


{{< ref-cols >}}

{{< ref-card filename="卷积输出大小" >}}
**卷积输出尺寸公式**

$$H_{\text{out}} = \left\lfloor \frac{H_{\text{in}} + 2 \times \text{padding} - kH}{\text{stride}} \right\rfloor + 1$$

$$W_{\text{out}} = \left\lfloor \frac{W_{\text{in}} + 2 \times \text{padding} - kW}{\text{stride}} \right\rfloor + 1$$

**参数说明：**

- `H_in`, `W_in` = 输入高宽
- `kH`, `kW` = 卷积核高宽
- `padding` = 边缘补零数
- `stride` = 滑动步长
- **输出通道数 = 卷积核数量**
{{< /ref-card >}}

{{< /ref-cols >}}

{{< ref-cols >}}

{{< ref-card filename="输入图像大小" >}}
输入图像越大，卷积输出越大（在 stride=1、padding=0 时）。

**输出尺寸公式：**

$$\text{输出尺寸} = \frac{H_{in} - kH + 2 \times \text{padding}}{\text{stride} + 1}$$
{{< /ref-card >}}

{{< ref-card filename="卷积核大小" >}}
- 卷积核越大，每次看图像的区域越大
- 输出尺寸越小，因为大卷积核覆盖区域多，边缘能放置的位置少
{{< /ref-card >}}

{{< ref-card filename="步长 stride" >}}
- stride 越大 → 每次卷积滑动的步子越大 → 输出尺寸越小
- stride = 1 → 输出尺寸最大（在 padding 相同的情况下）
- stride = 2 → 输出尺寸大约减半
{{< /ref-card >}}

{{< ref-card filename="填充 padding" >}}
- padding = 0 → 不补边 → 输出尺寸变小
- padding > 0 → 给输入图像边缘补零 → 输出尺寸变大

常见 padding 类型：
- **same padding** → 输出尺寸 ≈ 输入尺寸
- **valid padding** → 输出尺寸 = H_in - kH + 1
{{< /ref-card >}}

{{< ref-card filename="输出通道数" >}}
- **通道数决定深度**，不影响高×宽，但每个卷积核生成一个通道

示例：
- 输入：1024×1024×3
- 256 个卷积核 → 输出：1022×1022×256（不加 padding，stride=1，kernel=3×3）
{{< /ref-card >}}

{{< /ref-cols >}}
