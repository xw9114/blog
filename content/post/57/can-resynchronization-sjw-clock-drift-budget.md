---
title: "技能档案：CAN 位时序里的重同步、SJW 与长线时钟漂移容限"
slug: "skill-can-resynchronization-sjw-sample-point-and-clock-drift-budget"
date: 2026-06-12T11:19:12+08:00
draft: false
description: "从传播延迟、采样点、重同步跳宽 SJW 到振荡器 ppm 预算，系统拆解 CAN 为什么常在长线、温漂与相位误差里失稳，而不是仲裁逻辑本身。"
tags: ["CAN", "STM32", "bxCAN", "SJW", "位时序", "采样点", "嵌入式"]
categories: ["技能档案"]
image: ""
---

## 技能概述

很多工程里的 CAN 问题，并不是 `HAL_CAN_Start()` 调不起来，而是系统在台架上能跑、上线束后偶发错误帧，换一批晶振或环境升温后又突然开始 `REC/TEC` 累加。真正的痛点不在“能不能发仲裁 ID”，而在 **本地时钟和远端时钟并不完全一致时，控制器还能靠多少相位缓冲段把采样点拉回正确位置**。这个主题要解决的核心问题，不是再复述一遍显性/隐性电平和 ID 优先级，而是把 **传播延迟预算**、**采样点位置**、**重同步跳宽 SJW** 和 **振荡器频偏容限** 串成一份可以落到 STM32 bxCAN HAL 配置里的时域合同。

## 核心底层概念解析

- **CAN 的稳定性首先是一份时间合同，而不是一份帧格式合同**：同一根总线上每个节点都在用自己的振荡器数时间量子 `tq`。只要这些本地时间轴的相位关系失控，仲裁字段、CRC 字段、ACK 槽位都会逐步失去共同语义。
- **位时序的本质是把一个比特拆成“允许传播”和“允许纠偏”的两个窗口**：经典 CAN 的位时间可写成  
  `t_bit = (1 + TSEG1 + TSEG2) * tq`。  
  其中 `1` 是 **SYNC_SEG**，`TSEG1 = PROP_SEG + PHASE_SEG1`，`TSEG2 = PHASE_SEG2`。采样点位于 `SYNC_SEG + TSEG1` 的末端，也就是“先允许网络传播，再决定何时采样”。
- **传播段不是为了好看，而是为了等总线电磁状态真正传到最远节点再回来**：对一个正在发送 dominant 的节点来说，它不仅要把边沿送到远端，还要在本地采样前看到总线最终结果。因此工程上常把环路传播延迟估成  
  `t_loop ~= 2 * t_cable + t_txrx + t_margin`，  
  其中 `t_cable = L * tau_cable`，`tau_cable` 常可近似看成 `5 ns/m` 量级，`t_txrx` 是收发器发送到接收的回环延迟，`t_margin` 用来吸收隔离器、温漂和布局差异。
- **采样点太早，远端 dominant 还没传回来；采样点太晚，留给相位纠偏的余量又会变小**：这就是为什么同样是 `500 kbit/s`，一套配置在 20 米线上很稳，搬到 80 米线束上就开始偶发 bit error。真正决定能不能工作的是“采样时刻和物理传播最慢路径之间还差多少缓冲”，而不是波特率数字本身。
- **重同步并不是“重新开始一帧”，而是看见边沿后允许局部时间轴做一次受限平移**：当控制器检测到期望边沿和实际边沿不重合时，会通过 **SJW（Synchronization Jump Width）** 对 `PHASE_SEG1` 或 `PHASE_SEG2` 做有限伸缩。SJW 本质上是“单次最多能纠回多少相位误差”的上限，而不是随便写个最大值就一定更稳。
- **SJW 大小必须服从剩余相位缓冲段，而不能脱离位结构单独存在**：若 `SJW` 大于 `PHASE_SEG1` 或 `PHASE_SEG2`，控制器就没有足够的时间窗口完成这次纠偏。因此工程上总有  
  `SJW <= min(PHASE_SEG1, PHASE_SEG2)`  
  这样的硬边界。`SJW` 不是白拿来的鲁棒性，它是从一整个比特预算里切出来的纠偏额度。
- **振荡器误差不是抽象的 ppm，而是会在“连续几位都没有可重同步边沿”时不断积累成相位漂移**：若本地与远端的相对频偏为 `eps_rel`，在 `N_edge_free` 个比特时间内累计的相位误差近似为  
  `delta_t ~= N_edge_free * eps_rel * t_bit`。  
  只有当这部分漂移仍能被 `SJW * tq` 或相位缓冲段吸收时，采样点才不会穿过位边界。
- **位填充机制的真正价值之一，就是强迫总线定期出现新边沿，避免误差无上限累积**：如果总线允许无限长的无边沿区间，那么再好的晶振也会在足够长时间后漂到错误采样槽位。CAN 的位填充不是多余开销，它是在用协议规则给重同步创造周期性纠偏机会。
- **长线、高温、隔离器和廉价晶振会同时吃掉同一份相位预算**：线越长，`PROP_SEG` 需求越大；`PROP_SEG` 越大，留给 `PHASE_SEG1/2` 的量子越少；相位缓冲越少，能容纳的 `SJW` 和振荡器误差就越小。很多现场故障不是单一变量超限，而是多个“只多了一点点”的误差共同挤爆了同一张时间预算表。
- **错误计数器往往先于总线瘫痪给出预警**：当位时序边界不够时，最先出现的通常不是彻底 `Bus-Off`，而是 `REC/TEC` 缓慢爬升、`LEC` 在 `Bit Error / Form Error / Stuff Error` 之间游走。这说明系统不是“CAN 协议不对”，而是时间边界正在持续被碰撞。
- **工程上“把采样点调到 87.5%”并不是万能答案**：87.5% 只是很多场景里的经验折中。若总线很短、时钟很高且晶振一般，过晚的采样点反而会压缩 `TSEG2`，让重同步后段补偿能力变差。合理配置必须同时看传播延迟、位时间总量和晶振 ppm 预算，而不是照抄一组网络上流行的数字。
- **技术哲学上，CAN 并不是靠“所有节点都绝对准时”来稳定，而是靠“每个节点都承认自己会漂，并在有限窗口内彼此纠偏”来稳定**：真正成熟的配置，不追求消灭误差，而是把误差限制在可被相位缓冲段吸收的范围内。

## 代码能力展现

下面给出一个基于 STM32 **bxCAN HAL** 的位时序求解与应用示例。重点不是手填 `Prescaler/BS1/BS2/SJW`，而是把四个经常被经验化处理的量重新显式化:

- **比特率映射**: `bitrate = f_can_clk / (Prescaler * NBT)`
- **采样点映射**: `sample_point = (1 + BS1) / NBT`
- **传播延迟约束**: `PROP_SEG * tq >= t_loop`
- **频偏容限约束**: 依据 `SJW`、`PHASE_SEG1/2` 和 `NBT` 估算总相对频偏上限

示例假设：

- `CAN1` 使用经典 bxCAN 外设。
- 内核时钟 `f_can_clk` 已知，例如 `36 MHz`。
- 业务给出目标比特率、目标采样点、线束长度、线缆传播延迟和本地/远端晶振 ppm 预算。

```c
#include "main.h"

#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#define BXCAN_TQ_MIN                         8U
#define BXCAN_TQ_MAX                        25U
#define BXCAN_BS1_MIN                        1U
#define BXCAN_BS1_MAX                       16U
#define BXCAN_BS2_MIN                        1U
#define BXCAN_BS2_MAX                        8U
#define BXCAN_SJW_MIN                        1U
#define BXCAN_SJW_MAX                        4U
#define BXCAN_PRESCALER_MIN                  1U
#define BXCAN_PRESCALER_MAX               1024U
#define BXCAN_SAMPLE_POINT_MIN_PM          500U
#define BXCAN_SAMPLE_POINT_MAX_PM          950U
#define BXCAN_BITRATE_TOLERANCE_PPM       5000U
#define BXCAN_PROP_MARGIN_NS               100U
#define BXCAN_U32_MAX                0xFFFFFFFFUL

typedef struct
{
    uint32_t can_clk_hz;
    uint32_t target_bitrate_hz;
    uint16_t target_sample_point_permille;
    uint32_t bus_length_m;
    uint32_t cable_delay_ns_per_m;
    uint32_t transceiver_loop_delay_ns;
    uint32_t board_margin_ns;
    uint32_t local_oscillator_ppm;
    uint32_t remote_oscillator_ppm;
} BxCanTimingRequest_t;

typedef struct
{
    uint16_t prescaler;
    uint8_t total_tq;
    uint8_t prop_seg_tq;
    uint8_t phase_seg1_tq;
    uint8_t phase_seg2_tq;
    uint8_t sjw_tq;
    uint8_t bs1_tq;
    uint8_t bs2_tq;

    uint32_t actual_bitrate_hz;
    uint16_t actual_sample_point_permille;
    uint32_t tq_ns;
    uint32_t loop_delay_ns;
    uint32_t oscillator_tolerance_ppm_limit;
    uint32_t bitrate_error_ppm;
    uint16_t sample_point_error_permille;
} BxCanTimingSolution_t;

extern CAN_HandleTypeDef hcan1;

static uint16_t ClampU16(uint16_t value, uint16_t min_value, uint16_t max_value)
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

static uint32_t AbsDiffU32(uint32_t a, uint32_t b)
{
    return (a > b) ? (a - b) : (b - a);
}

static uint32_t MinU32(uint32_t a, uint32_t b)
{
    return (a < b) ? a : b;
}

static uint32_t CeilDivU64ToU32(uint64_t numerator, uint32_t denominator)
{
    if ((denominator == 0U) || (numerator == 0ULL))
    {
        return 0U;
    }

    return (uint32_t)((numerator + (uint64_t)denominator - 1ULL) / (uint64_t)denominator);
}

static uint32_t BxCan_ComputeLoopDelayNs(const BxCanTimingRequest_t *request)
{
    uint64_t cable_delay_ns;
    uint64_t loop_delay_ns;

    if (request == NULL)
    {
        return 0U;
    }

    /*
     * 传播延迟预算:
     * t_loop ~= 2 * t_cable + t_txrx + t_margin
     * t_cable = bus_length * cable_delay_ns_per_m
     *
     * 这里取“最远节点往返”视角，因为本地节点在采样前既要等待自己发出的边沿
     * 传到远端，又要等待总线最终状态回到本地接收比较器。
     */
    cable_delay_ns = 2ULL * (uint64_t)request->bus_length_m * (uint64_t)request->cable_delay_ns_per_m;
    loop_delay_ns = cable_delay_ns +
                    (uint64_t)request->transceiver_loop_delay_ns +
                    (uint64_t)request->board_margin_ns;

    if (loop_delay_ns > (uint64_t)BXCAN_U32_MAX)
    {
        return BXCAN_U32_MAX;
    }

    return (uint32_t)loop_delay_ns;
}

static uint32_t BxCan_ComputeTqNs(uint32_t can_clk_hz, uint16_t prescaler)
{
    if ((can_clk_hz == 0U) || (prescaler == 0U))
    {
        return 0U;
    }

    /*
     * 时间量子:
     * tq = Prescaler / f_can_clk
     *
     * 以纳秒表示并向上取整，避免把传播段预算低估。
     */
    return CeilDivU64ToU32((uint64_t)prescaler * 1000000000ULL, can_clk_hz);
}

static uint16_t BxCan_ComputeSamplePointPermille(uint8_t total_tq, uint8_t bs1_tq)
{
    /*
     * 采样点位于 SYNC_SEG + BS1 末端:
     * sample_point = (1 + BS1) / NBT
     */
    return (uint16_t)((((uint32_t)1U + (uint32_t)bs1_tq) * 1000U + ((uint32_t)total_tq / 2U)) /
                      (uint32_t)total_tq);
}

static uint32_t BxCan_ComputeBitratePpmError(uint32_t target_bitrate_hz, uint32_t actual_bitrate_hz)
{
    if ((target_bitrate_hz == 0U) || (actual_bitrate_hz == 0U))
    {
        return BXCAN_U32_MAX;
    }

    /*
     * 比特率误差:
     * error_ppm = |actual - target| / target * 1e6
     */
    return (uint32_t)((((uint64_t)AbsDiffU32(target_bitrate_hz, actual_bitrate_hz)) * 1000000ULL) /
                      (uint64_t)target_bitrate_hz);
}

/**
 * @brief 估算给定位时序下可容纳的总相对频偏上限。
 * @param total_tq 每比特总时间量子 NBT。
 * @param phase_seg1_tq 相位缓冲段 1，单位 tq。
 * @param phase_seg2_tq 相位缓冲段 2，单位 tq。
 * @param sjw_tq 重同步跳宽 SJW，单位 tq。
 * @return 允许的总相对频偏上限，单位 ppm。
 *
 * @note 这里使用经典 CAN 工程上常见的两条约束:
 *       1. df_sync  < SJW / (20 * NBT)
 *       2. df_drift < min(PHASE_SEG1, PHASE_SEG2) / (2 * (13 * NBT - PHASE_SEG2))
 *
 *       第一条反映一次硬同步/重同步能吞下的瞬时相位误差；
 *       第二条反映多位连续运行后，相位漂移在下一次可纠偏边沿到来前
 *       仍然不能越过相位缓冲段。
 *
 *       代码取两者中的更小值，并换算成 ppm。这里得到的是“总相对频偏预算”，
 *       因此本地与远端晶振 ppm 之和必须小于该值。
 */
static uint32_t BxCan_ComputeOscillatorTolerancePpm(uint8_t total_tq,
                                                    uint8_t phase_seg1_tq,
                                                    uint8_t phase_seg2_tq,
                                                    uint8_t sjw_tq)
{
    uint64_t ppm_sync;
    uint64_t ppm_drift_num;
    uint64_t ppm_drift_den;
    uint64_t ppm_drift;

    if ((total_tq == 0U) ||
        (phase_seg1_tq == 0U) ||
        (phase_seg2_tq == 0U) ||
        (sjw_tq == 0U))
    {
        return 0U;
    }

    ppm_sync = ((uint64_t)sjw_tq * 1000000ULL) / (20ULL * (uint64_t)total_tq);

    ppm_drift_num = (uint64_t)MinU32(phase_seg1_tq, phase_seg2_tq) * 1000000ULL;
    ppm_drift_den = 2ULL * ((13ULL * (uint64_t)total_tq) - (uint64_t)phase_seg2_tq);

    if (ppm_drift_den == 0ULL)
    {
        return 0U;
    }

    ppm_drift = ppm_drift_num / ppm_drift_den;
    return (uint32_t)MinU32((uint32_t)ppm_sync, (uint32_t)ppm_drift);
}

static bool BxCan_IsCandidateBetter(const BxCanTimingSolution_t *candidate,
                                    const BxCanTimingSolution_t *best,
                                    bool best_valid)
{
    if ((candidate == NULL) || (best == NULL))
    {
        return false;
    }

    if (!best_valid)
    {
        return true;
    }

    if (candidate->bitrate_error_ppm != best->bitrate_error_ppm)
    {
        return (candidate->bitrate_error_ppm < best->bitrate_error_ppm);
    }

    if (candidate->sample_point_error_permille != best->sample_point_error_permille)
    {
        return (candidate->sample_point_error_permille < best->sample_point_error_permille);
    }

    if (candidate->oscillator_tolerance_ppm_limit != best->oscillator_tolerance_ppm_limit)
    {
        return (candidate->oscillator_tolerance_ppm_limit > best->oscillator_tolerance_ppm_limit);
    }

    if (candidate->phase_seg2_tq != best->phase_seg2_tq)
    {
        return (candidate->phase_seg2_tq > best->phase_seg2_tq);
    }

    return (candidate->prescaler < best->prescaler);
}

/**
 * @brief 搜索满足传播、采样点与频偏预算的 bxCAN 位时序。
 * @param request 目标时序与物理链路约束。
 * @param out_solution 求得的最优解。
 * @retval true 成功找到满足约束的解。
 * @retval false 当前时钟、波特率与物理链路约束下无可行解。
 *
 * @note 搜索中同时满足以下关系:
 *       bitrate = f_can_clk / (Prescaler * NBT)
 *       sample_point = (1 + BS1) / NBT
 *       PROP_SEG * tq >= t_loop
 *       ppm_local + ppm_remote <= ppm_limit(BS1, BS2, SJW)
 *
 *       这里刻意不直接“抄一组经验值”，而是先从物理传播约束推出 PROP_SEG 下限，
 *       再看剩余量子还能否分给 PHASE_SEG1/2 与 SJW。
 */
bool BxCan_FindBestTiming(const BxCanTimingRequest_t *request, BxCanTimingSolution_t *out_solution)
{
    BxCanTimingSolution_t best_solution;
    bool best_valid = false;
    uint32_t combined_osc_ppm;
    uint32_t loop_delay_ns;
    uint16_t target_sample_point_pm;
    uint16_t prescaler;

    if ((request == NULL) || (out_solution == NULL))
    {
        return false;
    }

    if ((request->can_clk_hz == 0U) || (request->target_bitrate_hz == 0U))
    {
        return false;
    }

    target_sample_point_pm = ClampU16(request->target_sample_point_permille,
                                      BXCAN_SAMPLE_POINT_MIN_PM,
                                      BXCAN_SAMPLE_POINT_MAX_PM);
    loop_delay_ns = BxCan_ComputeLoopDelayNs(request);
    combined_osc_ppm = request->local_oscillator_ppm + request->remote_oscillator_ppm;

    memset(&best_solution, 0, sizeof(best_solution));

    for (prescaler = BXCAN_PRESCALER_MIN; prescaler <= BXCAN_PRESCALER_MAX; ++prescaler)
    {
        uint8_t total_tq;
        uint32_t tq_ns = BxCan_ComputeTqNs(request->can_clk_hz, prescaler);
        uint32_t prop_seg_min_tq;

        if (tq_ns == 0U)
        {
            continue;
        }

        /*
         * PROP_SEG 至少要覆盖传播延迟；为避免把板级模型误差写成“恰好等于边界”，
         * 额外加上一个很小的固定裕量再做一次向上取整。
         */
        prop_seg_min_tq = CeilDivU64ToU32((uint64_t)loop_delay_ns + (uint64_t)BXCAN_PROP_MARGIN_NS, tq_ns);

        for (total_tq = BXCAN_TQ_MIN; total_tq <= BXCAN_TQ_MAX; ++total_tq)
        {
            uint32_t actual_bitrate_hz;
            uint32_t bitrate_error_ppm;
            uint8_t bs1_tq;
            uint8_t bs2_tq;
            uint8_t phase_seg1_tq;
            uint8_t phase_seg2_tq;
            uint8_t sjw_tq;
            uint16_t sample_point_pm;
            BxCanTimingSolution_t candidate;

            actual_bitrate_hz = request->can_clk_hz / ((uint32_t)prescaler * (uint32_t)total_tq);
            bitrate_error_ppm = BxCan_ComputeBitratePpmError(request->target_bitrate_hz, actual_bitrate_hz);

            if (bitrate_error_ppm > BXCAN_BITRATE_TOLERANCE_PPM)
            {
                continue;
            }

            /*
             * 目标 BS1 由采样点反推:
             * BS1 ~= round(sample_point * NBT) - 1
             *
             * 这里对半量子做四舍五入，避免系统性偏向过早采样。
             */
            bs1_tq = (uint8_t)((((uint32_t)target_sample_point_pm * (uint32_t)total_tq) + 500U) / 1000U);

            if (bs1_tq == 0U)
            {
                continue;
            }

            bs1_tq = (uint8_t)(bs1_tq - 1U);

            if ((bs1_tq < BXCAN_BS1_MIN) || (bs1_tq > BXCAN_BS1_MAX))
            {
                continue;
            }

            if (((uint32_t)total_tq < (1U + (uint32_t)bs1_tq + (uint32_t)BXCAN_BS2_MIN)) ||
                ((uint32_t)total_tq > (1U + (uint32_t)bs1_tq + (uint32_t)BXCAN_BS2_MAX)))
            {
                continue;
            }

            bs2_tq = (uint8_t)((uint32_t)total_tq - 1U - (uint32_t)bs1_tq);

            if ((bs2_tq < BXCAN_BS2_MIN) || (bs2_tq > BXCAN_BS2_MAX))
            {
                continue;
            }

            if ((prop_seg_min_tq < 1U) || (prop_seg_min_tq >= (uint32_t)bs1_tq))
            {
                continue;
            }

            phase_seg1_tq = (uint8_t)((uint32_t)bs1_tq - prop_seg_min_tq);
            phase_seg2_tq = bs2_tq;

            if ((phase_seg1_tq < 1U) || (phase_seg2_tq < 1U))
            {
                continue;
            }

            sjw_tq = (uint8_t)MinU32(BXCAN_SJW_MAX, MinU32(phase_seg1_tq, phase_seg2_tq));

            if (sjw_tq < BXCAN_SJW_MIN)
            {
                continue;
            }

            sample_point_pm = BxCan_ComputeSamplePointPermille(total_tq, bs1_tq);

            memset(&candidate, 0, sizeof(candidate));
            candidate.prescaler = prescaler;
            candidate.total_tq = total_tq;
            candidate.prop_seg_tq = (uint8_t)prop_seg_min_tq;
            candidate.phase_seg1_tq = phase_seg1_tq;
            candidate.phase_seg2_tq = phase_seg2_tq;
            candidate.sjw_tq = sjw_tq;
            candidate.bs1_tq = bs1_tq;
            candidate.bs2_tq = bs2_tq;
            candidate.actual_bitrate_hz = actual_bitrate_hz;
            candidate.actual_sample_point_permille = sample_point_pm;
            candidate.tq_ns = tq_ns;
            candidate.loop_delay_ns = loop_delay_ns;
            candidate.oscillator_tolerance_ppm_limit =
                BxCan_ComputeOscillatorTolerancePpm(total_tq, phase_seg1_tq, phase_seg2_tq, sjw_tq);
            candidate.bitrate_error_ppm = bitrate_error_ppm;
            candidate.sample_point_error_permille =
                (uint16_t)AbsDiffU32(target_sample_point_pm, sample_point_pm);

            if (candidate.oscillator_tolerance_ppm_limit < combined_osc_ppm)
            {
                continue;
            }

            if (BxCan_IsCandidateBetter(&candidate, &best_solution, best_valid))
            {
                best_solution = candidate;
                best_valid = true;
            }
        }
    }

    if (!best_valid)
    {
        return false;
    }

    *out_solution = best_solution;
    return true;
}

static uint32_t BxCan_MapBs1Enum(uint8_t bs1_tq)
{
    switch (bs1_tq)
    {
        case 1U:  return CAN_BS1_1TQ;
        case 2U:  return CAN_BS1_2TQ;
        case 3U:  return CAN_BS1_3TQ;
        case 4U:  return CAN_BS1_4TQ;
        case 5U:  return CAN_BS1_5TQ;
        case 6U:  return CAN_BS1_6TQ;
        case 7U:  return CAN_BS1_7TQ;
        case 8U:  return CAN_BS1_8TQ;
        case 9U:  return CAN_BS1_9TQ;
        case 10U: return CAN_BS1_10TQ;
        case 11U: return CAN_BS1_11TQ;
        case 12U: return CAN_BS1_12TQ;
        case 13U: return CAN_BS1_13TQ;
        case 14U: return CAN_BS1_14TQ;
        case 15U: return CAN_BS1_15TQ;
        case 16U: return CAN_BS1_16TQ;
        default:  return CAN_BS1_1TQ;
    }
}

static uint32_t BxCan_MapBs2Enum(uint8_t bs2_tq)
{
    switch (bs2_tq)
    {
        case 1U: return CAN_BS2_1TQ;
        case 2U: return CAN_BS2_2TQ;
        case 3U: return CAN_BS2_3TQ;
        case 4U: return CAN_BS2_4TQ;
        case 5U: return CAN_BS2_5TQ;
        case 6U: return CAN_BS2_6TQ;
        case 7U: return CAN_BS2_7TQ;
        case 8U: return CAN_BS2_8TQ;
        default: return CAN_BS2_1TQ;
    }
}

static uint32_t BxCan_MapSjwEnum(uint8_t sjw_tq)
{
    switch (sjw_tq)
    {
        case 1U: return CAN_SJW_1TQ;
        case 2U: return CAN_SJW_2TQ;
        case 3U: return CAN_SJW_3TQ;
        case 4U: return CAN_SJW_4TQ;
        default: return CAN_SJW_1TQ;
    }
}

/**
 * @brief 把计算得到的解应用到 STM32 bxCAN HAL 初始化结构。
 * @param hcan CAN 句柄。
 * @param solution 已验证可行的位时序解。
 * @retval true 参数写入成功。
 * @retval false 参数非法。
 *
 * @note HAL 的 BS1 字段对应的是 `PROP_SEG + PHASE_SEG1` 的总和，
 *       因此本文保留 `prop_seg_tq` 与 `phase_seg1_tq` 两个显式量，
 *       是为了让工程师看到“物理传播预算”和“相位纠偏预算”分别吃掉了多少 tq。
 */
bool BxCan_ApplyTimingToHandle(CAN_HandleTypeDef *hcan, const BxCanTimingSolution_t *solution)
{
    if ((hcan == NULL) || (solution == NULL))
    {
        return false;
    }

    hcan->Init.Prescaler = solution->prescaler;
    hcan->Init.SyncJumpWidth = BxCan_MapSjwEnum(solution->sjw_tq);
    hcan->Init.TimeSeg1 = BxCan_MapBs1Enum(solution->bs1_tq);
    hcan->Init.TimeSeg2 = BxCan_MapBs2Enum(solution->bs2_tq);

    return true;
}

/**
 * @brief 按物理链路约束初始化 CAN1 位时序。
 * @retval HAL_OK 初始化成功。
 * @retval HAL_ERROR 当前约束下无可行位时序或 HAL 初始化失败。
 *
 * @note 示例参数说明:
 *       - 目标 500 kbit/s
 *       - 目标采样点 87.5%
 *       - 线束长度 40m
 *       - 线缆传播延迟按 5ns/m 预算
 *       - 收发器发送+接收环路延迟按 180ns 预算
 *       - 本地与远端晶振各按 100ppm 预算
 *
 *       如果这个函数返回 HAL_ERROR，不应第一时间怀疑 HAL，
 *       更常见的真实结论是: 当前 `f_can_clk`、目标比特率、线长和 ppm 预算
 *       在同一张时间账本里本来就放不下。
 */
HAL_StatusTypeDef App_Can1_InitWithTimingBudget(void)
{
    const BxCanTimingRequest_t request =
    {
        .can_clk_hz = 36000000U,
        .target_bitrate_hz = 500000U,
        .target_sample_point_permille = 875U,
        .bus_length_m = 40U,
        .cable_delay_ns_per_m = 5U,
        .transceiver_loop_delay_ns = 180U,
        .board_margin_ns = 80U,
        .local_oscillator_ppm = 100U,
        .remote_oscillator_ppm = 100U
    };

    BxCanTimingSolution_t solution;

    if (!BxCan_FindBestTiming(&request, &solution))
    {
        return HAL_ERROR;
    }

    if (!BxCan_ApplyTimingToHandle(&hcan1, &solution))
    {
        return HAL_ERROR;
    }

    /*
     * 到这里，HAL 写入的是外设寄存器格式；
     * 但真正被保留下来的是一份已经过“传播延迟 + 频偏预算”约束筛选的解。
     */
    if (HAL_CAN_Init(&hcan1) != HAL_OK)
    {
        return HAL_ERROR;
    }

    return HAL_OK;
}
```

这段代码真正有价值的地方，不是自动算出一组 `Prescaler/BS1/BS2/SJW`，而是把平时最容易被“经验值”掩盖的三类边界重新摆到了台面上：

- `PROP_SEG * tq` 必须先容纳最坏传播路径，否则远端 dominant 还没回来你就先采样了。
- `PHASE_SEG1/PHASE_SEG2` 和 `SJW` 共同决定这条总线能吞下多少时钟漂移，而不是 `SJW` 单独越大越好。
- `ppm_local + ppm_remote` 一旦超过可纠偏预算，系统即使低温短线能跑，到了高温、长线、隔离器链路或不同批次晶振组合下也会慢慢失稳。

对 CAN 来说，真正的工程能力不是背出几个推荐采样点，而是把**电缆长度、收发器延迟、采样点、相位段和晶振误差**放进同一张时间预算表里。只有当这张表自洽，仲裁、ACK、CRC 和错误恢复才是在同一条真实时间轴上发生的。
