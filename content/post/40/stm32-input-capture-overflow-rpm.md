---
title: "技能档案：STM32 输入捕获测速，从计数器溢出扩展到低速转速误差预算"
slug: "skill-stm32-input-capture-overflow-and-low-speed-rpm-estimation"
date: 2026-05-15T18:17:03+08:00
draft: false
description: "从边沿时间戳、16 位计数器溢出扩展、数字滤波到倒数法测速误差，系统拆解 STM32 输入捕获为什么本质上是在把脉冲间隔翻译成可审计的机械速度。"
tags: ["STM32", "输入捕获", "定时器", "测速", "嵌入式"]
categories: ["技能档案"]
image: ""
---

## 技能概述

STM32 输入捕获真正解决的，不是“某个引脚来了一次上升沿”这么简单的事件响应，而是如何把机械旋转、霍尔跳变、编码盘脉冲或者流量计叶轮的离散边沿，稳定翻译成控制器可消费的速度量。它广泛用于电机测速、风扇监测、曲轴齿盘测角、计量脉冲计数与低速运动感知，核心痛点从来不是能不能读到 `CCR`，而是当转速很低、定时器会反复溢出、毛刺脉冲混入、边沿卡在更新事件附近以及中断延迟不再可忽略时，系统还能不能给出一份连续、单调、带误差边界的速度估计。输入捕获本质上不是“中断 + 计数器”，而是一条把物理时间间隔映射为离散频率估计的测量链。

## 核心底层概念解析

- **输入捕获测的不是电平，而是边沿到达的时间戳**：GPIO 读到的是此刻高还是低，输入捕获记下的是边沿穿过比较器的那一刻计数器是多少。前者是状态采样，后者是时间采样。测速这件事需要的不是“线现在为高”，而是“这一跳和上一跳隔了多久”。
- **机械速度在数字域里首先表现为脉冲间隔，而不是每秒计数值**：若被测对象每转一圈产生 `N_ppr` 个脉冲，边沿周期为 `Delta t`，那么转速满足 `rpm = 60 / (N_ppr * Delta t)`。当定时器计数频率为 `f_cnt`，时间被量化成计数差 `Delta c` 后，就得到更工程化的映射：`rpm = 60 * f_cnt / (N_ppr * Delta c)`。这意味着输入捕获本质上是在求倒数。
- **低速区更适合“测周期”，高速区更适合“计窗口”**：固定时间窗计数法在高速时抗量化，因为窗口内脉冲多；但在低速时，一个窗口里可能只有 0 个或 1 个脉冲，分辨率会塌陷。输入捕获的倒数法恰好反过来，低速时虽然等待时间更长，但分辨率更稳定，因此它特别适合风扇、减速电机、流量轮这类慢变量测速。
- **16 位定时器不是不能测慢，而是必须做溢出扩展**：以 `f_cnt = 1 MHz`、`ARR = 65535` 为例，定时器每 `65.536 ms` 溢出一次。若传感器只有 `1 pulse/rev`，被测轴转速是 `10 rpm`，单个脉冲周期就是 `6 s`，期间会溢出约 `91` 次。此时单次 `CCR` 读数已经失去意义，真正可用的时间戳必须是“软件高位 + 硬件低位”拼出来的扩展计数值。
- **更新事件与捕获事件之间存在天然竞态**：最容易把测速写错的，不是公式，而是边沿恰好发生在计数器翻转前后。如果 `UIF` 和 `CCxIF` 在同一个 IRQ 周期里同时置位，必须判断捕获值究竟属于溢出前还是溢出后那个计数纪元。否则时间戳会平白多一个或少一个 `ARR + 1`，最终把速度算快一倍或者慢一倍。
- **输入滤波不是“消抖魔法”，而是拿额外延迟换脉冲可信度**：定时器数字滤波会要求输入在若干个采样周期内保持一致才认定边沿成立。滤波越强，窄毛刺越难混进来，但有效边沿也会被推迟。对测速来说，这种延迟若近似恒定，问题不大；但若边沿斜率受转速、线缆和噪声影响而漂移，滤波延迟就会转化成周期测量误差。
- **量化误差在倒数映射下是非线性放大的**：由 `rpm = 60 * f_cnt / (N_ppr * Delta c)` 对 `Delta c` 求导，可得 `Delta rpm ≈ 60 * f_cnt / (N_ppr * Delta c^2) * Delta c`。这条式子揭示了两个事实：其一，输入捕获的理论分辨率主要由计数时钟决定；其二，同样是 `1 tick` 的时间戳量化，在高速时会被放大成更显著的转速抖动，在低速时反而更平滑。
- **毛刺拒绝不能只靠硬件滤波，还要有最小周期约束**：如果物理系统不可能超过 `rpm_max`，那就能反推出最小合法计数差 `Delta c_min = ceil(60 * f_cnt / (N_ppr * rpm_max))`。凡是小于这个下界的捕获间隔，都更像是干扰、回波或比较器振铃，而不是有效机械事件。硬件滤波负责挡住窄毛刺，软件阈值负责挡住“不合理但足够宽”的假脉冲。
- **零速判断本质上是“在多长时间内还没等到下一次边沿”**：倒数法最大的工程问题不是启动，而是停止。没有新边沿到来时，系统不会自动告诉你“现在是 0 rpm”，它只会沉默。因此必须构造超时合同，例如若 `elapsed_counts > zero_timeout_counts`，就把速度强制回零，并把上一次有效样本标记为过期。
- **中断频率也是系统资源预算的一部分**：若每个编码脉冲都进一次中断，高速区会把 CPU 拖进“只顾记时间戳”的状态。输入捕获适合低到中速、脉冲密度不极端的场景；若已经进入高 PPR 高转速区，往往应该切到编码器接口模式、DMA 搬运或者固定窗统计法。测量方法不是信仰，而是资源调度策略。
- **真正可靠的测速不是只给一个数字，而是给一个有时间语义的数字**：速度值本身必须附带“这是哪两个边沿之间估出来的”“误差大概有多少”“当前是否超时过期”这些上下文。没有这些语义，控制器拿到的只是一个看似连续、实则可能已陈旧的标量。

## 代码能力展现

下面给出一个基于 STM32 HAL 的输入捕获测速模块。代码重点不在“把 TIM 通道开起来”，而在四条更硬的链路上：**16 位计数器的溢出扩展**、**更新事件与捕获事件的先后竞态修正**、**倒数法 RPM 计算与量化误差估计**、**毛刺拒绝与零速超时处理**。初始化仍然依赖 HAL，IRQ 路径则直接读定时器标志位，因为这里真正需要的是比通用回调更可控的时序语义。

```c
#include "stm32f4xx_hal.h"

#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#define SPEED_IC_MIN_TIMEOUT_MS          10U
#define SPEED_IC_MAX_TIMEOUT_MS          10000U
#define SPEED_IC_MIN_RPM_LIMIT           1.0f
#define SPEED_IC_MAX_RPM_LIMIT           200000.0f
#define SPEED_IC_MAX_FILTER              15U

typedef struct
{
    float rpm;                      /* 最新转速估计值。 */
    float rpm_sigma;                /* 由 1 tick 时间戳量化推导的一阶转速误差。 */
    uint32_t period_counts;         /* 本次测速对应的计数差 Delta c。 */
    uint64_t edge_timestamp_counts; /* 当前有效边沿的扩展时间戳。 */
    uint8_t valid;                  /* 1 表示样本可用。 */
    uint8_t updated;                /* 1 表示自上次读取后有新样本。 */
    uint8_t timed_out;              /* 1 表示该样本由零速超时逻辑产生。 */
} SpeedIcSample_t;

typedef struct
{
    TIM_HandleTypeDef *htim;
    uint32_t channel;
    uint32_t timer_clock_hz;
    uint32_t counter_hz;
    uint32_t counter_period_counts; /* ARR + 1，对 16 位全量程即 65536。 */
    uint32_t pulses_per_rev;
    float max_rpm;
    uint32_t min_period_counts;     /* 小于该周期的边沿直接按毛刺丢弃。 */
    uint32_t zero_timeout_counts;   /* 超过该间隔未见新边沿，则认为转速归零。 */
    uint64_t overflow_base_counts;  /* 软件高位，每次更新事件累加 ARR + 1。 */
    uint64_t last_edge_timestamp_counts;
    uint32_t overcapture_count;
    uint8_t has_first_edge;
    volatile SpeedIcSample_t sample;
} SpeedIcContext_t;

static uint32_t SpeedIc_ClampU32(uint32_t value, uint32_t min_value, uint32_t max_value)
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

static float SpeedIc_ClampF32(float value, float min_value, float max_value)
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

static uint32_t SpeedIc_GetCaptureFlag(uint32_t channel)
{
    switch (channel)
    {
    case TIM_CHANNEL_1:
        return TIM_FLAG_CC1;
    case TIM_CHANNEL_2:
        return TIM_FLAG_CC2;
    case TIM_CHANNEL_3:
        return TIM_FLAG_CC3;
    case TIM_CHANNEL_4:
        return TIM_FLAG_CC4;
    default:
        return 0U;
    }
}

static uint32_t SpeedIc_GetCaptureInterruptMask(uint32_t channel)
{
    switch (channel)
    {
    case TIM_CHANNEL_1:
        return TIM_DIER_CC1IE;
    case TIM_CHANNEL_2:
        return TIM_DIER_CC2IE;
    case TIM_CHANNEL_3:
        return TIM_DIER_CC3IE;
    case TIM_CHANNEL_4:
        return TIM_DIER_CC4IE;
    default:
        return 0U;
    }
}

static uint32_t SpeedIc_GetOvercaptureFlag(uint32_t channel)
{
    switch (channel)
    {
    case TIM_CHANNEL_1:
        return TIM_FLAG_CC1OF;
    case TIM_CHANNEL_2:
        return TIM_FLAG_CC2OF;
    case TIM_CHANNEL_3:
        return TIM_FLAG_CC3OF;
    case TIM_CHANNEL_4:
        return TIM_FLAG_CC4OF;
    default:
        return 0U;
    }
}

static uint32_t SpeedIc_ReadCaptureRegister(const SpeedIcContext_t *ctx)
{
    switch (ctx->channel)
    {
    case TIM_CHANNEL_1:
        return ctx->htim->Instance->CCR1;
    case TIM_CHANNEL_2:
        return ctx->htim->Instance->CCR2;
    case TIM_CHANNEL_3:
        return ctx->htim->Instance->CCR3;
    case TIM_CHANNEL_4:
        return ctx->htim->Instance->CCR4;
    default:
        return 0U;
    }
}

/**
 * @brief 配置输入捕获通道。
 * @param htim HAL 定时器句柄。
 * @param channel 输入捕获通道，例如 TIM_CHANNEL_1。
 * @param digital_filter 数字滤波等级，范围 0~15。
 * @retval true 配置成功。
 * @retval false 参数非法或 HAL 配置失败。
 *
 * @note 数字滤波并不改变“按边沿测速”的本质，只是在 TI 输入端加入
 *       一段一致性判决窗口，用更高的边沿延迟换更低的毛刺概率。
 */
bool SpeedIc_ConfigChannel(TIM_HandleTypeDef *htim,
                           uint32_t channel,
                           uint32_t digital_filter)
{
    TIM_IC_InitTypeDef config;

    if (htim == NULL)
    {
        return false;
    }

    memset(&config, 0, sizeof(config));
    config.ICPolarity = TIM_INPUTCHANNELPOLARITY_RISING;
    config.ICSelection = TIM_ICSELECTION_DIRECTTI;
    config.ICPrescaler = TIM_ICPSC_DIV1;
    config.ICFilter = SpeedIc_ClampU32(digital_filter, 0U, SPEED_IC_MAX_FILTER);

    return (HAL_TIM_IC_ConfigChannel(htim, &config, channel) == HAL_OK);
}

/**
 * @brief 初始化输入捕获测速上下文。
 * @param ctx 测速上下文。
 * @param htim HAL 定时器句柄。
 * @param channel 输入捕获通道。
 * @param timer_clock_hz TIM 外设输入时钟，单位 Hz。
 * @param pulses_per_rev 每转脉冲数 N_ppr。
 * @param max_rpm 物理允许的最高转速，用于反推毛刺拒绝阈值。
 * @param zero_timeout_ms 零速超时阈值，超过该时间未见新边沿则速度回零。
 * @retval true 初始化成功。
 * @retval false 参数不合法。
 *
 * @note 这里把两个边界显式写进初始化：
 *       1. 最小合法周期：
 *          Delta c_min = ceil(60 * f_cnt / (N_ppr * rpm_max))
 *       2. 零速超时窗口：
 *          zero_timeout_counts = ceil(f_cnt * timeout_ms / 1000)
 */
bool SpeedIc_Init(SpeedIcContext_t *ctx,
                  TIM_HandleTypeDef *htim,
                  uint32_t channel,
                  uint32_t timer_clock_hz,
                  uint32_t pulses_per_rev,
                  float max_rpm,
                  uint32_t zero_timeout_ms)
{
    uint32_t prescaler_div;
    uint64_t numerator;
    uint64_t denominator;

    if ((ctx == NULL) ||
        (htim == NULL) ||
        (pulses_per_rev == 0U) ||
        (timer_clock_hz == 0U))
    {
        return false;
    }

    memset(ctx, 0, sizeof(*ctx));

    ctx->htim = htim;
    ctx->channel = channel;
    ctx->timer_clock_hz = timer_clock_hz;
    ctx->pulses_per_rev = pulses_per_rev;
    ctx->max_rpm = SpeedIc_ClampF32(max_rpm, SPEED_IC_MIN_RPM_LIMIT, SPEED_IC_MAX_RPM_LIMIT);

    prescaler_div = htim->Instance->PSC + 1U;
    ctx->counter_hz = timer_clock_hz / prescaler_div;
    ctx->counter_period_counts = htim->Instance->ARR + 1U;

    zero_timeout_ms = SpeedIc_ClampU32(zero_timeout_ms,
                                       SPEED_IC_MIN_TIMEOUT_MS,
                                       SPEED_IC_MAX_TIMEOUT_MS);

    numerator = 60ULL * (uint64_t)ctx->counter_hz;
    denominator = (uint64_t)pulses_per_rev * (uint64_t)(ctx->max_rpm);

    /* 向上取整，保证毛刺拒绝阈值不会因截断而偏小。 */
    ctx->min_period_counts = (uint32_t)((numerator + denominator - 1ULL) / denominator);
    ctx->min_period_counts = SpeedIc_ClampU32(ctx->min_period_counts, 1U, 0x7FFFFFFFU);

    ctx->zero_timeout_counts =
        (uint32_t)((((uint64_t)ctx->counter_hz * zero_timeout_ms) + 999ULL) / 1000ULL);

    if (ctx->zero_timeout_counts <= ctx->min_period_counts)
    {
        ctx->zero_timeout_counts = ctx->min_period_counts + 1U;
    }

    return true;
}

/**
 * @brief 启动输入捕获测速。
 * @param ctx 测速上下文。
 * @retval true 启动成功。
 * @retval false HAL 启动失败或参数非法。
 *
 * @note 同时启动 Base Update 中断与 Capture 中断。前者负责扩展软件高位，
 *       后者负责锁存边沿时间戳；缺任何一方，低速区测速都会失真。
 */
bool SpeedIc_Start(SpeedIcContext_t *ctx)
{
    uint32_t capture_flag;

    if ((ctx == NULL) || (ctx->htim == NULL))
    {
        return false;
    }

    capture_flag = SpeedIc_GetCaptureFlag(ctx->channel);
    if (capture_flag == 0U)
    {
        return false;
    }

    ctx->overflow_base_counts = 0ULL;
    ctx->last_edge_timestamp_counts = 0ULL;
    ctx->overcapture_count = 0U;
    ctx->has_first_edge = 0U;
    memset((void *)&ctx->sample, 0, sizeof(ctx->sample));

    __HAL_TIM_DISABLE_IT(ctx->htim, TIM_IT_UPDATE);
    __HAL_TIM_SET_COUNTER(ctx->htim, 0U);
    __HAL_TIM_CLEAR_FLAG(ctx->htim, TIM_FLAG_UPDATE | capture_flag);

    if (HAL_TIM_Base_Start_IT(ctx->htim) != HAL_OK)
    {
        return false;
    }

    if (HAL_TIM_IC_Start_IT(ctx->htim, ctx->channel) != HAL_OK)
    {
        (void)HAL_TIM_Base_Stop_IT(ctx->htim);
        return false;
    }

    return true;
}

/**
 * @brief 读取当前扩展计数时间戳。
 * @param ctx 测速上下文。
 * @return 当前单调递增的扩展计数值。
 *
 * @note 若 UIF 已经置位但 Update IRQ 还没来得及执行，而 CNT 已经回到较小值，
 *       说明当前计数实际已经属于“下一纪元”，需要手动补一个 ARR + 1。
 */
static uint64_t SpeedIc_GetNowExtendedCounts(const SpeedIcContext_t *ctx)
{
    uint32_t primask;
    uint32_t status;
    uint32_t counter;
    uint64_t base;

    primask = __get_PRIMASK();
    __disable_irq();

    status = ctx->htim->Instance->SR;
    counter = ctx->htim->Instance->CNT;
    base = ctx->overflow_base_counts;

    if (((status & TIM_SR_UIF) != 0U) && (counter < (ctx->counter_period_counts / 2U)))
    {
        base += ctx->counter_period_counts;
    }

    if (primask == 0U)
    {
        __enable_irq();
    }

    return base + counter;
}

/**
 * @brief 在周期任务中轮询零速超时。
 * @param ctx 测速上下文。
 *
 * @note 输入捕获只能在边沿到来时更新速度，因此停止场景必须主动轮询：
 *       if (now - last_edge_timestamp > zero_timeout_counts) => rpm = 0
 */
void SpeedIc_Service(SpeedIcContext_t *ctx)
{
    uint64_t now_counts;
    uint64_t elapsed_counts;

    if ((ctx == NULL) || (ctx->has_first_edge == 0U))
    {
        return;
    }

    now_counts = SpeedIc_GetNowExtendedCounts(ctx);
    elapsed_counts = now_counts - ctx->last_edge_timestamp_counts;

    if ((elapsed_counts >= ctx->zero_timeout_counts) &&
        ((ctx->sample.valid == 0U) || (ctx->sample.rpm > 0.0f) || (ctx->sample.timed_out == 0U)))
    {
        __disable_irq();
        ctx->sample.rpm = 0.0f;
        ctx->sample.rpm_sigma = 0.0f;
        ctx->sample.period_counts = (uint32_t)SpeedIc_ClampU32((uint32_t)elapsed_counts,
                                                               0U,
                                                               0xFFFFFFFFU);
        ctx->sample.edge_timestamp_counts = now_counts;
        ctx->sample.valid = 1U;
        ctx->sample.updated = 1U;
        ctx->sample.timed_out = 1U;
        __enable_irq();
    }
}

/**
 * @brief 取出一份最新测速样本。
 * @param ctx 测速上下文。
 * @param out_sample 输出样本。
 * @retval true 读取到新样本。
 * @retval false 当前没有新样本。
 */
bool SpeedIc_TakeSample(SpeedIcContext_t *ctx, SpeedIcSample_t *out_sample)
{
    uint32_t primask;
    bool has_update;

    if ((ctx == NULL) || (out_sample == NULL))
    {
        return false;
    }

    primask = __get_PRIMASK();
    __disable_irq();

    has_update = (ctx->sample.updated != 0U);
    *out_sample = ctx->sample;
    ctx->sample.updated = 0U;

    if (primask == 0U)
    {
        __enable_irq();
    }

    return has_update;
}

/**
 * @brief 定时器 IRQ 处理函数。
 * @param ctx 测速上下文。
 *
 * @note 这里故意不直接依赖 HAL 的通用回调分发，而是先快照 SR/DIER，
 *       以便在 UIF 与 CCxIF 同时置位时做“捕获属于溢出前还是溢出后”的判定。
 *       关键修正规则如下：
 *
 *       1. 先按 Update 事件把软件高位 base += ARR + 1
 *       2. 若本次 IRQ 同时看到了 UIF 与 CCxIF：
 *          - 若 CCR < (ARR + 1) / 2，说明捕获更像发生在溢出之后，时间戳直接使用新 base
 *          - 若 CCR >= (ARR + 1) / 2，说明捕获更像发生在溢出之前，需要减回一个周期
 *
 *       这相当于用“CCR 靠近前半圈还是后半圈”来恢复边沿在环形计数器中的真实纪元。
 */
void SpeedIc_IrqHandler(SpeedIcContext_t *ctx)
{
    TIM_TypeDef *tim;
    uint32_t status;
    uint32_t interrupt_enable;
    uint32_t capture_flag;
    uint32_t capture_it_mask;
    uint32_t overcapture_flag;

    if ((ctx == NULL) || (ctx->htim == NULL))
    {
        return;
    }

    tim = ctx->htim->Instance;
    status = tim->SR;
    interrupt_enable = tim->DIER;
    capture_flag = SpeedIc_GetCaptureFlag(ctx->channel);
    capture_it_mask = SpeedIc_GetCaptureInterruptMask(ctx->channel);
    overcapture_flag = SpeedIc_GetOvercaptureFlag(ctx->channel);

    if (((status & TIM_SR_UIF) != 0U) && ((interrupt_enable & TIM_DIER_UIE) != 0U))
    {
        __HAL_TIM_CLEAR_FLAG(ctx->htim, TIM_FLAG_UPDATE);
        ctx->overflow_base_counts += ctx->counter_period_counts;
    }

    if (((status & overcapture_flag) != 0U) && (overcapture_flag != 0U))
    {
        __HAL_TIM_CLEAR_FLAG(ctx->htim, overcapture_flag);
        ctx->overcapture_count++;
    }

    if (((status & capture_flag) != 0U) && ((interrupt_enable & capture_it_mask) != 0U))
    {
        const uint32_t captured_counts = SpeedIc_ReadCaptureRegister(ctx);
        uint64_t edge_timestamp = ctx->overflow_base_counts + captured_counts;

        __HAL_TIM_CLEAR_FLAG(ctx->htim, capture_flag);

        if (((status & TIM_SR_UIF) != 0U) &&
            (captured_counts >= (ctx->counter_period_counts / 2U)))
        {
            edge_timestamp -= ctx->counter_period_counts;
        }

        if (ctx->has_first_edge == 0U)
        {
            ctx->last_edge_timestamp_counts = edge_timestamp;
            ctx->has_first_edge = 1U;
            return;
        }

        {
            const uint64_t delta_counts_64 = edge_timestamp - ctx->last_edge_timestamp_counts;

            if (delta_counts_64 < ctx->min_period_counts)
            {
                /* 周期短到超出物理最高转速，视为毛刺，保留旧时间基。 */
                return;
            }

            if (delta_counts_64 > ctx->zero_timeout_counts)
            {
                /*
                 * 长时间无边沿后再次出现脉冲，多数时候意味着系统经历了停转或超慢速区。
                 * 这里不直接把它换算成一个陈旧的小转速，而是先报告 0 rpm，
                 * 再把当前边沿作为新的时间基，等待下一周期重新建立速度估计。
                 */
                ctx->last_edge_timestamp_counts = edge_timestamp;
                ctx->sample.rpm = 0.0f;
                ctx->sample.rpm_sigma = 0.0f;
                ctx->sample.period_counts = (uint32_t)SpeedIc_ClampU32((uint32_t)delta_counts_64,
                                                                       0U,
                                                                       0xFFFFFFFFU);
                ctx->sample.edge_timestamp_counts = edge_timestamp;
                ctx->sample.valid = 1U;
                ctx->sample.updated = 1U;
                ctx->sample.timed_out = 1U;
                return;
            }

            {
                const uint32_t delta_counts = (uint32_t)delta_counts_64;
                const float delta_f = (float)delta_counts;
                const float numerator = 60.0f * (float)ctx->counter_hz;
                const float denominator = (float)ctx->pulses_per_rev * delta_f;
                const float rpm = numerator / denominator;

                /*
                 * 速度映射：
                 * rpm = 60 * f_cnt / (N_ppr * Delta c)
                 *
                 * 一阶量化误差传播：
                 * d(rpm)/d(Delta c) = -60 * f_cnt / (N_ppr * Delta c^2)
                 * 因此对 1 tick 计数不确定度，可近似写成：
                 * rpm_sigma ≈ 60 * f_cnt / (N_ppr * Delta c^2)
                 */
                const float rpm_sigma = numerator /
                                        ((float)ctx->pulses_per_rev * delta_f * delta_f);

                ctx->last_edge_timestamp_counts = edge_timestamp;

                if ((rpm > 0.0f) && (rpm <= (ctx->max_rpm * 1.10f)))
                {
                    ctx->sample.rpm = rpm;
                    ctx->sample.rpm_sigma = rpm_sigma;
                    ctx->sample.period_counts = delta_counts;
                    ctx->sample.edge_timestamp_counts = edge_timestamp;
                    ctx->sample.valid = 1U;
                    ctx->sample.updated = 1U;
                    ctx->sample.timed_out = 0U;
                }
            }
        }
    }
}

static SpeedIcContext_t g_speed_ic;

/**
 * @brief 示例：配置 TIM3 CH1 为输入捕获测速。
 *
 * @note 假设 TIM3 时钟为 84 MHz，PSC = 83，因此 f_cnt = 1 MHz，
 *       即每个计数代表 1 us。若霍尔盘为 6 pulse/rev，则：
 *       rpm = 60 * 1e6 / (6 * Delta c)
 */
void App_SpeedCaptureInit(void)
{
    /* MX_TIM3_Init() 中建议：
     * - ARR = 65535
     * - 计数模式 Up
     * - PSC = 83，使计数频率为 1 MHz
     * - CH1 映射到待测脉冲输入
     */

    (void)SpeedIc_ConfigChannel(&htim3, TIM_CHANNEL_1, 8U);

    (void)SpeedIc_Init(&g_speed_ic,
                       &htim3,
                       TIM_CHANNEL_1,
                       84000000U,
                       6U,        /* 每转 6 脉冲 */
                       12000.0f,  /* 物理最高转速 */
                       300U);     /* 300 ms 无边沿则回零 */

    (void)SpeedIc_Start(&g_speed_ic);
}

void TIM3_IRQHandler(void)
{
    SpeedIc_IrqHandler(&g_speed_ic);
}

void App_1msTask(void)
{
    SpeedIcSample_t sample;

    SpeedIc_Service(&g_speed_ic);

    if (!SpeedIc_TakeSample(&g_speed_ic, &sample))
    {
        return;
    }

    if (!sample.valid)
    {
        return;
    }

    /* sample.rpm 是最新转速估计；
     * sample.rpm_sigma 表示由 1 tick 量化带来的理论抖动下界；
     * sample.timed_out = 1 说明这不是由新边沿更新出来的速度，而是零速超时样本。 */
    MotorSpeed_UpdateEstimate(sample.rpm, sample.rpm_sigma, sample.timed_out);
}
```

这段实现真正想解决的，不是“怎么把霍尔信号接进 TIM3”，而是如何让速度估计拥有**单调时间基、竞态修正、误差预算和失效语义**。如果没有溢出扩展，低速区的时间轴会断裂；如果没有 `UIF/CCxIF` 同周期判定，边沿恰好跨越翻转点时会直接把速度打穿；如果没有最小周期约束和零速超时，系统就会在毛刺与停转之间来回自欺。输入捕获看起来像在测转速，本质上却是在维护一份“边沿时间戳是否可信”的合同。只有这份合同成立，后面的速度环、保护逻辑和故障诊断才有资格相信那个 `rpm` 数字。
