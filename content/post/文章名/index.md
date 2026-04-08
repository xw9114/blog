---
title: "蓝桥杯单片机：MM模式与IO模式的核心区别"
slug: "lanqiao-mcu-mm-vs-io"
date: 2026-04-08T10:00:00+08:00
draft: false
description: "深入解析蓝桥杯CT107D开发板中存储器映射模式（MM）与IO扩展模式的底层原理与代码差异。"
tags: ["蓝桥杯", "51单片机", "嵌入式", "C语言"]
categories: ["学习笔记"]
image: ""
---

## 模式切换基础

在蓝桥杯单片机（CT107D 开发板）中，通过跳线帽 **J13** 可以切换单片机控制外设（如 LED、数码管、蜂鸣器）的寻址方式：
- 短接 1-2 引脚：**IO扩展模式（IO模式）**
- 短接 2-3 引脚：**存储器映射扩展模式（MM模式）**

## IO 模式 (IO Mode) —— “手动挡”

IO 模式是最基础的控制方式，通过直接、手动地操作单片机的普通 I/O 端口配合逻辑门电路来控制外设。

- **工作原理**：利用 `P2.5`、`P2.6`、`P2.7` 三个引脚连接 `74HC138` 译码器，通过代码手动改变高低电平来打通特定的锁存器，再通过 `P0` 端口输出数据。
- **痛点**：每次操作外设都需要经历“准备数据 -> 打开锁存器 -> 关闭锁存器”的繁琐流程。

### 代码示例：点亮所有 LED

```c
P0 = 0x00;               // 1. 准备数据（LED 低电平点亮）
P2 = (P2 & 0x1F) | 0x80; // 2. 138 译码器选择 Y4，打通 LED 锁存器
P2 &= 0x1F;              // 3. 关闭锁存器，锁定数据


### MM代码示例
```c
#include <STC15F2K60S2.H>
#include <absacc.h>

// ================== 核心外设内存地址映射 ==================
#define LED_ADDR         0x8000  // 译码器 Y4C 通道
#define BEEP_RELAY_ADDR  0xA000  // 译码器 Y5C 通道
#define SEG_COM_ADDR     0xC000  // 译码器 Y6C 通道 (数码管位选)
#define SEG_DAT_ADDR     0xE000  // 译码器 Y7C 通道 (数码管段选)

// ================== 原子级控制函数 ==================
void Set_LED(unsigned char dat) {
    // 硬件自动分配 16 位地址并生成 WR 写脉冲，一步完成选通与锁存
    XBYTE[LED_ADDR] = dat;
}

void Set_Seg(unsigned char com, unsigned char dat) {
    // 严格遵循时序的数码管动态扫描驱动，内置硬件级消影
    XBYTE[SEG_DAT_ADDR] = 0xFF;  
    XBYTE[SEG_COM_ADDR] = com;
    XBYTE[SEG_DAT_ADDR] = dat;
}