---
title: "技能档案：FOC 的电压圆限幅、SVPWM 零序注入与母线利用率边界"
slug: "skill-foc-voltage-circle-limiting-svpwm-zero-sequence-and-dc-bus-utilization"
date: 2026-06-22T10:12:21+08:00
draft: false
description: "从 dq 电压指令、两电平逆变器的六边形线性区到零序注入与抗饱和回写，系统拆解 FOC 为什么常死在可用母线电压而不是 Clarke/Park 公式。"
tags: ["FOC", "STM32", "SVPWM", "PMSM", "零序注入", "母线利用率", "电压限幅"]
categories: ["技能档案", "电机控制"]
image: ""
---

## 技能概述

很多人把 `FOC` 理解成“电流采样 + Clarke/Park 变换 + 两路 PI + PWM 输出”，但真正把系统推到中高速、大扭矩、母线下陷或者弱磁边界时，决定成败的往往不是控制律本身，而是 **逆变器此刻到底还剩多少可兑现的电压向量**。`i_q` 跟不上、相电流畸变、母线一掉压就啸叫、过调制后波形突然发脏，本质上都指向同一个问题：**dq 坐标系里的理想电压命令，最终必须穿过两电平开关桥的线性调制边界，映射成受死区、采样窗与母线幅值约束的真实占空比**。这个主题真正要解决的，是把 **电压圆限幅**、**SVPWM 零序注入**、**母线利用率预算** 和 **抗饱和回写** 串成一份能落到 `STM32 HAL` 快环里的电压兑现合同。

## 核心底层概念解析

- **逆变器不是理想电压源，而是一个离散开关网络**：三相桥每个桥臂在一个载波周期内只能在 `+Vdc/2` 和 `-Vdc/2` 之间切换。控制器给出的 `v_d`、`v_q` 不是直接“施加”到电机上的，而是先要变成一个在开关平均意义下可实现的空间矢量。
- **FOC 里的电压限制首先出现在 `alpha/beta` 平面，而不是 d 轴或 q 轴单独维度**：对两电平逆变器的线性 `SVPWM` 区间，可实现的空间矢量端点构成一个正六边形；其内切圆半径决定了 dq 电压命令可被无失真的保守边界，常写成 `|V_ref| <= Vdc / sqrt(3)`。所以工程上更合理的限幅方式是  
  `sqrt(v_d^2 + v_q^2) <= k_util * Vdc / sqrt(3)`，  
  其中 `k_util < 1` 给死区、电流采样窗、器件压降和参数误差预留余量。
- **电压圆不是几何装饰，而是“控制器承诺能力”的边界**：若把 `v_d`、`v_q` 分别各自截断，向量方向会发生旋转，等于把“想要的磁链方向”和“最终生成的相电压方向”拆成两份合同。向量模长统一缩放，才不会破坏 FOC 本来的坐标语义。
- **零序注入利用的是三相桥对公共模式电压的不敏感**：相电压命令从 `alpha/beta` 逆变换回 `u/v/w` 后，并不是只能原样送给 PWM。由于  
  `v_uv = v_u - v_v`、`v_vw = v_v - v_w`，  
  若三相同时加上同一个 `v_0`，线电压不变，电机磁链看到的 `alpha/beta` 向量也不变。于是可取  
  `v_0 = -0.5 * (max(v_u, v_v, v_w) + min(v_u, v_v, v_w))`，  
  把三相参考整体平移到载波窗口中央，最大化母线利用率。
- **`SVPWM` 比正弦 PWM 更省母线，本质不是“算法更高级”，而是更充分使用了六边形边界**：纯正弦调制相当于把参考向量限制在较小的圆里；零序注入后，向量仍保持同样方向，却能更接近六边形边界，因此同一条母线能兑换出更大的基波电压。
- **过调制不是白送的额外增益，而是非线性失真交易**：一旦参考向量越过线性区，桥臂占空比就会顶到 `0` 或 `1`，波形开始被剪平，电流环看到的对象不再近似线性。此时若 PI 积分器继续按“理想电压仍可兑现”累加，退出饱和后就会留下长尾和反冲。
- **母线利用率 `k_util` 必须主动让位给工程现实**：死区会侵蚀有效导通时间，低侧采样需要保留电流重构窗口，`Vce`/`Rds_on` 会吞掉部分幅值，母线纹波又会让瞬时 `Vdc` 上下摆动。把 `k_util` 固定写成 `1.0`，相当于假设电力级、采样链路和时钟永远完美。
- **抗饱和回写的核心不是“保护 PI”，而是把已承诺但未兑现的电压及时记账**：若 PI 输出 `v_unsat`，实际经过限幅与调制后只能施加 `v_sat`，则  
  `integrator[k+1] = integrator[k] + ki * e[k] * dt + kaw * (v_sat - v_unsat)`。  
  这项回写会直接告诉积分器：“你刚才想给的电压，母线没有兑现那么多。”它让积分状态重新贴近物理现实。
- **`Vdc` 应该用实时测量值，而不是标称值**：电机急加速、刹车回灌、电池内阻、DC-Link 电容 ESR 都会让母线在毫秒甚至更短时间尺度上波动。若调制器还按静态 `24V`、`48V` 去算，电压限幅就会比真实世界乐观。
- **中心对齐 PWM 与采样时刻协同，是“电压能用”与“电流可测”之间的资源调度**：占空比推到边缘后，某些相的有效导通窗口会短到不足以完成 ADC 采样与运放建立。很多系统不是电压向量数学上不可达，而是采样链路在那个占空组合下已经先失真了。
- **技术哲学上，FOC 不只是磁场定向，更是一次实时预算分配**：电流环、弱磁环和速度环都在索取电压；逆变器、采样窗和母线纹波则在持续压缩可用额度。成熟系统的关键，不是“把目标写得更理想”，而是先承认资源是有限的，再把每一伏母线电压用在最有价值的方向上。

## 代码能力展现

下面给出一个基于 `STM32 HAL` 的 `SVPWM` 调制与抗饱和回写示例。场景假设如下：

- `TIM1` 工作在中心对齐 PWM 模式，更新频率 `20 kHz`。
- 当前快环已经得到了 `v_d_ref`、`v_q_ref`，需要把它们映射成三相占空比。
- `ADC` 实时测得母线电压 `vdc_meas`，用于动态计算线性调制边界。
- 代码重点不在重复讲 `Park` 变换，而在把 **dq 向量限幅 -> 零序注入 -> 占空比映射 -> 反算实际施加电压 -> 抗饱和回写** 这条链真正打通。

```c
#include "main.h"

#include <math.h>
#include <stdbool.h>
#include <stdint.h>

#define FOC_PI_F                               3.14159265359f
#define FOC_TWO_PI_F                           6.28318530718f
#define FOC_SQRT3_F                            1.73205080757f
#define FOC_INV_SQRT3_F                        0.57735026919f
#define FOC_HALF_SQRT3_F                       0.86602540378f

#define FOC_VBUS_MIN_V                         8.0f
#define FOC_VBUS_MAX_V                         80.0f
#define FOC_VUTIL_MIN                          0.70f
#define FOC_VUTIL_MAX                          0.98f
#define FOC_DT_MIN_S                           0.00002f
#define FOC_DT_MAX_S                           0.00020f
#define FOC_DUTY_MIN                           0.02f
#define FOC_DUTY_MAX                           0.98f
#define FOC_CURRENT_REF_LIMIT_A                60.0f

typedef struct
{
    float d;
    float q;
} FocDq_t;

typedef struct
{
    float alpha;
    float beta;
} FocAlphaBeta_t;

typedef struct
{
    float u;
    float v;
    float w;
} FocPhaseVoltage_t;

typedef struct
{
    float duty_u;
    float duty_v;
    float duty_w;
} FocDuty_t;

typedef struct
{
    float kp;
    float ki;
    float kaw;
    float integrator;
} FocPIController_t;

typedef struct
{
    TIM_HandleTypeDef *htim_pwm;
    uint32_t channel_u;
    uint32_t channel_v;
    uint32_t channel_w;
    uint32_t arr_ticks;
    float duty_min;
    float duty_max;
} FocPwmBridge_t;

typedef struct
{
    FocPwmBridge_t pwm;
    FocPIController_t id_pi;
    FocPIController_t iq_pi;
    float voltage_utilization;
    float current_limit_a;
} FocVoltageLoop_t;

typedef struct
{
    FocDq_t voltage_unsat_dq;
    FocDq_t voltage_cmd_dq;
    FocDq_t voltage_applied_dq;
    float vector_limit_v;
    float saturation_scale;
    float zero_sequence_v;
    bool duty_clamped;
} FocVoltageTrace_t;

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

static FocDq_t Foc_LimitCurrentRef(const FocDq_t *reference, float current_limit_a)
{
    FocDq_t out = *reference;
    const float abs_limit = Foc_ClampF(current_limit_a, 1.0f, FOC_CURRENT_REF_LIMIT_A);

    out.d = Foc_ClampF(out.d, -abs_limit, abs_limit);
    out.q = Foc_ClampF(out.q, -abs_limit, abs_limit);
    return out;
}

/**
 * @brief 把 d/q 电压矢量旋回定子静止 alpha/beta 平面。
 * @param voltage_dq d/q 坐标系电压，单位 V。
 * @param theta_e_rad 电角度，单位 rad。
 * @return alpha/beta 坐标系电压。
 *
 * @note 逆 Park 变换:
 *       v_alpha = v_d * cos(theta_e) - v_q * sin(theta_e)
 *       v_beta  = v_d * sin(theta_e) + v_q * cos(theta_e)
 */
static FocAlphaBeta_t Foc_InversePark(const FocDq_t *voltage_dq, float theta_e_rad)
{
    const float s = sinf(theta_e_rad);
    const float c = cosf(theta_e_rad);
    FocAlphaBeta_t voltage_ab;

    voltage_ab.alpha = (voltage_dq->d * c) - (voltage_dq->q * s);
    voltage_ab.beta = (voltage_dq->d * s) + (voltage_dq->q * c);
    return voltage_ab;
}

/**
 * @brief 把 alpha/beta 电压投影回三相桥臂平均相电压参考。
 * @param voltage_ab alpha/beta 坐标系电压，单位 V。
 * @return 三相桥臂参考电压，单位 V。
 *
 * @note 逆 Clarke 变换:
 *       v_u = v_alpha
 *       v_v = -0.5 * v_alpha + sqrt(3) / 2 * v_beta
 *       v_w = -0.5 * v_alpha - sqrt(3) / 2 * v_beta
 */
static FocPhaseVoltage_t Foc_InverseClarke(const FocAlphaBeta_t *voltage_ab)
{
    FocPhaseVoltage_t phase_voltage;

    phase_voltage.u = voltage_ab->alpha;
    phase_voltage.v = (-0.5f * voltage_ab->alpha) + (FOC_HALF_SQRT3_F * voltage_ab->beta);
    phase_voltage.w = (-0.5f * voltage_ab->alpha) - (FOC_HALF_SQRT3_F * voltage_ab->beta);
    return phase_voltage;
}

static FocAlphaBeta_t Foc_ClarkeFromPhaseVoltage(const FocPhaseVoltage_t *phase_voltage)
{
    FocAlphaBeta_t voltage_ab;
    const float v_cm = (phase_voltage->u + phase_voltage->v + phase_voltage->w) / 3.0f;
    const float v_u = phase_voltage->u - v_cm;
    const float v_v = phase_voltage->v - v_cm;

    /*
     * 零序注入与占空比钳位会让三相桥臂平均电压带有公共模式分量。
     * 电机磁链真正看到的是去掉公共模式后的线电压等效量，
     * 因此这里先减去 v_cm，再执行 Clarke 反算。
     */
    voltage_ab.alpha = v_u;
    voltage_ab.beta = (v_u + (2.0f * v_v)) * FOC_INV_SQRT3_F;
    return voltage_ab;
}

/**
 * @brief 将 alpha/beta 电压旋回 d/q 坐标系，用于抗饱和回写。
 * @param voltage_ab alpha/beta 坐标系电压，单位 V。
 * @param theta_e_rad 电角度，单位 rad。
 * @return d/q 坐标系电压。
 *
 * @note Park 变换:
 *       v_d =  v_alpha * cos(theta_e) + v_beta * sin(theta_e)
 *       v_q = -v_alpha * sin(theta_e) + v_beta * cos(theta_e)
 */
static FocDq_t Foc_Park(const FocAlphaBeta_t *voltage_ab, float theta_e_rad)
{
    const float s = sinf(theta_e_rad);
    const float c = cosf(theta_e_rad);
    FocDq_t voltage_dq;

    voltage_dq.d = (voltage_ab->alpha * c) + (voltage_ab->beta * s);
    voltage_dq.q = (-voltage_ab->alpha * s) + (voltage_ab->beta * c);
    return voltage_dq;
}

/**
 * @brief 计算 SVPWM 的保守线性矢量边界。
 * @param vdc_bus_v 实时母线电压，单位 V。
 * @param utilization 用户配置的利用率系数。
 * @return dq 平面内可兑现的最大矢量模长，单位 V。
 *
 * @note 线性 SVPWM 区的保守边界可写成:
 *       |V_ref|max = k_util * Vdc / sqrt(3)
 *
 *       其中:
 *       1. Vdc / sqrt(3) 是两电平逆变器线性区的经典矢量半径；
 *       2. k_util < 1 用于给死区、器件压降、采样窗和母线纹波留余量。
 */
static float Foc_GetVectorLimitV(float vdc_bus_v, float utilization)
{
    const float safe_vdc = Foc_ClampF(vdc_bus_v, FOC_VBUS_MIN_V, FOC_VBUS_MAX_V);
    const float safe_util = Foc_ClampF(utilization, FOC_VUTIL_MIN, FOC_VUTIL_MAX);

    return safe_util * safe_vdc * FOC_INV_SQRT3_F;
}

/**
 * @brief 对 d/q 电压向量做统一模长限幅，保持方向不变。
 * @param voltage_dq 输入 d/q 电压向量，单位 V。
 * @param vector_limit_v 允许的最大矢量模长，单位 V。
 * @param saturation_scale 输出缩放系数，1 表示未限幅。
 * @return 限幅后的 d/q 电压向量。
 *
 * @note 统一缩放公式:
 *       scale = min(1, V_limit / sqrt(v_d^2 + v_q^2))
 *       [v_d_sat, v_q_sat] = scale * [v_d, v_q]
 *
 *       这样做不会旋转电压矢量方向，等于在有限母线预算下保留最重要的场向信息。
 */
static FocDq_t Foc_LimitVoltageVectorDq(const FocDq_t *voltage_dq,
                                        float vector_limit_v,
                                        float *saturation_scale)
{
    FocDq_t out = *voltage_dq;
    const float magnitude = sqrtf((out.d * out.d) + (out.q * out.q));

    *saturation_scale = 1.0f;

    if ((magnitude > vector_limit_v) && (magnitude > 1.0e-6f))
    {
        *saturation_scale = vector_limit_v / magnitude;
        out.d *= *saturation_scale;
        out.q *= *saturation_scale;
    }

    return out;
}

/**
 * @brief 计算 SVPWM 零序注入量，把三相参考平移到载波窗中央。
 * @param phase_voltage_raw 未注入零序的三相参考电压，单位 V。
 * @return 公共模式零序电压，单位 V。
 *
 * @note 令:
 *       v_0 = -0.5 * (max(v_u, v_v, v_w) + min(v_u, v_v, v_w))
 *
 *       则新的三相桥臂参考:
 *       v'_x = v_x + v_0
 *
 *       因为三相同时加同一个 v_0，不改变线电压差值，
 *       所以不会改变 alpha/beta 空间矢量，只会改善母线窗口利用。
 */
static float Foc_ComputeZeroSequenceV(const FocPhaseVoltage_t *phase_voltage_raw)
{
    float vmax = phase_voltage_raw->u;
    float vmin = phase_voltage_raw->u;

    if (phase_voltage_raw->v > vmax)
    {
        vmax = phase_voltage_raw->v;
    }

    if (phase_voltage_raw->w > vmax)
    {
        vmax = phase_voltage_raw->w;
    }

    if (phase_voltage_raw->v < vmin)
    {
        vmin = phase_voltage_raw->v;
    }

    if (phase_voltage_raw->w < vmin)
    {
        vmin = phase_voltage_raw->w;
    }

    return -0.5f * (vmax + vmin);
}

/**
 * @brief 将桥臂平均相电压映射为占空比。
 * @param phase_voltage 三相桥臂平均相电压，单位 V。
 * @param vdc_bus_v 实时母线电压，单位 V。
 * @param bridge PWM 桥对象。
 * @param duty_clamped 输出是否发生占空比钳位。
 * @return 三相占空比。
 *
 * @note 两电平桥臂平均电压与占空比关系:
 *       v_leg = (duty - 0.5) * Vdc
 *       duty  = 0.5 + v_leg / Vdc
 *
 *       最终 duty 还会被限制在 [duty_min, duty_max]，给采样窗和死区留出缓冲。
 */
static FocDuty_t Foc_PhaseVoltageToDuty(const FocPhaseVoltage_t *phase_voltage,
                                        float vdc_bus_v,
                                        const FocPwmBridge_t *bridge,
                                        bool *duty_clamped)
{
    const float safe_vdc = Foc_ClampF(vdc_bus_v, FOC_VBUS_MIN_V, FOC_VBUS_MAX_V);
    FocDuty_t duty;

    *duty_clamped = false;

    duty.duty_u = 0.5f + (phase_voltage->u / safe_vdc);
    duty.duty_v = 0.5f + (phase_voltage->v / safe_vdc);
    duty.duty_w = 0.5f + (phase_voltage->w / safe_vdc);

    if ((duty.duty_u < bridge->duty_min) || (duty.duty_u > bridge->duty_max) ||
        (duty.duty_v < bridge->duty_min) || (duty.duty_v > bridge->duty_max) ||
        (duty.duty_w < bridge->duty_min) || (duty.duty_w > bridge->duty_max))
    {
        *duty_clamped = true;
    }

    duty.duty_u = Foc_ClampF(duty.duty_u, bridge->duty_min, bridge->duty_max);
    duty.duty_v = Foc_ClampF(duty.duty_v, bridge->duty_min, bridge->duty_max);
    duty.duty_w = Foc_ClampF(duty.duty_w, bridge->duty_min, bridge->duty_max);
    return duty;
}

static FocPhaseVoltage_t Foc_DutyToPhaseVoltage(const FocDuty_t *duty, float vdc_bus_v)
{
    const float safe_vdc = Foc_ClampF(vdc_bus_v, FOC_VBUS_MIN_V, FOC_VBUS_MAX_V);
    FocPhaseVoltage_t phase_voltage;

    phase_voltage.u = (duty->duty_u - 0.5f) * safe_vdc;
    phase_voltage.v = (duty->duty_v - 0.5f) * safe_vdc;
    phase_voltage.w = (duty->duty_w - 0.5f) * safe_vdc;
    return phase_voltage;
}

static void Foc_WriteDutyToTimer(const FocPwmBridge_t *bridge, const FocDuty_t *duty)
{
    const uint32_t ccr_u = (uint32_t)lrintf(duty->duty_u * (float)bridge->arr_ticks);
    const uint32_t ccr_v = (uint32_t)lrintf(duty->duty_v * (float)bridge->arr_ticks);
    const uint32_t ccr_w = (uint32_t)lrintf(duty->duty_w * (float)bridge->arr_ticks);

    __HAL_TIM_SET_COMPARE(bridge->htim_pwm, bridge->channel_u, ccr_u);
    __HAL_TIM_SET_COMPARE(bridge->htim_pwm, bridge->channel_v, ccr_v);
    __HAL_TIM_SET_COMPARE(bridge->htim_pwm, bridge->channel_w, ccr_w);
}

/**
 * @brief 把 dq 电压命令调制成 SVPWM 占空比，并反算实际施加电压。
 * @param loop FOC 电压环对象。
 * @param voltage_ref_dq 输入 d/q 电压命令，单位 V。
 * @param theta_e_rad 电角度，单位 rad。
 * @param vdc_bus_v 实时母线电压，单位 V。
 * @param trace 输出调制轨迹。
 *
 * @note 关键步骤:
 *       1. 在 dq 平面做统一电压圆限幅；
 *       2. 逆 Park / 逆 Clarke 得到三相桥臂参考；
 *       3. 施加零序注入，提高母线利用率；
 *       4. 映射占空比并写入定时器；
 *       5. 再由最终 duty 反算 voltage_applied_dq，供抗饱和回写使用。
 */
static void Foc_ModulateVoltage(FocVoltageLoop_t *loop,
                                const FocDq_t *voltage_ref_dq,
                                float theta_e_rad,
                                float vdc_bus_v,
                                FocVoltageTrace_t *trace)
{
    FocAlphaBeta_t voltage_ab;
    FocAlphaBeta_t applied_ab;
    FocPhaseVoltage_t phase_voltage_raw;
    FocPhaseVoltage_t phase_voltage_shifted;
    FocPhaseVoltage_t phase_voltage_applied;
    FocDuty_t duty;

    trace->vector_limit_v = Foc_GetVectorLimitV(vdc_bus_v, loop->voltage_utilization);
    trace->voltage_cmd_dq = Foc_LimitVoltageVectorDq(voltage_ref_dq,
                                                     trace->vector_limit_v,
                                                     &trace->saturation_scale);

    voltage_ab = Foc_InversePark(&trace->voltage_cmd_dq, theta_e_rad);
    phase_voltage_raw = Foc_InverseClarke(&voltage_ab);

    trace->zero_sequence_v = Foc_ComputeZeroSequenceV(&phase_voltage_raw);
    phase_voltage_shifted.u = phase_voltage_raw.u + trace->zero_sequence_v;
    phase_voltage_shifted.v = phase_voltage_raw.v + trace->zero_sequence_v;
    phase_voltage_shifted.w = phase_voltage_raw.w + trace->zero_sequence_v;

    duty = Foc_PhaseVoltageToDuty(&phase_voltage_shifted,
                                  vdc_bus_v,
                                  &loop->pwm,
                                  &trace->duty_clamped);

    Foc_WriteDutyToTimer(&loop->pwm, &duty);

    phase_voltage_applied = Foc_DutyToPhaseVoltage(&duty, vdc_bus_v);
    applied_ab = Foc_ClarkeFromPhaseVoltage(&phase_voltage_applied);
    trace->voltage_applied_dq = Foc_Park(&applied_ab, theta_e_rad);
}

/**
 * @brief 执行一次 d/q 电压 PI 与抗饱和回写。
 * @param loop FOC 电压环对象。
 * @param current_ref_dq 电流参考，单位 A。
 * @param current_meas_dq 电流反馈，单位 A。
 * @param theta_e_rad 电角度，单位 rad。
 * @param vdc_bus_v 实时母线电压，单位 V。
 * @param dt_s 本次快环步长，单位 s。
 * @param trace 输出调制轨迹。
 *
 * @note 抗饱和回写采用 back-calculation:
 *       integrator[k+1] = integrator[k]
 *                       + ki * e[k] * dt
 *                       + kaw * (v_applied - v_unsat)
 *
 *       最后一项显式告诉积分器:
 *       "刚才那一拍你要求的电压，逆变器并没有完全兑现。"
 */
void Foc_CurrentVoltageStep(FocVoltageLoop_t *loop,
                            const FocDq_t *current_ref_dq,
                            const FocDq_t *current_meas_dq,
                            float theta_e_rad,
                            float vdc_bus_v,
                            float dt_s,
                            FocVoltageTrace_t *trace)
{
    FocDq_t current_ref_limited;
    FocDq_t current_error;
    const float dt_safe = Foc_ClampF(dt_s, FOC_DT_MIN_S, FOC_DT_MAX_S);

    current_ref_limited = Foc_LimitCurrentRef(current_ref_dq, loop->current_limit_a);

    current_error.d = current_ref_limited.d - current_meas_dq->d;
    current_error.q = current_ref_limited.q - current_meas_dq->q;

    trace->voltage_unsat_dq.d = loop->id_pi.integrator + (loop->id_pi.kp * current_error.d);
    trace->voltage_unsat_dq.q = loop->iq_pi.integrator + (loop->iq_pi.kp * current_error.q);

    Foc_ModulateVoltage(loop, &trace->voltage_unsat_dq, theta_e_rad, vdc_bus_v, trace);

    loop->id_pi.integrator += (loop->id_pi.ki * current_error.d * dt_safe) +
                              (loop->id_pi.kaw * (trace->voltage_applied_dq.d - trace->voltage_unsat_dq.d));
    loop->iq_pi.integrator += (loop->iq_pi.ki * current_error.q * dt_safe) +
                              (loop->iq_pi.kaw * (trace->voltage_applied_dq.q - trace->voltage_unsat_dq.q));
}
```

这段代码的关键不在于“成功输出了三路 PWM”，而在于它把几条常被拆开的约束重新接回了一起：`dq` 平面的统一限幅守住了磁场方向，零序注入把三相参考压回载波窗中央，实时 `Vdc` 让母线掉压不会被算法假装看不见，而 `v_applied - v_unsat` 的回写则让积分器知道哪些电压承诺已经落空。对 FOC 来说，这比单纯把 `kp/ki` 再拧大一点更接近系统真实边界。
