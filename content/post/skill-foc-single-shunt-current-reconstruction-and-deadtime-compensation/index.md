---
title: "技能档案：FOC 低速区的硬仗，从单电阻采样窗口到死区补偿"
slug: "skill-foc-single-shunt-current-reconstruction-and-deadtime-compensation"
date: 2026-05-12T09:58:08+08:00
draft: false
description: "从母线单电阻采样、PWM 有效窗口、死区电压误差到三相电流重构，系统拆解 FOC 为什么首先是一份时域预算与误差闭环合同。"
tags: ["FOC", "STM32", "电机控制", "ADC", "PWM", "嵌入式"]
categories: ["技能档案", "电机控制", "控制与融合"]
image: ""
---

## 技能概述

FOC 在论文里最迷人的部分，是 Clarke 与 Park 变换把三相交流系统压缩成 d/q 两个正交量；但在真实控制板上，系统最容易翻车的地方反而是更“土”的那一层：低速区母线电流太小、PWM 有效采样窗口太窄、死区电压把小矢量吃掉，最后导致电流环看见的不是电机真实状态，而是被开关时序污染过的离散残影。单电阻采样方案之所以常见，是因为它便宜、紧凑、功耗低；它之所以难，是因为它把“测量”这件事强行塞进了开关周期里最拥挤的几个微秒。工程上的核心痛点，不是把 SVPWM 跑起来，而是让采样、重构、补偿与限幅在低速弱信号区仍然维持一份可验证的时域合同。

## 核心底层概念解析

- **单电阻采样测到的不是相电流，而是直流母线在某个开关状态下的瞬时回流**：只有当某一组桥臂导通拓扑成立时，母线分流电阻上的电流才与某个相电流或两相电流线性相关。因此“ADC 采样值”并不天然等于 `i_a`、`i_b` 或 `i_c`，它只是一个需要结合扇区和开关矢量去解释的投影。
- **采样窗口是 PWM 里的时间缝，不是随便挑一个中断点**：以中心对齐 SVPWM 为例，只有在有效矢量持续时间足够长时，才存在可用采样窗。这个条件可近似写成 `T_sample_valid = T_vec - T_dead - T_settle - T_aperture`。如果 `T_sample_valid <= 0`，那一拍电流就不是“噪声变大”，而是从物理上失去可观测性。
- **低速区最难，不是因为转得慢，而是因为有效矢量太短**：当给定电压矢量幅值很小，`T1`、`T2` 都会缩短，零矢量时间 `T0` 变长。此时电机本身很安静，但 ADC 反而更难测，因为导通片段不够长，采样保持电容还没稳定，运放还在恢复，死区已经把本来就很小的电流信息进一步吞掉。
- **死区误差本质上是等效输出电压误差，而不是“波形稍微难看一点”**：上下桥臂为了防止直通，会人为插入 `T_dead`。对于某一相，死区造成的平均电压偏差近似满足 `Delta_V_phase ≈ sign(i_phase) * V_dc * T_dead / T_pwm`。注意这个误差和电流方向相关，而不是和电压指令方向相关，所以它会在过零附近把电流环搞得最狼狈。
- **单电阻重构依赖 KCL，而 KCL 的前提是采样值可信**：三相电流满足 `i_a + i_b + i_c = 0`，于是只要测到两个独立电流，就能还原第三个。但如果两个采样点之一落在无效窗口、开关毛刺期或运放饱和恢复期，那么后面的 Clarke/Park 只是把错误更优雅地变换进 d/q 坐标系。
- **SVPWM 的扇区不是数学装饰，而是采样解释器**：同样一个母线电流，在扇区 1 和扇区 5 下对应的导通路径完全不同。单电阻方案必须把“当前扇区 + 当前采样落在哪个有效矢量”一起纳入重构，否则采样值没有语义。
- **ADC 前端稳定时间是一条硬边界**：分流电阻、放大器带宽、RC 滤波和 ADC 采样保持电容共同决定建立时间。若放大器闭环带宽不足，或者 RC 过大，采样值会向前一状态拖尾。这个误差不是随机噪声，更像受限带宽系统的卷积残影。
- **低速补偿首先是可观测性补偿，然后才是控制性能补偿**：很多系统一到低速就谈“加一点前馈”或“提一点 PI 增益”，但如果电流测量本身已经失真，再激进的控制律也只是在追一张错误的地图。工程上更有效的顺序通常是：先修采样窗口，再做死区补偿，最后再碰电流环参数。
- **无法重构的周期不该硬算，而该优雅退化**：当 `T1` 或 `T2` 小到窗口失效时，正确做法往往不是“继续算”，而是保持上一拍可信电流、降额电压指令、或切换到两相近似估计。闭环系统最怕的是带着伪精度继续自信输出。
- **FOC 的哲学从来不只是坐标变换，而是把不可直接观测的能量流转成可调度、可采样、可闭环的离散对象**：数学变换解决的是表达空间；单电阻采样、PWM 对齐、死区补偿解决的，是表达能否站住物理地面。

## 代码能力展现

下面给出一个基于 STM32 HAL 的单电阻 FOC 低速采样示例。代码重点不在完整实现一套电流环，而在于四件事：其一，依据 `T1/T2/T0` 预算可用采样窗；其二，在不同扇区下把母线电流重构为两相电流；其三，对死区引入的等效电压误差做符号相关补偿；其四，当窗口失效时做受控退化，而不是输出伪精度结果。

```c
#include "main.h"
#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#define FOC_SQRT3                              1.73205080757f
#define FOC_INV_SQRT3                          0.57735026919f
#define FOC_HALF                               0.5f

#define FOC_MIN_SAMPLE_WINDOW_NS               700U
#define FOC_ADC_APERTURE_NS                    120U
#define FOC_CURRENT_SETTLE_NS                  220U
#define FOC_RECONSTRUCT_HOLD_LIMIT             4U

#define FOC_DUTY_MIN                           0.02f
#define FOC_DUTY_MAX                           0.98f

typedef struct
{
    float alpha;
    float beta;
} FocAlphaBeta_t;

typedef struct
{
    float a;
    float b;
    float c;
} FocPhaseCurrent_t;

typedef struct
{
    uint8_t sector;
    float duty_a;
    float duty_b;
    float duty_c;
    uint32_t t1_ns;
    uint32_t t2_ns;
    uint32_t t0_ns;
} FocSvpwmPlan_t;

typedef struct
{
    uint32_t sample1_tick;
    uint32_t sample2_tick;
    bool sample1_valid;
    bool sample2_valid;
} FocSamplePlan_t;

typedef struct
{
    TIM_HandleTypeDef *htim_pwm;
    ADC_HandleTypeDef *hadc;
    uint32_t tim_clk_hz;
    uint32_t pwm_period_tick;
    float vbus;
    float shunt_resistor_ohm;
    float amplifier_gain;
    uint32_t deadtime_ns;
    uint32_t adc_trigger_latency_ns;
    FocPhaseCurrent_t last_valid_phase_current;
    uint8_t invalid_reconstruct_count;
} FocSingleShunt_t;

static float Foc_ClampF(float value, float min_value, float max_value)
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

static uint32_t Foc_MaxU32(uint32_t a, uint32_t b)
{
    return (a > b) ? a : b;
}

static uint32_t Foc_MinU32(uint32_t a, uint32_t b)
{
    return (a < b) ? a : b;
}

static uint32_t Foc_TimeNsToTick(uint32_t time_ns, uint32_t tim_clk_hz)
{
    return (uint32_t)(((uint64_t)time_ns * (uint64_t)tim_clk_hz) / 1000000000ULL);
}

static float Foc_SignNonZero(float value)
{
    return (value >= 0.0f) ? 1.0f : -1.0f;
}

/**
 * @brief 将 ADC 原始码值映射为母线分流电流。
 * @param raw_adc ADC 原始码值。
 * @param vref 电流采样前端参考电压。
 * @param offset_adc 零电流偏置码值。
 * @param foc FOC 单电阻对象。
 * @retval 以安培为单位的母线电流。
 *
 * @note 线性映射关系如下：
 *       V_shunt_amp = (raw_adc - offset_adc) / ADC_FS * vref
 *       I_bus = V_shunt_amp / (R_shunt * Gain)
 */
static float Foc_MapAdcToBusCurrent(uint16_t raw_adc,
                                    float vref,
                                    uint16_t offset_adc,
                                    const FocSingleShunt_t *foc)
{
    const float adc_full_scale = 4095.0f;
    const float v_amp =
        ((float)((int32_t)raw_adc - (int32_t)offset_adc) * vref) / adc_full_scale;

    return v_amp / (foc->shunt_resistor_ohm * foc->amplifier_gain);
}

/**
 * @brief 对单相电压指令做死区补偿。
 * @param v_cmd 原始相电压指令。
 * @param i_phase 当前估计相电流。
 * @param vbus 母线电压。
 * @param deadtime_ns 死区时间。
 * @param pwm_period_ns PWM 周期。
 * @retval 补偿后的相电压指令。
 *
 * @note 死区导致的平均相电压误差可近似写成：
 *       Delta_V_phase ≈ sign(i_phase) * Vdc * T_dead / T_pwm
 *
 *       因此补偿时采用反号注入：
 *       V_cmd_comp = V_cmd - Delta_V_phase
 */
static float Foc_CompensateDeadtime(float v_cmd,
                                    float i_phase,
                                    float vbus,
                                    uint32_t deadtime_ns,
                                    uint32_t pwm_period_ns)
{
    const float delta_v =
        Foc_SignNonZero(i_phase) * vbus * ((float)deadtime_ns / (float)pwm_period_ns);

    return v_cmd - delta_v;
}

/**
 * @brief 将 alpha/beta 电压映射为中心对齐 SVPWM 三相占空比与时序。
 * @param v_ab alpha/beta 电压指令。
 * @param vbus 母线电压。
 * @param pwm_period_ns PWM 周期。
 * @param out_plan 输出的 SVPWM 计划。
 * @retval true 表示扇区识别成功。
 *
 * @note 这里使用常见的零序注入法得到三相占空比，并进一步推导矢量时长。
 *       设归一化相电压为：
 *       u_a = v_alpha / Vdc
 *       u_b = (-0.5 * v_alpha + sqrt(3)/2 * v_beta) / Vdc
 *       u_c = (-0.5 * v_alpha - sqrt(3)/2 * v_beta) / Vdc
 *
 *       零序注入后：
 *       duty_x = 0.5 + u_x - (u_max + u_min) / 2
 *
 *       再根据排序得到扇区与邻接有效矢量时间。
 */
static bool Foc_BuildSvpwmPlan(const FocAlphaBeta_t *v_ab,
                               float vbus,
                               uint32_t pwm_period_ns,
                               FocSvpwmPlan_t *out_plan)
{
    float ua;
    float ub;
    float uc;
    float umax;
    float umin;
    float duty_a;
    float duty_b;
    float duty_c;
    float dmax;
    float dmid;
    float dmin;
    uint8_t sector;

    if ((v_ab == NULL) || (out_plan == NULL) || (vbus <= 0.0f))
    {
        return false;
    }

    ua = v_ab->alpha / vbus;
    ub = (-FOC_HALF * v_ab->alpha + 0.8660254f * v_ab->beta) / vbus;
    uc = (-FOC_HALF * v_ab->alpha - 0.8660254f * v_ab->beta) / vbus;

    umax = fmaxf(ua, fmaxf(ub, uc));
    umin = fminf(ua, fminf(ub, uc));

    duty_a = Foc_ClampF(0.5f + ua - 0.5f * (umax + umin), FOC_DUTY_MIN, FOC_DUTY_MAX);
    duty_b = Foc_ClampF(0.5f + ub - 0.5f * (umax + umin), FOC_DUTY_MIN, FOC_DUTY_MAX);
    duty_c = Foc_ClampF(0.5f + uc - 0.5f * (umax + umin), FOC_DUTY_MIN, FOC_DUTY_MAX);

    dmax = fmaxf(duty_a, fmaxf(duty_b, duty_c));
    dmin = fminf(duty_a, fminf(duty_b, duty_c));
    dmid = duty_a + duty_b + duty_c - dmax - dmin;

    /*
     * 通过三相占空比排序映射扇区。
     * 中心对齐下，邻接有效矢量时间可由占空比分差换算：
     * T1 + T2 = (dmax - dmin) * T_pwm
     * 进一步将：
     * T1 = (dmid - dmin) * T_pwm
     * T2 = (dmax - dmid) * T_pwm
     */
    if ((duty_a >= duty_b) && (duty_b >= duty_c))
    {
        sector = 1U;
    }
    else if ((duty_b >= duty_a) && (duty_a >= duty_c))
    {
        sector = 2U;
    }
    else if ((duty_b >= duty_c) && (duty_c >= duty_a))
    {
        sector = 3U;
    }
    else if ((duty_c >= duty_b) && (duty_b >= duty_a))
    {
        sector = 4U;
    }
    else if ((duty_c >= duty_a) && (duty_a >= duty_b))
    {
        sector = 5U;
    }
    else
    {
        sector = 6U;
    }

    out_plan->sector = sector;
    out_plan->duty_a = duty_a;
    out_plan->duty_b = duty_b;
    out_plan->duty_c = duty_c;
    out_plan->t1_ns = (uint32_t)((dmid - dmin) * (float)pwm_period_ns);
    out_plan->t2_ns = (uint32_t)((dmax - dmid) * (float)pwm_period_ns);
    out_plan->t0_ns = pwm_period_ns - out_plan->t1_ns - out_plan->t2_ns;

    return true;
}

/**
 * @brief 为单电阻方案规划两个注入式 ADC 采样点。
 * @param foc FOC 单电阻对象。
 * @param plan 当前 PWM 计划。
 * @param out_sample 输出的采样计划。
 * @retval true 表示至少存在一个有效窗口。
 *
 * @note 有效采样窗口近似写成：
 *       T_valid = T_vec - T_dead - T_settle - T_aperture - T_trigger_latency
 *
 *       当 T_valid <= 0 时，说明该有效矢量内部没有足够的时间完成：
 *       1. 桥臂换相后的电流稳定；
 *       2. 运放恢复；
 *       3. ADC 建立与采样保持。
 */
static bool Foc_BuildSamplePlan(const FocSingleShunt_t *foc,
                                const FocSvpwmPlan_t *plan,
                                FocSamplePlan_t *out_sample)
{
    const uint32_t t_margin_ns =
        foc->deadtime_ns + foc->adc_trigger_latency_ns + FOC_CURRENT_SETTLE_NS + FOC_ADC_APERTURE_NS;
    const uint32_t t_valid_1 = (plan->t1_ns > t_margin_ns) ? (plan->t1_ns - t_margin_ns) : 0U;
    const uint32_t t_valid_2 = (plan->t2_ns > t_margin_ns) ? (plan->t2_ns - t_margin_ns) : 0U;
    const uint32_t half_period_tick = foc->pwm_period_tick / 2U;

    memset(out_sample, 0, sizeof(*out_sample));

    out_sample->sample1_valid = (t_valid_1 >= FOC_MIN_SAMPLE_WINDOW_NS);
    out_sample->sample2_valid = (t_valid_2 >= FOC_MIN_SAMPLE_WINDOW_NS);

    /*
     * 对于中心对齐 PWM，这里把两个采样点布在上半周两个有效矢量中心附近。
     * 简化起见，用 ns -> tick 的线性换算：
     * tick = time_ns * f_tim / 1e9
     */
    if (out_sample->sample1_valid)
    {
        out_sample->sample1_tick = Foc_MinU32(Foc_MaxU32(1U, Foc_TimeNsToTick(plan->t1_ns / 2U, foc->tim_clk_hz)),
                                              foc->pwm_period_tick - 1U);
    }

    if (out_sample->sample2_valid)
    {
        out_sample->sample2_tick = Foc_MinU32(half_period_tick +
                                              Foc_MaxU32(1U, Foc_TimeNsToTick(plan->t2_ns / 2U, foc->tim_clk_hz)),
                                              foc->pwm_period_tick - 1U);
    }

    return out_sample->sample1_valid || out_sample->sample2_valid;
}

/**
 * @brief 根据扇区和两次母线采样值重构三相电流。
 * @param sector 当前 SVPWM 扇区。
 * @param ibus1 第一采样点的母线电流。
 * @param ibus2 第二采样点的母线电流。
 * @param out_phase 输出三相电流。
 * @retval true 表示重构成功。
 *
 * @note 不同扇区下，母线电流对应关系不同。以下给出常见的一组映射：
 *       Sector 1: ibus1 = -i_c, ibus2 = i_a
 *       Sector 2: ibus1 = i_b,  ibus2 = -i_c
 *       Sector 3: ibus1 = -i_a, ibus2 = i_b
 *       Sector 4: ibus1 = i_c,  ibus2 = -i_a
 *       Sector 5: ibus1 = -i_b, ibus2 = i_c
 *       Sector 6: ibus1 = i_a,  ibus2 = -i_b
 *
 *       再利用 KCL：
 *       i_a + i_b + i_c = 0
 */
static bool Foc_ReconstructPhaseCurrent(uint8_t sector,
                                        float ibus1,
                                        float ibus2,
                                        FocPhaseCurrent_t *out_phase)
{
    if (out_phase == NULL)
    {
        return false;
    }

    switch (sector)
    {
        case 1U:
            out_phase->c = -ibus1;
            out_phase->a = ibus2;
            out_phase->b = -out_phase->a - out_phase->c;
            break;

        case 2U:
            out_phase->b = ibus1;
            out_phase->c = -ibus2;
            out_phase->a = -out_phase->b - out_phase->c;
            break;

        case 3U:
            out_phase->a = -ibus1;
            out_phase->b = ibus2;
            out_phase->c = -out_phase->a - out_phase->b;
            break;

        case 4U:
            out_phase->c = ibus1;
            out_phase->a = -ibus2;
            out_phase->b = -out_phase->a - out_phase->c;
            break;

        case 5U:
            out_phase->b = -ibus1;
            out_phase->c = ibus2;
            out_phase->a = -out_phase->b - out_phase->c;
            break;

        case 6U:
            out_phase->a = ibus1;
            out_phase->b = -ibus2;
            out_phase->c = -out_phase->a - out_phase->b;
            break;

        default:
            return false;
    }

    return true;
}

/**
 * @brief 将三相电流变换到 alpha/beta 坐标。
 * @param phase 三相电流。
 * @retval alpha/beta 电流。
 *
 * @note Clarke 变换常用形式：
 *       i_alpha = i_a
 *       i_beta  = (i_a + 2 * i_b) / sqrt(3)
 */
static FocAlphaBeta_t Foc_ClarkeTransform(const FocPhaseCurrent_t *phase)
{
    FocAlphaBeta_t out;

    out.alpha = phase->a;
    out.beta = (phase->a + 2.0f * phase->b) * FOC_INV_SQRT3;

    return out;
}

/**
 * @brief 更新单电阻 FOC 的 PWM、ADC 采样点与电流重构结果。
 * @param foc FOC 单电阻对象。
 * @param v_cmd_alpha 原始 alpha 轴电压指令。
 * @param v_cmd_beta 原始 beta 轴电压指令。
 * @param current_offset_adc 电流采样零偏。
 * @param adc_raw1 第一次采样 ADC 原始值。
 * @param adc_raw2 第二次采样 ADC 原始值。
 * @param out_iab 输出 alpha/beta 电流。
 * @retval true 表示本周期获得了可信电流。
 *
 * @note 当采样窗口不足时，函数不会硬做错误重构，而是：
 *       1. 暂时保持上一拍可信三相电流；
 *       2. 统计连续失效次数；
 *       3. 由上层决定是否进一步降额或切换观测模式。
 */
bool FocSingleShunt_Update(FocSingleShunt_t *foc,
                           float v_cmd_alpha,
                           float v_cmd_beta,
                           uint16_t current_offset_adc,
                           uint16_t adc_raw1,
                           uint16_t adc_raw2,
                           FocAlphaBeta_t *out_iab)
{
    const uint32_t pwm_period_ns = (uint32_t)(((uint64_t)foc->pwm_period_tick * 1000000000ULL) /
                                              foc->tim_clk_hz);
    FocAlphaBeta_t v_cmd;
    FocSvpwmPlan_t pwm_plan;
    FocSamplePlan_t sample_plan;
    FocPhaseCurrent_t phase_current;
    bool reconstructed = false;

    if ((foc == NULL) || (out_iab == NULL) || (foc->vbus <= 0.0f))
    {
        return false;
    }

    /*
     * 使用上一拍可信电流做死区补偿，这比“按命令符号补偿”更接近真实电流方向。
     */
    v_cmd.alpha = v_cmd_alpha;
    v_cmd.beta = v_cmd_beta;

    {
        const float va = v_cmd.alpha;
        const float vb = -FOC_HALF * v_cmd.alpha + 0.8660254f * v_cmd.beta;
        const float vc = -FOC_HALF * v_cmd.alpha - 0.8660254f * v_cmd.beta;
        const float va_comp = Foc_CompensateDeadtime(va,
                                                     foc->last_valid_phase_current.a,
                                                     foc->vbus,
                                                     foc->deadtime_ns,
                                                     pwm_period_ns);
        const float vb_comp = Foc_CompensateDeadtime(vb,
                                                     foc->last_valid_phase_current.b,
                                                     foc->vbus,
                                                     foc->deadtime_ns,
                                                     pwm_period_ns);
        const float vc_comp = Foc_CompensateDeadtime(vc,
                                                     foc->last_valid_phase_current.c,
                                                     foc->vbus,
                                                     foc->deadtime_ns,
                                                     pwm_period_ns);

        /*
         * 逆回 alpha/beta：
         * alpha = va
         * beta  = (vb - vc) / sqrt(3)
         */
        v_cmd.alpha = va_comp;
        v_cmd.beta = (vb_comp - vc_comp) * FOC_INV_SQRT3;
    }

    if (!Foc_BuildSvpwmPlan(&v_cmd, foc->vbus, pwm_period_ns, &pwm_plan))
    {
        return false;
    }

    (void)Foc_BuildSamplePlan(foc, &pwm_plan, &sample_plan);

    /*
     * 将三相占空比映射到定时器 CCR。
     * compare = duty * ARR
     */
    __HAL_TIM_SET_COMPARE(foc->htim_pwm, TIM_CHANNEL_1,
                          (uint32_t)(pwm_plan.duty_a * (float)foc->pwm_period_tick));
    __HAL_TIM_SET_COMPARE(foc->htim_pwm, TIM_CHANNEL_2,
                          (uint32_t)(pwm_plan.duty_b * (float)foc->pwm_period_tick));
    __HAL_TIM_SET_COMPARE(foc->htim_pwm, TIM_CHANNEL_3,
                          (uint32_t)(pwm_plan.duty_c * (float)foc->pwm_period_tick));

    if (sample_plan.sample1_valid && sample_plan.sample2_valid)
    {
        const float ibus1 = Foc_MapAdcToBusCurrent(adc_raw1, 3.3f, current_offset_adc, foc);
        const float ibus2 = Foc_MapAdcToBusCurrent(adc_raw2, 3.3f, current_offset_adc, foc);

        reconstructed = Foc_ReconstructPhaseCurrent(pwm_plan.sector, ibus1, ibus2, &phase_current);
    }

    if (reconstructed)
    {
        foc->last_valid_phase_current = phase_current;
        foc->invalid_reconstruct_count = 0U;
    }
    else
    {
        phase_current = foc->last_valid_phase_current;
        foc->invalid_reconstruct_count =
            Foc_MinU32(foc->invalid_reconstruct_count + 1U, FOC_RECONSTRUCT_HOLD_LIMIT);
    }

    /*
     * 连续窗口失效时，上层可据 invalid_reconstruct_count 触发降额。
     * 这里先输出上一拍可信值，保证闭环不会因单拍失观测而瞬间炸开。
     */
    *out_iab = Foc_ClarkeTransform(&phase_current);

    return reconstructed;
}
```

这段实现真正想强调的，不是“单电阻 FOC 也能跑”，而是**单电阻 FOC 只有在时间预算、重构条件和误差补偿都被显式建模时，才算真正可控**。低速区的问题，从来不只是 PI 参数不对，而是测量窗口、死区、电流方向和 ADC 前端恢复一起挤压了可观测性。把这些底层约束处理干净，Clarke/Park 才不是悬空的数学优雅，而是能够落在铜线、电流和转矩上的工程闭环。
