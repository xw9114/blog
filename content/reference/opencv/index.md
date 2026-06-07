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
