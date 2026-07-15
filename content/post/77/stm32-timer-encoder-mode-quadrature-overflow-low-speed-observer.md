---
title: "技能档案：STM32 定时器编码器模式、四倍频计数与低速速度观测"
slug: "skill-stm32-timer-encoder-mode-quadrature-overflow-low-speed-observer"
date: 2026-06-30T23:42:00+08:00
draft: false
description: "从正交编码器 A/B 相、定时器四倍频计数、环形差分溢出扩展到低速速度观测与反向抖动拒绝，系统拆解 STM32 编码器模式为什么不是简单读 CNT。"
tags: ["STM32", "定时器", "编码器模式", "正交编码器", "测速", "嵌入式"]
categories: ["技能档案", "控制与融合"]
image: ""
---

## 技能概述

`STM32` 的定时器编码器模式经常被简化成一句话：把 `TIMx` 配成 `Encoder Interface`，然后定时读取 `CNT`。这句话能让轮子转起来，却不足以让控制系统长期可信。真正的问题不在于计数器会不会加减，而在于**正交 A/B 相如何把机械位移折叠成四倍频脉冲、`CNT` 环形回绕后如何恢复有符号位移、低速时为什么速度估计会被量化和齿隙支配、反向抖动又为什么会把方向位翻来覆去地污染控制环**。

这个主题解决的不是 CubeMX 里选哪个模式，而是把编码器模式看成一条完整的测量链：物理轴角度进入 A/B 相边沿，定时器硬件做相位判向和计数，软件在固定采样点读取环形计数器，再把有限位宽的计数差扩展为连续位置、速度和可信度。只有这条链路被显式建模，`PID`、里程计、速度环和故障诊断拿到的才不是一个偶然正确的 `CNT`，而是一份带时间语义的运动观测。

## 核心底层概念解析

- **正交编码器输出的不是“速度”，而是带方向的边沿序列**：A/B 两相信号相差约 `90 deg` 电角度。若 A 领先 B，计数器按一个方向累加；若 B 领先 A，计数器反向递减。硬件真正识别的是 Gray-like 状态迁移：`00 -> 01 -> 11 -> 10 -> 00` 或反向序列，而不是某一根线的高低电平。

- **四倍频计数把一线脉冲数变成了控制域里的计数分辨率**：若编码器标称为 `N_line` 线，定时器在 A/B 两相的上升沿和下降沿都计数，则每机械圈得到  
  `counts_per_rev = 4 * N_line * gear_ratio`。  
  这意味着软件里所有位置、速度和阈值都必须用 `counts_per_rev` 归一化。把 `N_line` 当成一圈计数，会让速度和位移全部差 `4` 倍。

- **`CNT` 是环形寄存器，不是连续位置**：16 位定时器的 `CNT` 从 `65535` 再加一会回到 `0`，从 `0` 再减一会回到 `65535`。因此连续位置不能直接等于 `CNT`，而应由固定采样间隔里的有符号差分累加得到：  
  `position[k] = position[k-1] + wrap_delta(CNT[k], CNT[k-1])`。

- **环形差分成立的前提，是单个采样周期内位移不能跨过半圈计数空间**：对 16 位全周期计数器，`delta = (int16_t)(now - last)` 可以自然把回绕解释成正负位移，但它只在 `|delta| < 32768` 时唯一。采样周期、最高转速和 `counts_per_rev` 必须共同满足这个边界，否则软件无法区分“真的高速正转”和“反向跨过回绕点”。

- **方向位 `DIR` 适合诊断，不适合替代差分**：`TIMx->CR1` 里的方向位反映的是硬件当前计数方向，但在低速、停转、齿隙回摆和毛刺边沿下，它可能频繁翻转。速度估计应来自有时间边界的 `delta / dt`，方向判断也应从有效差分中派生；直接把 `DIR` 当速度符号，会把静止抖动放大成方向抖动。

- **编码器模式和输入捕获测速的误差结构不同**：输入捕获测的是相邻边沿间隔，适合慢速高分辨；编码器模式在固定控制周期里读累计位移，天然适合位置环和里程计。它的速度估计满足  
  `rpm = 60 * delta_counts / (counts_per_rev * dt)`。  
  当低速下 `delta_counts` 经常是 `0` 或 `1` 时，速度就会呈现台阶，低通滤波只能缓和，不能凭空创造分辨率。

- **低速速度观测的关键不是“更灵敏”，而是承认量化边界**：若 `counts_per_rev = 4096`，采样周期 `dt = 1 ms`，一个计数对应的速度台阶就是  
  `60 / (4096 * 0.001) ~= 14.65 rpm`。  
  对低速云台、轮式里程计或手轮输入来说，这个台阶已经很大。要么延长速度观测窗口，要么融合边沿周期法，要么在控制律里把低速区当成带死区的离散观测。

- **机械齿隙会把方向反转变成一串真假交错的计数**：减速箱、联轴器和轮胎接触面都有弹性与间隙。指令刚反向时，编码器可能先记录几下回弹，再进入真实反向运动。若每一个 `+1/-1` 都立刻喂给速度环，控制器会追着机械间隙打。软件需要最小有效位移、方向确认窗口和速度死区，而不是盲目追求“每个脉冲都响应”。

- **输入数字滤波是在相位延迟和毛刺拒绝之间交易**：定时器的 `ICxF` 会要求输入在多个采样点保持稳定后才认定边沿有效。滤波越强，窄毛刺越难进计数器，但有效边沿也会被延后。对纯位置计数，这种延迟通常可接受；对高速速度估计和相位同步，它会变成可见的滞后。

- **Z 相索引不是速度信号，而是绝对零位校验点**：很多增量式编码器提供 `Z` 相，每圈一个脉冲。它适合在上电寻零、长时间积分漂移校验或齿轮比验证时使用，但不应在任意时刻粗暴清零位置。正确做法是只在系统处于已知寻零状态、速度低于阈值且 A/B 状态合法时接受索引。

- **采样一致性比单次读取更重要**：如果控制环在读 `CNT` 的同时又读了一批旧的电流、电压或姿态数据，位置和执行器状态就不在同一个时间切面上。编码器观测最好在固定控制节拍中封存为快照，让上层只读同一批次的 `position/rpm/valid/timestamp`。

- **异常跳变必须被显式拒绝，而不是让滤波器背锅**：若单周期 `delta_counts` 超过了由机械最高转速推导出的上限，它更可能来自线缆干扰、计数器重配、采样周期丢失或电源噪声。低通滤波会把异常稀释成一段长尾错误；边界检查则能把它直接标成无效样本。

- **技术哲学上，编码器模式不是“读一个递增数”，而是在维护一条有限位宽计数器到连续机械状态的映射**：硬件负责不丢边沿，软件负责给边沿安排时间、方向、可信度和物理尺度。少掉任何一层，`CNT` 都只是一个看似稳定的寄存器数字。

## 代码能力展现

下面给出一段基于 **STM32 HAL** 的编码器观测模块。它刻意保持简单：定时器使用 16 位全周期 `ARR = 0xFFFF`，控制任务以固定周期调用 `EncoderObserver_Update()`，模块只做四件事：

- 用 `int16_t` 环形差分把 `CNT` 回绕恢复成有符号位移；
- 累加得到 `int64_t` 连续位置，避免长时间运行后溢出；
- 根据 `delta_counts / dt` 计算原始速度，并用一阶滤波输出控制友好的 `rpm_filtered`；
- 对不可能跳变、低速反向抖动和零速超时给出显式状态。

```c
#include "stm32f4xx_hal.h"

#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#define ENCODER_OBSERVER_COUNTER_MAX        0xFFFFU
#define ENCODER_OBSERVER_COUNTER_SPAN       65536U
#define ENCODER_OBSERVER_MIN_CPR            1U
#define ENCODER_OBSERVER_MAX_ALPHA          1.0f
#define ENCODER_OBSERVER_MIN_ALPHA          0.0f

typedef struct
{
    TIM_HandleTypeDef *htim;
    uint32_t counts_per_rev;          /* 四倍频后的每机械圈计数。 */
    float sample_period_s;            /* 固定调用周期，必须由外部控制节拍保证。 */
    float filter_alpha;               /* 速度一阶滤波系数，0 表示冻结，1 表示不过滤。 */
    uint16_t jitter_counts;           /* 低速抖动死区，通常为 0~2 个计数。 */
    uint16_t max_counts_per_sample;   /* 单周期物理可达最大位移，用于拒绝异常跳变。 */
    uint16_t zero_timeout_samples;    /* 连续无有效位移多少次后确认零速。 */
} EncoderObserverConfig_t;

typedef struct
{
    int64_t position_counts;          /* 连续位置，单位为编码器计数。 */
    float position_rev;               /* 连续位置，单位为机械圈。 */
    float rpm_raw;                    /* 本周期差分得到的原始速度。 */
    float rpm_filtered;               /* 滤波后的速度。 */
    int32_t delta_counts;             /* 本周期有效位移。 */
    uint16_t counter_raw;             /* 本次采样时的硬件 CNT。 */
    uint8_t direction;                /* 0 停止，1 正向，2 反向。 */
    uint8_t valid;                    /* 1 表示本次样本可信。 */
    uint8_t stopped;                  /* 1 表示已进入零速确认态。 */
    uint32_t sample_index;            /* 样本序号，便于上层做时间对齐。 */
    uint32_t rejected_jumps;          /* 被物理边界拒绝的异常跳变次数。 */
} EncoderObserverSnapshot_t;

typedef struct
{
    EncoderObserverConfig_t cfg;
    EncoderObserverSnapshot_t snapshot;
    uint16_t last_counter;
    uint16_t no_motion_samples;
    uint8_t initialized;
} EncoderObserver_t;

static float EncoderObserver_ClampFloat(float value, float min_value, float max_value)
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

static uint8_t EncoderObserver_ConfigValid(const EncoderObserverConfig_t *cfg)
{
    if (cfg == NULL || cfg->htim == NULL)
    {
        return 0U;
    }

    if (cfg->counts_per_rev < ENCODER_OBSERVER_MIN_CPR)
    {
        return 0U;
    }

    if (cfg->sample_period_s <= 0.0f)
    {
        return 0U;
    }

    if (cfg->max_counts_per_sample == 0U ||
        cfg->max_counts_per_sample >= (ENCODER_OBSERVER_COUNTER_SPAN / 2U))
    {
        return 0U;
    }

    return 1U;
}

static int32_t EncoderObserver_WrapDelta16(uint16_t now, uint16_t last)
{
    return (int32_t)((int16_t)(uint16_t)(now - last));
}

static uint8_t EncoderObserver_AbsDeltaTooLarge(int32_t delta, uint16_t max_counts)
{
    if (delta < 0)
    {
        delta = -delta;
    }

    return ((uint32_t)delta > (uint32_t)max_counts) ? 1U : 0U;
}

uint8_t EncoderObserver_Init(EncoderObserver_t *observer,
                             const EncoderObserverConfig_t *config)
{
    if (observer == NULL || EncoderObserver_ConfigValid(config) == 0U)
    {
        return 0U;
    }

    memset(observer, 0, sizeof(*observer));
    observer->cfg = *config;
    observer->cfg.filter_alpha = EncoderObserver_ClampFloat(config->filter_alpha,
                                                            ENCODER_OBSERVER_MIN_ALPHA,
                                                            ENCODER_OBSERVER_MAX_ALPHA);

    __HAL_TIM_SET_AUTORELOAD(observer->cfg.htim, ENCODER_OBSERVER_COUNTER_MAX);
    __HAL_TIM_SET_COUNTER(observer->cfg.htim, 0U);

    observer->last_counter = 0U;
    observer->initialized = 1U;

    return 1U;
}

uint8_t EncoderObserver_Start(EncoderObserver_t *observer)
{
    if (observer == NULL || observer->initialized == 0U)
    {
        return 0U;
    }

    __HAL_TIM_SET_COUNTER(observer->cfg.htim, 0U);
    observer->last_counter = 0U;
    observer->snapshot.counter_raw = 0U;

    if (HAL_TIM_Encoder_Start(observer->cfg.htim, TIM_CHANNEL_ALL) != HAL_OK)
    {
        return 0U;
    }

    return 1U;
}

void EncoderObserver_ResetPosition(EncoderObserver_t *observer, int64_t position_counts)
{
    if (observer == NULL || observer->initialized == 0U)
    {
        return;
    }

    observer->snapshot.position_counts = position_counts;
    observer->snapshot.position_rev = (float)position_counts /
                                      (float)observer->cfg.counts_per_rev;
}

uint8_t EncoderObserver_Update(EncoderObserver_t *observer)
{
    uint16_t now;
    int32_t delta;
    uint32_t abs_delta;
    float rpm;

    if (observer == NULL || observer->initialized == 0U)
    {
        return 0U;
    }

    now = (uint16_t)__HAL_TIM_GET_COUNTER(observer->cfg.htim);
    delta = EncoderObserver_WrapDelta16(now, observer->last_counter);
    observer->last_counter = now;

    observer->snapshot.sample_index++;
    observer->snapshot.counter_raw = now;
    observer->snapshot.valid = 1U;
    observer->snapshot.stopped = 0U;

    if (EncoderObserver_AbsDeltaTooLarge(delta,
                                         observer->cfg.max_counts_per_sample) != 0U)
    {
        observer->snapshot.valid = 0U;
        observer->snapshot.delta_counts = 0;
        observer->snapshot.rpm_raw = 0.0f;
        observer->snapshot.rejected_jumps++;
        return 0U;
    }

    abs_delta = (delta < 0) ? (uint32_t)(-delta) : (uint32_t)delta;

    if (abs_delta <= observer->cfg.jitter_counts)
    {
        delta = 0;

        if (observer->no_motion_samples < UINT16_MAX)
        {
            observer->no_motion_samples++;
        }
    }
    else
    {
        observer->no_motion_samples = 0U;
    }

    observer->snapshot.position_counts += (int64_t)delta;
    observer->snapshot.position_rev = (float)observer->snapshot.position_counts /
                                      (float)observer->cfg.counts_per_rev;

    rpm = (60.0f * (float)delta) /
          ((float)observer->cfg.counts_per_rev * observer->cfg.sample_period_s);

    observer->snapshot.rpm_raw = rpm;
    observer->snapshot.rpm_filtered += observer->cfg.filter_alpha *
                                       (rpm - observer->snapshot.rpm_filtered);
    observer->snapshot.delta_counts = delta;

    if (delta > 0)
    {
        observer->snapshot.direction = 1U;
    }
    else if (delta < 0)
    {
        observer->snapshot.direction = 2U;
    }
    else if (observer->no_motion_samples >= observer->cfg.zero_timeout_samples)
    {
        observer->snapshot.direction = 0U;
        observer->snapshot.rpm_raw = 0.0f;
        observer->snapshot.rpm_filtered = 0.0f;
        observer->snapshot.stopped = 1U;
    }

    return 1U;
}

EncoderObserverSnapshot_t EncoderObserver_GetSnapshot(const EncoderObserver_t *observer)
{
    EncoderObserverSnapshot_t empty;

    memset(&empty, 0, sizeof(empty));

    if (observer == NULL || observer->initialized == 0U)
    {
        return empty;
    }

    return observer->snapshot;
}
```

这段代码的关键约束有三个。

第一，`ARR` 被固定为 `0xFFFF`，所以 `int16_t` 环形差分的语义明确、成本极低。这是一个典型的 `KISS` 选择：不把所有计数器位宽和任意自动重装值都塞进抽象里，而是先把最常见的 16 位编码器接口做可靠。

第二，`max_counts_per_sample` 必须由真实机械上限推导。例如最高转速为 `3000 rpm`、`counts_per_rev = 4096`、采样周期为 `1 ms`，单周期最大计数约为  
`3000 / 60 * 4096 * 0.001 = 204.8 counts`。  
工程上可以留出两到三倍裕量，比如设为 `600`，但不能随手填 `30000`，否则异常跳变就失去诊断意义。

第三，低速区的速度台阶不可被滤波器“消灭”。若应用真的要求 `1 rpm` 级低速观测，而控制周期内经常读到 `0/1` 个计数，就应该把速度估计拆成双路径：位置仍由编码器模式累加，低速速度则由更长窗口或输入捕获周期法估计。不要用一个漂亮的浮点低通掩盖观测分辨率不够这个事实。

## 工程落地要点

- **定时器初始化要使用完整 16 位周期**：`Period = 65535`，`CounterMode` 的方向由编码器接口硬件接管。不要在运行时频繁改 `ARR`，否则环形差分的数学前提会被破坏。

- **A/B 相 GPIO 优先保证边沿质量**：上拉、屏蔽、走线、输入滤波和共地比软件补救更重要。若线缆很长，先处理物理层噪声，再谈速度滤波。

- **采样周期要由控制节拍统一驱动**：不要在多个任务里随手读 `CNT`。编码器观测应该有一个唯一生产者，其他模块读取封存快照。

- **计数方向要在系统级校验**：不同编码器接线、定时器通道映射或电机安装方向都会改变正负号。最好在上电自检或产测阶段用已知运动方向验证 `delta_counts` 符号。

- **索引脉冲只在受控状态下使用**：如果把 `Z` 相中断写成“一来就清零”，高速运行时的干扰或错位索引会直接毁掉连续位置。索引应当有速度、相位和状态机三重门控。

- **速度环要知道样本是否有效**：当 `valid = 0` 或 `rejected_jumps` 增长时，上层应进入降级策略，例如保持上一速度、降低控制增益或触发传感器故障计数，而不是继续把坏样本当真。

把这些边界写清楚后，`STM32` 定时器编码器模式才真正从“能计数”升级为“能观测运动”。这一步看似朴素，却是轮式机器人、电机伺服、手轮交互和里程计系统里最容易被低估的底层稳定性来源。
