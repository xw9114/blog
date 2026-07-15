---
title: "技能档案：卡尔曼滤波的第二层防线，从 NIS 门控到协方差恢复"
slug: "skill-kalman-filter-nis-gating-and-covariance-recovery"
date: 2026-05-20T09:06:00+08:00
draft: false
description: "从创新残差、归一化创新平方 NIS、异常观测剔除到协方差恢复，系统拆解卡尔曼滤波如何在传感器说假话时守住状态估计。"
tags: ["卡尔曼滤波", "STM32", "传感器融合", "异常检测", "控制理论"]
categories: ["技能档案", "控制与融合"]
image: ""
---

## 技能概述

很多人第一次把卡尔曼滤波跑起来，关注点都在“曲线是不是更平滑了”；但真正把它带进平衡车、IMU 姿态、云台、轮速估计、视觉定位或工业传感闭环后，最先暴露的问题往往不是滤波公式不够高级，而是**观测并不总是可信**。加速度计会在振动和机动时把线加速度误报成姿态变化，编码器会在打滑时给出假的速度，视觉测量会在遮挡和曝光跳变时突然飘点。如果滤波器对每一笔观测都照单全收，状态会被假消息硬拉偏；如果一味拒绝观测，先验又会在长时间盲飞后变得过度自信。这个主题要解决的，正是卡尔曼滤波的第二层工程问题：**当传感器说假话时，系统如何识别、降权、拒绝，并在失锁后重新建立可信度**。

## 核心底层概念解析

- **创新残差 `y = z - Hx^-` 不是误差项附属品，而是滤波器判断世界是否失真的第一现场**：`x^-` 是先验预测，`z` 是当前观测，`y` 则是“传感器说的”和“模型预言的”之间的分歧。残差本身并不说明谁错了，但它暴露了物理系统、时间同步、坐标映射和噪声模型之间是否还在同一张合同上。
- **残差必须被协方差归一化，才能跨量纲比较**：同样是 `5 deg` 的姿态残差，若当前先验很松、测量噪声也大，它可能是正常波动；若当前 `P^-` 很小、`R` 也很小，那它更像一次异常观测。于是引入 **创新协方差** `S = H P^- H^T + R`，再构造 **归一化创新平方** `NIS = y^T S^{-1} y`。在标量观测下它退化为 `NIS = y^2 / S`，变成一个无量纲可信度指标。
- **NIS 门控本质上不是“看起来像异常就扔掉”，而是在做统计意义上的一致性检验**：若模型和噪声假设大体成立，1 维观测的 `NIS` 近似服从自由度为 1 的卡方分布。因此常见阈值如 `3.84` 对应约 `95%`，`6.63` 对应约 `99%`。超过阈值并不必然说明传感器坏了，但至少说明“这次观测与当前信任预算不一致”。
- **硬拒绝不是唯一手段，软门控往往更贴近工程现实**：很多异常并不是纯粹离群点，而是“这次观测比平时更脏”。例如加速度计模长偏离 `1 g` 一点点、视觉回传抖动变大但还没有彻底失锁。此时直接丢弃容易让状态只剩先验独走，更稳妥的做法是**动态放大测量噪声 `R`**，让卡尔曼增益 `K` 自动减小，给观测降权而不是一刀切。
- **观测可用性是物理可观测性问题，不是软件 if-else 问题**：对姿态估计来说，加速度计只有在 `||a||` 接近 `1 g` 时才更像重力方向传感器；对轮速估计来说，编码器只有在轮胎不明显打滑时才真能代表车体速度；对视觉定位来说，特征点只有在视差、纹理和曝光链路正常时才具备几何意义。门控逻辑真正判断的，是“当前观测是否仍代表了目标物理量”。
- **长时间拒绝观测后，真正危险的不是漂移本身，而是先验过度自信**：如果滤波器连续几十拍只做预测，状态会逐渐漂；但若 `Q` 过小或 `P` 被压得太死，滤波器仍会以为自己很准。等下一次有效观测回来时，过小的 `P^-` 会让 `K` 变小，系统反而拉不回来。这就是为什么工程里常要加入 **协方差恢复** 或 **协方差膨胀**。
- **协方差恢复不是作弊，而是在承认“我刚才其实处于盲飞状态”**：当连续多次观测无效、硬拒绝或明显不一致时，可以适度放大 `P` 的对角项，比如让 `p00`、`p11` 乘上恢复系数。它的物理含义是：我对角度和零偏的自信应该下降，这样一旦可信观测重新出现，增益会更愿意让系统回到现实世界。
- **时间基准 `Delta t` 仍然是这一切的隐性底板**：预测、残差和 `Q` 传播都依赖 `Delta t`。如果采样抖动大、时间戳不准，残差异常未必来自传感器本身，也可能只是模型推进错了时间轴。很多“门控误杀”问题，最后根因不是阈值没调好，而是时基已经先失真。
- **滤波器的技术哲学，不是把每次测量都融合进去，而是决定什么时候该信、该信多少、以及不该信时如何体面地等待下一次可信世界回来**：这才是工程场景里的卡尔曼滤波，而不是课本里的理想高斯游戏。

## 代码能力展现

下面给出一个基于 STM32 HAL 场景的 2 状态俯仰角卡尔曼滤波示例。状态定义为 `x = [angle_deg, gyro_bias_dps]^T`，先验由陀螺积分推进，观测来自加速度计重力投影反解的俯仰角。实现重点不在“把 Kalman 写出来”，而在于把 **NIS 门控、软门控降权、硬拒绝、连续失锁后的协方差恢复** 全部落实到可运行代码里。

```c
#include "stm32f4xx_hal.h"
#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#define KF_PITCH_DT_MIN_S                    0.0005f
#define KF_PITCH_DT_MAX_S                    0.0200f
#define KF_PITCH_ANGLE_LIMIT_DEG             89.0f
#define KF_PITCH_VARIANCE_MIN                1.0e-7f
#define KF_PITCH_VARIANCE_MAX                1.0e5f

#define MPU6050_ACCEL_LSB_PER_G              16384.0f
#define MPU6050_GYRO_LSB_PER_DPS             65.5f
#define RAD_TO_DEG                           57.2957795f

#define KF_PITCH_ACCEL_NORM_MIN_G            0.85f
#define KF_PITCH_ACCEL_NORM_MAX_G            1.15f
#define KF_PITCH_NIS_ACCEPT_1DOF             6.63f
#define KF_PITCH_NIS_REJECT_1DOF             25.0f
#define KF_PITCH_R_INFLATE_MAX               25.0f
#define KF_PITCH_RECOVERY_SCALE              4.0f
#define KF_PITCH_RECOVERY_LIMIT              20U

typedef struct
{
    float angle_deg;
    float bias_dps;
    float unbiased_rate_dps;

    float p00;
    float p01;
    float p10;
    float p11;

    float q_angle;
    float q_bias;
    float r_measure;

    float nis_last;
    float accel_angle_last_deg;
    float accel_norm_last_g;

    uint8_t initialized;
    uint8_t consecutive_untrusted_count;
    uint8_t last_measurement_used;
    uint32_t last_tick_ms;
} KalmanPitchGate_t;

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

static float ClampVariance(float value)
{
    return ClampF32(value, KF_PITCH_VARIANCE_MIN, KF_PITCH_VARIANCE_MAX);
}

/**
 * @brief 初始化带异常观测门控的 2 状态俯仰角卡尔曼滤波器。
 * @param kf 滤波器对象。
 * @param q_angle 角度过程噪声，反映积分先验的不确定度增长速度。
 * @param q_bias 零偏过程噪声，反映陀螺零偏游走强度。
 * @param r_measure 标称测量噪声，反映加速度计反解姿态的基准可信度。
 *
 * @note Q 与 R 的物理含义：
 *       - q_angle 越大，表示越承认陀螺积分先验会快速失真；
 *       - q_bias  越大，表示越承认零偏会随时间游走；
 *       - r_measure 越大，表示越警惕加速度计在振动/机动下说假话。
 */
void KalmanPitchGate_Init(KalmanPitchGate_t *kf,
                          float q_angle,
                          float q_bias,
                          float r_measure)
{
    if (kf == NULL)
    {
        return;
    }

    memset(kf, 0, sizeof(*kf));
    kf->q_angle = ClampVariance(q_angle);
    kf->q_bias = ClampVariance(q_bias);
    kf->r_measure = ClampVariance(r_measure);
}

/**
 * @brief 重置滤波器状态与协方差。
 * @param kf 滤波器对象。
 * @param initial_angle_deg 初始俯仰角。
 * @param initial_bias_dps 初始陀螺零偏。
 * @param initial_variance 初始协方差对角线，用于描述启动时的不确定度。
 */
void KalmanPitchGate_Reset(KalmanPitchGate_t *kf,
                           float initial_angle_deg,
                           float initial_bias_dps,
                           float initial_variance)
{
    const float safe_variance = ClampVariance(initial_variance);

    if (kf == NULL)
    {
        return;
    }

    kf->angle_deg = ClampF32(initial_angle_deg, -KF_PITCH_ANGLE_LIMIT_DEG, KF_PITCH_ANGLE_LIMIT_DEG);
    kf->bias_dps = initial_bias_dps;
    kf->unbiased_rate_dps = 0.0f;

    kf->p00 = safe_variance;
    kf->p01 = 0.0f;
    kf->p10 = 0.0f;
    kf->p11 = safe_variance;

    kf->nis_last = 0.0f;
    kf->accel_angle_last_deg = initial_angle_deg;
    kf->accel_norm_last_g = 1.0f;
    kf->consecutive_untrusted_count = 0U;
    kf->last_measurement_used = 0U;
    kf->initialized = 1U;
    kf->last_tick_ms = HAL_GetTick();
}

/**
 * @brief 对预测后的协方差执行恢复膨胀。
 * @param kf 滤波器对象。
 * @param p00 角度方差。
 * @param p11 零偏方差。
 *
 * @note 当连续多拍观测不可用或被硬拒绝时，若仍维持很小的 P，
 *       后续即便有效观测回来，卡尔曼增益也会过小，滤波器会“拉不回来”。
 *       因此这里显式做协方差恢复：
 *       P_recover = diag(scale * p00, scale * p11)
 */
static void KalmanPitchGate_ApplyRecovery(KalmanPitchGate_t *kf,
                                          float *p00,
                                          float *p11)
{
    if ((kf == NULL) || (p00 == NULL) || (p11 == NULL))
    {
        return;
    }

    if (kf->consecutive_untrusted_count >= KF_PITCH_RECOVERY_LIMIT)
    {
        *p00 = ClampVariance((*p00) * KF_PITCH_RECOVERY_SCALE);
        *p11 = ClampVariance((*p11) * KF_PITCH_RECOVERY_SCALE);
        kf->consecutive_untrusted_count = KF_PITCH_RECOVERY_LIMIT;
    }
}

/**
 * @brief 执行一次预测 + NIS 门控测量更新。
 * @param kf 滤波器对象。
 * @param gyro_rate_dps 陀螺角速度，单位 deg/s。
 * @param accel_angle_deg 加速度计反解角度，单位 deg。
 * @param accel_norm_g 加速度模长，单位 g。
 * @param dt_s 采样周期，单位 s。
 * @return 更新后的俯仰角，单位 deg。
 *
 * @note 状态定义：
 *       x = [angle_deg, bias_dps]^T
 *
 *       先验预测：
 *       angle^- = angle + dt * (gyro_rate - bias)
 *       bias^-  = bias
 *
 *       协方差传播：
 *       P^- = F * P * F^T + Q
 *       其中 F = [1  -dt
 *                 0   1 ]
 *
 *       加速度观测模型：
 *       z = angle + v,   H = [1 0]
 *
 *       归一化创新平方：
 *       y   = z - Hx^-
 *       S   = H * P^- * H^T + R_eff
 *       NIS = y^2 / S
 *
 *       若 NIS 较小，说明观测与先验在当前噪声预算内一致；
 *       若 NIS 过大，则应降低权重甚至拒绝该观测。
 */
float KalmanPitchGate_Update(KalmanPitchGate_t *kf,
                             float gyro_rate_dps,
                             float accel_angle_deg,
                             float accel_norm_g,
                             float dt_s)
{
    float angle_prior;
    float bias_prior;
    float p00_prior;
    float p01_prior;
    float p10_prior;
    float p11_prior;
    const bool accel_norm_valid =
        (accel_norm_g >= KF_PITCH_ACCEL_NORM_MIN_G) &&
        (accel_norm_g <= KF_PITCH_ACCEL_NORM_MAX_G);

    if (kf == NULL)
    {
        return 0.0f;
    }

    dt_s = ClampF32(dt_s, KF_PITCH_DT_MIN_S, KF_PITCH_DT_MAX_S);
    accel_angle_deg = ClampF32(accel_angle_deg, -KF_PITCH_ANGLE_LIMIT_DEG, KF_PITCH_ANGLE_LIMIT_DEG);
    kf->last_measurement_used = 0U;
    kf->accel_angle_last_deg = accel_angle_deg;
    kf->accel_norm_last_g = accel_norm_g;

    /* ---------- Prediction ----------
     * 陀螺输出 = 真角速度 + 零偏 + 噪声
     * 因此先验推进应使用去偏后的角速度。
     */
    kf->unbiased_rate_dps = gyro_rate_dps - kf->bias_dps;
    angle_prior = kf->angle_deg + (dt_s * kf->unbiased_rate_dps);
    bias_prior = kf->bias_dps;

    /*
     * 显式展开 2x2 协方差传播：
     * p00^- = p00 + dt * (dt * p11 - p01 - p10) + q_angle * dt
     * p01^- = p01 - dt * p11
     * p10^- = p10 - dt * p11
     * p11^- = p11 + q_bias * dt
     */
    p00_prior = kf->p00 + dt_s * ((dt_s * kf->p11) - kf->p01 - kf->p10) + (kf->q_angle * dt_s);
    p01_prior = kf->p01 - (dt_s * kf->p11);
    p10_prior = kf->p10 - (dt_s * kf->p11);
    p11_prior = kf->p11 + (kf->q_bias * dt_s);

    p00_prior = ClampVariance(p00_prior);
    p11_prior = ClampVariance(p11_prior);

    if (accel_norm_valid)
    {
        const float accel_norm_error_g = fabsf(accel_norm_g - 1.0f);
        const float r_scale_from_norm =
            1.0f + ClampF32(accel_norm_error_g / 0.02f, 0.0f, KF_PITCH_R_INFLATE_MAX - 1.0f);
        float r_eff = ClampVariance(kf->r_measure * r_scale_from_norm);
        float innovation = accel_angle_deg - angle_prior;
        float innovation_cov = ClampVariance(p00_prior + r_eff);
        float nis = (innovation * innovation) / innovation_cov;

        kf->nis_last = nis;

        if (nis <= KF_PITCH_NIS_ACCEPT_1DOF)
        {
            /* 观测与先验一致，按当前 R_eff 正常融合。 */
        }
        else if (nis < KF_PITCH_NIS_REJECT_1DOF)
        {
            /*
             * 软门控：
             * 观测没有完全失真，但它比标称噪声更脏。
             * 用 NIS 比例放大 R，使 Kalman 增益自动减小，而不是直接一票否决。
             */
            const float nis_scale = ClampF32(nis / KF_PITCH_NIS_ACCEPT_1DOF,
                                             1.0f,
                                             KF_PITCH_R_INFLATE_MAX);
            r_eff = ClampVariance(r_eff * nis_scale);
            innovation_cov = ClampVariance(p00_prior + r_eff);
            nis = (innovation * innovation) / innovation_cov;
            kf->nis_last = nis;
        }
        else
        {
            /*
             * 硬拒绝：
             * 当前观测与先验严重不一致，大概率已经不是“姿态角测量”，
             * 可能来自冲击、线加速度、传感器饱和或时序撕裂。
             * 本拍只保留预测，不做测量更新。
             */
            kf->angle_deg = ClampF32(angle_prior, -KF_PITCH_ANGLE_LIMIT_DEG, KF_PITCH_ANGLE_LIMIT_DEG);
            kf->bias_dps = bias_prior;
            kf->p00 = p00_prior;
            kf->p01 = p01_prior;
            kf->p10 = p10_prior;
            kf->p11 = p11_prior;
            kf->consecutive_untrusted_count++;
            KalmanPitchGate_ApplyRecovery(kf, &kf->p00, &kf->p11);
            return kf->angle_deg;
        }

        {
            float k0;
            float k1;
            float a00;
            float a01;
            float a10;
            float a11;
            float ap00;
            float ap01;
            float ap10;
            float ap11;
            float p00_new;
            float p01_new;
            float p10_new;
            float p11_new;
            float cross;

            k0 = p00_prior / innovation_cov;
            k1 = p10_prior / innovation_cov;

            kf->angle_deg = angle_prior + (k0 * innovation);
            kf->bias_dps = bias_prior + (k1 * innovation);
            kf->angle_deg = ClampF32(kf->angle_deg, -KF_PITCH_ANGLE_LIMIT_DEG, KF_PITCH_ANGLE_LIMIT_DEG);

            /*
             * Joseph Form 协方差更新：
             * P = (I - K H) P^- (I - K H)^T + K R K^T
             * 这样做的目的不是“公式更长”，而是减少数值误差把 P 推成负值或非对称矩阵。
             */
            a00 = 1.0f - k0;
            a01 = 0.0f;
            a10 = -k1;
            a11 = 1.0f;

            ap00 = (a00 * p00_prior) + (a01 * p10_prior);
            ap01 = (a00 * p01_prior) + (a01 * p11_prior);
            ap10 = (a10 * p00_prior) + (a11 * p10_prior);
            ap11 = (a10 * p01_prior) + (a11 * p11_prior);

            p00_new = (ap00 * a00) + (ap01 * a01) + (k0 * r_eff * k0);
            p01_new = (ap00 * a10) + (ap01 * a11) + (k0 * r_eff * k1);
            p10_new = (ap10 * a00) + (ap11 * a01) + (k1 * r_eff * k0);
            p11_new = (ap10 * a10) + (ap11 * a11) + (k1 * r_eff * k1);

            cross = 0.5f * (p01_new + p10_new);

            kf->p00 = ClampVariance(p00_new);
            kf->p01 = cross;
            kf->p10 = cross;
            kf->p11 = ClampVariance(p11_new);
            kf->last_measurement_used = 1U;
            kf->consecutive_untrusted_count = 0U;
            return kf->angle_deg;
        }
    }

    /* 加速度模长远离 1 g，本拍观测不再可信，只保留预测。 */
    kf->nis_last = 0.0f;
    kf->angle_deg = ClampF32(angle_prior, -KF_PITCH_ANGLE_LIMIT_DEG, KF_PITCH_ANGLE_LIMIT_DEG);
    kf->bias_dps = bias_prior;
    kf->p00 = p00_prior;
    kf->p01 = p01_prior;
    kf->p10 = p10_prior;
    kf->p11 = p11_prior;
    kf->consecutive_untrusted_count++;
    KalmanPitchGate_ApplyRecovery(kf, &kf->p00, &kf->p11);
    return kf->angle_deg;
}

/**
 * @brief 使用 MPU6050 原始数据更新俯仰角估计。
 * @param kf 滤波器对象。
 * @param accel_x_raw 加速度计 X 轴原始值。
 * @param accel_z_raw 加速度计 Z 轴原始值。
 * @param gyro_y_raw 陀螺仪 Y 轴原始值。
 * @param out_pitch_deg 输出俯仰角，单位 deg。
 * @retval true 更新成功。
 * @retval false 参数非法或观测退化到无法计算角度。
 *
 * @note 原始量到物理量的线性映射：
 *       a_x[g]      = accel_x_raw / 16384
 *       a_z[g]      = accel_z_raw / 16384
 *       gyro[dps]   = gyro_y_raw  / 65.5
 *
 *       加速度姿态反解：
 *       theta_acc = atan2(a_x, a_z) * 180 / pi
 *
 *       这里特意使用 atan2 而不是简单除法，是为了保留象限信息并降低垂直附近的退化风险。
 */
bool KalmanPitchGate_UpdateFromMpu6050(KalmanPitchGate_t *kf,
                                       int16_t accel_x_raw,
                                       int16_t accel_z_raw,
                                       int16_t gyro_y_raw,
                                       float *out_pitch_deg)
{
    const float ax_g = (float)accel_x_raw / MPU6050_ACCEL_LSB_PER_G;
    const float az_g = (float)accel_z_raw / MPU6050_ACCEL_LSB_PER_G;
    const float accel_norm_g = sqrtf((ax_g * ax_g) + (az_g * az_g));
    const float accel_pitch_deg = atan2f(ax_g, az_g) * RAD_TO_DEG;
    const float gyro_rate_dps = (float)gyro_y_raw / MPU6050_GYRO_LSB_PER_DPS;
    const uint32_t now_ms = HAL_GetTick();
    float dt_s;

    if ((kf == NULL) || (out_pitch_deg == NULL))
    {
        return false;
    }

    if ((fabsf(ax_g) + fabsf(az_g)) < 1.0e-6f)
    {
        return false;
    }

    if (kf->initialized == 0U)
    {
        KalmanPitchGate_Reset(kf,
                              ClampF32(accel_pitch_deg, -KF_PITCH_ANGLE_LIMIT_DEG, KF_PITCH_ANGLE_LIMIT_DEG),
                              0.0f,
                              1.0f);
        *out_pitch_deg = kf->angle_deg;
        return true;
    }

    dt_s = (float)(now_ms - kf->last_tick_ms) * 0.001f;
    kf->last_tick_ms = now_ms;

    *out_pitch_deg = KalmanPitchGate_Update(kf,
                                            gyro_rate_dps,
                                            accel_pitch_deg,
                                            accel_norm_g,
                                            dt_s);
    return true;
}

static KalmanPitchGate_t g_pitch_filter;

/**
 * @brief 应用层初始化示例。
 *
 * @note 这组参数只给出量级起点：
 *       - q_angle   对应积分先验的不确定度增长；
 *       - q_bias    对应陀螺零偏游走；
 *       - r_measure 对应加速度反解姿态在静态时的噪声。
 *       真正落地时应结合采样率、振动谱和目标带宽重新标定。
 */
void App_PitchEstimatorInit(void)
{
    KalmanPitchGate_Init(&g_pitch_filter, 0.03f, 0.004f, 0.40f);
}

/**
 * @brief 应用层一步更新示例。
 * @param accel_x_raw MPU6050 加速度计 X 轴原始值。
 * @param accel_z_raw MPU6050 加速度计 Z 轴原始值。
 * @param gyro_y_raw MPU6050 陀螺仪 Y 轴原始值。
 * @param out_pitch_deg 输出俯仰角。
 * @retval true 更新成功。
 * @retval false 数据非法。
 */
bool App_PitchEstimatorStep(int16_t accel_x_raw,
                            int16_t accel_z_raw,
                            int16_t gyro_y_raw,
                            float *out_pitch_deg)
{
    return KalmanPitchGate_UpdateFromMpu6050(&g_pitch_filter,
                                             accel_x_raw,
                                             accel_z_raw,
                                             gyro_y_raw,
                                             out_pitch_deg);
}
```

这段实现真正想强调的是：**滤波器不是一个默认相信所有观测的平滑器，而是一台带信任闸门的状态机**。NIS 负责把残差放回统计语境里，软门控负责承认“这次测量变脏了但还没死”，硬拒绝负责在传感器明显失真时守住先验，而协方差恢复则负责在长时间盲飞后主动降低自信。只有把这几层都补齐，卡尔曼滤波才不只是会算矩阵，而是真能在嵌入式现场里扛住坏观测、等到好观测、再把状态拉回现实。
