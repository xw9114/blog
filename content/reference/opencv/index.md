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
