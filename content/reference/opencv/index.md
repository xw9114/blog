---
title: "opencv"
description: "视觉"
type: reference
icon: ""
color: "#17c48a"
toc: false
date: 2026-06-07
---


{{< ref-cols >}}

{{< ref-card filename="imread vs VideoCapture 关键区别" >}}
| 方式 | 用来读什么 | 是否需要循环 |
|------|-----------|------------|
| `cv2.imread("图片路径")` | 一张图片 | 不需要 |
| `cv2.VideoCapture(0)` | 摄像头 | 需要循环 |
| `cv2.VideoCapture("test.mp4")` | 视频 | 需要循环 |
| `cv2.VideoCapture("img_%03d.jpg")` | 图片序列 | 通常需要循环 |

> `VideoCapture` 用于从摄像头、视频文件或图片序列中读取连续画面；`cv2.imread()` 是直接读取单张图片。
{{< /ref-card >}}

{{< /ref-cols >}}

{{< ref-cols >}}

{{< ref-card filename="颜色空间转换" >}}
```python
gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)  # 转为灰度图
hsv  = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)   # 转为 HSV 色彩空间
rgb  = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)   # 转为 RGB 色彩空间
```
{{< /ref-card >}}

{{< /ref-cols >}}

{{< ref-cols >}}

{{< ref-card filename="BGR 转 HSV" >}}
将图片从 BGR 色彩空间转换为 HSV 色彩空间。

```python
hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
```

HSV 三个通道含义：

- **H**：色调（Hue）
- **S**：饱和度（Saturation）
- **V**：亮度（Value）

常用于颜色识别，比如识别红色、蓝色、绿色物体。
{{< /ref-card >}}

{{< /ref-cols >}}

{{< ref-cols >}}

{{< ref-card filename="BGR 转灰度图" >}}
作用：把彩色图变成黑白图。

```python
gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
```

常用于：

- 边缘检测
- 二值化
- 轮廓检测
- 人脸检测
{{< /ref-card >}}

{{< /ref-cols >}}

## 常见插值方法

{{< ref-cols >}}

{{< ref-card filename="最近邻插值" >}}
```python
cv.INTER_NEAREST
```
最近邻插值，速度快，但图片容易有锯齿。
{{< /ref-card >}}

{{< ref-card filename="双线性插值" >}}
```python
cv.INTER_LINEAR
```
双线性插值，默认方法，效果和速度都比较均衡。
{{< /ref-card >}}

{{< ref-card filename="三次插值" >}}
```python
cv.INTER_CUBIC
```
三次插值，放大图片效果更好，但速度慢一点。
{{< /ref-card >}}

{{< ref-card filename="区域插值" >}}
```python
cv.INTER_AREA
```
区域插值，通常适合缩小图片。
{{< /ref-card >}}

{{< /ref-cols >}}

{{< ref-cols >}}

{{< ref-card filename="cv.threshold 函数签名" >}}
```python
ret, dst = cv.threshold(src, thresh, maxval, type)
```
{{< /ref-card >}}

{{< ref-card filename="cv.threshold 参数说明" >}}
| 参数 | 说明 |
|------|------|
| `src` | 输入图像 |
| `thresh` | 设置的阈值 |
| `maxval` | 最大像素值 |
| `type` | 阈值处理类型 |
| `ret` | 实际使用的阈值 |
| `dst` | 阈值处理后的图像 |
{{< /ref-card >}}

{{< /ref-cols >}}

## 固定阈值与自动阈值的区别

{{< ref-cols >}}

{{< ref-card filename="固定阈值用法" >}}
固定阈值：手动指定阈值，OpenCV 直接使用该值。

```python
ret, result = cv.threshold(
    img,
    127,       # 手动设定的阈值
    255,       # 超过阈值时赋的最大值
    cv.THRESH_BINARY
)
```
{{< /ref-card >}}

{{< ref-card filename="固定阈值流程" >}}
固定阈值处理流程：

你设置 127
↓
OpenCV 直接使用 127
↓
ret 返回 127
{{< /ref-card >}}

{{< /ref-cols >}}

{{< ref-cols >}}

{{< ref-card filename="Otsu 自动阈值" >}}
```python
ret, result = cv.threshold(
    img,
    0,        # 阈值填0作为占位符
    255,
    cv.THRESH_BINARY + cv.THRESH_OTSU  # 启用 Otsu 自动计算
)
```
{{< /ref-card >}}

{{< ref-card filename="Otsu 执行流程" >}}
代码填写 `0` 作为占位

↓

OpenCV 分析整张图像的灰度分布

↓

自动计算合适的阈值，例如 `132`

↓

使用 `132` 进行二值化

↓

`ret` 返回 `132`
{{< /ref-card >}}

{{< /ref-cols >}}

## 五种阈值处理方式

{{< ref-cols >}}

{{< ref-card filename="二值化 THRESH_BINARY" >}}
```python
ret, thresh1 = cv.threshold(
    img, 127, 255, cv.THRESH_BINARY
)
```
处理规则：
- 如果 x > 127，则输出 255
- 如果 x ≤ 127，则输出 0

公式：输出值 = 255（x > 127）或 0（x ≤ 127）

| 原像素值 | 50 | 100 | 127 | 128 | 200 |
|----------|-----|-----|-----|-----|-----|
| 处理结果 | 0   | 0   | 0   | 255 | 255 |

处理后的图像只有黑色和白色，因此叫做二值化。
{{< /ref-card >}}

{{< ref-card filename="反向二值化 THRESH_BINARY_INV" >}}
```python
ret, thresh2 = cv.threshold(
    img, 127, 255, cv.THRESH_BINARY_INV
)
```
处理规则（与普通二值化正好相反）：
- 如果 x > 127，则输出 0
- 如果 x ≤ 127，则输出 255

| 原像素值 | 50  | 100 | 127 | 128 | 200 |
|----------|-----|-----|-----|-----|-----|
| 处理结果 | 255 | 255 | 255 | 0   | 0   |

普通二值化是亮的部分变黑、暗的部分变白；反向二值化则是亮的部分变黑、暗的部分变白。
{{< /ref-card >}}

{{< ref-card filename="截断阈值 THRESH_TRUNC" >}}
```python
ret, thresh3 = cv.threshold(
    img, 127, 255, cv.THRESH_TRUNC
)
```
处理规则：
- 如果 x > 127，则输出 127
- 如果 x ≤ 127，则保持原值

| 原像素值 | 50 | 100 | 127 | 128 | 200 |
|----------|-----|-----|-----|-----|-----|
| 处理结果 | 50  | 100 | 127 | 127 | 127 |

所有超过 127 的像素都会被截断成 127。设置的最大值 255 实际上不会起作用，因为 THRESH_TRUNC 使用的是阈值 127 进行截断。
{{< /ref-card >}}

{{< ref-card filename="低值归零 THRESH_TOZERO" >}}
```python
ret, thresh4 = cv.threshold(
    img, 127, 255, cv.THRESH_TOZERO
)
```
处理规则：
- 如果 x > 127，则保持原值
- 如果 x ≤ 127，则输出 0

| 原像素值 | 50 | 100 | 127 | 128 | 200 |
|----------|-----|-----|-----|-----|-----|
| 处理结果 | 0   | 0   | 0   | 128 | 200 |

低于或等于阈值的部分变成黑色，高于阈值的部分保留原来的灰度。
{{< /ref-card >}}

{{< ref-card filename="高值归零 THRESH_TOZERO_INV" >}}
```python
ret, thresh5 = cv.threshold(
    img, 127, 255, cv.THRESH_TOZERO_INV
)
```
处理规则（与 THRESH_TOZERO 相反）：
- 如果 x > 127，则输出 0
- 如果 x ≤ 127，则保持原值

| 原像素值 | 50 | 100 | 127 | 128 | 200 |
|----------|-----|-----|-----|-----|-----|
| 处理结果 | 50  | 100 | 127 | 0   | 0   |

高于阈值的部分变成黑色，低于或等于阈值的部分保留。
{{< /ref-card >}}

{{< /ref-cols >}}

## 五种阈值方法对比

{{< ref-cols >}}

{{< ref-card filename="五种阈值方法对比" >}}
| 阈值类型 | x > 127 时 | x ≤ 127 时 |
|---|---|---|
| `THRESH_BINARY` | 255 | 0 |
| `THRESH_BINARY_INV` | 0 | 255 |
| `THRESH_TRUNC` | 127 | 保留原值 |
| `THRESH_TOZERO` | 保留原值 | 0 |
| `THRESH_TOZERO_INV` | 0 | 保留原值 |
{{< /ref-card >}}

{{< /ref-cols >}}

## 六、自适应平均阈值

{{< ref-cols >}}

{{< ref-card filename="自适应阈值调用示例" >}}
```python
th2 = cv.adaptiveThreshold(
    img,
    255,
    cv.ADAPTIVE_THRESH_MEAN_C,
    cv.THRESH_BINARY,
    11,
    2
)
```
{{< /ref-card >}}

{{< ref-card filename="函数参数格式" >}}
```python
cv.adaptiveThreshold(
    src,        # 输入灰度图
    maxValue,   # 最大输出值
    adaptiveMethod,   # 自适应方法
    thresholdType,    # 阈值类型
    blockSize,  # 邻域大小
    C           # 从计算结果中减去的常数
)
```

| 参数 | 说明 |
|------|------|
| `img` | 输入灰度图 |
| `255` | 最大输出值 |
| `ADAPTIVE_THRESH_MEAN_C` | 使用邻域平均值计算阈值 |
| `THRESH_BINARY` | 使用普通二值化 |
| `11` | 使用 11×11 的邻域 |
| `2` | 计算后的阈值再减去 2 |
{{< /ref-card >}}

{{< ref-card filename="自适应阈值计算原理" >}}
对每个像素，取周围 **11×11** 区域计算平均灰度值：

```
局部阈值 = 11×11区域的平均值 - 2
```

**亮区示例**（附近平均值为 140）：

```
阈值 = 140 - 2 = 138
```

**暗区示例**（附近平均值为 90）：

```
阈值 = 90 - 2 = 88
```

> 针对每个像素，根据它周围的小区域，单独计算阈值，而非对整张图使用同一固定阈值。
{{< /ref-card >}}

{{< /ref-cols >}}

## 七、自适应高斯阈值

{{< ref-cols >}}

{{< ref-card filename="自适应高斯阈值调用" >}}
```python
th3 = cv.adaptiveThreshold(
    img,
    255,
    cv.ADAPTIVE_THRESH_GAUSSIAN_C,  # 使用高斯加权平均
    cv.THRESH_BINARY,
    11,  # 邻域大小（11×11）
    2    # 常数 C，从加权均值中减去
)
```
{{< /ref-card >}}

{{< ref-card filename="两种自适应方法对比" >}}
**平均法（MEAN_C）**

`cv.ADAPTIVE_THRESH_MEAN_C`

直接对周围 11×11 区域中的像素求平均。

---

**高斯法（GAUSSIAN_C）**

`cv.ADAPTIVE_THRESH_GAUSSIAN_C`

对周围像素进行**高斯加权平均**：

- 离当前像素越近的像素，权重越大
- 离当前像素越远的像素，权重越小

局部阈值计算公式：

> 局部阈值 = 高斯加权平均值 - 2

它通常比简单平均更加重视当前像素附近的信息。
{{< /ref-card >}}

{{< /ref-cols >}}
