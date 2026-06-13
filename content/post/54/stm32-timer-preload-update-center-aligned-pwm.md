---
title: "技能档案：STM32 定时器影子寄存器、更新事件与中心对齐 PWM 的无毛刺更新"
slug: "skill-stm32-timer-preload-update-event-center-aligned-pwm-glitch-free-update"
date: 2026-06-11T12:29:21+08:00
draft: false
description: "从影子寄存器、更新事件、中心对齐载波到多通道比较值原子装载，系统拆解 STM32 PWM 为何真正难在改值的时刻，而不是改值本身。"
tags: ["STM32", "定时器", "PWM", "更新事件", "中心对齐", "预装载", "中断"]
categories: ["技能档案"]
image: ""
---

## 技能概述

STM32 定时器输出 PWM，表面上像是在改一个 `CCR` 数值，实质上是在一条已经运行中的离散时间轨道上重新签署下一周期的电压占有权。只要系统涉及电机调速、同步整流、半桥驱动、数字电源或者多通道互补输出，真正的痛点通常都不是“PWM 能不能出来”，而是占空比在运行中更新时会不会切断当前脉冲、三路输出会不会只更新了一半、中心对齐模式下上下半周是否失去对称、ADC 触发点是否因此漂移。这个主题要解决的核心问题，不是再包一层 `__HAL_TIM_SET_COMPARE()`，而是把 **影子寄存器**、**更新事件**、**中心对齐计数** 和 **多通道原子装载** 串成一份可证明的时域合同。

## 核心底层概念解析

- **定时器计数器** 不是“一个递增变量”，而是一条离散时间轴：`PSC` 决定这条时间轴的刻度有多细，`ARR` 决定一个载波周期在时间轴上有多长。PWM 的频率、分辨率、更新边界，本质上都绑定在这条计数轨道上。
- **影子寄存器与活动寄存器** 构成了硬件级双缓冲：开启 `ARPE/OCxPE` 后，软件写入的不是当前正在驱动引脚的值，而是“下一次允许提交时将要生效的值”。这和数据库里的 staging area 很像，先暂存，再在统一边界提交。
- **更新事件 `UEV`** 是硬件承认“本周期已经结束”的瞬间：只有在这个边界上，预装载的 `ARR/CCR` 才会整体转正成为活动值。若没有这个边界，软件写寄存器只是把新命令塞进候车区，还没有真正影响引脚。
- **毛刺的根源不是写错值，而是写对了值却写在错误时刻**：例如上数过程中，计数器已经越过旧的 `CCR=700`，你此时直接把活动比较值改成 `CCR=300`，那么这一半周里“计数器与比较值相遇”的事件可能已经错过，输出就会多保持半个周期，表现为异常宽脉冲。
- **中心对齐模式** 的价值不只是“波形更对称”，而是把比较动作分布到上数和下数两个方向：这会降低频谱能量集中、减轻电流纹波和采样相位偏置，但也意味着软件若在半周期中途直接插值，代价往往比边沿对齐模式更明显。
- **中心对齐 PWM 的频率与占空比映射要按时域重新理解**：对高级定时器常见场景，可近似写成  
  `f_pwm = f_tim / (2 * (PSC + 1) * ARR)`，  
  `duty ~= CCR / ARR`。  
  因此 `ARR` 既决定载波频率，也决定占空比分辨率 `Delta duty ~= 1 / ARR`。提升频率通常会压缩 `ARR`，从而牺牲可表达的占空比分辨率。
- **多通道更新本质上是一笔事务，而不是三次赋值**：三相桥、双路同步整流或推挽驱动，要求 `CCR1/CCR2/CCR3` 在同一个边界切换生效。若任务线程先后调用三次 `SET_COMPARE`，硬件看到的可能是三次分散提交，而不是一帧一致的波形更新。
- **`RCR` 重复计数器** 解决的是“可见更新边界的粒度”问题：某些中心对齐配置下，硬件更新边界可能比控制算法想要的更频繁。高级定时器允许把若干底层计数周期合并成一次对软件可见的更新节拍，让“算一帧、提交一帧”的节奏更干净。
- **软件更新动作应该围绕载波边界组织，而不是围绕控制任务醒来的时刻组织**：控制环即便是 `10 kHz`，如果它的唤醒相位相对 PWM 载波在漂，直接写 `CCR` 仍会把抖动注入功率级。更可靠的做法是: 控制环只产生命令，真正写硬件预装载寄存器的动作固定放在更新边界之后。
- **`UG` 软件更新事件** 不是“让改值立刻生效”的万能按钮：在输出已经运行时强行触发 `UG`，等于人为制造一个新的提交边界，可能让尚未准备好的 `ARR/CCR` 提前转正。它更适合用于定时器停机配置、首次装载或故障恢复后的受控重启。
- **ADC 触发、死区和 PWM 提交边界其实是同一套时序合同的不同侧面**：一旦占空比更新边界漂移，基于 `TRGO` 的 ADC 采样窗、基于 `BDTR` 的死区安排乃至互补输出的导通对称性都会一起被带歪。很多“电流环突然抖”“采样相位偶发错位”不是算法失稳，而是载波时序被软件打断。
- **技术哲学上，定时器预装载机制并不是为了省心，而是为了阻止软件在物理过程进行到一半时改写现实**：数字控制要尊重物理时间边界。无毛刺 PWM 的关键，不是写得更快，而是在正确的边界提交下一份波形契约。

## 代码能力展现

下面给出一个基于 STM32 HAL 使用场景的中心对齐 PWM 装载模块。假设使用 `TIM1` 驱动三路功率输出，控制环在主循环或其他定时任务里计算三路归一化占空比，而真正写入硬件比较寄存器的动作统一放在 **更新事件回调** 之后完成。代码重点不是初始化模板，而是四条更硬的链路：**中心对齐载波参数计算**、**归一化占空比到比较值的线性映射与限幅**、**软件双缓冲到硬件预装载寄存器的原子提交**、**在载波边界而不是任意时刻改写 PWM**。

```c
#include "main.h"

#include <math.h>
#include <stdbool.h>
#include <stdint.h>

#define PWM_CENTER_MIN_HZ                 1000U
#define PWM_CENTER_MAX_HZ                100000U
#define PWM_CENTER_MAX_ARR               65535U
#define PWM_CENTER_MAX_PSC               65535U
#define PWM_CENTER_CHANNEL_COUNT             3U

typedef struct
{
    float a;
    float b;
    float c;
} PwmDutyFrame_t;

typedef struct
{
    uint16_t ccr1;
    uint16_t ccr2;
    uint16_t ccr3;
    uint32_t sequence;
    uint8_t valid;
} PwmPendingFrame_t;

typedef struct
{
    TIM_HandleTypeDef *htim;
    uint32_t timer_clk_hz;
    uint32_t target_pwm_hz;
    uint32_t actual_pwm_hz;
    uint16_t arr;
    uint16_t psc;
    uint16_t guard_ticks;
    volatile uint32_t carrier_sequence;
    volatile uint32_t applied_sequence;
    volatile PwmPendingFrame_t pending;
} PwmCenterAligned_t;

static PwmCenterAligned_t g_pwm1;

static float ClampF(float value, float min_value, float max_value)
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

static uint16_t ClampU16(uint16_t value, uint16_t min_value, uint16_t max_value)
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

static uint16_t RoundToU16(float value)
{
    if (value <= 0.0f)
    {
        return 0U;
    }

    if (value >= (float)PWM_CENTER_MAX_ARR)
    {
        return PWM_CENTER_MAX_ARR;
    }

    return (uint16_t)(value + 0.5f);
}

/**
 * @brief 计算中心对齐 PWM 的 PSC/ARR 组合。
 * @param timer_clk_hz 定时器输入时钟，单位 Hz。
 * @param target_pwm_hz 目标 PWM 载波频率，单位 Hz。
 * @param psc_out 输出的预分频寄存器值。
 * @param arr_out 输出的自动重装载寄存器值。
 * @param actual_pwm_hz_out 输出的实际可实现频率，便于评估量化误差。
 * @retval HAL_OK 计算成功，HAL_ERROR 表示参数非法。
 */
static HAL_StatusTypeDef PwmCenter_ComputeDividers(uint32_t timer_clk_hz,
                                                   uint32_t target_pwm_hz,
                                                   uint16_t *psc_out,
                                                   uint16_t *arr_out,
                                                   uint32_t *actual_pwm_hz_out)
{
    uint64_t min_divider;
    uint64_t timer_cnt_hz;
    uint64_t arr_counts;

    if ((timer_clk_hz == 0U) ||
        (psc_out == NULL) ||
        (arr_out == NULL) ||
        (actual_pwm_hz_out == NULL))
    {
        return HAL_ERROR;
    }

    target_pwm_hz = ClampU32(target_pwm_hz, PWM_CENTER_MIN_HZ, PWM_CENTER_MAX_HZ);

    /*
     * 中心对齐一整个载波周期包含上数与下数两段，可近似写成:
     * T_pwm = 2 * ARR * (PSC + 1) / f_tim
     * f_pwm = f_tim / (2 * ARR * (PSC + 1))
     *
     * 这里先求满足 ARR 不超过 16 位上限时所需的最小分频系数:
     * PSC + 1 >= f_tim / (2 * f_pwm * ARR_max)
     *
     * 使用向上取整，保证后续反推出来的 ARR 不会溢出。
     */
    min_divider = ((uint64_t)timer_clk_hz + (2ULL * (uint64_t)target_pwm_hz * (uint64_t)PWM_CENTER_MAX_ARR) - 1ULL) /
                  (2ULL * (uint64_t)target_pwm_hz * (uint64_t)PWM_CENTER_MAX_ARR);

    min_divider = ClampU32((uint32_t)min_divider, 1U, PWM_CENTER_MAX_PSC + 1U);
    timer_cnt_hz = (uint64_t)timer_clk_hz / min_divider;

    /*
     * 由 f_pwm = f_cnt / (2 * ARR) 反推:
     * ARR = round(f_cnt / (2 * f_pwm))
     *
     * 这里采用四舍五入，尽量减小频率量化误差。
     */
    arr_counts = (timer_cnt_hz + (uint64_t)target_pwm_hz) / (2ULL * (uint64_t)target_pwm_hz);
    arr_counts = ClampU32((uint32_t)arr_counts, 1U, PWM_CENTER_MAX_ARR);

    *psc_out = (uint16_t)(min_divider - 1ULL);
    *arr_out = (uint16_t)arr_counts;
    *actual_pwm_hz_out = (uint32_t)(timer_cnt_hz / (2ULL * arr_counts));

    return (*actual_pwm_hz_out == 0U) ? HAL_ERROR : HAL_OK;
}

/**
 * @brief 将归一化占空比映射为中心对齐 PWM 比较值。
 * @param duty 归一化占空比，期望范围 [0.0, 1.0]。
 * @param arr 当前自动重装载值。
 * @param guard_ticks 为采样静默窗、最小脉宽或驱动保护预留的保护计数。
 * @return 可直接写入 CCRx 的比较值。
 */
static uint16_t PwmCenter_DutyToCompare(float duty, uint16_t arr, uint16_t guard_ticks)
{
    uint16_t compare;

    duty = ClampF(duty, 0.0f, 1.0f);

    /*
     * 在中心对齐 PWM Mode 1 下，理想化近似关系为:
     * duty ~= CCR / ARR
     * 因而可反推:
     * CCR = round(duty * ARR)
     *
     * 若系统为了 ADC 采样静默窗、最小导通脉宽或驱动器保护需要，
     * 可以再把 0% 与 100% 之外的有效范围限缩到 [guard_ticks, ARR - guard_ticks]。
     */
    compare = RoundToU16(duty * (float)arr);

    if ((compare > 0U) && (compare < arr) && (guard_ticks > 0U))
    {
        compare = ClampU16(compare, guard_ticks, (uint16_t)(arr - guard_ticks));
    }

    return compare;
}

/**
 * @brief 配置 TIM1 为中心对齐 PWM，并启用 ARR/CCR 预装载。
 * @param ctx PWM 上下文。
 * @param htim HAL 定时器句柄，示例假设为 TIM1。
 * @param timer_clk_hz 定时器真实输入时钟。
 * @param target_pwm_hz 目标载波频率。
 * @param guard_ticks 非零时，为占空比保留的保护计数。
 * @retval HAL_OK 成功，HAL_ERROR 失败。
 */
HAL_StatusTypeDef PwmCenter_Init(PwmCenterAligned_t *ctx,
                                 TIM_HandleTypeDef *htim,
                                 uint32_t timer_clk_hz,
                                 uint32_t target_pwm_hz,
                                 uint16_t guard_ticks)
{
    uint16_t psc;
    uint16_t arr;
    uint32_t actual_pwm_hz;

    if ((ctx == NULL) || (htim == NULL))
    {
        return HAL_ERROR;
    }

    if (PwmCenter_ComputeDividers(timer_clk_hz,
                                  target_pwm_hz,
                                  &psc,
                                  &arr,
                                  &actual_pwm_hz) != HAL_OK)
    {
        return HAL_ERROR;
    }

    ctx->htim = htim;
    ctx->timer_clk_hz = timer_clk_hz;
    ctx->target_pwm_hz = ClampU32(target_pwm_hz, PWM_CENTER_MIN_HZ, PWM_CENTER_MAX_HZ);
    ctx->actual_pwm_hz = actual_pwm_hz;
    ctx->psc = psc;
    ctx->arr = arr;
    ctx->guard_ticks = (guard_ticks >= arr) ? 0U : guard_ticks;
    ctx->carrier_sequence = 0U;
    ctx->applied_sequence = 0U;
    ctx->pending.ccr1 = 0U;
    ctx->pending.ccr2 = 0U;
    ctx->pending.ccr3 = 0U;
    ctx->pending.sequence = 0U;
    ctx->pending.valid = 0U;

    /*
     * 关键点:
     * 1. 先停表，避免在输出运行中途修改活动寄存器；
     * 2. 打开 ARPE/OCxPE，让 ARR/CCR 写入先进 preload；
     * 3. 中心对齐模式下用载波边界统一提交，而不是让任务线程随时改波形。
     */
    __HAL_TIM_DISABLE(htim);
    __HAL_TIM_SET_COUNTER(htim, 0U);
    __HAL_TIM_SET_PRESCALER(htim, psc);
    __HAL_TIM_SET_AUTORELOAD(htim, arr);
    __HAL_TIM_SET_COMPARE(htim, TIM_CHANNEL_1, 0U);
    __HAL_TIM_SET_COMPARE(htim, TIM_CHANNEL_2, 0U);
    __HAL_TIM_SET_COMPARE(htim, TIM_CHANNEL_3, 0U);

    htim->Instance->CR1 |= TIM_CR1_ARPE;
    htim->Instance->CR1 &= ~TIM_CR1_CMS;
    htim->Instance->CR1 |= TIM_COUNTERMODE_CENTERALIGNED1;

    htim->Instance->CCMR1 |= TIM_CCMR1_OC1PE | TIM_CCMR1_OC2PE;
    htim->Instance->CCMR2 |= TIM_CCMR2_OC3PE;

    /*
     * 对 TIM1/TIM8 这类高级定时器，可通过 RCR 让软件只在完整载波边界看到一次更新。
     * 这里设置为 1，含义是“底层计数边界累计 2 次后，再向软件报告 1 次完整周期更新”。
     */
    htim->Instance->RCR = 1U;

    __HAL_TIM_CLEAR_FLAG(htim, TIM_FLAG_UPDATE);
    __HAL_TIM_ENABLE_IT(htim, TIM_IT_UPDATE);

    /*
     * 仅在定时器停机状态下使用 UG，目的是把刚写入的 PSC/ARR/CCR preload
     * 同步进活动寄存器，建立一个干净的初始状态，而不是运行中途插入额外提交边界。
     */
    __HAL_TIM_GENERATE_EVENT(htim, TIM_EVENTSOURCE_UPDATE);

    if ((HAL_TIM_PWM_Start(htim, TIM_CHANNEL_1) != HAL_OK) ||
        (HAL_TIM_PWM_Start(htim, TIM_CHANNEL_2) != HAL_OK) ||
        (HAL_TIM_PWM_Start(htim, TIM_CHANNEL_3) != HAL_OK))
    {
        return HAL_ERROR;
    }

    __HAL_TIM_ENABLE(htim);

    return HAL_OK;
}

/**
 * @brief 提交下一帧三路占空比请求。函数只写软件缓冲，不直接改硬件输出。
 * @param ctx PWM 上下文。
 * @param duty_frame 三路归一化占空比，范围建议为 [0.0, 1.0]。
 * @retval HAL_OK 成功，HAL_ERROR 表示参数非法。
 */
HAL_StatusTypeDef PwmCenter_RequestDutyFrame(PwmCenterAligned_t *ctx,
                                             const PwmDutyFrame_t *duty_frame)
{
    uint16_t next_ccr1;
    uint16_t next_ccr2;
    uint16_t next_ccr3;
    uint32_t primask;

    if ((ctx == NULL) || (duty_frame == NULL))
    {
        return HAL_ERROR;
    }

    next_ccr1 = PwmCenter_DutyToCompare(duty_frame->a, ctx->arr, ctx->guard_ticks);
    next_ccr2 = PwmCenter_DutyToCompare(duty_frame->b, ctx->arr, ctx->guard_ticks);
    next_ccr3 = PwmCenter_DutyToCompare(duty_frame->c, ctx->arr, ctx->guard_ticks);

    /*
     * 这里只更新软件 pending 帧，不碰硬件 CCR。
     * 控制环可以在任何相位计算 duty，但真正写 preload 的动作必须回到更新边界之后，
     * 否则三路输出可能出现“通道 1 已换新值，通道 3 还保留旧值”的半帧状态。
     */
    primask = __get_PRIMASK();
    __disable_irq();

    ctx->pending.ccr1 = next_ccr1;
    ctx->pending.ccr2 = next_ccr2;
    ctx->pending.ccr3 = next_ccr3;
    ctx->pending.sequence += 1U;
    ctx->pending.valid = 1U;

    if (primask == 0U)
    {
        __enable_irq();
    }

    return HAL_OK;
}

/**
 * @brief 在定时器更新边界之后，把上一轮控制环算好的占空比原子装载进 CCR preload。
 * @param ctx PWM 上下文。
 */
void PwmCenter_OnPeriodElapsed(PwmCenterAligned_t *ctx)
{
    uint16_t ccr1;
    uint16_t ccr2;
    uint16_t ccr3;
    uint32_t sequence;
    uint32_t primask;

    if ((ctx == NULL) || (ctx->htim == NULL))
    {
        return;
    }

    ctx->carrier_sequence += 1U;

    if (ctx->pending.valid == 0U)
    {
        return;
    }

    primask = __get_PRIMASK();
    __disable_irq();

    ccr1 = ctx->pending.ccr1;
    ccr2 = ctx->pending.ccr2;
    ccr3 = ctx->pending.ccr3;
    sequence = ctx->pending.sequence;
    ctx->pending.valid = 0U;

    if (primask == 0U)
    {
        __enable_irq();
    }

    /*
     * 此回调发生在 UEV 已经被硬件承认之后:
     * - 上一帧 preload 已经整体转正为当前活动值；
     * - 现在写入的新 CCR 只会进入下一帧 preload；
     * - 因而不会截断当前这一个完整载波周期。
     *
     * 这就是“无毛刺更新”的核心: 软件永远只在边界后为下一周期准备数据，
     * 而不是在本周期进行到一半时修改现实。
     */
    __HAL_TIM_SET_COMPARE(ctx->htim, TIM_CHANNEL_1, ccr1);
    __HAL_TIM_SET_COMPARE(ctx->htim, TIM_CHANNEL_2, ccr2);
    __HAL_TIM_SET_COMPARE(ctx->htim, TIM_CHANNEL_3, ccr3);

    ctx->applied_sequence = sequence;
}

/**
 * @brief 查询最近一次请求是否已经被硬件提交。
 * @param ctx PWM 上下文。
 * @return true 表示最近一次 pending 帧已经在某个更新边界写入了硬件 preload。
 */
bool PwmCenter_IsFrameApplied(const PwmCenterAligned_t *ctx)
{
    if (ctx == NULL)
    {
        return false;
    }

    return (ctx->pending.valid == 0U) && (ctx->applied_sequence != 0U);
}

void MotorPwm_Init(void)
{
    /*
     * 示例:
     * - TIM1 输入时钟 168 MHz
     * - 目标中心对齐载波 20 kHz
     * - guard_ticks = 24，用于给电流采样静默窗和驱动保护留边界
     */
    (void)PwmCenter_Init(&g_pwm1, &htim1, 168000000U, 20000U, 24U);
}

void MotorControl_Task10kHz(void)
{
    PwmDutyFrame_t next_frame;

    /*
     * 这里假设 FOC 或电压环已经在别处算出了三相归一化占空比。
     * 控制任务只负责“产生命令”，不直接碰 TIM1->CCR。
     */
    next_frame.a = 0.42f;
    next_frame.b = 0.73f;
    next_frame.c = 0.28f;

    (void)PwmCenter_RequestDutyFrame(&g_pwm1, &next_frame);
}

void HAL_TIM_PeriodElapsedCallback(TIM_HandleTypeDef *htim)
{
    if (htim->Instance == TIM1)
    {
        PwmCenter_OnPeriodElapsed(&g_pwm1);
    }
}
```

这段代码的关键不在“又写了一个 PWM 驱动”，而在它明确区分了三件事：第一，**控制环计算 duty** 是软件层行为；第二，**写入 preload** 是硬件边界后的提交行为；第三，**真正驱动引脚生效** 只发生在下一次 `UEV`。只要这三层语义不混，中心对齐 PWM 就不会因为一次看似无害的运行中改值而把功率级带进毛刺、半帧更新和采样相位漂移。
