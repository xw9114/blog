---
title: "技能档案：MPU6050 DLPF、采样分频与互补滤波的相位裕量预算"
slug: "skill-mpu6050-dlpf-sample-divider-and-complementary-filter-phase-margin-budget"
date: 2026-05-27T14:18:50+08:00
draft: false
description: "从陀螺 DLPF 群时延、SMPLRT_DIV 采样离散化到互补滤波交越频率，系统拆解姿态链路为什么常死在相位裕量，而不是精度标定。"
tags: ["MPU6050", "STM32", "DLPF", "互补滤波", "相位裕量", "采样率", "姿态解算"]
categories: ["技能档案"]
image: ""
---

## 技能概述

很多人第一次把 MPU6050 跑起来时，最先盯住的是零偏和姿态公式；但一旦系统真正进入平衡车、云台、双轮腿或低成本飞控这类闭环场景，问题很快就从“能不能算出角度”变成“这个角度到底滞后了多少”。陀螺 DLPF 会压噪声，也会带来群时延；`SMPLRT_DIV` 会决定离散时间分辨率，也会决定混叠边界；互补滤波会把陀螺高频和重力低频拼起来，也会在交越频率附近吃掉相位裕量。真正的工程痛点不是 API 初始化，而是如何在噪声、时延和闭环稳定之间签一份不自相矛盾的合同。

## 核心底层概念解析

- **DLPF 不是“顺手开一下的降噪选项”，而是噪声与时延的交易**：陀螺数字低通把高频振动和量化噪声压下去，但任何滤波器都不是免费午餐。截止频率越低，输出相位越滞后，闭环里看到的就越像“过去的姿态”。
- **MPU6050 的采样链路是两级时基，不是一个 `HAL_Delay()`**：当 DLPF 打开时，内部陀螺输出率通常工作在 `1 kHz`；随后再由 `SMPLRT_DIV` 做整数分频，得到
  `f_s = f_internal / (1 + SMPLRT_DIV)`。
  这意味着你拿到的 `200 Hz`、`250 Hz`、`500 Hz` 都不是抽象数字，而是内部时基被离散化后的结果。
- **采样率不足的后果不是“数据稀一点”，而是机械振动折叠成假姿态**：如果车体、电机或桨叶带来的振动频率高于奈奎斯特频率 `f_s / 2`，它不会消失，而会折叠进低频区间，最后以“姿态抖动”或“角速度漂移”的形式回到控制器。
- **DLPF 截止频率不能只按噪声选，还要按交越频率选**：若互补滤波或姿态闭环的关键工作频率在 `f_x` 附近，而 DLPF 的相位延迟在这个频点已经很大，那么系统即便均方误差更小，动态响应也可能更差。稳定系统首先要守住时域因果，而不是追求静态平滑。
- **互补滤波本质上是一个频域分工器，而不是经验权重 `0.98 / 0.02`**：连续时间里它更接近
  `theta = HP(s) * ∫omega dt + LP(s) * theta_acc`，
  其中 `HP(s) = s / (s + omega_c)`，`LP(s) = omega_c / (s + omega_c)`。离散实现里那个常见的 `alpha`，只是交越频率 `f_c` 与采样周期 `Delta t` 映射出来的结果。
- **`alpha` 应当从频率推出来，而不是手感试出来**：若采用指数离散化，
  `alpha = exp(-2π f_c Delta t)`，
  则 `1 - alpha` 才是加速度重力通道在当前采样周期里真正占到的权重。`Delta t` 一变，等效截止频率也跟着变，所以时基抖动本身就是一种隐形调参。
- **相位裕量的损失可以先按纯延迟做工程预算**：对观测链路，可把 DLPF 延迟、半个采样周期的零阶保持延迟、任务调度延迟和时间戳抖动加总成
  `T_delay ≈ T_dlpf + Delta t / 2 + T_sched + T_jitter`。
  那么在交越频率 `f_x` 处，额外相位滞后可粗略估算为
  `phi_delay_deg ≈ 360 * f_x * T_delay`。
  它不完美，但足够用于先做架构级筛选。
- **低带宽 DLPF 与低交越互补滤波不是同一件事**：前者在传感器端消掉高频噪声，后者在观测器端重分配陀螺与重力的信任。两者都像低通，但作用点不同，错把其中一个当另一个，会让系统在噪声和动态之间两头不讨好。
- **高采样率并不自动等于高带宽**：如果中断时间戳不稳定、DMA 读数与解算线程不同步、主循环偶发阻塞，那么名义上的 `1 kHz` 更新最终只会变成高抖动输入。闭环讨厌的往往不是慢，而是不确定。
- **加速度计在互补滤波里不是永远可信的“真值传感器”**：线加速度存在时，`theta_acc` 测到的是重力与机体加速度的合成结果。若不做模长门控，互补滤波会把刹车、转弯和撞击直接解释成姿态变化。
- **参数选择本质上是在给噪声、混叠和相位滞后分预算**：DLPF 太高，振动直灌积分；DLPF 太低，传感器自己吃掉相位；采样率太低，振动混叠；互补交越太高，加速度噪声冲进角度；交越太低，长时漂移难以及时拉回。任何一个参数都不能脱离整条链路单独谈。
- **技术哲学上，姿态解算不是“把角度算出来”，而是把物理连续时间压缩进一个仍然可控的离散模型**：噪声可以后滤，精度可以校准，但相位一旦在链路里被提前透支，后面再漂亮的控制律都只是在追逐旧世界。

## 代码能力展现

下面给出一个基于 STM32 HAL 的 MPU6050 配置与互补滤波示例。代码重点不在“再写一遍寄存器读写”，而在于把 **DLPF 档位、采样分频、互补滤波交越频率与相位预算** 放到同一份配置里统一检查，然后再执行姿态更新。

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
#define MPU6050_DEG_TO_RAD                     0.01745329252f
#define MPU6050_RAD_TO_DEG                     57.2957795f
#define MPU6050_TWO_PI                         6.28318530718f
#define MPU6050_MIN_SAMPLE_HZ                  20.0f
#define MPU6050_MAX_SAMPLE_HZ                  1000.0f
#define MPU6050_MAX_SENSOR_PHASE_LAG_DEG       25.0f
#define MPU6050_MAX_ACCEL_NORM_ERR_G           0.12f
#define MPU6050_MAX_VALID_DT_S                 0.02f
#define MPU6050_MIN_VALID_DT_S                 0.0005f

typedef struct
{
    float x;
    float y;
    float z;
} Mpu6050Vec3f_t;

typedef struct
{
    float roll_deg;
    float pitch_deg;
    Mpu6050Vec3f_t gyro_bias_dps;
    float last_accel_norm_g;
} Mpu6050AttitudeState_t;

typedef struct
{
    uint8_t dlpf_cfg;
    float gyro_bandwidth_hz;
    float gyro_delay_ms;
    uint16_t internal_sample_hz;
} Mpu6050DlpfProfile_t;

typedef struct
{
    float target_sample_hz;
    float complementary_cutoff_hz;
    float control_crossover_hz;
    float scheduler_delay_us;
    float jitter_guard_us;
    float max_sensor_phase_lag_deg;
} Mpu6050ObserverRequest_t;

typedef struct
{
    Mpu6050DlpfProfile_t profile;
    uint8_t smplrt_div;
    float actual_sample_hz;
    float dt_s;
    float complementary_alpha;
    float sensor_delay_s;
    float sensor_phase_lag_deg;
} Mpu6050ObserverPlan_t;

typedef struct
{
    I2C_HandleTypeDef *hi2c;
    Mpu6050ObserverPlan_t plan;
    Mpu6050AttitudeState_t state;
} Mpu6050Handle_t;

static const Mpu6050DlpfProfile_t k_mpu6050_dlpf_profiles[] =
{
    /* 从低带宽到高带宽排列，优先选择更强的抑噪档位，
     * 但前提是相位预算仍然满足闭环要求。
     */
    {6U,   5.0f, 18.6f, 1000U},
    {5U,  10.0f, 13.4f, 1000U},
    {4U,  20.0f,  8.3f, 1000U},
    {3U,  42.0f,  4.8f, 1000U},
    {2U,  98.0f,  2.8f, 1000U},
    {1U, 188.0f,  1.9f, 1000U},
    {0U, 256.0f,  0.98f, 8000U}
};

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

static uint8_t ClampU8(int32_t value, uint8_t min_value, uint8_t max_value)
{
    if (value < (int32_t)min_value)
    {
        return min_value;
    }

    if (value > (int32_t)max_value)
    {
        return max_value;
    }

    return (uint8_t)value;
}

static int16_t JoinBytes(uint8_t msb, uint8_t lsb)
{
    return (int16_t)(((uint16_t)msb << 8) | (uint16_t)lsb);
}

static float Vec3Norm(const Mpu6050Vec3f_t *v)
{
    return sqrtf((v->x * v->x) + (v->y * v->y) + (v->z * v->z));
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
 * @brief 计算最接近目标采样率的 `SMPLRT_DIV` 与实际输出频率。
 * @param internal_sample_hz DLPF 档位决定的内部输出率。
 * @param target_sample_hz 目标采样率。
 * @param out_div 输出 `SMPLRT_DIV`。
 * @param out_actual_sample_hz 输出实际采样率。
 *
 * @note MPU6050 的分频关系为：
 *       f_s = f_internal / (1 + SMPLRT_DIV)
 *       由于 `SMPLRT_DIV` 为整数，因此实际采样率一定是量化后的结果，
 *       不能假设目标频率必然被精确命中。
 */
static void MPU6050_ComputeSampleDivider(uint16_t internal_sample_hz,
                                         float target_sample_hz,
                                         uint8_t *out_div,
                                         float *out_actual_sample_hz)
{
    const float bounded_target_hz = ClampF(target_sample_hz,
                                           MPU6050_MIN_SAMPLE_HZ,
                                           (float)internal_sample_hz);
    const float divider_f = ((float)internal_sample_hz / bounded_target_hz) - 1.0f;
    const int32_t divider_i = (int32_t)lroundf(divider_f);
    const uint8_t divider = ClampU8(divider_i, 0U, 255U);

    *out_div = divider;
    *out_actual_sample_hz = (float)internal_sample_hz / (float)(divider + 1U);
}

/**
 * @brief 根据互补滤波交越频率与采样周期计算离散系数 alpha。
 * @param cutoff_hz 互补滤波交越频率。
 * @param dt_s 实际采样周期。
 * @return 陀螺预测项权重 alpha，范围 (0, 1)。
 *
 * @note 连续时间一阶低通 `LP(s) = wc / (s + wc)` 经指数离散化后，
 *       对应的互补滤波权重可写成：
 *       alpha = exp(-wc * Delta_t) = exp(-2π * f_c * Delta_t)
 *
 *       更新式因此为：
 *       theta_k = alpha * theta_gyro_pred + (1 - alpha) * theta_acc
 */
static float MPU6050_ComputeComplementaryAlpha(float cutoff_hz, float dt_s)
{
    const float bounded_cutoff_hz = ClampF(cutoff_hz, 0.1f, 80.0f);
    const float bounded_dt_s = ClampF(dt_s, MPU6050_MIN_VALID_DT_S, MPU6050_MAX_VALID_DT_S);
    const float alpha = expf(-MPU6050_TWO_PI * bounded_cutoff_hz * bounded_dt_s);

    return ClampF(alpha, 0.0f, 0.9999f);
}

/**
 * @brief 估算传感链路在闭环交越频率处吃掉的相位。
 * @param dlpf_delay_s 传感器 DLPF 典型时延。
 * @param sample_period_s 采样周期。
 * @param scheduler_delay_s 采样到解算的确定性调度延迟。
 * @param jitter_guard_s 抖动保护量，按最坏值近似。
 * @param crossover_hz 闭环或观测链关键交越频率。
 * @return 额外相位滞后，单位 deg。
 *
 * @note 工程上可把观测链近似成纯延迟：
 *       T_delay ≈ T_dlpf + Ts/2 + T_sched + T_jitter
 *       phi_delay_deg ≈ 360 * f_x * T_delay
 *
 *       这里的 `Ts/2` 来自零阶保持与离散采样的平均半拍滞后。
 */
static float MPU6050_EstimateSensorPhaseLagDeg(float dlpf_delay_s,
                                               float sample_period_s,
                                               float scheduler_delay_s,
                                               float jitter_guard_s,
                                               float crossover_hz)
{
    const float total_delay_s = dlpf_delay_s +
                                (0.5f * sample_period_s) +
                                scheduler_delay_s +
                                jitter_guard_s;

    return 360.0f * crossover_hz * total_delay_s;
}

/**
 * @brief 在可用 DLPF 档位中寻找满足相位预算的最强抑噪方案。
 * @param request 观测链需求。
 * @param out_plan 输出最终配置。
 * @retval true 找到可用方案。
 * @retval false 所有 DLPF 档位均无法满足采样率或相位约束。
 *
 * @note 选择策略遵循两条约束：
 *       1. `f_comp <= 0.1 * f_s`，避免互补滤波交越过于逼近离散边界；
 *       2. `phi_sensor <= phi_budget`，保证观测链不会先把相位裕量吃空。
 */
static bool MPU6050_BuildObserverPlan(const Mpu6050ObserverRequest_t *request,
                                      Mpu6050ObserverPlan_t *out_plan)
{
    const float phase_budget_deg = ClampF(request->max_sensor_phase_lag_deg,
                                          5.0f,
                                          MPU6050_MAX_SENSOR_PHASE_LAG_DEG);
    const float bounded_target_hz = ClampF(request->target_sample_hz,
                                           MPU6050_MIN_SAMPLE_HZ,
                                           MPU6050_MAX_SAMPLE_HZ);
    const float bounded_comp_cutoff_hz = ClampF(request->complementary_cutoff_hz, 0.2f, 80.0f);
    const float bounded_crossover_hz = ClampF(request->control_crossover_hz, 0.5f, 80.0f);
    const float scheduler_delay_s = ClampF(request->scheduler_delay_us, 0.0f, 5000.0f) * 1.0e-6f;
    const float jitter_guard_s = ClampF(request->jitter_guard_us, 0.0f, 3000.0f) * 1.0e-6f;

    for (size_t i = 0U; i < (sizeof(k_mpu6050_dlpf_profiles) / sizeof(k_mpu6050_dlpf_profiles[0])); ++i)
    {
        Mpu6050ObserverPlan_t plan;

        memset(&plan, 0, sizeof(plan));
        plan.profile = k_mpu6050_dlpf_profiles[i];
        MPU6050_ComputeSampleDivider(plan.profile.internal_sample_hz,
                                     bounded_target_hz,
                                     &plan.smplrt_div,
                                     &plan.actual_sample_hz);

        plan.dt_s = 1.0f / plan.actual_sample_hz;
        if (bounded_comp_cutoff_hz > (0.1f * plan.actual_sample_hz))
        {
            continue;
        }

        plan.complementary_alpha = MPU6050_ComputeComplementaryAlpha(bounded_comp_cutoff_hz, plan.dt_s);
        plan.sensor_delay_s = (plan.profile.gyro_delay_ms * 1.0e-3f) +
                              scheduler_delay_s +
                              jitter_guard_s +
                              (0.5f * plan.dt_s);
        plan.sensor_phase_lag_deg = MPU6050_EstimateSensorPhaseLagDeg(plan.profile.gyro_delay_ms * 1.0e-3f,
                                                                      plan.dt_s,
                                                                      scheduler_delay_s,
                                                                      jitter_guard_s,
                                                                      bounded_crossover_hz);

        if (plan.sensor_phase_lag_deg <= phase_budget_deg)
        {
            *out_plan = plan;
            return true;
        }
    }

    return false;
}

/**
 * @brief 按规划结果初始化 MPU6050。
 * @param imu MPU6050 句柄。
 * @param plan 已验证通过的观测链方案。
 * @retval HAL_OK 初始化成功。
 *
 * @note 这里固定使用 ±2 g 和 ±500 dps 档位。
 *       若量程调整，应同步修正后续物理量换算比例。
 */
HAL_StatusTypeDef MPU6050_InitWithPlan(Mpu6050Handle_t *imu, const Mpu6050ObserverPlan_t *plan)
{
    I2C_HandleTypeDef *hi2c;

    if ((imu == NULL) || (imu->hi2c == NULL) || (plan == NULL))
    {
        return HAL_ERROR;
    }

    hi2c = imu->hi2c;
    memset(imu, 0, sizeof(*imu));
    imu->hi2c = hi2c;
    imu->plan = *plan;

    if (MPU6050_WriteReg(imu, MPU6050_REG_PWR_MGMT_1, 0x01U) != HAL_OK) return HAL_ERROR;
    if (MPU6050_WriteReg(imu, MPU6050_REG_CONFIG, imu->plan.profile.dlpf_cfg) != HAL_OK) return HAL_ERROR;
    if (MPU6050_WriteReg(imu, MPU6050_REG_SMPLRT_DIV, imu->plan.smplrt_div) != HAL_OK) return HAL_ERROR;
    if (MPU6050_WriteReg(imu, MPU6050_REG_GYRO_CONFIG, 0x08U) != HAL_OK) return HAL_ERROR;
    if (MPU6050_WriteReg(imu, MPU6050_REG_ACCEL_CONFIG, 0x00U) != HAL_OK) return HAL_ERROR;

    return HAL_OK;
}

/**
 * @brief 读取一帧原始数据并执行互补滤波更新。
 * @param imu MPU6050 句柄。
 * @param dt_s 实际采样周期，推荐来自定时器时间戳而不是软件延时。
 * @retval HAL_OK 更新成功。
 * @retval HAL_ERROR I2C 失败或参数异常。
 *
 * @note 加速度姿态近似为：
 *       roll_acc  = atan2(a_y, a_z)
 *       pitch_acc = atan2(-a_x, sqrt(a_y^2 + a_z^2))
 *
 *       互补滤波更新为：
 *       theta_pred = theta_prev + (gyro_raw - bias) * Delta_t
 *       theta_new  = alpha * theta_pred + (1 - alpha) * theta_acc
 *
 *       当 `| ||a|| - 1g |` 过大时，说明线加速度污染明显，此时只保留陀螺预测项。
 */
HAL_StatusTypeDef MPU6050_UpdateComplementary(Mpu6050Handle_t *imu, float dt_s)
{
    uint8_t raw[14];
    Mpu6050Vec3f_t accel_g;
    Mpu6050Vec3f_t gyro_dps;
    const float bounded_dt_s = ClampF(dt_s, MPU6050_MIN_VALID_DT_S, MPU6050_MAX_VALID_DT_S);
    const float alpha = MPU6050_ComputeComplementaryAlpha(imu->plan.complementary_alpha == 0.0f ?
                                                          0.1f :
                                                          -logf(imu->plan.complementary_alpha) /
                                                          (MPU6050_TWO_PI * imu->plan.dt_s),
                                                          bounded_dt_s);
    float accel_norm_g;
    float roll_acc_deg;
    float pitch_acc_deg;
    float roll_pred_deg;
    float pitch_pred_deg;

    if ((imu == NULL) || (imu->hi2c == NULL))
    {
        return HAL_ERROR;
    }

    if (MPU6050_ReadBurst(imu, MPU6050_REG_ACCEL_XOUT_H, raw, sizeof(raw)) != HAL_OK)
    {
        return HAL_ERROR;
    }

    accel_g.x = (float)JoinBytes(raw[0], raw[1]) / MPU6050_ACCEL_SENS_2G;
    accel_g.y = (float)JoinBytes(raw[2], raw[3]) / MPU6050_ACCEL_SENS_2G;
    accel_g.z = (float)JoinBytes(raw[4], raw[5]) / MPU6050_ACCEL_SENS_2G;

    gyro_dps.x = ((float)JoinBytes(raw[8], raw[9]) / MPU6050_GYRO_SENS_500DPS) - imu->state.gyro_bias_dps.x;
    gyro_dps.y = ((float)JoinBytes(raw[10], raw[11]) / MPU6050_GYRO_SENS_500DPS) - imu->state.gyro_bias_dps.y;
    gyro_dps.z = ((float)JoinBytes(raw[12], raw[13]) / MPU6050_GYRO_SENS_500DPS) - imu->state.gyro_bias_dps.z;

    roll_acc_deg = atan2f(accel_g.y, accel_g.z) * MPU6050_RAD_TO_DEG;
    pitch_acc_deg = atan2f(-accel_g.x,
                           sqrtf((accel_g.y * accel_g.y) + (accel_g.z * accel_g.z))) * MPU6050_RAD_TO_DEG;

    roll_pred_deg = imu->state.roll_deg + (gyro_dps.x * bounded_dt_s);
    pitch_pred_deg = imu->state.pitch_deg + (gyro_dps.y * bounded_dt_s);

    accel_norm_g = Vec3Norm(&accel_g);
    imu->state.last_accel_norm_g = accel_norm_g;

    if (fabsf(accel_norm_g - 1.0f) <= MPU6050_MAX_ACCEL_NORM_ERR_G)
    {
        imu->state.roll_deg = (alpha * roll_pred_deg) + ((1.0f - alpha) * roll_acc_deg);
        imu->state.pitch_deg = (alpha * pitch_pred_deg) + ((1.0f - alpha) * pitch_acc_deg);
    }
    else
    {
        /*
         * 加速度模长偏离 1 g 过大时，当前测量更可能包含显著线加速度。
         * 这时若仍强行相信 `theta_acc`，会把刹车、颠簸和侧向加速度误并入姿态。
         */
        imu->state.roll_deg = roll_pred_deg;
        imu->state.pitch_deg = pitch_pred_deg;
    }

    return HAL_OK;
}

/*
 * 典型用法：
 *
 * Mpu6050Handle_t imu = {.hi2c = &hi2c1};
 * Mpu6050ObserverRequest_t request =
 * {
 *     .target_sample_hz = 200.0f,
 *     .complementary_cutoff_hz = 8.0f,
 *     .control_crossover_hz = 12.0f,
 *     .scheduler_delay_us = 350.0f,
 *     .jitter_guard_us = 120.0f,
 *     .max_sensor_phase_lag_deg = 20.0f
 * };
 * Mpu6050ObserverPlan_t plan;
 *
 * if (MPU6050_BuildObserverPlan(&request, &plan))
 * {
 *     // 例如该参数下常会落到 42 Hz 或 98 Hz DLPF 档，而不会盲目选 5 Hz。
 *     (void)MPU6050_InitWithPlan(&imu, &plan);
 * }
 *
 * // 随后在 200 Hz 定时任务里，用硬件时间戳计算 dt_s：
 * (void)MPU6050_UpdateComplementary(&imu, 0.005f);
 */
```

这段实现真正想表达的是，MPU6050 的姿态链路不该被拆成“传感器初始化”和“滤波公式”两块孤立代码。`DLPF_CFG`、`SMPLRT_DIV`、`Delta t`、互补交越频率和调度抖动，本质上都在共同决定同一件事：**控制器看到的姿态到底落后真实世界多少**。把这些参数统一进一套预算后，你得到的就不再只是一个“能跑”的 IMU 驱动，而是一条对噪声、混叠和相位裕量都可解释的观测链。
