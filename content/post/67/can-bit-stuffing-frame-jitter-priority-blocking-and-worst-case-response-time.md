---
title: "技能档案：CAN 位填充帧长抖动、优先级阻塞与最坏响应时间"
slug: "skill-can-bit-stuffing-frame-jitter-priority-blocking-and-worst-case-response-time"
date: 2026-06-21T09:08:11+08:00
draft: false
description: "从五连同极位后的插入规则、标准帧最坏帧长到低优先级整帧阻塞与固定点响应时间方程，系统拆解 CAN 周期报文为什么常死在时延预算而不是仲裁本身。"
tags: ["CAN", "STM32", "bxCAN", "位填充", "最坏响应时间", "实时调度"]
categories: ["技能档案"]
image: ""
---

## 技能概述

很多控制网络真正难搞的地方，不是 `HAL_CAN_AddTxMessage()` 会不会返回 `HAL_OK`，而是电机力矩指令、BMS 电流广播、编码器周期帧和诊断报文一旦同时挤上总线，系统明明平均负载不高，某几路关键报文却还是会周期性超期。根因往往不在“仲裁失败”本身，而在 **位填充会把同样的 8 字节业务负载拉成不同长度的线上帧，低优先级报文一旦抢先起发又会形成整帧非抢占阻塞，高优先级流量则会在固定时间窗里不断叠加干扰**。这个主题真正要解决的，是把 **位填充**、**最坏帧长**、**优先级阻塞** 和 **固定点最坏响应时间分析** 串成一份能落到 `STM32 bxCAN HAL` 的实时预算合同。

## 核心底层概念解析

- **位填充不是协议税，而是给接收端周期性制造重同步边沿**：经典 CAN 从 `SOF` 到 `CRC Sequence` 采用 `NRZ` 编码，若连续太久都没有边沿，各节点本地时钟的相位误差就会在一个比特时间里持续积累。因此规则要求 **每出现 5 个连续同极性位，就自动插入 1 个反相填充位**。它牺牲的是吞吐，换回的是时钟语义还能继续对齐。
- **“DLC=8” 并不直接等于一条固定长度的线上事务**：对 **标准 11 位数据帧** 而言，未计位填充时总位数可写成 `N_base = 47 + 8 * DLC`，其中已经包含 `CRC delimiter`、`ACK`、`EOF` 和 `IFS`；允许发生位填充的区域长度则是 `N_sr = 34 + 8 * DLC`。这说明你在应用层看见的是 8 字节，在总线上真正占掉的是一段仍会被编码规则继续拉长的时域窗口。
- **最坏位填充不能靠平均值估，要先给出保守上界**：对一段长度为 `N_sr` 的可填充原始位串，常用的保守上界是 `N_stuff,max <= floor((N_sr - 1) / 4)`。原因在于最坏模式下，插入的填充位本身还会参与后续连位计数，使得“每增加 4 个原始位就可能再长出 1 个填充位”。于是标准数据帧的保守最坏总位数可预算为 `N_total,worst = N_base + N_stuff,max`。
- **一条报文真正参与调度分析的执行时间不是平均帧长，而是 `C_i = N_total,worst / bitrate`**：只要你还在做闭环控制，就不能用“平时大多只有这么长”来写 deadline。位填充把 CAN 帧从“业务字段长度固定”改写成“总线占用时间与比特模式相关”，而实时系统最怕的正是这种模式相关时延。
- **CAN 的仲裁是按位竞争，但一旦 `SOF` 成功上总线，整帧就是非抢占的**：这意味着高优先级报文虽然最终一定会赢过低优先级报文，但它不能把一条已经开始发送的低优先级长帧打断。因此对报文 `i` 来说，总会存在一项 **低优先级阻塞**：`B_i = max_{k ∈ lp(i)} C_k`。很多“高优先级为什么还超时”的答案，就藏在这一个整帧阻塞里。
- **平均带宽利用率不是可调度性证明，固定点方程才是**：经典固定优先级 CAN 分析常写成  
  `R_i^{n+1} = J_i + C_i + B_i + Σ ceil((R_i^n + J_j + tau_bit) / T_j) * C_j`。  
  这里 `J_i` 是自身释放抖动，`C_i` 是自身最坏传输时间，`B_i` 是低优先级整帧阻塞，求和项是所有高优先级流在窗口 `R_i` 内可能重复出现的干扰。真正决定 deadline 能否守住的，从来不是总负载一个数，而是这个窗口里最坏时刻能塞进多少完整帧。
- **位填充把干扰从“高优先级来了几次”进一步扩展成“每次来多长”**：若报文内容模式变化大，虽然 ID、周期和 `DLC` 一样，帧长仍可能在一个范围内抖动。工程上若不想把证明做成数据相关，就应该直接按保守最坏填充去分析，而不是拿某次示波器抓到的平均帧长替代 `C_i`。
- **bxCAN 的发送邮箱不是抽象队列，寄存器策略会直接改写优先级语义**：`TXFP = DISABLE` 时，bxCAN 在多个待发送邮箱间按报文标识符优先级参与仲裁；若误开 `TXFP = ENABLE`，则邮箱进入 FIFO 顺序优先，软件先塞进去的低优先级帧可能先占住起发机会。调度分析默认的“ID 越小优先级越高”，必须和外设配置保持同一套现实。
- **自动重发、错误主动帧和总线恢复会把 nominal 分析边界外再叠一层时延**：本文讨论的是**无错误稳态**下的最坏响应时间。只要 ACK 缺失、错误帧重发或 `Bus-Off` 恢复进来，`C_i` 与干扰项就会继续膨胀。因此 nominal 分析通过，只代表“物理层健康时不会因调度本身超期”，不代表你已经覆盖错误恢复预算。
- **长诊断帧不该和短控制帧共享相近优先级**：因为 CAN 的最坏阻塞单位是“一整帧占线时间”，所以真正伤害控制实时性的，不一定是最频繁的流，而可能是一条偶发但很长、ID 又没有刻意压低的诊断或状态快照帧。
- **技术哲学上，CAN 带宽不是平均 `kbit/s` 的问题，而是“最坏连续占线时间”如何在多个优先级之间分配的问题**：位填充解决的是物理同步，仲裁解决的是冲突归属，而响应时间分析解决的，是这些物理与协议规则落到实时系统后，谁还能在自己的 deadline 之前真正说完话。

## 代码能力展现

下面给出一个基于 **STM32 bxCAN HAL** 的周期报文预算与发送门控示例。场景假设如下：

- 使用 **经典 CAN 2.0A 标准 11 位数据帧**。
- `TIM2` 提供 `1 MHz` 自由运行计数器，作为调度层时间基准。
- `bxCAN` 采用 **按标识符优先级发送**，因此 `TransmitFifoPriority` 必须保持 `DISABLE`。
- 代码只分析 **无错误稳态** 下的最坏响应时间；一旦引入错误重发，需要在此基础上再加通信异常预算。

代码重点不在“再包一层 `HAL_CAN_AddTxMessage()`”，而在把 **标准帧最坏位数估算**、**低优先级整帧阻塞**、**高优先级固定点干扰** 和 **deadline 门控发送** 串成一条闭环。

```c
#include "main.h"

#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#define CAN_SCHED_MAX_FRAMES                    8U
#define CAN_CLASSIC_MAX_DLC                     8U
#define CAN_ANALYSIS_MAX_ITER                  32U
#define CAN_ANALYSIS_MAX_RESPONSE_US      500000U
#define CAN_ANALYSIS_MAX_SUM_US          4000000U
#define CAN_TIME_ONE_SECOND_US           1000000ULL

typedef struct
{
    uint16_t std_id;
    uint8_t dlc;
    uint32_t period_us;
    uint32_t deadline_us;
    uint32_t release_jitter_us;
    uint8_t payload[CAN_CLASSIC_MAX_DLC];
    bool enabled;
} CanPeriodicFrame_t;

typedef struct
{
    CanPeriodicFrame_t cfg;
    uint32_t last_release_us;
    uint32_t last_wcrt_us;
    uint16_t dropped_deadline_count;
} CanPeriodicSlot_t;

typedef struct
{
    CAN_HandleTypeDef *hcan;
    TIM_HandleTypeDef *htim_timebase;
    uint32_t bitrate_hz;
    CanPeriodicSlot_t slots[CAN_SCHED_MAX_FRAMES];
    uint8_t slot_count;
} CanPeriodicNode_t;

static uint8_t Can_ClampDlc(uint8_t dlc)
{
    return (dlc <= CAN_CLASSIC_MAX_DLC) ? dlc : CAN_CLASSIC_MAX_DLC;
}

static uint32_t Can_MaxU32(uint32_t a, uint32_t b)
{
    return (a > b) ? a : b;
}

static uint32_t Can_CeilDivU64ToU32(uint64_t numerator, uint32_t denominator)
{
    if ((denominator == 0U) || (numerator == 0ULL))
    {
        return 0U;
    }

    return (uint32_t)((numerator + (uint64_t)denominator - 1ULL) / (uint64_t)denominator);
}

static uint32_t Can_GetTimestampUs(const TIM_HandleTypeDef *htim_timebase)
{
    return __HAL_TIM_GET_COUNTER(htim_timebase);
}

/**
 * @brief 返回标准 11 位经典 CAN 数据帧中允许位填充的原始位数。
 * @param frame 周期报文配置。
 * @return 可发生位填充的原始位数。
 *
 * @note 对标准数据帧，从 SOF 到 CRC Sequence 的原始位数为:
 *       N_sr = 1(SOF) + 12(arbitration) + 6(control) + 8 * DLC + 15(CRC)
 *            = 34 + 8 * DLC
 *
 *       位填充只发生在这一段，不发生在 CRC delimiter、ACK、EOF 和 IFS。
 */
static uint32_t CanClassic_StuffRegionBits(const CanPeriodicFrame_t *frame)
{
    const uint8_t dlc = Can_ClampDlc(frame->dlc);

    return 34U + ((uint32_t)8U * (uint32_t)dlc);
}

/**
 * @brief 返回标准 11 位经典 CAN 数据帧未计位填充时的总位数。
 * @param frame 周期报文配置。
 * @return 未计位填充时的总位数。
 *
 * @note 基础位数预算:
 *       N_base = 1(SOF) + 12(arbitration) + 6(control) + 8 * DLC
 *              + 15(CRC) + 1(CRC delimiter) + 2(ACK) + 7(EOF) + 3(IFS)
 *              = 47 + 8 * DLC
 *
 *       这里把 IFS 也计入执行时间，是因为下一帧最早也要在 IFS 之后才能真正起发。
 */
static uint32_t CanClassic_BaseBits(const CanPeriodicFrame_t *frame)
{
    const uint8_t dlc = Can_ClampDlc(frame->dlc);

    return 47U + ((uint32_t)8U * (uint32_t)dlc);
}

/**
 * @brief 计算可填充位串的保守最坏位填充个数。
 * @param stuff_region_bits 从 SOF 到 CRC Sequence 的原始位数。
 * @return 保守最坏位填充个数。
 *
 * @note 常用保守上界:
 *       N_stuff,max <= floor((N_sr - 1) / 4)
 *
 *       这个上界并不等于每一帧的精确填充个数，但它的优点是:
 *       1. 与 ID / payload 位模式无关；
 *       2. 可直接用于实时预算；
 *       3. 不会低估最坏占线时间。
 */
static uint32_t CanClassic_WorstStuffBits(uint32_t stuff_region_bits)
{
    if (stuff_region_bits < 5U)
    {
        return 0U;
    }

    return (stuff_region_bits - 1U) / 4U;
}

/**
 * @brief 计算标准 11 位经典 CAN 数据帧的保守最坏总位数。
 * @param frame 周期报文配置。
 * @return 保守最坏总位数。
 *
 * @note 计算链路:
 *       N_total,worst = N_base + N_stuff,max
 */
static uint32_t CanClassic_WorstFrameBits(const CanPeriodicFrame_t *frame)
{
    const uint32_t stuff_region_bits = CanClassic_StuffRegionBits(frame);
    const uint32_t base_bits = CanClassic_BaseBits(frame);

    return base_bits + CanClassic_WorstStuffBits(stuff_region_bits);
}

/**
 * @brief 将最坏总位数映射为保守最坏发送时间。
 * @param frame 周期报文配置。
 * @param bitrate_hz 总线比特率，单位 bit/s。
 * @return 最坏发送时间，单位 us。
 *
 * @note 时间映射公式:
 *       C_i = ceil(N_total,worst / bitrate) seconds
 *           = ceil(N_total,worst * 1e6 / bitrate) us
 */
static uint32_t CanClassic_TxTimeWorstUs(const CanPeriodicFrame_t *frame, uint32_t bitrate_hz)
{
    const uint32_t worst_bits = CanClassic_WorstFrameBits(frame);

    return Can_CeilDivU64ToU32((uint64_t)worst_bits * CAN_TIME_ONE_SECOND_US, bitrate_hz);
}

static uint32_t CanClassic_OneBitTimeUs(uint32_t bitrate_hz)
{
    return Can_CeilDivU64ToU32(CAN_TIME_ONE_SECOND_US, bitrate_hz);
}

static bool Can_IsHigherPriority(uint16_t candidate_id, uint16_t target_id)
{
    /*
     * 经典标准帧仲裁中，数值越小优先级越高。
     * 这里有意把优先级关系显式写出来，避免后续把“ID 配置”
     * 当成和实时性无关的纯协议字段。
     */
    return (candidate_id < target_id);
}

/**
 * @brief 计算目标报文受到的最大低优先级整帧阻塞。
 * @param slots 周期报文槽位表。
 * @param slot_count 槽位数量。
 * @param target_index 目标报文索引。
 * @param bitrate_hz 总线比特率，单位 bit/s。
 * @return 最大低优先级阻塞时间，单位 us。
 *
 * @note 一旦低优先级报文已经在总线上成功起发，高优先级报文不能中途抢占，
 *       因此最坏情况下目标报文会先被一条“比它优先级更低但刚好先起发”的帧整帧阻塞:
 *       B_i = max_{k ∈ lp(i)} C_k
 */
static uint32_t CanSched_ComputeBlockingUs(const CanPeriodicSlot_t *slots,
                                           uint8_t slot_count,
                                           uint8_t target_index,
                                           uint32_t bitrate_hz)
{
    uint32_t blocking_us = 0U;
    uint8_t i;
    const uint16_t target_id = slots[target_index].cfg.std_id;

    for (i = 0U; i < slot_count; ++i)
    {
        uint32_t candidate_us;

        if ((i == target_index) || (!slots[i].cfg.enabled))
        {
            continue;
        }

        if (Can_IsHigherPriority(slots[i].cfg.std_id, target_id))
        {
            continue;
        }

        candidate_us = CanClassic_TxTimeWorstUs(&slots[i].cfg, bitrate_hz);
        blocking_us = Can_MaxU32(blocking_us, candidate_us);
    }

    return blocking_us;
}

/**
 * @brief 计算在给定响应时间窗口内，高优先级报文对目标报文的干扰总时间。
 * @param slots 周期报文槽位表。
 * @param slot_count 槽位数量。
 * @param target_index 目标报文索引。
 * @param bitrate_hz 总线比特率，单位 bit/s。
 * @param window_us 当前分析窗口，单位 us。
 * @return 干扰总时间，单位 us。
 *
 * @note 采用固定点分析常见的保守写法:
 *       I_i(R) = Σ ceil((R + J_j + tau_bit) / T_j) * C_j
 *
 *       其中:
 *       - R 是当前待求响应时间窗口
 *       - J_j 是高优先级报文 j 的释放抖动
 *       - tau_bit 是 1 bit 时间，用来覆盖“窗口边界前 1 bit 起发”的最坏相位
 *       - T_j 是高优先级报文周期
 */
static uint32_t CanSched_ComputeInterferenceUs(const CanPeriodicSlot_t *slots,
                                               uint8_t slot_count,
                                               uint8_t target_index,
                                               uint32_t bitrate_hz,
                                               uint32_t window_us)
{
    uint64_t sum_us = 0ULL;
    uint8_t i;
    const uint16_t target_id = slots[target_index].cfg.std_id;
    const uint32_t bit_time_us = CanClassic_OneBitTimeUs(bitrate_hz);

    for (i = 0U; i < slot_count; ++i)
    {
        uint32_t jobs;
        uint32_t tx_us;

        if ((i == target_index) || (!slots[i].cfg.enabled))
        {
            continue;
        }

        if (!Can_IsHigherPriority(slots[i].cfg.std_id, target_id))
        {
            continue;
        }

        if (slots[i].cfg.period_us == 0U)
        {
            continue;
        }

        tx_us = CanClassic_TxTimeWorstUs(&slots[i].cfg, bitrate_hz);
        jobs = Can_CeilDivU64ToU32((uint64_t)window_us +
                                   (uint64_t)slots[i].cfg.release_jitter_us +
                                   (uint64_t)bit_time_us,
                                   slots[i].cfg.period_us);

        sum_us += (uint64_t)jobs * (uint64_t)tx_us;
        if (sum_us > (uint64_t)CAN_ANALYSIS_MAX_SUM_US)
        {
            return CAN_ANALYSIS_MAX_SUM_US;
        }
    }

    return (uint32_t)sum_us;
}

/**
 * @brief 计算目标报文在无错误稳态下的保守最坏响应时间。
 * @param slots 周期报文槽位表。
 * @param slot_count 槽位数量。
 * @param target_index 目标报文索引。
 * @param bitrate_hz 总线比特率，单位 bit/s。
 * @param out_response_us 输出最坏响应时间，单位 us。
 * @retval true  收敛成功。
 * @retval false 迭代未收敛或参数非法。
 *
 * @note 固定点方程:
 *       R_i^(n+1) = J_i + C_i + B_i + I_i(R_i^n)
 *
 *       这里把自身释放抖动 J_i 显式保留下来，是因为很多 STM32 工程里
 *       报文并不是在硬定时中断里立刻入邮箱，而是由任务调度、互斥锁或 DMA
 *       回调把“业务周期”进一步打碎成 release jitter。
 */
static bool CanSched_ComputeWorstResponseUs(const CanPeriodicSlot_t *slots,
                                            uint8_t slot_count,
                                            uint8_t target_index,
                                            uint32_t bitrate_hz,
                                            uint32_t *out_response_us)
{
    const CanPeriodicFrame_t *frame = &slots[target_index].cfg;
    const uint32_t own_jitter_us = frame->release_jitter_us;
    const uint32_t tx_us = CanClassic_TxTimeWorstUs(frame, bitrate_hz);
    const uint32_t blocking_us = CanSched_ComputeBlockingUs(slots, slot_count, target_index, bitrate_hz);
    uint32_t response_prev_us = own_jitter_us + tx_us + blocking_us;
    uint8_t iter;

    if ((out_response_us == NULL) || (bitrate_hz == 0U))
    {
        return false;
    }

    for (iter = 0U; iter < CAN_ANALYSIS_MAX_ITER; ++iter)
    {
        uint32_t interference_us =
            CanSched_ComputeInterferenceUs(slots, slot_count, target_index, bitrate_hz, response_prev_us);
        uint32_t response_next_us = own_jitter_us + tx_us + blocking_us + interference_us;

        if (response_next_us > CAN_ANALYSIS_MAX_RESPONSE_US)
        {
            *out_response_us = response_next_us;
            return false;
        }

        if (response_next_us == response_prev_us)
        {
            *out_response_us = response_next_us;
            return true;
        }

        response_prev_us = response_next_us;
    }

    *out_response_us = response_prev_us;
    return false;
}

/**
 * @brief 根据配置构造 bxCAN 发送头。
 * @param frame 周期报文配置。
 * @param header 输出头部。
 */
static void CanSched_BuildTxHeader(const CanPeriodicFrame_t *frame, CAN_TxHeaderTypeDef *header)
{
    memset(header, 0, sizeof(*header));

    header->StdId = frame->std_id & 0x7FFU;
    header->IDE = CAN_ID_STD;
    header->RTR = CAN_RTR_DATA;
    header->DLC = Can_ClampDlc(frame->dlc);
    header->TransmitGlobalTime = DISABLE;
}

/**
 * @brief 尝试释放一个周期报文；若最坏响应时间已超过 deadline，则本周期直接丢弃。
 * @param node 周期节点对象。
 * @param slot_index 目标槽位索引。
 * @param now_us 当前时间戳，单位 us。
 * @retval true  本次已成功入邮箱，或当前未到释放时刻。
 * @retval false 已到释放时刻，但因 deadline 不可满足、邮箱无空位或 HAL 发送失败而未发出。
 *
 * @note 这里的门控逻辑是：
 *       1. 到达释放时刻后，先算这条报文的保守最坏响应时间 R_i；
 *       2. 若 R_i > D_i，说明即使此刻释放也无法在最坏情况下守住 deadline，
 *          则宁可显式丢弃并计数，也不把不可兑现的报文继续堆进总线；
 *       3. 只有在预算可满足且邮箱有空位时，才调用 HAL_CAN_AddTxMessage()。
 */
static bool CanSched_TryReleaseSlot(CanPeriodicNode_t *node, uint8_t slot_index, uint32_t now_us)
{
    CanPeriodicSlot_t *slot;
    CAN_TxHeaderTypeDef tx_header;
    uint32_t tx_mailbox;
    uint32_t response_us;

    if ((node == NULL) || (slot_index >= node->slot_count))
    {
        return false;
    }

    slot = &node->slots[slot_index];

    if ((!slot->cfg.enabled) || (slot->cfg.period_us == 0U))
    {
        return true;
    }

    if ((slot->last_release_us != 0U) &&
        ((uint32_t)(now_us - slot->last_release_us) < slot->cfg.period_us))
    {
        return true;
    }

    if (!CanSched_ComputeWorstResponseUs(node->slots,
                                         node->slot_count,
                                         slot_index,
                                         node->bitrate_hz,
                                         &response_us))
    {
        slot->last_wcrt_us = response_us;
        slot->dropped_deadline_count++;
        slot->last_release_us = now_us;
        return false;
    }

    slot->last_wcrt_us = response_us;
    if (response_us > slot->cfg.deadline_us)
    {
        slot->dropped_deadline_count++;
        slot->last_release_us = now_us;
        return false;
    }

    if (HAL_CAN_GetTxMailboxesFreeLevel(node->hcan) == 0U)
    {
        /*
         * 邮箱无空位时不更新时间戳，让该周期报文在下一次调度 tick 继续尝试；
         * 这样做承认了“邮箱资源”同样是实时链路的一部分，而不是透明黑盒。
         */
        return false;
    }

    CanSched_BuildTxHeader(&slot->cfg, &tx_header);
    if (HAL_CAN_AddTxMessage(node->hcan,
                             &tx_header,
                             (uint8_t *)slot->cfg.payload,
                             &tx_mailbox) != HAL_OK)
    {
        return false;
    }

    slot->last_release_us = now_us;
    return true;
}

/**
 * @brief 初始化 bxCAN 节点的关键发送策略。
 * @param node 周期节点对象。
 * @param hcan CAN 句柄。
 * @param htim_timebase 1 MHz 自由运行时间基。
 * @param bitrate_hz 总线比特率，单位 bit/s。
 * @retval true  初始化成功。
 * @retval false HAL 初始化或启动失败。
 *
 * @note 对 bxCAN 来说，若要让“ID 小者优先”的仲裁语义在多个待发邮箱之间保持成立，
 *       必须把 TransmitFifoPriority 设为 DISABLE。否则软件入队顺序会覆盖标识符优先级。
 */
bool CanSched_NodeInit(CanPeriodicNode_t *node,
                       CAN_HandleTypeDef *hcan,
                       TIM_HandleTypeDef *htim_timebase,
                       uint32_t bitrate_hz)
{
    if ((node == NULL) || (hcan == NULL) || (htim_timebase == NULL) || (bitrate_hz == 0U))
    {
        return false;
    }

    memset(node, 0, sizeof(*node));
    node->hcan = hcan;
    node->htim_timebase = htim_timebase;
    node->bitrate_hz = bitrate_hz;

    hcan->Init.AutoRetransmission = ENABLE;
    hcan->Init.TransmitFifoPriority = DISABLE;

    if (HAL_CAN_Init(hcan) != HAL_OK)
    {
        return false;
    }

    if (HAL_CAN_Start(hcan) != HAL_OK)
    {
        return false;
    }

    HAL_TIM_Base_Start(htim_timebase);
    return true;
}

/**
 * @brief 注册一个周期报文槽位。
 * @param node 周期节点对象。
 * @param frame 周期报文配置。
 * @retval true  注册成功。
 * @retval false 槽位已满或参数非法。
 */
bool CanSched_RegisterFrame(CanPeriodicNode_t *node, const CanPeriodicFrame_t *frame)
{
    CanPeriodicSlot_t *slot;

    if ((node == NULL) || (frame == NULL) || (node->slot_count >= CAN_SCHED_MAX_FRAMES))
    {
        return false;
    }

    slot = &node->slots[node->slot_count];
    memset(slot, 0, sizeof(*slot));
    slot->cfg = *frame;
    slot->cfg.dlc = Can_ClampDlc(frame->dlc);
    node->slot_count++;
    return true;
}

/**
 * @brief 周期发送调度入口，建议在主循环或 1 kHz 任务中调用。
 * @param node 周期节点对象。
 *
 * @note 调度顺序显式按槽位遍历即可，因为真正的总线优先级由 ID 决定；
 *       但在软件层仍应优先把高优先级短帧配置为更小的 ID，避免分析与现场脱节。
 */
void CanSched_RunOnce(CanPeriodicNode_t *node)
{
    uint32_t now_us;
    uint8_t i;

    if (node == NULL)
    {
        return;
    }

    now_us = Can_GetTimestampUs(node->htim_timebase);
    for (i = 0U; i < node->slot_count; ++i)
    {
        (void)CanSched_TryReleaseSlot(node, i, now_us);
    }
}

extern CAN_HandleTypeDef hcan1;
extern TIM_HandleTypeDef htim2;

static CanPeriodicNode_t g_can_node;

void App_CanPeriodicPublisherInit(void)
{
    const CanPeriodicFrame_t torque_cmd =
    {
        .std_id = 0x080U,
        .dlc = 2U,
        .period_us = 1000U,
        .deadline_us = 900U,
        .release_jitter_us = 60U,
        .payload = {0x12U, 0x34U},
        .enabled = true
    };

    const CanPeriodicFrame_t imu_status =
    {
        .std_id = 0x120U,
        .dlc = 8U,
        .period_us = 5000U,
        .deadline_us = 3500U,
        .release_jitter_us = 120U,
        .payload = {0},
        .enabled = true
    };

    const CanPeriodicFrame_t diag_snapshot =
    {
        .std_id = 0x300U,
        .dlc = 8U,
        .period_us = 20000U,
        .deadline_us = 15000U,
        .release_jitter_us = 200U,
        .payload = {0},
        .enabled = true
    };

    if (!CanSched_NodeInit(&g_can_node, &hcan1, &htim2, 500000U))
    {
        return;
    }

    (void)CanSched_RegisterFrame(&g_can_node, &torque_cmd);
    (void)CanSched_RegisterFrame(&g_can_node, &imu_status);
    (void)CanSched_RegisterFrame(&g_can_node, &diag_snapshot);
}

void App_CanPeriodicPublisherTask(void)
{
    /*
     * 在主循环或 1 kHz 周期任务中调用该函数。
     * 每次释放前，系统都会重新按“最坏帧长 + 优先级阻塞 + 高优先级干扰”
     * 预算本周期是否仍能守住 deadline。
     */
    CanSched_RunOnce(&g_can_node);
}
```

这段实现里有几处工程重点值得单独拎出来：

- `CanClassic_WorstStuffBits()` 没有去猜具体 payload 会不会触发多少次位填充，而是直接用保守上界 `floor((N_sr - 1) / 4)` 做预算，避免把一次抓包的“平均帧长”误当成长期实时边界。
- `CanSched_ComputeBlockingUs()` 把低优先级整帧阻塞显式建模出来，承认 CAN 是“按位仲裁、整帧非抢占”的协议，而不是理想的可抢占固定优先级队列。
- `CanSched_ComputeWorstResponseUs()` 用固定点方程把 `release jitter`、`blocking` 和 `interference` 摊开写清楚，让 deadline 讨论回到一个能算、能复核、能和物理位时间对得上的数学对象上。
- `CanSched_TryReleaseSlot()` 先算最坏响应时间，再决定要不要入邮箱；这比“所有报文到点就直接发”更接近工程现实，因为真正的系统目标不是把邮箱塞满，而是让关键帧按时说完话。
- `CanSched_NodeInit()` 强调了 `TransmitFifoPriority = DISABLE`，这是 bxCAN 上最容易被忽略、却会直接破坏优先级语义的一处配置边界。

如果继续往前扩展，这套骨架还可以进一步加入：

- 29 位扩展帧与远程帧的独立位数模型。
- `Bus-Off` 恢复、ACK 缺失重发和错误主动帧的异常通信预算。
- 基于观测 payload 模式的在线帧长统计，用于把“保守最坏上界”和“现场典型占线”并排监控。

但无论怎么扩展，底层原则都不会变：**CAN 的实时性从来不是“负载大概够不够”的问题，而是最坏位数、最坏阻塞和最坏干扰在同一条总线时间轴上能否同时装得下的问题。**
