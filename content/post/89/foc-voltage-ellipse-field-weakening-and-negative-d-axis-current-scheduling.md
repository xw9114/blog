---
title: "技能档案：FOC 基速以上的电压椭圆、弱磁控制与负 d 轴电流调度"
slug: "skill-foc-voltage-ellipse-field-weakening-and-negative-d-axis-current-scheduling"
date: 2026-07-13T09:07:01+08:00
draft: false
description: "从 PMSM 的 dq 电压方程、电压椭圆与基速边界，到负 d 轴去磁、MTPA 让位与弱磁 PI 余量闭环，系统拆解 FOC 为什么在高速区常败给母线电压而不是扭矩命令。"
tags: ["FOC", "STM32", "PMSM", "弱磁控制", "电压椭圆", "负d轴", "电机控制"]
categories: ["技能档案", "电机控制", "控制与融合"]
image: ""
---

## 技能概述

很多人第一次把 `FOC` 跑起来时，会觉得系统的主矛盾已经结束：电流能闭环、速度能拉升、`SVPWM` 也在正常出波。但电机一旦越过基速，母线电压开始不够用，真正接管系统的就不再是“PI 参数是否再调一点”，而是 **永磁磁链、交叉耦合项、母线余量、采样带宽与负 d 轴电流预算能否签成同一份高速合同**。这个主题要解决的核心痛点，是把 `FOC` 在基速以上的控制问题重新还原成一张**电流平面里的电压椭圆**：你要多少 `i_q` 才能保住扭矩、又要打入多少负 `i_d` 才能把反电动势压回母线窗口，同时还不能把电流圆、电流环带宽和铜耗一起推爆。

## 核心底层概念解析

- **基速不是数据手册上的单点，而是“母线可兑现电压”与“转子反电动势”第一次相撞的地方**：对 `PMSM` 的 `dq` 模型，常见近似写成  
  `v_d = R_s i_d - ω_e L_q i_q`，  
  `v_q = R_s i_q + ω_e (ψ_f + L_d i_d)`。  
  当 `i_d ≈ 0`、`ω_e` 继续上升时，`v_q` 里的 `ω_e ψ_f` 会最先把母线窗口吃光，所以“基速”本质上是电压预算而不是转速铭牌。

- **一旦把速度固定，电压限制会从 dq 电压平面里的圆，投影成 id/iq 平面里的椭圆**：若定义可用相电压极限 `V_lim ≈ k_util * V_bus / sqrt(3)`，并先忽略 `R_s`，则有  
  `(ω_e L_q i_q)^2 + (ω_e (L_d i_d + ψ_f))^2 <= V_lim^2`。  
  整理后得到  
  `(i_q / (V_lim / (ω_e L_q)))^2 + ((i_d + ψ_f / L_d) / (V_lim / (ω_e L_d)))^2 <= 1`。  
  这就是高速区最重要的物理图像：**速度越高，椭圆越收缩；你能保住的扭矩电流区域会越来越小。**

- **弱磁控制的本质不是“故意加错 d 轴电流”，而是用负 `i_d` 主动抵消永磁体带来的固定磁链**：因为 `ψ_eff = ψ_f + L_d i_d`，而弱磁阶段 `i_d < 0`，所以等效磁链会被拉小，`v_q` 中那项随速度线性增长的 `ω_e ψ_eff` 也随之下降。你牺牲的是一部分电流额度和铜耗，换回来的是高速区继续可控的电压空间。

- **电流圆与电压椭圆的交集，才是高速区真正允许你站立的区域**：逆变器、电流采样与热设计通常会给出 `i_d^2 + i_q^2 <= I_max^2`。因此一旦你把 `i_d` 往负方向推得更深，留给扭矩的 `i_q` 上限会同步缩小：  
  `i_q,max = sqrt(I_max^2 - i_d^2)`。  
  工程上最痛的地方正在这里：弱磁不是免费高速，它是**用磁链去换速度，用电流额度去换可兑现电压**。

- **低速区的最优目标通常是 MTPA，高速区才轮到弱磁接管**：对 `L_q > L_d` 的 `IPMSM`，最小电流给定扭矩的近似轨迹可写成  
  `i_d,mtpa ≈ (ψ_f - sqrt(ψ_f^2 + 4ΔL^2 i_q^2)) / (2ΔL)`，`ΔL = L_q - L_d`。  
  这条轨迹的意义不是追求数学优雅，而是承认“同样的扭矩，在 saliency 允许时可以少烧一点铜”。但当 `V_est` 已接近 `V_lim`，最优目标就必须从 **每安培最大转矩** 切换成 **每伏特可活下来**。

- **母线纹波会让基速边界在每个 PWM 周期都轻微呼吸**：`V_lim` 并不是常数，刹车回灌、电池内阻、DC-Link 电容 ESR、负载突变都会让 `V_bus` 产生可见波动。于是弱磁控制真正对付的不是单一阈值，而是一个不断抖动的高速边界。只按标称 `24V`、`48V` 去规划 `i_d`，在台架上能跑，在实机上往往一脚油门就啸叫。

- **参数误差会直接投影成弱磁过度或不足**：`L_d`、`L_q`、`R_s` 与 `ψ_f` 都会随温升、饱和和工作点变化。若 `ψ_f` 估小了，你会晚进弱磁，`v_q` 先撞顶；若 `L_d` 估大了，你会以为一小撮负 `i_d` 就能去掉很多磁链，结果高速区还是不够压。弱磁失败常常不是控制器没工作，而是**模型已经背离了被控对象**。

- **模式切换若没有回差，MTPA 与弱磁会在边界反复争抢控制权**：当 `V_est / V_lim` 恰好在 1 附近摇摆时，若进入阈值与退出阈值相同，参考值会在 `i_d,mtpa` 和更负的 `i_d,fw` 之间来回跳，电流环看到的就是一串人工注入的低频扰动。因此成熟实现通常会使用类似 `0.98 / 0.93` 的电压比回差，承认边界本来就有测量噪声。

- **负 d 轴参考不能跳变，它同样受电感和母线约束**：从 `v = L di/dt` 出发，单步参考的物理上界近似满足  
  `|Δi_d|max ≈ (V_lim / L_d) * T_s`，  
  `|Δi_q|max ≈ (V_lim / L_q) * T_s`。  
  这意味着弱磁参考调度本身也必须是一个离散化的驱动问题，而不是一句“算出目标值后立即赋值”。参考跳得比电流环能追的还快，只会把 PI 顶进饱和。

- **基速以上的扭矩塌缩，本质上是能量、磁链与时间预算同时失配**：如果你只盯 `i_q`，会忽略母线不够；如果你只盯 `i_d`，会把扭矩榨干；如果你只盯平均 `V_bus`，会错过瞬时低谷；如果你只盯连续公式，又会忘记参考更新本身受采样频率和 ISR 带宽限制。真正成熟的高速 `FOC`，从来不是一条公式取胜，而是把这些约束在代码里同时记账。

## 代码能力展现

下面给出一段基于 **STM32 HAL** 风格的弱磁参考调度骨架。代码刻意把重点放在五件真正决定高速区是否还能稳定出扭矩的事情上：

- 先根据 `PMSM` 参数估算 **MTPA 电流轨迹**；
- 再用 `dq` 电压模型计算 **当前工作点是否已经碰到电压椭圆**；
- 一旦越界，就用 **负 d 轴弱磁 PI** 与解析磁链下界同时把参考往安全区拉；
- 然后用 **电流圆约束** 保住总电流上界；
- 最后再依据 `v = L di/dt` 对参考本身做 **斜率限幅**，确保当前环真的追得上。

这段代码假设：

- 电流快环本身已经存在，`id_ref/iq_ref` 只是它的外部参考；
- 本文代码运行在一个较慢的控制节拍中，例如 `TIM6` 触发的 `1 kHz` 参考调度中断；
- 电角速度、母线电压与扭矩请求由其他模块提供；
- 真正的电流 PI、Park/Clarke 与 PWM 调制仍由你的快环完成。

```c
#include "main.h"

#include <math.h>
#include <stdbool.h>
#include <stdint.h>

#define FOC_FW_SQRT3_F                        1.73205080757f
#define FOC_FW_INV_SQRT3_F                    0.57735026919f
#define FOC_FW_MIN_VBUS_V                     6.0f
#define FOC_FW_MAX_VBUS_V                     100.0f
#define FOC_FW_MIN_TS_S                       1.0e-6f
#define FOC_FW_MAX_TS_S                       5.0e-3f
#define FOC_FW_MIN_CURRENT_LIMIT_A            0.5f
#define FOC_FW_MAX_CURRENT_LIMIT_A            300.0f
#define FOC_FW_MIN_INDUCTANCE_H               1.0e-6f
#define FOC_FW_MIN_FLUX_WB                    1.0e-5f
#define FOC_FW_MIN_SPEED_RAD_S                1.0f
#define FOC_FW_MIN_DENOM                      1.0e-4f
#define FOC_FW_MAX_SOLVER_ITER                4U

typedef struct
{
    float id_a;
    float iq_a;
} FocFwCurrentRef_t;

typedef struct
{
    float vd_v;
    float vq_v;
} FocFwVoltageDq_t;

typedef struct
{
    float rs_ohm;
    float ld_h;
    float lq_h;
    float psi_f_wb;
    uint8_t pole_pairs;
} PmsmMotorParam_t;

typedef enum
{
    FOC_FW_MODE_MTPA = 0U,
    FOC_FW_MODE_FIELD_WEAKENING
} FocFwMode_t;

typedef struct
{
    float current_limit_a;              /* 电流圆半径 I_max */
    float id_min_a;                     /* 允许的最负 d 轴电流，通常由热/退磁边界给出 */
    float vbus_utilization;             /* 线性调制 + 采样窗综合利用率，典型 0.85~0.95 */

    float fw_kp;
    float fw_ki;
    float fw_kaw;
    float fw_integrator_a;              /* 积分状态记录的是“需要多少额外负 d 轴” */

    float id_rate_limit_a_s;
    float iq_rate_limit_a_s;

    float enter_ratio;
    float exit_ratio;
    float mtpa_bias_a;                  /* 用于补偿模型误差的经验偏置，可为 0 */

    FocFwMode_t mode;
    FocFwCurrentRef_t ref_z1;
} FocFieldWeakeningCtrl_t;

typedef struct
{
    float torque_request_nm;
    float omega_e_rad_s;
    float vbus_v;
    float dt_s;
} FocFwInput_t;

typedef struct
{
    FocFwCurrentRef_t mtpa_ref;
    FocFwCurrentRef_t raw_target;
    FocFwCurrentRef_t limited_target;

    FocFwVoltageDq_t voltage_est;
    float v_limit_v;
    float v_est_v;
    float voltage_margin_v;
    float id_flux_floor_a;
    float id_pi_a;
    float iq_limit_a;
    uint8_t entered_weakening;
} FocFwTrace_t;

extern TIM_HandleTypeDef htim6;
extern float Motion_GetTorqueRequestNm(void);
extern float Observer_GetElectricalSpeedRadS(void);
extern float PowerStage_GetBusVoltage(void);

static volatile float g_id_ref_a = 0.0f;
static volatile float g_iq_ref_a = 0.0f;
static FocFwTrace_t g_fw_trace;

static PmsmMotorParam_t g_motor =
{
    .rs_ohm = 0.082f,
    .ld_h = 0.00019f,
    .lq_h = 0.00031f,
    .psi_f_wb = 0.0145f,
    .pole_pairs = 7U
};

static FocFieldWeakeningCtrl_t g_fw =
{
    .current_limit_a = 18.0f,
    .id_min_a = -11.0f,
    .vbus_utilization = 0.90f,
    .fw_kp = 0.22f,
    .fw_ki = 80.0f,
    .fw_kaw = 0.18f,
    .fw_integrator_a = 0.0f,
    .id_rate_limit_a_s = 4000.0f,
    .iq_rate_limit_a_s = 6000.0f,
    .enter_ratio = 0.98f,
    .exit_ratio = 0.93f,
    .mtpa_bias_a = 0.0f,
    .mode = FOC_FW_MODE_MTPA,
    .ref_z1 = {0.0f, 0.0f}
};

static float FocFw_ClampF(float value, float min_value, float max_value)
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

static float FocFw_SignF(float value)
{
    if (value > 0.0f)
    {
        return 1.0f;
    }

    if (value < 0.0f)
    {
        return -1.0f;
    }

    return 0.0f;
}

static float FocFw_GetTorqueGain(const PmsmMotorParam_t *motor)
{
    return 1.5f * (float)motor->pole_pairs;
}

/**
 * @brief 根据实时母线电压和利用率系数，计算当前可兑现的相电压极限。
 * @param vbus_v 实时母线电压，单位 V。
 * @param utilization 线性调制利用率，包含死区、采样窗与器件压降余量。
 * @return dq 模型可使用的保守电压半径，单位 V。
 *
 * @note 线性区常取：
 *       V_lim ≈ k_util * V_bus / sqrt(3)
 *
 *       其中 k_util < 1 的原因不是数学保守，而是必须给：
 *       1. 死区与器件压降；
 *       2. 电流采样静默窗；
 *       3. 母线纹波与参数误差
 *       预留边界。
 */
static float FocFw_GetVoltageLimitV(float vbus_v, float utilization)
{
    const float safe_vbus = FocFw_ClampF(vbus_v, FOC_FW_MIN_VBUS_V, FOC_FW_MAX_VBUS_V);
    const float safe_util = FocFw_ClampF(utilization, 0.60f, 0.98f);

    return safe_util * safe_vbus * FOC_FW_INV_SQRT3_F;
}

/**
 * @brief 按 PMSM dq 模型估算某组电流参考需要的定子电压。
 * @param motor 电机参数。
 * @param omega_e_rad_s 电角速度，单位 rad/s。
 * @param ref 电流参考，单位 A。
 * @return dq 电压估计值，单位 V。
 *
 * @note 使用的近似模型为：
 *       v_d = R_s * i_d - ω_e * L_q * i_q
 *       v_q = R_s * i_q + ω_e * (ψ_f + L_d * i_d)
 *
 *       该式刻意保留：
 *       1. d/q 交叉耦合项；
 *       2. 永磁磁链项 ψ_f；
 *       3. 电阻压降项 R_s * i。
 *
 *       因为弱磁区真正决定“会不会撞顶”的，往往不是单独某一项，
 *       而是三者在高速下共同堆出来的电压模长。
 */
static FocFwVoltageDq_t FocFw_EstimateVoltage(const PmsmMotorParam_t *motor,
                                              float omega_e_rad_s,
                                              const FocFwCurrentRef_t *ref)
{
    FocFwVoltageDq_t voltage;

    voltage.vd_v = (motor->rs_ohm * ref->id_a) - (omega_e_rad_s * motor->lq_h * ref->iq_a);
    voltage.vq_v = (motor->rs_ohm * ref->iq_a) +
                   (omega_e_rad_s * (motor->psi_f_wb + motor->ld_h * ref->id_a));
    return voltage;
}

/**
 * @brief 由某组 q 轴电流近似求出 IPMSM 的 MTPA d 轴电流。
 * @param motor 电机参数。
 * @param iq_a 期望 q 轴电流，单位 A。
 * @return MTPA 轨迹下的 d 轴参考，单位 A；若无显著凸极性则返回 0。
 *
 * @note 令 ΔL = L_q - L_d，对于 L_q > L_d 的 IPMSM，
 *       MTPA 轨迹近似满足：
 *       i_d,mtpa ≈ (ψ_f - sqrt(ψ_f^2 + 4 * ΔL^2 * i_q^2)) / (2 * ΔL)
 *
 *       该式来自“给定扭矩下最小化 i_d^2 + i_q^2”的约束最优化；
 *       若 ΔL <= 0，则表面式 PMSM 近似退化为 i_d ≈ 0。
 */
static float FocFw_GetMtpAIdFromIq(const PmsmMotorParam_t *motor, float iq_a)
{
    const float delta_l_h = motor->lq_h - motor->ld_h;
    const float psi_f_wb = FocFw_ClampF(motor->psi_f_wb, FOC_FW_MIN_FLUX_WB, 10.0f);

    if (delta_l_h <= 1.0e-8f)
    {
        return 0.0f;
    }

    return (psi_f_wb - sqrtf((psi_f_wb * psi_f_wb) +
                             (4.0f * delta_l_h * delta_l_h * iq_a * iq_a))) /
           (2.0f * delta_l_h);
}

/**
 * @brief 通过少量定点迭代，把扭矩请求映射到 MTPA 参考点。
 * @param motor 电机参数。
 * @param ctrl 弱磁控制器，用于读取 d 轴偏置与限幅边界。
 * @param torque_request_nm 扭矩请求，单位 N·m。
 * @param out_ref [out] 输出的 MTPA 电流参考。
 *
 * @note 电磁转矩近似满足：
 *       T_e = 1.5 * p * i_q * (ψ_f + (L_d - L_q) * i_d)
 *
 *       因此这里的做法是：
 *       1. 先用 i_d = 0 估一个 i_q 初值；
 *       2. 依据该 i_q 计算 i_d,mtpa；
 *       3. 再把更新后的 i_d 代回转矩方程修正 i_q；
 *       4. 重复若干次，得到稳定的近似解。
 */
static void FocFw_SolveMtpAReference(const PmsmMotorParam_t *motor,
                                     const FocFieldWeakeningCtrl_t *ctrl,
                                     float torque_request_nm,
                                     FocFwCurrentRef_t *out_ref)
{
    float iq_a;
    float id_a = 0.0f;
    const float kt = FocFw_GetTorqueGain(motor);
    const float psi_f = FocFw_ClampF(motor->psi_f_wb, FOC_FW_MIN_FLUX_WB, 10.0f);
    uint32_t iter;

    iq_a = torque_request_nm / FocFw_ClampF(kt * psi_f, FOC_FW_MIN_DENOM, 1000.0f);

    for (iter = 0U; iter < FOC_FW_MAX_SOLVER_ITER; ++iter)
    {
        id_a = FocFw_GetMtpAIdFromIq(motor, iq_a) + ctrl->mtpa_bias_a;
        id_a = FocFw_ClampF(id_a, ctrl->id_min_a, 0.0f);

        {
            const float torque_per_iq = kt * (psi_f + ((motor->ld_h - motor->lq_h) * id_a));

            if (fabsf(torque_per_iq) > FOC_FW_MIN_DENOM)
            {
                iq_a = torque_request_nm / torque_per_iq;
            }
        }
    }

    out_ref->id_a = FocFw_ClampF(id_a, ctrl->id_min_a, 0.0f);
    out_ref->iq_a = iq_a;
}

/**
 * @brief 根据 q 轴电压主项，快速估算弱磁所需的最小 d 轴磁链下界。
 * @param motor 电机参数。
 * @param v_limit_v 当前可用电压上界，单位 V。
 * @param omega_e_rad_s 电角速度，单位 rad/s。
 * @param iq_a 当前目标 q 轴电流，单位 A。
 * @param id_min_a 最负 d 轴允许值。
 * @return 为满足高速电压预算而需要的最小 d 轴参考，单位 A。
 *
 * @note 从 q 轴近似式：
 *       v_q ≈ R_s * i_q + ω_e * (ψ_f + L_d * i_d)
 *
 *       可反求可接受的等效磁链上界：
 *       ψ_allow ≈ (V_lim - |R_s * i_q|) / |ω_e|
 *
 *       则为了满足 ψ_f + L_d * i_d <= ψ_allow，有：
 *       i_d <= (ψ_allow - ψ_f) / L_d
 *
 *       该解不是最终闭环，而是一条解析“地板线”，
 *       用来让弱磁控制在高速突变时更快进入正确方向。
 */
static float FocFw_GetFluxFloorId(const PmsmMotorParam_t *motor,
                                  float v_limit_v,
                                  float omega_e_rad_s,
                                  float iq_a,
                                  float id_min_a)
{
    const float speed_abs = FocFw_ClampF(fabsf(omega_e_rad_s),
                                         FOC_FW_MIN_SPEED_RAD_S,
                                         1.0e7f);
    const float ld_h = FocFw_ClampF(motor->ld_h, FOC_FW_MIN_INDUCTANCE_H, 1.0f);
    const float psi_f = FocFw_ClampF(motor->psi_f_wb, FOC_FW_MIN_FLUX_WB, 10.0f);
    const float resistive_drop_v = fabsf(motor->rs_ohm * iq_a);
    const float psi_allow_wb = (v_limit_v - resistive_drop_v) / speed_abs;
    const float id_floor_a = (psi_allow_wb - psi_f) / ld_h;

    return FocFw_ClampF(id_floor_a, id_min_a, 0.0f);
}

/**
 * @brief 根据电压超限量生成额外的负 d 轴电流，带回算抗饱和。
 * @param ctrl 弱磁控制器。
 * @param voltage_error_v 电压超限量，定义为 V_est - V_target，单位 V。
 * @param dt_s 当前离散步长，单位 s。
 * @return 由 PI 产生的 d 轴弱磁参考，范围为 [id_min, 0]。
 *
 * @note 这里的积分状态记账的是“额外负 d 轴需求量”，近似公式为：
 *       mag_unsat = Kp * e_v + I
 *       I[k+1]    = I[k] + Ki * e_v * dt + Kaw * (mag_sat - mag_unsat)
 *       i_d,fw    = -mag_sat
 *
 *       e_v > 0 说明电压估计已经超过目标余量，此时需要更深的负 d 轴；
 *       e_v < 0 则积分状态会自动退回，避免系统一直挂在过深弱磁区。
 */
static float FocFw_RunVoltageMarginPI(FocFieldWeakeningCtrl_t *ctrl,
                                      float voltage_error_v,
                                      float dt_s)
{
    const float id_mag_limit_a = fabsf(ctrl->id_min_a);
    const float kp = FocFw_ClampF(ctrl->fw_kp, 0.0f, 1000.0f);
    const float ki = FocFw_ClampF(ctrl->fw_ki, 0.0f, 100000.0f);
    const float kaw = FocFw_ClampF(ctrl->fw_kaw, 0.0f, 10.0f);
    const float unsat_mag_a = (kp * voltage_error_v) + ctrl->fw_integrator_a;
    const float sat_mag_a = FocFw_ClampF(unsat_mag_a, 0.0f, id_mag_limit_a);

    ctrl->fw_integrator_a += (ki * dt_s * voltage_error_v) + (kaw * (sat_mag_a - unsat_mag_a));
    ctrl->fw_integrator_a = FocFw_ClampF(ctrl->fw_integrator_a, 0.0f, id_mag_limit_a);

    return -sat_mag_a;
}

/**
 * @brief 将目标参考压回电流圆内，并根据 d 轴占用重新计算可用 q 轴额度。
 * @param ctrl 弱磁控制器。
 * @param ref [in,out] 待约束的电流参考。
 * @param iq_limit_a [out] 当前 d 轴占用下允许的 q 轴最大绝对值。
 *
 * @note 电流圆约束：
 *       i_d^2 + i_q^2 <= I_max^2
 *       => |i_q| <= sqrt(I_max^2 - i_d^2)
 *
 *       这是弱磁控制里最常被忽视的现实：
 *       负 d 轴拉得越深，可用于出扭矩的 q 轴窗口越小。
 */
static void FocFw_ApplyCurrentCircle(const FocFieldWeakeningCtrl_t *ctrl,
                                     FocFwCurrentRef_t *ref,
                                     float *iq_limit_a)
{
    const float current_limit_a = FocFw_ClampF(ctrl->current_limit_a,
                                               FOC_FW_MIN_CURRENT_LIMIT_A,
                                               FOC_FW_MAX_CURRENT_LIMIT_A);
    const float id_clamped_a = FocFw_ClampF(ref->id_a, ctrl->id_min_a, 0.0f);
    const float iq_abs_limit_a = sqrtf(fmaxf((current_limit_a * current_limit_a) -
                                             (id_clamped_a * id_clamped_a),
                                             0.0f));

    ref->id_a = id_clamped_a;
    ref->iq_a = FocFw_ClampF(ref->iq_a, -iq_abs_limit_a, iq_abs_limit_a);
    *iq_limit_a = iq_abs_limit_a;
}

/**
 * @brief 按物理斜率和软件斜率双重约束，对参考本身做离散化限幅。
 * @param motor 电机参数。
 * @param ctrl 弱磁控制器。
 * @param v_limit_v 当前可用电压上界，单位 V。
 * @param dt_s 当前离散步长，单位 s。
 * @param target 目标参考。
 * @return 已限速的新参考。
 *
 * @note 限幅依据来自两层：
 *       1. 软件配置斜率：|Δi| <= rate_limit * dt
 *       2. 物理斜率上界：|Δi_d|max ≈ (V_lim / L_d) * dt
 *                         |Δi_q|max ≈ (V_lim / L_q) * dt
 *
 *       取两者较小值，避免参考跳得比电流环能兑现得更快。
 */
static FocFwCurrentRef_t FocFw_RateLimitReference(const PmsmMotorParam_t *motor,
                                                  FocFieldWeakeningCtrl_t *ctrl,
                                                  float v_limit_v,
                                                  float dt_s,
                                                  const FocFwCurrentRef_t *target)
{
    FocFwCurrentRef_t out = ctrl->ref_z1;
    const float ld_h = FocFw_ClampF(motor->ld_h, FOC_FW_MIN_INDUCTANCE_H, 1.0f);
    const float lq_h = FocFw_ClampF(motor->lq_h, FOC_FW_MIN_INDUCTANCE_H, 1.0f);
    const float sw_id_step_a = FocFw_ClampF(ctrl->id_rate_limit_a_s, 1.0f, 1.0e7f) * dt_s;
    const float sw_iq_step_a = FocFw_ClampF(ctrl->iq_rate_limit_a_s, 1.0f, 1.0e7f) * dt_s;
    const float phy_id_step_a = (v_limit_v / ld_h) * dt_s;
    const float phy_iq_step_a = (v_limit_v / lq_h) * dt_s;
    const float max_id_step_a = fminf(sw_id_step_a, phy_id_step_a);
    const float max_iq_step_a = fminf(sw_iq_step_a, phy_iq_step_a);
    const float delta_id_a = target->id_a - ctrl->ref_z1.id_a;
    const float delta_iq_a = target->iq_a - ctrl->ref_z1.iq_a;

    out.id_a = ctrl->ref_z1.id_a + FocFw_ClampF(delta_id_a, -max_id_step_a, max_id_step_a);
    out.iq_a = ctrl->ref_z1.iq_a + FocFw_ClampF(delta_iq_a, -max_iq_step_a, max_iq_step_a);

    ctrl->ref_z1 = out;
    return out;
}

/**
 * @brief 更新一拍弱磁参考调度，并输出交给电流快环的 id/iq 参考。
 * @param motor 电机参数。
 * @param ctrl 弱磁控制器。
 * @param input 当前拍输入，包括扭矩请求、电角速度、母线电压和步长。
 * @param out_ref [out] 最终参考。
 * @param trace [out] 调试轨迹，可为 NULL。
 * @retval true  参考更新成功。
 * @retval false 参数非法。
 *
 * @note 处理链路如下：
 *       1. 用扭矩请求求出 MTPA 参考；
 *       2. 估算该点所需电压；
 *       3. 若 V_est 逼近或超过 enter_ratio * V_lim，则切到弱磁模式；
 *       4. 在弱磁模式中取 min(id_mtpa, id_flux_floor, id_pi) 作为更负的 d 轴目标；
 *       5. 再由转矩方程反算 q 轴，最后落到电流圆和斜率限幅里。
 */
static bool FocFw_UpdateReference(const PmsmMotorParam_t *motor,
                                  FocFieldWeakeningCtrl_t *ctrl,
                                  const FocFwInput_t *input,
                                  FocFwCurrentRef_t *out_ref,
                                  FocFwTrace_t *trace)
{
    FocFwCurrentRef_t mtpa_ref;
    FocFwCurrentRef_t target_ref;
    FocFwVoltageDq_t mtpa_voltage;
    FocFwVoltageDq_t final_voltage;
    const float dt_s = FocFw_ClampF(input->dt_s, FOC_FW_MIN_TS_S, FOC_FW_MAX_TS_S);
    const float omega_e_rad_s = input->omega_e_rad_s;
    const float v_limit_v = FocFw_GetVoltageLimitV(input->vbus_v, ctrl->vbus_utilization);
    const float kt = FocFw_GetTorqueGain(motor);
    const float v_enter_v = ctrl->enter_ratio * v_limit_v;
    const float v_exit_v = ctrl->exit_ratio * v_limit_v;
    float v_est_v = 0.0f;
    float torque_den = 0.0f;
    float voltage_error_v = 0.0f;
    float id_flux_floor_a = 0.0f;
    float id_pi_a = 0.0f;
    float iq_limit_a = 0.0f;
    uint8_t entered_weakening = 0U;

    if ((motor == NULL) || (ctrl == NULL) || (input == NULL) || (out_ref == NULL))
    {
        return false;
    }

    FocFw_SolveMtpAReference(motor, ctrl, input->torque_request_nm, &mtpa_ref);
    mtpa_voltage = FocFw_EstimateVoltage(motor, omega_e_rad_s, &mtpa_ref);
    v_est_v = sqrtf((mtpa_voltage.vd_v * mtpa_voltage.vd_v) +
                    (mtpa_voltage.vq_v * mtpa_voltage.vq_v));

    if ((ctrl->mode == FOC_FW_MODE_MTPA) && (v_est_v > v_enter_v))
    {
        ctrl->mode = FOC_FW_MODE_FIELD_WEAKENING;
        entered_weakening = 1U;
    }
    else if ((ctrl->mode == FOC_FW_MODE_FIELD_WEAKENING) && (v_est_v < v_exit_v))
    {
        ctrl->mode = FOC_FW_MODE_MTPA;
    }

    target_ref = mtpa_ref;

    if (ctrl->mode == FOC_FW_MODE_FIELD_WEAKENING)
    {
        id_flux_floor_a = FocFw_GetFluxFloorId(motor,
                                               v_limit_v,
                                               omega_e_rad_s,
                                               mtpa_ref.iq_a,
                                               ctrl->id_min_a);
        voltage_error_v = v_est_v - v_enter_v;
        id_pi_a = FocFw_RunVoltageMarginPI(ctrl, voltage_error_v, dt_s);

        /* 负值越小表示弱磁越深，因此取三者中的最小值。 */
        target_ref.id_a = fminf(mtpa_ref.id_a, fminf(id_flux_floor_a, id_pi_a));

        torque_den = kt * (motor->psi_f_wb + ((motor->ld_h - motor->lq_h) * target_ref.id_a));
        if (fabsf(torque_den) < FOC_FW_MIN_DENOM)
        {
            torque_den = FOC_FW_MIN_DENOM * FocFw_SignF((torque_den == 0.0f) ? 1.0f : torque_den);
        }

        target_ref.iq_a = input->torque_request_nm / torque_den;
    }
    else
    {
        /* 退出弱磁时让积分状态自然回卷，避免下一次进入时残留过深负 d 轴。 */
        ctrl->fw_integrator_a *= 0.92f;
        id_pi_a = -ctrl->fw_integrator_a;
    }

    FocFw_ApplyCurrentCircle(ctrl, &target_ref, &iq_limit_a);
    *out_ref = FocFw_RateLimitReference(motor, ctrl, v_limit_v, dt_s, &target_ref);

    final_voltage = FocFw_EstimateVoltage(motor, omega_e_rad_s, out_ref);

    if (trace != NULL)
    {
        trace->mtpa_ref = mtpa_ref;
        trace->raw_target = target_ref;
        trace->limited_target = *out_ref;
        trace->voltage_est = final_voltage;
        trace->v_limit_v = v_limit_v;
        trace->v_est_v = sqrtf((final_voltage.vd_v * final_voltage.vd_v) +
                               (final_voltage.vq_v * final_voltage.vq_v));
        trace->voltage_margin_v = v_limit_v - trace->v_est_v;
        trace->id_flux_floor_a = id_flux_floor_a;
        trace->id_pi_a = id_pi_a;
        trace->iq_limit_a = iq_limit_a;
        trace->entered_weakening = entered_weakening;
    }

    return true;
}

/**
 * @brief 1 kHz 参考调度示例：在 TIM6 周期中断中更新弱磁参考。
 * @param htim 触发本次回调的定时器句柄。
 *
 * @note 这里的节拍故意比电流快环慢，因为：
 *       1. MTPA / 弱磁参考不需要每个 PWM 周期都重算；
 *       2. 让重一些的模型计算留在慢环，可减轻快环 ISR 压力；
 *       3. 电流 PI 与 PWM 调制仍可在更高频率上读取最新 g_id_ref_a / g_iq_ref_a。
 */
void HAL_TIM_PeriodElapsedCallback(TIM_HandleTypeDef *htim)
{
    if (htim == &htim6)
    {
        FocFwInput_t input;
        FocFwCurrentRef_t ref;

        input.torque_request_nm = Motion_GetTorqueRequestNm();
        input.omega_e_rad_s = Observer_GetElectricalSpeedRadS();
        input.vbus_v = PowerStage_GetBusVoltage();
        input.dt_s = 0.001f; /* TIM6 以 1 kHz 触发 */

        if (FocFw_UpdateReference(&g_motor, &g_fw, &input, &ref, &g_fw_trace))
        {
            g_id_ref_a = ref.id_a;
            g_iq_ref_a = ref.iq_a;
        }
    }
}
```

这段实现的重点，不是把弱磁神秘化，而是把它拆回几条可以落地审核的工程合同：

- **模型合同**：`vd/vq` 电压估算必须反映高速区的真实主导项；
- **几何合同**：目标电流必须同时落在电压椭圆和电流圆的交集中；
- **调度合同**：MTPA 与弱磁切换要带回差，不能来回抖动；
- **离散合同**：参考本身的变化速度也必须服从 `v = L di/dt`；
- **实现合同**：慢环负责参考规划，快环负责把它真正兑现成电流。

真正成熟的高速 `FOC`，从来不是“给电机多打一口负 d 轴”这么简单，而是承认 **母线、磁链、速度、电感和离散时间** 都在同时收税，然后把每一安培电流都花在最值钱的地方。
