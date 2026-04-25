---
title: "技能档案：FOC 磁场定向控制的核心，从 Clarke / Park 变换到 d/q 电流闭环"
slug: "skill-foc-clarke-park-transform-and-dq-current-loop"
date: 2026-04-25T09:38:36+08:00
draft: false
description: "从三相电流约束、Clarke / Park 坐标变换到 d/q 电流 PI 闭环与母线电压限幅，系统拆解 FOC 如何把旋转磁场变成可调度的数字控制量。"
tags: ["FOC", "STM32", "电机控制", "Clarke变换", "Park变换"]
categories: ["技能档案"]
image: ""
---

## 技能概述

FOC 的价值，从来不只是“让电机转得更丝滑”。它真正解决的是高性能电机控制里最棘手的那道物理鸿沟：逆变器输出的是按 PWM 切碎的三相电压，转子感受到的却是随电角度旋转的磁链与转矩。无人机云台、伺服驱动、关节电机、电动工具和新能源汽车之所以离不开 FOC，是因为它把三相交流系统的耦合关系压缩成 d/q 两个彼此解耦的控制量，让工程师可以像调两个直流量一样分别约束励磁与转矩。真正的痛点不在 `HAL_TIM_PWM_Start()` 能否跑通，而在于你是否理解三相电流为何能降维到二维平面、电角度误差为何会直接变成转矩损失、ADC 采样时刻为何决定闭环是否可信，以及母线电压极限如何把数学解重新拉回功率器件的现实边界。

## 核心底层概念解析

- **三相电流并不是三个独立自由度**：对理想三相电机而言，绕组星形连接且中性点不引出时，总有 `i_a + i_b + i_c = 0`。这意味着三相电流表面上活在 `abc` 三维空间里，实际上只占据一个二维子空间。FOC 的第一步并不是“做变换”，而是承认系统本来就只有两个独立自由度。
- **Clarke 变换不是数学花活，而是把三相约束投影到静止坐标平面**：常见形式可写成 `i_alpha = i_a`，`i_beta = (i_a + 2 i_b) / sqrt(3)`。它的物理意义是把三相绕组电流重新表达为定子静止参考系里的一个电流矢量。只要 `alpha/beta` 坐标稳定，后续控制器面对的就不再是三个彼此错相 120 度的交流量，而是一支在平面里旋转的矢量。
- **Park 变换的本质，是把“看着矢量转”改成“跟着矢量一起转”**：给定电角度 `theta_e` 后，`d/q` 变换等于把静止坐标系绕原点旋转 `theta_e`。公式写成 `i_d = i_alpha cos(theta_e) + i_beta sin(theta_e)`，`i_q = -i_alpha sin(theta_e) + i_beta cos(theta_e)`。一旦参考系跟着转子磁场同步旋转，原本时变的正弦量就被翻译成近似直流量，PI 调节器才有资格稳定工作。
- **d 轴与 q 轴不是两个随便起的字母，而是磁链与转矩的职责分工**：对表贴式 PMSM，通常把 `i_d` 压在 0 A 附近，让永磁体负责励磁；`i_q` 则直接承担转矩输出，近似满足 `T_e = 1.5 * p * psi_f * i_q`。如果电角度对齐错误，原本应该落在 `q` 轴上的转矩电流会泄漏到 `d` 轴，表现出来就是效率下降、发热增加、动态变钝。
- **电角度不是机械角度，极对数和零位偏置都是控制器的“世界观”**：`theta_e = pole_pairs * theta_m + theta_offset`。编码器少一个极对数、霍尔插值错一拍、零位标定偏几度，Park 变换就等于拿错坐标轴，PI 明明在压 `i_d=0`，结果却在真实物理世界里不断注入额外励磁或负转矩。
- **电流采样时刻决定你看到的是绕组电流，还是开关噪声**：逆变器输出并不是连续模拟正弦，而是被高频 PWM 切成离散片段。若 ADC 采样撞在 MOSFET 翻转边沿、死区切换或续流重构阶段，采到的就是开关瞬态、电流尖峰与共模噪声的混合物。FOC 快环要稳定，采样触发必须和中心对齐 PWM、死区时间与运放建立时间一起设计。
- **电流环不是“两个 PI 一贴”这么简单，离散化和饱和边界同样关键**：数字控制器真正执行的是 `integral(k) = integral(k-1) + ki * e(k) * dt`。`dt` 抖动、母线电压跌落、指令突变或积分饱和都会把原本线性的 d/q 闭环推向非线性区域。没有限幅和抗积分饱和，电流环看起来是“有响应”，实际上已经在持续积累不可恢复的相位债务。
- **母线电压不是背景参数，而是电压矢量的天花板**：FOC 算出来的是期望电压矢量，但逆变器最终只能在 `Vdc` 提供的六边形线性调制区里实现它。工程上常用近似上限 `|V_dq| <= m * Vdc / sqrt(3)`，其中 `m < 1` 留给死区、器件压降与建模误差。超出这个边界，再漂亮的 PI 输出也只会被 PWM 饱和剪平。
- **逆 Park 与调制过程，是数字坐标重新回到功率开关世界的最后一跳**：`d/q` 电压先被逆 Park 旋回 `alpha/beta`，再经逆 Clarke 映射成三相桥臂目标电压。这里通常会引入共模偏置，把三相参考同时上移或下移，以便尽可能多地挤进母线线性区。也就是说，调制算法并不是输出层的装饰，而是控制器和功率级之间的最后一个物理翻译器。
- **FOC 的哲学，不是把交流电机“伪装成直流电机”，而是把旋转电磁场变成可审计、可调度的状态量**：一旦三相电流、转子角度、母线电压、采样时刻和 PI 边界都进入同一套模型，你控制的就不再是某个抽象 PWM 占空比，而是在每一个 PWM 周期里主动塑造磁场方向与转矩预算。

## 代码能力展现

下面给出一个基于 STM32 HAL 使用场景的 FOC 电流环示例。代码聚焦于表贴式 PMSM 的经典 `i_d = 0` 控制思路，覆盖两电阻采样下的相电流重构、Clarke / Park 变换、d/q 电流 PI、母线电压矢量限幅、逆 Park 以及带共模注入的三相 PWM 映射。重点不是堆 API，而是把 **采样值 -> 电流矢量 -> d/q 闭环 -> 电压矢量 -> 占空比** 这条链路完整打通。

```c
#include "main.h"
#include <math.h>
#include <stdbool.h>
#include <stdint.h>

#define FOC_SQRT3                         1.73205080757f
#define FOC_INV_SQRT3                     0.57735026919f
#define FOC_HALF_SQRT3                    0.86602540378f
#define FOC_TWO_PI                        6.28318530718f

#define FOC_DT_MIN_S                      0.00002f
#define FOC_DT_MAX_S                      0.00100f
#define FOC_BUS_VOLTAGE_MIN_V             8.0f
#define FOC_BUS_VOLTAGE_MAX_V             60.0f
#define FOC_PHASE_CURRENT_LIMIT_A         40.0f
#define FOC_PWM_DUTY_MIN                  0.02f
#define FOC_PWM_DUTY_MAX                  0.98f

typedef struct
{
    float ia;
    float ib;
    float ic;
} PhaseCurrentABC_t;

typedef struct
{
    float alpha;
    float beta;
} AlphaBeta_t;

typedef struct
{
    float d;
    float q;
} DqFrame_t;

typedef struct
{
    float duty_a;
    float duty_b;
    float duty_c;
} PwmDuty_t;

typedef struct
{
    uint16_t offset_count_a;
    uint16_t offset_count_b;
    uint16_t adc_full_scale;
    float adc_vref_v;
    float shunt_res_ohm;
    float amp_gain;
    float current_limit_a;
} CurrentSenseConfig_t;

typedef struct
{
    float kp;
    float ki;
    float integral;
} PIController_t;

typedef struct
{
    TIM_HandleTypeDef *htim;
    uint32_t channel_u;
    uint32_t channel_v;
    uint32_t channel_w;
    uint32_t period_ticks;
    float duty_min;
    float duty_max;
} PwmBridge_t;

typedef struct
{
    CurrentSenseConfig_t sense;
    PwmBridge_t pwm;
    PIController_t id_pi;
    PIController_t iq_pi;
    float electrical_zero_rad;
    float id_limit_a;
    float iq_limit_a;
    float voltage_utilization;
} FocCurrentLoop_t;

typedef struct
{
    PhaseCurrentABC_t phase_current;
    DqFrame_t current_dq;
    DqFrame_t voltage_dq;
    PwmDuty_t pwm_duty;
} FocSnapshot_t;

static float ClampF32(float value, float min_value, float max_value)
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

static float WrapAngleRad(float angle_rad)
{
    while (angle_rad >= FOC_TWO_PI)
    {
        angle_rad -= FOC_TWO_PI;
    }

    while (angle_rad < 0.0f)
    {
        angle_rad += FOC_TWO_PI;
    }

    return angle_rad;
}

/**
 * @brief 将两路 ADC 原始采样值重构为三相电流。
 * @param config 电流采样链路配置，包含分流电阻、放大倍数与 ADC 满量程参数。
 * @param raw_a A 相采样通道原始 ADC 计数值。
 * @param raw_b B 相采样通道原始 ADC 计数值。
 * @return 重构后的三相电流，单位 A。
 *
 * @note 线性映射公式：
 *       v_adc   = raw / adc_full_scale * adc_vref
 *       v_diff  = (raw - offset_count) / adc_full_scale * adc_vref
 *       i_phase = v_diff / (amp_gain * shunt_res)
 *
 *       两电阻方案下通常直接测得 ia、ib，再由约束 i_a + i_b + i_c = 0
 *       推回第三相：ic = -(ia + ib)。
 */
static PhaseCurrentABC_t CurrentSense_TwoShuntToABC(const CurrentSenseConfig_t *config,
                                                    uint16_t raw_a,
                                                    uint16_t raw_b)
{
    PhaseCurrentABC_t phase = {0.0f, 0.0f, 0.0f};
    const float adc_full_scale = (float)((config->adc_full_scale == 0U) ? 4095U : config->adc_full_scale);
    const float denominator = config->amp_gain * config->shunt_res_ohm;
    const float safe_denominator = (denominator < 1.0e-6f) ? 1.0e-6f : denominator;
    const float current_limit = ClampF32(config->current_limit_a, 1.0f, FOC_PHASE_CURRENT_LIMIT_A);

    phase.ia = ((((float)raw_a - (float)config->offset_count_a) / adc_full_scale) * config->adc_vref_v)
             / safe_denominator;
    phase.ib = ((((float)raw_b - (float)config->offset_count_b) / adc_full_scale) * config->adc_vref_v)
             / safe_denominator;
    phase.ic = -(phase.ia + phase.ib);

    phase.ia = ClampF32(phase.ia, -current_limit, current_limit);
    phase.ib = ClampF32(phase.ib, -current_limit, current_limit);
    phase.ic = ClampF32(phase.ic, -current_limit, current_limit);
    return phase;
}

/**
 * @brief 对三相电流执行 Clarke 变换，投影到定子静止 alpha/beta 平面。
 * @param phase_abc 三相电流。
 * @return alpha/beta 静止坐标系电流。
 *
 * @note 在平衡三相约束 i_a + i_b + i_c = 0 下，可写成：
 *       i_alpha = i_a
 *       i_beta  = (i_a + 2 * i_b) / sqrt(3)
 *
 *       这一步的本质是承认三相系统只剩两个独立自由度，
 *       把 abc 空间中的冗余约束压缩成二维电流矢量。
 */
static AlphaBeta_t FOC_ClarkeTransform(const PhaseCurrentABC_t *phase_abc)
{
    AlphaBeta_t current_ab;

    current_ab.alpha = phase_abc->ia;
    current_ab.beta = (phase_abc->ia + (2.0f * phase_abc->ib)) * FOC_INV_SQRT3;
    return current_ab;
}

/**
 * @brief 将 alpha/beta 静止电流旋转到 d/q 同步坐标系。
 * @param current_ab 定子静止坐标系电流。
 * @param electrical_angle_rad 转子电角度，单位 rad。
 * @return d/q 同步旋转坐标系电流。
 *
 * @note Park 变换公式：
 *       i_d =  i_alpha * cos(theta_e) + i_beta * sin(theta_e)
 *       i_q = -i_alpha * sin(theta_e) + i_beta * cos(theta_e)
 *
 *       d 轴对准转子磁链，q 轴垂直于磁链。
 *       对表贴式 PMSM，常见策略是让 i_d ≈ 0，仅用 i_q 产生转矩。
 */
static DqFrame_t FOC_ParkTransform(const AlphaBeta_t *current_ab, float electrical_angle_rad)
{
    const float theta_e = WrapAngleRad(electrical_angle_rad);
    const float sin_theta = sinf(theta_e);
    const float cos_theta = cosf(theta_e);
    DqFrame_t current_dq;

    current_dq.d = (current_ab->alpha * cos_theta) + (current_ab->beta * sin_theta);
    current_dq.q = (-current_ab->alpha * sin_theta) + (current_ab->beta * cos_theta);
    return current_dq;
}

/**
 * @brief 执行带条件积分的离散 PI 控制器。
 * @param controller PI 控制器对象。
 * @param reference 目标值。
 * @param feedback 反馈值。
 * @param dt_s 控制周期，单位 s。
 * @param out_min 本周期输出下限。
 * @param out_max 本周期输出上限。
 * @return 限幅后的控制输出。
 *
 * @note 离散化公式：
 *       e(k)          = ref(k) - fb(k)
 *       integral(k)   = integral(k-1) + ki * e(k) * dt
 *       output_raw(k) = kp * e(k) + integral(k)
 *
 *       当输出已撞到边界时，仅在误差有助于把输出拉回线性区时继续积分，
 *       以抑制母线饱和导致的积分累积。
 */
static float PIController_Run(PIController_t *controller,
                              float reference,
                              float feedback,
                              float dt_s,
                              float out_min,
                              float out_max)
{
    const float error = reference - feedback;
    const float p_term = controller->kp * error;
    const float integral_candidate = controller->integral + (controller->ki * error * dt_s);
    const float output_raw = p_term + integral_candidate;
    const float output_sat = ClampF32(output_raw, out_min, out_max);

    if (output_raw == output_sat)
    {
        controller->integral = integral_candidate;
    }
    else if (((output_raw > out_max) && (error < 0.0f))
          || ((output_raw < out_min) && (error > 0.0f)))
    {
        controller->integral = integral_candidate;
    }

    return output_sat;
}

/**
 * @brief 将 d/q 电压矢量旋回 alpha/beta 静止坐标系。
 * @param voltage_dq d/q 电压指令。
 * @param electrical_angle_rad 转子电角度，单位 rad。
 * @return alpha/beta 静止坐标系电压。
 *
 * @note 逆 Park 公式：
 *       v_alpha = v_d * cos(theta_e) - v_q * sin(theta_e)
 *       v_beta  = v_d * sin(theta_e) + v_q * cos(theta_e)
 */
static AlphaBeta_t FOC_InverseParkTransform(const DqFrame_t *voltage_dq, float electrical_angle_rad)
{
    const float theta_e = WrapAngleRad(electrical_angle_rad);
    const float sin_theta = sinf(theta_e);
    const float cos_theta = cosf(theta_e);
    AlphaBeta_t voltage_ab;

    voltage_ab.alpha = (voltage_dq->d * cos_theta) - (voltage_dq->q * sin_theta);
    voltage_ab.beta = (voltage_dq->d * sin_theta) + (voltage_dq->q * cos_theta);
    return voltage_ab;
}

/**
 * @brief 将 alpha/beta 电压映射为中心对齐 PWM 占空比。
 * @param voltage_ab alpha/beta 平面电压矢量。
 * @param bus_voltage_v 当前直流母线电压。
 * @param pwm PWM 桥臂配置。
 * @return 三相桥臂占空比。
 *
 * @note 先做逆 Clarke 得到三相桥臂参考电压：
 *       v_a = v_alpha
 *       v_b = -0.5 * v_alpha + sqrt(3)/2 * v_beta
 *       v_c = -0.5 * v_alpha - sqrt(3)/2 * v_beta
 *
 *       再引入共模偏置：
 *       v_offset = -(max(v_a, v_b, v_c) + min(v_a, v_b, v_c)) / 2
 *
 *       最后映射到占空比：
 *       duty_x = 0.5 + (v_x + v_offset) / Vdc
 *
 *       共模注入的作用，是让三相参考尽可能多地留在线性调制区，
 *       避免某一桥臂先触碰 0% 或 100% 饱和。
 */
static PwmDuty_t FOC_AlphaBetaToCenterAlignedDuty(const AlphaBeta_t *voltage_ab,
                                                  float bus_voltage_v,
                                                  const PwmBridge_t *pwm)
{
    const float safe_bus_voltage_v = ClampF32(bus_voltage_v, FOC_BUS_VOLTAGE_MIN_V, FOC_BUS_VOLTAGE_MAX_V);
    const float duty_min = ClampF32(pwm->duty_min, 0.0f, 0.45f);
    const float duty_max = ClampF32(pwm->duty_max, 0.55f, 1.0f);
    const float va = voltage_ab->alpha;
    const float vb = (-0.5f * voltage_ab->alpha) + (FOC_HALF_SQRT3 * voltage_ab->beta);
    const float vc = (-0.5f * voltage_ab->alpha) - (FOC_HALF_SQRT3 * voltage_ab->beta);
    const float v_max = fmaxf(va, fmaxf(vb, vc));
    const float v_min = fminf(va, fminf(vb, vc));
    const float v_offset = -0.5f * (v_max + v_min);
    PwmDuty_t duty;

    duty.duty_a = ClampF32(0.5f + ((va + v_offset) / safe_bus_voltage_v), duty_min, duty_max);
    duty.duty_b = ClampF32(0.5f + ((vb + v_offset) / safe_bus_voltage_v), duty_min, duty_max);
    duty.duty_c = ClampF32(0.5f + ((vc + v_offset) / safe_bus_voltage_v), duty_min, duty_max);
    return duty;
}

/**
 * @brief 将占空比写入定时器 CCR。
 * @param pwm PWM 桥臂配置。
 * @param duty 三相桥臂占空比。
 *
 * @note 中心对齐 PWM 下，CCR 与周期寄存器 ARR 的关系近似为：
 *       compare = duty * period_ticks
 *       这里做了四舍五入，减少低占空比区域的量化误差。
 */
static void FOC_WriteDutyToTimer(const PwmBridge_t *pwm, const PwmDuty_t *duty)
{
    const float period_ticks = (float)((pwm->period_ticks == 0U) ? 1U : pwm->period_ticks);
    const uint32_t ccr_u = (uint32_t)(ClampF32(duty->duty_a, 0.0f, 1.0f) * period_ticks + 0.5f);
    const uint32_t ccr_v = (uint32_t)(ClampF32(duty->duty_b, 0.0f, 1.0f) * period_ticks + 0.5f);
    const uint32_t ccr_w = (uint32_t)(ClampF32(duty->duty_c, 0.0f, 1.0f) * period_ticks + 0.5f);

    __HAL_TIM_SET_COMPARE(pwm->htim, pwm->channel_u, ccr_u);
    __HAL_TIM_SET_COMPARE(pwm->htim, pwm->channel_v, ccr_v);
    __HAL_TIM_SET_COMPARE(pwm->htim, pwm->channel_w, ccr_w);
}

/**
 * @brief 执行一次 FOC 快速电流环更新。
 * @param loop FOC 电流环对象。
 * @param raw_phase_a A 相 ADC 原始采样值。
 * @param raw_phase_b B 相 ADC 原始采样值。
 * @param electrical_angle_rad 转子电角度，必须已包含极对数映射。
 * @param id_ref_a d 轴参考电流，表贴式 PMSM 常设为 0 A。
 * @param iq_ref_a q 轴参考电流，正负决定电磁转矩方向。
 * @param bus_voltage_v 当前直流母线电压。
 * @param dt_s 本次电流环周期。
 * @param out_snapshot 可选输出快照，便于上层调试。
 * @retval true 更新成功。
 * @retval false 参数非法或母线电压过低。
 *
 * @note 关键工程约束：
 *       1. 电角度必须满足 theta_e = pole_pairs * theta_m + theta_offset。
 *       2. 线性调制区近似满足 |V_dq| <= m * Vdc / sqrt(3)，其中 m < 1。
 *       3. ADC 采样应尽量放在 PWM 中点附近，否则 dq 电流反馈会被开关噪声污染。
 */
bool FOC_CurrentLoopStep(FocCurrentLoop_t *loop,
                         uint16_t raw_phase_a,
                         uint16_t raw_phase_b,
                         float electrical_angle_rad,
                         float id_ref_a,
                         float iq_ref_a,
                         float bus_voltage_v,
                         float dt_s,
                         FocSnapshot_t *out_snapshot)
{
    const float safe_dt_s = ClampF32(dt_s, FOC_DT_MIN_S, FOC_DT_MAX_S);
    const float safe_bus_voltage_v = ClampF32(bus_voltage_v, FOC_BUS_VOLTAGE_MIN_V, FOC_BUS_VOLTAGE_MAX_V);
    const float voltage_utilization = ClampF32(loop->voltage_utilization, 0.70f, 0.98f);
    const float vector_limit_v = voltage_utilization * safe_bus_voltage_v * FOC_INV_SQRT3;
    const float theta_e = WrapAngleRad(electrical_angle_rad + loop->electrical_zero_rad);
    PhaseCurrentABC_t phase_current;
    AlphaBeta_t current_ab;
    DqFrame_t current_dq;
    DqFrame_t voltage_dq = {0.0f, 0.0f};
    AlphaBeta_t voltage_ab;
    PwmDuty_t pwm_duty;
    float vq_limit_v;

    if ((loop == NULL) || (loop->pwm.htim == NULL) || (loop->pwm.period_ticks == 0U))
    {
        return false;
    }

    if (bus_voltage_v < FOC_BUS_VOLTAGE_MIN_V)
    {
        /* 母线电压过低时继续推占空比没有意义，反而会把积分项推向饱和。 */
        return false;
    }

    phase_current = CurrentSense_TwoShuntToABC(&loop->sense, raw_phase_a, raw_phase_b);
    current_ab = FOC_ClarkeTransform(&phase_current);
    current_dq = FOC_ParkTransform(&current_ab, theta_e);

    id_ref_a = ClampF32(id_ref_a, -loop->id_limit_a, loop->id_limit_a);
    iq_ref_a = ClampF32(iq_ref_a, -loop->iq_limit_a, loop->iq_limit_a);

    /* d 轴先闭环，先抢占一部分电压预算；q 轴只能在剩余矢量半径内工作。 */
    voltage_dq.d = PIController_Run(&loop->id_pi,
                                    id_ref_a,
                                    current_dq.d,
                                    safe_dt_s,
                                    -vector_limit_v,
                                    vector_limit_v);

    vq_limit_v = sqrtf(fmaxf((vector_limit_v * vector_limit_v) - (voltage_dq.d * voltage_dq.d), 0.0f));
    voltage_dq.q = PIController_Run(&loop->iq_pi,
                                    iq_ref_a,
                                    current_dq.q,
                                    safe_dt_s,
                                    -vq_limit_v,
                                    vq_limit_v);

    voltage_ab = FOC_InverseParkTransform(&voltage_dq, theta_e);
    pwm_duty = FOC_AlphaBetaToCenterAlignedDuty(&voltage_ab, safe_bus_voltage_v, &loop->pwm);
    FOC_WriteDutyToTimer(&loop->pwm, &pwm_duty);

    if (out_snapshot != NULL)
    {
        out_snapshot->phase_current = phase_current;
        out_snapshot->current_dq = current_dq;
        out_snapshot->voltage_dq = voltage_dq;
        out_snapshot->pwm_duty = pwm_duty;
    }

    return true;
}

extern TIM_HandleTypeDef htim1;

static FocCurrentLoop_t g_foc_current_loop =
{
    .sense =
    {
        .offset_count_a = 2048U,
        .offset_count_b = 2048U,
        .adc_full_scale = 4095U,
        .adc_vref_v = 3.3f,
        .shunt_res_ohm = 0.005f,
        .amp_gain = 20.0f,
        .current_limit_a = 35.0f
    },
    .pwm =
    {
        .htim = &htim1,
        .channel_u = TIM_CHANNEL_1,
        .channel_v = TIM_CHANNEL_2,
        .channel_w = TIM_CHANNEL_3,
        .period_ticks = 3600U,
        .duty_min = FOC_PWM_DUTY_MIN,
        .duty_max = FOC_PWM_DUTY_MAX
    },
    .id_pi = {.kp = 2.4f, .ki = 320.0f, .integral = 0.0f},
    .iq_pi = {.kp = 2.0f, .ki = 280.0f, .integral = 0.0f},
    .electrical_zero_rad = 0.12f,
    .id_limit_a = 8.0f,
    .iq_limit_a = 25.0f,
    .voltage_utilization = 0.95f
};

void App_FocFastLoop_20kHz(uint16_t adc_ia,
                           uint16_t adc_ib,
                           float encoder_electrical_angle_rad,
                           float iq_command_a,
                           float bus_voltage_v)
{
    FocSnapshot_t snapshot;

    /* 典型表贴式 PMSM 场景下，让 d 轴电流维持在 0A，
     * 把全部动态响应资源交给 q 轴转矩电流。
     */
    (void)FOC_CurrentLoopStep(&g_foc_current_loop,
                              adc_ia,
                              adc_ib,
                              encoder_electrical_angle_rad,
                              0.0f,
                              ClampF32(iq_command_a, -20.0f, 20.0f),
                              bus_voltage_v,
                              0.00005f,
                              &snapshot);

    /* snapshot 可接到串口示波、SWV 或上位机，观察：
     * 1. i_d 是否收敛到 0A；
     * 2. i_q 是否跟随转矩指令；
     * 3. 电压矢量是否长期贴住 vector_limit_v，若是则说明已进入电压饱和区。
     */
    (void)snapshot;
}
```

这段实现真正想表达的，不是“FOC 模板代码应该怎么抄”，而是一个更底层的事实：**电机控制的每一步，本质上都在做坐标系与物理边界之间的映射**。三相电流通过 Clarke 变换被压进二维平面，旋转磁场通过 Park 变换被翻译成近似直流量，PI 输出再被逆变换和 PWM 调制重新送回功率级。只要其中任何一层的前提被破坏，比如电角度偏移、采样时序错误、母线电压估计失真或积分饱和失控，最终体现出来的都不是“代码小问题”，而是磁场方向、转矩输出和热损耗一起偏离预期。理解了这一点，FOC 才不再是一个高级名词，而是一整套把旋转电磁场驯化为数字闭环的工程方法。
