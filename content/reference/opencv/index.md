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
