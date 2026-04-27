---
title: "技能档案：视觉坐标系与 MPU6050 姿态的对齐，从像素射线到地平面姿态补偿"
slug: "skill-vision-imu-frame-alignment-and-ground-plane-compensation"
date: 2026-04-27T16:14:48+08:00
draft: false
description: "从相机内参、机外参、时间同步到 IMU 姿态补偿与地平面求交，系统拆解视觉坐标系和 MPU6050 姿态为何必须先对齐再谈融合。"
tags: ["STM32", "MPU6050", "传感器融合", "机器视觉", "坐标系对齐"]
categories: ["技能档案"]
image: ""
---

## 技能概述

视觉和 IMU 的融合，真正难的从来不是“两个传感器一起用”，而是让两套原本说不同语言的测量系统在同一个时刻、同一个参考系里描述同一个物理事实。摄像头看到的是像素平面里的偏移，MPU6050 看到的是机体相对重力的姿态变化；如果不先处理相机内参、相机到机体的外参、视觉帧时间戳和 IMU 姿态时基之间的错位，控制器追的就不是目标，而是机体抖动制造出来的假位移。平衡车、云台、巡线车、视觉追踪炮台和低空着陆系统之所以离不开这项能力，是因为它决定了“图像里的点”能否被稳定地翻译成“地面上的位置误差”。

## 核心底层概念解析

- **融合之前先定义坐标系，否则一切计算都只是符号游戏**：工程里至少同时存在三个坐标系。相机坐标系 `C` 通常遵循 OpenCV 约定，`x` 向右、`y` 向下、`z` 沿光轴向前；机体坐标系 `B` 则跟底盘、云台或飞行器结构绑定；重力对齐坐标系 `L` 用来提供“地面是哪里、竖直是哪里”的参考。所谓融合，不是把数值拼起来，而是把 `C -> B -> L` 这条旋转链路做对。
- **像素点不是三维点，它首先只是一条穿过光心的射线**：给定像素坐标 `(u, v)`，去掉内参后的归一化相机射线满足 `r_c = normalize([(u - cx) / fx, (v - cy) / fy, 1])`。这里的 `fx`、`fy`、`cx`、`cy` 不只是标定结果，它们决定了像素偏移如何映射成角度偏移。若内参错 2%，后面的几何解算也会跟着错 2% 量级。
- **IMU 给出的不是“目标方向”，而是机体参考系相对重力参考系的旋转**：MPU6050 的陀螺积分负责短时连续性，加速度计重力投影负责长期拉回。它解决的是 `B -> L` 的姿态估计，而不是 `C -> B` 的安装关系。也就是说，IMU 再准，也替代不了相机外参标定。
- **相机外参不是超参数，而是机械装配留下的几何指纹**：相机中心相对机体原点的平移 `t_bc`、相机坐标轴相对机体坐标轴的旋转 `R_bc`，共同决定了光轴指向和近场杠杆臂。尤其在相机离转轴较远时，哪怕只有几度俯仰变化，`R_lb * t_bc` 也会把相机中心在地面投影上拉出明显偏移。
- **时间同步和空间对齐同等重要**：视觉帧往往只有 `30 Hz` 到 `60 Hz`，而 IMU 常在 `200 Hz` 到 `1000 Hz` 更新。如果相机帧时间戳和姿态样本错开 `Δt`，角误差近似满足 `δθ ≈ ω * Δt`。当地面观察高度为 `h` 时，小角度下横向误差近似 `δx ≈ h * δθ`。例如 `h = 0.25 m`、角速度 `120 deg/s`、时间错位 `20 ms`，单靠时基误差就足以制造近厘米级假位移。
- **真正参与求交的是“姿态补偿后的光线”，不是原始像素偏差**：经过外参和 IMU 姿态旋转后，世界或地平面参考系中的射线可写为 `r_l = R_lb * R_bc * r_c`。这一步的意义，是把“机体晃了一下”的影响从像素偏差里剥离出去，让控制器只看到目标自身相对地面的几何位置。
- **地平面求交把二维视觉重新接回物理世界**：若相机中心在重力对齐坐标系中的位置为 `C_l`，且地面满足 `z = 0`，则目标点满足 `P_l = C_l + λ r_l`，其中 `λ = -C_l.z / r_l.z`。只要 `r_l.z` 接近 0，系统就会对距离极度敏感，这也是地平线附近目标最容易“炸解”的原因。
- **误差不是平均分配的，而是沿几何链路放大的**：镜头残余畸变、主点偏移、MPU6050 零偏、陀螺积分漂移、补偿延迟、软连接结构形变、滚动快门曝光错位，都会沿着 `像素 -> 射线 -> 坐标变换 -> 平面求交` 这条链路被重新放大。系统看起来是在做矩阵乘法，本质上却是在做误差传递。
- **MPU6050 的价值不只是提供角度，而是提供“竖直约束”**：视觉单帧天然缺深度，但只要你知道重力方向、相机高度和目标落在某个已知平面上，二维观测就能被抬升为三维几何约束。换句话说，IMU 不是在替视觉“看得更清楚”，而是在替视觉补上缺失的物理先验。
- **对齐的哲学，是把不同时域、不同安装方向、不同噪声模型的测量，翻译成同一种可审计的状态量**：当相机和 IMU 真正共享同一套参考系后，控制器看到的就不再是“这帧偏左了 18 个像素”，而是“目标在机体前方 420 mm、左侧 65 mm，且这组数字已经扣除了俯仰和横滚扰动”。这才是传感器融合真正有工程价值的时刻。

## 代码能力展现

下面给出一个基于 STM32 HAL 使用场景的视觉-IMU 对齐示例。假设视觉侧已经通过 UART 或 SPI 把目标像素中心 `(u, v)` 和帧时间戳送到 STM32，MPU6050 上游姿态滤波器则持续输出 **机体坐标系到重力对齐坐标系** 的四元数。本段代码不重复展开底层读传感器过程，而是聚焦真正容易出工程问题的三件事：**IMU 样本缓冲与时间插值、相机射线到机体系的外参映射、姿态补偿后的地平面求交**。

```c
#include "stm32f4xx_hal.h"
#include <math.h>
#include <string.h>

#define VISION_IMU_SAMPLE_BUFFER_SIZE     16U
#define VISION_IMU_EPSILON                1.0e-6f
#define VISION_IMU_MIN_FOCAL_PX           8.0f
#define VISION_IMU_MAX_CAMERA_HEIGHT_MM   5000.0f

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
    float fx_px;
    float fy_px;
    float cx_px;
    float cy_px;
    uint16_t image_width_px;
    uint16_t image_height_px;
} VisionCameraIntrinsics_t;

typedef struct
{
    Mat3f_t r_bc;
    Vec3f_t t_bc_mm;
    float body_origin_height_mm;
} VisionCameraExtrinsics_t;

typedef struct
{
    uint32_t timestamp_ms;
    Quatf_t q_lb;
} VisionImuSample_t;

typedef struct
{
    VisionCameraIntrinsics_t intrinsics;
    VisionCameraExtrinsics_t extrinsics;
    VisionImuSample_t samples[VISION_IMU_SAMPLE_BUFFER_SIZE];
    uint8_t head;
    uint8_t count;
} VisionImuFusion_t;

typedef struct
{
    float u_px;
    float v_px;
    uint32_t frame_timestamp_ms;
} VisionObservation_t;

typedef struct
{
    Vec3f_t ground_point_l_mm;
    Vec3f_t ray_l;
    float slant_range_mm;
} VisionGroundHit_t;

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

static Vec3f_t Vec3Add(Vec3f_t a, Vec3f_t b)
{
    Vec3f_t out = {a.x + b.x, a.y + b.y, a.z + b.z};
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

    if (norm_sq <= VISION_IMU_EPSILON)
    {
        Vec3f_t fallback = {0.0f, 0.0f, 1.0f};
        return fallback;
    }

    return Vec3Scale(v, 1.0f / sqrtf(norm_sq));
}

static Quatf_t QuatNormalize(Quatf_t q)
{
    const float norm_sq = (q.w * q.w) + (q.x * q.x) + (q.y * q.y) + (q.z * q.z);

    if (norm_sq <= VISION_IMU_EPSILON)
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

static Quatf_t QuatNlerp(Quatf_t a, Quatf_t b, float ratio)
{
    Quatf_t out;
    float dot = QuatDot(a, b);

    ratio = ClampF(ratio, 0.0f, 1.0f);

    /* 四元数 q 与 -q 表示同一个旋转。
     * 若点积为负，说明两端样本在四维球面上走的是“长路”，
     * 先翻转其中一个样本再插值，可避免姿态跨越 180 deg 时出现跳变。
     */
    if (dot < 0.0f)
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

static Mat3f_t QuatToMat3(Quatf_t q)
{
    Mat3f_t r;
    const float ww = q.w * q.w;
    const float xx = q.x * q.x;
    const float yy = q.y * q.y;
    const float zz = q.z * q.z;
    const float wx = q.w * q.x;
    const float wy = q.w * q.y;
    const float wz = q.w * q.z;
    const float xy = q.x * q.y;
    const float xz = q.x * q.z;
    const float yz = q.y * q.z;

    /* q_lb 对应机体系 B 到重力对齐坐标系 L 的旋转。
     * 方向余弦矩阵展开后，可把任意机体系向量 v_b 映射到 v_l：
     * v_l = R_lb * v_b
     */
    r.m[0][0] = ww + xx - yy - zz;
    r.m[0][1] = 2.0f * (xy - wz);
    r.m[0][2] = 2.0f * (xz + wy);
    r.m[1][0] = 2.0f * (xy + wz);
    r.m[1][1] = ww - xx + yy - zz;
    r.m[1][2] = 2.0f * (yz - wx);
    r.m[2][0] = 2.0f * (xz - wy);
    r.m[2][1] = 2.0f * (yz + wx);
    r.m[2][2] = ww - xx - yy + zz;

    return r;
}

static Vec3f_t Mat3MulVec3(const Mat3f_t *m, Vec3f_t v)
{
    Vec3f_t out;

    out.x = (m->m[0][0] * v.x) + (m->m[0][1] * v.y) + (m->m[0][2] * v.z);
    out.y = (m->m[1][0] * v.x) + (m->m[1][1] * v.y) + (m->m[1][2] * v.z);
    out.z = (m->m[2][0] * v.x) + (m->m[2][1] * v.y) + (m->m[2][2] * v.z);

    return out;
}

static uint8_t VisionImu_GetOrderedIndex(const VisionImuFusion_t *fusion, uint8_t order_index)
{
    const uint8_t oldest = (uint8_t)((fusion->head + VISION_IMU_SAMPLE_BUFFER_SIZE - fusion->count)
                                   % VISION_IMU_SAMPLE_BUFFER_SIZE);
    return (uint8_t)((oldest + order_index) % VISION_IMU_SAMPLE_BUFFER_SIZE);
}

/**
 * @brief 压入一帧由 MPU6050 姿态滤波器输出的姿态样本。
 * @param fusion 融合服务句柄，内部包含相机参数和姿态环形缓冲区。
 * @param timestamp_ms 姿态样本时间戳，单位 ms，应与视觉侧共用同一时基。
 * @param q_lb 机体系 B 到重力对齐坐标系 L 的四元数。
 * @retval HAL_OK 压入成功。
 * @retval HAL_ERROR 句柄空指针或时间戳逆序。
 *
 * @note 若视觉侧和 IMU 侧不共用时基，再漂亮的插值都只是在错误时间线上做平滑。
 */
HAL_StatusTypeDef VisionImu_PushAttitudeSample(VisionImuFusion_t *fusion,
                                               uint32_t timestamp_ms,
                                               Quatf_t q_lb)
{
    VisionImuSample_t *slot;

    if (fusion == NULL)
    {
        return HAL_ERROR;
    }

    if (fusion->count > 0U)
    {
        const uint8_t newest_index =
            (uint8_t)((fusion->head + VISION_IMU_SAMPLE_BUFFER_SIZE - 1U) % VISION_IMU_SAMPLE_BUFFER_SIZE);
        const VisionImuSample_t *newest = &fusion->samples[newest_index];

        if (timestamp_ms < newest->timestamp_ms)
        {
            return HAL_ERROR;
        }
    }

    slot = &fusion->samples[fusion->head];
    slot->timestamp_ms = timestamp_ms;
    slot->q_lb = QuatNormalize(q_lb);

    fusion->head = (uint8_t)((fusion->head + 1U) % VISION_IMU_SAMPLE_BUFFER_SIZE);

    if (fusion->count < VISION_IMU_SAMPLE_BUFFER_SIZE)
    {
        fusion->count++;
    }

    return HAL_OK;
}

/**
 * @brief 根据视觉帧时间戳，从姿态缓冲区插值出同一时刻的机体姿态。
 * @param fusion 融合服务句柄。
 * @param frame_timestamp_ms 视觉帧时间戳，单位 ms。
 * @param out_q_lb 输出插值得到的四元数。
 * @retval HAL_OK 插值成功。
 * @retval HAL_ERROR 样本不足或参数无效。
 *
 * @note 视觉帧频低于 IMU 时，最稳妥的策略通常不是外推，而是对历史样本做短窗口插值。
 */
static HAL_StatusTypeDef VisionImu_InterpolateAttitude(const VisionImuFusion_t *fusion,
                                                       uint32_t frame_timestamp_ms,
                                                       Quatf_t *out_q_lb)
{
    if ((fusion == NULL) || (out_q_lb == NULL) || (fusion->count == 0U))
    {
        return HAL_ERROR;
    }

    if (fusion->count == 1U)
    {
        *out_q_lb = fusion->samples[VisionImu_GetOrderedIndex(fusion, 0U)].q_lb;
        return HAL_OK;
    }

    for (uint8_t i = 0U; i < (fusion->count - 1U); ++i)
    {
        const VisionImuSample_t *left = &fusion->samples[VisionImu_GetOrderedIndex(fusion, i)];
        const VisionImuSample_t *right = &fusion->samples[VisionImu_GetOrderedIndex(fusion, (uint8_t)(i + 1U))];

        if (frame_timestamp_ms <= left->timestamp_ms)
        {
            *out_q_lb = left->q_lb;
            return HAL_OK;
        }

        if ((frame_timestamp_ms >= left->timestamp_ms) && (frame_timestamp_ms <= right->timestamp_ms))
        {
            const uint32_t dt_ms = right->timestamp_ms - left->timestamp_ms;
            const float ratio = (dt_ms == 0U)
                              ? 0.0f
                              : ((float)(frame_timestamp_ms - left->timestamp_ms) / (float)dt_ms);
            *out_q_lb = QuatNlerp(left->q_lb, right->q_lb, ratio);
            return HAL_OK;
        }
    }

    *out_q_lb = fusion->samples[VisionImu_GetOrderedIndex(fusion, (uint8_t)(fusion->count - 1U))].q_lb;
    return HAL_OK;
}

/**
 * @brief 把视觉目标像素坐标投影到重力对齐坐标系下的地平面。
 * @param fusion 融合服务句柄，内部包含内参、外参和姿态样本缓存。
 * @param observation 视觉观测，包含像素中心与帧时间戳。
 * @param out_hit 输出地平面交点与补偿后的射线信息。
 * @retval HAL_OK 求交成功。
 * @retval HAL_ERROR 参数非法、姿态样本不足或射线接近地平线导致几何退化。
 *
 * @note 数学链路如下：
 *       1. 归一化像素射线：r_c = normalize([(u-cx)/fx, (v-cy)/fy, 1])
 *       2. 机体系射线：r_b = R_bc * r_c
 *       3. 重力对齐射线：r_l = R_lb * r_b
 *       4. 相机中心：C_l = [0, 0, h_body]^T + R_lb * t_bc
 *       5. 地平面求交：P_l = C_l + lambda * r_l, lambda = -C_l.z / r_l.z
 */
HAL_StatusTypeDef VisionImu_ProjectPixelToGround(const VisionImuFusion_t *fusion,
                                                 const VisionObservation_t *observation,
                                                 VisionGroundHit_t *out_hit)
{
    Quatf_t q_lb;
    Mat3f_t r_lb;
    Vec3f_t ray_c;
    Vec3f_t ray_b;
    Vec3f_t ray_l;
    Vec3f_t body_origin_l;
    Vec3f_t camera_center_l;
    float u_px;
    float v_px;
    float lambda_mm;

    if ((fusion == NULL) || (observation == NULL) || (out_hit == NULL))
    {
        return HAL_ERROR;
    }

    if ((fusion->intrinsics.fx_px < VISION_IMU_MIN_FOCAL_PX) ||
        (fusion->intrinsics.fy_px < VISION_IMU_MIN_FOCAL_PX))
    {
        return HAL_ERROR;
    }

    if ((fusion->extrinsics.body_origin_height_mm <= 1.0f) ||
        (fusion->extrinsics.body_origin_height_mm > VISION_IMU_MAX_CAMERA_HEIGHT_MM))
    {
        return HAL_ERROR;
    }

    if (VisionImu_InterpolateAttitude(fusion, observation->frame_timestamp_ms, &q_lb) != HAL_OK)
    {
        return HAL_ERROR;
    }

    r_lb = QuatToMat3(q_lb);

    /* 视觉算法输出的质心可能因滤波或 ROI 裁剪略微越界。
     * 这里先把像素位置钳回有效图像窗口，避免把明显非法值传播到后续几何链路。
     */
    u_px = ClampF(observation->u_px,
                  0.0f,
                  (float)((fusion->intrinsics.image_width_px > 0U) ? (fusion->intrinsics.image_width_px - 1U) : 0U));
    v_px = ClampF(observation->v_px,
                  0.0f,
                  (float)((fusion->intrinsics.image_height_px > 0U) ? (fusion->intrinsics.image_height_px - 1U) : 0U));

    /* 像素到归一化射线的线性映射：
     * x_n = (u - cx) / fx
     * y_n = (v - cy) / fy
     * r_c = normalize([x_n, y_n, 1])
     */
    ray_c.x = (u_px - fusion->intrinsics.cx_px) / fusion->intrinsics.fx_px;
    ray_c.y = (v_px - fusion->intrinsics.cy_px) / fusion->intrinsics.fy_px;
    ray_c.z = 1.0f;
    ray_c = Vec3Normalize(ray_c);

    /* r_bc 来自离线外参标定，负责把相机光轴、图像行列方向
     * 翻译到机体系定义里。若这里的轴方向号错，后面的姿态补偿会“越补越偏”。
     */
    ray_b = Mat3MulVec3(&fusion->extrinsics.r_bc, ray_c);
    ray_l = Vec3Normalize(Mat3MulVec3(&r_lb, ray_b));

    body_origin_l.x = 0.0f;
    body_origin_l.y = 0.0f;
    body_origin_l.z = fusion->extrinsics.body_origin_height_mm;
    camera_center_l = Vec3Add(body_origin_l, Mat3MulVec3(&r_lb, fusion->extrinsics.t_bc_mm));

    /* 当 r_l.z 接近 0 时，射线几乎平行于地面。
     * 此时 lambda = -C_l.z / r_l.z 会急剧放大，任何 0.1 deg 级姿态抖动
     * 都可能被放大成几十毫米甚至更大的平面位置跳动，因此直接判为几何退化。
     */
    if (ray_l.z >= -0.02f)
    {
        return HAL_ERROR;
    }

    lambda_mm = -camera_center_l.z / ray_l.z;

    if (lambda_mm <= 0.0f)
    {
        return HAL_ERROR;
    }

    out_hit->ray_l = ray_l;
    out_hit->slant_range_mm = lambda_mm;
    out_hit->ground_point_l_mm = Vec3Add(camera_center_l, Vec3Scale(ray_l, lambda_mm));
    out_hit->ground_point_l_mm.z = 0.0f;

    return HAL_OK;
}

/**
 * @brief 给出一组可直接落地到 STM32 工程的默认相机参数。
 * @param fusion 融合服务句柄。
 *
 * @note 下面这组 r_bc 假设：
 *       - 相机坐标系 C: x 向右, y 向下, z 向前
 *       - 机体系 B: x 向前, y 向左, z 向上
 *       因此有：
 *       x_b =  z_c
 *       y_b = -x_c
 *       z_b = -y_c
 */
void VisionImu_LoadDefaultRig(VisionImuFusion_t *fusion)
{
    if (fusion == NULL)
    {
        return;
    }

    memset(fusion, 0, sizeof(*fusion));

    fusion->intrinsics.fx_px = 698.0f;
    fusion->intrinsics.fy_px = 701.0f;
    fusion->intrinsics.cx_px = 160.0f;
    fusion->intrinsics.cy_px = 120.0f;
    fusion->intrinsics.image_width_px = 320U;
    fusion->intrinsics.image_height_px = 240U;

    fusion->extrinsics.r_bc.m[0][0] = 0.0f;
    fusion->extrinsics.r_bc.m[0][1] = 0.0f;
    fusion->extrinsics.r_bc.m[0][2] = 1.0f;
    fusion->extrinsics.r_bc.m[1][0] = -1.0f;
    fusion->extrinsics.r_bc.m[1][1] = 0.0f;
    fusion->extrinsics.r_bc.m[1][2] = 0.0f;
    fusion->extrinsics.r_bc.m[2][0] = 0.0f;
    fusion->extrinsics.r_bc.m[2][1] = -1.0f;
    fusion->extrinsics.r_bc.m[2][2] = 0.0f;

    /* t_bc_mm 为“相机中心相对机体原点”的平移，单位 mm。
     * 这里假设相机在车体前方 42 mm、竖直高于机体原点 118 mm。
     */
    fusion->extrinsics.t_bc_mm.x = 42.0f;
    fusion->extrinsics.t_bc_mm.y = 0.0f;
    fusion->extrinsics.t_bc_mm.z = 118.0f;
    fusion->extrinsics.body_origin_height_mm = 76.0f;
}
```

这段代码真正解决的，不是“把像素换算成毫米”这么简单，而是把测量链路里的三个关键债务一次还清。第一，IMU 以高频连续更新姿态，视觉以低频异步给出观测，因此必须缓存姿态并按视觉时间戳插值，而不是直接拿“当前角度”硬套；第二，相机和 MPU6050 从来不在同一个坐标系里，`R_bc` 与 `t_bc` 决定了你是在补偿真实光轴，还是在补偿一个虚构出来的安装方向；第三，地平面求交让图像误差重新获得物理尺度，但也把姿态、标定和时间误差一起放大，所以所有边界条件都要提前限幅。真正稳定的融合链路，从来不是某个滤波公式更花哨，而是把像素、姿态、时基和几何约束同时拉回到同一套物理世界观里。
