---
title: "技能档案：视觉-IMU 外参中的重力向量对齐、旋转矩阵正交化与 yaw 不可观测守卫"
slug: "skill-vision-imu-gravity-alignment-orthonormality-and-yaw-observability-guard"
date: 2026-07-10T09:06:03+08:00
draft: false
description: "从重力向量约束、外参旋转矩阵投影、tilt/yaw 残差分解到在线观测性门控，系统拆解视觉与 MPU6050 对齐为什么常在‘矩阵算出来以后’才开始失真。"
tags: ["STM32", "MPU6050", "传感器融合", "机器视觉", "外参标定", "姿态解算"]
categories: ["技能档案"]
image: ""
---

## 技能概述

视觉和 MPU6050 的融合，最容易被低估的不是 `solvePnP()`、四元数或者卡尔曼滤波本身，而是**相机坐标系、IMU 坐标系和重力参考系之间那张长期有效的旋转合同**。只要这张合同里混进了装配误差、数值漂移、动态加速度伪重力，或者把本来不可观测的 yaw 当成了“顺手就能标出来”的量，系统就会出现一种很典型的假稳定：静态时画面看着还行，一上车体振动、转弯、俯仰耦合，视觉射线和姿态补偿就开始彼此打架。这个主题真正要解决的，不是“再求一次外参”，而是如何把 **重力向量对齐**、**旋转矩阵正交化**、**yaw 观测性门控** 和 **在线残差守卫** 绑定成一套能长期工作的工程闭环。

## 核心底层概念解析

- **视觉-IMU 对齐首先是一道刚体旋转题，而不是角度拼接题**：若定义 `R_ab` 表示“把 `b` 坐标系中的向量旋到 `a` 坐标系”，那么视觉输出 `R_wc`，IMU 姿态解算输出 `R_wi`，二者之间真正长期要维护的是外参旋转 `R_ic`，满足  
  `R_wc ≈ R_wi * R_ic`。  
  这意味着你校准的不是某个“俯仰角偏 2.3 度”的经验常数，而是一整个三维旋转群上的元素。

- **重力向量天然只约束 2 个自由度，绕重力轴的 yaw 处在零空间里**：静止时，MPU6050 加速度计看到的主信号近似是重力方向 `g_i`；视觉若也能给出世界系里的竖直方向，就能把“哪边朝下”对齐。但只靠这一个向量，旋转轴绕 `g` 的分量并不会改变测量结果。换句话说，**roll/pitch 可以靠重力拉齐，yaw 不能靠重力凭空出现**。

- **加速度计测到的是比力，不是永远纯净的重力**：车体加减速、云台甩动、底盘过坎时，传感器输出是 `f = a - g`。只有在准静态窗口里，`|a| ≈ g` 才说明“把这帧拿来做重力对齐还算合理”。如果系统在大横向加速度下仍然拿加计去纠正外参，等价于把机动加速度误写成安装误差。

- **从姿态样本直接反推外参时，数值结果先要回到 `SO(3)` 上**：理想旋转矩阵应满足 `R^T R = I` 且 `det(R) = 1`。但有限精度浮点、噪声和低频滤波会让直接算出的 `R_ic,raw = R_wi^T * R_wc` 逐渐偏离这个流形。结果就是列向量不再正交、长度不再为 1，后续每做一次补偿都在把“假旋转”继续传播。

- **正交化不是数学洁癖，而是误差不扩散的最低防线**：离线最严谨的投影可以写成  
  `R_so3 = U * diag(1, 1, det(UV^T)) * V^T`，其中 `R_raw = UΣV^T`。  
  这相当于把最近的正交矩阵重新投回旋转群。在线 MCU 里未必每次都跑 SVD，但至少要做 Gram-Schmidt、叉乘闭合和行列式守卫，否则“外参在漂”很多时候其实只是“矩阵已经不是旋转了”。

- **真正该被更新的是误差的小量，而不是整块矩阵直接硬覆盖**：更稳的写法不是每来一帧视觉姿态就 `R_ic = R_ic_raw`，而是先算相对误差 `R_err = R_ic^T * R_ic,raw`，再用小角度近似取出 `δθ`，最后按  
  `R_ic,next = R_ic * exp([δθ]_x)`  
  去做受限更新。这样每次只吃一小口误差，系统对偶发噪声和错误观测更有弹性。

- **把残差分解成 tilt 与 yaw，是把“可校正”和“暂时别动”分开**：设当前 IMU 系重力单位向量为 `g_i`，则任意小旋转误差都可拆成  
  `δθ_yaw = (δθ · g_i) g_i`，`δθ_tilt = δθ - δθ_yaw`。  
  前者沿重力轴，后者垂直重力轴。工程意义非常直接：`δθ_tilt` 可以在准静态条件下持续修，`δθ_yaw` 则必须等到水平参考充分、视觉几何条件可靠时再松手。

- **yaw 是否可观测，不取决于你想不想估，而取决于系统有没有提供水平参照**：如果视觉端只有“竖直方向”或目标法向，`yaw` 本来就不该更新；如果视觉端有 AprilTag/棋盘格的水平边、地图关键点方位或其他水平基准，才有资格给出 `yaw_observable_score`。没有观测性的更新，数学上不是“精度差一点”，而是把噪声直接塞进自由度空洞里。

- **外参误差会把纯姿态问题投影成位置假象**：对地面目标或固定距离目标，小角度下横向误差近似满足 `Δx ≈ Z * Δθ`。也就是说，只要外参旋转错了 `0.8°`，在 `Z = 1.5 m` 的工作距离上就能膨胀成约 `21 mm` 的横向假位移。很多人以为自己在修视觉定位，其实真正失控的是姿态几何。

- **安装杠杆臂让旋转误差更像“会呼吸的平移偏差”**：相机与 IMU 通常不共点，存在平移 `t_ic`。一旦姿态补偿角度错了，`R * t_ic` 会把纯角度误差重新折算成相机中心的位置摆动，近场目标、地面求交和云台瞄准都会更加敏感。外参从来不是“只有方向没关系位置”的问题。

- **在线守卫要盯的不是单一 RMS，而是一串物理一致性指标**：例如 `| |a| / g - 1 |` 说明当前是不是准静态；`det(R_ic)` 说明矩阵是否还像个旋转；`gravity_residual` 说明重力链是否闭合；`reproj_rms_px` 说明视觉姿态本身值不值得信；`yaw_observable_score` 则决定绕重力轴那一维能不能动。融合系统真正强壮的地方，不是“永远有解”，而是**知道哪一帧不该让它更新**。

- **技术哲学上，外参不是一次性文件，而是一份持续审计的物理契约**：`yaml` 里的矩阵只是起点，不是终点。真正可靠的系统，会在每一帧都重新问自己：这次观测来自同一个参考系吗？这次加速度还是重力吗？这次 yaw 真有信息吗？这次矩阵还是旋转吗？只有这些问题都过关，视觉和 IMU 才算真的在描述同一个世界。

## 代码能力展现

下面给出一段基于 **STM32 HAL** 的视觉-IMU 外参在线守卫示例。假设：

- 姿态滤波器已经持续输出 `R_wi`；
- 视觉端已经给出当前相机姿态 `R_wc`、重投影残差和一个 `yaw_observable_score`；
- 主控需要在 MCU 侧维护一份**长期可用**的 `R_ic`，而不是每帧无脑覆盖；
- 系统要显式区分 **tilt 可修正** 与 **yaw 暂不可观测** 这两类误差。

代码刻意聚焦“在线守卫”这半段：**准静态门控、误差分解、增量更新、矩阵正交化与边界限幅**，避免把 UART 解包、MPU6050 寄存器读取等无关细节一股脑塞进来。

```c
#include "main.h"

#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#define VIF_GRAVITY_MPS2                    9.80665f
#define VIF_MIN_NORM                        1.0e-6f
#define VIF_ACCEL_STATIC_TOL_G              0.12f
#define VIF_MAX_REPROJ_RMS_PX               1.50f
#define VIF_MIN_YAW_SCORE                   0.35f
#define VIF_MAX_CORR_STEP_RAD               0.035f      /* 单次最多修正约 2 deg，避免坏帧猛拉外参 */
#define VIF_TILT_GAIN                       0.18f
#define VIF_YAW_GAIN                        0.08f
#define VIF_MAX_FRAME_SKEW_MS               80U

typedef struct
{
    float x;
    float y;
    float z;
} VifVec3f_t;

typedef struct
{
    float m[3][3];
} VifMat3f_t;

typedef struct
{
    /* R_wi: 将 IMU 坐标系向量旋到 world 坐标系 */
    VifMat3f_t r_wi;
    /* 校准后的加速度计输出，单位 m/s^2 */
    VifVec3f_t accel_i_mps2;
    uint32_t tick_ms;
} VifImuSample_t;

typedef struct
{
    /* R_wc: 将 camera 坐标系向量旋到 world 坐标系 */
    VifMat3f_t r_wc;
    float reproj_rms_px;
    /* 由视觉端给出的 yaw 可观测性评分：
     * - 仅靠重力向量时应为 0
     * - 有稳定水平参考时可逐步升高到 1
     */
    float yaw_observable_score;
    uint32_t tick_ms;
} VifVisionSample_t;

typedef struct
{
    /* R_ic: 将 camera 坐标系向量旋到 IMU 坐标系 */
    VifMat3f_t r_ic;
    float last_tilt_error_deg;
    float last_yaw_error_deg;
    float last_gravity_error_deg;
    float last_det;
    uint32_t reject_dynamic_count;
    uint32_t reject_reproj_count;
    uint32_t reject_yaw_count;
    uint32_t reject_stale_count;
    uint8_t initialized;
} VifExtrinsicState_t;

static VifExtrinsicState_t g_vif_state;

static float Vif_ClampF(float value, float min_value, float max_value)
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

static float Vif_AbsF(float value)
{
    return (value >= 0.0f) ? value : -value;
}

static VifVec3f_t Vif_Vec3(float x, float y, float z)
{
    VifVec3f_t v = { x, y, z };
    return v;
}

static VifVec3f_t Vif_VecAdd(VifVec3f_t a, VifVec3f_t b)
{
    return Vif_Vec3(a.x + b.x, a.y + b.y, a.z + b.z);
}

static VifVec3f_t Vif_VecSub(VifVec3f_t a, VifVec3f_t b)
{
    return Vif_Vec3(a.x - b.x, a.y - b.y, a.z - b.z);
}

static VifVec3f_t Vif_VecScale(VifVec3f_t v, float scale)
{
    return Vif_Vec3(v.x * scale, v.y * scale, v.z * scale);
}

static float Vif_VecDot(VifVec3f_t a, VifVec3f_t b)
{
    return (a.x * b.x) + (a.y * b.y) + (a.z * b.z);
}

static VifVec3f_t Vif_VecCross(VifVec3f_t a, VifVec3f_t b)
{
    return Vif_Vec3((a.y * b.z) - (a.z * b.y),
                    (a.z * b.x) - (a.x * b.z),
                    (a.x * b.y) - (a.y * b.x));
}

static float Vif_VecNorm(VifVec3f_t v)
{
    return sqrtf(Vif_VecDot(v, v));
}

static VifVec3f_t Vif_VecNormalize(VifVec3f_t v)
{
    const float norm = Vif_VecNorm(v);

    if (norm < VIF_MIN_NORM)
    {
        return Vif_Vec3(0.0f, 0.0f, 0.0f);
    }

    return Vif_VecScale(v, 1.0f / norm);
}

static VifVec3f_t Vif_VecClampNorm(VifVec3f_t v, float max_norm)
{
    const float norm = Vif_VecNorm(v);

    if ((norm < VIF_MIN_NORM) || (norm <= max_norm))
    {
        return v;
    }

    return Vif_VecScale(v, max_norm / norm);
}

static VifMat3f_t Vif_MatIdentity(void)
{
    VifMat3f_t r =
    {{
        {1.0f, 0.0f, 0.0f},
        {0.0f, 1.0f, 0.0f},
        {0.0f, 0.0f, 1.0f}
    }};

    return r;
}

static VifVec3f_t Vif_MatGetColumn(const VifMat3f_t *r, uint32_t column)
{
    return Vif_Vec3(r->m[0][column], r->m[1][column], r->m[2][column]);
}

static void Vif_MatSetColumn(VifMat3f_t *r, uint32_t column, VifVec3f_t v)
{
    r->m[0][column] = v.x;
    r->m[1][column] = v.y;
    r->m[2][column] = v.z;
}

static VifMat3f_t Vif_MatTranspose(VifMat3f_t r)
{
    VifMat3f_t out;
    uint32_t i;
    uint32_t j;

    for (i = 0U; i < 3U; ++i)
    {
        for (j = 0U; j < 3U; ++j)
        {
            out.m[i][j] = r.m[j][i];
        }
    }

    return out;
}

static VifMat3f_t Vif_MatMultiply(VifMat3f_t a, VifMat3f_t b)
{
    VifMat3f_t out = {{{0.0f}}};
    uint32_t i;
    uint32_t j;
    uint32_t k;

    for (i = 0U; i < 3U; ++i)
    {
        for (j = 0U; j < 3U; ++j)
        {
            for (k = 0U; k < 3U; ++k)
            {
                out.m[i][j] += a.m[i][k] * b.m[k][j];
            }
        }
    }

    return out;
}

static VifVec3f_t Vif_MatMulVec(VifMat3f_t r, VifVec3f_t v)
{
    return Vif_Vec3((r.m[0][0] * v.x) + (r.m[0][1] * v.y) + (r.m[0][2] * v.z),
                    (r.m[1][0] * v.x) + (r.m[1][1] * v.y) + (r.m[1][2] * v.z),
                    (r.m[2][0] * v.x) + (r.m[2][1] * v.y) + (r.m[2][2] * v.z));
}

static float Vif_MatDet(VifMat3f_t r)
{
    return (r.m[0][0] * ((r.m[1][1] * r.m[2][2]) - (r.m[1][2] * r.m[2][1])))
         - (r.m[0][1] * ((r.m[1][0] * r.m[2][2]) - (r.m[1][2] * r.m[2][0])))
         + (r.m[0][2] * ((r.m[1][0] * r.m[2][1]) - (r.m[1][1] * r.m[2][0])));
}

/**
 * @brief 将近似旋转矩阵重新投回 SO(3)。
 * @param r [in,out] 待正交化矩阵。
 *
 * @note 离线精确投影可写为：
 *       R_so3 = U * diag(1, 1, det(UV^T)) * V^T
 *
 *       但 MCU 在线守卫更强调 KISS：
 *       1. 对第一列单位化；
 *       2. 第二列减去在第一列上的投影后再单位化；
 *       3. 第三列由叉乘闭合，确保右手系；
 *       4. 再次用 y = z x x 收紧累计误差。
 */
static void Vif_Orthonormalize(VifMat3f_t *r)
{
    VifVec3f_t x;
    VifVec3f_t y;
    VifVec3f_t z;

    if (r == NULL)
    {
        return;
    }

    x = Vif_VecNormalize(Vif_MatGetColumn(r, 0U));
    y = Vif_MatGetColumn(r, 1U);
    y = Vif_VecSub(y, Vif_VecScale(x, Vif_VecDot(x, y)));
    y = Vif_VecNormalize(y);

    if ((Vif_VecNorm(x) < VIF_MIN_NORM) || (Vif_VecNorm(y) < VIF_MIN_NORM))
    {
        *r = Vif_MatIdentity();
        return;
    }

    z = Vif_VecNormalize(Vif_VecCross(x, y));
    y = Vif_VecNormalize(Vif_VecCross(z, x));

    Vif_MatSetColumn(r, 0U, x);
    Vif_MatSetColumn(r, 1U, y);
    Vif_MatSetColumn(r, 2U, z);
}

/**
 * @brief 由小角度向量构造增量旋转矩阵。
 * @param dtheta_rad 误差旋转向量，单位 rad。
 * @retval 增量旋转矩阵。
 *
 * @note 当 ||dtheta|| 很小时，
 *       exp([dtheta]_x) ~= I + sin(theta)/theta [u]_x
 *                          + (1-cos(theta))/theta^2 [dtheta]_x^2
 *
 *       若 theta -> 0，则退化成一阶近似 I + [dtheta]_x。
 */
static VifMat3f_t Vif_Rodrigues(VifVec3f_t dtheta_rad)
{
    const float theta = Vif_VecNorm(dtheta_rad);
    VifMat3f_t r = Vif_MatIdentity();
    float kx;
    float ky;
    float kz;
    float s;
    float c;
    float v;

    if (theta < 1.0e-5f)
    {
        r.m[0][1] = -dtheta_rad.z;
        r.m[0][2] =  dtheta_rad.y;
        r.m[1][0] =  dtheta_rad.z;
        r.m[1][2] = -dtheta_rad.x;
        r.m[2][0] = -dtheta_rad.y;
        r.m[2][1] =  dtheta_rad.x;
        return r;
    }

    kx = dtheta_rad.x / theta;
    ky = dtheta_rad.y / theta;
    kz = dtheta_rad.z / theta;
    s = sinf(theta);
    c = cosf(theta);
    v = 1.0f - c;

    r.m[0][0] = (kx * kx * v) + c;
    r.m[0][1] = (kx * ky * v) - (kz * s);
    r.m[0][2] = (kx * kz * v) + (ky * s);
    r.m[1][0] = (ky * kx * v) + (kz * s);
    r.m[1][1] = (ky * ky * v) + c;
    r.m[1][2] = (ky * kz * v) - (kx * s);
    r.m[2][0] = (kz * kx * v) - (ky * s);
    r.m[2][1] = (kz * ky * v) + (kx * s);
    r.m[2][2] = (kz * kz * v) + c;

    return r;
}

/**
 * @brief 从误差旋转矩阵提取小角度误差向量。
 * @param r_err 误差矩阵，满足 R_err = R_est^T * R_meas。
 * @retval 近似误差向量，单位 rad。
 *
 * @note 当误差较小时，
 *       R_err ~= I + [dtheta]_x
 *       因此 dtheta ~= 0.5 * vee(R_err - R_err^T)
 */
static VifVec3f_t Vif_SmallAngleFromRotationError(VifMat3f_t r_err)
{
    return Vif_Vec3(0.5f * (r_err.m[2][1] - r_err.m[1][2]),
                    0.5f * (r_err.m[0][2] - r_err.m[2][0]),
                    0.5f * (r_err.m[1][0] - r_err.m[0][1]));
}

static float Vif_AngleBetweenUnitVectorsDeg(VifVec3f_t a_unit, VifVec3f_t b_unit)
{
    const float dot = Vif_ClampF(Vif_VecDot(a_unit, b_unit), -1.0f, 1.0f);
    return acosf(dot) * 57.2957795f;
}

static bool Vif_IsFrameSkewTooLarge(uint32_t imu_tick_ms, uint32_t vision_tick_ms)
{
    const uint32_t delta_ms = (imu_tick_ms >= vision_tick_ms)
                            ? (imu_tick_ms - vision_tick_ms)
                            : (vision_tick_ms - imu_tick_ms);

    return (delta_ms > VIF_MAX_FRAME_SKEW_MS);
}

/**
 * @brief 用一帧视觉姿态样本增量更新 camera->IMU 外参。
 * @param state 外参状态。
 * @param imu 当前 IMU 姿态样本。
 * @param vision 当前视觉姿态样本。
 * @retval true 本帧被接受并完成更新；false 本帧被门控拒绝。
 *
 * @note 外参原始测量可由姿态链直接写成：
 *       R_wc ~= R_wi * R_ic
 *       => R_ic_raw = R_wi^T * R_wc
 *
 *       误差分解则写成：
 *       dtheta_yaw  = (dtheta · g_i) * g_i
 *       dtheta_tilt = dtheta - dtheta_yaw
 *
 *       其中 g_i 为 IMU 坐标系中的重力单位向量。
 *       - tilt 修正只有在 |a| ≈ g 的准静态窗口内才放行；
 *       - yaw 修正只有在视觉给出足够观测性评分时才放行；
 *       - 最终修正量还要做范数限幅，避免坏帧把外参猛拉走。
 */
bool Vif_UpdateExtrinsic(VifExtrinsicState_t *state,
                         const VifImuSample_t *imu,
                         const VifVisionSample_t *vision)
{
    const VifVec3f_t g_w = {0.0f, 0.0f, -1.0f};
    const float accel_norm_g = Vif_VecNorm(imu->accel_i_mps2) / VIF_GRAVITY_MPS2;
    const bool static_ok = (Vif_AbsF(accel_norm_g - 1.0f) <= VIF_ACCEL_STATIC_TOL_G);
    VifMat3f_t r_ic_raw;
    VifMat3f_t r_err;
    VifVec3f_t dtheta_rad;
    VifVec3f_t dtheta_yaw_rad;
    VifVec3f_t dtheta_tilt_rad;
    VifVec3f_t correction_rad;
    VifVec3f_t g_i_unit;
    VifVec3f_t g_c_unit;
    VifVec3f_t g_i_from_camera_unit;

    if ((state == NULL) || (imu == NULL) || (vision == NULL))
    {
        return false;
    }

    if (Vif_IsFrameSkewTooLarge(imu->tick_ms, vision->tick_ms))
    {
        state->reject_stale_count++;
        return false;
    }

    if (vision->reproj_rms_px > VIF_MAX_REPROJ_RMS_PX)
    {
        state->reject_reproj_count++;
        return false;
    }

    /* R_ic_raw = R_wi^T * R_wc：把视觉姿态和 IMU 姿态拉回同一条旋转链上。 */
    r_ic_raw = Vif_MatMultiply(Vif_MatTranspose(imu->r_wi), vision->r_wc);
    Vif_Orthonormalize(&r_ic_raw);

    if (state->initialized == 0U)
    {
        state->r_ic = r_ic_raw;
        state->last_det = Vif_MatDet(state->r_ic);
        state->initialized = 1U;
        return true;
    }

    r_err = Vif_MatMultiply(Vif_MatTranspose(state->r_ic), r_ic_raw);
    dtheta_rad = Vif_SmallAngleFromRotationError(r_err);

    /* 当前 IMU / Camera 坐标系中的重力方向，用来做 tilt-yaw 分解与闭环审计。 */
    g_i_unit = Vif_VecNormalize(Vif_MatMulVec(Vif_MatTranspose(imu->r_wi), g_w));
    g_c_unit = Vif_VecNormalize(Vif_MatMulVec(Vif_MatTranspose(vision->r_wc), g_w));
    g_i_from_camera_unit = Vif_VecNormalize(Vif_MatMulVec(state->r_ic, g_c_unit));

    state->last_gravity_error_deg = Vif_AngleBetweenUnitVectorsDeg(g_i_unit, g_i_from_camera_unit);

    /*
     * 将误差旋量按重力轴分解：
     * - yaw 分量平行于 g_i
     * - tilt 分量垂直于 g_i
     */
    dtheta_yaw_rad = Vif_VecScale(g_i_unit, Vif_VecDot(dtheta_rad, g_i_unit));
    dtheta_tilt_rad = Vif_VecSub(dtheta_rad, dtheta_yaw_rad);

    state->last_tilt_error_deg = Vif_VecNorm(dtheta_tilt_rad) * 57.2957795f;
    state->last_yaw_error_deg = Vif_VecNorm(dtheta_yaw_rad) * 57.2957795f;

    if (!static_ok)
    {
        /* 动态加速度会污染重力方向，因此冻结 tilt 修正，只保留诊断信息。 */
        dtheta_tilt_rad = Vif_Vec3(0.0f, 0.0f, 0.0f);
        state->reject_dynamic_count++;
    }

    if (vision->yaw_observable_score < VIF_MIN_YAW_SCORE)
    {
        /* 只有重力、没有水平参考时，yaw 在数学上就是不可观测的。 */
        dtheta_yaw_rad = Vif_Vec3(0.0f, 0.0f, 0.0f);
        state->reject_yaw_count++;
    }

    correction_rad = Vif_VecAdd(Vif_VecScale(dtheta_tilt_rad, VIF_TILT_GAIN),
                                Vif_VecScale(dtheta_yaw_rad, VIF_YAW_GAIN));
    correction_rad = Vif_VecClampNorm(correction_rad, VIF_MAX_CORR_STEP_RAD);

    state->r_ic = Vif_MatMultiply(state->r_ic, Vif_Rodrigues(correction_rad));
    Vif_Orthonormalize(&state->r_ic);
    state->last_det = Vif_MatDet(state->r_ic);

    return true;
}

/**
 * @brief 初始化视觉-IMU 外参守卫。
 * @retval true 初始化成功。
 */
bool App_VisionImuFusionInit(void)
{
    memset(&g_vif_state, 0, sizeof(g_vif_state));
    g_vif_state.r_ic = Vif_MatIdentity();
    g_vif_state.last_det = 1.0f;
    return true;
}

/* 以下两个样本一般由各自数据通路维护：
 * - IMU 路径可来自 MPU6050 + 姿态滤波器
 * - Vision 路径可来自 OpenCV / OpenMV / 上位机发来的姿态包
 */
extern volatile VifImuSample_t g_latest_imu_sample;
extern volatile VifVisionSample_t g_latest_vision_sample;

/**
 * @brief 在 1 kHz 控制任务中维护外参与诊断量。
 *
 * @note 这里不直接展示 UART/I2C 读写细节，保持单一职责：
 *       本任务只关心“是否接受这一帧外参修正”。
 */
void App_VisionImuFusion1kHzTask(void)
{
    VifImuSample_t imu_snapshot;
    VifVisionSample_t vision_snapshot;

    /*
     * 先做局部快照，避免跨中断上下文直接读 volatile 结构体导致字段撕裂。
     * 这是资源调度问题，不是语法问题。
     */
    memcpy(&imu_snapshot, (const void *)&g_latest_imu_sample, sizeof(imu_snapshot));
    memcpy(&vision_snapshot, (const void *)&g_latest_vision_sample, sizeof(vision_snapshot));

    (void)Vif_UpdateExtrinsic(&g_vif_state, &imu_snapshot, &vision_snapshot);

    /*
     * 此处可把以下诊断量暴露给上位机或日志：
     * - g_vif_state.last_gravity_error_deg
     * - g_vif_state.last_tilt_error_deg
     * - g_vif_state.last_yaw_error_deg
     * - g_vif_state.last_det
     * - reject_* 计数
     *
     * 当 det(R_ic) 明显偏离 1、gravity_error 持续抬升，
     * 或 reject_yaw_count 快速增长时，说明系统已经不是“外参有点偏”，
     * 而是观测条件本身失效了。
     */
}
```

这段代码的重点，不是把视觉和 IMU “凑起来能跑”，而是把**什么条件下可以修、什么条件下不能修、修的时候最多修多少**写进状态机里。重力负责长期拉齐 tilt，视觉在有水平参考时才接管 yaw，矩阵每次更新后都回到 `SO(3)`，坏帧则通过重投影误差、动态加速度和观测性门槛被挡在门外。只有这样，视觉坐标系与 MPU6050 姿态的对齐，才不是一次性的标定动作，而是一份能在真实振动、延迟和噪声里长期维持的工程合同。
