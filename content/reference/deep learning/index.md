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
