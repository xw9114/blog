---
title: "技能档案：视觉-IMU 时间对齐中的曝光中点、滚动快门与姿态补偿"
slug: "skill-vision-imu-exposure-midpoint-rolling-shutter-attitude-compensation"
date: 2026-05-30T12:37:46+08:00
draft: false
description: "从曝光中点、滚动快门逐行扫描、MPU6050 陀螺积分到像素射线稳定化，系统拆解视觉与 IMU 融合为何常常先败在时间轴而不是坐标轴。"
tags: ["STM32", "MPU6050", "传感器融合", "滚动快门", "时间同步", "姿态补偿", "机器视觉"]
categories: ["技能档案", "机器视觉", "控制与融合"]
image: ""
---

## 技能概述

视觉和 IMU 融合常被误解成“做完坐标系标定，再把姿态角喂给视觉结果”。真正难的地方其实更靠前: 相机一帧图像不是在同一个时刻形成，MPU6050 给出的姿态也不是“此刻真值”，而是带着采样分频、DLPF 群延迟、总线搬运和滤波滞后的一个时间切片。只要时间轴没有对齐，像素里看到的偏移就会混入机体运动造成的假位移，后面的 PnP、地面投影、跟踪闭环和目标角度控制都会在错误的物理时刻上用力。这个主题解决的核心痛点，不是“怎么取一组姿态角”，而是如何把 **曝光中点**、**滚动快门行延迟**、**陀螺短时外推** 和 **像素射线映射** 绑定成同一份时域合同。

## 核心底层概念解析

- **帧时间戳不是单点事件，而是一段曝光与读出的时间区间**：很多相机模块上报的 `frame_timestamp` 实际可能对应 **SOF**、**EOF**、DMA 收包完成时刻，甚至是上位机解包时刻。若把它们都当成“这一帧的真实观测时刻”，视觉和惯导一开始就说的不是同一时间。
- **曝光中点** 才更接近“这一帧平均看到了什么”**：若全局快门一帧曝光宽度为 `T_exp`，更合理的观测时刻应近似写成 `t_mid = t_sof + T_exp / 2`。用曝光起点代替中点，会引入一个固定的半曝光宽度误差；角速度越高，这个误差越会直接长成像素偏移。
- **滚动快门不是整帧同时成像，而是逐行签署时间戳**：对第 `v` 行像素，更合理的观测时刻应写成  
  `t_row(v) = t_sof + T_exp / 2 + (v + 0.5 - H / 2) * T_line`，  
  其中 `H` 是图像高度，`T_line` 是单行扫描时间。图像底部那一行和顶部那一行，看到的其实不是同一个机体姿态。
- **时间误差会被焦距直接放大成像素误差**：小角度下，姿态错位引发的像素漂移可近似写成  
  `Δu ≈ f_x * ω_y * Δt`，`Δv ≈ f_y * ω_x * Δt`。  
  例如 `f_x = 720 px`、俯仰角速度 `ω_y = 2 rad/s`、时间错位 `Δt = 6 ms`，单这一项就足以制造约 `8.6 px` 的虚假横向位移。
- **MPU6050 的“样本时刻”不等于中断到达时刻**：陀螺和加速度先经过内部采样、DLPF，再通过 I2C 被主控读走。若把 `HAL_I2C_MemRxCpltCallback()` 到达时刻直接当作物理采样时刻，系统就把总线搬运延迟和滤波群延迟误写进了时间轴。
- **姿态滤波器给你的常常是“更平滑但更晚”的状态**：互补滤波、Mahony、Madgwick 甚至卡尔曼滤波都可能引入额外相位滞后。对行级补偿这种亚毫秒到数毫秒的短时预测，真正该信的通常是 **去零偏后的陀螺角速度**，而不是已经被低通和平滑处理过的欧拉角。
- **时间同步和外参标定是串联关系，不是替代关系**：`R_bc` 没标对，时间补偿只会更精确地沿错误方向补；时间没对齐，外参再准也只是在解释已经变形过的图像。视觉-IMU 融合必须先同时承认 **空间旋转误差** 和 **时间错位误差** 都会投影到同一组像素上。
- **行延迟补偿本质是短时间姿态外推**：若在曝光中点获得机体系角速度 `ω_b`，则某一行相对于中点的姿态增量可近似写成  
  `Δθ_b ≈ (ω_b - b_g) * Δt_row`，  
  其中 `b_g` 是陀螺零偏，`Δt_row` 是该行相对中点的时间偏移。进一步可用小角度四元数 `δq ≈ [1, Δθ_x/2, Δθ_y/2, Δθ_z/2]` 完成姿态修正。
- **滚动快门补偿不是只修正图像，而是修正“像素背后的射线时刻”**：像素 `(u, v)` 首先映射成归一化光线 `r_c = normalize([(u-cx)/fx, (v-cy)/fy, 1])`；随后要用“这一行真正对应的姿态”把它旋到机体或重力坐标系，而不是偷懒使用整帧同一个姿态。
- **高动态场景里，行时间甚至比曝光时间更关键**：对 30 fps 的低速平台，`T_exp` 可能主导误差；但在云台、平衡车、飞行器这类角速度较高的场景，`H * T_line` 带来的顶部到底部姿态差，常常比你想象得更早成为一阶误差源。
- **工程上最怕的是把所有延迟都混成一个经验常数**：相机链路有触发到曝光延迟、曝光宽度、读出行时间、串口传输时间；IMU 链路有采样分频、DLPF 群延迟、I2C 读出延迟、姿态滤波延迟。把它们一股脑写成“经验补偿 12 ms”，短期也许能跑，换帧率、换曝光、换 ROI 立刻失效。
- **调试这类系统时，示波器比日志更接近真相**：`VSYNC`、`frame valid`、相机串口包到达、MPU6050 `DRDY`、定时器捕获边沿，这些信号能告诉你真实物理时刻；软件日志往往记录的是“CPU 终于看到它的时候”。
- **技术哲学上，融合不是把两个传感器结果相加，而是先让它们在同一时刻描述同一个世界**：如果时间轴都没校平，坐标变换、滤波增益和闭环控制不过是在高精度地消费一份时刻错误的观测。

## 代码能力展现

下面给出一个基于 STM32 HAL 使用场景的视觉-IMU 时间补偿模块。假设系统中:

- `TIM2` 以 `1 MHz` 自由运行，作为全局微秒时基。
- MPU6050 由定时任务周期读取，姿态滤波器持续产出 **机体系 B 到重力对齐坐标系 L** 的四元数，以及去量纲前的原始陀螺角速度。
- 相机侧通过 UART/SPI 送来目标中心 `(u, v)`、`SOF` 时间戳、曝光时间和单行扫描时间。

代码重点不是“如何初始化外设”，而是如何把 **相机时间元数据 -> 曝光中点 -> 行时间偏移 -> 陀螺短时外推 -> 像素射线姿态补偿** 这条链明确表达出来。

```c
#include "main.h"

#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#define FUSION_IMU_RING_SIZE                 64U
#define FUSION_MIN_FOCAL_PX                  16.0f
#define FUSION_MAX_IMAGE_SIZE                4096U
#define FUSION_MAX_EXPOSURE_US               40000.0f
#define FUSION_MAX_LINE_TIME_US              200.0f
#define FUSION_MAX_ROW_DT_S                  0.020f
#define FUSION_MIN_INTERP_DT_US              1U
#define FUSION_EPSILON                       1.0e-6f
#define FUSION_DEG_TO_RAD                    0.017453292519943295f

typedef struct
{
    float x;
    float y;
    float z;
} Vec3f_t;

typedef struct
{
    float w;
    float x;
    float y;
    float z;
} Quatf_t;

typedef struct
{
    float m[3][3];
} Mat3f_t;

typedef struct
{
    uint32_t physical_timestamp_us;
    Quatf_t q_lb;
    Vec3f_t gyro_rad_s_b;
} ImuStateSample_t;

typedef struct
{
    float fx_px;
    float fy_px;
    float cx_px;
    float cy_px;
    uint16_t image_width_px;
    uint16_t image_height_px;
} VisionIntrinsics_t;

typedef struct
{
    Mat3f_t r_bc;
    int32_t camera_to_mcu_offset_us;
    float imu_group_delay_us;
    Vec3f_t gyro_bias_rad_s;
} FusionTimingRig_t;

typedef struct
{
    uint32_t sof_timestamp_us;
    float exposure_us;
    float line_time_us;
    float u_px;
    float v_px;
} VisionObservation_t;

typedef struct
{
    uint32_t t_mid_us;
    uint32_t t_row_us;
    float row_dt_s;
    Quatf_t q_mid_lb;
    Quatf_t q_row_lb;
    Vec3f_t ray_c;
    Vec3f_t ray_b;
    Vec3f_t ray_l;
    float yaw_rad;
    float pitch_rad;
} CompensatedObservation_t;

typedef struct
{
    VisionIntrinsics_t intrinsics;
    FusionTimingRig_t rig;
    ImuStateSample_t imu_ring[FUSION_IMU_RING_SIZE];
    uint16_t head;
    uint16_t count;
} VisionImuFusion_t;

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

static uint32_t ClampU32(uint32_t value, uint32_t min_value, uint32_t max_value)
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

static int32_t TimeDiffUs(uint32_t newer, uint32_t older)
{
    return (int32_t)(newer - older);
}

static Vec3f_t Vec3Add(Vec3f_t a, Vec3f_t b)
{
    Vec3f_t out = {a.x + b.x, a.y + b.y, a.z + b.z};
    return out;
}

static Vec3f_t Vec3Sub(Vec3f_t a, Vec3f_t b)
{
    Vec3f_t out = {a.x - b.x, a.y - b.y, a.z - b.z};
    return out;
}

static Vec3f_t Vec3Scale(Vec3f_t v, float scale)
{
    Vec3f_t out = {v.x * scale, v.y * scale, v.z * scale};
    return out;
}

static float Vec3Dot(Vec3f_t a, Vec3f_t b)
{
    return (a.x * b.x) + (a.y * b.y) + (a.z * b.z);
}

static Vec3f_t Vec3Normalize(Vec3f_t v)
{
    const float norm_sq = Vec3Dot(v, v);

    if (norm_sq <= FUSION_EPSILON)
    {
        Vec3f_t fallback = {0.0f, 0.0f, 1.0f};
        return fallback;
    }

    return Vec3Scale(v, 1.0f / sqrtf(norm_sq));
}

static Vec3f_t Vec3Lerp(Vec3f_t a, Vec3f_t b, float ratio)
{
    return Vec3Add(a, Vec3Scale(Vec3Sub(b, a), ratio));
}

static Quatf_t QuatNormalize(Quatf_t q)
{
    const float norm_sq = (q.w * q.w) + (q.x * q.x) + (q.y * q.y) + (q.z * q.z);

    if (norm_sq <= FUSION_EPSILON)
    {
        Quatf_t identity = {1.0f, 0.0f, 0.0f, 0.0f};
        return identity;
    }

    const float inv_norm = 1.0f / sqrtf(norm_sq);
    q.w *= inv_norm;
    q.x *= inv_norm;
    q.y *= inv_norm;
    q.z *= inv_norm;
    return q;
}

static float QuatDot(Quatf_t a, Quatf_t b)
{
    return (a.w * b.w) + (a.x * b.x) + (a.y * b.y) + (a.z * b.z);
}

static Quatf_t QuatMultiply(Quatf_t a, Quatf_t b)
{
    Quatf_t out;

    out.w = (a.w * b.w) - (a.x * b.x) - (a.y * b.y) - (a.z * b.z);
    out.x = (a.w * b.x) + (a.x * b.w) + (a.y * b.z) - (a.z * b.y);
    out.y = (a.w * b.y) - (a.x * b.z) + (a.y * b.w) + (a.z * b.x);
    out.z = (a.w * b.z) + (a.x * b.y) - (a.y * b.x) + (a.z * b.w);

    return out;
}

static Quatf_t QuatConjugate(Quatf_t q)
{
    Quatf_t out = {q.w, -q.x, -q.y, -q.z};
    return out;
}

static Quatf_t QuatNlerp(Quatf_t a, Quatf_t b, float ratio)
{
    Quatf_t out;

    ratio = ClampF(ratio, 0.0f, 1.0f);

    /*
     * 四元数 q 与 -q 表示同一旋转。
     * 若点积为负，说明两者在四维球面上走的是“长弧”，
     * 先翻转其中一个端点可避免插值穿越 180 deg 造成跳变。
     */
    if (QuatDot(a, b) < 0.0f)
    {
        b.w = -b.w;
        b.x = -b.x;
        b.y = -b.y;
        b.z = -b.z;
    }

    out.w = ((1.0f - ratio) * a.w) + (ratio * b.w);
    out.x = ((1.0f - ratio) * a.x) + (ratio * b.x);
    out.y = ((1.0f - ratio) * a.y) + (ratio * b.y);
    out.z = ((1.0f - ratio) * a.z) + (ratio * b.z);

    return QuatNormalize(out);
}

static Quatf_t QuatFromSmallAngle(Vec3f_t delta_theta_rad)
{
    Quatf_t delta_q;

    /*
     * 小角度近似:
     * delta_q ~= [1, dtheta_x / 2, dtheta_y / 2, dtheta_z / 2]
     *
     * 它来自旋转四元数:
     * q = [cos(|dtheta| / 2), axis * sin(|dtheta| / 2)]
     * 当 |dtheta| 足够小时, cos(x) ~= 1, sin(x) ~= x。
     */
    delta_q.w = 1.0f;
    delta_q.x = 0.5f * delta_theta_rad.x;
    delta_q.y = 0.5f * delta_theta_rad.y;
    delta_q.z = 0.5f * delta_theta_rad.z;

    return QuatNormalize(delta_q);
}

static Vec3f_t QuatRotateVec3(Quatf_t q, Vec3f_t v)
{
    Quatf_t p = {0.0f, v.x, v.y, v.z};
    Quatf_t rotated = QuatMultiply(QuatMultiply(q, p), QuatConjugate(q));
    Vec3f_t out = {rotated.x, rotated.y, rotated.z};
    return out;
}

static Vec3f_t Mat3MulVec3(const Mat3f_t *m, Vec3f_t v)
{
    Vec3f_t out;

    out.x = (m->m[0][0] * v.x) + (m->m[0][1] * v.y) + (m->m[0][2] * v.z);
    out.y = (m->m[1][0] * v.x) + (m->m[1][1] * v.y) + (m->m[1][2] * v.z);
    out.z = (m->m[2][0] * v.x) + (m->m[2][1] * v.y) + (m->m[2][2] * v.z);

    return out;
}

static uint16_t FusionOldestIndex(const VisionImuFusion_t *fusion)
{
    return (uint16_t)((fusion->head + FUSION_IMU_RING_SIZE - fusion->count) % FUSION_IMU_RING_SIZE);
}

static uint16_t FusionOrderedIndex(const VisionImuFusion_t *fusion, uint16_t order)
{
    return (uint16_t)((FusionOldestIndex(fusion) + order) % FUSION_IMU_RING_SIZE);
}

/**
 * @brief 压入一帧 IMU 状态样本，并把时间戳修正到“物理采样时刻”。
 * @param fusion 融合句柄，内部保存相机内参、时序参数和 IMU 环形缓冲区。
 * @param irq_timestamp_us MCU 在本次 IMU 结果到达时记录的本地时间戳，单位 us。
 * @param q_lb 机体系 B 到重力对齐坐标系 L 的姿态四元数。
 * @param gyro_dps_b 机体系角速度，单位 deg/s。
 * @retval true 写入成功。
 * @retval false 参数非法或时间戳逆序。
 *
 * @note IMU 物理样本时刻不是 I2C 回调到达时刻，而应近似修正为:
 *       t_phys = t_irq - t_group_delay
 *       其中 t_group_delay 既包含 DLPF 群延迟，也可以吸收少量固定搬运延迟。
 */
static bool FusionPushImuSample(VisionImuFusion_t *fusion,
                                uint32_t irq_timestamp_us,
                                Quatf_t q_lb,
                                Vec3f_t gyro_dps_b)
{
    ImuStateSample_t sample;
    const uint16_t newest_index =
        (uint16_t)((fusion->head + FUSION_IMU_RING_SIZE - 1U) % FUSION_IMU_RING_SIZE);

    if (fusion == NULL)
    {
        return false;
    }

    sample.physical_timestamp_us =
        irq_timestamp_us - (uint32_t)ClampF(fusion->rig.imu_group_delay_us, 0.0f, 50000.0f);
    sample.q_lb = QuatNormalize(q_lb);
    sample.gyro_rad_s_b.x = gyro_dps_b.x * FUSION_DEG_TO_RAD;
    sample.gyro_rad_s_b.y = gyro_dps_b.y * FUSION_DEG_TO_RAD;
    sample.gyro_rad_s_b.z = gyro_dps_b.z * FUSION_DEG_TO_RAD;

    if ((fusion->count > 0U) &&
        (TimeDiffUs(sample.physical_timestamp_us, fusion->imu_ring[newest_index].physical_timestamp_us) < 0))
    {
        return false;
    }

    fusion->imu_ring[fusion->head] = sample;
    fusion->head = (uint16_t)((fusion->head + 1U) % FUSION_IMU_RING_SIZE);

    if (fusion->count < FUSION_IMU_RING_SIZE)
    {
        fusion->count++;
    }

    return true;
}

/**
 * @brief 对指定时刻插值 IMU 姿态与角速度。
 * @param fusion 融合句柄。
 * @param timestamp_us 目标时间戳，单位 us。
 * @param out_q_lb 输出插值姿态。
 * @param out_gyro_rad_s_b 输出插值角速度，单位 rad/s。
 * @retval true 插值成功。
 * @retval false 样本不足或参数非法。
 *
 * @note 这里用 nlerp 对姿态插值，用线性插值对角速度插值。
 *       这样做的目的不是追求“数学上最华丽”，而是让短时间内的时间对齐
 *       足够稳定、实现足够直接，并且不会在 MCU 上带来额外计算负担。
 */
static bool FusionInterpolateImuState(const VisionImuFusion_t *fusion,
                                      uint32_t timestamp_us,
                                      Quatf_t *out_q_lb,
                                      Vec3f_t *out_gyro_rad_s_b)
{
    uint16_t i;

    if ((fusion == NULL) || (out_q_lb == NULL) || (out_gyro_rad_s_b == NULL) || (fusion->count == 0U))
    {
        return false;
    }

    if (fusion->count == 1U)
    {
        const ImuStateSample_t *sample = &fusion->imu_ring[FusionOrderedIndex(fusion, 0U)];
        *out_q_lb = sample->q_lb;
        *out_gyro_rad_s_b = sample->gyro_rad_s_b;
        return true;
    }

    for (i = 0U; i < (fusion->count - 1U); ++i)
    {
        const ImuStateSample_t *left = &fusion->imu_ring[FusionOrderedIndex(fusion, i)];
        const ImuStateSample_t *right = &fusion->imu_ring[FusionOrderedIndex(fusion, (uint16_t)(i + 1U))];

        if (TimeDiffUs(timestamp_us, left->physical_timestamp_us) <= 0)
        {
            *out_q_lb = left->q_lb;
            *out_gyro_rad_s_b = left->gyro_rad_s_b;
            return true;
        }

        if ((TimeDiffUs(timestamp_us, left->physical_timestamp_us) >= 0) &&
            (TimeDiffUs(right->physical_timestamp_us, timestamp_us) >= 0))
        {
            const uint32_t dt_us =
                ClampU32(right->physical_timestamp_us - left->physical_timestamp_us,
                         FUSION_MIN_INTERP_DT_US,
                         1000000U);
            const float ratio =
                (float)(timestamp_us - left->physical_timestamp_us) / (float)dt_us;

            *out_q_lb = QuatNlerp(left->q_lb, right->q_lb, ratio);
            *out_gyro_rad_s_b = Vec3Lerp(left->gyro_rad_s_b, right->gyro_rad_s_b, ratio);
            return true;
        }
    }

    *out_q_lb = fusion->imu_ring[FusionOrderedIndex(fusion, (uint16_t)(fusion->count - 1U))].q_lb;
    *out_gyro_rad_s_b = fusion->imu_ring[FusionOrderedIndex(fusion, (uint16_t)(fusion->count - 1U))].gyro_rad_s_b;
    return true;
}

/**
 * @brief 计算当前视觉目标对应的曝光中点时间戳。
 * @param fusion 融合句柄。
 * @param observation 视觉观测，含 SOF 时间戳和曝光参数。
 * @return 曝光中点对应的 MCU 本地时间戳，单位 us。
 *
 * @note 时间映射公式:
 *       t_mid = t_sof + camera_to_mcu_offset + T_exp / 2
 *
 *       其中 `camera_to_mcu_offset` 用于吸收相机时钟域与 MCU 时钟域之间的固定偏置，
 *       它不是“拍脑袋延时”，而应通过硬件触发或对时流程标定得到。
 */
static uint32_t FusionComputeExposureMidUs(const VisionImuFusion_t *fusion,
                                           const VisionObservation_t *observation)
{
    const float exposure_us = ClampF(observation->exposure_us, 1.0f, FUSION_MAX_EXPOSURE_US);
    const int32_t offset_us = fusion->rig.camera_to_mcu_offset_us;
    const int64_t mid_time =
        (int64_t)observation->sof_timestamp_us + (int64_t)offset_us + (int64_t)lroundf(exposure_us * 0.5f);

    return (uint32_t)((mid_time < 0LL) ? 0U : (uint32_t)mid_time);
}

/**
 * @brief 根据目标所在图像行，计算该行相对曝光中点的时间偏移。
 * @param fusion 融合句柄。
 * @param observation 视觉观测。
 * @return 行时间偏移，单位 s。
 *
 * @note 滚动快门逐行时序模型:
 *       delta_t_row = ((v + 0.5) - H / 2) * T_line
 *
 *       这里使用 `v + 0.5` 表示像素中心所在的扫描行中心，而非行边界。
 */
static float FusionComputeRowOffsetS(const VisionImuFusion_t *fusion,
                                     const VisionObservation_t *observation)
{
    const float bounded_v =
        ClampF(observation->v_px,
               0.0f,
               (float)((fusion->intrinsics.image_height_px > 0U) ? (fusion->intrinsics.image_height_px - 1U) : 0U));
    const float image_center_row = 0.5f * (float)fusion->intrinsics.image_height_px;
    const float line_time_us = ClampF(observation->line_time_us, 0.0f, FUSION_MAX_LINE_TIME_US);
    const float delta_row = (bounded_v + 0.5f) - image_center_row;
    const float row_dt_s = (delta_row * line_time_us) * 1.0e-6f;

    return ClampF(row_dt_s, -FUSION_MAX_ROW_DT_S, FUSION_MAX_ROW_DT_S);
}

static Vec3f_t FusionPixelToRayC(const VisionImuFusion_t *fusion, float u_px, float v_px)
{
    Vec3f_t ray_c;

    /*
     * 像素到归一化射线映射:
     * x_n = (u - cx) / fx
     * y_n = (v - cy) / fy
     * r_c = normalize([x_n, y_n, 1])
     */
    ray_c.x = (u_px - fusion->intrinsics.cx_px) / fusion->intrinsics.fx_px;
    ray_c.y = (v_px - fusion->intrinsics.cy_px) / fusion->intrinsics.fy_px;
    ray_c.z = 1.0f;

    return Vec3Normalize(ray_c);
}

/**
 * @brief 结合曝光中点与滚动快门行延迟，计算姿态补偿后的视觉射线。
 * @param fusion 融合句柄。
 * @param observation 视觉观测。
 * @param out 输出补偿结果。
 * @retval true 计算成功。
 * @retval false 参数非法、内参不合法或 IMU 缓冲区不足以覆盖目标时间。
 *
 * @note 计算链路:
 *       1. t_mid = t_sof + T_exp / 2 + offset
 *       2. delta_t_row = ((v + 0.5) - H / 2) * T_line
 *       3. Delta_theta = (omega_b - bias_b) * delta_t_row
 *       4. q_row = normalize(q_mid * delta_q)
 *       5. r_c = normalize([(u-cx)/fx, (v-cy)/fy, 1])
 *       6. r_b = R_bc * r_c
 *       7. r_l = q_row * r_b * q_row^-1
 */
static bool FusionCompensateObservation(const VisionImuFusion_t *fusion,
                                        const VisionObservation_t *observation,
                                        CompensatedObservation_t *out)
{
    Vec3f_t gyro_mid_rad_s_b;
    Vec3f_t unbiased_gyro_rad_s_b;
    Vec3f_t delta_theta_rad;
    Quatf_t delta_q_row;
    float bounded_u_px;
    float bounded_v_px;

    if ((fusion == NULL) || (observation == NULL) || (out == NULL))
    {
        return false;
    }

    if ((fusion->intrinsics.fx_px < FUSION_MIN_FOCAL_PX) ||
        (fusion->intrinsics.fy_px < FUSION_MIN_FOCAL_PX) ||
        (fusion->intrinsics.image_width_px == 0U) ||
        (fusion->intrinsics.image_width_px > FUSION_MAX_IMAGE_SIZE) ||
        (fusion->intrinsics.image_height_px == 0U) ||
        (fusion->intrinsics.image_height_px > FUSION_MAX_IMAGE_SIZE))
    {
        return false;
    }

    memset(out, 0, sizeof(*out));
    out->t_mid_us = FusionComputeExposureMidUs(fusion, observation);
    out->row_dt_s = FusionComputeRowOffsetS(fusion, observation);
    out->t_row_us = out->t_mid_us + (uint32_t)lroundf(out->row_dt_s * 1.0e6f);

    if (!FusionInterpolateImuState(fusion, out->t_mid_us, &out->q_mid_lb, &gyro_mid_rad_s_b))
    {
        return false;
    }

    unbiased_gyro_rad_s_b = Vec3Sub(gyro_mid_rad_s_b, fusion->rig.gyro_bias_rad_s);
    delta_theta_rad = Vec3Scale(unbiased_gyro_rad_s_b, out->row_dt_s);
    delta_q_row = QuatFromSmallAngle(delta_theta_rad);
    out->q_row_lb = QuatNormalize(QuatMultiply(out->q_mid_lb, delta_q_row));

    bounded_u_px =
        ClampF(observation->u_px,
               0.0f,
               (float)((fusion->intrinsics.image_width_px > 0U) ? (fusion->intrinsics.image_width_px - 1U) : 0U));
    bounded_v_px =
        ClampF(observation->v_px,
               0.0f,
               (float)((fusion->intrinsics.image_height_px > 0U) ? (fusion->intrinsics.image_height_px - 1U) : 0U));

    out->ray_c = FusionPixelToRayC(fusion, bounded_u_px, bounded_v_px);
    out->ray_b = Vec3Normalize(Mat3MulVec3(&fusion->rig.r_bc, out->ray_c));
    out->ray_l = Vec3Normalize(QuatRotateVec3(out->q_row_lb, out->ray_b));

    /*
     * 这里给出的是姿态补偿后的空间视线角，而不是原始像素误差。
     * yaw / pitch 之后可以直接送给上层地面投影、目标跟踪或云台控制。
     */
    out->yaw_rad = atan2f(out->ray_l.y, out->ray_l.x);
    out->pitch_rad = atan2f(-out->ray_l.z, sqrtf((out->ray_l.x * out->ray_l.x) +
                                                 (out->ray_l.y * out->ray_l.y)));

    return true;
}

/**
 * @brief 装载一组适合车体前视相机的默认标定参数。
 * @param fusion 融合句柄。
 *
 * @note 坐标约定:
 *       - 相机坐标系 C: x 向右, y 向下, z 向前
 *       - 机体系坐标系 B: x 向前, y 向左, z 向上
 *
 *       因此:
 *       x_b =  z_c
 *       y_b = -x_c
 *       z_b = -y_c
 */
void VisionImuFusion_LoadDefaultRig(VisionImuFusion_t *fusion)
{
    if (fusion == NULL)
    {
        return;
    }

    memset(fusion, 0, sizeof(*fusion));

    fusion->intrinsics.fx_px = 722.4f;
    fusion->intrinsics.fy_px = 719.8f;
    fusion->intrinsics.cx_px = 160.0f;
    fusion->intrinsics.cy_px = 120.0f;
    fusion->intrinsics.image_width_px = 320U;
    fusion->intrinsics.image_height_px = 240U;

    fusion->rig.r_bc.m[0][0] = 0.0f;
    fusion->rig.r_bc.m[0][1] = 0.0f;
    fusion->rig.r_bc.m[0][2] = 1.0f;
    fusion->rig.r_bc.m[1][0] = -1.0f;
    fusion->rig.r_bc.m[1][1] = 0.0f;
    fusion->rig.r_bc.m[1][2] = 0.0f;
    fusion->rig.r_bc.m[2][0] = 0.0f;
    fusion->rig.r_bc.m[2][1] = -1.0f;
    fusion->rig.r_bc.m[2][2] = 0.0f;

    /*
     * 这些量都应由实测得到:
     * - camera_to_mcu_offset_us: 相机时间戳域到 MCU 时间戳域的固定偏移
     * - imu_group_delay_us: MPU6050 内部 DLPF + 读出搬运造成的有效采样延迟
     * - gyro_bias_rad_s: 静止标定得到的陀螺零偏
     */
    fusion->rig.camera_to_mcu_offset_us = 380U;
    fusion->rig.imu_group_delay_us = 2800.0f;
    fusion->rig.gyro_bias_rad_s.x = 0.002f;
    fusion->rig.gyro_bias_rad_s.y = -0.0015f;
    fusion->rig.gyro_bias_rad_s.z = 0.0007f;
}

/*
 * 典型使用流程:
 *
 * 1. 初始化阶段:
 *    static VisionImuFusion_t g_fusion;
 *    VisionImuFusion_LoadDefaultRig(&g_fusion);
 *
 * 2. 每次 IMU 新数据到达时:
 *    uint32_t now_us = __HAL_TIM_GET_COUNTER(&htim2);
 *    Quatf_t q_lb = attitude_filter_output;
 *    Vec3f_t gyro_dps_b = mpu6050_gyro_dps;
 *    (void)FusionPushImuSample(&g_fusion, now_us, q_lb, gyro_dps_b);
 *
 * 3. 每次视觉目标到达时:
 *    VisionObservation_t obs;
 *    CompensatedObservation_t result;
 *
 *    obs.sof_timestamp_us = camera_packet.sof_timestamp_us;
 *    obs.exposure_us = camera_packet.exposure_us;
 *    obs.line_time_us = camera_packet.line_time_us;
 *    obs.u_px = camera_packet.u_px;
 *    obs.v_px = camera_packet.v_px;
 *
 *    if (FusionCompensateObservation(&g_fusion, &obs, &result))
 *    {
 *        // result.yaw_rad / result.pitch_rad 已经扣除了曝光中点和滚动快门的姿态错位
 *    }
 */
```

这段代码真正强调的是，视觉补偿链路不该从“收到一帧包之后当前姿态是多少”开始，而应从“这颗像素在物理上究竟是哪一时刻形成的”开始。它先把 `SOF`、曝光宽度和行扫描时间还原成观测时刻，再用陀螺角速度而不是迟到的姿态滤波输出完成短时外推，最后才把像素翻译成射线并旋进统一参考系。这样做的价值，不在于多写了几步矩阵乘法，而在于把误差最容易混淆的那条时间轴显式建模了出来。只有当视觉和 IMU 先在同一时刻描述同一个目标，后续的地面投影、目标跟踪、云台闭环和姿态稳定才谈得上真正可信。
