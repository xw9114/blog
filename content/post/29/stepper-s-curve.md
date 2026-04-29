---
title: "技能档案：步进电机 S 型加减速算法，从 jerk 受限轨迹到机械谐振抑制"
slug: "skill-stepper-s-curve-jerk-limited-trajectory-and-resonance-suppression"
date: 2026-04-29T10:08:32+08:00
draft: false
description: "从 jerk 受限轨迹、短行程峰值求解到 STM32 定时器脉冲映射，系统拆解 S 型加减速为何比梯形速度曲线更懂机械谐振。"
tags: ["STM32", "步进电机", "S型加减速", "定时器", "运动控制"]
categories: ["技能档案"]
image: ""
---

## 技能概述

步进电机真正难的地方，从来不是“给它一串脉冲它就会转”，而是如何让离散脉冲序列在有限转矩、有限电流建立时间和有限机械刚度的现实里，既跟得上目标速度，又不要把丝杆、联轴器和负载平台打进共振区。3D 打印机、点胶平台、滑台模组、视觉对焦机构和小型 CNC 之所以依赖 S 型加减速，不是因为它听起来比梯形速度曲线高级，而是因为它把原本在相位切换处瞬间跳变的加速度，重新约束成一个对电机磁链和机械结构都更友好的 jerk 有限过程。真正的工程痛点，不在 `HAL_TIM_PWM_Start()` 能否拉出 STEP 波形，而在于你是否理解离散步距如何映射成线位移、速度指令如何翻译成定时器重装值、短行程为什么根本跑不到标称最高速，以及谐振本质上是你的时域调度方式在激励系统固有频率。

## 核心底层概念解析

- **步进电机不是连续力矩源，而是离散角位移激励器**：对典型 `1.8°` 电机而言，整步一圈是 `200` 步；若驱动器工作在 `microstep = 16`，则单脉冲角位移只有 `360 / (200 * 16) = 0.1125°`。如果再接一根 `8 mm/rev` 丝杆，线位移分辨率就变成 `l_step = 8 / (200 * 16) = 0.0025 mm`。后续所有速度、位移、误差与限幅，最终都要回到这个最小离散单位。
- **梯形加减速的问题不在速度平台，而在加速度突变**：梯形速度曲线把加速度从 `0` 突然切到 `a_max`，又在拐点处从 `a_max` 瞬间切回 `0`。从数学上看，这等于 jerk `j = da / dt` 在相位边界处趋近无穷大。无限尖锐的 jerk 会把宽频能量砸进机械系统，最容易激发步进电机中低速区的转子摆振、齿槽转矩起伏和丝杆弹性耦合。
- **S 型加减速的本质，是给加速度再套一层带宽限制**：它不直接调速度，而是先限制 jerk，再积分得到加速度、速度和位置。连续形式满足 `a(t) = ∫ j(t) dt`，`v(t) = ∫ a(t) dt`，`x(t) = ∫ v(t) dt`；离散实现则是 `a[k+1] = a[k] + j[k] * dt`，`v[k+1] = v[k] + a[k] * dt`，`x[k+1] = x[k] + v[k] * dt + 0.5 * a[k] * dt^2`。这不是数学装饰，而是在时域里主动裁掉高频激励。
- **七段式 S 曲线，本质上是三层积分状态机**：完整轨迹通常包含“加加速、恒加速、减加速、匀速、负加加速、恒减速、正减加速”七段。它不是为了图形好看，而是让控制器可以在“最快到达”和“不过分打扰机械系统”之间做资源分配。
- **短行程常常根本进不了匀速段**：当总位移太短时，系统来不及升到 `v_max` 就必须开始减速。此时轨迹求解的关键不再是“跑多快”，而是“在给定距离里，峰值速度和峰值加速度到底能抬到哪里”。如果还拿长行程参数硬套短行程，结果通常就是减速距离不够、末端冲击变大或直接丢步。
- **STEP 频率是速度在数字世界里的直接投影**：若单步线位移为 `l_step`，则目标速度与脉冲频率满足 `f_step = v / l_step`。定时器重装值进一步满足 `ARR ≈ f_tim / f_step - 1`。因此“速度规划”并不是一个独立模块，它最终必须变成可落地的定时器周期，接受计数位宽、最小高电平宽度和驱动器建立保持时间的约束。
- **驱动器与功率回路给脉冲上限设了物理天花板**：很多 STEP/DIR 驱动器都要求 `t_STEPH`、`t_STEPL` 至少几百纳秒到数微秒不等；同时绕组电流建立还受电感、电源电压和细分斩波策略限制。即使 MCU 能打出更快的脉冲，电机也未必能在该速度下维持足够转矩，所以“能输出”和“能跟上”从来不是同一件事。
- **抗丢步不是单纯把电流调大，而是让需求转矩变化率别超过机电系统带宽**：负载惯量越大、供电越低、细分越高、反电动势越强，步进电机能承受的速度斜率和加速度斜率就越有限。S 曲线降低的并不是最终速度，而是命令变化的尖锐程度，让驱动器和机械结构有时间把理想轨迹翻译成真实转子位置。
- **定时器只是脉冲发生器，真正决定运动品质的是“规划时基”和“载波时基”的解耦**：工程上常见做法，是用一个固定周期的规划中断，例如 `1 kHz`，在其中更新当前位置、速度与目标频率；再让另一个高速定时器负责连续输出 STEP 脉冲。前者负责“想跑多快”，后者负责“脉冲怎么稳定地发出去”。把这两层时基混在一起，最后往往既不平滑，也不稳定。
- **S 型加减速背后的技术哲学，是让数字调度尊重电机和机构的固有节奏**：我们并不是在“美化曲线”，而是在承认任何控制命令最终都要穿过磁链建立、机械弹性和采样时基这三道物理关卡。算法真正高级的地方，不是公式多，而是它知道什么时候该慢一点，才能让系统整体更快。

## 代码能力展现

```c
#include <math.h>
#include <stdbool.h>
#include <stdint.h>

#include "tim.h"
#include "gpio.h"

/**
 * 这里假定使用 STEP / DIR 驱动器：
 * 1. TIM1 CH1 负责输出 STEP 脉冲；
 * 2. TIM6 以固定周期触发规划器更新；
 * 3. DIR 引脚由 GPIO 控制。
 */
#define STEP_DIR_GPIO_Port GPIOA
#define STEP_DIR_Pin       GPIO_PIN_8

typedef struct
{
    TIM_HandleTypeDef *step_htim;
    uint32_t step_channel;
    float timer_clock_hz;
    float planner_dt_s;
    float step_length_mm;
    float v_max_mm_s;
    float a_max_mm_s2;
    float j_max_mm_s3;
    uint32_t arr_min;
    uint32_t arr_max;
    uint32_t step_high_min_ticks;
} StepperAxisConfig;

typedef struct
{
    float distance_mm;
    float t_jerk_s;
    float t_accel_hold_s;
    float t_cruise_s;
    float t_accel_total_s;
    float t_total_s;
    float s_accel_mm;
    float v_peak_mm_s;
    float a_peak_mm_s2;
    float jerk_mm_s3;
    int32_t direction;
    uint32_t target_steps;
} StepperSCurvePlan;

typedef struct
{
    StepperAxisConfig cfg;
    StepperSCurvePlan plan;
    float elapsed_s;
    volatile uint32_t emitted_steps;
    bool active;
} StepperAxis;

static StepperAxis g_stepper_x =
{
    .cfg =
    {
        .step_htim = &htim1,
        .step_channel = TIM_CHANNEL_1,
        .timer_clock_hz = 72000000.0f,
        .planner_dt_s = 0.001f,          /* 1 kHz 规划时基 */
        .step_length_mm = 0.0025f,       /* 8 mm 丝杆 / (200 * 16) */
        .v_max_mm_s = 120.0f,
        .a_max_mm_s2 = 2500.0f,
        .j_max_mm_s3 = 40000.0f,
        .arr_min = 359U,                 /* 72 MHz / (359 + 1) = 200 kHz */
        .arr_max = 0xFFFFU,
        .step_high_min_ticks = 72U       /* 72 MHz 下 1 us 高电平下限 */
    }
};

static bool StepperSCurve_BuildPlan(StepperAxis *axis, float distance_mm);
void StepperSCurve_PlannerTick(StepperAxis *axis);

static float Stepper_ClampFloat(float value, float min_value, float max_value)
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

static void StepperSCurve_Stop(StepperAxis *axis)
{
    axis->active = false;
    __HAL_TIM_SET_COMPARE(axis->cfg.step_htim, axis->cfg.step_channel, 0U);
    HAL_TIM_Base_Stop_IT(axis->cfg.step_htim);
    HAL_TIM_PWM_Stop(axis->cfg.step_htim, axis->cfg.step_channel);
}

/**
 * @brief 把目标 STEP 频率映射为定时器 ARR / CCR。
 * @param axis 步进轴对象。
 * @param step_freq_hz 目标脉冲频率，单位 Hz。
 *
 * @note 线性映射关系为：
 *       f_step = v / l_step
 *       ARR ~= f_tim / f_step - 1
 *       其中 l_step 是单脉冲对应的线位移，f_tim 是定时器计数时钟。
 *       为满足驱动器脉宽约束，还要保证：
 *       (ARR + 1) / 2 >= step_high_min_ticks
 */
static void StepperSCurve_SetPulseFrequency(StepperAxis *axis, float step_freq_hz)
{
    const float min_step_freq_hz = 1.0f;
    const float max_step_freq_hz = axis->cfg.timer_clock_hz / ((float)axis->cfg.arr_min + 1.0f);

    uint32_t arr = 0U;
    uint32_t ccr = 0U;
    float arr_f = 0.0f;

    step_freq_hz = Stepper_ClampFloat(step_freq_hz, min_step_freq_hz, max_step_freq_hz);

    arr_f = (axis->cfg.timer_clock_hz / step_freq_hz) - 1.0f;
    arr_f = Stepper_ClampFloat(arr_f, (float)axis->cfg.arr_min, (float)axis->cfg.arr_max);
    arr = (uint32_t)lroundf(arr_f);

    /* 近似 50% 占空比，同时保证高电平宽度不小于驱动器最小要求。 */
    ccr = (arr + 1U) / 2U;
    if (ccr < axis->cfg.step_high_min_ticks)
    {
        ccr = axis->cfg.step_high_min_ticks;
    }

    if (ccr > arr)
    {
        ccr = arr;
    }

    __HAL_TIM_SET_AUTORELOAD(axis->cfg.step_htim, arr);
    __HAL_TIM_SET_COMPARE(axis->cfg.step_htim, axis->cfg.step_channel, ccr);
}

/**
 * @brief 评估 S 曲线前半程（加速半程）的位移、速度和加速度。
 * @param plan 已求解的轨迹参数。
 * @param t_s 当前采样时间，范围为 [0, t_accel_total_s]。
 * @param[out] x_mm 该时刻累计位移，单位 mm。
 * @param[out] v_mm_s 该时刻线速度，单位 mm/s。
 * @param[out] a_mm_s2 该时刻线加速度，单位 mm/s^2。
 *
 * @note 对 jerk 受限加速半程，三段解析式分别为：
 *       1) 加加速段：
 *          a = j * t
 *          v = 0.5 * j * t^2
 *          x = (1 / 6) * j * t^3
 *       2) 恒加速段：
 *          a = A
 *          v = v1 + A * tau
 *          x = x1 + v1 * tau + 0.5 * A * tau^2
 *       3) 减加速段：
 *          a = A - j * tau
 *          v = v2 + A * tau - 0.5 * j * tau^2
 *          x = x2 + v2 * tau + 0.5 * A * tau^2 - (1 / 6) * j * tau^3
 */
static void StepperSCurve_EvalAccelHalf(const StepperSCurvePlan *plan,
                                        float t_s,
                                        float *x_mm,
                                        float *v_mm_s,
                                        float *a_mm_s2)
{
    const float Tj = plan->t_jerk_s;
    const float Ta = plan->t_accel_hold_s;
    const float A = plan->a_peak_mm_s2;
    const float j = plan->jerk_mm_s3;

    float tau = 0.0f;
    float x1 = 0.0f;
    float v1 = 0.0f;
    float x2 = 0.0f;
    float v2 = 0.0f;

    t_s = Stepper_ClampFloat(t_s, 0.0f, plan->t_accel_total_s);

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
 * @brief 在整条 S 曲线上采样当前位移、速度和加速度。
 * @param plan 已求解的轨迹参数。
 * @param t_s 当前总时间，范围为 [0, t_total_s]。
 * @param[out] x_mm 该时刻累计位移，单位 mm。
 * @param[out] v_mm_s 该时刻线速度，单位 mm/s。
 * @param[out] a_mm_s2 该时刻线加速度，单位 mm/s^2。
 *
 * @note 减速半程使用时间镜像：
 *       x(t) = S_total - x_accel(t_total - t)
 *       v(t) = v_accel(t_total - t)
 *       a(t) = -a_accel(t_total - t)
 *       这样可以避免重复写一套减速分段公式，同时保证轨迹严格对称。
 */
static void StepperSCurve_Evaluate(const StepperSCurvePlan *plan,
                                   float t_s,
                                   float *x_mm,
                                   float *v_mm_s,
                                   float *a_mm_s2)
{
    float xr = 0.0f;
    float vr = 0.0f;
    float ar = 0.0f;
    const float t_acc = plan->t_accel_total_s;

    t_s = Stepper_ClampFloat(t_s, 0.0f, plan->t_total_s);

    if (t_s <= t_acc)
    {
        StepperSCurve_EvalAccelHalf(plan, t_s, x_mm, v_mm_s, a_mm_s2);
        return;
    }

    if (t_s <= (t_acc + plan->t_cruise_s))
    {
        const float tau = t_s - t_acc;
        *x_mm = plan->s_accel_mm + (plan->v_peak_mm_s * tau);
        *v_mm_s = plan->v_peak_mm_s;
        *a_mm_s2 = 0.0f;
        return;
    }

    StepperSCurve_EvalAccelHalf(plan, plan->t_total_s - t_s, &xr, &vr, &ar);
    *x_mm = plan->distance_mm - xr;
    *v_mm_s = vr;
    *a_mm_s2 = -ar;
}

/**
 * @brief 根据目标位移求解对称 S 曲线参数。
 * @param axis 步进轴对象。
 * @param distance_mm 目标位移，正负号决定方向，单位 mm。
 * @retval true 求解成功。
 * @retval false 输入非法或目标位移小于半步。
 *
 * @note 该函数先把连续位移量化成整数步数，再做轨迹求解，避免“规划位移”
 *       与“实际脉冲数”之间长期漂移。关键约束分两类：
 *       1) 长行程：若 S_total > 2 * S_acc(v_max)，则包含匀速段；
 *       2) 短行程：若距离不足以跑到 v_max，则自动回退为无匀速段，
 *          进一步判断是否能达到 a_max。
 *
 *       纯三角 S 曲线时：
 *       S_total = 2 * j * Tj^3  ->  Tj = cbrt(S_total / (2 * j))
 *
 *       能达到 a_max 但无匀速段时：
 *       S_half = A * (Tj^2 + 1.5 * Tj * Ta + 0.5 * Ta^2)
 *       联立可解 Ta，进而得到 v_peak = A * (Ta + Tj)
 */
static bool StepperSCurve_BuildPlan(StepperAxis *axis, float distance_mm)
{
    StepperSCurvePlan plan = {0};
    const float abs_distance_mm = fabsf(distance_mm);
    const float step_length_mm = axis->cfg.step_length_mm;
    const float j_max = axis->cfg.j_max_mm_s3;
    const float a_max = axis->cfg.a_max_mm_s2;
    const float v_max = axis->cfg.v_max_mm_s;

    uint32_t target_steps = 0U;
    float total_distance_mm = 0.0f;
    float Tj_full = 0.0f;
    float v_threshold = 0.0f;
    float Tj_vmax = 0.0f;
    float Ta_vmax = 0.0f;
    float s_acc_vmax = 0.0f;
    float s_no_cruise = 0.0f;

    if ((step_length_mm <= 0.0f) || (j_max <= 0.0f) || (a_max <= 0.0f) || (v_max <= 0.0f))
    {
        return false;
    }

    target_steps = (uint32_t)lroundf(abs_distance_mm / step_length_mm);
    if (target_steps == 0U)
    {
        return false;
    }

    total_distance_mm = (float)target_steps * step_length_mm;
    Tj_full = a_max / j_max;
    v_threshold = a_max * Tj_full; /* 等价于 a_max^2 / j_max */

    if (v_max >= v_threshold)
    {
        /* 能到达 a_max，再在恒加速段继续爬升到 v_max。 */
        Tj_vmax = Tj_full;
        Ta_vmax = (v_max / a_max) - Tj_full;
        s_acc_vmax = a_max * (Tj_vmax * Tj_vmax +
                              1.5f * Tj_vmax * Ta_vmax +
                              0.5f * Ta_vmax * Ta_vmax);
    }
    else
    {
        /* vmax 很低时，轨迹退化成不触顶 a_max 的三角 S 曲线。 */
        Tj_vmax = sqrtf(v_max / j_max);
        Ta_vmax = 0.0f;
        s_acc_vmax = j_max * Tj_vmax * Tj_vmax * Tj_vmax;
    }

    s_no_cruise = 2.0f * s_acc_vmax;

    plan.direction = (distance_mm >= 0.0f) ? 1 : -1;
    plan.distance_mm = total_distance_mm;
    plan.jerk_mm_s3 = j_max;
    plan.target_steps = target_steps;

    if (total_distance_mm > s_no_cruise)
    {
        /* 长行程：加速、匀速、减速三段齐全。 */
        plan.t_jerk_s = Tj_vmax;
        plan.t_accel_hold_s = Ta_vmax;
        plan.t_cruise_s = (total_distance_mm - s_no_cruise) / v_max;
        plan.a_peak_mm_s2 = (Ta_vmax > 0.0f) ? a_max : (j_max * Tj_vmax);
        plan.v_peak_mm_s = v_max;
        plan.s_accel_mm = s_acc_vmax;
    }
    else
    {
        const float distance_reach_amax_mm = 2.0f * a_max * Tj_full * Tj_full;

        if (total_distance_mm >= distance_reach_amax_mm)
        {
            const float half_distance_mm = 0.5f * total_distance_mm;
            const float radical = (Tj_full * Tj_full) + ((8.0f * half_distance_mm) / a_max);
            const float Ta = 0.5f * (-3.0f * Tj_full + sqrtf(radical));

            plan.t_jerk_s = Tj_full;
            plan.t_accel_hold_s = Stepper_ClampFloat(Ta, 0.0f, 1.0e6f);
            plan.t_cruise_s = 0.0f;
            plan.a_peak_mm_s2 = a_max;
            plan.v_peak_mm_s = a_max * (plan.t_accel_hold_s + Tj_full);
            plan.s_accel_mm = half_distance_mm;
        }
        else
        {
            /* 极短位移：只剩两段加加速和两段减加速。 */
            const float Tj = cbrtf(total_distance_mm / (2.0f * j_max));

            plan.t_jerk_s = Tj;
            plan.t_accel_hold_s = 0.0f;
            plan.t_cruise_s = 0.0f;
            plan.a_peak_mm_s2 = j_max * Tj;
            plan.v_peak_mm_s = j_max * Tj * Tj;
            plan.s_accel_mm = 0.5f * total_distance_mm;
        }
    }

    plan.t_accel_total_s = (2.0f * plan.t_jerk_s) + plan.t_accel_hold_s;
    plan.t_total_s = (2.0f * plan.t_accel_total_s) + plan.t_cruise_s;
    axis->plan = plan;

    return true;
}

/**
 * @brief 启动一次位移运动。
 * @param axis 步进轴对象。
 * @param distance_mm 目标位移，正负号决定方向，单位 mm。
 * @retval true 规划并启动成功。
 * @retval false 规划失败。
 */
bool StepperSCurve_StartMove(StepperAxis *axis, float distance_mm)
{
    if (!StepperSCurve_BuildPlan(axis, distance_mm))
    {
        return false;
    }

    axis->elapsed_s = 0.0f;
    axis->emitted_steps = 0U;
    axis->active = true;

    HAL_GPIO_WritePin(STEP_DIR_GPIO_Port,
                      STEP_DIR_Pin,
                      (axis->plan.direction > 0) ? GPIO_PIN_SET : GPIO_PIN_RESET);

    __HAL_TIM_SET_COUNTER(axis->cfg.step_htim, 0U);
    HAL_TIM_Base_Start_IT(axis->cfg.step_htim);
    HAL_TIM_PWM_Start(axis->cfg.step_htim, axis->cfg.step_channel);

    /* 立即采样一次轨迹，避免起始 ARR 仍停在 CubeMX 默认值。 */
    StepperSCurve_PlannerTick(axis);
    return axis->active;
}

/**
 * @brief 在固定规划时基中更新当前 STEP 频率。
 * @param axis 步进轴对象。
 *
 * @note 如果规划已经结束，但离目标还差最后几个离散步，则进入短尾段补齐。
 *       这样可以兼顾连续轨迹与离散脉冲计数，避免因为四舍五入少发 1~2 步。
 */
void StepperSCurve_PlannerTick(StepperAxis *axis)
{
    float x_mm = 0.0f;
    float v_mm_s = 0.0f;
    float a_mm_s2 = 0.0f;
    float remaining_mm = 0.0f;
    float step_freq_hz = 0.0f;

    if ((axis == NULL) || (!axis->active))
    {
        return;
    }

    if (axis->emitted_steps >= axis->plan.target_steps)
    {
        StepperSCurve_Stop(axis);
        return;
    }

    axis->elapsed_s = Stepper_ClampFloat(axis->elapsed_s + axis->cfg.planner_dt_s,
                                         0.0f,
                                         axis->plan.t_total_s);

    StepperSCurve_Evaluate(&axis->plan, axis->elapsed_s, &x_mm, &v_mm_s, &a_mm_s2);
    (void)x_mm;
    (void)a_mm_s2;

    remaining_mm = axis->plan.distance_mm -
                   ((float)axis->emitted_steps * axis->cfg.step_length_mm);

    if (remaining_mm <= (0.5f * axis->cfg.step_length_mm))
    {
        StepperSCurve_Stop(axis);
        return;
    }

    if (axis->elapsed_s >= axis->plan.t_total_s)
    {
        /* 尾段补齐：remaining_steps / dt 等价于在一个规划周期里补完余量。 */
        step_freq_hz = remaining_mm / (axis->cfg.step_length_mm * axis->cfg.planner_dt_s);
        step_freq_hz = Stepper_ClampFloat(step_freq_hz, 100.0f, 5000.0f);
        StepperSCurve_SetPulseFrequency(axis, step_freq_hz);
        return;
    }

    step_freq_hz = v_mm_s / axis->cfg.step_length_mm;
    StepperSCurve_SetPulseFrequency(axis, step_freq_hz);
}

/**
 * @brief 在 STEP 定时器更新事件里累计已发脉冲数。
 * @param axis 步进轴对象。
 *
 * @note 对 STEP / DIR 驱动器而言，一个完整 PWM 周期对应一次有效 STEP 上升沿。
 *       这里假定定时器以更新事件作为“已发出 1 步”的计数时刻。
 */
void StepperSCurve_OnStepPulse(StepperAxis *axis)
{
    if ((axis != NULL) && axis->active && (axis->emitted_steps < axis->plan.target_steps))
    {
        axis->emitted_steps++;
    }
}

void HAL_TIM_PeriodElapsedCallback(TIM_HandleTypeDef *htim)
{
    if (htim->Instance == TIM6)
    {
        StepperSCurve_PlannerTick(&g_stepper_x);
        return;
    }

    if (htim->Instance == g_stepper_x.cfg.step_htim->Instance)
    {
        StepperSCurve_OnStepPulse(&g_stepper_x);
        return;
    }
}
```
