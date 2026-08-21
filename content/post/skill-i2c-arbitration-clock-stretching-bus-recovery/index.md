---
title: "I2C 仲裁、时钟拉伸与总线恢复：把共享线上的等待变成可证明的时序合同"
slug: "skill-i2c-arbitration-clock-stretching-bus-recovery"
date: 2026-08-19T09:00:00+08:00
draft: false
description: "从开漏线与线与逻辑出发，推导 I2C 多主仲裁、时钟拉伸和 SDA 卡死恢复的边界，并给出 STM32 HAL 实现。"
tags: ["STM32", "I2C", "仲裁", "时钟拉伸", "总线恢复"]
categories: ["技能档案"]
image: ""
---

## 技能概述

I2C 的难点不在于发出起始位，而在于多个主机、慢速从机和异常复位同时存在时，如何仍然知道“总线现在是谁的、还要等多久、何时可以安全退出”。本文从开漏晶体管的线与逻辑出发，解释逐位仲裁和 SCL 时钟拉伸的物理边界，建立可计算的超时预算，并用 STM32 HAL 代码实现仲裁丢失处理、总线空闲判定与九脉冲恢复。

## 核心底层概念解析

- **开漏与线与**：任一节点只能主动拉低，释放后由上拉电阻回到高电平。总线电平是所有节点的逻辑 AND；因此主机发送“1”却采到“0”时，并非噪声，而是另一个主机赢得了仲裁。
- **位级仲裁**：仲裁只发生在 SCL 为高的数据窗口。对每一位检查 `tx=1 && rx=0`，第一次出现即失去仲裁；胜者无需重发，已发送的位序列仍保持完整，这就是“非破坏性竞争”。
- **时钟拉伸**：主机释放 SCL 后，慢速从机可继续拉低。有效高电平时间为 `t_high_eff = t_release_to_high + t_slave_release`，主机不能把自己的定时器当作总线真实时钟，必须等待引脚电平并设置上限 `T_stretch_max`。
- **空闲不是电平瞬间为高**：停止条件后要连续观察 SDA/SCL 为高至少一个总线周期，避免前一事务的上升沿尚未完成就误判空闲。上拉 RC 的上升时间近似 `t_r = 0.8473 * R_p * C_b`，它直接消耗建立时间预算。
- **SDA 卡死与九脉冲**：从机可能在复位时停留在“等待第 9 个 SCL”的状态。主机切换 GPIO 开漏，产生最多 9 个低-高脉冲；每个高相位都重新采样 SDA，检测到释放后再发 STOP。若 SCL 自身被拉低，脉冲无效，必须报告硬件级故障而不是无限重试。
- **超时是系统契约**：一次位等待的截止期应满足 `T_deadline = T_stretch_max + t_r + t_guard`。把它纳入任务的最坏响应时间，才能避免 I2C ISR 或 RTOS 任务永久占用总线。

## 代码能力展现

```c
#include "stm32f4xx_hal.h"

#define I2C_STRETCH_MAX_US 2500u
#define I2C_RECOVERY_PULSES 9u

static uint32_t micros(void);
static void sda_release(void);
static void sda_low(void);
static void scl_release(void);
static void scl_low(void);
static GPIO_PinState sda_read(void);
static GPIO_PinState scl_read(void);

/**
 * @brief Wait until SCL is released by every device.
 * @return HAL_OK when high, HAL_TIMEOUT when a slave stretches too long.
 */
static HAL_StatusTypeDef i2c_wait_scl_high(void)
{
    const uint32_t start = micros();
    while (scl_read() == GPIO_PIN_RESET) {
        if ((uint32_t)(micros() - start) > I2C_STRETCH_MAX_US) {
            return HAL_TIMEOUT;
        }
    }
    return HAL_OK;
}

/**
 * @brief Recover a bus whose SDA is held low by a partially completed slave transaction.
 * @return HAL_OK if STOP can be generated, HAL_ERROR if SCL is physically held low.
 */
HAL_StatusTypeDef I2C_BusRecover(void)
{
    sda_release();
    scl_release();
    if (i2c_wait_scl_high() != HAL_OK) return HAL_ERROR;

    for (uint32_t i = 0; i < I2C_RECOVERY_PULSES && sda_read() == GPIO_PIN_RESET; ++i) {
        scl_low();
        /* Low phase is deliberately longer than the GPIO edge settling time. */
        HAL_Delay(1);
        scl_release();
        if (i2c_wait_scl_high() != HAL_OK) return HAL_TIMEOUT;
        HAL_Delay(1);
    }

    /* STOP: SDA transitions low->high while SCL is already high. */
    sda_low();
    HAL_Delay(1);
    scl_release();
    if (i2c_wait_scl_high() != HAL_OK) return HAL_TIMEOUT;
    sda_release();
    return (sda_read() == GPIO_PIN_SET) ? HAL_OK : HAL_ERROR;
}

/**
 * @brief Check one transmitted bit against the physical bus for multi-master arbitration.
 * @param tx_bit Bit intended by this master (0 or 1).
 * @return HAL_OK, or HAL_BUSY when another master wins arbitration.
 */
HAL_StatusTypeDef I2C_CheckArbitration(uint8_t tx_bit)
{
    if (i2c_wait_scl_high() != HAL_OK) return HAL_TIMEOUT;
    /* A released '1' sampled as dominant '0' proves arbitration loss. */
    if (tx_bit != 0u && sda_read() == GPIO_PIN_RESET) return HAL_BUSY;
    return HAL_OK;
}
```

