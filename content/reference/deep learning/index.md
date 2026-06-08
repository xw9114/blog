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

{{< ref-cols >}}

{{< ref-card filename="三种视觉任务的区别" >}}
计算机视觉有几种常见任务，从粗到细：

| 任务 | 问题 | 输出示例 |
|------|------|----------|
| 图像分类 | 这张图里有什么？ | 一个标签："这是一张有道路的图" |
| 目标检测 | 每个物体在哪里？ | 边框："道路在 (100,200)-(800,900) 这个矩形里" |
| 语义分割 | 每个像素属于什么？ | 像素类别："第(50,73)个像素是道路，第(51,73)是建筑……" |
{{< /ref-card >}}

{{< /ref-cols >}}

{{< ref-cols >}}

{{< ref-card filename="Tensor 基本概念" >}}
PyTorch 里用 **Tensor** 存储数字，可以理解为"支持 GPU 加速的 numpy 数组"。
{{< /ref-card >}}

{{< ref-card filename="图片 Batch 的形状" >}}
一个 batch（批次）的图片形状是：

```python
(B, C, H, W)
B = batch size  # 一次送几张图
C = 通道数      # RGB = 3
H = 高度        # 1024
W = 宽度        # 1024
```
{{< /ref-card >}}

{{< /ref-cols >}}
