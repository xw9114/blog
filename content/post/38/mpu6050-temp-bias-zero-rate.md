---
title: "技能档案：MPU6050 的第二层校准，从温漂零偏到零角速度约束"
slug: "skill-mpu6050-temperature-bias-and-zero-rate-constraint"
date: 2026-05-13T08:23:51+08:00
draft: false
description: "从 MEMS 温漂、静止窗口判定、零角速度约束到四元数离散积分，系统拆解 MPU6050 如何在长时运行中压住姿态漂移。"
tags: ["MPU6050", "STM32", "IMU", "姿态解算", "零偏校准", "嵌入式"]
categories: ["技能档案", "控制与融合"]
image: ""
---

## 技能概述

很多系统第一次把 MPU6050 跑起来时，启动静止平均一下陀螺零偏，姿态看上去就“能用了”；但只要板子连续工作十几分钟、环境温度慢慢爬升、机械结构受热应力重新分布，原本那组零偏就会悄悄失效，最后把四元数积分拖向肉眼可见的漂移。这个主题真正要解决的痛点，不是再写一遍 I2C 读寄存器，而是回答一个更工程化的问题：**当传感器偏置本身是慢变量时，姿态解算怎样在不引入伪校正的前提下，持续约束漂移**。它广泛出现在平衡车、云台、手持稳定器、巡检小车和轻载机械臂上，核心价值是在长时运行里守住“可被控制器信任”的姿态基线。

## 核心底层概念解析

- **零偏不是常数，而是一个缓慢漂移的状态量**：MEMS 陀螺的零偏会受 **温漂、封装应力、电源噪声、焊接残余应力** 共同影响。启动时测得的 `b_g(T0)` 只是在某个参考温度 `T0` 下的一次切片，而不是永远有效的真值。
- **温度寄存器不是附赠信息，而是零偏漂移的代理变量**：MPU6050 内部温度可由 `T(°C) = raw_temp / 340 + 36.53` 近似恢复。若某轴零偏对温度的一阶斜率为 `k_T`，则可写出 `b_g(T) = b_g(T_ref) + k_T * (T - T_ref)`。这不是完美模型，但比“假装偏置恒定”更接近物理现实。
- **静止检测不是主观判断，而是给观测器开权限**：只有当 `||omega|| < omega_th`、`| ||a|| - g | < a_th` 且这种状态持续若干采样周期时，系统才有资格说“当前真实角速度应接近零”。换句话说，静止窗口不是为了显示一个布尔量，而是为了给在线零偏更新提供可信先验。
- **零角速度约束本质上是把“此刻应该没有旋转”写进状态更新**：当载体静止时，陀螺剩余输出几乎都应被解释为偏置残差，因此可把残差低通灌回偏置估计。这类方法常被称为 **ZARU（Zero Angular Rate Update）**，它修的不是姿态角本身，而是姿态积分的输入误差源。
- **四元数积分对偏置异常敏感**：离散姿态更新可写成 `q_{k+1} = normalize(q_k + 0.5 * Delta_t * Omega(omega_k - b_k) * q_k)`。其中 `omega_k` 若残留一个很小的恒定偏差，误差就会在时间轴上持续累积，所以“偏置先管住”通常比“滤波器再复杂一点”更有效。
- **加速度计只能提供重力方向约束，不能替代全部姿态观测**：当载体线加速度明显存在时，加速度计测到的是 **比力**，而不是纯重力。因此只有在 `||a||` 接近 `1 g` 时，才能把它当作姿态纠偏依据；否则把线加速度硬解释成姿态，会把系统拖向另一种漂移。
- **采样周期 `Delta_t` 本身也是一种隐含传感器**：若 `Delta_t` 抖动失控，角速度积分与偏置低通都会一起失真。很多“零偏怎么越校越飘”的问题，根因不是滤波公式错了，而是时间基准来自不稳定的软件延时，而不是硬件定时器时间戳。
- **在线校准必须有边界，否则修正会反噬系统**：偏置限幅、静止计数门槛、温度模型有效范围、四元数归一化与加速度可信门控都属于必要保护。在线估计最怕“带着错误自信更新自己”，因为那会把暂时噪声变成长期模型污染。
- **技术哲学上，这是一层“先别漂，再谈更准”的防线**：互补滤波、Mahony、EKF 都能做姿态融合，但如果输入端的温漂零偏和静止约束没处理好，再高级的融合器也只是在更漂亮地积分错误。

## 代码能力展现

下面给出一个基于 STM32 HAL 的 MPU6050 长时姿态更新示例。代码重点不再是“如何算一个俯仰角”，而是把 **参考温度零偏、温漂一阶补偿、静止窗口判定、零角速度约束和四元数离散积分** 串成一条闭环。示例假设温度斜率 `gyro_temp_slope_dps_per_c` 已通过离线实验或产线标定得到，运行时只做在线修正与边界保护。

```c
#include "stm32f4xx_hal.h"
#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#define MPU6050_I2C_ADDR                       (0x68U << 1)
#define MPU6050_REG_SMPLRT_DIV                 0x19U
#define MPU6050_REG_CONFIG                     0x1AU
#define MPU6050_REG_GYRO_CONFIG                0x1BU
#define MPU6050_REG_ACCEL_CONFIG               0x1CU
#define MPU6050_REG_PWR_MGMT_1                 0x6BU
#define MPU6050_REG_ACCEL_XOUT_H               0x3BU

#define MPU6050_ACCEL_SENS_2G                  16384.0f
#define MPU6050_GYRO_SENS_500DPS               65.5f
#define MPU6050_TEMP_SENS_LSB_PER_C            340.0f
#define MPU6050_TEMP_OFFSET_C                  36.53f
#define MPU6050_DEG_TO_RAD                     0.01745329252f
#define MPU6050_RAD_TO_DEG                     57.2957795f

#define MPU6050_BIAS_LPF_TC_S                  10.0f
#define MPU6050_MOTION_METRIC_TC_S             0.20f
#define MPU6050_STATIC_GYRO_THR_DPS            1.0f
#define MPU6050_STATIC_ACCEL_ERR_THR_G         0.05f
#define MPU6050_ACCEL_TRUST_MIN_G              0.85f
#define MPU6050_ACCEL_TRUST_MAX_G              1.15f
#define MPU6050_BIAS_LIMIT_DPS                 15.0f
#define MPU6050_TEMP_DELTA_LIMIT_C             30.0f
#define MPU6050_STATIC_CONFIRM_COUNT           25U
#define MPU6050_GRAVITY_CORR_GAIN_DYNAMIC      0.8f
#define MPU6050_GRAVITY_CORR_GAIN_STATIC       2.2f

typedef struct
{
    float x;
    float y;
    float z;
} Mpu6050Vec3f_t;

typedef struct
{
    float w;
    float x;
    float y;
    float z;
} Mpu6050Quat_t;

typedef struct
{
    Mpu6050Vec3f_t accel_g;
    Mpu6050Vec3f_t gyro_raw_dps;
    Mpu6050Vec3f_t gyro_corr_dps;
    float temperature_c;
} Mpu6050Sample_t;

typedef struct
{
    I2C_HandleTypeDef *hi2c;
    Mpu6050Quat_t attitude_q;
    Mpu6050Vec3f_t gyro_bias_ref_dps;
    Mpu6050Vec3f_t gyro_temp_slope_dps_per_c;
    float ref_temperature_c;
    float gyro_motion_metric_dps;
    float accel_norm_error_metric_g;
    uint16_t static_counter;
    uint8_t bias_ready;
    uint8_t is_static;
} Mpu6050Handle_t;

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

static int16_t JoinBytes(uint8_t msb, uint8_t lsb)
{
    return (int16_t)(((uint16_t)msb << 8) | (uint16_t)lsb);
}

static float Vec3Norm(const Mpu6050Vec3f_t *v)
{
    return sqrtf((v->x * v->x) + (v->y * v->y) + (v->z * v->z));
}

static Mpu6050Vec3f_t Vec3Scale(const Mpu6050Vec3f_t *v, float scale)
{
    Mpu6050Vec3f_t out;

    out.x = v->x * scale;
    out.y = v->y * scale;
    out.z = v->z * scale;

    return out;
}

static Mpu6050Vec3f_t Vec3Add(const Mpu6050Vec3f_t *a, const Mpu6050Vec3f_t *b)
{
    Mpu6050Vec3f_t out;

    out.x = a->x + b->x;
    out.y = a->y + b->y;
    out.z = a->z + b->z;

    return out;
}

static Mpu6050Vec3f_t Vec3Sub(const Mpu6050Vec3f_t *a, const Mpu6050Vec3f_t *b)
{
    Mpu6050Vec3f_t out;

    out.x = a->x - b->x;
    out.y = a->y - b->y;
    out.z = a->z - b->z;

    return out;
}

static Mpu6050Vec3f_t Vec3Cross(const Mpu6050Vec3f_t *a, const Mpu6050Vec3f_t *b)
{
    Mpu6050Vec3f_t out;

    out.x = (a->y * b->z) - (a->z * b->y);
    out.y = (a->z * b->x) - (a->x * b->z);
    out.z = (a->x * b->y) - (a->y * b->x);

    return out;
}

static Mpu6050Vec3f_t Vec3Normalize(const Mpu6050Vec3f_t *v)
{
    const float norm = Vec3Norm(v);

    if (norm < 1e-6f)
    {
        const Mpu6050Vec3f_t zero = {0.0f, 0.0f, 0.0f};
        return zero;
    }

    return Vec3Scale(v, 1.0f / norm);
}

static Mpu6050Quat_t QuatNormalize(const Mpu6050Quat_t *q)
{
    const float norm = sqrtf((q->w * q->w) + (q->x * q->x) + (q->y * q->y) + (q->z * q->z));
    Mpu6050Quat_t out = *q;

    if (norm < 1e-6f)
    {
        out.w = 1.0f;
        out.x = 0.0f;
        out.y = 0.0f;
        out.z = 0.0f;
        return out;
    }

    out.w /= norm;
    out.x /= norm;
    out.y /= norm;
    out.z /= norm;

    return out;
}

static Mpu6050Quat_t QuatIntegrateBodyRate(const Mpu6050Quat_t *q,
                                           const Mpu6050Vec3f_t *omega_rad_s,
                                           float dt_s)
{
    Mpu6050Quat_t out;
    const float half_dt = 0.5f * dt_s;

    /*
     * 四元数离散积分：
     * q_{k+1} = normalize(q_k + 0.5 * Delta_t * Omega(omega_k) * q_k)
     *
     * 这里假设 omega 位于机体系，且角速度在一个采样周期内近似常值。
     */
    out.w = q->w + half_dt * ((-q->x * omega_rad_s->x) -
                              (q->y * omega_rad_s->y) -
                              (q->z * omega_rad_s->z));
    out.x = q->x + half_dt * (( q->w * omega_rad_s->x) +
                              (q->y * omega_rad_s->z) -
                              (q->z * omega_rad_s->y));
    out.y = q->y + half_dt * (( q->w * omega_rad_s->y) -
                              (q->x * omega_rad_s->z) +
                              (q->z * omega_rad_s->x));
    out.z = q->z + half_dt * (( q->w * omega_rad_s->z) +
                              (q->x * omega_rad_s->y) -
                              (q->y * omega_rad_s->x));

    return QuatNormalize(&out);
}

static Mpu6050Vec3f_t GravityBodyFromQuat(const Mpu6050Quat_t *q)
{
    Mpu6050Vec3f_t g_body;

    /*
     * 根据当前姿态估计，重力在机体系中的方向可近似写成：
     * g_hat_b =
     * [ 2*(q_x*q_z - q_w*q_y),
     *   2*(q_w*q_x + q_y*q_z),
     *   q_w^2 - q_x^2 - q_y^2 + q_z^2 ]
     */
    g_body.x = 2.0f * ((q->x * q->z) - (q->w * q->y));
    g_body.y = 2.0f * ((q->w * q->x) + (q->y * q->z));
    g_body.z = (q->w * q->w) - (q->x * q->x) - (q->y * q->y) + (q->z * q->z);

    return Vec3Normalize(&g_body);
}

static HAL_StatusTypeDef MPU6050_WriteReg(Mpu6050Handle_t *imu, uint8_t reg, uint8_t value)
{
    return HAL_I2C_Mem_Write(imu->hi2c,
                             MPU6050_I2C_ADDR,
                             reg,
                             I2C_MEMADD_SIZE_8BIT,
                             &value,
                             1U,
                             HAL_MAX_DELAY);
}

static HAL_StatusTypeDef MPU6050_ReadBurst(Mpu6050Handle_t *imu,
                                           uint8_t reg,
                                           uint8_t *buffer,
                                           uint16_t length)
{
    return HAL_I2C_Mem_Read(imu->hi2c,
                            MPU6050_I2C_ADDR,
                            reg,
                            I2C_MEMADD_SIZE_8BIT,
                            buffer,
                            length,
                            HAL_MAX_DELAY);
}

/**
 * @brief 初始化 MPU6050 到 200 Hz 输出、±2 g / ±500 dps 工作档位。
 * @param imu MPU6050 句柄。
 * @retval HAL_OK 表示初始化成功，其余值表示总线或参数异常。
 */
HAL_StatusTypeDef MPU6050_InitAdvanced(Mpu6050Handle_t *imu)
{
    I2C_HandleTypeDef *hi2c;

    if ((imu == NULL) || (imu->hi2c == NULL))
    {
        return HAL_ERROR;
    }

    hi2c = imu->hi2c;
    memset(imu, 0, sizeof(*imu));
    imu->hi2c = hi2c;
    imu->attitude_q.w = 1.0f;

    /*
     * 当 DLPF 使陀螺内部输出率为 1 kHz，且 SMPLRT_DIV = 4 时：
     * Fs = 1000 / (1 + 4) = 200 Hz
     */
    if (MPU6050_WriteReg(imu, MPU6050_REG_PWR_MGMT_1, 0x01U) != HAL_OK) return HAL_ERROR;
    if (MPU6050_WriteReg(imu, MPU6050_REG_CONFIG, 0x03U) != HAL_OK) return HAL_ERROR;
    if (MPU6050_WriteReg(imu, MPU6050_REG_SMPLRT_DIV, 0x04U) != HAL_OK) return HAL_ERROR;
    if (MPU6050_WriteReg(imu, MPU6050_REG_GYRO_CONFIG, 0x08U) != HAL_OK) return HAL_ERROR;
    if (MPU6050_WriteReg(imu, MPU6050_REG_ACCEL_CONFIG, 0x00U) != HAL_OK) return HAL_ERROR;

    return HAL_OK;
}

/**
 * @brief 连续读取原始数据并转换到物理量域。
 * @param imu MPU6050 句柄。
 * @param out_sample 输出样本。
 * @retval HAL_OK 表示读取成功。
 *
 * @note 线性映射如下：
 *       accel_g   = raw_acc / 16384.0            (±2 g)
 *       gyro_dps  = raw_gyro / 65.5              (±500 dps)
 *       temp_degC = raw_temp / 340 + 36.53
 */
HAL_StatusTypeDef MPU6050_ReadSample(Mpu6050Handle_t *imu, Mpu6050Sample_t *out_sample)
{
    uint8_t raw[14];

    if ((imu == NULL) || (out_sample == NULL))
    {
        return HAL_ERROR;
    }

    if (MPU6050_ReadBurst(imu, MPU6050_REG_ACCEL_XOUT_H, raw, sizeof(raw)) != HAL_OK)
    {
        return HAL_ERROR;
    }

    out_sample->accel_g.x = (float)JoinBytes(raw[0], raw[1]) / MPU6050_ACCEL_SENS_2G;
    out_sample->accel_g.y = (float)JoinBytes(raw[2], raw[3]) / MPU6050_ACCEL_SENS_2G;
    out_sample->accel_g.z = (float)JoinBytes(raw[4], raw[5]) / MPU6050_ACCEL_SENS_2G;

    out_sample->temperature_c =
        ((float)JoinBytes(raw[6], raw[7]) / MPU6050_TEMP_SENS_LSB_PER_C) + MPU6050_TEMP_OFFSET_C;

    out_sample->gyro_raw_dps.x = (float)JoinBytes(raw[8], raw[9]) / MPU6050_GYRO_SENS_500DPS;
    out_sample->gyro_raw_dps.y = (float)JoinBytes(raw[10], raw[11]) / MPU6050_GYRO_SENS_500DPS;
    out_sample->gyro_raw_dps.z = (float)JoinBytes(raw[12], raw[13]) / MPU6050_GYRO_SENS_500DPS;

    out_sample->gyro_corr_dps = out_sample->gyro_raw_dps;

    return HAL_OK;
}

/**
 * @brief 在已知静止条件下标定参考温度零偏。
 * @param imu MPU6050 句柄。
 * @param sample_count 求均值的样本数量，内部限幅到 [128, 4096]。
 * @param sample_interval_ms 相邻采样间隔，内部限幅到 [1, 10] ms。
 * @retval HAL_OK 表示标定成功。
 *
 * @note 这是“第一层校准”，得到参考温度 T_ref 下的 b_g(T_ref)。
 *       运行期会在此基础上叠加温漂补偿与静止窗口在线修正。
 */
HAL_StatusTypeDef MPU6050_CalibrateReferenceBias(Mpu6050Handle_t *imu,
                                                 uint16_t sample_count,
                                                 uint32_t sample_interval_ms)
{
    Mpu6050Sample_t sample;
    Mpu6050Vec3f_t gyro_sum = {0.0f, 0.0f, 0.0f};
    float temp_sum_c = 0.0f;

    if (imu == NULL)
    {
        return HAL_ERROR;
    }

    sample_count = (uint16_t)ClampF((float)sample_count, 128.0f, 4096.0f);
    sample_interval_ms = (uint32_t)ClampF((float)sample_interval_ms, 1.0f, 10.0f);

    for (uint16_t i = 0U; i < sample_count; ++i)
    {
        if (MPU6050_ReadSample(imu, &sample) != HAL_OK)
        {
            return HAL_ERROR;
        }

        gyro_sum = Vec3Add(&gyro_sum, &sample.gyro_raw_dps);
        temp_sum_c += sample.temperature_c;
        HAL_Delay(sample_interval_ms);
    }

    imu->gyro_bias_ref_dps = Vec3Scale(&gyro_sum, 1.0f / (float)sample_count);
    imu->ref_temperature_c = temp_sum_c / (float)sample_count;
    imu->bias_ready = 1U;

    return HAL_OK;
}

/**
 * @brief 使用温漂模型与静止约束更新姿态四元数。
 * @param imu MPU6050 句柄，需先完成参考零偏标定。
 * @param dt_s 实际采样周期，单位 s，内部限幅到 [0.0005, 0.02]。
 * @param out_sample 输出本次样本与修正结果，可为 NULL。
 * @retval HAL_OK 表示更新成功。
 *
 * @note 温漂补偿公式：
 *       b_g(T) = b_g(T_ref) + k_T * (T - T_ref)
 *
 *       静止窗口中的零角速度约束更新：
 *       b_{k+1} = clamp(b_k + beta * omega_residual, -B_max, B_max)
 *       beta    = Delta_t / (tau_bias + Delta_t)
 *
 *       其中 omega_residual = gyro_raw - b_g(T)，
 *       在静止条件成立时其理想值应接近 0。
 */
HAL_StatusTypeDef MPU6050_UpdateAttitudeWithZeroRateConstraint(Mpu6050Handle_t *imu,
                                                               float dt_s,
                                                               Mpu6050Sample_t *out_sample)
{
    Mpu6050Sample_t sample;
    Mpu6050Vec3f_t bias_temp_dps;
    Mpu6050Vec3f_t omega_rad_s;
    Mpu6050Vec3f_t accel_unit;
    Mpu6050Vec3f_t gravity_est_body;
    Mpu6050Vec3f_t gravity_error;
    const float dt_clamped = ClampF(dt_s, 0.0005f, 0.02f);
    const float metric_alpha = dt_clamped / (MPU6050_MOTION_METRIC_TC_S + dt_clamped);
    const float bias_alpha = dt_clamped / (MPU6050_BIAS_LPF_TC_S + dt_clamped);
    float accel_norm_g;
    float temp_delta_c;

    if ((imu == NULL) || (imu->bias_ready == 0U))
    {
        return HAL_ERROR;
    }

    if (MPU6050_ReadSample(imu, &sample) != HAL_OK)
    {
        return HAL_ERROR;
    }

    temp_delta_c = ClampF(sample.temperature_c - imu->ref_temperature_c,
                          -MPU6050_TEMP_DELTA_LIMIT_C,
                           MPU6050_TEMP_DELTA_LIMIT_C);

    bias_temp_dps.x = imu->gyro_bias_ref_dps.x + (imu->gyro_temp_slope_dps_per_c.x * temp_delta_c);
    bias_temp_dps.y = imu->gyro_bias_ref_dps.y + (imu->gyro_temp_slope_dps_per_c.y * temp_delta_c);
    bias_temp_dps.z = imu->gyro_bias_ref_dps.z + (imu->gyro_temp_slope_dps_per_c.z * temp_delta_c);

    sample.gyro_corr_dps = Vec3Sub(&sample.gyro_raw_dps, &bias_temp_dps);

    /*
     * 静止判定不直接看单拍值，而是看带时间常数的运动指标，
     * 避免短时噪声或轻微敲击把系统频繁拉进拉出静止态。
     */
    accel_norm_g = Vec3Norm(&sample.accel_g);
    imu->gyro_motion_metric_dps =
        (1.0f - metric_alpha) * imu->gyro_motion_metric_dps +
        metric_alpha * Vec3Norm(&sample.gyro_corr_dps);
    imu->accel_norm_error_metric_g =
        (1.0f - metric_alpha) * imu->accel_norm_error_metric_g +
        metric_alpha * fabsf(accel_norm_g - 1.0f);

    if ((imu->gyro_motion_metric_dps < MPU6050_STATIC_GYRO_THR_DPS) &&
        (imu->accel_norm_error_metric_g < MPU6050_STATIC_ACCEL_ERR_THR_G))
    {
        if (imu->static_counter < MPU6050_STATIC_CONFIRM_COUNT)
        {
            imu->static_counter++;
        }
    }
    else
    {
        imu->static_counter = 0U;
    }

    imu->is_static = (imu->static_counter >= MPU6050_STATIC_CONFIRM_COUNT) ? 1U : 0U;

    if (imu->is_static != 0U)
    {
        /*
         * 静止时真实角速度应接近 0，因此残差可以回灌到参考零偏。
         * 这一步不是瞬时覆盖，而是慢时间常数低通，防止把振动误学成模型。
         */
        imu->gyro_bias_ref_dps.x = ClampF(imu->gyro_bias_ref_dps.x + (bias_alpha * sample.gyro_corr_dps.x),
                                          -MPU6050_BIAS_LIMIT_DPS,
                                           MPU6050_BIAS_LIMIT_DPS);
        imu->gyro_bias_ref_dps.y = ClampF(imu->gyro_bias_ref_dps.y + (bias_alpha * sample.gyro_corr_dps.y),
                                          -MPU6050_BIAS_LIMIT_DPS,
                                           MPU6050_BIAS_LIMIT_DPS);
        imu->gyro_bias_ref_dps.z = ClampF(imu->gyro_bias_ref_dps.z + (bias_alpha * sample.gyro_corr_dps.z),
                                          -MPU6050_BIAS_LIMIT_DPS,
                                           MPU6050_BIAS_LIMIT_DPS);
    }

    /*
     * 仅当加速度模长接近 1 g 时，才相信重力方向可用于姿态纠偏。
     * 误差项采用叉乘形式：
     * e_g = a_hat x g_hat_est
     * omega_used = omega_bias_comp + Kp * e_g
     */
    omega_rad_s = Vec3Scale(&sample.gyro_corr_dps, MPU6050_DEG_TO_RAD);

    if ((accel_norm_g > MPU6050_ACCEL_TRUST_MIN_G) && (accel_norm_g < MPU6050_ACCEL_TRUST_MAX_G))
    {
        const float kp = (imu->is_static != 0U) ?
                         MPU6050_GRAVITY_CORR_GAIN_STATIC :
                         MPU6050_GRAVITY_CORR_GAIN_DYNAMIC;

        accel_unit = Vec3Normalize(&sample.accel_g);
        gravity_est_body = GravityBodyFromQuat(&imu->attitude_q);
        gravity_error = Vec3Cross(&gravity_est_body, &accel_unit);
        omega_rad_s.x += kp * gravity_error.x;
        omega_rad_s.y += kp * gravity_error.y;
        omega_rad_s.z += kp * gravity_error.z;
    }

    imu->attitude_q = QuatIntegrateBodyRate(&imu->attitude_q, &omega_rad_s, dt_clamped);

    if (out_sample != NULL)
    {
        *out_sample = sample;
    }

    return HAL_OK;
}

/**
 * @brief 将当前四元数转换为横滚角与俯仰角。
 * @param imu MPU6050 句柄。
 * @param out_roll_deg 输出横滚角，单位 deg。
 * @param out_pitch_deg 输出俯仰角，单位 deg。
 */
void MPU6050_GetRollPitchDeg(const Mpu6050Handle_t *imu,
                             float *out_roll_deg,
                             float *out_pitch_deg)
{
    const float sinr_cosp = 2.0f * ((imu->attitude_q.w * imu->attitude_q.x) +
                                    (imu->attitude_q.y * imu->attitude_q.z));
    const float cosr_cosp = 1.0f - 2.0f * ((imu->attitude_q.x * imu->attitude_q.x) +
                                           (imu->attitude_q.y * imu->attitude_q.y));
    const float sinp = 2.0f * ((imu->attitude_q.w * imu->attitude_q.y) -
                               (imu->attitude_q.z * imu->attitude_q.x));

    if (out_roll_deg != NULL)
    {
        *out_roll_deg = atan2f(sinr_cosp, cosr_cosp) * MPU6050_RAD_TO_DEG;
    }

    if (out_pitch_deg != NULL)
    {
        const float sinp_limited = ClampF(sinp, -1.0f, 1.0f);
        *out_pitch_deg = asinf(sinp_limited) * MPU6050_RAD_TO_DEG;
    }
}
```

这段实现真正想传达的重点是：**长时姿态稳定性并不只取决于“滤波器名字”，而取决于你有没有把偏置、温度、静止窗口和时间基准当作同一条误差链来管理**。启动均值校准解决的是起跑线，温漂模型解决的是热漂移，零角速度约束解决的是长时自修正，而四元数积分与门控纠偏只是把这些约束落实到离散时间里。把这条链条打通，MPU6050 才不只是一个会回数的 IMU，而是一个能在工程现场里长期守住参考系的姿态源。
