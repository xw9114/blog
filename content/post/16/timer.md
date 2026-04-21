---
title: "技能档案：STM32 硬件定时器与中断机制"
slug: "skill-stm32-hardware-timer-interrupt"
date: 2026-04-21T21:24:46+08:00
draft: false
description: "从时钟树、预分频、更新事件到 NVIC 响应链路，系统拆解 STM32 硬件定时器与中断机制的实时控制本质。"
tags: ["嵌入式", "STM32", "定时器", "中断", "实时系统"]
categories: ["技能档案"]
image: ""
---

## 技能概述

STM32 硬件定时器与中断机制的价值，不在于“每隔一段时间进一次回调”，而在于把晶振提供的连续物理振荡，翻译成 MCU 可调度、可量化、可复现的时间秩序。它广泛用于控制周期调度、PWM 输出、输入捕获、编码器测速、超声测距与高精度时基构建，解决的核心痛点是：主循环轮询的节拍不稳定、软件延时不可并行、实时任务缺乏统一时基，最终导致控制链路抖动、采样失配与执行失真。

## 核心底层概念解析

- **定时器不是“延时函数硬件版”**：它的本质是一个被时钟驱动的可编程计数器。晶振提供连续震荡，时钟树做频率分发，**PSC（预分频器）** 决定“每几拍计一次数”，**ARR（自动重装载寄存器）** 决定“数到哪里产生一个周期边界”。时间在这里不再是抽象概念，而是被量化成寄存器可表示的离散刻度。
- **更新事件是时间边界被硬件承认的瞬间**：当计数器上溢、下溢或软件主动触发 `UG` 时，定时器会产生 **Update Event**。这个事件不仅可能触发中断，还会把预装载寄存器中的新参数同步到影子寄存器。换句话说，中断不是凭空跳出的一段代码，而是某个硬件时刻穿过了 CPU 可感知的边界。
- **中断链路本质上是一条“硬件裁决路径”**：`TIMx` 先在外设内部置位状态标志，再经 **NVIC** 参与优先级仲裁，最终 CPU 保存现场并跳转到 ISR。所谓“定时到了就执行”，中间实际穿过了 **标志位、使能位、优先级、现场保护、总线访问** 五层门槛。不了解这条链路，就很容易把中断抖动误判成算法问题。
- **比较通道解决的是“周期内定位”而不是“整周期等待”**：**CCR（捕获比较寄存器）** 的意义，在于让定时器不只知道“一圈结束了没有”，还知道“在这一圈的第几个刻度发生动作”。PWM 输出、输出比较翻转、输入捕获测宽，本质上都在利用同一件事：把物理世界里的相位、脉宽、边沿时间，映射成计数空间里的比较关系。
- **预装载与影子寄存器是抗毛刺的关键**：若在计数过程中直接改 ARR 或 CCR，当前周期可能立刻被截断，输出脉冲也可能出现毛刺。启用 **Preload** 后，软件写入先进入缓冲区，等下一个更新事件再统一生效。这是一种很典型的工程哲学：数字系统要想稳定，不只要“能改值”，更要“在正确的时刻改值”。
- **实时系统里最昂贵的不是时间，而是时间的不确定性**：理论周期 `T = 1 / f` 很容易算，真正难的是让采样、控制、执行都围绕同一时基运行。若控制回路名义上 1 kHz，实际却因中断嵌套、串口阻塞、Flash 等待状态而漂移，那么 PID 的积分项、速度估计、滤波器截止频率都会一起失真。闭环系统最怕的不是慢，而是节拍失真。
- **定时器是数字世界对物理节律的最底层承诺**：编码器测速靠它量时间，PWM 驱动靠它配脉宽，任务调度靠它给节拍。控制系统中的“稳定”，本质上并不是代码写得多优雅，而是从时钟到中断、从中断到任务的整条链路，都愿意对时间负责。

## 代码能力展现

下面给出一个基于 STM32 HAL 的定时器中断驱动示例：使用 `TIM6` 构造固定频率控制周期，把重计算留在主循环，把中断服务函数压缩到只做“记账与置位”。代码重点不在 API 调用本身，而在 **如何把目标中断频率稳定映射为 PSC/ARR**，以及 **如何降低 ISR 抖动对控制闭环的污染**。

```c
#include "stm32f4xx_hal.h"
#include <stdint.h>

#define CTRL_TIMER_MIN_HZ          50U
#define CTRL_TIMER_MAX_HZ          20000U
#define CTRL_TIMER_COUNTER_MAX     65535U

typedef struct
{
    TIM_HandleTypeDef *htim;
    uint32_t timer_clk_hz;
    uint32_t target_hz;
    uint32_t actual_hz;
    volatile uint32_t tick_count;
    volatile uint8_t period_elapsed;
} ControlTimer_t;

static ControlTimer_t g_control_timer;

static uint32_t ClampU32(uint32_t value, uint32_t min_value, uint32_t max_value)
{
    if (value < min_value)
    {
        return min_value;
    }

    if (value > max_value)
    {
        return max_value;
    }

    return value;
}

/**
 * @brief 根据目标中断频率计算 16 位定时器的 PSC 与 ARR。
 * @param timer_clk_hz 定时器输入时钟，单位 Hz，例如 APB1 定时器时钟 84000000。
 * @param target_hz 目标更新频率，单位 Hz。
 * @param psc_out 输出的预分频值，写入寄存器时对应 PSC。
 * @param arr_out 输出的重装载值，写入寄存器时对应 ARR。
 * @param actual_hz_out 输出的实际更新频率，便于上层评估量化误差。
 * @retval HAL_OK 计算成功，HAL_ERROR 表示参数非法或超出 16 位定时器表达能力。
 */
static HAL_StatusTypeDef ControlTimer_ComputeDividers(uint32_t timer_clk_hz,
                                                      uint32_t target_hz,
                                                      uint32_t *psc_out,
                                                      uint32_t *arr_out,
                                                      uint32_t *actual_hz_out)
{
    uint64_t divider;
    uint64_t denominator;
    uint64_t tick_hz;
    uint64_t reload;

    if ((timer_clk_hz == 0U) || (psc_out == NULL) || (arr_out == NULL) || (actual_hz_out == NULL))
    {
        return HAL_ERROR;
    }

    target_hz = ClampU32(target_hz, CTRL_TIMER_MIN_HZ, CTRL_TIMER_MAX_HZ);

    /* 更新频率公式：
     * update_hz = timer_clk_hz / ((PSC + 1) * (ARR + 1))
     *
     * 由于 ARR 只有 16 位，必须满足：
     * (ARR + 1) <= 65536
     *
     * 先求满足该约束的最小分频系数 divider = PSC + 1：
     * divider >= timer_clk_hz / (target_hz * 65536)
     *
     * 这里使用向上取整，确保后续计算得到的 ARR 不会越界。
     */
    denominator = (uint64_t)target_hz * (CTRL_TIMER_COUNTER_MAX + 1ULL);
    divider = ((uint64_t)timer_clk_hz + denominator - 1ULL) / denominator;
    divider = (uint64_t)ClampU32((uint32_t)divider, 1U, CTRL_TIMER_COUNTER_MAX + 1U);

    tick_hz = (uint64_t)timer_clk_hz / divider;

    /* 重新整理更新频率公式：
     * ARR + 1 = tick_hz / target_hz
     *
     * 为减小频率量化误差，这里不直接截断，而是采用四舍五入：
     * round(a / b) = (a + b / 2) / b
     */
    reload = (tick_hz + ((uint64_t)target_hz / 2ULL)) / (uint64_t)target_hz;
    reload = (uint64_t)ClampU32((uint32_t)reload, 1U, CTRL_TIMER_COUNTER_MAX + 1U);

    *psc_out = (uint32_t)(divider - 1ULL);
    *arr_out = (uint32_t)(reload - 1ULL);
    *actual_hz_out = (uint32_t)(tick_hz / reload);

    return (*actual_hz_out == 0U) ? HAL_ERROR : HAL_OK;
}

/**
 * @brief 启动一个固定频率的控制周期定时器中断。
 * @param ctx 控制定时器上下文。
 * @param htim HAL 定时器句柄，例如 &htim6。
 * @param timer_clk_hz 当前 TIM 外设真实输入时钟，单位 Hz。
 * @param target_hz 期望控制周期频率，单位 Hz，函数内部限幅到 [50, 20000]。
 * @retval HAL_OK 启动成功，HAL_ERROR 表示参数错误或底层 HAL 启动失败。
 */
HAL_StatusTypeDef ControlTimer_Start(ControlTimer_t *ctx,
                                     TIM_HandleTypeDef *htim,
                                     uint32_t timer_clk_hz,
                                     uint32_t target_hz)
{
    uint32_t psc;
    uint32_t arr;
    uint32_t actual_hz;

    if ((ctx == NULL) || (htim == NULL))
    {
        return HAL_ERROR;
    }

    target_hz = ClampU32(target_hz, CTRL_TIMER_MIN_HZ, CTRL_TIMER_MAX_HZ);

    if (ControlTimer_ComputeDividers(timer_clk_hz, target_hz, &psc, &arr, &actual_hz) != HAL_OK)
    {
        return HAL_ERROR;
    }

    ctx->htim = htim;
    ctx->timer_clk_hz = timer_clk_hz;
    ctx->target_hz = target_hz;
    ctx->actual_hz = actual_hz;
    ctx->tick_count = 0U;
    ctx->period_elapsed = 0U;

    /* 停止后再重配，避免运行中途修改寄存器导致当前周期被截断。 */
    (void)HAL_TIM_Base_Stop_IT(htim);
    __HAL_TIM_DISABLE(htim);

    __HAL_TIM_SET_PRESCALER(htim, psc);
    __HAL_TIM_SET_AUTORELOAD(htim, arr);
    __HAL_TIM_SET_COUNTER(htim, 0U);
    __HAL_TIM_CLEAR_FLAG(htim, TIM_FLAG_UPDATE);

    /* 强制生成一次更新事件，把 PSC/ARR 的预装载值同步进影子寄存器。
     * 若省略这一步，第一次周期可能沿用旧分频参数，导致首个中断节拍失真。
     */
    __HAL_TIM_GENERATE_EVENT(htim, TIM_EVENTSOURCE_UPDATE);

    return HAL_TIM_Base_Start_IT(htim);
}

/**
 * @brief 读取并清除周期到达标志，供主循环做非阻塞调度。
 * @param ctx 控制定时器上下文。
 * @retval 1 表示有新的周期到达，0 表示当前无需执行周期任务。
 */
uint8_t ControlTimer_TakePeriodFlag(ControlTimer_t *ctx)
{
    uint8_t pending;

    if (ctx == NULL)
    {
        return 0U;
    }

    /* 虽然 8 位读写在 Cortex-M 上通常是原子的，但“读取后清零”属于读改写序列。
     * 这里短暂关中断，确保不会在清零瞬间丢掉一个刚到达的新周期。
     */
    __disable_irq();
    pending = ctx->period_elapsed;
    ctx->period_elapsed = 0U;
    __enable_irq();

    return pending;
}

/**
 * @brief 在 HAL 定时器回调中转发周期到达事件。
 * @param ctx 控制定时器上下文。
 * @param htim 当前触发回调的 HAL 定时器句柄。
 */
void ControlTimer_HandlePeriodElapsed(ControlTimer_t *ctx, TIM_HandleTypeDef *htim)
{
    if ((ctx == NULL) || (ctx->htim != htim))
    {
        return;
    }

    /* ISR 只做最小必要工作：
     * 1. 记录周期计数，供测速、超时与统计使用。
     * 2. 置位标志，把真正耗时的控制算法放回主循环。
     *
     * 这样做的目的，是把中断执行时间收缩到近似常量，降低高优先级抢占带来的周期抖动。
     */
    ctx->tick_count++;
    ctx->period_elapsed = 1U;
}

/**
 * @brief HAL 库统一的定时器更新中断回调。
 * @param htim 触发更新事件的 HAL 定时器句柄。
 */
void HAL_TIM_PeriodElapsedCallback(TIM_HandleTypeDef *htim)
{
    ControlTimer_HandlePeriodElapsed(&g_control_timer, htim);
}

void App_InitControlLoop(void)
{
    /* 例：TIM6 输入时钟 84 MHz，目标控制频率 1000 Hz。
     * 理想情况下：
     * update_hz = 84000000 / ((PSC + 1) * (ARR + 1)) ≈ 1000
     */
    (void)ControlTimer_Start(&g_control_timer, &htim6, 84000000U, 1000U);
}

void App_MainLoop(void)
{
    if (ControlTimer_TakePeriodFlag(&g_control_timer) == 0U)
    {
        return;
    }

    /* 在固定时基上执行采样、滤波与控制输出。
     * 周期确定之后，离散系统中的积分、微分与滤波参数才有物理意义。
     */
    Motor_ReadEncoder();
    Balance_UpdateEstimate();
    Balance_RunPid();
    Motor_ApplyOutput();
}
```

这段实现真正想解决的问题，不是“怎么把 TIM6 跑起来”，而是如何让控制系统拥有一个可信的时间底座。对定时器而言，稳定的节拍比复杂的功能更重要；对中断而言，确定性的执行边界比回调里堆多少逻辑更重要。实时系统最终比拼的，从来不是谁会写延时，而是谁能让数字逻辑持续忠于物理时间。
