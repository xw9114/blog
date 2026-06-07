---
title: "技能档案：步进电机短行程 S 曲线的段退化、定时器量化与末端残差消除"
slug: "skill-stepper-short-move-s-curve-segment-collapse-timer-quantization-and-residual-cancellation"
date: 2026-06-07T10:51:16+08:00
draft: false
description: "从七段 S 曲线在短行程下的塌缩、连续位移到离散步数的映射、ARR 非整数分频误差到末端补步清算，系统拆解步进平台为什么总败在最后几步。"
tags: ["STM32", "步进电机", "S型加减速", "定时器", "量化误差", "运动控制"]
categories: ["技能档案"]
image: ""
---

## 技能概述

步进平台真正棘手的场景，往往不是长距离匀速运行，而是“只走几十到几百个细分步”的短行程定位: 镜头对焦、贴片飞拍补偿、丝杆末端找位、小行程压装回零，这类动作几乎来不及进入理想的七段 S 曲线，就已经要开始刹车。如果控制器仍按长行程思路规划，连续速度曲线会在离散步数、定时器整数分频和驱动器最小脉宽这三重约束下发生失真，最终表现成末端多走一步、少走一步、减速发抖或换向撞击。这个主题要解决的核心痛点，不是“怎么输出 STEP 脉冲”，而是如何把 **短行程段退化**、**连续轨迹到整数步预算的映射**、**ARR 量化误差平均化** 和 **末端残差清算** 串成一条可证明正确的运动链路。

## 核心底层概念解析

- **短行程不是长行程的缩小版，而是约束关系发生了拓扑变化**：完整七段 S 曲线依赖 `jerk -> acceleration -> velocity -> position` 的三级积分链，但当目标位移太短时，匀速段先消失，随后恒加速度段也会塌缩，最终只剩“加加速 + 减加速 + 镜像减速”四段。此时系统不再是“跑不到 `v_max`”，而是连 `a_max` 都未必触得到。
- **段退化的判据来自位移预算，而不是经验阈值**：若单侧加速半程位移记为 `S_half`，则总位移 `S_total < 2 * S_half(v_max)` 时匀速段必然消失；若再小到 `S_total < 2 * a_max * (a_max / j_max)^2`，恒加速度段也无法存在，轨迹会退化成纯三角 S 曲线。很多“末端减速不稳”其实是因为代码仍执意保留一个理论上已经不存在的相位。
- **步进控制最终消费的是整数步，不是连续毫米**：机械世界里的连续位移 `x_mm` 必须映射成 `N = round(x_mm / l_step)` 个离散脉冲，其中 `l_step` 是单脉冲线位移。若轨迹规划在毫米域结束，而执行层在步域独立计数，二者之间就会留下一个 `[-0.5, +0.5]` 步的天然残差。
- **连续轨迹与整数步之间最稳妥的桥梁，不是“想到哪补到哪”，而是步预算发布**：规划层在每个固定时基只发布“截至当前时刻最多允许发出多少步”，记作 `released_steps = floor(x_cmd / l_step)`；载波层只负责在不超预算的前提下发脉冲。这样做的意义是把“目标位置”改写成“已获许可的整数事件数”，末端就不会因为频率抖动而提前越界。
- **定时器 ARR 是整数，理想 STEP 周期通常不是整数**：若目标步频为 `f_step`，定时器时钟为 `f_tim`，理想周期满足 `T_ticks* = f_tim / f_step`。但寄存器里只能写整数 `ARR + 1`，于是实际步频变成 `f_real = f_tim / (ARR + 1)`。一味四舍五入虽然简单，却会在低速短行程里把几次 1 tick 误差直接积累成可见的相位偏差。
- **非整数周期最适合用 Bresenham 式分数累加来均值守恒**：将 `T_ticks* = N + alpha` 拆成整数部分 `N` 与小数部分 `alpha`，每次更新都累加 `alpha`，当累加器溢出 1 时本周期多给 1 tick。这样单周期仍是整数，但多周期平均值逼近理想周期，等价于在时间轴上做一个离散版 Delta-Sigma 调制。
- **最小高电平宽度和 DIR 建立时间是驱动器的物理合同**：控制器即使能把 ARR 算得很漂亮，若 `t_STEPH` 不满足驱动器要求，或者 `DIR` 改变后没留出 `t_DIR_SETUP` 就开始发脉冲，电机看到的仍然是无效命令。短行程里这类保护尤其重要，因为动作本来就只有几十步，丢第一步或最后一步的代价会被直接放大。
- **规划时基与脉冲时基必须解耦**：S 曲线更新通常在 `0.5~2 kHz` 的规划中断里完成，而 STEP 脉冲可能运行在 `1~200 kHz`。前者负责积分状态和段边界，后者负责波形输出。若用同一个中断既算轨迹又打脉冲，段切换延迟、ISR 抖动和整数除法开销会一起污染步频。
- **末端误差不一定来自转矩不够，很多时候来自“时间到点了，但步还没发完”**：短行程动作里，规划总时间结束并不自动代表整数步已经清账。只要 `released_steps` 已到目标而 `emitted_steps` 还落后，系统就应转入低速尾段把剩余步数补齐，而不是粗暴停表。
- **尾段补步的关键是不再回看连续速度，而只清算剩余预算**：当轨迹时间已结束，控制器可以把目标简化为 `remaining_steps / planner_dt` 对应的安全低步频，直到 `emitted_steps == target_steps`。这个尾段不是“补救 bug”，而是显式承认“连续时间规划”和“离散事件执行”之间存在不可压缩的量化缝隙。
- **技术哲学上，短行程步进控制不是让曲线更平滑，而是让积分世界和计数世界签同一份合同**：S 曲线描述的是机械系统想怎样走，整数步和整数定时器描述的是 MCU 实际能怎样发。只有把这两套语言先翻译成统一的预算，再谈抑振、提速和精定位，系统才不会在最后几步露出原形。

## 代码能力展现

下面给出一个基于 STM32 HAL 的短行程 STEP/DIR 轴控制示例。设计重点不是“能跑一条 S 曲线”，而是把 **段退化求解**、**步预算发布**、**ARR 分数累加量化** 和 **尾段残差清算** 同时纳入实现。假设场景如下:

- `TIM6` 以固定周期触发规划层，例如 `1 kHz`。
- `TIM1 CH1` 输出 STEP 脉冲，更新事件可视作“本周期已经发出 1 步”。
- `DIR` 由 GPIO 控制，切换方向后必须满足建立时间再放行 STEP。

```c
#include "main.h"

#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#define STEPPER_EPSILON                       1.0e-6f
#define STEPPER_MAX_TAIL_FREQ_HZ              4000.0f
#define STEPPER_MIN_TAIL_FREQ_HZ              200.0f
#define STEPPER_MAX_PROFILE_TIME_S            10.0f

typedef enum
{
    STEPPER_PROFILE_FULL = 0,          /* 七段: 含匀速段 */
    STEPPER_PROFILE_NO_CRUISE,         /* 五段: 无匀速段 */
    STEPPER_PROFILE_TRIANGULAR         /* 四段: 纯三角 S 曲线 */
} StepperProfileKind_t;

typedef struct
{
    TIM_HandleTypeDef *pulse_htim;
    uint32_t pulse_channel;
    float pulse_timer_hz;
    float planner_dt_s;
    float step_length_mm;
    float v_max_mm_s;
    float a_max_mm_s2;
    float j_max_mm_s3;
    uint32_t arr_min;
    uint32_t arr_max;
    uint32_t pulse_high_min_ticks;
    GPIO_TypeDef *dir_port;
    uint16_t dir_pin;
    uint32_t dir_setup_cycles;
} StepperAxisConfig_t;

typedef struct
{
    StepperProfileKind_t kind;
    int32_t direction;
    uint32_t target_steps;
    float quantized_distance_mm;
    float jerk_mm_s3;
    float a_peak_mm_s2;
    float v_peak_mm_s;
    float t_jerk_s;
    float t_acc_hold_s;
    float t_cruise_s;
    float t_acc_total_s;
    float t_total_s;
    float s_accel_half_mm;
} StepperMovePlan_t;

typedef struct
{
    StepperAxisConfig_t cfg;
    StepperMovePlan_t plan;
    volatile uint32_t emitted_steps;
    volatile uint32_t released_steps;
    float planner_elapsed_s;
    float last_command_mm;
    float period_fraction_accum;
    bool motion_active;
    bool pulse_running;
} StepperAxis_t;

static StepperAxis_t g_axis_x =
{
    .cfg =
    {
        .pulse_htim = &htim1,
        .pulse_channel = TIM_CHANNEL_1,
        .pulse_timer_hz = 72000000.0f,
        .planner_dt_s = 0.001f,              /* 1 kHz 规划层时基 */
        .step_length_mm = 0.0025f,           /* 8 mm 丝杆 / (200 * 16) */
        .v_max_mm_s = 80.0f,
        .a_max_mm_s2 = 2000.0f,
        .j_max_mm_s3 = 50000.0f,
        .arr_min = 359U,                     /* 72 MHz / (359 + 1) = 200 kHz */
        .arr_max = 0xFFFFU,
        .pulse_high_min_ticks = 72U,         /* 72 MHz 下至少 1 us 高电平 */
        .dir_port = GPIOA,
        .dir_pin = GPIO_PIN_8,
        .dir_setup_cycles = 720U             /* 72 MHz 下约 10 us */
    }
};

static float StepperClampF(float value, float min_value, float max_value)
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

static uint32_t StepperClampU32(uint32_t value, uint32_t min_value, uint32_t max_value)
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

static void StepperDelayCycles(uint32_t cycles)
{
    const uint32_t start = DWT->CYCCNT;

    while ((uint32_t)(DWT->CYCCNT - start) < cycles)
    {
        /* 等待 DIR 建立时间到达。 */
    }
}

static void StepperPulseStop(StepperAxis_t *axis)
{
    if ((axis == NULL) || (!axis->pulse_running))
    {
        return;
    }

    HAL_TIM_PWM_Stop(axis->cfg.pulse_htim, axis->cfg.pulse_channel);
    axis->pulse_running = false;
}

static bool StepperPulseStart(StepperAxis_t *axis)
{
    if (axis == NULL)
    {
        return false;
    }

    if (axis->pulse_running)
    {
        return true;
    }

    if (HAL_TIM_PWM_Start(axis->cfg.pulse_htim, axis->cfg.pulse_channel) != HAL_OK)
    {
        return false;
    }

    axis->pulse_running = true;
    return true;
}

/**
 * @brief 把理想步频映射为整数 ARR/CCR，并用分数累加降低量化误差。
 * @param axis 步进轴对象。
 * @param step_freq_hz 目标步频，单位 Hz。
 *
 * @note 理想周期满足：
 *       T_ticks* = f_tim / f_step
 *
 *       但 ARR 只能取整数，所以把理想周期拆成：
 *       T_ticks* = N + alpha, 其中 N = floor(T_ticks*), alpha in [0, 1)
 *
 *       每次配置都执行：
 *       frac_acc += alpha
 *       if frac_acc >= 1:
 *           T_ticks = N + 1
 *           frac_acc -= 1
 *       else
 *           T_ticks = N
 *
 *       这样单个周期仍是整数 tick，但长期平均周期逼近 `T_ticks*`，
 *       可显著减轻短行程里的步频系统偏差。
 */
static void StepperSetPulseFrequency(StepperAxis_t *axis, float step_freq_hz)
{
    float bounded_freq_hz;
    float ideal_ticks;
    float integer_ticks;
    float fractional_ticks;
    uint32_t period_ticks;
    uint32_t arr;
    uint32_t ccr;

    if (axis == NULL)
    {
        return;
    }

    bounded_freq_hz = StepperClampF(step_freq_hz,
                                    1.0f,
                                    axis->cfg.pulse_timer_hz / ((float)axis->cfg.arr_min + 1.0f));

    ideal_ticks = axis->cfg.pulse_timer_hz / bounded_freq_hz;
    ideal_ticks = StepperClampF(ideal_ticks,
                                (float)axis->cfg.arr_min + 1.0f,
                                (float)axis->cfg.arr_max + 1.0f);

    integer_ticks = floorf(ideal_ticks);
    fractional_ticks = ideal_ticks - integer_ticks;

    axis->period_fraction_accum += fractional_ticks;
    period_ticks = (uint32_t)integer_ticks;
    if (axis->period_fraction_accum >= 1.0f)
    {
        period_ticks++;
        axis->period_fraction_accum -= 1.0f;
    }

    period_ticks = StepperClampU32(period_ticks, axis->cfg.arr_min + 1U, axis->cfg.arr_max + 1U);
    arr = period_ticks - 1U;

    /*
     * 目标是近似 50% 占空比，同时满足驱动器对 STEP 高电平宽度的要求：
     * t_high = CCR / f_tim >= t_high_min
     */
    ccr = period_ticks / 2U;
    if (ccr < axis->cfg.pulse_high_min_ticks)
    {
        ccr = axis->cfg.pulse_high_min_ticks;
    }

    if (ccr > arr)
    {
        ccr = arr;
    }

    __HAL_TIM_SET_AUTORELOAD(axis->cfg.pulse_htim, arr);
    __HAL_TIM_SET_COMPARE(axis->cfg.pulse_htim, axis->cfg.pulse_channel, ccr);
}

/**
 * @brief 计算对称 S 曲线加速半程的位移、速度和加速度。
 * @param plan 已求解轨迹。
 * @param t_s 半程内时间，范围 [0, t_acc_total_s]。
 * @param[out] x_mm 半程累计位移。
 * @param[out] v_mm_s 半程瞬时速度。
 * @param[out] a_mm_s2 半程瞬时加速度。
 *
 * @note 三段解析式如下：
 *       1) jerk 上升段:
 *          a = j * t
 *          v = 0.5 * j * t^2
 *          x = (1 / 6) * j * t^3
 *
 *       2) 恒加速度段:
 *          a = A
 *          v = v1 + A * tau
 *          x = x1 + v1 * tau + 0.5 * A * tau^2
 *
 *       3) jerk 回落段:
 *          a = A - j * tau
 *          v = v2 + A * tau - 0.5 * j * tau^2
 *          x = x2 + v2 * tau + 0.5 * A * tau^2 - (1 / 6) * j * tau^3
 */
static void StepperEvalAccelHalf(const StepperMovePlan_t *plan,
                                 float t_s,
                                 float *x_mm,
                                 float *v_mm_s,
                                 float *a_mm_s2)
{
    const float Tj = plan->t_jerk_s;
    const float Ta = plan->t_acc_hold_s;
    const float A = plan->a_peak_mm_s2;
    const float j = plan->jerk_mm_s3;
    float tau;
    float x1;
    float v1;
    float x2;
    float v2;

    t_s = StepperClampF(t_s, 0.0f, plan->t_acc_total_s);

    if (t_s < Tj)
    {
        *a_mm_s2 = j * t_s;
        *v_mm_s = 0.5f * j * t_s * t_s;
        *x_mm = (j * t_s * t_s * t_s) / 6.0f;
        return;
    }

    x1 = (A * Tj * Tj) / 6.0f;
    v1 = 0.5f * A * Tj;

    if (t_s < (Tj + Ta))
    {
        tau = t_s - Tj;
        *a_mm_s2 = A;
        *v_mm_s = v1 + (A * tau);
        *x_mm = x1 + (v1 * tau) + (0.5f * A * tau * tau);
        return;
    }

    x2 = x1 + (v1 * Ta) + (0.5f * A * Ta * Ta);
    v2 = v1 + (A * Ta);
    tau = t_s - Tj - Ta;

    *a_mm_s2 = A - (j * tau);
    *v_mm_s = v2 + (A * tau) - (0.5f * j * tau * tau);
    *x_mm = x2 + (v2 * tau) + (0.5f * A * tau * tau) - ((j * tau * tau * tau) / 6.0f);
}

/**
 * @brief 在整条对称 S 曲线上采样位移、速度和加速度。
 * @param plan 已求解轨迹。
 * @param t_s 当前总时间。
 * @param[out] x_mm 累计位移。
 * @param[out] v_mm_s 瞬时速度。
 * @param[out] a_mm_s2 瞬时加速度。
 *
 * @note 减速半程直接使用时间镜像：
 *       x(t) = S_total - x_acc(t_total - t)
 *       v(t) = v_acc(t_total - t)
 *       a(t) = -a_acc(t_total - t)
 *
 *       好处是加减速天然对称，短行程段退化时也不需要再单独写一套减速公式。
 */
static void StepperEvaluateProfile(const StepperMovePlan_t *plan,
                                   float t_s,
                                   float *x_mm,
                                   float *v_mm_s,
                                   float *a_mm_s2)
{
    float mirrored_x;
    float mirrored_v;
    float mirrored_a;

    t_s = StepperClampF(t_s, 0.0f, plan->t_total_s);

    if (t_s <= plan->t_acc_total_s)
    {
        StepperEvalAccelHalf(plan, t_s, x_mm, v_mm_s, a_mm_s2);
        return;
    }

    if (t_s <= (plan->t_acc_total_s + plan->t_cruise_s))
    {
        const float tau = t_s - plan->t_acc_total_s;
        *x_mm = plan->s_accel_half_mm + (plan->v_peak_mm_s * tau);
        *v_mm_s = plan->v_peak_mm_s;
        *a_mm_s2 = 0.0f;
        return;
    }

    StepperEvalAccelHalf(plan, plan->t_total_s - t_s, &mirrored_x, &mirrored_v, &mirrored_a);
    *x_mm = plan->quantized_distance_mm - mirrored_x;
    *v_mm_s = mirrored_v;
    *a_mm_s2 = -mirrored_a;
}

/**
 * @brief 根据目标位移求解短行程友好的对称 S 曲线。
 * @param axis 步进轴对象。
 * @param distance_mm 目标位移，正负号表示方向。
 * @retval true 求解成功。
 * @retval false 参数非法或量化后目标步数为 0。
 *
 * @note 先做位移到步数的量化：
 *       target_steps = round(|distance_mm| / step_length_mm)
 *       S_quantized  = target_steps * step_length_mm
 *
 *       这样轨迹规划一开始就对齐离散执行边界，避免最后再补一个“神秘半步”。
 *
 *       长行程判据：
 *       S_total > 2 * S_half(v_max)  -> 存在匀速段
 *
 *       无匀速但可触顶 a_max：
 *       S_half = A * (Tj^2 + 1.5 * Tj * Ta + 0.5 * Ta^2)
 *       解出 Ta 即可
 *
 *       极短行程纯三角 S 曲线：
 *       S_total = 2 * j * Tj^3
 *       Tj = cbrt(S_total / (2 * j))
 */
static bool StepperBuildShortMovePlan(StepperAxis_t *axis, float distance_mm)
{
    StepperMovePlan_t plan;
    const float abs_distance_mm = fabsf(distance_mm);
    const float step_length_mm = axis->cfg.step_length_mm;
    const float j_max = axis->cfg.j_max_mm_s3;
    const float a_max = axis->cfg.a_max_mm_s2;
    const float v_max = axis->cfg.v_max_mm_s;
    uint32_t target_steps;
    float quantized_distance_mm;
    float Tj_limit;
    float v_threshold;
    float Tj_vmax;
    float Ta_vmax;
    float s_acc_vmax;
    float s_total_no_cruise;
    float s_total_reach_amax;

    if ((axis == NULL) || (step_length_mm <= 0.0f) || (j_max <= 0.0f) ||
        (a_max <= 0.0f) || (v_max <= 0.0f))
    {
        return false;
    }

    target_steps = (uint32_t)lroundf(abs_distance_mm / step_length_mm);
    if (target_steps == 0U)
    {
        return false;
    }

    memset(&plan, 0, sizeof(plan));
    quantized_distance_mm = (float)target_steps * step_length_mm;
    Tj_limit = a_max / j_max;
    v_threshold = a_max * Tj_limit;

    if (v_max >= v_threshold)
    {
        Tj_vmax = Tj_limit;
        Ta_vmax = (v_max / a_max) - Tj_limit;
        s_acc_vmax = a_max * (Tj_vmax * Tj_vmax +
                              1.5f * Tj_vmax * Ta_vmax +
                              0.5f * Ta_vmax * Ta_vmax);
    }
    else
    {
        Tj_vmax = sqrtf(v_max / j_max);
        Ta_vmax = 0.0f;
        s_acc_vmax = j_max * Tj_vmax * Tj_vmax * Tj_vmax;
    }

    s_total_no_cruise = 2.0f * s_acc_vmax;
    s_total_reach_amax = 2.0f * a_max * Tj_limit * Tj_limit;

    plan.direction = (distance_mm >= 0.0f) ? 1 : -1;
    plan.target_steps = target_steps;
    plan.quantized_distance_mm = quantized_distance_mm;
    plan.jerk_mm_s3 = j_max;

    if (quantized_distance_mm > s_total_no_cruise)
    {
        plan.kind = STEPPER_PROFILE_FULL;
        plan.t_jerk_s = Tj_vmax;
        plan.t_acc_hold_s = Ta_vmax;
        plan.t_cruise_s = (quantized_distance_mm - s_total_no_cruise) / v_max;
        plan.a_peak_mm_s2 = (Ta_vmax > 0.0f) ? a_max : (j_max * Tj_vmax);
        plan.v_peak_mm_s = v_max;
        plan.s_accel_half_mm = s_acc_vmax;
    }
    else if (quantized_distance_mm >= s_total_reach_amax)
    {
        const float half_distance = 0.5f * quantized_distance_mm;
        const float radical = (Tj_limit * Tj_limit) + ((8.0f * half_distance) / a_max);
        const float Ta = 0.5f * (-3.0f * Tj_limit + sqrtf(radical));

        plan.kind = STEPPER_PROFILE_NO_CRUISE;
        plan.t_jerk_s = Tj_limit;
        plan.t_acc_hold_s = StepperClampF(Ta, 0.0f, STEPPER_MAX_PROFILE_TIME_S);
        plan.t_cruise_s = 0.0f;
        plan.a_peak_mm_s2 = a_max;
        plan.v_peak_mm_s = a_max * (plan.t_acc_hold_s + Tj_limit);
        plan.s_accel_half_mm = half_distance;
    }
    else
    {
        const float Tj = cbrtf(quantized_distance_mm / (2.0f * j_max));

        plan.kind = STEPPER_PROFILE_TRIANGULAR;
        plan.t_jerk_s = Tj;
        plan.t_acc_hold_s = 0.0f;
        plan.t_cruise_s = 0.0f;
        plan.a_peak_mm_s2 = j_max * Tj;
        plan.v_peak_mm_s = j_max * Tj * Tj;
        plan.s_accel_half_mm = 0.5f * quantized_distance_mm;
    }

    plan.t_acc_total_s = (2.0f * plan.t_jerk_s) + plan.t_acc_hold_s;
    plan.t_total_s = (2.0f * plan.t_acc_total_s) + plan.t_cruise_s;

    axis->plan = plan;
    return true;
}

/**
 * @brief 根据连续位置命令发布步预算，并决定脉冲层是否需要继续工作。
 * @param axis 步进轴对象。
 * @param commanded_position_mm 当前连续轨迹给出的累计位移。
 * @param desired_velocity_mm_s 当前连续轨迹给出的速度。
 * @retval true 本周期允许输出 STEP。
 * @retval false 当前没有可发步预算，应停住载波层等待下一拍预算。
 *
 * @note 核心思想是：
 *       released_steps = floor(commanded_position_mm / step_length_mm)
 *
 *       载波层只能把 `emitted_steps` 推进到 `released_steps`，
 *       绝不允许因为 ARR 量化或 ISR 抖动而超发。
 */
static bool StepperPublishReleasedSteps(StepperAxis_t *axis,
                                        float commanded_position_mm,
                                        float desired_velocity_mm_s)
{
    uint32_t commanded_steps;
    uint32_t backlog_steps;
    float desired_step_freq_hz;

    if (axis == NULL)
    {
        return false;
    }

    commanded_position_mm = StepperClampF(commanded_position_mm,
                                          0.0f,
                                          axis->plan.quantized_distance_mm);
    commanded_steps = (uint32_t)floorf((commanded_position_mm / axis->cfg.step_length_mm) + STEPPER_EPSILON);
    commanded_steps = StepperClampU32(commanded_steps, axis->emitted_steps, axis->plan.target_steps);
    axis->released_steps = commanded_steps;

    backlog_steps = axis->released_steps - axis->emitted_steps;
    if (backlog_steps == 0U)
    {
        StepperPulseStop(axis);
        return false;
    }

    desired_step_freq_hz = desired_velocity_mm_s / axis->cfg.step_length_mm;
    desired_step_freq_hz = StepperClampF(desired_step_freq_hz,
                                         STEPPER_MIN_TAIL_FREQ_HZ,
                                         axis->cfg.pulse_timer_hz / ((float)axis->cfg.arr_min + 1.0f));

    StepperSetPulseFrequency(axis, desired_step_freq_hz);
    return StepperPulseStart(axis);
}

/**
 * @brief 启动一次短行程位移动作。
 * @param axis 步进轴对象。
 * @param distance_mm 目标位移。
 * @retval true 启动成功。
 * @retval false 规划失败或底层启动失败。
 *
 * @note 在切换 DIR 后先等待建立时间：
 *       t_dir_setup = dir_setup_cycles / f_cpu
 *
 *       这样做不是形式主义，而是避免驱动器在方向未稳定时误采第一拍 STEP。
 */
bool StepperStartShortMove(StepperAxis_t *axis, float distance_mm)
{
    if ((axis == NULL) || (!StepperBuildShortMovePlan(axis, distance_mm)))
    {
        return false;
    }

    axis->emitted_steps = 0U;
    axis->released_steps = 0U;
    axis->planner_elapsed_s = 0.0f;
    axis->last_command_mm = 0.0f;
    axis->period_fraction_accum = 0.0f;
    axis->motion_active = true;
    axis->pulse_running = false;

    HAL_GPIO_WritePin(axis->cfg.dir_port,
                      axis->cfg.dir_pin,
                      (axis->plan.direction > 0) ? GPIO_PIN_SET : GPIO_PIN_RESET);
    StepperDelayCycles(axis->cfg.dir_setup_cycles);

    __HAL_TIM_SET_COUNTER(axis->cfg.pulse_htim, 0U);
    return true;
}

/**
 * @brief 规划层固定时基回调。
 * @param axis 步进轴对象。
 *
 * @note 若连续轨迹时间已经结束，但整数步还没发完，则进入尾段清算：
 *       tail_freq = clamp(remaining_steps / planner_dt, f_tail_min, f_tail_max)
 *
 *       这里不再回头相信连续速度，而是只对剩余步数负责，
 *       直到 `emitted_steps == target_steps` 为止。
 */
void StepperPlannerTick(StepperAxis_t *axis)
{
    float x_cmd_mm;
    float v_cmd_mm_s;
    float a_cmd_mm_s2;
    uint32_t remaining_steps;
    float tail_freq_hz;

    if ((axis == NULL) || (!axis->motion_active))
    {
        return;
    }

    if (axis->emitted_steps >= axis->plan.target_steps)
    {
        axis->motion_active = false;
        StepperPulseStop(axis);
        return;
    }

    axis->planner_elapsed_s = StepperClampF(axis->planner_elapsed_s + axis->cfg.planner_dt_s,
                                            0.0f,
                                            axis->plan.t_total_s);

    StepperEvaluateProfile(&axis->plan, axis->planner_elapsed_s, &x_cmd_mm, &v_cmd_mm_s, &a_cmd_mm_s2);
    (void)a_cmd_mm_s2;

    axis->last_command_mm = x_cmd_mm;

    if (axis->planner_elapsed_s < axis->plan.t_total_s)
    {
        (void)StepperPublishReleasedSteps(axis, x_cmd_mm, v_cmd_mm_s);
        return;
    }

    /*
     * 进入尾段: 轨迹时间结束后，released_steps 直接放到目标步数，
     * 让载波层把尚未清算的整数步安全发完。
     */
    axis->released_steps = axis->plan.target_steps;
    remaining_steps = axis->plan.target_steps - axis->emitted_steps;

    if (remaining_steps == 0U)
    {
        axis->motion_active = false;
        StepperPulseStop(axis);
        return;
    }

    tail_freq_hz = (float)remaining_steps / axis->cfg.planner_dt_s;
    tail_freq_hz = StepperClampF(tail_freq_hz, STEPPER_MIN_TAIL_FREQ_HZ, STEPPER_MAX_TAIL_FREQ_HZ);
    StepperSetPulseFrequency(axis, tail_freq_hz);
    (void)StepperPulseStart(axis);
}

/**
 * @brief 在 STEP 定时器更新事件中累计已发步数。
 * @param axis 步进轴对象。
 *
 * @note 该层只认两个事实：
 *       1. emitted_steps 是已经真实落到驱动器输入端的整数步数；
 *       2. released_steps 是规划层已经批准的最大发步数。
 *
 *       只要 `emitted_steps == released_steps`，就必须停脉冲等待下一轮预算，
 *       从根上阻止“时间到了但位置越界”的问题。
 */
void StepperOnPulseElapsed(StepperAxis_t *axis)
{
    if ((axis == NULL) || (!axis->motion_active))
    {
        return;
    }

    if (axis->emitted_steps >= axis->released_steps)
    {
        StepperPulseStop(axis);
        return;
    }

    axis->emitted_steps++;

    if (axis->emitted_steps >= axis->plan.target_steps)
    {
        axis->motion_active = false;
        StepperPulseStop(axis);
        return;
    }

    if (axis->emitted_steps >= axis->released_steps)
    {
        StepperPulseStop(axis);
    }
}

void HAL_TIM_PeriodElapsedCallback(TIM_HandleTypeDef *htim)
{
    if (htim->Instance == TIM6)
    {
        StepperPlannerTick(&g_axis_x);
        return;
    }

    if (htim->Instance == g_axis_x.cfg.pulse_htim->Instance)
    {
        StepperOnPulseElapsed(&g_axis_x);
    }
}
```

这段代码真正建立的，不是一条“看上去很平滑”的速度曲线，而是一套跨越两个世界的清账机制。规划层用连续时间表达 jerk、加速度和位移，执行层用整数步和整数定时器 tick 落地命令，中间通过 `released_steps` 这个步预算变量建立硬边界。于是短行程再短，也不会因为段退化而错判相位；ARR 再怎么量化，也只会在时间上抖动平均值，不会在位置上偷走最后一步。对步进系统来说，这比单纯把 `v_max` 调得更保守更重要，因为真正决定末端品质的，往往不是电机能不能再快一点，而是控制器有没有把最后几步说清楚。
