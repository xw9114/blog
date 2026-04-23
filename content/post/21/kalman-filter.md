---
title: "技能档案：卡尔曼滤波（Kalman Filter）的数学推演与先验信任"
slug: "skill-kalman-filter-derivation-and-prior-belief"
date: 2026-04-23T21:23:39+08:00
draft: false
description: "从状态方程、协方差传播、创新残差到 2 状态姿态融合，系统拆解卡尔曼滤波如何把先验模型与观测噪声统一到同一套概率预算。"
tags: ["卡尔曼滤波", "STM32", "传感器融合", "控制理论", "嵌入式"]
categories: ["技能档案"]
image: ""
---

## 技能概述

卡尔曼滤波的价值，从来不只是“把曲线变平滑”。它真正解决的是嵌入式系统里一个更硬核的问题：物理世界连续变化、传感器观测带噪、控制器却必须在离散采样时刻给出下一拍可执行的状态估计。无论是平衡车姿态、编码器速度、IMU 融合、温控系统状态观测，还是电机反电动势估算，核心痛点都一样：模型会错、测量会脏、采样周期会抖，但系统不能因为“不确定”就停止决策。卡尔曼滤波的意义，就在于把“上一刻我相信什么”和“这一刻传感器看到了什么”压缩成一套可计算的信任分配机制。

## 核心底层概念解析

- **状态不是数据堆，而是系统可预测性的最小表达**：卡尔曼滤波先问的不是“读到了什么”，而是“下一时刻系统应该长成什么样”。离散系统通常写成 `x(k) = F x(k-1) + B u(k) + w(k)`，其中 `F` 是系统如何把过去推进到未来的映射，`u(k)` 是外部输入，`w(k)` 是你承认自己模型不完美后留下的误差预算。没有状态方程，滤波器就只是带数学外衣的平滑器。
- **先验不是猜测，而是模型对时间连续性的押注**：所谓 **先验估计**，本质上是“如果这段时间里世界按我理解的规律继续运动，那么下一刻应该在哪里”。在姿态问题里，陀螺积分负责提供这个先验；在电机速度估计里，机械惯量和采样周期一起提供这个先验。卡尔曼滤波真正厉害的地方，不是它会修正，而是它先敢于预测。
- **协方差矩阵 P 不是附属参数，而是信任本体**：`x` 给出“我估计状态是多少”，`P` 给出“我对这份估计有多心虚”。`P` 大，意味着先验不可靠；`P` 小，意味着模型暂时值得信任。很多工程失效并不是状态公式写错，而是把 `P`、`Q`、`R` 当成调参魔法，最后让滤波器在“过度自信”和“完全多疑”之间来回摆动。
- **Q 与 R 的冲突，反映的是模型世界和传感器世界的博弈**：**过程噪声 Q** 描述的是“系统本身偏离理想模型”的程度，例如陀螺零偏游走、机械扰动、采样周期漂移；**测量噪声 R** 描述的是“传感器这句话有多脏”，例如加速度计振动噪声、ADC 量化噪声、视觉定位抖动。Q 大，滤波器更愿意听测量；R 大，滤波器更愿意守住先验。它们不是经验开关，而是对误差来源的建模立场。
- **创新量 y 是残差，也是系统发现自己看错世界的瞬间**：测量更新阶段最关键的量不是原始观测 `z(k)`，而是 **创新量** `y(k) = z(k) - H x^-(k)`。它表示“传感器看到的”和“模型预言的”差了多少。创新量长期偏大，通常意味着零偏未校准、坐标系映射错了、传感器时序撕裂，或者 Q/R 的信任分配已经偏离现实。
- **卡尔曼增益 K 不是固定权重，而是随不确定性动态重分配的信任比**：对标量观测而言，`K = P^- H^T / (H P^- H^T + R)`。如果 `P^-` 很大、`R` 很小，那么 `K` 会变大，系统更愿意被测量拉走；反之则更保守。它不像互补滤波那样先写死一个 `0.98/0.02`，而是让权重随着不确定度实时变化。换句话说，卡尔曼滤波不只是“融合两个值”，而是在融合两个来源对自己的自信程度。
- **离散化把连续物理过程压缩进采样周期 dt，dt 一旦失真，整个滤波器都会失真**：以两状态姿态模型为例，若状态为 `x = [angle, bias]^T`，输入为陀螺角速度 `gyro`，则离散先验可写成 `angle(k) = angle(k-1) + dt * (gyro - bias)`。这里 `dt` 不只是乘法因子，它会同时进入状态推进和协方差传播。定时器节拍飘了、中断延迟变了、主循环堵塞了，滤波器不是“变差一点”，而是概率意义上的世界观被改写了。
- **观测从来不是“真值”，只是带噪投影**：加速度计在静止时可以通过重力投影给出俯仰角，但车辆急加速、云台剧烈摆动或机体受振动时，它测到的是重力加上线加速度的合成结果。也就是说，测量方程 `z(k) = H x(k) + v(k)` 里的 `v(k)` 不只是随机白噪声，还可能包含结构性扰动。对这种场景，盲目调小 `R`，等于强迫系统相信一条本来就会说假话的观测链路。
- **滤波稳定性既是数学问题，也是数值实现问题**：理论上协方差矩阵应保持对称、半正定；工程上若直接用低精度浮点、长期积分、粗暴的 `(I-KH)P` 更新，数值误差会慢慢把 `P` 推成非对称甚至负值。真正可靠的实现，常常会使用 **Joseph Form** 更新、对角线下限保护、对称化回写和异常采样限幅。滤波器不是只在纸上推导，最后还是要在 MCU 的有限字长里活下去。
- **卡尔曼滤波的哲学，不是消灭不确定性，而是给不确定性定价**：模型不能保证正确，传感器不能保证诚实，系统也不能等到一切确定才行动。卡尔曼滤波的工程价值，就在于它把“不确定”从一种情绪，变成一套可传播、可更新、可利用的数学量。

## 代码能力展现

下面给出一个基于 STM32 HAL 使用场景的 2 状态卡尔曼姿态滤波示例。状态向量定义为 `x = [angle_deg, gyro_bias_dps]^T`，控制输入为陀螺角速度，测量值来自加速度计重力投影解算出的俯仰角。代码重点不在“调一个滤波函数”，而在于把 **离散状态方程、协方差传播、Joseph 形式更新、dt 限幅与原始传感器映射** 全部落实到 MCU 可运行的实现里。

```c
#include "main.h"
#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#define KALMAN_DT_MIN_S                    0.0005f
#define KALMAN_DT_MAX_S                    0.0200f
#define KALMAN_ANGLE_LIMIT_DEG             89.0f
#define KALMAN_VARIANCE_MIN                1.0e-6f
#define KALMAN_VARIANCE_MAX                1.0e6f

#define MPU6050_ACCEL_LSB_PER_G            16384.0f
#define MPU6050_GYRO_LSB_PER_DPS           131.0f
#define RAD_TO_DEG                         57.2957795f

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

    uint8_t initialized;
    uint32_t last_tick_ms;
} KalmanAngle2State_t;

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

static float Kalman_ClampVariance(float value)
{
    return ClampF32(value, KALMAN_VARIANCE_MIN, KALMAN_VARIANCE_MAX);
}

/**
 * @brief 初始化 2 状态角度卡尔曼滤波器。
 * @param kf 滤波器对象。
 * @param q_angle 角度过程噪声，反映模型对角度先验的不确定度增长速度。
 * @param q_bias 陀螺零偏过程噪声，反映零偏游走强度。
 * @param r_measure 测量噪声，反映加速度计反解角度的可信度。
 *
 * @note Q 与 R 不是“手感参数”，而是误差来源建模：
 *       - q_angle 越大，说明越不信任纯积分先验；
 *       - q_bias  越大，说明越承认零偏会随时间漂移；
 *       - r_measure 越大，说明越警惕加速度计在振动/机动下说假话。
 */
void KalmanAngle2State_Init(KalmanAngle2State_t *kf,
                            float q_angle,
                            float q_bias,
                            float r_measure)
{
    if (kf == NULL)
    {
        return;
    }

    memset(kf, 0, sizeof(*kf));
    kf->q_angle = Kalman_ClampVariance(q_angle);
    kf->q_bias = Kalman_ClampVariance(q_bias);
    kf->r_measure = Kalman_ClampVariance(r_measure);
}

/**
 * @brief 重置滤波器状态与初始协方差。
 * @param kf 滤波器对象。
 * @param initial_angle_deg 初始角度。
 * @param initial_bias_dps 初始零偏。
 * @param initial_variance 初始方差，对角线越大表示“刚启动时越不自信”。
 */
void KalmanAngle2State_Reset(KalmanAngle2State_t *kf,
                             float initial_angle_deg,
                             float initial_bias_dps,
                             float initial_variance)
{
    const float safe_variance = Kalman_ClampVariance(initial_variance);

    if (kf == NULL)
    {
        return;
    }

    kf->angle_deg = ClampF32(initial_angle_deg, -KALMAN_ANGLE_LIMIT_DEG, KALMAN_ANGLE_LIMIT_DEG);
    kf->bias_dps = initial_bias_dps;
    kf->unbiased_rate_dps = 0.0f;

    kf->p00 = safe_variance;
    kf->p01 = 0.0f;
    kf->p10 = 0.0f;
    kf->p11 = safe_variance;

    kf->initialized = 1U;
    kf->last_tick_ms = HAL_GetTick();
}

/**
 * @brief 执行一次 2 状态卡尔曼更新，融合陀螺角速度与加速度计反解角度。
 * @param kf 滤波器对象。
 * @param gyro_rate_dps 当前陀螺角速度，单位 deg/s。
 * @param accel_angle_deg 当前由加速度计反解得到的角度，单位 deg。
 * @param dt_s 本次更新使用的离散采样周期，单位 s。
 * @return 更新后的角度估计值，单位 deg。
 *
 * @note 状态定义：x = [angle, bias]^T
 *       控制输入：u = gyro_rate
 *
 *       先验预测：
 *       angle(k|k-1) = angle(k-1|k-1) + dt * (gyro - bias)
 *       bias(k|k-1)  = bias(k-1|k-1)
 *
 *       协方差传播：
 *       P(k|k-1) = F * P(k-1|k-1) * F^T + Q
 *       其中 F = [1  -dt
 *                 0   1 ]
 *
 *       测量模型：
 *       z(k) = H * x(k) + v(k), H = [1 0]
 *
 *       增益：
 *       K = P^- * H^T / (H * P^- * H^T + R)
 *
 *       这里使用 Joseph Form 更新协方差，降低数值误差把 P 推成非对称/负值的风险。
 */
float KalmanAngle2State_Update(KalmanAngle2State_t *kf,
                               float gyro_rate_dps,
                               float accel_angle_deg,
                               float dt_s)
{
    float angle_prior;
    float bias_prior;
    float p00_prior;
    float p01_prior;
    float p10_prior;
    float p11_prior;
    float innovation;
    float innovation_cov;
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

    if (kf == NULL)
    {
        return 0.0f;
    }

    dt_s = ClampF32(dt_s, KALMAN_DT_MIN_S, KALMAN_DT_MAX_S);
    accel_angle_deg = ClampF32(accel_angle_deg, -KALMAN_ANGLE_LIMIT_DEG, KALMAN_ANGLE_LIMIT_DEG);
    kf->q_angle = Kalman_ClampVariance(kf->q_angle);
    kf->q_bias = Kalman_ClampVariance(kf->q_bias);
    kf->r_measure = Kalman_ClampVariance(kf->r_measure);

    /* ---------- Prediction ----------
     * 连续角速度被离散化后，先验角度按 dt 向前推进。
     * 这里减去 bias，是因为陀螺输出 = 真角速度 + 零偏 + 噪声。
     */
    kf->unbiased_rate_dps = gyro_rate_dps - kf->bias_dps;
    angle_prior = kf->angle_deg + dt_s * kf->unbiased_rate_dps;
    bias_prior = kf->bias_dps;

    /* 协方差传播显式展开自 P^- = F P F^T + Q：
     *
     * p00^- = p00 + dt * (dt * p11 - p01 - p10) + q_angle * dt
     * p01^- = p01 - dt * p11
     * p10^- = p10 - dt * p11
     * p11^- = p11 + q_bias * dt
     *
     * 直观含义：
     * - 时间推进得越久，角度不确定度会因为积分而增加；
     * - 若承认 bias 会游走，则 p11 不能长期锁死不动。
     */
    p00_prior = kf->p00 + dt_s * (dt_s * kf->p11 - kf->p01 - kf->p10) + kf->q_angle * dt_s;
    p01_prior = kf->p01 - dt_s * kf->p11;
    p10_prior = kf->p10 - dt_s * kf->p11;
    p11_prior = kf->p11 + kf->q_bias * dt_s;

    p00_prior = Kalman_ClampVariance(p00_prior);
    p11_prior = Kalman_ClampVariance(p11_prior);

    /* ---------- Correction ----------
     * 创新量 = 实际测量 - 先验预测
     * 若 innovation 长期偏大，就该回头查零偏、安装方向、时间基和传感器时序。
     */
    innovation = accel_angle_deg - angle_prior;
    innovation_cov = p00_prior + kf->r_measure;
    innovation_cov = Kalman_ClampVariance(innovation_cov);

    k0 = p00_prior / innovation_cov;
    k1 = p10_prior / innovation_cov;

    kf->angle_deg = angle_prior + k0 * innovation;
    kf->bias_dps = bias_prior + k1 * innovation;
    kf->angle_deg = ClampF32(kf->angle_deg, -KALMAN_ANGLE_LIMIT_DEG, KALMAN_ANGLE_LIMIT_DEG);

    /* Joseph Form:
     * P = (I - K H) P^- (I - K H)^T + K R K^T
     *
     * 对 H = [1 0] 的标量测量场景，仍显式保留矩阵运算，
     * 目的是把“数值稳定性”也作为工程约束写进代码，而不是只停留在纸面公式。
     */
    a00 = 1.0f - k0;
    a01 = 0.0f;
    a10 = -k1;
    a11 = 1.0f;

    ap00 = a00 * p00_prior + a01 * p10_prior;
    ap01 = a00 * p01_prior + a01 * p11_prior;
    ap10 = a10 * p00_prior + a11 * p10_prior;
    ap11 = a10 * p01_prior + a11 * p11_prior;

    p00_new = ap00 * a00 + ap01 * a01 + k0 * kf->r_measure * k0;
    p01_new = ap00 * a10 + ap01 * a11 + k0 * kf->r_measure * k1;
    p10_new = ap10 * a00 + ap11 * a01 + k1 * kf->r_measure * k0;
    p11_new = ap10 * a10 + ap11 * a11 + k1 * kf->r_measure * k1;

    cross = 0.5f * (p01_new + p10_new);

    kf->p00 = Kalman_ClampVariance(p00_new);
    kf->p01 = cross;
    kf->p10 = cross;
    kf->p11 = Kalman_ClampVariance(p11_new);

    return kf->angle_deg;
}

/**
 * @brief 用 MPU6050 原始数据更新俯仰角卡尔曼估计。
 * @param kf 滤波器对象。
 * @param accel_x_raw 加速度计 X 轴原始值。
 * @param accel_z_raw 加速度计 Z 轴原始值。
 * @param gyro_y_raw 陀螺仪 Y 轴原始值。
 * @param out_pitch_deg 输出俯仰角估计。
 * @retval true 更新成功。
 * @retval false 参数非法，或加速度向量退化到无法反解角度。
 *
 * @note 这里示例的是常见平衡车/双轮车体坐标：
 *       - 俯仰角由 X/Z 轴重力投影通过 atan2f 求得；
 *       - 陀螺 Y 轴角速度作为控制输入；
 *       - dt 使用 HAL_GetTick() 的毫秒节拍换算。
 */
bool KalmanAngle2State_UpdatePitchFromMpu6050(KalmanAngle2State_t *kf,
                                              int16_t accel_x_raw,
                                              int16_t accel_z_raw,
                                              int16_t gyro_y_raw,
                                              float *out_pitch_deg)
{
    float ax_g;
    float az_g;
    float accel_pitch_deg;
    float gyro_rate_dps;
    uint32_t now_ms;
    float dt_s;

    if ((kf == NULL) || (out_pitch_deg == NULL))
    {
        return false;
    }

    ax_g = (float)accel_x_raw / MPU6050_ACCEL_LSB_PER_G;
    az_g = (float)accel_z_raw / MPU6050_ACCEL_LSB_PER_G;

    if ((fabsf(ax_g) + fabsf(az_g)) < 1.0e-6f)
    {
        return false;
    }

    gyro_rate_dps = (float)gyro_y_raw / MPU6050_GYRO_LSB_PER_DPS;

    /* 由重力投影反解俯仰角：
     * pitch = atan2(ax, az) * 180 / pi
     *
     * 这不是“套个 atan2”就结束了，而是在把机体系的向量投影
     * 映射回控制器使用的角度坐标。
     */
    accel_pitch_deg = atan2f(ax_g, az_g) * RAD_TO_DEG;
    accel_pitch_deg = ClampF32(accel_pitch_deg, -KALMAN_ANGLE_LIMIT_DEG, KALMAN_ANGLE_LIMIT_DEG);

    now_ms = HAL_GetTick();

    if (kf->initialized == 0U)
    {
        KalmanAngle2State_Reset(kf, accel_pitch_deg, 0.0f, 1.0f);
        kf->last_tick_ms = now_ms;
        *out_pitch_deg = kf->angle_deg;
        return true;
    }

    dt_s = (float)(now_ms - kf->last_tick_ms) * 0.001f;
    kf->last_tick_ms = now_ms;

    *out_pitch_deg = KalmanAngle2State_Update(kf, gyro_rate_dps, accel_pitch_deg, dt_s);
    return true;
}

KalmanAngle2State_t g_pitch_kalman;

void App_AttitudeFusionInit(void)
{
    /* 一组适合作为起点的经验量级：
     * - q_angle   : 陀螺积分模型误差
     * - q_bias    : 零偏随机游走
     * - r_measure : 加速度计反解角度噪声
     *
     * 真正整定时，应结合静态噪声、振动环境和控制带宽重新估计。
     */
    KalmanAngle2State_Init(&g_pitch_kalman, 0.02f, 0.003f, 0.5f);
}

bool App_AttitudeFusionStep(int16_t accel_x_raw,
                            int16_t accel_z_raw,
                            int16_t gyro_y_raw,
                            float *out_pitch_deg)
{
    return KalmanAngle2State_UpdatePitchFromMpu6050(&g_pitch_kalman,
                                                    accel_x_raw,
                                                    accel_z_raw,
                                                    gyro_y_raw,
                                                    out_pitch_deg);
}
```

这段实现真正想表达的，不是“STM32 上怎么写一个卡尔曼函数”，而是一个更底层的事实：**滤波器每一步都在重新分配对世界的信任**。陀螺积分提供时间连续性，加速度计提供空间参考，`Q/R/P` 决定系统如何在模型与观测之间保持克制，`dt` 决定这份克制是否还建立在真实时基上。理解了这些，卡尔曼滤波才不再是“调得出来就行”的黑盒，而是一套把不确定性转译成可计算工程约束的语言。
