---
title: "技能档案：MPU6050 的 Allan 方差、零偏随机游走与静止冻结校准"
slug: "skill-mpu6050-allan-variance-bias-random-walk-and-stationary-bias-freeze"
date: 2026-06-20T10:51:14+08:00
draft: false
description: "从 MEMS 陀螺的角随机游走、零偏不稳定性与温漂，到 Allan 方差识别、静止门控与温度分段补偿，系统拆解 MPU6050 的零偏为什么是时间函数而不是常数。"
tags: ["STM32", "MPU6050", "MEMS陀螺仪", "姿态解算", "Allan方差", "零偏校准"]
categories: ["技能档案"]
image: ""
---

## 技能概述

只要系统里有“角速度积分成角度”这条链路，`MPU6050` 的零偏就迟早会从后台走到台前。平衡车会莫名其妙越站越斜，云台会在静止时慢慢漂走，腿足机器人会在起步前就带着一份已经积累好的姿态债务。真正的痛点从来不是 `I2C` 能不能读到寄存器，而是 **MEMS 陀螺输出里的零偏并不是常数，它会随温度、时间、机械应力和噪声统计特性持续变化**。这个主题真正要解决的，是如何把 **Allan 方差**、**零偏随机游走**、**静止检测门控** 和 **在线冻结校准** 串成一份能落到 `STM32 HAL` 上的误差管理合同。

## 核心底层概念解析

- **MEMS 陀螺测到的不是“纯角速度”，而是振动结构在科里奥利力下的电学读数**：对 `MPU6050` 而言，更贴近工程 reality 的输出模型是  `omega_meas = omega_true + b(T, t) + n_white + n_quant + n_vib`。  这里 `b(T, t)` 是随温度和时间缓慢漂移的零偏，`n_white` 是白噪声，`n_vib` 则可能来自机体振动整流误差。姿态漂移很多时候不是算法“不会滤波”，而是把一份时间变化的偏置错当成常数。
- **积分会把零偏放大成角度债务**：离散姿态更新最朴素的写法是  `theta[k+1] = theta[k] + dt * (omega_meas[k] - b_hat[k])`。  若 `b_hat` 比真实零偏少补了 `0.2 deg/s`，一分钟后就会累计约 `12 deg` 的角度误差。陀螺零偏之所以难缠，根源不在它大，而在它被时间积分了。
- **Allan 方差不是论文装饰，而是“噪声按时间尺度怎么变”的地图**：对等长平均角速度序列 `y_k(tau)`，Allan 偏差可写为  `sigma_A(tau) = sqrt(0.5 * <(y[k+1] - y[k])^2>)`。  当 `log-log` 曲线呈 `-1/2` 斜率时，主导项通常是 **角随机游走**；出现平坦台阶时，常意味着 **零偏不稳定性**；若斜率转为 `+1/2`，则系统开始进入更慢的 **随机游走/漂移** 区域。它告诉你的不是“这个 IMU 好不好”，而是 **静止平均要取多长、在线偏置更新要信多快**。
- **静止检测不是看角速度接近零就结束，它本质上是在判断“当前观测能不能被当成偏置样本”**：常见门控至少要同时满足  `||omega|| < omega_th`  和  `| ||a|| - g | < a_th`。  前者防止实际还在旋转，后者防止设备虽然角速度很小，却正处在平移加速度、碰撞或振动台上。能进入偏置更新器的数据，必须先通过物理状态门禁。
- **温漂补偿处理的是“零偏随温度的确定性部分”，静止冻结处理的是“同温度下随时间漂移的随机部分”**：温漂可近似看成 `b_T = f(T)`，工程上常用分段线性表；同温度下残余偏置再用  `b_dyn[k+1] = b_dyn[k] + alpha * (omega_res[k] - b_dyn[k])`  在静止窗口内慢慢收敛。二者解决的是不同层次的问题，不能互相顶替。
- **冻结校准的关键不在“更新”，而在“何时停止更新”**：系统一旦离开静止状态，就不应继续把当前角速度往零偏里吞。否则快速转身、急刹车、机体共振都会被错误地写进偏置估计，随后整套姿态解算会带着一份伪校准继续跑。
- **FIFO/突发读取保证的是同一时刻，而不是更快的采样率**：`MPU6050` 的加速度、温度和陀螺数据若分寄存器零散读取，主循环抖动就会把它们撕成不同时间片。一次性突发读出 `14 bytes`，是在保护“这一帧物理状态是同一个时刻的截面”。
- **DLPF 和采样率配置影响的不只是噪声大小，还会影响静止判决的真假**：截止频率太高时，高频机械振动会直接抬高 `||omega||` 和 `||a||` 的统计量；截止频率太低时，又会把真实的小幅动作抹平成“仿佛静止”。静止门控阈值永远要和前端带宽一起讨论。
- **零偏估计必须带边界限幅，否则坏状态会把补偿器本身拖崩**：例如电机启停瞬间、传感器掉线重连、I2C 帧错位，都可能让某几帧陀螺值远离正常分布。若不对 `dt`、温度区间、偏置幅值和连续静止样本数做限幅，校准器就会把一次异常写成长期事实。
- **工程哲学上，零偏校准不是“让读数归零”，而是在数字系统里维护一条对物理静止的可信定义**：Allan 方差决定你该相信哪一段时间尺度，温漂表决定你先扣掉哪部分确定性偏差，静止门控决定哪些样本有资格进入偏置估计，冻结策略决定系统什么时候该承认“现在的运动是真实的，不是传感器错了”。这才是姿态系统长期稳定的底层秩序。

## 代码能力展现

下面给出一个基于 **STM32 HAL** 的 `MPU6050` 在线零偏校准示例。场景假设如下：

- `I2C1` 连接 `MPU6050`，设备地址为 `0x68`。
- `TIM2` 提供 `1 MHz` 自由运行计数器，用于测量实际采样间隔。
- `MPU6050` 工作在 `±8g`、`±500 dps` 档位，并通过 DLPF 限制高频噪声。
- 系统离线做过 Allan 方差测试，并据此给出了 **偏置更新时间常数** 与 **静止门控尺度**。

代码重点不在“把数据读出来”，而在把 **14 字节同帧采样**、**物理量映射**、**温度分段补偿**、**静止门控** 和 **静止窗口内的零偏冻结更新** 串成一条闭环。

```c
#include "main.h"

#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#define MPU6050_I2C_ADDR_7BIT                    0x68U
#define MPU6050_I2C_ADDR_8BIT                   (MPU6050_I2C_ADDR_7BIT << 1)

#define MPU6050_REG_SMPLRT_DIV                   0x19U
#define MPU6050_REG_CONFIG                       0x1AU
#define MPU6050_REG_GYRO_CONFIG                  0x1BU
#define MPU6050_REG_ACCEL_CONFIG                 0x1CU
#define MPU6050_REG_INT_ENABLE                   0x38U
#define MPU6050_REG_ACCEL_XOUT_H                 0x3BU
#define MPU6050_REG_PWR_MGMT_1                   0x6BU

#define MPU6050_ACCEL_LSB_PER_G                  4096.0f   /* ±8 g */
#define MPU6050_GYRO_LSB_PER_DPS                  65.5f    /* ±500 dps */
#define MPU6050_TEMP_LSB_PER_C                   340.0f
#define MPU6050_TEMP_OFFSET_C                     36.53f

#define MPU6050_GRAVITY_G                          1.0f
#define MPU6050_DEG_TO_RAD                         0.01745329252f
#define MPU6050_PI_F                               3.14159265359f

#define MPU6050_BIAS_LUT_POINTS                       5U
#define MPU6050_STATIC_COUNT_MAX                    255U
#define MPU6050_I2C_TIMEOUT_MS                       20U

typedef struct
{
    float x;
    float y;
    float z;
} Vec3f_t;

typedef struct
{
    float temp_c;
    Vec3f_t bias_dps;
} GyroBiasTempPoint_t;

typedef struct
{
    int16_t accel_x;
    int16_t accel_y;
    int16_t accel_z;
    int16_t temp_raw;
    int16_t gyro_x;
    int16_t gyro_y;
    int16_t gyro_z;
} Mpu6050RawFrame_t;

typedef struct
{
    Vec3f_t accel_g;
    Vec3f_t gyro_dps;
    float temp_c;
} Mpu6050PhysicalFrame_t;

typedef struct
{
    float gyro_norm_lpf_dps;
    float accel_err_lpf_g;
    uint8_t static_count;
    bool is_stationary;
} Mpu6050StationaryGate_t;

typedef struct
{
    I2C_HandleTypeDef *hi2c;
    TIM_HandleTypeDef *htim_timebase;

    float dt_min_s;
    float dt_max_s;
    float warmup_skip_s;

    float bias_update_tau_s;
    float static_gyro_threshold_dps;
    float static_accel_threshold_g;
    float static_gate_lpf_alpha;
    uint8_t static_hold_samples;

    float bias_limit_dps;
    GyroBiasTempPoint_t temp_lut[MPU6050_BIAS_LUT_POINTS];
} Mpu6050BiasCalConfig_t;

typedef struct
{
    uint32_t last_timestamp_us;
    float uptime_s;

    Vec3f_t temp_bias_dps;
    Vec3f_t dyn_bias_dps;
    Vec3f_t gyro_comp_dps;
    Vec3f_t gyro_comp_rad_s;

    Mpu6050StationaryGate_t gate;
} Mpu6050BiasCalState_t;

typedef struct
{
    Mpu6050BiasCalConfig_t cfg;
    Mpu6050BiasCalState_t state;
} Mpu6050BiasCalibrator_t;

static float Mpu6050_ClampF(float value, float min_value, float max_value)
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

static Vec3f_t Mpu6050_ClampVec3(const Vec3f_t *value, float abs_limit)
{
    Vec3f_t out = *value;

    out.x = Mpu6050_ClampF(out.x, -abs_limit, abs_limit);
    out.y = Mpu6050_ClampF(out.y, -abs_limit, abs_limit);
    out.z = Mpu6050_ClampF(out.z, -abs_limit, abs_limit);
    return out;
}

static float Mpu6050_Vec3Norm(const Vec3f_t *v)
{
    return sqrtf((v->x * v->x) + (v->y * v->y) + (v->z * v->z));
}

static Vec3f_t Mpu6050_Vec3Add(const Vec3f_t *a, const Vec3f_t *b)
{
    Vec3f_t out;

    out.x = a->x + b->x;
    out.y = a->y + b->y;
    out.z = a->z + b->z;
    return out;
}

static Vec3f_t Mpu6050_Vec3Sub(const Vec3f_t *a, const Vec3f_t *b)
{
    Vec3f_t out;

    out.x = a->x - b->x;
    out.y = a->y - b->y;
    out.z = a->z - b->z;
    return out;
}

static Vec3f_t Mpu6050_Vec3Scale(const Vec3f_t *v, float scale)
{
    Vec3f_t out;

    out.x = v->x * scale;
    out.y = v->y * scale;
    out.z = v->z * scale;
    return out;
}

static uint32_t Mpu6050_GetTimestampUs(const TIM_HandleTypeDef *htim_timebase)
{
    return __HAL_TIM_GET_COUNTER(htim_timebase);
}

/**
 * @brief 根据硬件时间戳计算本次采样步长，并做边界限幅。
 * @param cal 校准器对象。
 * @param now_us 当前时间戳，单位 us。
 * @return 本次有效步长，单位 s。
 *
 * @note 离散补偿公式中的更新系数显式依赖 dt：
 *       alpha = 1 - exp(-dt / tau)
 *
 *       若采样调度偶发抖动，直接使用原始 dt 可能把更新器瞬间拉得过快或过慢，
 *       因此这里将 dt 限制在 [dt_min_s, dt_max_s] 区间内。
 */
static float Mpu6050_ComputeDtSeconds(Mpu6050BiasCalibrator_t *cal, uint32_t now_us)
{
    uint32_t delta_us;

    if (cal->state.last_timestamp_us == 0U)
    {
        cal->state.last_timestamp_us = now_us;
        return cal->cfg.dt_min_s;
    }

    delta_us = now_us - cal->state.last_timestamp_us;
    cal->state.last_timestamp_us = now_us;

    return Mpu6050_ClampF((float)delta_us * 1.0e-6f,
                          cal->cfg.dt_min_s,
                          cal->cfg.dt_max_s);
}

static HAL_StatusTypeDef Mpu6050_WriteRegister(I2C_HandleTypeDef *hi2c,
                                               uint16_t dev_addr,
                                               uint8_t reg_addr,
                                               uint8_t value)
{
    return HAL_I2C_Mem_Write(hi2c,
                             dev_addr,
                             reg_addr,
                             I2C_MEMADD_SIZE_8BIT,
                             &value,
                             1U,
                             MPU6050_I2C_TIMEOUT_MS);
}

/**
 * @brief 配置 MPU6050 的采样率、DLPF 与量程。
 * @param cal 校准器对象。
 * @retval true  配置成功。
 * @retval false 任一寄存器写入失败。
 *
 * @note 这里选择的配置是：
 *       1. `SMPLRT_DIV = 4`，在 1 kHz 内部采样基准下得到约 200 Hz 输出；
 *       2. `CONFIG = 0x03`，启用较温和的 DLPF，削弱高频机械振动；
 *       3. `GYRO_CONFIG = 0x08`，设置到 ±500 dps；
 *       4. `ACCEL_CONFIG = 0x10`，设置到 ±8 g。
 *
 *       这些寄存器不只是“初始化流程”，它们直接决定静止检测看到的噪声带宽。
 */
bool Mpu6050_ConfigForBiasTracking(Mpu6050BiasCalibrator_t *cal)
{
    if (cal == NULL)
    {
        return false;
    }

    if (Mpu6050_WriteRegister(cal->cfg.hi2c, MPU6050_I2C_ADDR_8BIT, MPU6050_REG_PWR_MGMT_1, 0x01U) != HAL_OK)
    {
        return false;
    }

    if (Mpu6050_WriteRegister(cal->cfg.hi2c, MPU6050_I2C_ADDR_8BIT, MPU6050_REG_SMPLRT_DIV, 0x04U) != HAL_OK)
    {
        return false;
    }

    if (Mpu6050_WriteRegister(cal->cfg.hi2c, MPU6050_I2C_ADDR_8BIT, MPU6050_REG_CONFIG, 0x03U) != HAL_OK)
    {
        return false;
    }

    if (Mpu6050_WriteRegister(cal->cfg.hi2c, MPU6050_I2C_ADDR_8BIT, MPU6050_REG_GYRO_CONFIG, 0x08U) != HAL_OK)
    {
        return false;
    }

    if (Mpu6050_WriteRegister(cal->cfg.hi2c, MPU6050_I2C_ADDR_8BIT, MPU6050_REG_ACCEL_CONFIG, 0x10U) != HAL_OK)
    {
        return false;
    }

    if (Mpu6050_WriteRegister(cal->cfg.hi2c, MPU6050_I2C_ADDR_8BIT, MPU6050_REG_INT_ENABLE, 0x00U) != HAL_OK)
    {
        return false;
    }

    return true;
}

/**
 * @brief 突发读取一整帧加速度、温度与陀螺数据。
 * @param cal 校准器对象。
 * @param raw 输出原始帧。
 * @retval true  读取成功。
 * @retval false I2C 传输失败。
 *
 * @note 一次性读取 14 字节，是为了保证：
 *       accel / temp / gyro 对应同一个采样时刻。
 *       若拆成多次零散寄存器访问，主循环抖动会把它们撕裂成不同时间片。
 */
bool Mpu6050_ReadBurstFrame(Mpu6050BiasCalibrator_t *cal, Mpu6050RawFrame_t *raw)
{
    uint8_t buf[14];

    if ((cal == NULL) || (raw == NULL))
    {
        return false;
    }

    if (HAL_I2C_Mem_Read(cal->cfg.hi2c,
                         MPU6050_I2C_ADDR_8BIT,
                         MPU6050_REG_ACCEL_XOUT_H,
                         I2C_MEMADD_SIZE_8BIT,
                         buf,
                         sizeof(buf),
                         MPU6050_I2C_TIMEOUT_MS) != HAL_OK)
    {
        return false;
    }

    raw->accel_x = (int16_t)((buf[0] << 8) | buf[1]);
    raw->accel_y = (int16_t)((buf[2] << 8) | buf[3]);
    raw->accel_z = (int16_t)((buf[4] << 8) | buf[5]);
    raw->temp_raw = (int16_t)((buf[6] << 8) | buf[7]);
    raw->gyro_x = (int16_t)((buf[8] << 8) | buf[9]);
    raw->gyro_y = (int16_t)((buf[10] << 8) | buf[11]);
    raw->gyro_z = (int16_t)((buf[12] << 8) | buf[13]);
    return true;
}

/**
 * @brief 将原始寄存器值映射为物理量。
 * @param raw 原始帧。
 * @param phy 输出物理量帧。
 *
 * @note 映射公式为：
 *       accel_g = accel_raw / 4096
 *       gyro_dps = gyro_raw / 65.5
 *       temp_c = temp_raw / 340 + 36.53
 *
 *       这些线性映射是所有后续误差分析的起点；一旦量程配置变了，比例也必须同步变。
 */
static void Mpu6050_ConvertRawToPhysical(const Mpu6050RawFrame_t *raw, Mpu6050PhysicalFrame_t *phy)
{
    phy->accel_g.x = (float)raw->accel_x / MPU6050_ACCEL_LSB_PER_G;
    phy->accel_g.y = (float)raw->accel_y / MPU6050_ACCEL_LSB_PER_G;
    phy->accel_g.z = (float)raw->accel_z / MPU6050_ACCEL_LSB_PER_G;

    phy->gyro_dps.x = (float)raw->gyro_x / MPU6050_GYRO_LSB_PER_DPS;
    phy->gyro_dps.y = (float)raw->gyro_y / MPU6050_GYRO_LSB_PER_DPS;
    phy->gyro_dps.z = (float)raw->gyro_z / MPU6050_GYRO_LSB_PER_DPS;

    phy->temp_c = ((float)raw->temp_raw / MPU6050_TEMP_LSB_PER_C) + MPU6050_TEMP_OFFSET_C;
}

/**
 * @brief 按温度查表得到确定性温漂偏置。
 * @param cal 校准器对象。
 * @param temp_c 当前温度，单位 °C。
 * @return 三轴温漂偏置，单位 dps。
 *
 * @note 这里使用分段线性插值：
 *       ratio = (T - T_i) / (T_{i+1} - T_i)
 *       b_T = b_i + ratio * (b_{i+1} - b_i)
 *
 *       它描述的是零偏随温度的可重复部分，而不是随机漂移本身。
 */
static Vec3f_t Mpu6050_TemperatureBiasLookup(const Mpu6050BiasCalibrator_t *cal, float temp_c)
{
    uint32_t i;

    if (temp_c <= cal->cfg.temp_lut[0].temp_c)
    {
        return cal->cfg.temp_lut[0].bias_dps;
    }

    if (temp_c >= cal->cfg.temp_lut[MPU6050_BIAS_LUT_POINTS - 1U].temp_c)
    {
        return cal->cfg.temp_lut[MPU6050_BIAS_LUT_POINTS - 1U].bias_dps;
    }

    for (i = 0U; i < (MPU6050_BIAS_LUT_POINTS - 1U); ++i)
    {
        const GyroBiasTempPoint_t *p0 = &cal->cfg.temp_lut[i];
        const GyroBiasTempPoint_t *p1 = &cal->cfg.temp_lut[i + 1U];

        if ((temp_c >= p0->temp_c) && (temp_c <= p1->temp_c))
        {
            const float span = p1->temp_c - p0->temp_c;
            const float ratio = (span > 1.0e-6f) ? ((temp_c - p0->temp_c) / span) : 0.0f;
            Vec3f_t out;

            out.x = p0->bias_dps.x + ratio * (p1->bias_dps.x - p0->bias_dps.x);
            out.y = p0->bias_dps.y + ratio * (p1->bias_dps.y - p0->bias_dps.y);
            out.z = p0->bias_dps.z + ratio * (p1->bias_dps.z - p0->bias_dps.z);
            return out;
        }
    }

    return cal->cfg.temp_lut[0].bias_dps;
}

/**
 * @brief 更新静止门控状态。
 * @param cal 校准器对象。
 * @param gyro_residual_dps 扣除温漂表后的残余角速度，单位 dps。
 * @param accel_g 当前加速度，单位 g。
 * @return true  表示已经满足连续静止判据。
 * @return false 当前还不能把样本当作偏置观测。
 *
 * @note 判据分两层：
 *       1. 原始物理约束：||gyro|| < gyro_th 且 |||accel|| - 1g| < accel_th
 *       2. 时域约束：连续 static_hold_samples 个样本都满足才放行
 *
 *       这样做的目的，是避免把瞬时噪声低谷、采样缝隙或机械抖动错误识别为静止。
 */
static bool Mpu6050_UpdateStationaryGate(Mpu6050BiasCalibrator_t *cal,
                                         const Vec3f_t *gyro_residual_dps,
                                         const Vec3f_t *accel_g)
{
    const float alpha = Mpu6050_ClampF(cal->cfg.static_gate_lpf_alpha, 0.01f, 1.0f);
    const float gyro_norm = Mpu6050_Vec3Norm(gyro_residual_dps);
    const float accel_norm = Mpu6050_Vec3Norm(accel_g);
    const float accel_err = fabsf(accel_norm - MPU6050_GRAVITY_G);
    Mpu6050StationaryGate_t *gate = &cal->state.gate;
    const bool instant_static =
        (gyro_norm <= cal->cfg.static_gyro_threshold_dps) &&
        (accel_err <= cal->cfg.static_accel_threshold_g);

    gate->gyro_norm_lpf_dps =
        alpha * gyro_norm + (1.0f - alpha) * gate->gyro_norm_lpf_dps;
    gate->accel_err_lpf_g =
        alpha * accel_err + (1.0f - alpha) * gate->accel_err_lpf_g;

    if (instant_static &&
        (gate->gyro_norm_lpf_dps <= cal->cfg.static_gyro_threshold_dps) &&
        (gate->accel_err_lpf_g <= cal->cfg.static_accel_threshold_g))
    {
        if (gate->static_count < MPU6050_STATIC_COUNT_MAX)
        {
            gate->static_count++;
        }
    }
    else
    {
        gate->static_count = 0U;
    }

    gate->is_stationary = (gate->static_count >= cal->cfg.static_hold_samples);
    return gate->is_stationary;
}

/**
 * @brief 在静止窗口内更新动态零偏估计。
 * @param cal 校准器对象。
 * @param gyro_after_temp_dps 已扣除温漂表后的残余角速度，单位 dps。
 * @param dt_s 当前步长，单位 s。
 *
 * @note 更新律采用一阶离散低通：
 *       alpha = 1 - exp(-dt / tau_bias)
 *       b_dyn[k+1] = b_dyn[k] + alpha * (omega_res[k] - b_dyn[k])
 *
 *       其中 `tau_bias` 可由 Allan 方差上“白噪声主导区”与“偏置不稳定区”
 *       的交界时间尺度来选取。tau 太小会吞掉真实动作，tau 太大则偏置跟不上温升。
 */
static void Mpu6050_UpdateDynamicBias(Mpu6050BiasCalibrator_t *cal,
                                      const Vec3f_t *gyro_after_temp_dps,
                                      float dt_s)
{
    const float tau_s = fmaxf(cal->cfg.bias_update_tau_s, 1.0e-3f);
    const float alpha = Mpu6050_ClampF(1.0f - expf(-dt_s / tau_s), 0.0f, 1.0f);
    Vec3f_t error = Mpu6050_Vec3Sub(gyro_after_temp_dps, &cal->state.dyn_bias_dps);
    Vec3f_t step = Mpu6050_Vec3Scale(&error, alpha);

    cal->state.dyn_bias_dps = Mpu6050_Vec3Add(&cal->state.dyn_bias_dps, &step);
    cal->state.dyn_bias_dps =
        Mpu6050_ClampVec3(&cal->state.dyn_bias_dps, cal->cfg.bias_limit_dps);
}

/**
 * @brief 处理一帧 MPU6050 数据，并输出补偿后的角速度。
 * @param cal 校准器对象。
 * @param gyro_rad_s_out 输出补偿后的角速度，单位 rad/s。
 * @param stationary_out 输出当前是否处于稳定静止窗口。
 * @retval true  本帧处理成功。
 * @retval false 读传感器失败或参数非法。
 *
 * @note 整条补偿链路为：
 *       1. 突发读取同帧原始数据；
 *       2. 原始值映射到 g / dps / °C；
 *       3. 由温度查表扣除确定性偏置 `b_T(T)`；
 *       4. 用加速度模长与角速度模长判定是否允许更新动态偏置；
 *       5. 若静止且已过预热期，则更新 `b_dyn`，否则冻结；
 *       6. 输出 `omega_comp = omega_raw - b_T - b_dyn`。
 */
bool Mpu6050_ProcessBiasTracking(Mpu6050BiasCalibrator_t *cal,
                                 Vec3f_t *gyro_rad_s_out,
                                 bool *stationary_out)
{
    uint32_t now_us;
    float dt_s;
    Mpu6050RawFrame_t raw;
    Mpu6050PhysicalFrame_t phy;
    Vec3f_t gyro_after_temp_dps;
    Vec3f_t gyro_comp_dps;
    bool stationary;

    if ((cal == NULL) || (gyro_rad_s_out == NULL) || (stationary_out == NULL))
    {
        return false;
    }

    if (!Mpu6050_ReadBurstFrame(cal, &raw))
    {
        return false;
    }

    now_us = Mpu6050_GetTimestampUs(cal->cfg.htim_timebase);
    dt_s = Mpu6050_ComputeDtSeconds(cal, now_us);
    cal->state.uptime_s += dt_s;

    Mpu6050_ConvertRawToPhysical(&raw, &phy);
    cal->state.temp_bias_dps = Mpu6050_TemperatureBiasLookup(cal, phy.temp_c);

    gyro_after_temp_dps = Mpu6050_Vec3Sub(&phy.gyro_dps, &cal->state.temp_bias_dps);
    stationary = Mpu6050_UpdateStationaryGate(cal, &gyro_after_temp_dps, &phy.accel_g);

    if (stationary && (cal->state.uptime_s >= cal->cfg.warmup_skip_s))
    {
        Mpu6050_UpdateDynamicBias(cal, &gyro_after_temp_dps, dt_s);
    }

    gyro_comp_dps = Mpu6050_Vec3Sub(&gyro_after_temp_dps, &cal->state.dyn_bias_dps);
    gyro_comp_dps = Mpu6050_ClampVec3(&gyro_comp_dps, 1000.0f);

    cal->state.gyro_comp_dps = gyro_comp_dps;
    cal->state.gyro_comp_rad_s = Mpu6050_Vec3Scale(&gyro_comp_dps, MPU6050_DEG_TO_RAD);

    *gyro_rad_s_out = cal->state.gyro_comp_rad_s;
    *stationary_out = stationary;
    return true;
}

/**
 * @brief 初始化零偏校准器。
 * @param cal 校准器对象。
 * @param hi2c 对应的 I2C 句柄。
 * @param htim_timebase 1 MHz 自由运行时间基。
 */
void Mpu6050_BiasCalibratorInit(Mpu6050BiasCalibrator_t *cal,
                                I2C_HandleTypeDef *hi2c,
                                TIM_HandleTypeDef *htim_timebase)
{
    memset(cal, 0, sizeof(*cal));

    cal->cfg.hi2c = hi2c;
    cal->cfg.htim_timebase = htim_timebase;
    cal->cfg.dt_min_s = 0.002f;
    cal->cfg.dt_max_s = 0.010f;
    cal->cfg.warmup_skip_s = 8.0f;

    /*
     * 这里假设离线 Allan 方差测试表明：
     * 1. 白噪声主导区与偏置不稳定区的交界时间常数约在 4~8 s；
     * 2. 因此在线动态偏置更新的 tau 选择 6 s，避免追得过快。
     */
    cal->cfg.bias_update_tau_s = 6.0f;
    cal->cfg.static_gyro_threshold_dps = 0.80f;
    cal->cfg.static_accel_threshold_g = 0.05f;
    cal->cfg.static_gate_lpf_alpha = 0.20f;
    cal->cfg.static_hold_samples = 20U;
    cal->cfg.bias_limit_dps = 8.0f;

    /*
     * 温漂表来自离线恒温箱标定，表示的是确定性偏置。
     * 现场若更换安装方式、供电或封装应力，这张表也要重新测。
     */
    cal->cfg.temp_lut[0].temp_c = 20.0f;
    cal->cfg.temp_lut[0].bias_dps = (Vec3f_t){ 0.62f, -0.38f, 0.54f };
    cal->cfg.temp_lut[1].temp_c = 28.0f;
    cal->cfg.temp_lut[1].bias_dps = (Vec3f_t){ 0.44f, -0.21f, 0.33f };
    cal->cfg.temp_lut[2].temp_c = 36.0f;
    cal->cfg.temp_lut[2].bias_dps = (Vec3f_t){ 0.27f, -0.05f, 0.15f };
    cal->cfg.temp_lut[3].temp_c = 44.0f;
    cal->cfg.temp_lut[3].bias_dps = (Vec3f_t){ 0.10f, 0.12f, -0.02f };
    cal->cfg.temp_lut[4].temp_c = 52.0f;
    cal->cfg.temp_lut[4].bias_dps = (Vec3f_t){ -0.05f, 0.24f, -0.19f };

    HAL_TIM_Base_Start(htim_timebase);
}

extern I2C_HandleTypeDef hi2c1;
extern TIM_HandleTypeDef htim2;

static Mpu6050BiasCalibrator_t g_mpu6050_cal;

void App_ImuInit(void)
{
    Mpu6050_BiasCalibratorInit(&g_mpu6050_cal, &hi2c1, &htim2);
    (void)Mpu6050_ConfigForBiasTracking(&g_mpu6050_cal);
}

void App_ImuTask(void)
{
    Vec3f_t gyro_rad_s;
    bool is_stationary;

    if (Mpu6050_ProcessBiasTracking(&g_mpu6050_cal, &gyro_rad_s, &is_stationary))
    {
        /*
         * 这里的 gyro_rad_s 已经完成：
         * raw -> 物理量 -> 温漂补偿 -> 动态偏置冻结校准
         * 后续互补滤波、EKF 或姿态积分都应使用这一版补偿结果。
         */
        (void)is_stationary;
    }
}
```

这段实现里有几处工程重点值得单独指出：

- `Mpu6050_ConfigForBiasTracking()` 把 `SMPLRT_DIV`、`DLPF` 和量程显式写了出来，因为静止门控阈值必须和前端带宽一起定，不能只在算法层拍脑袋。
- `Mpu6050_ReadBurstFrame()` 强制使用 `14 bytes` 同帧突发读取，避免加速度与陀螺时间错位后污染静止判决。
- `Mpu6050_TemperatureBiasLookup()` 只处理 **可重复温漂**，`Mpu6050_UpdateDynamicBias()` 只在连续静止窗口内处理 **随机漂移**，两条误差链被刻意拆开，符合 `DRY` 和单一职责。
- 动态偏置更新公式 `b_dyn[k+1] = b_dyn[k] + alpha * (omega_res[k] - b_dyn[k])` 明确写出了 `alpha = 1 - exp(-dt / tau)`，让时间常数和采样周期的关系可见、可算、可调。
- `warmup_skip_s`、`static_hold_samples`、`bias_limit_dps` 和 `dt` 限幅一起构成了保护边界，防的是开机热漂、振动误判、通信抖动与异常帧把校准器本身带偏。

如果再往前走一步，这套骨架还可以继续扩展到：

- 把 Allan 方差离线识别出的白噪声密度和随机游走参数直接映射到 EKF 的 `Q`。
- 将静止门控从“阈值 + 连续计数”升级为方差窗、谱能量或零角速度约束联合判定。
- 结合温度导数 `dT/dt` 做升温阶段的非稳态补偿，而不是只靠静态温漂表。

但无论怎么扩展，底层原则都不会变：**零偏不是一串出厂常量，而是一条随时间缓慢漂移、只在某些物理状态下才允许被重新估计的动态信号。**
