---
title: "技能档案：FOC 电流环的真实带宽，从离散化、交叉耦合解耦到反电动势前馈"
slug: "skill-foc-current-loop-discretization-decoupling-and-back-emf-feedforward"
date: 2026-06-13T10:42:47+08:00
draft: false
description: "从 PMSM dq 轴电压方程、采样周期离散化到 ωL 交叉耦合与 ψf 反电动势前馈，系统拆解 FOC 电流环为什么常死在高速区电压预算而不是 PI 参数表。"
tags: ["FOC", "STM32", "PMSM", "电流环", "前馈", "离散控制", "嵌入式"]
categories: ["技能档案", "电机控制", "控制与融合"]
image: ""
---

## 技能概述

很多工程师第一次把 FOC 跑起来时，会误以为电流环只是两路 PI 加一组 Clarke / Park 变换；真正到了高速区、弱磁区、母线下陷区或者重载突变区，系统才会暴露出本质问题: **dq 两轴从来不是天然解耦的，反电动势也不会因为你写了 `i_d = 0` 就自动消失**。伺服关节、电动工具、轮毂电机、压缩机和高速风机之所以在中高速段最容易出现 `i_q` 跟不上、`i_d` 漏电流、母线一饱和就发热抖动，本质上都和同一件事有关: 电流环面对的不是一个静止的一阶对象，而是一套随电角速度 `omega_e` 实时变形的旋转电磁系统。这个主题真正要解决的痛点，不是再讲一遍“FOC 让电机更平滑”，而是把 **PMSM dq 轴方程**、**采样周期离散化**、**交叉耦合解耦**、**反电动势前馈** 和 **电压矢量限幅** 串成一份可以落到 STM32 HAL 快环代码里的电压预算合同。

## 核心底层概念解析

- **dq 轴并不是两个天然独立的一阶环节**：对 PMSM 而言，连续时间电压方程写成  
  `v_d = R_s * i_d + L_d * di_d/dt - omega_e * L_q * i_q`  
  `v_q = R_s * i_q + L_q * di_q/dt + omega_e * (L_d * i_d + psi_f)`。  
  只看 `R` 和 `L` 会觉得像两路 RL 回路，但只要转子在转，`omega_e * L_q * i_q` 和 `omega_e * (L_d * i_d + psi_f)` 就会把 d、q 两轴重新绑回一起。
- **交叉耦合不是建模细节，而是高速区电流跟踪失败的第一原因**：当 `i_q` 很大时，`-omega_e * L_q * i_q` 会在 d 轴上生成一项与转速成正比的扰动；如果控制器不主动补偿，它就必须靠 d 轴 PI 先看到误差、再把积分堆起来补救。这个过程天然晚一拍，高速时尤其明显。
- **q 轴上的 `omega_e * psi_f` 就是反电动势在同步坐标系里的直接账单**：转速越高，永磁体磁链越像一个越来越大的“内生电压源”，它先吞掉母线电压预算，剩下的部分才轮到 `R_s * i_q` 和 `L_q * di_q/dt`。所以很多电机一到某个速度后 `i_q` 明显跟不上，并不一定是 PI 太小，而是 `Vdc` 已经先被 `omega_e * psi_f` 吃掉了。
- **数字控制器看到的不是连续方程，而是带零阶保持的离散对象**：若快环周期为 `T_s`，则前向 Euler 近似下有  
  `i_d[k+1] = i_d[k] + T_s / L_d * (v_d[k] - R_s * i_d[k] + omega_e[k] * L_q * i_q[k])`  
  `i_q[k+1] = i_q[k] + T_s / L_q * (v_q[k] - R_s * i_q[k] - omega_e[k] * (L_d * i_d[k] + psi_f))`。  
  这说明 `T_s` 不是“中断多久来一次”这么简单，它直接决定单拍电流能跳多远、相位还剩多少、离散极点会落在哪里。
- **模拟域调好的 PI，直接抄到数字域不一定还能成立**：当 `T_s` 接近电机电气时间常数 `tau = L / R` 的十分之一甚至更大时，积分器和计算延迟带来的相位损失会很明显。看上去只是 `20 kHz` 和 `10 kHz` 的区别，实质上是在重新定义同一个闭环的可达带宽。
- **前馈的价值不是“替代 PI”，而是把模型里本来就知道的那部分电压先付掉**：由离散模型反推，可把参考变化率和旋转耦合项直接写进电压前馈  
  `v_d_ff = R_s * i_d_ref + L_d * Delta_i_d_ref / T_s - omega_e * L_q * i_q`  
  `v_q_ff = R_s * i_q_ref + L_q * Delta_i_q_ref / T_s + omega_e * (L_d * i_d + psi_f)`。  
  这样 PI 不再负责“追整台电机”，而是只负责修正参数漂移、采样误差和外部扰动。
- **解耦项应该更相信“当前测到的电流”，而不是“理想参考电流”**：因为交叉耦合本质是此刻真实磁场与电流状态引出的扰动，所以 `omega_e * L_q * i_q`、`omega_e * L_d * i_d` 这类项用反馈电流更稳妥。参考值只适合进入欧姆压降和期望斜率项。
- **电压矢量限幅必须发生在 dq 向量层，而不是两路 PI 各自单独截断**：线性 SVPWM 区间里可实现的电压上限近似为  
  `|V_alpha_beta|max ~= m * Vdc / sqrt(3)`，`m < 1`。  
  若把 d、q 轴各自单独饱和，向量方向会被扭曲，等于控制器对同一磁场目标说了两种不同语言。更合理的做法通常是先合成 `v_dq`，再按矢量模长统一缩放。
- **抗积分饱和不是附加功能，而是高速区能不能恢复的分水岭**：一旦 `v_dq_unsat` 超过 `V_limit`，说明系统已经没有足够电压兑现当前参考。此时若积分器继续盲目累加，退出饱和后会出现长尾、反冲甚至扭矩翻转。工程上更稳妥的是用 back-calculation，把 `v_sat - v_unsat` 直接回灌到积分器。
- **参数误差会把前馈从“帮手”变成“偏置源”**：`R_s` 随铜温上升、`L_d/L_q` 随工作点变化、`psi_f` 会受磁钢温度影响。前馈从来不是绝对真理，它只是把“已知部分”先搬掉；剩余误差仍然要靠 PI 和在线辨识兜底。
- **速度估计与电流采样必须属于同一时间语境**：前馈项里最敏感的量之一就是 `omega_e`。若速度来自慢环，时间戳却比当前 ADC 电流滞后几个周期，那么你补进去的将不是解耦项，而是一份延迟扰动。
- **参考变化率本身也是资源调度问题**：从 `0 A` 一步跳到 `20 A`，在数学上 `Delta_i / T_s` 可以无穷大，但逆变器母线不会因此多给你电压。实际系统里必须给 `i_d_ref`、`i_q_ref` 加斜率约束，否则前馈项会先把电压预算一口吃光。
- **技术哲学上，FOC 电流环调参不是在摆弄两个 PI，而是在给一份有限母线电压做实时会计**：`R_s * i`、`L * di/dt`、`omega * L * i`、`omega * psi_f`、死区误差和采样偏差，都在抢同一笔电压预算。成熟的控制器不是假装这些项不存在，而是把它们逐项记账、优先支付，再把剩余误差交给反馈。

## 代码能力展现

下面给出一个基于 STM32 HAL 的 FOC 电流环示例。假设前级已经完成三相电流采样与零偏校正，电角度 `theta_e` 和电角速度 `omega_e` 也已经由编码器或观测器给出；`TIM1` 负责中心对齐 PWM，快环以 `20 kHz` 运行。代码重点不是重复介绍 Clarke / Park，而是把 **离散模型 -> 解耦前馈 -> dq 矢量限幅 -> back-calculation 抗饱和 -> PWM 映射** 这条链路完整打通。

```c
#include "main.h"

#include <math.h>
#include <stdbool.h>
#include <stdint.h>

#define FOC_PI                                 3.14159265359f
#define FOC_TWO_PI                             6.28318530718f
#define FOC_SQRT3                              1.73205080757f
#define FOC_INV_SQRT3                          0.57735026919f
#define FOC_HALF_SQRT3                         0.86602540378f

#define FOC_DT_MIN_S                           0.00002f
#define FOC_DT_MAX_S                           0.00020f
#define FOC_VBUS_MIN_V                         8.0f
#define FOC_VBUS_MAX_V                         80.0f
#define FOC_VUTIL_MIN                          0.70f
#define FOC_VUTIL_MAX                          0.98f
#define FOC_DUTY_MIN                           0.02f
#define FOC_DUTY_MAX                           0.98f
#define FOC_CURRENT_LIMIT_A                    60.0f
#define FOC_REF_SLEW_MIN_A_PER_S               100.0f
#define FOC_REF_SLEW_MAX_A_PER_S               300000.0f

typedef struct
{
    float ia;
    float ib;
    float ic;
} FocPhaseCurrent_t;

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
    float duty_u;
    float duty_v;
    float duty_w;
} FocPwmDuty_t;

typedef struct
{
    float kp;
    float ki;
    float kaw;
    float integrator;
} FocPIController_t;

typedef struct
{
    float rs_ohm;
    float ld_h;
    float lq_h;
    float psi_f_wb;
    float max_current_a;
    float voltage_utilization;
    float max_ref_slew_a_per_s;
} FocMotorModel_t;

typedef struct
{
    TIM_HandleTypeDef *htim_pwm;
    uint32_t channel_u;
    uint32_t channel_v;
    uint32_t channel_w;
    uint32_t period_ticks;
    float duty_min;
    float duty_max;
} FocPwmBridge_t;

typedef struct
{
    FocMotorModel_t motor;
    FocPwmBridge_t pwm;
    FocPIController_t id_pi;
    FocPIController_t iq_pi;
    float prev_id_ref_a;
    float prev_iq_ref_a;
} FocCurrentLoop_t;

typedef struct
{
    FocDq_t current_dq;
    FocDq_t voltage_ff_dq;
    FocDq_t voltage_pi_dq;
    FocDq_t voltage_cmd_dq;
    float vector_limit_v;
    float saturation_scale;
} FocCurrentLoopTrace_t;

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

static float Foc_WrapPmPi(float angle_rad)
{
    while (angle_rad > FOC_PI)
    {
        angle_rad -= FOC_TWO_PI;
    }

    while (angle_rad <= -FOC_PI)
    {
        angle_rad += FOC_TWO_PI;
    }

    return angle_rad;
}

static float Foc_LimitReferenceSlew(float reference,
                                    float previous_reference,
                                    float max_slew_a_per_s,
                                    float dt_s)
{
    const float safe_slew = Foc_ClampF(max_slew_a_per_s,
                                       FOC_REF_SLEW_MIN_A_PER_S,
                                       FOC_REF_SLEW_MAX_A_PER_S);
    const float max_delta = safe_slew * dt_s;

    return Foc_ClampF(reference, previous_reference - max_delta, previous_reference + max_delta);
}

/**
 * @brief 将三相电流投影到定子静止 alpha/beta 平面。
 * @param phase_current 三相电流，单位 A。
 * @return alpha/beta 静止坐标系电流。
 *
 * @note 经典 Clarke 变换在 `i_a + i_b + i_c = 0` 约束下可写成：
 *       i_alpha = i_a
 *       i_beta  = (i_a + 2 * i_b) / sqrt(3)
 */
static FocAlphaBeta_t Foc_ClarkeTransform(const FocPhaseCurrent_t *phase_current)
{
    FocAlphaBeta_t current_ab;

    current_ab.alpha = phase_current->ia;
    current_ab.beta = (phase_current->ia + (2.0f * phase_current->ib)) * FOC_INV_SQRT3;
    return current_ab;
}

/**
 * @brief 把 alpha/beta 电流旋转到转子同步 d/q 坐标系。
 * @param current_ab 定子静止坐标系电流。
 * @param theta_e_rad 电角度，单位 rad。
 * @return d/q 坐标系电流。
 *
 * @note Park 变换：
 *       i_d =  i_alpha * cos(theta_e) + i_beta * sin(theta_e)
 *       i_q = -i_alpha * sin(theta_e) + i_beta * cos(theta_e)
 */
static FocDq_t Foc_ParkTransform(const FocAlphaBeta_t *current_ab, float theta_e_rad)
{
    const float theta = Foc_WrapPmPi(theta_e_rad);
    const float sin_theta = sinf(theta);
    const float cos_theta = cosf(theta);
    FocDq_t current_dq;

    current_dq.d = (current_ab->alpha * cos_theta) + (current_ab->beta * sin_theta);
    current_dq.q = (-current_ab->alpha * sin_theta) + (current_ab->beta * cos_theta);
    return current_dq;
}

/**
 * @brief 把 d/q 电压指令旋回到 alpha/beta 静止平面。
 * @param voltage_dq d/q 坐标系电压。
 * @param theta_e_rad 电角度，单位 rad。
 * @return alpha/beta 坐标系电压。
 *
 * @note 逆 Park 变换：
 *       v_alpha = v_d * cos(theta_e) - v_q * sin(theta_e)
 *       v_beta  = v_d * sin(theta_e) + v_q * cos(theta_e)
 */
static FocAlphaBeta_t Foc_InverseParkTransform(const FocDq_t *voltage_dq, float theta_e_rad)
{
    const float theta = Foc_WrapPmPi(theta_e_rad);
    const float sin_theta = sinf(theta);
    const float cos_theta = cosf(theta);
    FocAlphaBeta_t voltage_ab;

    voltage_ab.alpha = (voltage_dq->d * cos_theta) - (voltage_dq->q * sin_theta);
    voltage_ab.beta = (voltage_dq->d * sin_theta) + (voltage_dq->q * cos_theta);
    return voltage_ab;
}

/**
 * @brief 按 d/q 电压矢量模长执行统一限幅。
 * @param voltage_dq 待限幅的 d/q 电压矢量。
 * @param vector_limit_v 可用电压矢量半径。
 * @param out_scale 输出本次缩放比例，1 表示未饱和。
 *
 * @note 这里不对 d、q 轴各自单独裁剪，而是统一按
 *       `scale = V_limit / |V_dq|` 缩放。这样做的原因是：
 *       dq 两轴共同描述的是同一支旋转电压矢量，单轴硬裁剪会改变其方向。
 */
static void Foc_LimitVoltageVector(FocDq_t *voltage_dq,
                                   float vector_limit_v,
                                   float *out_scale)
{
    const float magnitude =
        sqrtf((voltage_dq->d * voltage_dq->d) + (voltage_dq->q * voltage_dq->q));
    float scale = 1.0f;

    if ((vector_limit_v > 0.0f) && (magnitude > vector_limit_v))
    {
        scale = vector_limit_v / magnitude;
        voltage_dq->d *= scale;
        voltage_dq->q *= scale;
    }

    if (out_scale != NULL)
    {
        *out_scale = scale;
    }
}

/**
 * @brief 将 alpha/beta 电压映射为中心对齐 PWM 占空比。
 * @param voltage_ab alpha/beta 电压。
 * @param vbus_v 当前母线电压。
 * @param pwm PWM 桥臂对象。
 * @return 三相桥臂占空比。
 *
 * @note 先做逆 Clarke：
 *       v_u = v_alpha
 *       v_v = -0.5 * v_alpha + sqrt(3)/2 * v_beta
 *       v_w = -0.5 * v_alpha - sqrt(3)/2 * v_beta
 *
 *       再加入共模偏置：
 *       v_offset = -(max(v_u, v_v, v_w) + min(v_u, v_v, v_w)) / 2
 *
 *       最终线性映射：
 *       duty_x = 0.5 + (v_x + v_offset) / Vdc
 */
static FocPwmDuty_t Foc_AlphaBetaToCenterAlignedDuty(const FocAlphaBeta_t *voltage_ab,
                                                     float vbus_v,
                                                     const FocPwmBridge_t *pwm)
{
    const float safe_vbus = Foc_ClampF(vbus_v, FOC_VBUS_MIN_V, FOC_VBUS_MAX_V);
    const float duty_min = Foc_ClampF(pwm->duty_min, 0.0f, 0.45f);
    const float duty_max = Foc_ClampF(pwm->duty_max, 0.55f, 1.0f);

    const float vu = voltage_ab->alpha;
    const float vv = (-0.5f * voltage_ab->alpha) + (FOC_HALF_SQRT3 * voltage_ab->beta);
    const float vw = (-0.5f * voltage_ab->alpha) - (FOC_HALF_SQRT3 * voltage_ab->beta);

    const float vmax = fmaxf(vu, fmaxf(vv, vw));
    const float vmin = fminf(vu, fminf(vv, vw));
    const float voffset = -0.5f * (vmax + vmin);

    FocPwmDuty_t duty;

    duty.duty_u = Foc_ClampF(0.5f + ((vu + voffset) / safe_vbus), duty_min, duty_max);
    duty.duty_v = Foc_ClampF(0.5f + ((vv + voffset) / safe_vbus), duty_min, duty_max);
    duty.duty_w = Foc_ClampF(0.5f + ((vw + voffset) / safe_vbus), duty_min, duty_max);
    return duty;
}

/**
 * @brief 将三相占空比写入 STM32 高级定时器 CCR。
 * @param pwm PWM 桥臂对象。
 * @param duty 待写入的占空比。
 *
 * @note 线性映射公式：
 *       compare = round(duty * period_ticks)
 */
static void Foc_WriteDutyToTimer(const FocPwmBridge_t *pwm, const FocPwmDuty_t *duty)
{
    const float period_ticks = (float)((pwm->period_ticks == 0U) ? 1U : pwm->period_ticks);
    const uint32_t ccr_u = (uint32_t)(duty->duty_u * period_ticks + 0.5f);
    const uint32_t ccr_v = (uint32_t)(duty->duty_v * period_ticks + 0.5f);
    const uint32_t ccr_w = (uint32_t)(duty->duty_w * period_ticks + 0.5f);

    __HAL_TIM_SET_COMPARE(pwm->htim_pwm, pwm->channel_u, ccr_u);
    __HAL_TIM_SET_COMPARE(pwm->htim_pwm, pwm->channel_v, ccr_v);
    __HAL_TIM_SET_COMPARE(pwm->htim_pwm, pwm->channel_w, ccr_w);
}

/**
 * @brief 执行一次带解耦前馈与反电动势补偿的 PMSM 电流环更新。
 * @param loop 电流环对象。
 * @param phase_current 当前三相电流反馈，单位 A。
 * @param theta_e_rad 当前电角度，单位 rad。
 * @param omega_e_rad_s 当前电角速度，单位 rad/s。
 * @param id_ref_a d 轴参考电流，单位 A。
 * @param iq_ref_a q 轴参考电流，单位 A。
 * @param vbus_v 当前母线电压，单位 V。
 * @param dt_s 当前快环周期，单位 s。
 * @param out_trace 可选调试快照。
 * @retval true 本次更新成功。
 * @retval false 参数非法或当前母线电压不足。
 *
 * @note 连续时间 dq 方程：
 *       v_d = R_s * i_d + L_d * di_d/dt - omega_e * L_q * i_q
 *       v_q = R_s * i_q + L_q * di_q/dt + omega_e * (L_d * i_d + psi_f)
 *
 *       前向 Euler 离散化：
 *       i_d[k+1] = i_d[k] + Ts / L_d * (v_d[k] - R_s * i_d[k] + omega_e[k] * L_q * i_q[k])
 *       i_q[k+1] = i_q[k] + Ts / L_q * (v_q[k] - R_s * i_q[k] - omega_e[k] * (L_d * i_d[k] + psi_f))
 *
 *       若希望下一拍电流跟踪到参考，可把“已知的那部分电压”先前馈出来：
 *       v_d_ff = R_s * i_d_ref + L_d * Delta_i_d_ref / Ts - omega_e * L_q * i_q
 *       v_q_ff = R_s * i_q_ref + L_q * Delta_i_q_ref / Ts + omega_e * (L_d * i_d + psi_f)
 *
 *       PI 只负责消化模型误差、采样偏置、角度偏差和外部负载扰动。
 */
bool FocCurrentLoop_RunFastStep(FocCurrentLoop_t *loop,
                                const FocPhaseCurrent_t *phase_current,
                                float theta_e_rad,
                                float omega_e_rad_s,
                                float id_ref_a,
                                float iq_ref_a,
                                float vbus_v,
                                float dt_s,
                                FocCurrentLoopTrace_t *out_trace)
{
    const float safe_dt_s = Foc_ClampF(dt_s, FOC_DT_MIN_S, FOC_DT_MAX_S);
    const float safe_vbus_v = Foc_ClampF(vbus_v, FOC_VBUS_MIN_V, FOC_VBUS_MAX_V);
    const float max_current_a = Foc_ClampF(loop->motor.max_current_a, 1.0f, FOC_CURRENT_LIMIT_A);
    const float vutil = Foc_ClampF(loop->motor.voltage_utilization, FOC_VUTIL_MIN, FOC_VUTIL_MAX);
    const float vector_limit_v = vutil * safe_vbus_v * FOC_INV_SQRT3;

    const FocAlphaBeta_t current_ab = Foc_ClarkeTransform(phase_current);
    const FocDq_t current_dq = Foc_ParkTransform(&current_ab, theta_e_rad);

    FocDq_t voltage_ff_dq;
    FocDq_t voltage_pi_dq;
    FocDq_t voltage_unsat_dq;
    FocDq_t voltage_cmd_dq;
    FocAlphaBeta_t voltage_ab;
    FocPwmDuty_t duty;

    float id_ref_limited;
    float iq_ref_limited;
    float did_ref_a_per_s;
    float diq_ref_a_per_s;
    float error_d;
    float error_q;
    float saturation_scale = 1.0f;

    if ((loop == NULL) || (phase_current == NULL) || (loop->pwm.htim_pwm == NULL))
    {
        return false;
    }

    if ((loop->motor.ld_h <= 0.0f) || (loop->motor.lq_h <= 0.0f) || (loop->motor.rs_ohm < 0.0f))
    {
        return false;
    }

    if (safe_vbus_v <= FOC_VBUS_MIN_V)
    {
        return false;
    }

    id_ref_a = Foc_ClampF(id_ref_a, -max_current_a, max_current_a);
    iq_ref_a = Foc_ClampF(iq_ref_a, -max_current_a, max_current_a);

    /* 电流参考本身需要斜率限幅。
     * 否则 Delta_i_ref / Ts 会在单拍大阶跃时生成不现实的前馈电压尖峰。
     */
    id_ref_limited = Foc_LimitReferenceSlew(id_ref_a,
                                            loop->prev_id_ref_a,
                                            loop->motor.max_ref_slew_a_per_s,
                                            safe_dt_s);
    iq_ref_limited = Foc_LimitReferenceSlew(iq_ref_a,
                                            loop->prev_iq_ref_a,
                                            loop->motor.max_ref_slew_a_per_s,
                                            safe_dt_s);

    did_ref_a_per_s = (id_ref_limited - loop->prev_id_ref_a) / safe_dt_s;
    diq_ref_a_per_s = (iq_ref_limited - loop->prev_iq_ref_a) / safe_dt_s;

    voltage_ff_dq.d =
        (loop->motor.rs_ohm * id_ref_limited) +
        (loop->motor.ld_h * did_ref_a_per_s) -
        (omega_e_rad_s * loop->motor.lq_h * current_dq.q);

    voltage_ff_dq.q =
        (loop->motor.rs_ohm * iq_ref_limited) +
        (loop->motor.lq_h * diq_ref_a_per_s) +
        (omega_e_rad_s * ((loop->motor.ld_h * current_dq.d) + loop->motor.psi_f_wb));

    error_d = id_ref_limited - current_dq.d;
    error_q = iq_ref_limited - current_dq.q;

    voltage_pi_dq.d = (loop->id_pi.kp * error_d) + loop->id_pi.integrator;
    voltage_pi_dq.q = (loop->iq_pi.kp * error_q) + loop->iq_pi.integrator;

    voltage_unsat_dq.d = voltage_ff_dq.d + voltage_pi_dq.d;
    voltage_unsat_dq.q = voltage_ff_dq.q + voltage_pi_dq.q;

    voltage_cmd_dq = voltage_unsat_dq;
    Foc_LimitVoltageVector(&voltage_cmd_dq, vector_limit_v, &saturation_scale);

    /* back-calculation 抗积分饱和：
     * int[k+1] = int[k] + (ki * e + kaw * (u_sat - u_unsat)) * Ts
     *
     * 当电压矢量被限幅时，(u_sat - u_unsat) 为负反馈项，
     * 它会主动把积分器从“已经实现不了的指令”上拉回来。
     */
    loop->id_pi.integrator +=
        ((loop->id_pi.ki * error_d) + (loop->id_pi.kaw * (voltage_cmd_dq.d - voltage_unsat_dq.d))) *
        safe_dt_s;
    loop->iq_pi.integrator +=
        ((loop->iq_pi.ki * error_q) + (loop->iq_pi.kaw * (voltage_cmd_dq.q - voltage_unsat_dq.q))) *
        safe_dt_s;

    loop->id_pi.integrator = Foc_ClampF(loop->id_pi.integrator, -vector_limit_v, vector_limit_v);
    loop->iq_pi.integrator = Foc_ClampF(loop->iq_pi.integrator, -vector_limit_v, vector_limit_v);

    voltage_ab = Foc_InverseParkTransform(&voltage_cmd_dq, theta_e_rad);
    duty = Foc_AlphaBetaToCenterAlignedDuty(&voltage_ab, safe_vbus_v, &loop->pwm);
    Foc_WriteDutyToTimer(&loop->pwm, &duty);

    loop->prev_id_ref_a = id_ref_limited;
    loop->prev_iq_ref_a = iq_ref_limited;

    if (out_trace != NULL)
    {
        out_trace->current_dq = current_dq;
        out_trace->voltage_ff_dq = voltage_ff_dq;
        out_trace->voltage_pi_dq = voltage_pi_dq;
        out_trace->voltage_cmd_dq = voltage_cmd_dq;
        out_trace->vector_limit_v = vector_limit_v;
        out_trace->saturation_scale = saturation_scale;
    }

    return true;
}

extern TIM_HandleTypeDef htim1;

static FocCurrentLoop_t g_foc_current_loop =
{
    .motor =
    {
        .rs_ohm = 0.18f,
        .ld_h = 0.00032f,
        .lq_h = 0.00036f,
        .psi_f_wb = 0.018f,
        .max_current_a = 28.0f,
        .voltage_utilization = 0.94f,
        .max_ref_slew_a_per_s = 80000.0f
    },
    .pwm =
    {
        .htim_pwm = &htim1,
        .channel_u = TIM_CHANNEL_1,
        .channel_v = TIM_CHANNEL_2,
        .channel_w = TIM_CHANNEL_3,
        .period_ticks = 3600U,
        .duty_min = FOC_DUTY_MIN,
        .duty_max = FOC_DUTY_MAX
    },
    .id_pi = {.kp = 1.8f, .ki = 900.0f, .kaw = 4000.0f, .integrator = 0.0f},
    .iq_pi = {.kp = 1.6f, .ki = 850.0f, .kaw = 4000.0f, .integrator = 0.0f},
    .prev_id_ref_a = 0.0f,
    .prev_iq_ref_a = 0.0f
};

void App_FocFastLoop20kHz(const FocPhaseCurrent_t *phase_current,
                          float theta_e_rad,
                          float omega_e_rad_s,
                          float torque_current_ref_a,
                          float vbus_v)
{
    FocCurrentLoopTrace_t trace;

    /* 表贴式 PMSM 的常见基线是 i_d_ref = 0A，
     * 把绝大部分电压预算留给 q 轴转矩；若进入弱磁区，再由上层慢环改写 i_d_ref。
     */
    (void)FocCurrentLoop_RunFastStep(&g_foc_current_loop,
                                     phase_current,
                                     theta_e_rad,
                                     omega_e_rad_s,
                                     0.0f,
                                     torque_current_ref_a,
                                     vbus_v,
                                     0.00005f,
                                     &trace);

    /* trace 可用于 SWV、UART 或上位机观测：
     * 1. 若 voltage_ff_dq.q 长期接近 vector_limit_v，说明主要瓶颈是反电动势；
     * 2. 若 saturation_scale 频繁小于 1，说明母线电压预算已不足；
     * 3. 若 i_d 在 iq 大负载时持续偏离 0A，说明交叉耦合补偿或角度链路仍有误差。
     */
    (void)trace;
}
```

这段实现最值得关注的地方，不是 `kp/ki` 数字本身，而是它把电流环里最容易被“经验调参”掩盖的账目显式摊开了:

- `R_s * i_ref`、`L * Delta_i_ref / T_s`、`omega * L * i` 和 `omega * psi_f` 先进入前馈，意味着模型里本来就知道的电压不再让 PI 去慢慢猜。
- dq 两轴在合成后按矢量模长统一限幅，确保母线不够时系统承认“整支电压矢量”预算不足，而不是假装只是某一路 PI 碰到了边界。
- `back-calculation` 把饱和残差直接回灌进积分器，让系统在退出饱和区时还能迅速收敛，而不是拖着一大笔历史积分债务。
- `Delta_i_ref / T_s` 前先做参考斜率限幅，承认控制器生活在有限 `Vdc` 里，而不是生活在连续数学的无限电压世界里。

真正成熟的 FOC 电流环，并不是“把 Clarke / Park 跑起来再多拧几次 PI”，而是先看清楚同一份母线电压到底被 **欧姆压降**、**电感动态**、**交叉耦合**、**反电动势** 和 **饱和恢复** 各拿走了多少。只有这份账本自洽，所谓带宽、转矩响应和高速稳定性才不是偶然现象，而是电磁模型与数字控制共同兑现出来的结果。
