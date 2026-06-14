---
title: "技能档案：卡尔曼滤波里的测量延迟、离序观测与固定滞后回放"
slug: "skill-kalman-delayed-measurement-out-of-sequence-and-fixed-lag-replay"
date: 2026-06-14T11:54:48+08:00
draft: false
description: "从状态时间戳、延迟观测落点、Joseph 更新到固定滞后缓存回放，系统拆解卡尔曼滤波为什么常死在时间对齐而不是增益公式。"
tags: ["Kalman", "STM32", "传感器融合", "延迟补偿", "离序观测", "固定滞后", "嵌入式"]
categories: ["技能档案"]
image: ""
---

## 技能概述

很多嵌入式融合系统真正难的，不是把卡尔曼公式抄进代码，而是不同传感器根本不活在同一个“现在”。陀螺 1 kHz 连续吐数据，编码器几十到几百赫兹，视觉模块 30 Hz 甚至更慢，还常常带着曝光、DMA、串口搬运和推理流水线延迟。如果把一笔 25 ms 前拍到的姿态观测，直接拿来修正“此刻”的状态，系统看起来像在融合，实质上是在把旧世界强行覆盖到新世界。这个主题要解决的核心痛点，不是再讲一遍预测和更新，而是把 **状态时间戳**、**延迟测量落点**、**离序观测更新** 和 **固定滞后回放** 串成一条能在 STM32 HAL 场景落地的时间轴管理链路。

## 核心底层概念解析

- **卡尔曼状态首先是一份“带时间戳的信念”，不是一组永远有效的数**：`x_k` 的真实语义不是“当前姿态”，而是“在 `t_k` 这一刻，对姿态和偏置的最优估计”。一旦测量发生在 `t_m`，就只能修正 `t_m` 附近的状态；如果你拿它去更新 `t_now`，其实是在做时间错配。
- **延迟测量不是噪声更大的测量，两者不能用同一个 `R` 糊过去**：测量噪声 `R` 负责描述“这笔观测本身有多抖”，而测量延迟描述的是“这笔观测属于过去哪个时刻”。把延迟错误塞进 `R`，只会让滤波器变钝，却不会修复相位错误。
- **离序观测（Out-of-Sequence Measurement, OOSM）的本质，是观测到达顺序与状态生成顺序不一致**：系统内部状态通常按 `t0 -> t1 -> t2 -> ... -> t_now` 正序推进，但视觉或无线链路上的观测可能在 `t5` 产生，却在 `t12` 才到达。这不是单纯的慢，而是“落点在过去”。
- **固定滞后回放的核心动作，不是“多存几帧”，而是“允许过去被修改后，未来重新计算一遍”**：一笔延迟观测修正了 `x(t_m)` 之后，`x(t_m+1)` 到 `x(t_now)` 全部都已经不是原来的最优解。你要么重放这段时间内的预测和中间观测，要么接受系统持续带着陈旧误差往前跑。
- **只存当前状态，不存历史驱动量，就没有资格做回放**：回放不是把旧状态拿出来看看，而是要按原始输入重新推进。对于姿态系统，至少要保存每一步的 **时间戳**、**预测步长 `dt`**、**驱动输入 `u_k`**，例如陀螺角速度。
- **固定滞后窗口长度本质上是资源调度问题**：若最大延迟为 `T_delay_max`，传感器时间戳抖动为 `T_jitter`，主预测周期为 `T_s`，则历史槽深至少满足  `N_hist >= ceil((T_delay_max + T_jitter) / T_s) + 1`。  这是 RAM 预算，不是拍脑袋常量。
- **时间量化误差也会进入滤波闭环**：如果 IMU 以 `1 kHz` 运行，而你只用 `1 ms` 粒度时间戳，那么一笔视觉观测落点误差就可能有 `±0.5 ms`。在快系统里，这部分误差会直接变成额外相位延迟。时间戳分辨率本身就是测量链的一部分。
- **离散预测方程必须跟真实采样周期绑定，而不是假设 `dt` 永远恒定**：对 2 状态姿态模型 `x = [theta, b]^T`，有  \n  `theta[k+1] = theta[k] + dt * (omega_gyro[k] - b[k])`  \n  `b[k+1] = b[k]`。  \n  一旦 `dt` 抖动，你的 `F(dt)` 和 `Q(dt)` 也必须跟着变，否则协方差在数值上就已经和物理时基脱节。
- **连续噪声离散化是延迟回放能否保持一致的关键**：若角状态噪声功率谱密度为 `q_theta`，零偏随机游走功率谱密度为 `q_bias`，则离散过程噪声可近似写成  \n  `Q_d = [[q_theta * dt + q_bias * dt^3 / 3, -q_bias * dt^2 / 2], [-q_bias * dt^2 / 2, q_bias * dt]]`。  \n  回放时如果只重算状态，不重算 `Q_d`，协方差就和重建后的轨迹不匹配。
- **Joseph Form 不是书本洁癖，而是 MCU 上避免协方差失真最稳妥的写法**：更新时直接用 `(I - KH)P` 很容易在单精度下把 `P` 算得非对称甚至非正定。Joseph Form  \n  `P = (I - KH) P (I - KH)^T + K R K^T`  \n  更费几次乘法，但能换来数值稳定。
- **延迟观测落点必须有门控，否则“过去的坏数据”会污染整段未来**：一笔明显异常的旧观测，一旦被写进历史槽位，再经过回放，会把后面整条状态轨迹一并拖偏。工程上通常先检查  \n  `NIS = y^2 / S`，  \n  若 `NIS` 超过门限，就在历史入口直接拒绝。
- **延迟补偿不等于无限追忆**：如果观测比历史窗口还老，它已经不再属于“可修复过去”，而是“系统没有资源再管这段过去”。成熟系统会明确丢弃过老观测，而不是悄悄把它塞进当前状态。
- **技术哲学上，卡尔曼滤波从来不是在求一个“最准确的现在”，而是在维护一条“过去如何影响现在”的因果账本**：观测、输入、时间戳、缓存长度和算力预算，决定的不是某个 API 调用了几次，而是系统是否仍然尊重物理时间的顺序。

## 代码能力展现

下面给出一个基于 **STM32 HAL** 的固定滞后姿态融合示例。场景假设如下：

- `TIM2` 已配置为 **1 MHz、32 位自由运行计数器**，作为全局微秒时基。
- IMU 侧陀螺以 `1 kHz` 中断上报角速度 `gyro_rad_s`。
- 视觉模块输出的是 **曝光中点对应的姿态角**，并已通过上层时钟同步转换到 MCU 的本地微秒时间轴。
- 视觉帧可能晚到 `10 ms ~ 40 ms`，因此必须落到历史槽位更新，再回放到当前时刻。

代码重点不在“再写一遍 Kalman 公式”，而在把 **历史槽管理**、**变量 `dt` 预测**、**延迟观测落点**、**Joseph 更新** 和 **回放重建** 连成一条闭环。

```c
#include "main.h"

#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#define KF_HISTORY_LEN                        64U
#define KF_DT_MIN_S                           0.0005f
#define KF_DT_MAX_S                           0.0200f
#define KF_MEAS_VAR_MIN_RAD2                  1.0e-6f
#define KF_MEAS_VAR_MAX_RAD2                  0.2500f
#define KF_GATE_SIGMA_MIN                     2.0f
#define KF_GATE_SIGMA_MAX                     6.0f
#define KF_ANGLE_LIMIT_RAD                    1.3962634f   /* 约 80 deg。 */
#define KF_BIAS_LIMIT_RAD_S                   1.5707963f   /* 约 90 deg/s。 */
#define KF_TIMESTAMP_TOLERANCE_US             2000U
#define KF_MICROSECONDS_PER_SECOND            1000000.0f

typedef struct
{
    float theta_rad;
    float bias_rad_s;
    float p00;
    float p01;
    float p10;
    float p11;
} Kf2State_t;

typedef struct
{
    uint32_t timestamp_us;        /* 该槽位后验状态所属时刻。 */
    float dt_from_prev_s;         /* 从前一槽推进到本槽的 dt。 */
    float gyro_from_prev_rad_s;   /* 该推进区间内使用的角速度输入。 */
    Kf2State_t state;
    bool valid;
} KfHistorySlot_t;

typedef struct
{
    KfHistorySlot_t slots[KF_HISTORY_LEN];
    uint16_t head;                /* 最新槽位。 */
    uint16_t size;                /* 有效槽位个数。 */
    float q_theta_psd;
    float q_bias_psd;
    float gate_sigma;
} DelayedAngleKalman_t;

typedef struct
{
    int16_t angle_mdeg;           /* 视觉估计角度，单位 0.001 deg。 */
    uint16_t quality_permille;    /* 0~1000，越大代表观测越可信。 */
    uint32_t capture_timestamp_us;/* 曝光中点时间戳，已在 MCU 本地时间轴上。 */
} VisionAnglePacket_t;

extern TIM_HandleTypeDef htim2;

static DelayedAngleKalman_t g_delayed_kf;

static float Kf_ClampF(float value, float min_value, float max_value)
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

static float Kf_WrapPmPi(float angle_rad)
{
    const float pi = 3.14159265359f;
    const float two_pi = 6.28318530718f;

    while (angle_rad > pi)
    {
        angle_rad -= two_pi;
    }

    while (angle_rad <= -pi)
    {
        angle_rad += two_pi;
    }

    return angle_rad;
}

static uint16_t Kf_GetOldestIndex(const DelayedAngleKalman_t *kf)
{
    return (uint16_t)((kf->head + KF_HISTORY_LEN - (kf->size - 1U)) % KF_HISTORY_LEN);
}

static uint32_t Kf_AbsDiffU32(uint32_t a, uint32_t b)
{
    return (a > b) ? (a - b) : (b - a);
}

static uint32_t Fusion_GetTimestampUs(void)
{
    /*
     * TIM2 以 1 MHz 自由运行，因此计数值可直接视为微秒时间戳。
     * 32 位无符号减法天然支持回绕，只要单次 dt 不跨越整个回绕周期即可。
     */
    return __HAL_TIM_GET_COUNTER(&htim2);
}

static float Fusion_DeltaTimeSeconds(uint32_t newer_us, uint32_t older_us)
{
    const uint32_t delta_us = newer_us - older_us;
    const float dt_s = (float)delta_us / KF_MICROSECONDS_PER_SECOND;

    return Kf_ClampF(dt_s, KF_DT_MIN_S, KF_DT_MAX_S);
}

/**
 * @brief 根据陀螺角速度推进 2 状态姿态模型。
 * @param state 需要原地更新的状态与协方差。
 * @param gyro_rad_s 当前区间平均角速度，单位 rad/s。
 * @param dt_s 本次预测步长，单位 s。
 * @param q_theta_psd 角状态等效连续噪声功率谱密度，单位 rad^2/s。
 * @param q_bias_psd 零偏随机游走连续噪声功率谱密度，单位 (rad/s)^2/s。
 *
 * @note 状态向量定义为 x = [theta, bias]^T。
 *       连续到离散后的预测关系近似为：
 *       theta[k+1] = theta[k] + dt * (gyro[k] - bias[k])
 *       bias[k+1]  = bias[k]
 *
 *       F(dt) = [[1, -dt],
 *                [0,  1 ]]
 *
 *       Qd(dt) = [[q_theta * dt + q_bias * dt^3 / 3, -q_bias * dt^2 / 2],
 *                 [-q_bias * dt^2 / 2,               q_bias * dt]]
 */
static void Kf_Predict(Kf2State_t *state,
                       float gyro_rad_s,
                       float dt_s,
                       float q_theta_psd,
                       float q_bias_psd)
{
    const float dt = Kf_ClampF(dt_s, KF_DT_MIN_S, KF_DT_MAX_S);
    const float dt2 = dt * dt;
    const float dt3 = dt2 * dt;

    const float f00 = 1.0f;
    const float f01 = -dt;
    const float f10 = 0.0f;
    const float f11 = 1.0f;

    const float q00 = q_theta_psd * dt + q_bias_psd * dt3 / 3.0f;
    const float q01 = -q_bias_psd * dt2 * 0.5f;
    const float q10 = q01;
    const float q11 = q_bias_psd * dt;

    float p00_new;
    float p01_new;
    float p10_new;
    float p11_new;

    if (state == NULL)
    {
        return;
    }

    state->theta_rad += dt * (gyro_rad_s - state->bias_rad_s);
    state->theta_rad = Kf_ClampF(Kf_WrapPmPi(state->theta_rad), -KF_ANGLE_LIMIT_RAD, KF_ANGLE_LIMIT_RAD);
    state->bias_rad_s = Kf_ClampF(state->bias_rad_s, -KF_BIAS_LIMIT_RAD_S, KF_BIAS_LIMIT_RAD_S);

    /*
     * P' = F * P * F^T + Q
     * 对 2x2 系统手工展开，避免 MCU 上的通用矩阵开销。
     */
    p00_new = f00 * (state->p00 * f00 + state->p01 * f01) +
              f01 * (state->p10 * f00 + state->p11 * f01) + q00;
    p01_new = f00 * (state->p00 * f10 + state->p01 * f11) +
              f01 * (state->p10 * f10 + state->p11 * f11) + q01;
    p10_new = f10 * (state->p00 * f00 + state->p01 * f01) +
              f11 * (state->p10 * f00 + state->p11 * f01) + q10;
    p11_new = f10 * (state->p00 * f10 + state->p01 * f11) +
              f11 * (state->p10 * f10 + state->p11 * f11) + q11;

    state->p00 = Kf_ClampF(p00_new, 1.0e-8f, 10.0f);
    state->p01 = p01_new;
    state->p10 = p10_new;
    state->p11 = Kf_ClampF(p11_new, 1.0e-10f, 1.0f);
}

/**
 * @brief 用角度观测更新指定状态，并执行 NIS 门控。
 * @param state 需要原地更新的状态与协方差。
 * @param angle_meas_rad 观测角度，单位 rad。
 * @param meas_var_rad2 观测方差，单位 rad^2。
 * @param gate_sigma 创新门限的 sigma 倍数。
 * @return `true` 表示观测被接受，`false` 表示被门控拒绝。
 *
 * @note 观测模型为 z = Hx + v，其中 H = [1 0]。
 *       创新 y = wrap(z - theta_pred)
 *       S = HPH^T + R = p00 + R
 *       K = [p00 / S, p10 / S]^T
 *
 *       协方差更新采用 Joseph Form：
 *       P = (I - KH) P (I - KH)^T + K R K^T
 *       它比直接计算 (I - KH)P 更抗单精度舍入误差。
 */
static bool Kf_UpdateAngleJoseph(Kf2State_t *state,
                                 float angle_meas_rad,
                                 float meas_var_rad2,
                                 float gate_sigma)
{
    float r;
    float sigma;
    float y;
    float s;
    float gate2;
    float k0;
    float k1;

    float i_kh_00;
    float i_kh_01;
    float i_kh_10;
    float i_kh_11;

    float a00;
    float a01;
    float a10;
    float a11;

    float p00_new;
    float p01_new;
    float p10_new;
    float p11_new;

    if (state == NULL)
    {
        return false;
    }

    r = Kf_ClampF(meas_var_rad2, KF_MEAS_VAR_MIN_RAD2, KF_MEAS_VAR_MAX_RAD2);
    sigma = Kf_ClampF(gate_sigma, KF_GATE_SIGMA_MIN, KF_GATE_SIGMA_MAX);
    y = Kf_WrapPmPi(angle_meas_rad - state->theta_rad);
    s = state->p00 + r;
    gate2 = sigma * sigma * s;
    k0 = state->p00 / s;
    k1 = state->p10 / s;

    if ((y * y) > gate2)
    {
        return false;
    }

    state->theta_rad += k0 * y;
    state->bias_rad_s += k1 * y;

    state->theta_rad = Kf_ClampF(Kf_WrapPmPi(state->theta_rad), -KF_ANGLE_LIMIT_RAD, KF_ANGLE_LIMIT_RAD);
    state->bias_rad_s = Kf_ClampF(state->bias_rad_s, -KF_BIAS_LIMIT_RAD_S, KF_BIAS_LIMIT_RAD_S);

    i_kh_00 = 1.0f - k0;
    i_kh_01 = 0.0f;
    i_kh_10 = -k1;
    i_kh_11 = 1.0f;

    a00 = i_kh_00 * state->p00 + i_kh_01 * state->p10;
    a01 = i_kh_00 * state->p01 + i_kh_01 * state->p11;
    a10 = i_kh_10 * state->p00 + i_kh_11 * state->p10;
    a11 = i_kh_10 * state->p01 + i_kh_11 * state->p11;

    p00_new = a00 * i_kh_00 + a01 * i_kh_01 + k0 * r * k0;
    p01_new = a00 * i_kh_10 + a01 * i_kh_11 + k0 * r * k1;
    p10_new = a10 * i_kh_00 + a11 * i_kh_01 + k1 * r * k0;
    p11_new = a10 * i_kh_10 + a11 * i_kh_11 + k1 * r * k1;

    state->p00 = Kf_ClampF(p00_new, 1.0e-8f, 10.0f);
    state->p01 = p01_new;
    state->p10 = p10_new;
    state->p11 = Kf_ClampF(p11_new, 1.0e-10f, 1.0f);

    return true;
}

/**
 * @brief 重置固定滞后滤波器历史。
 * @param kf 滤波器实例。
 * @param init_timestamp_us 初始时刻。
 * @param init_angle_rad 初始姿态角，单位 rad。
 */
static void DelayedKf_Reset(DelayedAngleKalman_t *kf,
                            uint32_t init_timestamp_us,
                            float init_angle_rad)
{
    if (kf == NULL)
    {
        return;
    }

    memset(kf, 0, sizeof(*kf));

    kf->q_theta_psd = 2.0e-3f;
    kf->q_bias_psd = 5.0e-5f;
    kf->gate_sigma = 3.5f;
    kf->head = 0U;
    kf->size = 1U;

    kf->slots[0].timestamp_us = init_timestamp_us;
    kf->slots[0].dt_from_prev_s = 0.0f;
    kf->slots[0].gyro_from_prev_rad_s = 0.0f;
    kf->slots[0].state.theta_rad = Kf_ClampF(init_angle_rad, -KF_ANGLE_LIMIT_RAD, KF_ANGLE_LIMIT_RAD);
    kf->slots[0].state.bias_rad_s = 0.0f;
    kf->slots[0].state.p00 = 0.02f;
    kf->slots[0].state.p01 = 0.0f;
    kf->slots[0].state.p10 = 0.0f;
    kf->slots[0].state.p11 = 0.001f;
    kf->slots[0].valid = true;
}

/**
 * @brief 记录一笔新的陀螺预测，并把后验状态写入历史环形缓冲。
 * @param kf 滤波器实例。
 * @param timestamp_us 当前样本时刻，单位 us。
 * @param gyro_rad_s 当前预测区间角速度，单位 rad/s。
 * @return `true` 表示推进成功。
 *
 * @note 若最大观测延迟为 `T_delay_max`，主循环周期为 `T_s`，则历史槽深至少满足：
 *       N_hist >= ceil(T_delay_max / T_s) + 1
 *       否则延迟观测还未到达，最老状态就已经被覆盖。
 */
static bool DelayedKf_PredictAndPush(DelayedAngleKalman_t *kf,
                                     uint32_t timestamp_us,
                                     float gyro_rad_s)
{
    uint16_t new_head;
    KfHistorySlot_t *slot_new;
    const KfHistorySlot_t *slot_old;
    float dt_s;

    if ((kf == NULL) || (kf->size == 0U))
    {
        return false;
    }

    slot_old = &kf->slots[kf->head];
    dt_s = Fusion_DeltaTimeSeconds(timestamp_us, slot_old->timestamp_us);

    new_head = (uint16_t)((kf->head + 1U) % KF_HISTORY_LEN);
    slot_new = &kf->slots[new_head];

    *slot_new = *slot_old;
    slot_new->timestamp_us = timestamp_us;
    slot_new->dt_from_prev_s = dt_s;
    slot_new->gyro_from_prev_rad_s = gyro_rad_s;
    slot_new->valid = true;

    Kf_Predict(&slot_new->state, gyro_rad_s, dt_s, kf->q_theta_psd, kf->q_bias_psd);

    kf->head = new_head;
    if (kf->size < KF_HISTORY_LEN)
    {
        ++kf->size;
    }

    return true;
}

/**
 * @brief 在历史槽中查找与观测时间最接近的状态落点。
 * @param kf 滤波器实例。
 * @param timestamp_us 观测发生时刻，单位 us。
 * @return 槽位索引，失败返回 -1。
 *
 * @note IMU 采样是离散的，因此观测时间一般不会与槽位完全重合。
 *       这里选用最近槽位，要求量化误差不超过 `KF_TIMESTAMP_TOLERANCE_US`。
 */
static int16_t DelayedKf_FindNearestSlot(const DelayedAngleKalman_t *kf, uint32_t timestamp_us)
{
    uint16_t idx;
    uint16_t oldest;
    uint16_t count;
    uint32_t best_diff = 0xFFFFFFFFUL;
    int16_t best_index = -1;

    if ((kf == NULL) || (kf->size == 0U))
    {
        return -1;
    }

    oldest = Kf_GetOldestIndex(kf);
    idx = oldest;

    for (count = 0U; count < kf->size; ++count)
    {
        const KfHistorySlot_t *slot = &kf->slots[idx];
        const uint32_t diff = Kf_AbsDiffU32(slot->timestamp_us, timestamp_us);

        if (slot->valid && (diff < best_diff))
        {
            best_diff = diff;
            best_index = (int16_t)idx;
        }

        idx = (uint16_t)((idx + 1U) % KF_HISTORY_LEN);
    }

    if (best_diff > KF_TIMESTAMP_TOLERANCE_US)
    {
        return -1;
    }

    return best_index;
}

/**
 * @brief 从指定历史槽位起，按原始陀螺输入重放到当前时刻。
 * @param kf 滤波器实例。
 * @param start_index 起始槽位索引；该槽位视为已拥有最新后验状态。
 */
static void DelayedKf_ReplayFrom(DelayedAngleKalman_t *kf, uint16_t start_index)
{
    uint16_t current = start_index;

    if ((kf == NULL) || (kf->size == 0U))
    {
        return;
    }

    while (current != kf->head)
    {
        const uint16_t next = (uint16_t)((current + 1U) % KF_HISTORY_LEN);
        KfHistorySlot_t *slot_prev = &kf->slots[current];
        KfHistorySlot_t *slot_next = &kf->slots[next];

        slot_next->state = slot_prev->state;
        Kf_Predict(&slot_next->state,
                   slot_next->gyro_from_prev_rad_s,
                   slot_next->dt_from_prev_s,
                   kf->q_theta_psd,
                   kf->q_bias_psd);

        current = next;
    }
}

/**
 * @brief 将延迟到达的角度观测写入历史槽位，并回放到当前时刻。
 * @param kf 滤波器实例。
 * @param meas_timestamp_us 观测实际发生时刻，单位 us。
 * @param angle_meas_rad 观测角度，单位 rad。
 * @param meas_var_rad2 观测方差，单位 rad^2。
 * @return `true` 表示观测被接受并完成回放。
 */
static bool DelayedKf_ApplyDelayedMeasurement(DelayedAngleKalman_t *kf,
                                              uint32_t meas_timestamp_us,
                                              float angle_meas_rad,
                                              float meas_var_rad2)
{
    const int16_t slot_index = DelayedKf_FindNearestSlot(kf, meas_timestamp_us);

    if (slot_index < 0)
    {
        /*
         * 观测已经老到超出固定滞后窗口，或者时间戳量化误差过大。
         * 这种数据再强行写入，只会制造伪补偿。
         */
        return false;
    }

    if (!Kf_UpdateAngleJoseph(&kf->slots[slot_index].state,
                              angle_meas_rad,
                              meas_var_rad2,
                              kf->gate_sigma))
    {
        return false;
    }

    DelayedKf_ReplayFrom(kf, (uint16_t)slot_index);
    return true;
}

/**
 * @brief 根据视觉质量分数生成角度观测方差。
 * @param quality_permille 0~1000，越大代表越可信。
 * @return 角度观测方差，单位 rad^2。
 *
 * @note 这里使用线性映射做工程近似：
 *       R(q) = R_max - (q / 1000) * (R_max - R_min)
 *       质量越高，观测方差越小，但始终保留测量噪声下界。
 */
static float Vision_QualityToVarianceRad2(uint16_t quality_permille)
{
    const float quality = Kf_ClampF((float)quality_permille, 0.0f, 1000.0f);
    const float r_min = 2.0e-4f;
    const float r_max = 2.5e-2f;

    return r_max - (quality / 1000.0f) * (r_max - r_min);
}

/**
 * @brief 初始化姿态融合器。
 * @param initial_angle_rad 初始姿态角，单位 rad。
 */
void AttitudeFusion_Init(float initial_angle_rad)
{
    HAL_TIM_Base_Start(&htim2);
    DelayedKf_Reset(&g_delayed_kf, Fusion_GetTimestampUs(), initial_angle_rad);
}

/**
 * @brief 在 IMU 中断中推进当前姿态状态。
 * @param gyro_rad_s 本周期角速度，单位 rad/s。
 *
 * @note 该函数应由固定频率 IMU 中断或 DMA 完整回调调用。
 *       每次都用真实时间戳计算 dt，避免把调度抖动隐藏进模型误差。
 */
void AttitudeFusion_OnImuGyro(float gyro_rad_s)
{
    (void)DelayedKf_PredictAndPush(&g_delayed_kf, Fusion_GetTimestampUs(), gyro_rad_s);
}

/**
 * @brief 处理一帧带延迟时间戳的视觉姿态观测。
 * @param packet 视觉模块回传的数据包。
 * @return `true` 表示延迟观测已被接纳。
 *
 * @note `capture_timestamp_us` 必须对应曝光中点，而不是 UART 收包完成时刻。
 *       如果拿到的是 `t_rx_done`，则至少应先减去固定流水线延迟：
 *       t_capture ~= t_rx_done - t_pipeline
 */
bool AttitudeFusion_OnVisionPacket(const VisionAnglePacket_t *packet)
{
    float angle_rad;
    float meas_var_rad2;

    if (packet == NULL)
    {
        return false;
    }

    angle_rad = ((float)packet->angle_mdeg) * 0.001f * 0.01745329252f;
    meas_var_rad2 = Vision_QualityToVarianceRad2(packet->quality_permille);

    return DelayedKf_ApplyDelayedMeasurement(&g_delayed_kf,
                                             packet->capture_timestamp_us,
                                             angle_rad,
                                             meas_var_rad2);
}

/**
 * @brief 读取当前时刻的最新姿态估计。
 * @return 最新头槽位中的后验姿态角，单位 rad。
 */
float AttitudeFusion_GetAngleRad(void)
{
    if (g_delayed_kf.size == 0U)
    {
        return 0.0f;
    }

    return g_delayed_kf.slots[g_delayed_kf.head].state.theta_rad;
}
```

这段实现有几个工程重点值得单独强调：

- 视觉观测并没有直接更新“当前头槽位”，而是先按 `capture_timestamp_us` 找历史落点，再沿着保存好的 `gyro_from_prev_rad_s` 和 `dt_from_prev_s` 回放到现在。
- 历史槽长度 `KF_HISTORY_LEN = 64` 对 `1 kHz` 预测链路意味着大约 `64 ms` 固定滞后窗；若现场视觉最坏延迟可能到 `80 ms`，这段代码必须先扩槽，否则任何补偿都是伪命题。
- `Fusion_DeltaTimeSeconds()` 直接使用硬件时间戳求 `dt`，而不是假设中断永远精确等周期；这能把调度抖动显式带进 `F(dt)` 和 `Q(dt)`。
- `Kf_UpdateAngleJoseph()` 用 Joseph Form 更新协方差，并用 `y^2 <= sigma^2 * S` 做门控，避免一笔错误的旧观测在回放后污染整条未来轨迹。
- `Vision_QualityToVarianceRad2()` 把算法侧“质量分数”映射成滤波侧 `R`，建立了从视觉置信度到概率权重的明确桥梁，而不是写死一个神秘常量。

如果再往前走一步，这套骨架还可以扩展到：

- 在历史槽里同时保存加速度计观测、编码器观测或里程计观测，形成多源回放。
- 把最近 `N` 个槽位做固定滞后平滑，而不是只做滤波重放。
- 将 `DelayedKf_FindNearestSlot()` 升级为插值落点，用 `t_m` 在两帧 IMU 之间插值 `theta` 和 `bias`，进一步减小时间量化误差。

但无论怎样扩展，底层原则都不会变：**观测属于哪个时刻，就修正哪个时刻；修正了过去，就诚实地重建未来。**
