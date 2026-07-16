---
title: "技能档案：Kalman Filter 里的 Joseph 协方差更新、正定性守卫与有限字长舍入"
slug: "skill-kalman-joseph-covariance-psd-guard-and-finite-precision-rounding"
date: 2026-07-16T09:10:05+08:00
draft: false
description: "从协方差为何会在 float32 MCU 上失去正定性，到 Joseph 形式如何把“危险减法”改写成“能量相加”的稳定更新，系统拆解 Kalman Filter 在嵌入式落地时最容易被忽略的数值合同。"
tags: ["Kalman Filter", "STM32", "数值稳定性", "协方差", "传感器融合"]
categories: ["技能档案"]
image: ""
---

## 技能概述

很多嵌入式项目把 Kalman Filter 的失败归咎于“`Q/R` 没调好”，却忽略了另一个更底层、也更致命的事实：**你在 MCU 上跑的不是黑板上的实数滤波器，而是一个受 `float32` 舍入、采样抖动、状态尺度失衡和矩阵病态共同约束的有限字长状态估计器**。一旦协方差矩阵 `P` 在更新阶段丢掉对称性或正定性，后续的 Kalman 增益、创新方差乃至整条信任链都会开始失真，表现出来就是角度估计忽然发飘、观测一加入就抖、甚至一段时间后直接“越滤越坏”。这个主题要解决的核心痛点，不是再教一遍公式，而是回答一个更工程化的问题：**为什么同样的 Kalman 方程在 PC 仿真里稳定，在 STM32 上却会因数值合同被破坏而悄悄失真，以及该怎样用 Joseph 形式、PSD 守卫和有限字长约束把它重新拉回可审计的闭环。**

## 核心底层概念解析

- **协方差 `P` 不是缓存变量，而是“不确定性几何”的离散投影**：`P` 的主对角线描述每个状态分量的方差，非对角线描述状态之间的相关性。对二维状态而言，它对应的是一只会随预测与观测不断拉伸、旋转的误差椭圆。Kalman Filter 真正做的事，不是“算一个更平滑的数”，而是在每个采样周期里重塑这只误差椭圆。

- **从连续物理噪声到离散 `Q_d`，本质上是把传感器功率谱密度映射到采样周期上**：以常见的姿态二状态模型 `x = [θ, b]^T` 为例，若 `θ` 由陀螺积分得到、`b` 为陀螺零偏，则连续模型可写成  
  `θ̇ = ω_g - b + n_g`，`ḃ = n_b`。  
  离散化后，过程噪声协方差不再是“凭经验拍一个矩阵”，而应满足  
  `Q_d = [[q_g Δt + q_b Δt^3 / 3, -q_b Δt^2 / 2], [-q_b Δt^2 / 2, q_b Δt]]`。  
  这里 `q_g` 对应陀螺白噪声密度，`q_b` 对应零偏随机游走密度。也就是说，**噪声并不是写进代码里才存在，而是从器件物理噪声经积分与采样映射进矩阵里。**

- **标准协方差更新式在有限字长下容易出现“灾难性消减”**：很多教材写更新式为 `P⁺ = (I - K H) P⁻`。它在代数上成立，但数值上非常脆弱，因为这一步本质上在做“大数减大数”。当 `K H P` 与 `P` 大小接近时，`float32` 的有效位会把本应极小且非负的残差直接削成负数，于是矩阵主对角线可能变负，或者 `P01 != P10`，协方差的物理意义当场崩塌。

- **Joseph 形式的价值，在于把“危险减法”改写成“能量相加”**：更稳健的写法是  
  `P⁺ = (I - K H) P⁻ (I - K H)^T + K R K^T`。  
  前半项表示经观测约束后剩余的不确定性，后半项表示观测噪声通过增益投影回状态空间后的残余能量。它比简化式多做几次乘法，却显著降低了舍入误差把 `P` 打出正半定锥的概率。换句话说，**Joseph 形式不是“更复杂的同义改写”，而是数值稳定性的工程保险丝。**

- **对称性与正定性，是协方差矩阵的两条最低物理合同**：真实协方差必须满足 `P = P^T` 且 `x^T P x >= 0`。前者意味着“互相关”的定义必须前后一致，后者意味着“沿任意方向的不确定性都不能是负能量”。如果滤波器跑着跑着出现 `P01 != P10` 或某个特征值为负，你得到的就不再是“更不确定”或“更确定”，而是**丢失了物理解释权的伪矩阵**。

- **创新方差 `S = H P H^T + R` 是“这一拍还该不该信传感器”的数学门槛**：`S` 必须严格大于零，否则 Kalman 增益 `K = P H^T S^-1` 根本没有可信分母。`S` 太小常见于两类错误：一类是把 `R` 设得过分乐观，另一类是 `P` 已因数值退化被压得近乎奇异。工程上如果 `S` 连最小阈值都保不住，就不要再谈“融合”，因为你连“这次观测的信任预算”都算不出来了。

- **有限字长问题的根源，常常不是 MCU 算力不足，而是状态尺度不匹配**：若角度状态量级是 `10^-1 rad`，偏置状态量级是 `10^-3 rad/s`，而你又把位置、速度、电流等不同维度硬塞进同一矩阵，矩阵条件数会快速变坏。此时哪怕仍用 `float32`，问题也不在“单次乘法不够准”，而在**小量被大尺度状态吞没，滤波器内部的信任预算已无法细分到有效位级别。**

- **PSD 守卫不是篡改数学，而是把数值实现重新投影回物理可行域**：对二维对称矩阵 `P = [[a, b], [b, d]]`，其特征值满足  
  `λ₁,₂ = 0.5 * [(a + d) ± sqrt((a - d)^2 + 4 b^2)]`。  
  若 `λ_min < λ_floor`，可以通过 `P ← P + (λ_floor - λ_min) I` 把矩阵抬回正半定锥。它会轻微增大估计不确定性，但这比带着“负方差”继续运行要诚实得多。

- **Joseph 形式的额外乘法成本，往往比一次现场事故便宜太多**：二维或三维嵌入式滤波器里，多出的矩阵乘法不过几十个浮点操作；而一旦协方差失真，后面为了查“为什么只有上车颠簸时姿态会抖”可能要花几天抓日志、查传感器、换板子。**用少量算力换稳定信任链，通常是嵌入式系统里最划算的资源交易之一。**

- **Kalman Filter 的工程哲学，从来不是“绝对相信模型”或“绝对相信传感器”**：它本质上是在每个采样周期里不断重写一句话——**当前这份信任，究竟该分配给先验演化，还是分配给本次观测。** 而 Joseph 形式、创新门控、PSD 修复这些看似“数值细节”的操作，本质上都是在保护这份信任分配不要被有限字长和实现误差偷梁换柱。

## 代码能力展现

下面给出一段基于 **STM32 HAL 风格** 的二状态姿态 Kalman 骨架，状态定义为 `x = [angle, gyro_bias]^T`。代码重点不在“如何从 MPU6050 读寄存器”，而在三件更底层的事情上：

- 用连续噪声密度推导离散 `Q_d`，而不是手填魔法数字；
- 用 **Joseph 形式** 更新协方差，避免 `float32` 下的灾难性消减；
- 在每次预测/更新后做 **对称化 + PSD 守卫**，把矩阵重新投影回物理可行域。

```c
#include "main.h"

#include <math.h>
#include <stdbool.h>
#include <stdint.h>

#define KALMAN_PI_F                          3.14159265358979323846f
#define KALMAN_MIN_DT_S                      0.0005f
#define KALMAN_MAX_DT_S                      0.0200f
#define KALMAN_MIN_VARIANCE                  1.0e-9f
#define KALMAN_MIN_INNOVATION_VAR            1.0e-7f
#define KALMAN_MAX_ABS_GYRO_RAD_S            35.0f
#define KALMAN_MAX_ABS_BIAS_RAD_S            8.0f
#define KALMAN_ACCEL_NIS_GATE                16.0f
#define KALMAN_ACCEL_NORM_GATE_G             0.15f
#define KALMAN_MATRIX_EPSILON                1.0e-12f

typedef struct
{
    float angle_rad;
    float bias_rad_s;

    /* 2x2 协方差矩阵：
     * P[0][0] -> angle 方差
     * P[0][1] / P[1][0] -> angle 与 bias 相关性
     * P[1][1] -> bias 方差
     */
    float P[2][2];

    /* 连续时间噪声密度：
     * q_gyro_rad2_s     : 陀螺白噪声功率谱密度，单位约为 rad^2 / s
     * q_bias_rw_rad2_s3 : 零偏随机游走密度，单位约为 (rad/s)^2 / s = rad^2 / s^3
     * r_accel_rad2      : 加速度反解倾角观测噪声方差，单位 rad^2
     */
    float q_gyro_rad2_s;
    float q_bias_rw_rad2_s3;
    float r_accel_rad2;

    uint32_t psd_repair_count;
    uint32_t symmetry_repair_count;
    uint32_t accel_reject_count;
} KalmanAngleBias_t;

typedef struct
{
    int16_t accel_x_lsb;
    int16_t accel_y_lsb;
    int16_t accel_z_lsb;
    int16_t gyro_y_lsb;

    float accel_lsb_per_g;
    float gyro_lsb_per_rad_s;
} ImuRawSample_t;

static float Kalman_ClampF(float value, float min_value, float max_value)
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

static float Kalman_WrapPi(float angle_rad)
{
    while (angle_rad > KALMAN_PI_F)
    {
        angle_rad -= 2.0f * KALMAN_PI_F;
    }

    while (angle_rad < -KALMAN_PI_F)
    {
        angle_rad += 2.0f * KALMAN_PI_F;
    }

    return angle_rad;
}

/**
 * @brief 将 2x2 协方差矩阵重新对称化。
 * @param kf Kalman 滤波器对象。
 *
 * @note 理论上协方差必须满足 P = P^T；但 float32 舍入和不同计算路径会导致
 *       P01 与 P10 产生 ulp 级偏差。这里直接取平均值：
 *       p01_sym = 0.5 * (P01 + P10)
 *       然后令 P01 = P10 = p01_sym。
 */
static void Kalman_SymmetrizeCovariance(KalmanAngleBias_t *kf)
{
    const float offdiag = 0.5f * (kf->P[0][1] + kf->P[1][0]);

    if (fabsf(kf->P[0][1] - kf->P[1][0]) > KALMAN_MATRIX_EPSILON)
    {
        kf->symmetry_repair_count++;
    }

    kf->P[0][1] = offdiag;
    kf->P[1][0] = offdiag;
}

/**
 * @brief 将 2x2 对称矩阵投影回正半定锥，避免负特征值继续传播。
 * @param kf Kalman 滤波器对象。
 * @param eig_floor 最小特征值地板，必须为正。
 *
 * @note 对称矩阵 P = [[a, b], [b, d]] 的特征值为：
 *       λ1,2 = 0.5 * [(a + d) ± sqrt((a - d)^2 + 4b^2)]
 *       若 λ_min < λ_floor，则令：
 *       P <- P + (λ_floor - λ_min) * I
 *
 *       这相当于沿单位矩阵方向平移，把协方差矩阵重新抬回物理可行域。
 */
static void Kalman_ProjectCovarianceToPsd(KalmanAngleBias_t *kf, float eig_floor)
{
    const float a = kf->P[0][0];
    const float b = kf->P[0][1];
    const float d = kf->P[1][1];
    const float trace = a + d;
    const float diff = a - d;
    const float radius = sqrtf(diff * diff + 4.0f * b * b);
    const float lambda_min = 0.5f * (trace - radius);

    if (lambda_min < eig_floor)
    {
        const float shift = eig_floor - lambda_min;
        kf->P[0][0] += shift;
        kf->P[1][1] += shift;
        kf->psd_repair_count++;
    }

    /* 再加一道主对角线地板，避免极端情况下出现接近 0 的负零或 subnormal。 */
    kf->P[0][0] = Kalman_ClampF(kf->P[0][0], eig_floor, 1.0e6f);
    kf->P[1][1] = Kalman_ClampF(kf->P[1][1], eig_floor, 1.0e6f);
}

/**
 * @brief 根据连续时间噪声密度构造 angle-bias 模型的离散过程噪声矩阵 Qd。
 * @param dt_s               采样周期，单位 s。
 * @param q_gyro_rad2_s      陀螺白噪声密度。
 * @param q_bias_rw_rad2_s3  零偏随机游走密度。
 * @param qd                 [out] 2x2 离散过程噪声矩阵。
 *
 * @note 连续模型：
 *       x = [θ, b]^T
 *       θ̇ = ωg - b + ng
 *       ḃ = nb
 *
 *       对应离散 Qd 可写为：
 *       Q00 = qg * dt + qb * dt^3 / 3
 *       Q01 = Q10 = -qb * dt^2 / 2
 *       Q11 = qb * dt
 *
 *       这里的负号来自 bias 对 angle 的积分耦合：
 *       bias 越高，预测 angle 会被减得越快，因此相关项为负。
 */
static void Kalman_BuildDiscreteProcessNoise(float dt_s,
                                             float q_gyro_rad2_s,
                                             float q_bias_rw_rad2_s3,
                                             float qd[2][2])
{
    const float dt2 = dt_s * dt_s;
    const float dt3 = dt2 * dt_s;

    qd[0][0] = q_gyro_rad2_s * dt_s + q_bias_rw_rad2_s3 * dt3 / 3.0f;
    qd[0][1] = -q_bias_rw_rad2_s3 * dt2 * 0.5f;
    qd[1][0] = qd[0][1];
    qd[1][1] = q_bias_rw_rad2_s3 * dt_s;
}

/**
 * @brief 初始化 angle-bias Kalman 滤波器。
 * @param kf                Kalman 滤波器对象。
 * @param angle0_rad        初始角度估计，单位 rad。
 * @param bias0_rad_s       初始零偏估计，单位 rad/s。
 * @param sigma_angle_rad   初始角度标准差，单位 rad。
 * @param sigma_bias_rad_s  初始零偏标准差，单位 rad/s。
 * @param q_gyro_rad2_s     陀螺白噪声密度。
 * @param q_bias_rw_rad2_s3 零偏随机游走密度。
 * @param r_accel_rad2      加速度倾角观测噪声方差。
 */
void KalmanAngleBias_Init(KalmanAngleBias_t *kf,
                          float angle0_rad,
                          float bias0_rad_s,
                          float sigma_angle_rad,
                          float sigma_bias_rad_s,
                          float q_gyro_rad2_s,
                          float q_bias_rw_rad2_s3,
                          float r_accel_rad2)
{
    if (kf == NULL)
    {
        return;
    }

    kf->angle_rad = Kalman_WrapPi(angle0_rad);
    kf->bias_rad_s = Kalman_ClampF(bias0_rad_s, -KALMAN_MAX_ABS_BIAS_RAD_S, KALMAN_MAX_ABS_BIAS_RAD_S);

    kf->P[0][0] = Kalman_ClampF(sigma_angle_rad * sigma_angle_rad, KALMAN_MIN_VARIANCE, 1.0e6f);
    kf->P[0][1] = 0.0f;
    kf->P[1][0] = 0.0f;
    kf->P[1][1] = Kalman_ClampF(sigma_bias_rad_s * sigma_bias_rad_s, KALMAN_MIN_VARIANCE, 1.0e6f);

    kf->q_gyro_rad2_s = Kalman_ClampF(q_gyro_rad2_s, KALMAN_MIN_VARIANCE, 1.0f);
    kf->q_bias_rw_rad2_s3 = Kalman_ClampF(q_bias_rw_rad2_s3, KALMAN_MIN_VARIANCE, 1.0f);
    kf->r_accel_rad2 = Kalman_ClampF(r_accel_rad2, KALMAN_MIN_VARIANCE, 1.0f);

    kf->psd_repair_count = 0U;
    kf->symmetry_repair_count = 0U;
    kf->accel_reject_count = 0U;
}

/**
 * @brief 执行一步预测，把陀螺角速度积分到 angle，并传播协方差。
 * @param kf             Kalman 滤波器对象。
 * @param gyro_rad_s     当前陀螺测得角速度，单位 rad/s。
 * @param dt_s           采样周期，单位 s。
 *
 * @note 状态转移为：
 *       angle_k^- = angle_{k-1} + (gyro - bias) * dt
 *       bias_k^-  = bias_{k-1}
 *
 *       对应 F = [[1, -dt], [0, 1]]。
 *       协方差传播为：
 *       P^- = F * P * F^T + Qd
 */
void KalmanAngleBias_Predict(KalmanAngleBias_t *kf, float gyro_rad_s, float dt_s)
{
    float qd[2][2];
    float p00;
    float p01;
    float p10;
    float p11;

    if (kf == NULL)
    {
        return;
    }

    dt_s = Kalman_ClampF(dt_s, KALMAN_MIN_DT_S, KALMAN_MAX_DT_S);
    gyro_rad_s = Kalman_ClampF(gyro_rad_s, -KALMAN_MAX_ABS_GYRO_RAD_S, KALMAN_MAX_ABS_GYRO_RAD_S);

    /* 先用去偏后的角速度做状态预测。 */
    kf->angle_rad += (gyro_rad_s - kf->bias_rad_s) * dt_s;
    kf->angle_rad = Kalman_WrapPi(kf->angle_rad);

    /* 连续噪声映射到离散 Qd。 */
    Kalman_BuildDiscreteProcessNoise(dt_s, kf->q_gyro_rad2_s, kf->q_bias_rw_rad2_s3, qd);

    /* 手工展开 2x2 FPF^T，避免通用矩阵库带来的额外开销。
     * F = [[1, -dt], [0, 1]]，所以：
     * p00^- = p00 - dt*(p01 + p10) + dt^2*p11 + q00
     * p01^- = p01 - dt*p11 + q01
     * p10^- = p10 - dt*p11 + q10
     * p11^- = p11 + q11
     */
    p00 = kf->P[0][0] - dt_s * (kf->P[0][1] + kf->P[1][0]) + dt_s * dt_s * kf->P[1][1] + qd[0][0];
    p01 = kf->P[0][1] - dt_s * kf->P[1][1] + qd[0][1];
    p10 = kf->P[1][0] - dt_s * kf->P[1][1] + qd[1][0];
    p11 = kf->P[1][1] + qd[1][1];

    kf->P[0][0] = p00;
    kf->P[0][1] = p01;
    kf->P[1][0] = p10;
    kf->P[1][1] = p11;

    Kalman_SymmetrizeCovariance(kf);
    Kalman_ProjectCovarianceToPsd(kf, KALMAN_MIN_VARIANCE);
}

/**
 * @brief 用加速度反解倾角执行一步测量更新。
 * @param kf                Kalman 滤波器对象。
 * @param accel_angle_rad   加速度计算出的倾角观测值，单位 rad。
 * @retval true  本次观测被接受并完成更新。
 * @retval false 本次观测被拒绝（例如创新过大）。
 *
 * @note 测量模型：
 *       z = Hx + v,  H = [1, 0]
 *
 *       创新：
 *       y = z - Hx^- = z - angle^-
 *
 *       创新方差：
 *       S = HPH^T + R = P00 + R
 *
 *       Kalman 增益：
 *       K = [P00 / S, P10 / S]^T
 *
 *       Joseph 形式协方差更新：
 *       P^+ = (I - KH) P^- (I - KH)^T + K R K^T
 */
bool KalmanAngleBias_UpdateAccel(KalmanAngleBias_t *kf, float accel_angle_rad)
{
    float innovation;
    float innovation_var;
    float nis;
    float k0;
    float k1;
    float a00;
    float a10;
    float p00;
    float p01;
    float p10;
    float p11;
    float j00;
    float j01;
    float j10;
    float j11;

    if (kf == NULL)
    {
        return false;
    }

    accel_angle_rad = Kalman_WrapPi(accel_angle_rad);

    /* 角度差必须回到 [-pi, pi]，否则 +179° 与 -179° 会被误判成 358° 的大残差。 */
    innovation = Kalman_WrapPi(accel_angle_rad - kf->angle_rad);

    innovation_var = kf->P[0][0] + kf->r_accel_rad2;
    innovation_var = Kalman_ClampF(innovation_var, KALMAN_MIN_INNOVATION_VAR, 1.0e6f);

    /* NIS = y^2 / S，用于拒绝本次明显失真的倾角观测。 */
    nis = innovation * innovation / innovation_var;
    if (nis > KALMAN_ACCEL_NIS_GATE)
    {
        kf->accel_reject_count++;
        return false;
    }

    k0 = kf->P[0][0] / innovation_var;
    k1 = kf->P[1][0] / innovation_var;

    /* 先更新状态，再更新协方差。 */
    kf->angle_rad += k0 * innovation;
    kf->angle_rad = Kalman_WrapPi(kf->angle_rad);

    kf->bias_rad_s += k1 * innovation;
    kf->bias_rad_s = Kalman_ClampF(kf->bias_rad_s,
                                   -KALMAN_MAX_ABS_BIAS_RAD_S,
                                   KALMAN_MAX_ABS_BIAS_RAD_S);

    /* 取更新前的 P^-，避免状态更新覆盖掉协方差传播结果。 */
    p00 = kf->P[0][0];
    p01 = kf->P[0][1];
    p10 = kf->P[1][0];
    p11 = kf->P[1][1];

    /* 对 H = [1, 0] 而言：
     * A = I - K H = [[1 - k0, 0], [-k1, 1]]
     */
    a00 = 1.0f - k0;
    a10 = -k1;

    /* 先算 (I - KH)P(I - KH)^T。手工展开的好处是每一项来源清晰，
     * 也便于审核哪些乘法是在保护 PSD，哪些是简化过后的危险减法。
     */
    j00 = a00 * a00 * p00;
    j01 = a00 * (a10 * p00 + p01);
    j10 = a00 * (a10 * p00 + p10);
    j11 = a10 * a10 * p00 + a10 * (p01 + p10) + p11;

    /* 再加上 K R K^T：
     * [[k0^2 R, k0 k1 R],
     *  [k0 k1 R, k1^2 R]]
     * 这一步把观测噪声经过增益投影回状态空间，是 Joseph 形式稳定性的关键。
     */
    j00 += k0 * k0 * kf->r_accel_rad2;
    j01 += k0 * k1 * kf->r_accel_rad2;
    j10 += k0 * k1 * kf->r_accel_rad2;
    j11 += k1 * k1 * kf->r_accel_rad2;

    kf->P[0][0] = j00;
    kf->P[0][1] = j01;
    kf->P[1][0] = j10;
    kf->P[1][1] = j11;

    Kalman_SymmetrizeCovariance(kf);
    Kalman_ProjectCovarianceToPsd(kf, KALMAN_MIN_VARIANCE);

    return true;
}

/**
 * @brief 基于 MPU6050 一拍样本运行一次 pitch Kalman 融合。
 * @param kf      Kalman 滤波器对象。
 * @param sample  原始 IMU 样本。
 * @param dt_s    采样周期，单位 s。
 * @retval true  加速度观测被接受。
 * @retval false 仅执行了预测，或输入参数非法。
 *
 * @note 倾角观测只在“加速度模长接近 1g”时参与更新，
 *       这是因为剧烈线加速度会破坏 `atan2()` 反解倾角的重力前提。
 */
bool App_KalmanPitchStep(KalmanAngleBias_t *kf,
                         const ImuRawSample_t *sample,
                         float dt_s)
{
    float ax_g;
    float ay_g;
    float az_g;
    float gyro_y_rad_s;
    float accel_norm_g;
    float accel_pitch_rad;

    if ((kf == NULL) || (sample == NULL) ||
        (sample->accel_lsb_per_g <= 0.0f) ||
        (sample->gyro_lsb_per_rad_s <= 0.0f))
    {
        return false;
    }

    ax_g = (float)sample->accel_x_lsb / sample->accel_lsb_per_g;
    ay_g = (float)sample->accel_y_lsb / sample->accel_lsb_per_g;
    az_g = (float)sample->accel_z_lsb / sample->accel_lsb_per_g;
    gyro_y_rad_s = (float)sample->gyro_y_lsb / sample->gyro_lsb_per_rad_s;

    KalmanAngleBias_Predict(kf, gyro_y_rad_s, dt_s);

    accel_norm_g = sqrtf(ax_g * ax_g + ay_g * ay_g + az_g * az_g);
    if (fabsf(accel_norm_g - 1.0f) > KALMAN_ACCEL_NORM_GATE_G)
    {
        /* 明显存在较大线加速度，只保留陀螺预测。 */
        return false;
    }

    accel_pitch_rad = atan2f(-ax_g, sqrtf(ay_g * ay_g + az_g * az_g));
    return KalmanAngleBias_UpdateAccel(kf, accel_pitch_rad);
}

/* 典型 HAL 用法：在 1 kHz 定时中断里读一拍 IMU 并推进滤波器。 */
extern I2C_HandleTypeDef hi2c1;
extern TIM_HandleTypeDef htim6;
extern bool MPU6050_ReadBurstHAL(I2C_HandleTypeDef *hi2c, ImuRawSample_t *sample);

static KalmanAngleBias_t g_pitch_kf;

void App_AttitudeEstimatorInit(void)
{
    KalmanAngleBias_Init(&g_pitch_kf,
                         0.0f,
                         0.0f,
                         10.0f * (KALMAN_PI_F / 180.0f),   /* 初始 angle σ = 10 deg */
                         2.0f * (KALMAN_PI_F / 180.0f),    /* 初始 bias  σ = 2 deg/s */
                         2.5e-3f,
                         4.0e-5f,
                         1.2e-2f);
}

void HAL_TIM_PeriodElapsedCallback(TIM_HandleTypeDef *htim)
{
    ImuRawSample_t sample;

    if ((htim == NULL) || (htim->Instance != TIM6))
    {
        return;
    }

    if (MPU6050_ReadBurstHAL(&hi2c1, &sample) == false)
    {
        return;
    }

    sample.accel_lsb_per_g = 16384.0f;                 /* ±2g 档位 */
    sample.gyro_lsb_per_rad_s = 131.0f * 57.2957795f;  /* ±250 dps -> LSB/rad/s */

    (void)App_KalmanPitchStep(&g_pitch_kf, &sample, 0.001f);
}
```

这段实现里最值得关注的，不是 `atan2f()` 或 `TIM6` 这些表层 API，而是三条更底层的工程边界：

1. **`Q_d` 必须跟着 `dt` 变化**，因为你积分的是连续噪声，不是离散魔法常量；
2. **协方差更新优先用 Joseph 形式**，因为它在 `float32` 上更接近“先做能量分解，再做数值实现”；
3. **一旦 `P` 偏离对称/PSD，可接受的修复策略是“承认自己更不确定”**，而不是继续带着负方差往下跑。

真正稳定的 Kalman Filter，从来不只是公式写对，而是**在有限精度、有限算力和有限传感器可信度的现实里，仍然守住了那份关于“先验与观测如何分账”的物理合同。**
