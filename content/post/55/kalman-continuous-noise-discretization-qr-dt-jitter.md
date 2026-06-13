---
title: "技能档案：卡尔曼滤波里的连续噪声离散化、Q/R 量纲统一与采样周期抖动"
slug: "skill-kalman-continuous-noise-discretization-qr-unit-consistency-and-dt-jitter"
date: 2026-06-11T13:08:27+08:00
draft: false
description: "从连续时间噪声强度、离散协方差 Q、加速度倾角测量方差 R 到时间戳抖动，系统拆解卡尔曼滤波为何真正难在不确定性的量纲对账，而不是矩阵乘法。"
tags: ["卡尔曼滤波", "STM32", "传感器融合", "离散化", "Q/R", "时间戳", "MPU6050"]
categories: ["技能档案"]
image: ""
---

## 技能概述

很多嵌入式项目把卡尔曼滤波调不稳，表面上看像是“`Q` 和 `R` 没调好”，实质上往往是更底层的账没对上: 连续物理噪声被离散采样后该如何进入 `Q`，加速度计的原始噪声怎样映射成角度域里的 `R`，`dt` 抖动为什么不仅会让积分多一点少一点，还会直接改写协方差传播。如果这些量纲、时间基和噪声来源没有统一，滤波器的协方差矩阵就不再是“不确定性预算表”，而会退化成一份掩盖问题的经验常数。这个主题要解决的核心痛点，不是再背一次卡尔曼公式，而是把 **连续噪声强度**、**离散化协方差**、**角度观测方差映射** 和 **时间戳抖动预算** 串成一份可以落到 STM32 代码里的数学合同。

## 核心底层概念解析

- **`Q` 不是神秘调参旋钮，而是连续噪声穿过采样门之后留下的离散能量**：陀螺白噪声、零偏随机游走、编码器量化、轮速打滑、视觉像素抖动，这些都首先存在于连续物理世界。离散滤波器看到的 `Q`，只是它们在一个采样周期 `dt` 内对状态不确定性的积分结果。
- **量纲如果没统一，协方差矩阵一开始就是假的**：以 2 状态俯仰角模型 `x = [theta, b]^T` 为例，`theta` 单位是 `rad`，`b` 单位是 `rad/s`。因此 `P00` 和 `R` 的单位是 `rad^2`，`P01` 的单位是 `rad^2/s`，`P11` 的单位是 `rad^2/s^2`。把这些量混成“都叫方差”但不区分量纲，本质上是在把不同物理量硬塞进一张假账本。
- **2 状态姿态模型看似简单，真正关键在噪声入口而不是状态方程本身**：对常见 IMU 俯仰角估计，可写成  
  `theta_dot = omega_m - b + n_g`，  
  `b_dot = n_b`。  
  其中 `omega_m` 是陀螺测得的角速度，`n_g` 是角速度白噪声，`n_b` 是零偏随机游走。滤波效果的上限，往往先由 `n_g` 和 `n_b` 的建模质量决定，而不是由矩阵乘法速度决定。
- **这个模型的状态转移矩阵可以精确离散，而不是只能粗糙欧拉近似**：由于系统矩阵  
  `A = [[0, -1], [0, 0]]`  
  满足 `A^2 = 0`，因此  
  `F = exp(A * dt) = [[1, -dt], [0, 1]]`。  
  这意味着在该模型下，常见的离散状态转移本身就是精确结果，不必为它再引入额外的一阶近似误差。
- **连续白噪声离散成 `Q` 时，会同时长出 `dt`、`dt^2` 和 `dt^3` 三种尺度**：若 `q_g` 表示角速度白噪声强度，`q_b` 表示零偏随机游走强度，则该 2 状态模型的离散过程噪声可写成  
  `Q_d = [[q_g * dt + q_b * dt^3 / 3, -q_b * dt^2 / 2], [-q_b * dt^2 / 2, q_b * dt]]`。  
  这条式子揭示了一个经常被忽略的事实: `dt` 抖动不只是改写角度积分，还会通过一次、二次、三次项同时改写先验协方差增长速度。
- **把 `q_angle`、`q_bias` 固定成经验常数，本质上是在把采样频率偷偷写死进参数里**：代码里如果直接写 `q_angle = 0.001f`、`q_bias = 0.003f`，表面上很方便，实则假设了某个隐含采样周期。系统一旦从 `1 kHz` 换到 `800 Hz`，或者任务抖动从 `1.0 ms` 漂到 `1.6 ms`，原本“调好的”滤波器就会失去物理一致性。
- **`R` 也不能直接拿传感器 LSB 方差顶上去，因为观测模型已经换了坐标系**：若加速度计通过  
  `theta_acc = atan2(-a_x, a_z)`  
  反解俯仰角，观测噪声已经从加速度域映射到了角度域。利用一阶误差传播可得  
  `R_theta ~= sigma_a^2 / (a_x^2 + a_z^2)`，  
  其中 `sigma_a^2` 是 `a_x`、`a_z` 轴的加速度噪声方差。也就是说，姿态观测噪声不是常量，它会随当前重力投影几何条件变化。
- **线加速度会把“测量噪声”伪装成“观测模型失真”**：当车体急加速、急刹车或者剧烈振动时，加速度计测到的不再只是重力投影。这时更合理的做法通常不是粗暴停用加速度计，而是让 `R` 随 `||a||` 偏离 `1 g` 的程度动态膨胀，承认此刻观测仍可用，但可信度正在下降。
- **时间戳质量往往比浮点精度更决定滤波质量**：`float` 精度不够很少是姿态滤波的第一现场，`dt` 来源错了才是。用 `HAL_GetTick()` 的毫秒节拍去推进 `1 kHz` IMU，和用定时器微秒计数器、DMA 帧到达时刻、`DRDY` 中断时间戳去推进，同样的公式会得到完全不同的物理含义。
- **协方差更新最好用 Joseph Form，而不是只追求最短代码**：理论上 `P = (I - KH) P^-` 就能工作，但在单片机的有限字长和长期迭代下，数值误差会让 `P` 逐渐失去对称性，甚至出现负方差。Joseph 形式  
  `P = (I - KH) P^- (I - KH)^T + K R K^T`  
  虽然多几次乘法，却是在用计算量换长期数值可信度。
- **技术哲学上，滤波器不是把噪声“消掉”，而是在每个采样周期里给不确定性做精确记账**：只要 `Q`、`R`、`dt` 和状态量纲对得上，滤波器才是在描述现实；否则无论曲线多平滑，都是在更高分辨率地误解世界。

## 代码能力展现

下面给出一个基于 STM32 HAL 使用场景的 2 状态俯仰角卡尔曼模块。假设:

- `TIM2` 以 `1 MHz` 自由运行，`__HAL_TIM_GET_COUNTER(&htim2)` 直接提供微秒级时间戳。
- MPU6050 已经完成原始数据突发读取，示例重点不放在 I2C 驱动，而放在 **连续噪声 -> 离散 `Q` -> 加速度角 `R` -> 实时 `dt` 重算 -> Joseph 协方差更新** 这条链路上。
- 滤波器内部统一使用 **弧度** 和 **弧度每秒**，避免角度制下 `Q/R` 的量纲被经验常数掩盖。

```c
#include "main.h"

#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#define KF_PITCH_VALUE_MIN                    1.0e-10f
#define KF_PITCH_VALUE_MAX                    1.0e6f
#define KF_PITCH_DT_DEFAULT_S                 0.0010f
#define KF_PITCH_ACCEL_PLANE_MIN_G2           0.05f
#define KF_PITCH_ACCEL_INFLATE_MAX            64.0f
#define KF_PITCH_ACCEL_NORM_REF_G             1.0f

#define MPU6050_ACCEL_LSB_PER_G               16384.0f
#define MPU6050_GYRO_LSB_PER_DPS              65.5f
#define DEG_TO_RAD                            0.017453292519943295f
#define RAD_TO_DEG                            57.295779513082320876f

typedef struct
{
    int16_t ax_raw;
    int16_t ay_raw;
    int16_t az_raw;
    int16_t temperature_raw;
    int16_t gx_raw;
    int16_t gy_raw;
    int16_t gz_raw;
} Mpu6050Frame_t;

typedef struct
{
    /*
     * 连续时间噪声强度的单位必须和状态定义对应:
     * - gyro_rate_noise_intensity_rad2_s    : 角速度白噪声积分到角度后的连续强度 q_g
     * - bias_random_walk_intensity_rad2_s3  : 零偏随机游走强度 q_b
     *
     * 对 2 状态模型:
     * theta_dot = omega_m - b + n_g
     * b_dot     = n_b
     *
     * 若连续噪声强度已由 Allan 方差、静止日志拟合或台架辨识得到，
     * 则离散过程噪声可由 Q_d(dt) 每拍实时重算，而不是写死常数。
     */
    float gyro_rate_noise_intensity_rad2_s;
    float bias_random_walk_intensity_rad2_s3;

    /* 加速度计单轴噪声方差，单位 g^2。 */
    float accel_axis_noise_var_g2;

    /* |a|-1g 越偏离，R 膨胀得越快。 */
    float accel_norm_inflate_gain;

    float dt_min_s;
    float dt_max_s;
    float angle_limit_rad;
    float bias_limit_rad_s;
} KalmanPitchNoiseModel_t;

typedef struct
{
    float angle_rad;
    float bias_rad_s;
    float unbiased_rate_rad_s;

    /*
     * 协方差矩阵:
     * P = [p00 p01
     *      p10 p11]
     *
     * 量纲:
     * p00 -> rad^2
     * p01/p10 -> rad^2/s
     * p11 -> rad^2/s^2
     */
    float p00;
    float p01;
    float p10;
    float p11;

    float dt_last_s;
    float r_last_rad2;
    uint32_t last_timestamp_us;
    uint8_t initialized;

    KalmanPitchNoiseModel_t model;
} KalmanPitch2State_t;

extern TIM_HandleTypeDef htim2;

static KalmanPitch2State_t g_pitch_kf;

static float ClampF(float value, float min_value, float max_value)
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

static float ClampPositiveF(float value, float min_value, float max_value)
{
    return ClampF(value, min_value, max_value);
}

static float ClampCrossCovariance(float value, float p00, float p11)
{
    float limit = sqrtf(fabsf(p00 * p11));
    limit = ClampPositiveF(limit, 0.0f, KF_PITCH_VALUE_MAX);
    return ClampF(value, -limit, limit);
}

static float Mpu6050_RawAccelToG(int16_t raw)
{
    return ((float)raw) / MPU6050_ACCEL_LSB_PER_G;
}

static float Mpu6050_RawGyroToRadPerSec(int16_t raw)
{
    return ((((float)raw) / MPU6050_GYRO_LSB_PER_DPS) * DEG_TO_RAD);
}

/**
 * @brief 初始化 2 状态俯仰角卡尔曼滤波器。
 * @param kf 滤波器对象。
 * @param model 连续时间噪声模型与边界配置。
 *
 * @note 这里不直接接收离散 Q/R 常数，而是保存连续噪声模型。
 *       这样系统每次拿到真实 dt 后，都能重新计算当前这一拍的 Q_d(dt)。
 */
void KalmanPitch_Init(KalmanPitch2State_t *kf, const KalmanPitchNoiseModel_t *model)
{
    if ((kf == NULL) || (model == NULL))
    {
        return;
    }

    memset(kf, 0, sizeof(*kf));
    kf->model = *model;

    kf->model.gyro_rate_noise_intensity_rad2_s =
        ClampPositiveF(kf->model.gyro_rate_noise_intensity_rad2_s, KF_PITCH_VALUE_MIN, KF_PITCH_VALUE_MAX);
    kf->model.bias_random_walk_intensity_rad2_s3 =
        ClampPositiveF(kf->model.bias_random_walk_intensity_rad2_s3, KF_PITCH_VALUE_MIN, KF_PITCH_VALUE_MAX);
    kf->model.accel_axis_noise_var_g2 =
        ClampPositiveF(kf->model.accel_axis_noise_var_g2, KF_PITCH_VALUE_MIN, KF_PITCH_VALUE_MAX);
    kf->model.accel_norm_inflate_gain =
        ClampPositiveF(kf->model.accel_norm_inflate_gain, 0.0f, KF_PITCH_VALUE_MAX);
    kf->model.dt_min_s =
        ClampPositiveF(kf->model.dt_min_s, 1.0e-6f, 1.0f);
    kf->model.dt_max_s =
        ClampPositiveF(kf->model.dt_max_s, kf->model.dt_min_s, 1.0f);
    kf->model.angle_limit_rad =
        ClampPositiveF(kf->model.angle_limit_rad, 1.0f * DEG_TO_RAD, 89.0f * DEG_TO_RAD);
    kf->model.bias_limit_rad_s =
        ClampPositiveF(kf->model.bias_limit_rad_s, 0.1f * DEG_TO_RAD, 1000.0f * DEG_TO_RAD);
}

/**
 * @brief 重置滤波器状态与协方差。
 * @param kf 滤波器对象。
 * @param initial_angle_rad 初始俯仰角，单位 rad。
 * @param initial_bias_rad_s 初始零偏，单位 rad/s。
 * @param initial_variance 初始对角方差，单位 rad^2。
 * @param timestamp_us 当前样本的微秒时间戳。
 */
void KalmanPitch_Reset(KalmanPitch2State_t *kf,
                       float initial_angle_rad,
                       float initial_bias_rad_s,
                       float initial_variance,
                       uint32_t timestamp_us)
{
    const float safe_variance = ClampPositiveF(initial_variance, KF_PITCH_VALUE_MIN, KF_PITCH_VALUE_MAX);

    if (kf == NULL)
    {
        return;
    }

    kf->angle_rad = ClampF(initial_angle_rad, -kf->model.angle_limit_rad, kf->model.angle_limit_rad);
    kf->bias_rad_s = ClampF(initial_bias_rad_s, -kf->model.bias_limit_rad_s, kf->model.bias_limit_rad_s);
    kf->unbiased_rate_rad_s = 0.0f;

    kf->p00 = safe_variance;
    kf->p01 = 0.0f;
    kf->p10 = 0.0f;
    kf->p11 = safe_variance;

    kf->dt_last_s = ClampF(KF_PITCH_DT_DEFAULT_S, kf->model.dt_min_s, kf->model.dt_max_s);
    kf->r_last_rad2 = safe_variance;
    kf->last_timestamp_us = timestamp_us;
    kf->initialized = 1U;
}

/**
 * @brief 计算本拍实际采样周期。
 * @param kf 滤波器对象。
 * @param timestamp_us 当前微秒时间戳。
 * @return 钳位后的 dt，单位 s。
 *
 * @note 使用 32 位无符号差分，允许定时器自然回绕:
 *       dt = (timestamp_k - timestamp_{k-1}) * 1e-6
 */
static float KalmanPitch_ComputeDtSeconds(KalmanPitch2State_t *kf, uint32_t timestamp_us)
{
    uint32_t dt_us;
    float dt_s;

    if ((kf == NULL) || (kf->initialized == 0U))
    {
        return KF_PITCH_DT_DEFAULT_S;
    }

    dt_us = timestamp_us - kf->last_timestamp_us;
    dt_s = (float)dt_us * 1.0e-6f;

    if (dt_us == 0U)
    {
        dt_s = KF_PITCH_DT_DEFAULT_S;
    }

    return ClampF(dt_s, kf->model.dt_min_s, kf->model.dt_max_s);
}

/**
 * @brief 根据连续时间噪声强度计算当前采样周期下的离散过程噪声。
 * @param model 连续噪声模型。
 * @param dt_s 当前采样周期，单位 s。
 * @param q00 输出 Q(0,0)，单位 rad^2。
 * @param q01 输出 Q(0,1)=Q(1,0)，单位 rad^2/s。
 * @param q11 输出 Q(1,1)，单位 rad^2/s^2。
 *
 * @note 对模型:
 *       theta_dot = omega_m - b + n_g
 *       b_dot     = n_b
 *
 *       离散过程噪声精确结果为:
 *       Q00 = q_g * dt + q_b * dt^3 / 3
 *       Q01 = Q10 = -q_b * dt^2 / 2
 *       Q11 = q_b * dt
 *
 *       这里最值得注意的不是公式本身，而是 dt 一旦抖动，Q 会同时在
 *       一次、二次、三次项上发生变化，因此不能再把 Q 固定成常数表。
 */
static void KalmanPitch_ComputeDiscreteQ(const KalmanPitchNoiseModel_t *model,
                                         float dt_s,
                                         float *q00,
                                         float *q01,
                                         float *q11)
{
    float dt2;
    float dt3;
    float qg;
    float qb;

    if ((model == NULL) || (q00 == NULL) || (q01 == NULL) || (q11 == NULL))
    {
        return;
    }

    dt2 = dt_s * dt_s;
    dt3 = dt2 * dt_s;
    qg = model->gyro_rate_noise_intensity_rad2_s;
    qb = model->bias_random_walk_intensity_rad2_s3;

    *q00 = ClampPositiveF((qg * dt_s) + (qb * dt3 / 3.0f), KF_PITCH_VALUE_MIN, KF_PITCH_VALUE_MAX);
    *q01 = ClampF(-(qb * dt2 * 0.5f), -KF_PITCH_VALUE_MAX, KF_PITCH_VALUE_MAX);
    *q11 = ClampPositiveF(qb * dt_s, KF_PITCH_VALUE_MIN, KF_PITCH_VALUE_MAX);
}

/**
 * @brief 由加速度计重力投影反解俯仰角。
 * @param ax_g X 轴加速度，单位 g。
 * @param az_g Z 轴加速度，单位 g。
 * @return 俯仰角，单位 rad。
 */
static float KalmanPitch_ComputeAccelAngleRad(float ax_g, float az_g)
{
    return atan2f(-ax_g, az_g);
}

/**
 * @brief 把加速度域噪声映射为角度域测量方差 R。
 * @param model 连续噪声模型。
 * @param ax_g X 轴加速度，单位 g。
 * @param ay_g Y 轴加速度，单位 g。
 * @param az_g Z 轴加速度，单位 g。
 * @return 当前样本对应的角度观测方差，单位 rad^2。
 *
 * @note 观测模型:
 *       theta_acc = atan2(-ax, az)
 *
 *       一阶误差传播:
 *       dtheta/dax = -az / (ax^2 + az^2)
 *       dtheta/daz =  ax / (ax^2 + az^2)
 *
 *       若 Var(ax)=Var(az)=sigma_a^2 且互不相关，则:
 *       R_theta ~= sigma_a^2 / (ax^2 + az^2)
 *
 *       同时，当 |a| 明显偏离 1g 时，说明线加速度正在污染重力观测，
 *       因此额外按模长偏差对 R 做膨胀。
 */
static float KalmanPitch_ComputeAccelAngleVarianceRad2(const KalmanPitchNoiseModel_t *model,
                                                       float ax_g,
                                                       float ay_g,
                                                       float az_g)
{
    float plane_norm_sq;
    float accel_norm_g;
    float inflate;
    float r_theta;

    if (model == NULL)
    {
        return KF_PITCH_VALUE_MAX;
    }

    plane_norm_sq = (ax_g * ax_g) + (az_g * az_g);
    plane_norm_sq = ClampPositiveF(plane_norm_sq, KF_PITCH_ACCEL_PLANE_MIN_G2, KF_PITCH_VALUE_MAX);

    accel_norm_g = sqrtf((ax_g * ax_g) + (ay_g * ay_g) + (az_g * az_g));
    inflate = 1.0f + (fabsf(accel_norm_g - KF_PITCH_ACCEL_NORM_REF_G) * model->accel_norm_inflate_gain);
    inflate = ClampPositiveF(inflate, 1.0f, KF_PITCH_ACCEL_INFLATE_MAX);

    r_theta = (model->accel_axis_noise_var_g2 / plane_norm_sq) * inflate * inflate;
    return ClampPositiveF(r_theta, KF_PITCH_VALUE_MIN, KF_PITCH_VALUE_MAX);
}

/**
 * @brief 执行一次 2 状态俯仰角卡尔曼更新。
 * @param kf 滤波器对象。
 * @param gyro_y_rad_s 陀螺 Y 轴角速度，单位 rad/s。
 * @param ax_g X 轴加速度，单位 g。
 * @param ay_g Y 轴加速度，单位 g。
 * @param az_g Z 轴加速度，单位 g。
 * @param timestamp_us 当前样本微秒时间戳。
 * @param out_pitch_rad 输出俯仰角，单位 rad，可为 NULL。
 * @retval true 更新成功，false 表示参数非法。
 *
 * @note 状态定义:
 *       x = [theta, bias]^T
 *
 *       先验预测:
 *       theta^- = theta + dt * (gyro - bias)
 *       bias^-  = bias
 *
 *       协方差传播:
 *       P^- = F * P * F^T + Q_d(dt)
 *       F   = [1  -dt
 *              0   1 ]
 *
 *       观测模型:
 *       z = theta + v,   H = [1 0]
 *
 *       Joseph 形式更新:
 *       P = (I - KH) * P^- * (I - KH)^T + K * R * K^T
 *
 *       这样做的意义，不只是“公式更完整”，而是长期运行时能更稳地维持
 *       P 的对称性与半正定性，避免数值误差把协方差矩阵写坏。
 */
bool KalmanPitch_Update(KalmanPitch2State_t *kf,
                        float gyro_y_rad_s,
                        float ax_g,
                        float ay_g,
                        float az_g,
                        uint32_t timestamp_us,
                        float *out_pitch_rad)
{
    float dt_s;
    float accel_angle_rad;
    float q00;
    float q01;
    float q11;

    float angle_prior;
    float bias_prior;
    float p00_prior;
    float p01_prior;
    float p10_prior;
    float p11_prior;

    float r_theta;
    float innovation;
    float innovation_cov;
    float k0;
    float k1;

    float angle_post;
    float bias_post;
    float p00_post;
    float p01_post;
    float p10_post;
    float p11_post;
    float p01_avg;
    float i00;

    if (kf == NULL)
    {
        return false;
    }

    accel_angle_rad = KalmanPitch_ComputeAccelAngleRad(ax_g, az_g);

    if (kf->initialized == 0U)
    {
        KalmanPitch_Reset(kf,
                          accel_angle_rad,
                          0.0f,
                          (5.0f * DEG_TO_RAD) * (5.0f * DEG_TO_RAD),
                          timestamp_us);

        if (out_pitch_rad != NULL)
        {
            *out_pitch_rad = kf->angle_rad;
        }

        return true;
    }

    dt_s = KalmanPitch_ComputeDtSeconds(kf, timestamp_us);
    kf->last_timestamp_us = timestamp_us;
    kf->dt_last_s = dt_s;

    KalmanPitch_ComputeDiscreteQ(&kf->model, dt_s, &q00, &q01, &q11);

    /*
     * 先验状态推进:
     * theta^- = theta + dt * (gyro - bias)
     *
     * 这里的 gyro 先减零偏再积分，本质上是在把陀螺读数拆成
     * “可信的角速度成分”和“待估计的慢变漂移成分”。
     */
    kf->unbiased_rate_rad_s = gyro_y_rad_s - kf->bias_rad_s;
    angle_prior = kf->angle_rad + (dt_s * kf->unbiased_rate_rad_s);
    bias_prior = kf->bias_rad_s;

    /*
     * 对 F = [1 -dt; 0 1] 的显式展开:
     * P^- = F P F^T + Q
     */
    p00_prior = kf->p00 - (dt_s * (kf->p01 + kf->p10)) + (dt_s * dt_s * kf->p11) + q00;
    p01_prior = kf->p01 - (dt_s * kf->p11) + q01;
    p10_prior = kf->p10 - (dt_s * kf->p11) + q01;
    p11_prior = kf->p11 + q11;

    p00_prior = ClampPositiveF(p00_prior, KF_PITCH_VALUE_MIN, KF_PITCH_VALUE_MAX);
    p11_prior = ClampPositiveF(p11_prior, KF_PITCH_VALUE_MIN, KF_PITCH_VALUE_MAX);

    r_theta = KalmanPitch_ComputeAccelAngleVarianceRad2(&kf->model, ax_g, ay_g, az_g);
    kf->r_last_rad2 = r_theta;

    innovation = accel_angle_rad - angle_prior;
    innovation_cov = ClampPositiveF(p00_prior + r_theta, KF_PITCH_VALUE_MIN, KF_PITCH_VALUE_MAX);

    k0 = p00_prior / innovation_cov;
    k1 = p10_prior / innovation_cov;

    angle_post = angle_prior + (k0 * innovation);
    bias_post = bias_prior + (k1 * innovation);

    angle_post = ClampF(angle_post, -kf->model.angle_limit_rad, kf->model.angle_limit_rad);
    bias_post = ClampF(bias_post, -kf->model.bias_limit_rad_s, kf->model.bias_limit_rad_s);

    /*
     * Joseph Form:
     * A = I - KH = [1-k0   0
     *              -k1    1]
     *
     * 然后:
     * P = A * P^- * A^T + K * R * K^T
     *
     * 显式展开后可避免引入通用矩阵库，同时保留数值稳定性。
     */
    i00 = 1.0f - k0;

    p00_post = (i00 * i00 * p00_prior) + (k0 * k0 * r_theta);
    p01_post = (i00 * (p01_prior - (k1 * p00_prior))) + (k0 * k1 * r_theta);
    p10_post = (i00 * (p10_prior - (k1 * p00_prior))) + (k0 * k1 * r_theta);
    p11_post = p11_prior - (k1 * p01_prior) - (k1 * p10_prior) + (k1 * k1 * p00_prior) + (k1 * k1 * r_theta);

    p00_post = ClampPositiveF(p00_post, KF_PITCH_VALUE_MIN, KF_PITCH_VALUE_MAX);
    p11_post = ClampPositiveF(p11_post, KF_PITCH_VALUE_MIN, KF_PITCH_VALUE_MAX);

    /*
     * 数值实现里显式对称化一次，避免长期迭代后 p01 与 p10 因浮点舍入漂开。
     * 同时应用 |P01| <= sqrt(P00 * P11) 的边界，防止交叉协方差越界。
     */
    p01_avg = 0.5f * (p01_post + p10_post);
    p01_avg = ClampCrossCovariance(p01_avg, p00_post, p11_post);

    kf->angle_rad = angle_post;
    kf->bias_rad_s = bias_post;
    kf->p00 = p00_post;
    kf->p01 = p01_avg;
    kf->p10 = p01_avg;
    kf->p11 = p11_post;

    if (out_pitch_rad != NULL)
    {
        *out_pitch_rad = angle_post;
    }

    return true;
}

/**
 * @brief 用 MPU6050 原始数据驱动一次俯仰角卡尔曼更新。
 * @param kf 滤波器对象。
 * @param frame MPU6050 原始帧。
 * @param htim_us 1 MHz 运行的微秒定时器句柄。
 * @param out_pitch_deg 输出俯仰角，单位 deg，可为 NULL。
 * @retval true 成功，false 失败。
 *
 * @note 这里显式依赖微秒定时器，而不是用 HAL_GetTick() 的毫秒时基。
 *       对 1 kHz 左右的 IMU 任务，1 ms 量化误差本身就足以扭曲 Q_d(dt)。
 */
bool KalmanPitch_UpdateFromMpu6050(KalmanPitch2State_t *kf,
                                   const Mpu6050Frame_t *frame,
                                   TIM_HandleTypeDef *htim_us,
                                   float *out_pitch_deg)
{
    uint32_t timestamp_us;
    float ax_g;
    float ay_g;
    float az_g;
    float gyro_y_rad_s;
    float pitch_rad;
    bool ok;

    if ((kf == NULL) || (frame == NULL) || (htim_us == NULL))
    {
        return false;
    }

    timestamp_us = __HAL_TIM_GET_COUNTER(htim_us);

    ax_g = Mpu6050_RawAccelToG(frame->ax_raw);
    ay_g = Mpu6050_RawAccelToG(frame->ay_raw);
    az_g = Mpu6050_RawAccelToG(frame->az_raw);

    /*
     * 示例假设 MPU6050 的 Y 轴陀螺与俯仰角旋转轴对齐。
     * 若实际安装方向不同，应先做轴重映射再进入滤波器。
     */
    gyro_y_rad_s = Mpu6050_RawGyroToRadPerSec(frame->gy_raw);

    ok = KalmanPitch_Update(kf,
                            gyro_y_rad_s,
                            ax_g,
                            ay_g,
                            az_g,
                            timestamp_us,
                            &pitch_rad);

    if (ok && (out_pitch_deg != NULL))
    {
        *out_pitch_deg = pitch_rad * RAD_TO_DEG;
    }

    return ok;
}

/**
 * @brief 应用层初始化示例。
 *
 * @note 若你手里的是 Allan 方差或静止日志拟合结果，
 *       应先换算成这里的连续时间噪声强度再填入模型。
 *       不要把某个旧工程里“看起来能跑”的离散 Q 常数直接复制过来。
 */
void App_AttitudeKalman_Init(void)
{
    const KalmanPitchNoiseModel_t model =
    {
        .gyro_rate_noise_intensity_rad2_s = 1.5e-5f,
        .bias_random_walk_intensity_rad2_s3 = 8.0e-6f,
        .accel_axis_noise_var_g2 = 2.5e-5f,
        .accel_norm_inflate_gain = 12.0f,
        .dt_min_s = 0.0008f,
        .dt_max_s = 0.0050f,
        .angle_limit_rad = 85.0f * DEG_TO_RAD,
        .bias_limit_rad_s = 20.0f * DEG_TO_RAD
    };

    KalmanPitch_Init(&g_pitch_kf, &model);
}

/**
 * @brief 应用层单步更新示例。
 * @param frame MPU6050 最新原始帧。
 * @param out_pitch_deg 输出俯仰角，单位 deg。
 * @retval true 成功，false 失败。
 */
bool App_AttitudeKalman_Step(const Mpu6050Frame_t *frame, float *out_pitch_deg)
{
    return KalmanPitch_UpdateFromMpu6050(&g_pitch_kf, frame, &htim2, out_pitch_deg);
}
```

这段实现真正想表达的，不是“STM32 上还能再写一个姿态滤波函数”，而是另外一个更容易被工程忽略的事实：**滤波器性能的上限，首先受限于你是否把连续物理噪声、离散采样时基和观测量纲认真对账**。当 `Q` 会随 `dt` 实时重算、`R` 来自角度域误差传播、时间戳来自真实外设节拍而不是任务醒来时刻，卡尔曼滤波才不再是靠经验魔法维持体面，而是真正在数字系统里尊重物理世界。
