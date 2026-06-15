---
title: "技能档案：STM32 定时器主从同步、TRGO 触发链与 ADC/PWM 相位锁定"
slug: "skill-stm32-timer-master-slave-trgo-adc-pwm-phase-lock"
date: 2026-06-15T08:22:52+08:00
draft: false
description: "从更新事件、TRGO、从模式复位到采样静默窗预算，系统拆解 STM32 如何把 PWM 边沿、ADC 采样与控制周期锁进同一条硬件时间轴。"
tags: ["STM32", "定时器", "TRGO", "ADC", "PWM", "主从同步", "嵌入式"]
categories: ["技能档案"]
image: ""
---

## 技能概述

很多电机控制、电源采样和高速闭环系统的问题，并不是 PWM 发不出来，也不是 ADC 采不到，而是两者虽然都在工作，却并不工作在同一个“物理时刻”上。MOSFET 刚翻转，死区还没走完，分流电阻上的电流还在恢复，运放还没建立，CPU 却已经在中断里读到了一个看似合法、实则带着开关噪声的样本。这个主题要解决的核心痛点，不是再写一遍 `HAL_TIM_PWM_Start()` 和 `HAL_ADC_Start()`，而是把 **主从定时器同步**、**TRGO 触发链**、**采样静默窗** 和 **影子寄存器更新时刻** 串成一条硬件时间合同，让 PWM、ADC 和控制周期对齐到同一条因果链上。

## 核心底层概念解析

- **TRGO/ITR 不是一个配置选项，而是一条片上时间总线**：主定时器把某个事件编码成 **TRGO**，从定时器通过 **ITR** 接收它。这个动作的本质，不是“模块 A 通知模块 B”，而是“整个芯片内部共享一次精确到硬件时钟边沿的时间参考”。
- **主从同步的核心不是谁先启动，而是谁定义相位零点**：一旦从定时器工作在 **Reset Mode**，每次收到主定时器触发，它的 `CNT` 都被硬件清零。此时 `t = 0` 不再是软件调用 `Start()` 的那一刻，而是主定时器事件到来的那一刻。
- **PWM 周期并不等于“任何时候都适合采样”**：功率级切换之后，电流采样链会经历死区、二极管反向恢复、分流电阻寄生振铃、运放建立和 ADC 采样保持孔径等一串物理过程。真正可用的采样窗口往往满足  
  `t_sample >= t_dead + t_rr + t_settle + t_aperture + t_guard`。  
  这个式子不是数学装饰，它定义了“数字采样何时才有资格代表模拟现实”。
- **从定时器经常扮演“硬件相位移器”**：主定时器只负责给出周期边界，从定时器在复位后延迟 `Δt` 再输出比较事件。于是 ADC 不再被迫采在 PWM 边沿，而是采在“边沿之后、噪声收敛之前后的某个安静位置”。
- **PWM 频率与采样相位本质上共享同一份计数预算**：若 PWM 定时器时钟为 `f_tim`、预分频为 `PSC`、自动重装值为 `ARR`，则边沿对齐 PWM 有  
  `f_pwm = f_tim / ((PSC + 1) * (ARR + 1))`。  
  这说明提高 PWM 频率，本质上是在缩短每个周期可分配给死区、建立、采样和控制的总时间。
- **采样延迟最终一定要回到计数器刻度**：若从定时器有效时钟为 `f_delay = f_tim2 / (PSC2 + 1)`，静默窗所需延迟为 `t_quiet`，则比较值近似满足  
  `CCR = ceil(t_quiet * f_delay)`。  
  这一步把纳秒级物理约束映射成了一个寄存器值，映射误差就是 `1 / f_delay`。
- **中断触发无法替代硬件触发，因为中断延迟不是常数**：哪怕 ISR 只抖动 `200 ns`，若 PWM 周期是 `50 us`，采样相位误差也有  
  `Δphi = 2π * Δt_jitter / T_pwm`。  
  在高 di/dt 场景里，这点相位误差足以把安静窗推回振铃边缘。硬件触发的价值，正是在于它把 `Δt_jitter` 压到软件不可企及的量级。
- **影子寄存器和更新事件决定的是“新参数何时生效”，不是“写寄存器何时发生”**：开启 `ARR`/`CCR` 预装载后，CPU 改写的其实只是影子值；真正把新值装入活动寄存器的是下一次 **Update Event**。这让占空比、采样延迟和周期切换能在统一边界生效，而不是半个周期内一半旧配置、一半新配置。
- **Reset Mode 与 Trigger Mode 解决的是两种不同问题**：`Trigger Mode` 适合“看到触发后开始跑”，`Reset Mode` 适合“每次触发都重建相位零点”。对 ADC/PWM 相位锁定来说，后者更关键，因为我们要的不是一次启动，而是每个 PWM 周期都重新对时。
- **主从链路如果穿过了错误的事件源，整个系统就会在错误的时间上稳定运行**：例如把 TRGO 绑在过早的更新事件、或把 ADC 绑在片选翻转而不是比较事件上，系统可能非常稳定地每次都采到坏数据。稳定不等于正确，正确依赖于触发源是否真的对应物理安静窗。
- **控制周期分频同样应该落在硬件时间轴上，而不是 `HAL_Delay()` 上**：很多系统会让 PWM 以 `20 kHz` 运行，而控制器只在每 `N` 个周期算一次。这个 `N` 最好由重复计数器或下游定时器分频实现，而不是依赖软件计数再碰巧赶上正确相位。
- **技术哲学上，定时器不是“帮 CPU 省事”的外设，而是 MCU 内部唯一真正理解时间因果顺序的硬件状态机**：当你把 PWM、ADC 和控制都挂在它的时间树上时，系统才是在尊重物理链路；否则就只是让多个模块各自独立地“差不多同时工作”。

## 代码能力展现

下面给出一个基于 **STM32 HAL** 的硬件触发链示例，场景如下：

- `TIM1` 作为 **PWM 主定时器**，输出 `20 kHz` 边沿对齐 PWM，并在每个周期更新点发出 `TRGO_UPDATE`。
- `TIM2` 作为 **延迟从定时器**，工作在 **Reset Slave Mode**。每次被 `TIM1` 的 `TRGO` 复位后，从 `0` 开始计数，延迟一段静默窗后在 `CCR1` 处输出 `TRGO_OC1REF`。
- `ADC1` 使用 **注入通道硬件触发**，触发源为 `TIM2_TRGO`。这样 ADC 采样时刻由硬件比较事件定义，而不是由 ISR 抢占时序定义。

代码重点不在“把三个外设初始化起来”，而在把 **PWM 周期**、**静默窗预算**、**采样相位** 和 **影子寄存器更新边界** 用明确公式串起来。

```c
#include "main.h"

#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#define PHASE_SYNC_PWM_FREQ_MIN_HZ              1000U
#define PHASE_SYNC_PWM_FREQ_MAX_HZ             200000U
#define PHASE_SYNC_TICK_HZ_MIN                 1000000U
#define PHASE_SYNC_ARR_MIN                           9U
#define PHASE_SYNC_ARR_MAX                       65535U
#define PHASE_SYNC_DELAY_MARGIN_TICKS                2U
#define PHASE_SYNC_NANOSECONDS_PER_SECOND   1000000000ULL

typedef struct
{
    uint32_t tim1_clk_hz;
    uint32_t tim2_clk_hz;
    uint32_t pwm_freq_hz;
    uint16_t tim1_prescaler;
    uint16_t tim2_prescaler;

    uint32_t deadtime_ns;
    uint32_t switch_recovery_ns;
    uint32_t shunt_amp_settle_ns;
    uint32_t adc_aperture_ns;
    uint32_t guard_ns;
} PwmAdcPhaseSyncRequest_t;

typedef struct
{
    uint16_t tim1_arr;
    uint16_t tim2_arr;
    uint16_t tim2_ccr1;

    uint32_t pwm_period_ns;
    uint32_t quiet_delay_ns;
    uint32_t tim2_tick_hz;
    uint16_t sample_phase_permille;
} PwmAdcPhaseSyncDerived_t;

extern TIM_HandleTypeDef htim1;
extern TIM_HandleTypeDef htim2;
extern ADC_HandleTypeDef hadc1;

static PwmAdcPhaseSyncDerived_t g_phase_sync;

static uint16_t PhaseSync_ClampU16(uint16_t value, uint16_t min_value, uint16_t max_value)
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

static uint32_t PhaseSync_ClampU32(uint32_t value, uint32_t min_value, uint32_t max_value)
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

static uint32_t PhaseSync_CeilDivU64(uint64_t numerator, uint32_t denominator)
{
    if ((numerator == 0ULL) || (denominator == 0U))
    {
        return 0U;
    }

    return (uint32_t)((numerator + (uint64_t)denominator - 1ULL) / (uint64_t)denominator);
}

static uint32_t PhaseSync_RoundDivU64(uint64_t numerator, uint32_t denominator)
{
    if (denominator == 0U)
    {
        return 0U;
    }

    return (uint32_t)((numerator + ((uint64_t)denominator / 2ULL)) / (uint64_t)denominator);
}

/**
 * @brief 根据 PWM 频率与时钟求解 TIM1 的 ARR。
 * @param tim_clk_hz TIM1 实际计数时钟，单位 Hz。
 * @param prescaler TIM1 预分频寄存器值。
 * @param pwm_freq_hz 目标 PWM 频率，单位 Hz。
 * @return 求得的 ARR 值；若参数非法则返回 0。
 *
 * @note 这里使用边沿对齐 PWM，因此频率关系为:
 *       f_pwm = f_tim / ((PSC + 1) * (ARR + 1))
 *
 *       推得:
 *       ARR + 1 = f_tim / ((PSC + 1) * f_pwm)
 *
 *       使用四舍五入而不是向下截断，避免系统性拉高实际 PWM 频率。
 */
static uint16_t PhaseSync_ComputeTim1Arr(uint32_t tim_clk_hz,
                                         uint16_t prescaler,
                                         uint32_t pwm_freq_hz)
{
    const uint32_t div = ((uint32_t)prescaler + 1U) * pwm_freq_hz;
    const uint32_t period_ticks = PhaseSync_RoundDivU64(tim_clk_hz, div);

    if ((div == 0U) || (period_ticks < (PHASE_SYNC_ARR_MIN + 1U)))
    {
        return 0U;
    }

    return (uint16_t)PhaseSync_ClampU32(period_ticks - 1U, PHASE_SYNC_ARR_MIN, PHASE_SYNC_ARR_MAX);
}

/**
 * @brief 计算 ADC 采样前必须等待的静默窗。
 * @param request 相位同步请求参数。
 * @return 静默窗时长，单位 ns。
 *
 * @note 静默窗预算采用保守求和:
 *       t_quiet = t_dead + t_switch_recovery + t_shunt_amp_settle
 *               + t_adc_aperture + t_guard
 *
 *       这个结果不是“最好如此”，而是“至少如此”。任何低估都会让 ADC
 *       在开关瞬态还未衰减时采到伪电流。
 */
static uint32_t PhaseSync_ComputeQuietDelayNs(const PwmAdcPhaseSyncRequest_t *request)
{
    uint64_t quiet_ns;

    if (request == NULL)
    {
        return 0U;
    }

    quiet_ns = (uint64_t)request->deadtime_ns +
               (uint64_t)request->switch_recovery_ns +
               (uint64_t)request->shunt_amp_settle_ns +
               (uint64_t)request->adc_aperture_ns +
               (uint64_t)request->guard_ns;

    if (quiet_ns > 0xFFFFFFFFULL)
    {
        return 0xFFFFFFFFUL;
    }

    return (uint32_t)quiet_ns;
}

/**
 * @brief 由物理静默窗预算求解 TIM2 的 ARR 与 CCR1。
 * @param request 相位同步请求参数。
 * @param derived 输出的派生寄存器配置。
 * @retval true 求解成功。
 * @retval false 当前 PWM 周期与静默窗预算冲突。
 *
 * @note TIM2 在每个 PWM 周期起点被主定时器复位，因此:
 *       PWM 周期      T_pwm   = 1 / f_pwm
 *       TIM2 计数频率 f_tick  = f_tim2 / (PSC2 + 1)
 *       采样比较值    CCR1    = ceil(t_quiet * f_tick)
 *       周期上限      ARR2    = round(T_pwm * f_tick) - 1
 *
 *       若 `CCR1 >= ARR2`，说明硬件周期内已经没有足够空间容纳静默窗，
 *       这不是“参数不太好”，而是当前 PWM 频率与模拟链路恢复时间物理上冲突。
 */
static bool PhaseSync_BuildDerived(const PwmAdcPhaseSyncRequest_t *request,
                                   PwmAdcPhaseSyncDerived_t *derived)
{
    uint32_t tim2_tick_hz;
    uint32_t pwm_period_ns;
    uint32_t quiet_delay_ns;
    uint32_t tim2_period_ticks;
    uint32_t tim2_ccr1_ticks;

    if ((request == NULL) || (derived == NULL))
    {
        return false;
    }

    if ((request->tim1_clk_hz == 0U) ||
        (request->tim2_clk_hz == 0U) ||
        (request->pwm_freq_hz < PHASE_SYNC_PWM_FREQ_MIN_HZ) ||
        (request->pwm_freq_hz > PHASE_SYNC_PWM_FREQ_MAX_HZ))
    {
        return false;
    }

    memset(derived, 0, sizeof(*derived));

    derived->tim1_arr = PhaseSync_ComputeTim1Arr(request->tim1_clk_hz,
                                                 request->tim1_prescaler,
                                                 request->pwm_freq_hz);
    if (derived->tim1_arr == 0U)
    {
        return false;
    }

    tim2_tick_hz = request->tim2_clk_hz / ((uint32_t)request->tim2_prescaler + 1U);
    if (tim2_tick_hz < PHASE_SYNC_TICK_HZ_MIN)
    {
        return false;
    }

    pwm_period_ns = PhaseSync_RoundDivU64(PHASE_SYNC_NANOSECONDS_PER_SECOND,
                                          request->pwm_freq_hz);
    quiet_delay_ns = PhaseSync_ComputeQuietDelayNs(request);

    tim2_period_ticks = PhaseSync_RoundDivU64((uint64_t)pwm_period_ns * (uint64_t)tim2_tick_hz,
                                              (uint32_t)PHASE_SYNC_NANOSECONDS_PER_SECOND);
    tim2_ccr1_ticks = PhaseSync_CeilDivU64((uint64_t)quiet_delay_ns * (uint64_t)tim2_tick_hz,
                                           (uint32_t)PHASE_SYNC_NANOSECONDS_PER_SECOND);

    if ((tim2_period_ticks <= (PHASE_SYNC_DELAY_MARGIN_TICKS + 1U)) ||
        (tim2_period_ticks > (PHASE_SYNC_ARR_MAX + 1U)))
    {
        return false;
    }

    if (tim2_ccr1_ticks == 0U)
    {
        tim2_ccr1_ticks = 1U;
    }

    /*
     * 预留至少两个 tick 作为比较事件后的安全尾巴，避免比较点贴着周期终点，
     * 否则 ADC 触发可能落入下一次主复位边界附近。
     */
    if (tim2_ccr1_ticks >= (tim2_period_ticks - PHASE_SYNC_DELAY_MARGIN_TICKS))
    {
        return false;
    }

    derived->tim2_arr = (uint16_t)(tim2_period_ticks - 1U);
    derived->tim2_ccr1 = (uint16_t)PhaseSync_ClampU32(tim2_ccr1_ticks,
                                                      1U,
                                                      derived->tim2_arr - PHASE_SYNC_DELAY_MARGIN_TICKS);
    derived->pwm_period_ns = pwm_period_ns;
    derived->quiet_delay_ns = quiet_delay_ns;
    derived->tim2_tick_hz = tim2_tick_hz;
    derived->sample_phase_permille =
        (uint16_t)((((uint32_t)derived->tim2_ccr1) * 1000U) / ((uint32_t)derived->tim2_arr + 1U));

    return true;
}

/**
 * @brief 初始化 TIM1，使其作为 PWM 主定时器输出 TRGO_UPDATE。
 * @param htim TIM1 句柄。
 * @param derived 已求解的寄存器参数。
 * @retval HAL_OK 初始化成功。
 * @retval HAL_ERROR 初始化失败。
 *
 * @note 主定时器负责定义每个 PWM 周期的“相位零点”。示例把 TRGO 绑到
 *       Update Event，因此下游从定时器会在每个 PWM 周期边界自动重新对时。
 */
static HAL_StatusTypeDef PhaseSync_InitTim1Master(TIM_HandleTypeDef *htim,
                                                  const PwmAdcPhaseSyncDerived_t *derived,
                                                  uint16_t prescaler)
{
    TIM_MasterConfigTypeDef s_master = {0};
    TIM_OC_InitTypeDef s_oc = {0};

    if ((htim == NULL) || (derived == NULL))
    {
        return HAL_ERROR;
    }

    htim->Init.Prescaler = prescaler;
    htim->Init.CounterMode = TIM_COUNTERMODE_UP;
    htim->Init.Period = derived->tim1_arr;
    htim->Init.ClockDivision = TIM_CLOCKDIVISION_DIV1;
    htim->Init.RepetitionCounter = 0U;
    htim->Init.AutoReloadPreload = TIM_AUTORELOAD_PRELOAD_ENABLE;

    if (HAL_TIM_PWM_Init(htim) != HAL_OK)
    {
        return HAL_ERROR;
    }

    s_oc.OCMode = TIM_OCMODE_PWM1;
    s_oc.Pulse = (derived->tim1_arr + 1U) / 2U;
    s_oc.OCPolarity = TIM_OCPOLARITY_HIGH;
    s_oc.OCNPolarity = TIM_OCNPOLARITY_HIGH;
    s_oc.OCFastMode = TIM_OCFAST_DISABLE;
    s_oc.OCIdleState = TIM_OCIDLESTATE_RESET;
    s_oc.OCNIdleState = TIM_OCNIDLESTATE_RESET;

    if (HAL_TIM_PWM_ConfigChannel(htim, &s_oc, TIM_CHANNEL_1) != HAL_OK)
    {
        return HAL_ERROR;
    }

    s_master.MasterOutputTrigger = TIM_TRGO_UPDATE;
    s_master.MasterSlaveMode = TIM_MASTERSLAVEMODE_ENABLE;

    if (HAL_TIMEx_MasterConfigSynchronization(htim, &s_master) != HAL_OK)
    {
        return HAL_ERROR;
    }

    return HAL_OK;
}

/**
 * @brief 初始化 TIM2，使其作为延迟从定时器在静默窗结束处输出触发。
 * @param htim TIM2 句柄。
 * @param derived 已求解的寄存器参数。
 * @param prescaler TIM2 预分频寄存器值。
 * @retval HAL_OK 初始化成功。
 * @retval HAL_ERROR 初始化失败。
 *
 * @note TIM2 采用 Reset Slave Mode:
 *       1. 每次收到 TIM1 的 TRGO，TIM2 的 CNT 被硬件清零。
 *       2. TIM2 重新从 0 开始计数。
 *       3. 计到 CCR1 时输出 OC1REF，作为 ADC 采样触发。
 *
 *       这样形成了“PWM 周期起点 -> 硬件延迟 Δt -> ADC 采样”的严格链路。
 */
static HAL_StatusTypeDef PhaseSync_InitTim2DelaySlave(TIM_HandleTypeDef *htim,
                                                      const PwmAdcPhaseSyncDerived_t *derived,
                                                      uint16_t prescaler)
{
    TIM_SlaveConfigTypeDef s_slave = {0};
    TIM_MasterConfigTypeDef s_master = {0};
    TIM_OC_InitTypeDef s_oc = {0};

    if ((htim == NULL) || (derived == NULL))
    {
        return HAL_ERROR;
    }

    htim->Init.Prescaler = prescaler;
    htim->Init.CounterMode = TIM_COUNTERMODE_UP;
    htim->Init.Period = derived->tim2_arr;
    htim->Init.ClockDivision = TIM_CLOCKDIVISION_DIV1;
    htim->Init.AutoReloadPreload = TIM_AUTORELOAD_PRELOAD_ENABLE;

    if (HAL_TIM_OC_Init(htim) != HAL_OK)
    {
        return HAL_ERROR;
    }

    /*
     * 这里假设目标芯片上 TIM1 -> TIM2 走 ITR0。不同 STM32 家族 ITR 映射表
     * 不完全一致，移植时必须先查参考手册，而不是照搬枚举值。
     */
    s_slave.SlaveMode = TIM_SLAVEMODE_RESET;
    s_slave.InputTrigger = TIM_TS_ITR0;
    s_slave.TriggerPolarity = TIM_TRIGGERPOLARITY_NONINVERTED;
    s_slave.TriggerPrescaler = TIM_TRIGGERPRESCALER_DIV1;
    s_slave.TriggerFilter = 0U;

    if (HAL_TIM_SlaveConfigSynchro(htim, &s_slave) != HAL_OK)
    {
        return HAL_ERROR;
    }

    s_oc.OCMode = TIM_OCMODE_TIMING;
    s_oc.Pulse = derived->tim2_ccr1;
    s_oc.OCPolarity = TIM_OCPOLARITY_HIGH;
    s_oc.OCFastMode = TIM_OCFAST_DISABLE;

    if (HAL_TIM_OC_ConfigChannel(htim, &s_oc, TIM_CHANNEL_1) != HAL_OK)
    {
        return HAL_ERROR;
    }

    s_master.MasterOutputTrigger = TIM_TRGO_OC1REF;
    s_master.MasterSlaveMode = TIM_MASTERSLAVEMODE_DISABLE;

    if (HAL_TIMEx_MasterConfigSynchronization(htim, &s_master) != HAL_OK)
    {
        return HAL_ERROR;
    }

    return HAL_OK;
}

/**
 * @brief 初始化 ADC1 注入通道，使其由 TIM2_TRGO 触发。
 * @param hadc ADC 句柄。
 * @retval HAL_OK 初始化成功。
 * @retval HAL_ERROR 初始化失败。
 *
 * @note ADC 采用硬件外部触发，意味着采样开始时刻由定时器比较事件定义，
 *       而不是由 CPU 何时进入 ISR 定义。对于高 di/dt 电流采样，这是比
 *       “中断里手动启动 ADC”更关键的系统边界。
 */
static HAL_StatusTypeDef PhaseSync_InitAdcInjected(ADC_HandleTypeDef *hadc)
{
    ADC_InjectionConfTypeDef s_injected = {0};

    if (hadc == NULL)
    {
        return HAL_ERROR;
    }

    s_injected.InjectedChannel = ADC_CHANNEL_1;
    s_injected.InjectedRank = ADC_INJECTED_RANK_1;
    s_injected.InjectedNbrOfConversion = 1U;
    s_injected.InjectedSamplingTime = ADC_SAMPLETIME_15CYCLES;
    s_injected.ExternalTrigInjecConvEdge = ADC_EXTERNALTRIGINJECCONVEDGE_RISING;
    s_injected.ExternalTrigInjecConv = ADC_EXTERNALTRIGINJECCONV_T2_TRGO;
    s_injected.AutoInjectedConv = DISABLE;
    s_injected.InjectedDiscontinuousConvMode = DISABLE;
    s_injected.InjectedOffset = 0U;

    if (HAL_ADCEx_InjectedConfigChannel(hadc, &s_injected) != HAL_OK)
    {
        return HAL_ERROR;
    }

    return HAL_OK;
}

/**
 * @brief 建立一条 PWM -> TIM2 延迟 -> ADC 注入采样的硬件相位锁定链。
 * @param request 相位同步请求参数。
 * @retval HAL_OK 初始化成功。
 * @retval HAL_ERROR 当前频率、时钟或静默窗预算不可满足。
 *
 * @note 该函数的关键不是“把外设启动起来”，而是先验证
 *       `t_quiet < T_pwm` 这条物理约束是否成立。若不成立，说明
 *       模拟链路恢复时间已经超过一个 PWM 周期，继续强行初始化只会得到
 *       看似运行、实则相位错误的采样系统。
 */
HAL_StatusTypeDef PowerStage_PhaseSyncInit(const PwmAdcPhaseSyncRequest_t *request)
{
    if (!PhaseSync_BuildDerived(request, &g_phase_sync))
    {
        return HAL_ERROR;
    }

    if (PhaseSync_InitTim1Master(&htim1, &g_phase_sync, request->tim1_prescaler) != HAL_OK)
    {
        return HAL_ERROR;
    }

    if (PhaseSync_InitTim2DelaySlave(&htim2, &g_phase_sync, request->tim2_prescaler) != HAL_OK)
    {
        return HAL_ERROR;
    }

    if (PhaseSync_InitAdcInjected(&hadc1) != HAL_OK)
    {
        return HAL_ERROR;
    }

    if (HAL_TIM_PWM_Start(&htim1, TIM_CHANNEL_1) != HAL_OK)
    {
        return HAL_ERROR;
    }

    if (HAL_TIM_OC_Start(&htim2, TIM_CHANNEL_1) != HAL_OK)
    {
        return HAL_ERROR;
    }

    if (HAL_ADCEx_InjectedStart_IT(&hadc1) != HAL_OK)
    {
        return HAL_ERROR;
    }

    return HAL_OK;
}

/**
 * @brief 在系统在线整定后更新 ADC 采样延迟。
 * @param quiet_delay_ns 新的静默窗预算，单位 ns。
 * @retval true 更新成功。
 * @retval false 新延迟超出当前 PWM 周期可容纳范围。
 *
 * @note 比较值映射公式:
 *       CCR1 = ceil(t_quiet * f_tick)
 *
 *       由于 TIM2 开启了 ARR/CCR 预装载，新值不会在写寄存器瞬间生效，
 *       而会等到下一次更新事件一起装载。这保证了相位切换的无毛刺。
 */
bool PowerStage_UpdateQuietDelayNs(uint32_t quiet_delay_ns)
{
    uint32_t new_ccr;

    new_ccr = PhaseSync_CeilDivU64((uint64_t)quiet_delay_ns * (uint64_t)g_phase_sync.tim2_tick_hz,
                                   (uint32_t)PHASE_SYNC_NANOSECONDS_PER_SECOND);

    if ((new_ccr == 0U) ||
        (new_ccr >= ((uint32_t)g_phase_sync.tim2_arr - PHASE_SYNC_DELAY_MARGIN_TICKS)))
    {
        return false;
    }

    g_phase_sync.quiet_delay_ns = quiet_delay_ns;
    g_phase_sync.tim2_ccr1 = (uint16_t)new_ccr;
    g_phase_sync.sample_phase_permille =
        (uint16_t)((new_ccr * 1000U) / ((uint32_t)g_phase_sync.tim2_arr + 1U));

    /*
     * 只更新影子寄存器，不在半个周期中途强行改动活动寄存器。
     * 这样下一次主定时器边界到来时，PWM 周期和 ADC 延迟会一起切换。
     */
    __HAL_TIM_SET_COMPARE(&htim2, TIM_CHANNEL_1, g_phase_sync.tim2_ccr1);
    return true;
}
```

这段实现有几个工程重点值得单独强调：

- `PowerStage_PhaseSyncInit()` 并不是先初始化外设、再看看能不能跑，而是先验证 `t_quiet < T_pwm`。如果这个条件不成立，问题是物理预算冲突，不是 HAL API 选错了。
- `TIM1` 负责定义 PWM 周期零点，`TIM2` 负责在零点之后延迟 `quiet_delay_ns`，`ADC1` 只负责在那个硬件事件上采样。三个外设各司其职，没有让 CPU 站在中间“凭感觉对时”。
- `PowerStage_UpdateQuietDelayNs()` 只写入比较寄存器影子值，不在半个周期中途强改活动寄存器。这能避免一次采样用旧相位、下一次采样用新相位的半拍错位。
- 代码里显式保留了 `deadtime_ns`、`switch_recovery_ns`、`shunt_amp_settle_ns` 和 `adc_aperture_ns` 四段预算，而不是只留一个神秘的 `sample_delay_ticks`。这让寄存器值和物理来源是一一可追溯的。
- 如果后续需要把控制 ISR 也锁到同一时间轴，可以继续让下游定时器从 `TIM1_TRGO` 分频得到控制节拍，而不是再开一个独立 `SysTick` 自己计数。

真正成熟的定时设计，从来不是“把几个外设同时启动”，而是让 **PWM 切换、模拟恢复、ADC 取样、控制更新** 全部承认同一条时间因果链。主从同步和 TRGO 触发链的价值，就在于它把这条因果链从软件约定，变成了硬件事实。
