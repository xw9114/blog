---
title: "技能档案：FOC 编码器零电角标定、极对数识别与 d/q 轴错位误差"
slug: "skill-foc-encoder-electrical-zero-and-pole-pair-calibration"
date: 2026-05-28T18:05:16+08:00
draft: false
description: "从机械角到电角的映射、极对数误配到零电角偏差引发的 d/q 轴串扰，系统拆解 FOC 标定为什么首先是一份坐标合同。"
tags: ["FOC", "STM32", "编码器", "零电角", "极对数", "Park变换", "PMSM"]
categories: ["技能档案"]
image: ""
---

## 技能概述

带编码器的 FOC 看起来像是“传感器一接上、电角一算出、电流环一闭合”就该自然稳定，但真正把系统拉开差距的，通常不是 PI 参数，而是坐标系本身是否说的是同一种语言。伺服轮、云台、关节电机、轮毂电机和高响应风机控制，都依赖机械角、极对数、零电角和 Park 变换之间那条看不见的映射链；只要其中一个量错半拍，`i_d` 和 `i_q` 就会互相串轴，扭矩塌陷、发热上升、低速抖动和反向不对称会一起出现。这个主题真正解决的痛点，不是“怎么读编码器”，而是如何把编码器计数、磁链空间位置和 d/q 轴控制目标收束成一份闭环可验证的坐标合同。

## 核心底层概念解析

- **机械角** 不是 **电角**：永磁同步电机里，机械转子转一圈，电角往往已经绕了 `p` 圈，其中 `p` 是极对数，因此核心映射永远是 `theta_e = dir * p * theta_m - theta_e_offset`。控制器调的是磁场相位，不是编码器刻度本身。
- **极对数** 不是静态铭牌参数，而是空间周期压缩比**：它决定了机械坐标被“折叠”成电角坐标的倍数。极对数填错时，系统不会立刻报错，而是表现为“能转、但总不对劲”：某些角度扭矩充足，某些角度突然发软，本质上是控制器在错误的空间频率上追磁场。
- **零电角** 不是编码器 Z 相，也不是机械装配零位**：它的物理意义，是当定子 d 轴磁场指向某个参考方向时，转子永磁体在编码器坐标里的对应位置。它描述的是“磁链对齐关系”，而不是“结构装配参考点”。
- **d/q 轴错位误差会把纯扭矩命令旋转成励磁误差**：若真实电角为 `theta_e`，控制器用的是 `theta_e + delta`，则估计坐标系相对真实坐标系多转了 `delta`。对于实际电流向量，有
  ` [i_d_hat, i_q_hat]^T = R(-delta) [i_d, i_q]^T `。
  当你以为自己在给纯 `i_q` 扭矩电流时，真实系统里已经混入了 `i_d_actual = i_q_cmd * sin(delta)`，而有效扭矩项衰减为 `i_q_actual = i_q_cmd * cos(delta)`。
- **几度零点误差不是“小偏差”，而是可量化的扭矩损失**：例如 `delta = 10°` 时，`cos(10°) ≈ 0.985`，表面看扭矩只损失约 `1.5%`；但同时 `sin(10°) ≈ 0.174`，也就是额外灌入了 `17.4%` 的 d 轴分量。对表贴式 PMSM，这通常直接变成铜耗和发热；对内嵌式 PMSM，还可能把磁阻转矩和弱磁边界一并搅乱。
- **方向符号 `dir` 是左手系和右手系的裁判**：编码器计数递增方向、正电角旋转方向、ABC 相序定义只要有一处与软件假设相反，系统就会在“算得出角度”的前提下输出相反转矩。很多“闭环一上电就发疯”的故障，本质不是控制参数错，而是坐标手性不一致。
- **开环对齐本质上是一场静态能量最小化实验**：给定一个固定 d 轴电压或电流矢量，转子会在磁阻和永磁体耦合作用下寻找最小势能位置。标定不是让电机“转起来”，而是借助这次可控对齐，把编码器坐标里的某个角度锚定为电角零点。
- **极对数识别可以从“已知电角扫频”反推“机械位移”**：当你在开环下让定子电角缓慢扫过 `Delta theta_e`，而转子可靠跟随时，就有 `p ≈ Delta theta_e / Delta theta_m`。这不是经验技巧，而是机械空间与磁空间一一映射的直接反演。
- **编码器分辨率要先折算到电角域，才知道它够不够用**：若编码器每机械圈计数为 `CPR`，则电角分辨率近似为
  `Delta theta_e_lsb = 360° * p / CPR`。
  电机极对数越高，同一只编码器在电角域里的量化越粗；高极对数低分辨率系统即便能跑，也更容易在低速时出现 `i_q` 纹波和速度齿槽感。
- **圆周平均和角度解包是标定里必须显式处理的数学细节**：`359°` 和 `1°` 的平均不是 `180°`。只要标定还停留在线性平均，结果就会在跨零点时瞬间失真。工程上必须在单位圆上做 `atan2(sum(sin), sum(cos))`，同时对编码器计数做环形解包。
- **反向扫回不是多余步骤，而是拿来对抗静摩擦、齿槽力矩和间隙偏置**：单次正向对齐可能被负载偏心、联轴器回差或轴承预紧拖偏；做一次正扫、一次反扫，再比较机械位移对称性，才能知道标定结果到底是坐标映射，还是某次偶然卡在了局部势阱里。
- **技术哲学上，FOC 的第一性问题不是变换公式，而是坐标契约**：Clarke/Park 把三相量压成 d/q 量，只是数学表达；而零电角、极对数和方向符号，决定了这个表达是否真的贴着物理世界。坐标系一旦签错合同，后面的电流环、速度环和位置环只是在更快地放大一个高精度误会。

## 代码能力展现

下面给出一个基于 STM32 HAL 的编码器 FOC 标定示例。代码目标不是做一套完整驱动，而是把三件真正关键的事情放在一起完成：其一，用开环 d 轴注入把转子磁链拉到可重复的参考位置；其二，用正反向电角慢扫识别极对数与方向符号；其三，把编码器机械角转成可存入 Flash 的 `zero_electrical_offset_rad`，供后续在线角度计算直接使用。

```c
#include "stm32f4xx_hal.h"

#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#define FOC_CALIB_TWO_PI                        6.28318530718f
#define FOC_CALIB_PI                            3.14159265359f
#define FOC_CALIB_SQRT3                         1.73205080757f
#define FOC_CALIB_INV_SQRT3                     0.57735026919f
#define FOC_CALIB_RAD_TO_DEG                    57.2957795f
#define FOC_CALIB_MAX_SWEEP_STEPS               4096U
#define FOC_CALIB_MIN_VBUS_V                    6.0f
#define FOC_CALIB_MAX_POLE_PAIRS                32U
#define FOC_CALIB_MIN_ENCODER_CPR               64U

typedef struct
{
    TIM_HandleTypeDef *htim_pwm;
    uint32_t channel_u;
    uint32_t channel_v;
    uint32_t channel_w;
    TIM_HandleTypeDef *htim_encoder;
    uint32_t pwm_arr;
    uint32_t encoder_cpr;
    float vbus_v;
} FocCalibrationHw_t;

typedef struct
{
    float align_voltage_v;
    uint32_t align_settle_ms;
    uint16_t align_average_samples;
    uint32_t align_sample_interval_ms;
    float sweep_voltage_v;
    float sweep_span_electrical_turns;
    float sweep_speed_elec_rad_s;
    uint32_t sweep_step_ms;
    float max_id_leakage_ratio;
    float max_mech_asymmetry_deg;
} FocCalibrationConfig_t;

typedef struct
{
    uint8_t pole_pairs;
    int8_t direction_sign;
    float mechanical_align_rad;
    float zero_electrical_offset_rad;
    float electrical_lsb_deg;
    float forward_mech_delta_deg;
    float backward_mech_delta_deg;
    float symmetry_error_deg;
    float recommended_max_zero_error_deg;
    bool valid;
} FocCalibrationResult_t;

static float FocCalib_ClampF(float value, float min_value, float max_value)
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

static float FocCalib_WrapPmPi(float angle_rad)
{
    while (angle_rad > FOC_CALIB_PI)
    {
        angle_rad -= FOC_CALIB_TWO_PI;
    }

    while (angle_rad <= -FOC_CALIB_PI)
    {
        angle_rad += FOC_CALIB_TWO_PI;
    }

    return angle_rad;
}

static float FocCalib_Wrap0To2Pi(float angle_rad)
{
    while (angle_rad >= FOC_CALIB_TWO_PI)
    {
        angle_rad -= FOC_CALIB_TWO_PI;
    }

    while (angle_rad < 0.0f)
    {
        angle_rad += FOC_CALIB_TWO_PI;
    }

    return angle_rad;
}

static int32_t FocCalib_EncoderDeltaCount(uint32_t current,
                                          uint32_t previous,
                                          uint32_t encoder_cpr)
{
    int32_t delta = (int32_t)current - (int32_t)previous;
    const int32_t half_span = (int32_t)encoder_cpr / 2;

    /* 编码器计数是模 CPR 的环形量。
     * 若相邻两次读取跨过 0 点，需要把差值解包成最短路径，
     * 否则会把 +2 count 误判成 -(CPR-2) count。
     */
    if (delta > half_span)
    {
        delta -= (int32_t)encoder_cpr;
    }
    else if (delta < -half_span)
    {
        delta += (int32_t)encoder_cpr;
    }

    return delta;
}

static float FocCalib_CountToMechanicalRad(uint32_t count, uint32_t encoder_cpr)
{
    return ((float)count * FOC_CALIB_TWO_PI) / (float)encoder_cpr;
}

/**
 * @brief 将三相电压参考映射为三路中心对齐 PWM 占空比。
 * @param hw 标定硬件对象。
 * @param v_alpha alpha 轴电压指令。
 * @param v_beta beta 轴电压指令。
 *
 * @note 逆 Clarke 变换为：
 *       v_a = v_alpha
 *       v_b = -0.5 * v_alpha + sqrt(3) / 2 * v_beta
 *       v_c = -0.5 * v_alpha - sqrt(3) / 2 * v_beta
 *
 *       为了充分利用母线电压，采用零序偏置：
 *       v_offset = (max(v_a, v_b, v_c) + min(v_a, v_b, v_c)) / 2
 *       duty_x   = 0.5 + (v_x - v_offset) / Vbus
 *
 *       其中 duty_x 会被限幅到 [0.02, 0.98]，避免高低桥臂贴边导通。
 */
static void FocCalib_SetAlphaBetaVoltage(const FocCalibrationHw_t *hw,
                                         float v_alpha,
                                         float v_beta)
{
    const float duty_min = 0.02f;
    const float duty_max = 0.98f;
    const float half = 0.5f;

    float v_a = v_alpha;
    float v_b = (-half * v_alpha) + (0.5f * FOC_CALIB_SQRT3 * v_beta);
    float v_c = (-half * v_alpha) - (0.5f * FOC_CALIB_SQRT3 * v_beta);

    float v_max = fmaxf(v_a, fmaxf(v_b, v_c));
    float v_min = fminf(v_a, fminf(v_b, v_c));
    float v_offset = 0.5f * (v_max + v_min);

    float duty_u = 0.5f + ((v_a - v_offset) / hw->vbus_v);
    float duty_v = 0.5f + ((v_b - v_offset) / hw->vbus_v);
    float duty_w = 0.5f + ((v_c - v_offset) / hw->vbus_v);

    uint32_t ccr_u = 0U;
    uint32_t ccr_v = 0U;
    uint32_t ccr_w = 0U;

    duty_u = FocCalib_ClampF(duty_u, duty_min, duty_max);
    duty_v = FocCalib_ClampF(duty_v, duty_min, duty_max);
    duty_w = FocCalib_ClampF(duty_w, duty_min, duty_max);

    ccr_u = (uint32_t)lroundf((float)hw->pwm_arr * duty_u);
    ccr_v = (uint32_t)lroundf((float)hw->pwm_arr * duty_v);
    ccr_w = (uint32_t)lroundf((float)hw->pwm_arr * duty_w);

    __HAL_TIM_SET_COMPARE(hw->htim_pwm, hw->channel_u, ccr_u);
    __HAL_TIM_SET_COMPARE(hw->htim_pwm, hw->channel_v, ccr_v);
    __HAL_TIM_SET_COMPARE(hw->htim_pwm, hw->channel_w, ccr_w);
}

/**
 * @brief 在给定电角下输出 d/q 电压，用于静态对齐和慢速开环扫角。
 * @param hw 标定硬件对象。
 * @param theta_e_rad 目标电角，单位 rad。
 * @param vd_v d 轴电压。
 * @param vq_v q 轴电压。
 *
 * @note 逆 Park 变换为：
 *       v_alpha = cos(theta_e) * v_d - sin(theta_e) * v_q
 *       v_beta  = sin(theta_e) * v_d + cos(theta_e) * v_q
 *
 *       标定时令 `v_q = 0`，只给 d 轴注入，是为了把转子拉向一个
 *       可重复的静态平衡位置，而不是持续输出转矩。
 */
static void FocCalib_ApplyDQVoltage(const FocCalibrationHw_t *hw,
                                    float theta_e_rad,
                                    float vd_v,
                                    float vq_v)
{
    const float c = cosf(theta_e_rad);
    const float s = sinf(theta_e_rad);

    const float v_alpha = (c * vd_v) - (s * vq_v);
    const float v_beta = (s * vd_v) + (c * vq_v);

    FocCalib_SetAlphaBetaVoltage(hw, v_alpha, v_beta);
}

/**
 * @brief 读取编码器机械角并在单位圆上做均值，抑制量化抖动和跨零误差。
 * @param hw 标定硬件对象。
 * @param sample_count 采样点数。
 * @param sample_interval_ms 相邻采样间隔。
 * @return 平均机械角，范围 [0, 2π)。
 *
 * @note 对圆周变量，必须采用：
 *       theta_mean = atan2(sum(sin(theta_i)), sum(cos(theta_i)))
 *       否则 359° 和 1° 的平均会被错误地算成 180°。
 */
static float FocCalib_SampleMechanicalMean(const FocCalibrationHw_t *hw,
                                           uint16_t sample_count,
                                           uint32_t sample_interval_ms)
{
    float sum_sin = 0.0f;
    float sum_cos = 0.0f;
    uint16_t i = 0U;

    for (i = 0U; i < sample_count; ++i)
    {
        const uint32_t count = __HAL_TIM_GET_COUNTER(hw->htim_encoder);
        const float theta_m = FocCalib_CountToMechanicalRad(count, hw->encoder_cpr);

        sum_sin += sinf(theta_m);
        sum_cos += cosf(theta_m);

        if ((sample_interval_ms > 0U) && ((i + 1U) < sample_count))
        {
            HAL_Delay(sample_interval_ms);
        }
    }

    return FocCalib_Wrap0To2Pi(atan2f(sum_sin, sum_cos));
}

/**
 * @brief 慢速开环扫过一段电角，并累积对应的机械位移。
 * @param hw 标定硬件对象。
 * @param start_theta_e_rad 起始电角。
 * @param end_theta_e_rad 终止电角。
 * @param vd_v 扫角过程中保持的 d 轴电压。
 * @param sweep_speed_elec_rad_s 电角扫描速度。
 * @param step_ms 每步停留时间。
 * @param out_accumulated_mech_count 输出机械累计位移计数。
 * @return true 表示扫描成功。
 *
 * @note 极对数可由
 *       p ~= Delta_theta_e / Delta_theta_m
 *       反推得到。为了让该式成立，扫角必须足够慢，使转子能准静态跟随，
 *       否则得到的不是磁空间映射，而是失步后的瞬态响应。
 */
static bool FocCalib_SweepElectricalAngle(const FocCalibrationHw_t *hw,
                                          float start_theta_e_rad,
                                          float end_theta_e_rad,
                                          float vd_v,
                                          float sweep_speed_elec_rad_s,
                                          uint32_t step_ms,
                                          int32_t *out_accumulated_mech_count)
{
    const float step_dt_s = (float)step_ms * 0.001f;
    const float total_span_rad = end_theta_e_rad - start_theta_e_rad;
    uint32_t step_count = 0U;
    uint32_t i = 0U;
    uint32_t prev_count = __HAL_TIM_GET_COUNTER(hw->htim_encoder);
    int32_t accumulated_count = 0;

    if ((out_accumulated_mech_count == NULL) ||
        (sweep_speed_elec_rad_s <= 0.0f) ||
        (step_dt_s <= 0.0f))
    {
        return false;
    }

    step_count = (uint32_t)ceilf(fabsf(total_span_rad) / (sweep_speed_elec_rad_s * step_dt_s));
    step_count = (uint32_t)FocCalib_ClampF((float)step_count, 1.0f, (float)FOC_CALIB_MAX_SWEEP_STEPS);

    for (i = 1U; i <= step_count; ++i)
    {
        const float ratio = (float)i / (float)step_count;
        const float theta_e = start_theta_e_rad + (total_span_rad * ratio);
        uint32_t current_count = 0U;

        /* 这里固定 q 轴为 0，仅保持 d 轴吸附。
         * 标定阶段不是为了发出可用扭矩，而是为了让磁链方向可观测、可重复。
         */
        FocCalib_ApplyDQVoltage(hw, theta_e, vd_v, 0.0f);
        HAL_Delay(step_ms);

        /* 分段读取并解包 encoder 计数，避免整段扫描跨过 0 点时出现大跳变。 */
        current_count = __HAL_TIM_GET_COUNTER(hw->htim_encoder);
        accumulated_count += FocCalib_EncoderDeltaCount(current_count, prev_count, hw->encoder_cpr);
        prev_count = current_count;
    }

    *out_accumulated_mech_count = accumulated_count;
    return true;
}

/**
 * @brief 执行 FOC 编码器标定，输出极对数、方向和零电角偏移。
 * @param hw 标定硬件对象。
 * @param cfg 标定配置。
 * @param out_result 输出标定结果。
 * @return true 表示标定结果有效。
 *
 * @note 在线角度计算应使用：
 *       theta_e = wrap(dir * pole_pairs * theta_m - theta_e_offset)
 *
 *       若零电角误差为 delta，且控制器命令纯 q 轴电流 `i_q_cmd`，
 *       则真实 d/q 轴分量约为：
 *       i_d_actual = i_q_cmd * sin(delta)
 *       i_q_actual = i_q_cmd * cos(delta)
 *
 *       因此若允许的 d 轴泄漏比例为 lambda，
 *       可接受的零点误差近似满足：
 *       |delta|max <= asin(lambda)
 */
static bool FocCalib_Run(const FocCalibrationHw_t *hw,
                         const FocCalibrationConfig_t *cfg,
                         FocCalibrationResult_t *out_result)
{
    const float sweep_span_elec_rad =
        FOC_CALIB_TWO_PI * FocCalib_ClampF(cfg->sweep_span_electrical_turns, 1.0f, 16.0f);
    const float allowed_id_ratio = FocCalib_ClampF(cfg->max_id_leakage_ratio, 0.01f, 0.5f);

    float theta_align_rad = 0.0f;
    float forward_mech_delta_rad = 0.0f;
    float backward_mech_delta_rad = 0.0f;
    float mean_mech_delta_rad = 0.0f;
    float pole_pair_estimate = 0.0f;
    float symmetry_error_deg = 0.0f;
    int32_t forward_mech_count = 0;
    int32_t backward_mech_count = 0;
    int8_t direction_sign = 1;
    uint8_t pole_pairs = 0U;

    if ((hw == NULL) ||
        (cfg == NULL) ||
        (out_result == NULL) ||
        (hw->htim_pwm == NULL) ||
        (hw->htim_encoder == NULL) ||
        (hw->encoder_cpr < FOC_CALIB_MIN_ENCODER_CPR) ||
        (hw->vbus_v < FOC_CALIB_MIN_VBUS_V))
    {
        return false;
    }

    memset(out_result, 0, sizeof(*out_result));

    HAL_TIM_PWM_Start(hw->htim_pwm, hw->channel_u);
    HAL_TIM_PWM_Start(hw->htim_pwm, hw->channel_v);
    HAL_TIM_PWM_Start(hw->htim_pwm, hw->channel_w);
    HAL_TIM_Encoder_Start(hw->htim_encoder, TIM_CHANNEL_ALL);

    /* 第一步：固定电角 0，给 d 轴一个温和的吸附电压，让转子磁链找齐。 */
    FocCalib_ApplyDQVoltage(hw, 0.0f, cfg->align_voltage_v, 0.0f);
    HAL_Delay(cfg->align_settle_ms);

    theta_align_rad = FocCalib_SampleMechanicalMean(hw,
                                                    cfg->align_average_samples,
                                                    cfg->align_sample_interval_ms);

    /* 第二步：正向慢扫若干电角周期，累计机械位移。 */
    if (!FocCalib_SweepElectricalAngle(hw,
                                       0.0f,
                                       sweep_span_elec_rad,
                                       cfg->sweep_voltage_v,
                                       cfg->sweep_speed_elec_rad_s,
                                       cfg->sweep_step_ms,
                                       &forward_mech_count))
    {
        return false;
    }

    HAL_Delay(cfg->align_settle_ms);

    /* 第三步：反向扫回原点，用对称性检查静摩擦与齿槽干扰。 */
    if (!FocCalib_SweepElectricalAngle(hw,
                                       sweep_span_elec_rad,
                                       0.0f,
                                       cfg->sweep_voltage_v,
                                       cfg->sweep_speed_elec_rad_s,
                                       cfg->sweep_step_ms,
                                       &backward_mech_count))
    {
        return false;
    }

    /* 回到零矢量，避免标定结束后继续吸附转子。 */
    FocCalib_SetAlphaBetaVoltage(hw, 0.0f, 0.0f);

    forward_mech_delta_rad =
        ((float)forward_mech_count * FOC_CALIB_TWO_PI) / (float)hw->encoder_cpr;
    backward_mech_delta_rad =
        ((float)backward_mech_count * FOC_CALIB_TWO_PI) / (float)hw->encoder_cpr;

    direction_sign = (forward_mech_delta_rad >= 0.0f) ? 1 : -1;
    mean_mech_delta_rad = 0.5f * (fabsf(forward_mech_delta_rad) + fabsf(backward_mech_delta_rad));

    if (mean_mech_delta_rad <= 1e-4f)
    {
        return false;
    }

    pole_pair_estimate = sweep_span_elec_rad / mean_mech_delta_rad;
    pole_pairs = (uint8_t)lroundf(FocCalib_ClampF(pole_pair_estimate,
                                                  1.0f,
                                                  (float)FOC_CALIB_MAX_POLE_PAIRS));

    symmetry_error_deg =
        fabsf(fabsf(forward_mech_delta_rad) - fabsf(backward_mech_delta_rad)) * FOC_CALIB_RAD_TO_DEG;

    out_result->pole_pairs = pole_pairs;
    out_result->direction_sign = direction_sign;
    out_result->mechanical_align_rad = theta_align_rad;
    out_result->zero_electrical_offset_rad =
        FocCalib_Wrap0To2Pi((float)direction_sign * (float)pole_pairs * theta_align_rad);
    out_result->electrical_lsb_deg =
        360.0f * (float)pole_pairs / (float)hw->encoder_cpr;
    out_result->forward_mech_delta_deg = forward_mech_delta_rad * FOC_CALIB_RAD_TO_DEG;
    out_result->backward_mech_delta_deg = backward_mech_delta_rad * FOC_CALIB_RAD_TO_DEG;
    out_result->symmetry_error_deg = symmetry_error_deg;
    out_result->recommended_max_zero_error_deg =
        asinf(allowed_id_ratio) * FOC_CALIB_RAD_TO_DEG;

    /* 有效性判据不追求“学术最优”，而是用工程边界做第一轮筛选：
     * 1. 电角量化不能太粗；
     * 2. 正反扫的机械位移不能明显失配；
     * 3. 极对数估计值要接近整数，否则说明转子没跟住。
     */
    out_result->valid =
        (fabsf(pole_pair_estimate - (float)pole_pairs) <= 0.2f) &&
        (out_result->electrical_lsb_deg <= out_result->recommended_max_zero_error_deg) &&
        (symmetry_error_deg <= cfg->max_mech_asymmetry_deg);

    return out_result->valid;
}

/**
 * @brief 根据标定结果在线计算电角。
 * @param encoder_count 当前编码器计数。
 * @param result 标定结果。
 * @param encoder_cpr 编码器每机械圈计数。
 * @return 供 Park 变换使用的电角，范围 (-pi, pi]。
 */
static float FocCalib_ComputeElectricalAngle(uint32_t encoder_count,
                                             const FocCalibrationResult_t *result,
                                             uint32_t encoder_cpr)
{
    const float theta_m = FocCalib_CountToMechanicalRad(encoder_count, encoder_cpr);
    const float theta_e =
        ((float)result->direction_sign * (float)result->pole_pairs * theta_m) -
        result->zero_electrical_offset_rad;

    return FocCalib_WrapPmPi(theta_e);
}

static const FocCalibrationConfig_t k_foc_calibration_cfg =
{
    .align_voltage_v = 1.2f,
    .align_settle_ms = 400U,
    .align_average_samples = 32U,
    .align_sample_interval_ms = 2U,
    .sweep_voltage_v = 1.4f,
    .sweep_span_electrical_turns = 6.0f,
    .sweep_speed_elec_rad_s = 2.5f,
    .sweep_step_ms = 4U,
    .max_id_leakage_ratio = 0.10f,
    .max_mech_asymmetry_deg = 3.0f
};

static FocCalibrationHw_t g_foc_hw =
{
    .htim_pwm = &htim1,
    .channel_u = TIM_CHANNEL_1,
    .channel_v = TIM_CHANNEL_2,
    .channel_w = TIM_CHANNEL_3,
    .htim_encoder = &htim3,
    .pwm_arr = 3599U,
    .encoder_cpr = 16384U,
    .vbus_v = 24.0f
};

bool Motor_RunElectricalZeroCalibration(FocCalibrationResult_t *out_result)
{
    return FocCalib_Run(&g_foc_hw, &k_foc_calibration_cfg, out_result);
}
```

这段代码刻意把“电角映射”本身当成一个独立可验证对象，而不是顺手塞进启动流程的几行偏置计算。实际工程里，标定结果通常要连同 `pole_pairs`、`direction_sign` 和 `zero_electrical_offset_rad` 一起存入 Flash；下一次上电再结合编码器读数实时计算 `theta_e`，此时电流环与速度环才有资格谈“调参”，否则它们只是建立在错误坐标系上的快速反馈。
