---
title: "STM32 时钟树速查"
slug: "stm32-clock"
date: 2026-05-31T00:00:00+08:00
draft: false
description: "STM32 各时钟来源与配置要点"
categories: ["Notes"]
tags: ["STM32", "嵌入式", "时钟"]
---

## 时钟来源

| 时钟 | 频率 | 用途 |
|------|------|------|
| HSI  | 16 MHz | 内部 RC，上电默认 |
| HSE  | 4–26 MHz | 外部晶振，精度高 |
| PLL  | 最高 180 MHz | 由 HSI/HSE 倍频 |
| LSI  | 32 kHz | IWDG、RTC（低精度）|
| LSE  | 32.768 kHz | RTC（高精度）|

## 关键配置寄存器

- `RCC_CR` — 时钟源使能与就绪标志
- `RCC_PLLCFGR` — PLL 倍频/分频系数 (M/N/P/Q)
- `RCC_CFGR` — 系统时钟选择、AHB/APB 分频

## 典型配置（HAL）

```c
// 使用 HSE + PLL，SYSCLK = 168 MHz
RCC_OscInitTypeDef osc = {0};
osc.OscillatorType = RCC_OSCILLATORTYPE_HSE;
osc.HSEState       = RCC_HSE_ON;
osc.PLL.PLLState   = RCC_PLL_ON;
osc.PLL.PLLSource  = RCC_PLLSOURCE_HSE;
osc.PLL.PLLM = 8;   // VCO 输入 = HSE/M = 1 MHz
osc.PLL.PLLN = 336; // VCO 输出 = 336 MHz
osc.PLL.PLLP = 2;   // SYSCLK  = 168 MHz
osc.PLL.PLLQ = 7;   // USB/SDIO = 48 MHz
HAL_RCC_OscConfig(&osc);
```

## 注意点

- 改时钟前先确认 Flash latency（168 MHz 需要 5 wait states）
- APB1 最高 42 MHz，APB2 最高 84 MHz，定时器时钟会自动 ×2
