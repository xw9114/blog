---
title: "技能档案：FOC 的电角度时间戳对齐、采样执行延迟与 Park 相位前馈补偿"
slug: "skill-foc-electrical-angle-timestamp-alignment-sampling-execution-delay-and-park-phase-lead"
date: 2026-07-04T09:15:22+08:00
draft: false
description: "从 ADC 电流采样时刻、编码器角度快照、控制计算尾延迟到电角速度前馈预测，系统拆解 FOC 为什么常死在时间对齐而不是 PI 参数。"
tags: ["FOC", "STM32", "PMSM", "Park 变换", "时间对齐", "相位前馈", "电机控制"]
categories: ["技能档案"]
image: ""
---

## 技能概述

很多人把 `FOC` 的主要难点放在 `PI` 参数、`Clarke/Park` 公式或者 `SVPWM` 调制本身，但当电机转速上来、载波频率固定、编码器分辨率有限、ADC 采样又被钉死在 `PWM` 静默窗里时，真正杀伤系统稳定性的往往不是控制律写错，而是**同一份电流样本、同一份转子角度和同一组桥臂占空比并不属于同一个电角时刻**。这个主题解决的核心痛点，是把 `FOC` 重新看成一份旋转坐标系里的时间合同：电流在什么时候被采，角度在什么时候被快照，电压在什么时候真正作用到绕组，若这些事件没有被映射到同一个 `theta_e(t)` 上，再漂亮的 `dq` 电流环也会被时延折算成额外的 d 轴扰动、q 轴力矩塌缩和高频啸叫。

## 核心底层概念解析

- **FOC 不是只做坐标变换，而是在旋转坐标系里做时间对账**：`Park` 变换默认 `i_alpha/beta` 与 `theta_e` 属于同一瞬间，逆 `Park` 又默认 `v_d/q` 会立即在该角度下兑现。真实系统里，这两个默认条件通常同时失效。

- **真正要预算的不是 ISR 执行了几微秒，而是从“采到电流”到“电压真正上桥”的总延迟**：常见近似可写成  
  `Tdelay = Tsample_to_latch + Tzoh + Nmiss * Tcarrier`。  
  其中 `Tsample_to_latch` 是从 ADC 有效采样中点到 PWM 预装载寄存器生效的时间，`Tzoh` 是零阶保持等效延迟，`Nmiss` 表示本拍是否因为算慢了而错过更新事件。只要错过一次，补偿量就会突然多出整整一个载波周期。

- **电角度误差首先是一条时间映射，而不是一个调参感觉**：若采样时刻的电角速度为 `omega_e`，电角加速度为 `alpha_e`，则执行时刻与采样时刻的相位差近似满足  
  `Delta_theta_e = omega_e * Tdelay + 0.5 * alpha_e * Tdelay^2`。  
  高速弱磁区之所以比低速区更容易炸，不是因为 `PI` 忽然变差，而是同样的 `Tdelay` 会被 `omega_e` 放大成更大的相位偏差。

- **过时的 Park 角度会把 q 轴电流漏到 d 轴里**：若真实电流在正确电角度下应为 `[id, iq]^T`，但软件使用了滞后的角度，测得的分量相当于被额外旋转了 `Delta_theta_e`。当目标是 `id = 0` 时，有  
  `id_meas ~= iq * sin(Delta_theta_e)`，  
  `iq_meas ~= iq * cos(Delta_theta_e)`。  
  也就是说，时间没对齐时，控制器会误以为自己产生了磁链误差，并开始多余地补 d 轴。

- **电压矢量同样会因为旧角度而旋错方向**：若电流环算出 `vd_ref = 0`、`vq_ref > 0`，但逆 `Park` 时仍使用采样时刻的旧角度，则真正施加到当前转子坐标系里的电压会近似变成  
  `vd_real ~= -vq_ref * sin(Delta_theta_e)`，  
  `vq_real ~=  vq_ref * cos(Delta_theta_e)`。  
  这会直接体现为扭矩常数下降、铜耗上升和高转速区的“明明电流给够了却推不动”。

- **编码器角度“读得出来”不代表“读得共时”**：若电流采样发生在 `PWM` 中点，而编码器计数在主循环里晚了几十微秒才被读取，那么这份角度已经不再属于当前电流样本。真正稳妥的做法，是在 ADC 采样完成回调附近立刻抓取扩展计数或锁存位置快照。

- **中心对齐 PWM 的好处不只是谐波更低，还给了采样静默窗与相位预算一个稳定几何结构**：你可以把注入组采样固定在导通中段，把 `Tsample_to_latch` 近似看成固定常数；但前提是代码必须在这个更新窗之前写完寄存器，否则系统会从“固定半拍延迟”瞬间退化成“多一整拍延迟”。

- **速度估计噪声会直接污染相位前馈**：补偿项依赖 `omega_e` 与 `alpha_e`，而编码器差分在低速时又最容易受量化和抖动影响。如果不做限幅和低通，前馈会从“补偿时延”退化成“主动注入角噪声”。

- **相位前馈不是越大越好，它必须服从可信度边界**：理论上你可以预测任意远的未来，工程上却只能在速度估计可信、延迟模型可信、更新事件没有丢失时做有限前推。常见做法是给 `Delta_theta_e` 加上明确的限幅，例如不超过 `20 deg ~ 30 deg` 电角。

- **资源调度错误比模型误差更致命**：若本拍计算已经错过写入窗口，软件再精确地算 `omega_e * Tdelay` 也救不了错过的更新事件。此时应该先把系统识别为“missed deadline”，再按多出一拍的实际时延重算补偿，而不是假装控制仍在本周期生效。

- **技术哲学上，FOC 的真正对象不是静态电机模型，而是“被 ADC、定时器、编码器和功率桥切碎后的时间片”**：电流环能否稳定，从来不只是 `dq` 公式是否正确，而是这些来自不同硬件模块的离散事件，是否被重新拼回了同一条物理旋转轨迹。

## 代码能力展现

下面给出一个基于 **STM32 HAL** 的电流环相位对齐示例。代码刻意把一拍 `FOC` 分成两条时间语义：

- 电流样本使用 **采样时刻的电角度** 做 `Park`，保证 `id/iq` 解释的是“刚刚被 ADC 看到的电流”；
- 电压命令使用 **预测到执行时刻的电角度** 做逆 `Park`，保证 `vd/vq` 对应的是“桥臂真正开始兑现电压矢量的时刻”。

示例重点不是重复展开完整电机库，而是把 **采样快照 -> 编码器共时 -> 时延预算 -> 相位前馈 -> PWM 写回** 这条链明确写进实现。

```c
#include "main.h"

#include <math.h>
#include <stdbool.h>
#include <stdint.h>

#define FOC_ALIGN_PI_F                       3.14159265359f
#define FOC_ALIGN_TWO_PI_F                   6.28318530718f
#define FOC_ALIGN_SQRT3_F                    1.73205080757f
#define FOC_ALIGN_INV_SQRT3_F                0.57735026919f
#define FOC_ALIGN_HALF_SQRT3_F               0.86602540378f
#define FOC_ALIGN_MIN_DT_S                   1.0e-6f
#define FOC_ALIGN_MAX_DT_S                   5.0e-3f
#define FOC_ALIGN_MIN_VBUS_V                 6.0f
#define FOC_ALIGN_MAX_PHASE_LEAD_RAD         0.60f
#define FOC_ALIGN_MAX_ACCEL_RAD_S2           250000.0f
#define FOC_ALIGN_MIN_DUTY                   0.02f
#define FOC_ALIGN_MAX_DUTY                   0.98f

typedef struct
{
    float alpha;
    float beta;
} FocAlphaBeta_t;

typedef struct
{
    float d;
    float q;
} FocDq_t;

typedef struct
{
    float a;
    float b;
    float c;
} FocPhaseValue_t;

typedef struct
{
    float kp;
    float ki;
    float kaw;
    float integrator;
    float output_limit_v;
} FocPI_t;

typedef struct
{
    TIM_HandleTypeDef *htim_pwm;
    uint32_t channel_a;
    uint32_t channel_b;
    uint32_t channel_c;
    uint16_t arr_ticks;
    float duty_min;
    float duty_max;
} FocPwmBridge_t;

typedef struct
{
    int32_t encoder_count_z1;
    uint32_t sample_tick_z1;
    float theta_e_sample_z1_rad;
    float omega_e_rad_s;
    float alpha_e_rad_s2;
    uint8_t ready;
} FocRotorObserver_t;

typedef struct
{
    TIM_HandleTypeDef *htim_timebase;
    uint32_t timebase_hz;
    uint32_t encoder_cpr;
    uint8_t pole_pairs;
    float current_loop_hz;
    float sample_to_latch_s;
    float pwm_zoh_s;
    float writeback_guard_s;
    float speed_lpf_alpha;
    float accel_limit_rad_s2;
    float phase_lead_limit_rad;
    float voltage_utilization;
    float vbus_v;
    FocPwmBridge_t pwm;
    FocPI_t id_pi;
    FocPI_t iq_pi;
    FocRotorObserver_t observer;
} FocPhaseAligner_t;

typedef struct
{
    uint32_t sample_tick;
    int32_t encoder_count;
    float ia_a;
    float ib_a;
} FocCurrentFrame_t;

typedef struct
{
    float theta_e_sample_rad;
    float theta_e_apply_rad;
    float omega_e_rad_s;
    float alpha_e_rad_s2;
    float id_a;
    float iq_a;
    float vd_v;
    float vq_v;
    float phase_lead_rad;
    float effective_delay_s;
    float compute_elapsed_s;
    uint8_t missed_latch_deadline;
} FocAlignTrace_t;

extern ADC_HandleTypeDef hadc1;
extern TIM_HandleTypeDef htim1;
extern TIM_HandleTypeDef htim2;

extern int32_t Encoder_GetExtendedCount(void);
extern float CurrentSense_CodeToAmp(uint32_t adc_code);

static FocPhaseAligner_t g_foc_align =
{
    .htim_timebase = &htim2,
    .timebase_hz = 1000000U,          /* TIM2 以 1 MHz 自由运行。 */
    .encoder_cpr = 8192U,
    .pole_pairs = 7U,
    .current_loop_hz = 20000.0f,
    .sample_to_latch_s = 18.0e-6f,    /* 采样中点 -> TIM1 更新事件。 */
    .pwm_zoh_s = 12.5e-6f,            /* 占空比在一个半载波上的等效保持时延。 */
    .writeback_guard_s = 1.2e-6f,     /* 留给 inverse Park + CCR 写回的尾部保护量。 */
    .speed_lpf_alpha = 0.22f,
    .accel_limit_rad_s2 = 80000.0f,
    .phase_lead_limit_rad = 0.45f,
    .voltage_utilization = 0.92f,
    .vbus_v = 24.0f,
    .pwm =
    {
        .htim_pwm = &htim1,
        .channel_a = TIM_CHANNEL_1,
        .channel_b = TIM_CHANNEL_2,
        .channel_c = TIM_CHANNEL_3,
        .arr_ticks = 3599U,
        .duty_min = FOC_ALIGN_MIN_DUTY,
        .duty_max = FOC_ALIGN_MAX_DUTY
    },
    .id_pi =
    {
        .kp = 2.8f,
        .ki = 420.0f,
        .kaw = 0.15f,
        .integrator = 0.0f,
        .output_limit_v = 10.0f
    },
    .iq_pi =
    {
        .kp = 2.8f,
        .ki = 420.0f,
        .kaw = 0.15f,
        .integrator = 0.0f,
        .output_limit_v = 10.0f
    }
};

static float FocAlign_ClampF(float value, float min_value, float max_value)
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

static float FocAlign_WrapPmPi(float angle_rad)
{
    while (angle_rad > FOC_ALIGN_PI_F)
    {
        angle_rad -= FOC_ALIGN_TWO_PI_F;
    }

    while (angle_rad < -FOC_ALIGN_PI_F)
    {
        angle_rad += FOC_ALIGN_TWO_PI_F;
    }

    return angle_rad;
}

static float FocAlign_Normalize0To2Pi(float angle_rad)
{
    while (angle_rad >= FOC_ALIGN_TWO_PI_F)
    {
        angle_rad -= FOC_ALIGN_TWO_PI_F;
    }

    while (angle_rad < 0.0f)
    {
        angle_rad += FOC_ALIGN_TWO_PI_F;
    }

    return angle_rad;
}

static float FocAlign_TickDeltaToSeconds(uint32_t now_tick,
                                         uint32_t prev_tick,
                                         uint32_t tick_hz)
{
    const uint32_t delta_tick = now_tick - prev_tick;
    return (float)delta_tick / (float)tick_hz;
}

static float FocAlign_EncoderCountToElectricalAngle(const FocPhaseAligner_t *aligner,
                                                    int32_t encoder_count)
{
    const float mech_angle_rad =
        ((float)encoder_count * FOC_ALIGN_TWO_PI_F) / (float)aligner->encoder_cpr;

    return FocAlign_Normalize0To2Pi(mech_angle_rad * (float)aligner->pole_pairs);
}

static FocAlphaBeta_t FocAlign_ClarkeTwoShunt(float ia_a, float ib_a)
{
    FocAlphaBeta_t current_ab;

    /* 两相采样的 Clarke 变换：
     * i_alpha = ia
     * i_beta  = (ia + 2 * ib) / sqrt(3)
     *
     * 这里默认 ic = -(ia + ib)，因此不必显式采第三相。
     */
    current_ab.alpha = ia_a;
    current_ab.beta = (ia_a + (2.0f * ib_a)) * FOC_ALIGN_INV_SQRT3_F;
    return current_ab;
}

static FocDq_t FocAlign_Park(const FocAlphaBeta_t *current_ab, float theta_e_rad)
{
    const float s = sinf(theta_e_rad);
    const float c = cosf(theta_e_rad);
    FocDq_t current_dq;

    current_dq.d = (current_ab->alpha * c) + (current_ab->beta * s);
    current_dq.q = (-current_ab->alpha * s) + (current_ab->beta * c);
    return current_dq;
}

static FocAlphaBeta_t FocAlign_InversePark(const FocDq_t *voltage_dq, float theta_e_rad)
{
    const float s = sinf(theta_e_rad);
    const float c = cosf(theta_e_rad);
    FocAlphaBeta_t voltage_ab;

    voltage_ab.alpha = (voltage_dq->d * c) - (voltage_dq->q * s);
    voltage_ab.beta = (voltage_dq->d * s) + (voltage_dq->q * c);
    return voltage_ab;
}

/**
 * @brief 用采样瞬间的编码器快照更新电角度、速度和加速度估计。
 * @param aligner FOC 相位对齐控制器。
 * @param frame 当前电流采样帧，时间戳和编码器计数必须共时。
 * @param trace 调试输出，可为 NULL。
 *
 * @note 电角度预测的基本近似是：
 *       Delta_theta_e = omega_e * Delta_t + 0.5 * alpha_e * Delta_t^2
 *       因此这里只接受“采样时刻”的角度快照，而不接受主循环晚到的读数。
 */
static void FocAlign_UpdateRotorObserver(FocPhaseAligner_t *aligner,
                                         const FocCurrentFrame_t *frame,
                                         FocAlignTrace_t *trace)
{
    FocRotorObserver_t *observer = &aligner->observer;
    const float theta_e_rad =
        FocAlign_EncoderCountToElectricalAngle(aligner, frame->encoder_count);

    if (observer->ready == 0U)
    {
        observer->encoder_count_z1 = frame->encoder_count;
        observer->sample_tick_z1 = frame->sample_tick;
        observer->theta_e_sample_z1_rad = theta_e_rad;
        observer->omega_e_rad_s = 0.0f;
        observer->alpha_e_rad_s2 = 0.0f;
        observer->ready = 1U;
    }
    else
    {
        const int32_t delta_count = frame->encoder_count - observer->encoder_count_z1;
        const float dt_s = FocAlign_ClampF(
            FocAlign_TickDeltaToSeconds(frame->sample_tick,
                                        observer->sample_tick_z1,
                                        aligner->timebase_hz),
            FOC_ALIGN_MIN_DT_S,
            FOC_ALIGN_MAX_DT_S);
        const float mech_delta_rad =
            ((float)delta_count * FOC_ALIGN_TWO_PI_F) / (float)aligner->encoder_cpr;
        const float omega_raw_rad_s =
            (mech_delta_rad * (float)aligner->pole_pairs) / dt_s;
        const float alpha_lpf = FocAlign_ClampF(aligner->speed_lpf_alpha, 0.02f, 1.0f);
        const float omega_filtered_rad_s =
            observer->omega_e_rad_s +
            alpha_lpf * (omega_raw_rad_s - observer->omega_e_rad_s);
        const float accel_raw_rad_s2 =
            (omega_filtered_rad_s - observer->omega_e_rad_s) / dt_s;

        observer->alpha_e_rad_s2 = FocAlign_ClampF(
            accel_raw_rad_s2,
            -FocAlign_ClampF(aligner->accel_limit_rad_s2, 1000.0f, FOC_ALIGN_MAX_ACCEL_RAD_S2),
            FocAlign_ClampF(aligner->accel_limit_rad_s2, 1000.0f, FOC_ALIGN_MAX_ACCEL_RAD_S2));
        observer->omega_e_rad_s = omega_filtered_rad_s;
        observer->encoder_count_z1 = frame->encoder_count;
        observer->sample_tick_z1 = frame->sample_tick;
        observer->theta_e_sample_z1_rad = theta_e_rad;
    }

    if (trace != NULL)
    {
        trace->theta_e_sample_rad = observer->theta_e_sample_z1_rad;
        trace->omega_e_rad_s = observer->omega_e_rad_s;
        trace->alpha_e_rad_s2 = observer->alpha_e_rad_s2;
    }
}

/**
 * @brief 执行带回算抗饱和的单轴 PI。
 * @param pi PI 控制器状态。
 * @param error 输入误差。
 * @param dt_s 当前离散步长。
 * @retval 该轴的饱和后电压输出，单位 V。
 *
 * @note 位置式积分和回算公式：
 *       u_unsat = Kp * e + I
 *       I[k+1]  = I[k] + Ki * dt * e + Kaw * (u_sat - u_unsat)
 *
 *       这里的 Kaw 项会把“母线兑现不了的电压”回写给积分器，
 *       避免高转速相位误差与电压限幅叠加后把积分状态顶飞。
 */
static float FocAlign_RunPI(FocPI_t *pi, float error, float dt_s)
{
    const float proportional_v = pi->kp * error;
    const float unsat_v = proportional_v + pi->integrator;
    const float sat_limit_v = FocAlign_ClampF(pi->output_limit_v, 0.5f, 200.0f);
    const float sat_v = FocAlign_ClampF(unsat_v, -sat_limit_v, sat_limit_v);

    pi->integrator += (pi->ki * dt_s * error) + (pi->kaw * (sat_v - unsat_v));
    pi->integrator = FocAlign_ClampF(pi->integrator, -sat_limit_v, sat_limit_v);
    return sat_v;
}

/**
 * @brief 对 dq 电压向量做统一缩放限幅。
 * @param aligner FOC 相位对齐控制器。
 * @param voltage_dq 待限幅的 dq 电压向量。
 *
 * @note 线性调制区的保守边界可写成：
 *       sqrt(vd^2 + vq^2) <= k_util * Vdc / sqrt(3)
 *       统一缩放比逐轴裁剪更稳，因为它不会旋转电压向量方向。
 */
static void FocAlign_LimitVoltageVector(const FocPhaseAligner_t *aligner,
                                        FocDq_t *voltage_dq)
{
    const float vbus_v = FocAlign_ClampF(aligner->vbus_v, FOC_ALIGN_MIN_VBUS_V, 100.0f);
    const float util = FocAlign_ClampF(aligner->voltage_utilization, 0.60f, 0.98f);
    const float limit_v = util * vbus_v * FOC_ALIGN_INV_SQRT3_F;
    const float magnitude_v =
        sqrtf((voltage_dq->d * voltage_dq->d) + (voltage_dq->q * voltage_dq->q));

    if (magnitude_v > limit_v)
    {
        const float scale = limit_v / magnitude_v;
        voltage_dq->d *= scale;
        voltage_dq->q *= scale;
    }
}

/**
 * @brief 把 alpha/beta 电压映射成三相 PWM 占空比并写回 TIM CCR。
 * @param aligner FOC 相位对齐控制器。
 * @param voltage_ab alpha/beta 平面电压向量。
 *
 * @note 采用零序平移的三相映射：
 *       va = v_alpha
 *       vb = -0.5 * v_alpha + sqrt(3) / 2 * v_beta
 *       vc = -0.5 * v_alpha - sqrt(3) / 2 * v_beta
 *       v0 = -0.5 * (max(va, vb, vc) + min(va, vb, vc))
 *
 *       duty = 0.5 + (v_phase + v0) / Vbus
 *
 *       该线性映射把三相平均桥臂电压压回 [0, 1] 的占空比区间，
 *       并通过 duty_min / duty_max 给死区、采样窗和驱动传播预留边界。
 */
static void FocAlign_WritePwm(FocPhaseAligner_t *aligner,
                              const FocAlphaBeta_t *voltage_ab)
{
    FocPhaseValue_t phase_voltage;
    const float vbus_v = FocAlign_ClampF(aligner->vbus_v, FOC_ALIGN_MIN_VBUS_V, 100.0f);
    const float duty_min = FocAlign_ClampF(aligner->pwm.duty_min, 0.0f, 0.45f);
    const float duty_max = FocAlign_ClampF(aligner->pwm.duty_max, 0.55f, 1.0f);
    float v_zero = 0.0f;
    float duty_a = 0.5f;
    float duty_b = 0.5f;
    float duty_c = 0.5f;
    uint32_t ccr_a = 0U;
    uint32_t ccr_b = 0U;
    uint32_t ccr_c = 0U;

    phase_voltage.a = voltage_ab->alpha;
    phase_voltage.b = (-0.5f * voltage_ab->alpha) + (FOC_ALIGN_HALF_SQRT3_F * voltage_ab->beta);
    phase_voltage.c = (-0.5f * voltage_ab->alpha) - (FOC_ALIGN_HALF_SQRT3_F * voltage_ab->beta);

    v_zero = -0.5f * (fmaxf(phase_voltage.a, fmaxf(phase_voltage.b, phase_voltage.c)) +
                      fminf(phase_voltage.a, fminf(phase_voltage.b, phase_voltage.c)));

    duty_a = 0.5f + ((phase_voltage.a + v_zero) / vbus_v);
    duty_b = 0.5f + ((phase_voltage.b + v_zero) / vbus_v);
    duty_c = 0.5f + ((phase_voltage.c + v_zero) / vbus_v);

    duty_a = FocAlign_ClampF(duty_a, duty_min, duty_max);
    duty_b = FocAlign_ClampF(duty_b, duty_min, duty_max);
    duty_c = FocAlign_ClampF(duty_c, duty_min, duty_max);

    ccr_a = (uint32_t)((float)aligner->pwm.arr_ticks * duty_a);
    ccr_b = (uint32_t)((float)aligner->pwm.arr_ticks * duty_b);
    ccr_c = (uint32_t)((float)aligner->pwm.arr_ticks * duty_c);

    __HAL_TIM_SET_COMPARE(aligner->pwm.htim_pwm, aligner->pwm.channel_a, ccr_a);
    __HAL_TIM_SET_COMPARE(aligner->pwm.htim_pwm, aligner->pwm.channel_b, ccr_b);
    __HAL_TIM_SET_COMPARE(aligner->pwm.htim_pwm, aligner->pwm.channel_c, ccr_c);
}

/**
 * @brief 在一次注入组电流采样完成后执行相位对齐的 FOC 电流环。
 * @param aligner FOC 相位对齐控制器。
 * @param frame 当前电流采样帧。
 * @param id_ref_a d 轴目标电流。
 * @param iq_ref_a q 轴目标电流。
 * @param trace 调试输出，可为 NULL。
 *
 * @note 核心时序分工：
 *       1. 电流测量在 theta_sample 下做 Park，保证测得的是采样那一刻的 id/iq。
 *       2. 电压命令在 theta_apply 下做 inverse Park，其中
 *          theta_apply = theta_sample + omega_e * Tdelay + 0.5 * alpha_e * Tdelay^2
 *       3. 若 compute_elapsed + writeback_guard > sample_to_latch_s，
 *          说明本拍已经错过更新事件，实际延迟需额外加一个 Tcarrier。
 */
static void FocAlign_CurrentLoopStep(FocPhaseAligner_t *aligner,
                                     const FocCurrentFrame_t *frame,
                                     float id_ref_a,
                                     float iq_ref_a,
                                     FocAlignTrace_t *trace)
{
    const uint32_t control_start_tick = __HAL_TIM_GET_COUNTER(aligner->htim_timebase);
    FocAlphaBeta_t current_ab;
    FocDq_t current_dq;
    FocDq_t voltage_dq;
    FocAlphaBeta_t voltage_ab;
    float effective_delay_s = 0.0f;
    float phase_lead_rad = 0.0f;
    float theta_apply_rad = 0.0f;
    float compute_elapsed_s = 0.0f;
    uint8_t missed_deadline = 0U;

    FocAlign_UpdateRotorObserver(aligner, frame, trace);

    current_ab = FocAlign_ClarkeTwoShunt(frame->ia_a, frame->ib_a);
    current_dq = FocAlign_Park(&current_ab, aligner->observer.theta_e_sample_z1_rad);

    /* 电流误差使用采样角 theta_sample 解释：
     * 这是 ADC 真正看到的物理电流所在坐标系，不能提前用预测角“美化”测量值。
     */
    voltage_dq.d = FocAlign_RunPI(&aligner->id_pi,
                                  id_ref_a - current_dq.d,
                                  1.0f / aligner->current_loop_hz);
    voltage_dq.q = FocAlign_RunPI(&aligner->iq_pi,
                                  iq_ref_a - current_dq.q,
                                  1.0f / aligner->current_loop_hz);

    FocAlign_LimitVoltageVector(aligner, &voltage_dq);

    compute_elapsed_s = FocAlign_TickDeltaToSeconds(__HAL_TIM_GET_COUNTER(aligner->htim_timebase),
                                                    control_start_tick,
                                                    aligner->timebase_hz);

    if ((compute_elapsed_s + aligner->writeback_guard_s) > aligner->sample_to_latch_s)
    {
        missed_deadline = 1U;
    }

    effective_delay_s = aligner->sample_to_latch_s + aligner->pwm_zoh_s;

    if (missed_deadline != 0U)
    {
        effective_delay_s += 1.0f / aligner->current_loop_hz;
    }

    phase_lead_rad =
        (aligner->observer.omega_e_rad_s * effective_delay_s) +
        (0.5f * aligner->observer.alpha_e_rad_s2 * effective_delay_s * effective_delay_s);
    phase_lead_rad = FocAlign_ClampF(
        phase_lead_rad,
        -FocAlign_ClampF(aligner->phase_lead_limit_rad, 0.05f, FOC_ALIGN_MAX_PHASE_LEAD_RAD),
        FocAlign_ClampF(aligner->phase_lead_limit_rad, 0.05f, FOC_ALIGN_MAX_PHASE_LEAD_RAD));

    theta_apply_rad = FocAlign_Normalize0To2Pi(
        aligner->observer.theta_e_sample_z1_rad + phase_lead_rad);
    voltage_ab = FocAlign_InversePark(&voltage_dq, theta_apply_rad);
    FocAlign_WritePwm(aligner, &voltage_ab);

    if (trace != NULL)
    {
        trace->theta_e_apply_rad = theta_apply_rad;
        trace->id_a = current_dq.d;
        trace->iq_a = current_dq.q;
        trace->vd_v = voltage_dq.d;
        trace->vq_v = voltage_dq.q;
        trace->phase_lead_rad = phase_lead_rad;
        trace->effective_delay_s = effective_delay_s;
        trace->compute_elapsed_s = compute_elapsed_s;
        trace->missed_latch_deadline = missed_deadline;
    }
}

static FocAlignTrace_t g_foc_trace;

void HAL_ADCEx_InjectedConvCpltCallback(ADC_HandleTypeDef *hadc)
{
    FocCurrentFrame_t frame;

    if (hadc != &hadc1)
    {
        return;
    }

    /* 关键点：采样时间戳与编码器计数必须在同一回调附近抓取，
     * 否则 theta_sample 与 ia/ib 就会天然错相。
     */
    frame.sample_tick = __HAL_TIM_GET_COUNTER(g_foc_align.htim_timebase);
    frame.encoder_count = Encoder_GetExtendedCount();
    frame.ia_a = CurrentSense_CodeToAmp(HAL_ADCEx_InjectedGetValue(hadc, ADC_INJECTED_RANK_1));
    frame.ib_a = CurrentSense_CodeToAmp(HAL_ADCEx_InjectedGetValue(hadc, ADC_INJECTED_RANK_2));

    FocAlign_CurrentLoopStep(&g_foc_align,
                             &frame,
                             0.0f,
                             12.0f,
                             &g_foc_trace);
}
```

这段实现的关键不在“多写了一个预测项”，而在它明确承认了 `FOC` 的两件事：**测量总是属于过去某个采样时刻，执行总是属于未来某个桥臂生效时刻**；只有先把这两个时刻用 `omega_e` 和 `alpha_e` 串起来，`Park` 变换才重新有了物理意义。
