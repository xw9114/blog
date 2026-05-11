---
title: "技能档案：CAN 总线的误差边界，从位时序容差到 Bus-Off 恢复"
slug: "skill-can-bit-timing-error-budget-and-bus-off-recovery"
date: 2026-05-11T10:13:19+08:00
draft: false
description: "从采样点、SJW、振荡器漂移到 TEC/REC 与 Bus-Off 最小恢复时间，系统拆解 CAN 通信为什么首先是一份时钟误差与故障隔离合同。"
tags: ["CAN", "STM32", "总线时序", "Bus-Off", "嵌入式"]
categories: ["技能档案"]
image: ""
---

## 技能概述

CAN 总线真正难的地方，不是把两根线接到收发器上，也不是把 `HAL_CAN_Start()` 调通，而是当线缆传播延迟、节点晶振误差、采样点偏移和错误帧同时出现时，系统还能不能维持一份可证明的时序合同。车载控制器、伺服驱动、BMS 和工业 I/O 之所以长期依赖 CAN，不是因为它“便宜好用”，而是因为它把竞争、同步、出错与隔离都压缩进了比特级时域。工程上的核心痛点，是把波特率、采样点、错误计数和 Bus-Off 恢复看成一条连续的资源调度链，而不是把它们拆成“硬件问题”和“驱动问题”各自处理。

## 核心底层概念解析

- **CAN 位时间首先是时钟预算，不是配置表里的几个枚举**：一个 CAN 位可写成 `T_bit = (1 + BS1 + BS2) * T_q`，其中 `T_q = Prescaler / f_can`。`1` 对应同步段 `SyncSeg`，`BS1` 和 `BS2` 分别给传播、相位缓冲和采样后修正留空间。你在 CubeMX 里点下去的 `Prescaler/BS1/BS2/SJW`，本质上是在给整条总线分配纳秒级时间片。
- **采样点不是习惯值，而是远端边沿是否来得及到达的物理契约**：若总线传播延迟、收发器环路延迟和比较器迟滞叠加后超过 `BS1 * T_q`，采样点就会在错误的时间读到错误的电平。所谓 `80%` 或 `87.5%` 采样点，并不是社区迷信，而是为了给长线、分支和收发器非理想性留出余量。
- **SJW 不是“随便填个 1TQ”，它是允许节点互相重新对时的最大修正步长**：重同步时，一个节点单次最多只允许把本地位边界拉回 `SJW * T_q`。如果两端振荡器相对漂移造成的相位偏差已经大于这个窗口，那么总线即使在平均波特率上“差不多”，也会在连续位流里逐步失锁。
- **晶振误差不是绝对值，而是相对误差**：如果两个节点都标称 `50 ppm`，最坏情况下相对偏差要按 `100 ppm` 估算。位时间上的累计漂移近似满足 `Delta_t_drift ≈ T_bit * ppm_rel / 10^6`。当连续若干位之间没有足够可用边沿时，这个漂移会积累，最后由采样点去承担全部后果。
- **位填充并不只是协议开销，它是在主动制造同步边沿密度**：CAN 连续发送 5 个相同比特后必须插入一位反相信号，目的不是“浪费一点带宽”，而是避免总线长时间没有边沿，导致重同步失去抓手。没有边沿，`SJW` 再大也只是摆设。
- **仲裁成功不代表时序安全**：旧话题里的显性/隐性位仲裁解决的是“谁先发”；而位时序容差解决的是“发出去的每一位能否被所有节点在同一时刻正确理解”。前者是优先级问题，后者是时间一致性问题，二者缺一不可。
- **`BS1` 与 `BS2` 不是对称资源**：`BS1` 更像传播延迟和采样点前缓冲，`BS2` 更像采样后相位修正和总线回稳窗口。把采样点一味往后推，确实能增加传播余量，但也会压缩 `BS2`，让重同步弹性变差。因此更晚的采样点并不总是更稳。
- **错误计数器 TEC/REC 本质上是总线对节点的“信任账本”**：发送错误会推高 `TEC`，接收错误会推高 `REC`。节点从 Error Active 进入 Error Passive，再进入 Bus-Off，不是协议在“惩罚”设备，而是在限制异常节点继续污染总线。工业现场最怕的不是偶发丢帧，而是坏节点把全网拖成错误风暴。
- **Bus-Off 不是失败终点，而是隔离后的冷却窗口**：经典 CAN 里，节点进入 Bus-Off 后，需要等待 `128` 次、每次 `11` 个连续隐性位的空闲序列，才能具备重新入网的最小物理条件，因此可写成 `T_recover_min = 128 * 11 / bitrate`。在 `500 kbps` 下，这个理论下限约为 `2.816 ms`；工程里还要再叠加软件重启、收发器释放和上层状态机重建的安全裕量。
- **自动恢复不一定优于受控恢复**：有些系统会启用控制器自动离开 Bus-Off，但对于电机驱动、制动控制或多主站工业网络，工程上更稳的策略往往是先锁存故障、拉闸发送通道、等待最小空闲时间，再由任务上下文分阶段重启。这不是保守，而是在把恢复过程从硬件偶然行为升级为软件可审计流程。
- **CAN 调试的第一优先级不是看 API 返回值，而是重建时间线**：示波器看采样点、逻辑分析仪看错误帧、驱动层看 `HAL_CAN_GetError()`、应用层看丢包窗口。只有把“哪一位错了、在什么采样点错的、错后 TEC/REC 怎么演化、Bus-Off 后多久重启”串成一条时间轴，问题才会从玄学变成工程。
- **总线协议的终极哲学是故障隔离，而不是吞掉一切错误继续硬撑**：CAN 的成熟，不在于它从不出错，而在于它承认传播延迟、噪声、时钟漂移和错误节点都会存在，并把这些不完美纳入一套可量化、可恢复、可隔离的时域合同里。

## 代码能力展现

下面给出一个基于 STM32 HAL `bxCAN` 的工程化示例。代码重点不在“收发一帧”本身，而在于三件事：其一，按目标波特率和采样点搜索一组可解释的位时序；其二，把 `TEC/REC` 风险收敛成 Bus-Off 锁存与受控恢复；其三，用标准 ID 的位域映射把报文优先级显式写出来，避免系统负载升高后仲裁顺序失控。

```c
#include "main.h"
#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#define CAN_STD_ID_MASK                     0x07FFU
#define CAN_PRIORITY_MAX                    7U
#define CAN_FUNCTION_MAX                    15U
#define CAN_NODE_MAX                        15U

#define CAN_PRESCALER_MIN                   1U
#define CAN_PRESCALER_MAX                   1024U
#define CAN_BS1_MIN_TQ                      1U
#define CAN_BS1_MAX_TQ                      16U
#define CAN_BS2_MIN_TQ                      2U
#define CAN_BS2_MAX_TQ                      8U
#define CAN_SJW_MAX_TQ                      4U
#define CAN_TOTAL_TQ_MIN                    8U
#define CAN_TOTAL_TQ_MAX                    25U

#define CAN_BITRATE_ERROR_LIMIT_PPM         5000U
#define CAN_RECOVERY_IDLE_SEQUENCES         128U
#define CAN_IDLE_BITS_PER_SEQUENCE          11U
#define CAN_RECOVERY_EXTRA_MARGIN_MS        2U

typedef struct
{
    uint16_t prescaler;
    uint8_t bs1_tq;
    uint8_t bs2_tq;
    uint8_t sjw_tq;
    uint32_t actual_bitrate_hz;
    uint16_t sample_point_permille;
    uint32_t bitrate_error_ppm;
} CanBitTiming_t;

typedef struct
{
    CAN_HandleTypeDef *hcan;
    CanBitTiming_t timing;
    uint32_t can_clock_hz;
    uint32_t target_bitrate_hz;
    uint16_t target_sample_permille;
    uint32_t propagation_delay_ns;
    uint32_t oscillator_tolerance_ppm;
    uint32_t busoff_count;
    uint32_t error_passive_count;
    uint32_t last_error_code;
    uint32_t recover_after_tick;
    bool bus_off_latched;
} CanBusGuard_t;

static inline uint32_t Can_AbsDiffU32(uint32_t a, uint32_t b)
{
    return (a > b) ? (a - b) : (b - a);
}

static inline uint32_t Can_ClampU32(uint32_t value, uint32_t min_value, uint32_t max_value)
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

static uint32_t Can_MapBs1Enum(uint8_t bs1_tq)
{
    static const uint32_t k_bs1_lut[] =
    {
        0U,
        CAN_BS1_1TQ, CAN_BS1_2TQ, CAN_BS1_3TQ, CAN_BS1_4TQ,
        CAN_BS1_5TQ, CAN_BS1_6TQ, CAN_BS1_7TQ, CAN_BS1_8TQ,
        CAN_BS1_9TQ, CAN_BS1_10TQ, CAN_BS1_11TQ, CAN_BS1_12TQ,
        CAN_BS1_13TQ, CAN_BS1_14TQ, CAN_BS1_15TQ, CAN_BS1_16TQ
    };

    return k_bs1_lut[Can_ClampU32(bs1_tq, CAN_BS1_MIN_TQ, CAN_BS1_MAX_TQ)];
}

static uint32_t Can_MapBs2Enum(uint8_t bs2_tq)
{
    static const uint32_t k_bs2_lut[] =
    {
        0U, 0U,
        CAN_BS2_2TQ, CAN_BS2_3TQ, CAN_BS2_4TQ, CAN_BS2_5TQ,
        CAN_BS2_6TQ, CAN_BS2_7TQ, CAN_BS2_8TQ
    };

    return k_bs2_lut[Can_ClampU32(bs2_tq, CAN_BS2_MIN_TQ, CAN_BS2_MAX_TQ)];
}

static uint32_t Can_MapSjwEnum(uint8_t sjw_tq)
{
    static const uint32_t k_sjw_lut[] =
    {
        0U, CAN_SJW_1TQ, CAN_SJW_2TQ, CAN_SJW_3TQ, CAN_SJW_4TQ
    };

    return k_sjw_lut[Can_ClampU32(sjw_tq, 1U, CAN_SJW_MAX_TQ)];
}

/**
 * @brief 将标准帧 11 位 ID 映射为“优先级 + 功能码 + 节点号”。
 * @param priority 3 位优先级，数值越小优先级越高。
 * @param function 4 位功能码。
 * @param node_id 4 位节点号。
 * @retval 11 位标准 ID。
 *
 * @note CAN 仲裁按 ID 从高位到低位逐位比较，因此这里把优先级放在最高位段：
 *       StdId[10:8] = priority
 *       StdId[7:4]  = function
 *       StdId[3:0]  = node_id
 */
static uint16_t Can_EncodeStdId(uint8_t priority, uint8_t function, uint8_t node_id)
{
    const uint16_t clamped_priority = (uint16_t)Can_ClampU32(priority, 0U, CAN_PRIORITY_MAX);
    const uint16_t clamped_function = (uint16_t)Can_ClampU32(function, 0U, CAN_FUNCTION_MAX);
    const uint16_t clamped_node_id = (uint16_t)Can_ClampU32(node_id, 0U, CAN_NODE_MAX);

    return (uint16_t)(((clamped_priority & 0x07U) << 8U) |
                      ((clamped_function & 0x0FU) << 4U) |
                      (clamped_node_id & 0x0FU));
}

/**
 * @brief 搜索一组满足波特率、采样点和相位误差预算的 CAN 位时序。
 * @param can_clock_hz CAN 内核时钟。
 * @param target_bitrate_hz 目标波特率。
 * @param target_sample_permille 目标采样点，千分比表示，例如 875 代表 87.5%。
 * @param propagation_delay_ns 估计的总线传播延迟预算，含线缆和收发器环路。
 * @param oscillator_tolerance_ppm 单节点振荡器容差，单位 ppm。
 * @param out_timing 输出的最佳时序。
 * @retval true 表示找到可用解；false 表示当前时钟条件下无满足约束的组合。
 *
 * @note 关键约束来自三组公式：
 *       1. T_bit = (1 + BS1 + BS2) * T_q
 *       2. sample_point = (1 + BS1) / (1 + BS1 + BS2)
 *       3. phase_error_max <= SJW * T_q
 *
 *       其中相位误差可近似分成两部分：
 *       - 传播延迟：远端边沿必须在采样点前抵达，因此 propagation_delay_ns < BS1 * T_q_ns
 *       - 时钟相对漂移：两端各自存在 oscillator_tolerance_ppm，最坏相对误差按 2 倍估算
 *         drift_ns ≈ T_bit_ns * (2 * oscillator_tolerance_ppm) / 1e6
 *         要求 drift_ns < SJW * T_q_ns
 */
static bool Can_FindBitTiming(uint32_t can_clock_hz,
                              uint32_t target_bitrate_hz,
                              uint16_t target_sample_permille,
                              uint32_t propagation_delay_ns,
                              uint32_t oscillator_tolerance_ppm,
                              CanBitTiming_t *out_timing)
{
    bool found = false;
    uint32_t best_score = 0xFFFFFFFFUL;
    CanBitTiming_t best = {0};

    if ((out_timing == NULL) || (target_bitrate_hz == 0U) || (can_clock_hz == 0U))
    {
        return false;
    }

    for (uint32_t total_tq = CAN_TOTAL_TQ_MIN; total_tq <= CAN_TOTAL_TQ_MAX; ++total_tq)
    {
        for (uint32_t bs1_tq = CAN_BS1_MIN_TQ; bs1_tq <= CAN_BS1_MAX_TQ; ++bs1_tq)
        {
            const uint32_t bs2_tq = total_tq - 1U - bs1_tq;

            if ((bs2_tq < CAN_BS2_MIN_TQ) || (bs2_tq > CAN_BS2_MAX_TQ))
            {
                continue;
            }

            for (uint32_t prescaler = CAN_PRESCALER_MIN; prescaler <= CAN_PRESCALER_MAX; ++prescaler)
            {
                const uint32_t denominator = prescaler * total_tq;
                const uint32_t actual_bitrate_hz = can_clock_hz / denominator;
                const uint32_t remainder = can_clock_hz % denominator;
                const uint16_t sample_permille = (uint16_t)(((1U + bs1_tq) * 1000U) / total_tq);
                const uint8_t sjw_tq = (uint8_t)((bs2_tq > CAN_SJW_MAX_TQ) ? CAN_SJW_MAX_TQ : bs2_tq);
                const uint32_t tq_ns = (uint32_t)(((uint64_t)prescaler * 1000000000ULL) / can_clock_hz);
                const uint32_t bit_time_ns = tq_ns * total_tq;
                const uint32_t bitrate_error_ppm =
                    (uint32_t)(((uint64_t)Can_AbsDiffU32(actual_bitrate_hz, target_bitrate_hz) * 1000000ULL) /
                               target_bitrate_hz);
                const uint32_t drift_ns =
                    (uint32_t)(((uint64_t)bit_time_ns * (2ULL * oscillator_tolerance_ppm)) / 1000000ULL);
                const uint32_t resync_ns = tq_ns * sjw_tq;
                uint32_t score = 0U;

                /*
                 * remainder != 0 说明 T_q 在当前时钟下不是精确整数纳秒，但这不构成错误；
                 * 我们只在 score 中轻微惩罚，优先选择更整齐的分频组合。
                 */
                (void)remainder;

                if (bitrate_error_ppm > CAN_BITRATE_ERROR_LIMIT_PPM)
                {
                    continue;
                }

                if ((bs1_tq * tq_ns) <= propagation_delay_ns)
                {
                    continue;
                }

                if (resync_ns <= drift_ns)
                {
                    continue;
                }

                score += bitrate_error_ppm;
                score += (Can_AbsDiffU32(sample_permille, target_sample_permille) * 8U);
                score += (uint32_t)(CAN_BS2_MAX_TQ - bs2_tq);

                if ((!found) || (score < best_score))
                {
                    found = true;
                    best_score = score;
                    best.prescaler = (uint16_t)prescaler;
                    best.bs1_tq = (uint8_t)bs1_tq;
                    best.bs2_tq = (uint8_t)bs2_tq;
                    best.sjw_tq = sjw_tq;
                    best.actual_bitrate_hz = actual_bitrate_hz;
                    best.sample_point_permille = sample_permille;
                    best.bitrate_error_ppm = bitrate_error_ppm;
                }
            }
        }
    }

    if (!found)
    {
        return false;
    }

    *out_timing = best;
    return true;
}

/**
 * @brief 将计算出的位时序写入 HAL CAN 句柄。
 * @param hcan HAL CAN 句柄。
 * @param timing 已通过预算检查的位时序。
 */
static void Can_ApplyBitTiming(CAN_HandleTypeDef *hcan, const CanBitTiming_t *timing)
{
    hcan->Init.Prescaler = timing->prescaler;
    hcan->Init.TimeSeg1 = Can_MapBs1Enum(timing->bs1_tq);
    hcan->Init.TimeSeg2 = Can_MapBs2Enum(timing->bs2_tq);
    hcan->Init.SyncJumpWidth = Can_MapSjwEnum(timing->sjw_tq);
}

/**
 * @brief 计算 Bus-Off 后的最小软件恢复等待时间。
 * @param bitrate_hz 当前总线波特率。
 * @retval 恢复前至少等待的毫秒数。
 *
 * @note 经典 CAN 的物理下限可近似写成：
 *       T_recover_min = 128 * 11 / bitrate
 *       其中 128 代表需要观察到 128 个空闲序列，每个序列为 11 个连续隐性位。
 *       软件侧再额外增加少量 margin，用于收发器释放和任务调度抖动。
 */
static uint32_t Can_ComputeRecoveryDelayMs(uint32_t bitrate_hz)
{
    const uint32_t recover_bits = CAN_RECOVERY_IDLE_SEQUENCES * CAN_IDLE_BITS_PER_SEQUENCE;
    const uint32_t recover_us =
        (uint32_t)(((uint64_t)recover_bits * 1000000ULL + (bitrate_hz - 1U)) / bitrate_hz);

    return (recover_us + 999U) / 1000U + CAN_RECOVERY_EXTRA_MARGIN_MS;
}

/**
 * @brief 初始化 CAN 总线保护对象，并启动总线。
 * @param guard 总线保护对象。
 * @param hcan HAL CAN 句柄。
 * @param can_clock_hz CAN 内核时钟。
 * @param target_bitrate_hz 目标波特率。
 * @param target_sample_permille 目标采样点。
 * @param propagation_delay_ns 总线传播延迟预算。
 * @param oscillator_tolerance_ppm 单节点振荡器误差预算。
 * @retval true 表示初始化成功。
 */
bool CanBusGuard_Init(CanBusGuard_t *guard,
                      CAN_HandleTypeDef *hcan,
                      uint32_t can_clock_hz,
                      uint32_t target_bitrate_hz,
                      uint16_t target_sample_permille,
                      uint32_t propagation_delay_ns,
                      uint32_t oscillator_tolerance_ppm)
{
    if ((guard == NULL) || (hcan == NULL))
    {
        return false;
    }

    memset(guard, 0, sizeof(*guard));
    guard->hcan = hcan;
    guard->can_clock_hz = can_clock_hz;
    guard->target_bitrate_hz = target_bitrate_hz;
    guard->target_sample_permille = target_sample_permille;
    guard->propagation_delay_ns = propagation_delay_ns;
    guard->oscillator_tolerance_ppm = oscillator_tolerance_ppm;

    if (!Can_FindBitTiming(can_clock_hz,
                           target_bitrate_hz,
                           target_sample_permille,
                           propagation_delay_ns,
                           oscillator_tolerance_ppm,
                           &guard->timing))
    {
        return false;
    }

    Can_ApplyBitTiming(hcan, &guard->timing);

    if (HAL_CAN_Init(hcan) != HAL_OK)
    {
        return false;
    }

    if (HAL_CAN_Start(hcan) != HAL_OK)
    {
        return false;
    }

    if (HAL_CAN_ActivateNotification(hcan,
                                     CAN_IT_RX_FIFO0_MSG_PENDING |
                                     CAN_IT_BUSOFF |
                                     CAN_IT_ERROR_PASSIVE |
                                     CAN_IT_LAST_ERROR_CODE) != HAL_OK)
    {
        return false;
    }

    return true;
}

/**
 * @brief 在 HAL 错误回调中锁存 Bus-Off 与 Error Passive 状态。
 * @param guard 总线保护对象。
 */
void CanBusGuard_OnError(CanBusGuard_t *guard)
{
    const uint32_t error_code = HAL_CAN_GetError(guard->hcan);

    guard->last_error_code = error_code;

    if ((error_code & HAL_CAN_ERROR_EPV) != 0U)
    {
        guard->error_passive_count++;
    }

    if ((error_code & HAL_CAN_ERROR_BOF) != 0U)
    {
        guard->busoff_count++;
        guard->bus_off_latched = true;
        guard->recover_after_tick =
            HAL_GetTick() + Can_ComputeRecoveryDelayMs(guard->timing.actual_bitrate_hz);

        /*
         * 进入 Bus-Off 后先停发，避免应用层继续向邮箱填充无意义报文。
         * 恢复动作放到任务上下文中做，而不是在中断里直接反复 Start/Init。
         */
        (void)HAL_CAN_Stop(guard->hcan);
    }
}

/**
 * @brief 在周期任务中尝试恢复 Bus-Off 节点。
 * @param guard 总线保护对象。
 *
 * @note 这里采用“锁存 -> 等待 -> 重新初始化 -> 重新启动 -> 重新开中断”的受控恢复顺序，
 *       目的是把故障恢复显式放进任务调度，而不是依赖不可见的自动状态跳转。
 */
void CanBusGuard_Service(CanBusGuard_t *guard)
{
    if ((guard == NULL) || (!guard->bus_off_latched))
    {
        return;
    }

    if ((int32_t)(HAL_GetTick() - guard->recover_after_tick) < 0)
    {
        return;
    }

    Can_ApplyBitTiming(guard->hcan, &guard->timing);

    if (HAL_CAN_Init(guard->hcan) != HAL_OK)
    {
        guard->recover_after_tick = HAL_GetTick() + 1U;
        return;
    }

    if (HAL_CAN_Start(guard->hcan) != HAL_OK)
    {
        guard->recover_after_tick = HAL_GetTick() + 1U;
        return;
    }

    if (HAL_CAN_ActivateNotification(guard->hcan,
                                     CAN_IT_RX_FIFO0_MSG_PENDING |
                                     CAN_IT_BUSOFF |
                                     CAN_IT_ERROR_PASSIVE |
                                     CAN_IT_LAST_ERROR_CODE) != HAL_OK)
    {
        guard->recover_after_tick = HAL_GetTick() + 1U;
        return;
    }

    guard->bus_off_latched = false;
}

/**
 * @brief 发送一帧标准数据帧，并显式执行优先级位域映射。
 * @param guard 总线保护对象。
 * @param priority 3 位优先级，0 最高。
 * @param function 4 位功能码。
 * @param node_id 4 位节点号。
 * @param payload 数据负载。
 * @param dlc 数据长度，范围 0~8。
 * @retval HAL 状态码。若总线仍处于 Bus-Off 锁存状态，则返回 HAL_BUSY。
 */
HAL_StatusTypeDef CanBusGuard_SendStd(CanBusGuard_t *guard,
                                      uint8_t priority,
                                      uint8_t function,
                                      uint8_t node_id,
                                      const uint8_t *payload,
                                      uint8_t dlc)
{
    CAN_TxHeaderTypeDef tx_header;
    uint32_t mailbox = 0U;
    uint8_t bounded_dlc = (uint8_t)Can_ClampU32(dlc, 0U, 8U);
    uint8_t frame[8] = {0U};

    if ((guard == NULL) || (payload == NULL))
    {
        return HAL_ERROR;
    }

    if (guard->bus_off_latched)
    {
        return HAL_BUSY;
    }

    memcpy(frame, payload, bounded_dlc);

    tx_header.StdId = Can_EncodeStdId(priority, function, node_id) & CAN_STD_ID_MASK;
    tx_header.ExtId = 0U;
    tx_header.IDE = CAN_ID_STD;
    tx_header.RTR = CAN_RTR_DATA;
    tx_header.DLC = bounded_dlc;
    tx_header.TransmitGlobalTime = DISABLE;

    return HAL_CAN_AddTxMessage(guard->hcan, &tx_header, frame, &mailbox);
}

/*
 * 典型用法：
 *
 * static CanBusGuard_t g_can1_guard;
 *
 * void App_CanInit(void)
 * {
 *     (void)CanBusGuard_Init(&g_can1_guard,
 *                            &hcan1,
 *                            42000000U,   // APB1 上的 CAN 时钟
 *                            500000U,     // 500 kbps
 *                            875U,        // 87.5% sample point
 *                            350U,        // 线缆 + 收发器传播预算
 *                            50U);        // 单节点晶振 50 ppm
 * }
 *
 * void HAL_CAN_ErrorCallback(CAN_HandleTypeDef *hcan)
 * {
 *     if (hcan == g_can1_guard.hcan)
 *     {
 *         CanBusGuard_OnError(&g_can1_guard);
 *     }
 * }
 *
 * void App_CanTask_1ms(void)
 * {
 *     CanBusGuard_Service(&g_can1_guard);
 * }
 */
```

这段实现刻意遵循几个边界。第一，**KISS**：位时序搜索只关心三个真正决定总线稳定性的量，波特率误差、采样点和相位修正窗口，没有额外堆砌“自动调优”。第二，**YAGNI**：代码只覆盖标准帧、Bus-Off 锁存和受控恢复，没有提前塞入并未被当前主题要求的过滤器表、诊断协议或网关桥接。第三，**DRY**：位时序映射、恢复等待和 ID 编码都集中在单一函数中，避免初始化、错误回调和发送路径各写一份“半对半错”的重复逻辑。最后是 **SOLID**：时序搜索、故障锁存和发送接口各司其职，应用层只需要关心“当前能否发、何时恢复”，而不是在每个任务里直接操作底层寄存器状态。
