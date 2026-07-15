---
title: "技能档案：CAN ACK 缺失、自动重发与发送截止期预算"
slug: "skill-can-ack-missing-auto-retry-and-transmission-deadline-budget"
date: 2026-05-25T14:11:54+08:00
draft: false
description: "从 ACK 槽显性位、错误主动帧到发送邮箱回压，系统拆解 CAN 自动重发为何会把可靠送达与实时截止期推向同一条时域边界。"
tags: ["CAN", "STM32", "ACK", "自动重发", "实时调度", "总线时序", "嵌入式"]
categories: ["技能档案", "工业通信"]
image: ""
---

## 技能概述

CAN 在工程上最难处理的，往往不是仲裁，也不是 Bus-Off，而是“这帧到底该不该无限重发”。电机控制心跳、驱动使能、制动释放、接触器闭合确认这类消息，既要求尽可能送达，又带着明确的截止期。一旦接收端掉线、过滤器配置错误、终端电阻异常或网络分段，发送端就会在 ACK 槽读不到显性位，随后自动触发错误帧与重发。问题从这一刻起就不再只是通信可靠性，而是实时调度冲突: 你是让报文继续占用总线直到有人响应，还是在超过控制窗口后主动放弃，把带宽让给仍然有意义的消息。

## 核心底层概念解析

- **ACK 槽不是“礼貌性回执”，而是总线对帧存在性的物理背书**: 发送节点在 ACK 槽发送 **隐性位**，任何正确接收了该帧的节点都必须把它覆写成 **显性位**。因此 ACK 本质上是一场线与电路上的共识投票，不是软件层的业务应答。
- **ACK 缺失并不说明 CRC 错了，它只说明“没有人愿意承认收到”**: 可能是总线上只有一个节点、接收端处于初始化模式、过滤器没放行、波特率不一致、收发器掉电，或者帧在更早阶段就被别的节点判错。发送端只看到一件事: 采样点读到的 ACK 仍是隐性位。
- **自动重发是协议级可靠性机制，但它不理解你的任务截止期**: 经典 CAN 控制器在发送失败后，会保留原帧并重新参与下一轮仲裁。它保证“尽量送达”，却不知道这条报文是否还赶得上 `1 ms` 电流环、`10 ms` 心跳或 `50 ms` 继电器时序。
- **错误主动帧会把一次 ACK 缺失扩展成额外时域开销**: 当发送方检测到 ACK Error，会立刻注入 **Active Error Flag**。这 6 个显性位会破坏当前帧尾，随后还要经历错误定界与重发间隙。于是一次失败发送消耗的，并不是“一帧时间”，而是“失败帧时间 + 错误帧时间 + intermission + 下一次仲裁等待”。
- **截止期预算首先取决于最坏帧长，而不是 8 字节负载**: 标准帧从 SOF 到 EOF 的基础字段已固定，再叠加位填充后，可近似按最坏位数估计发送时间:
  `T_frame_worst ~= N_bits_worst / bitrate`
  若再考虑一次 ACK 缺失引发的错误主动帧与重发，则单次尝试的占用时间接近:
  `T_attempt ~= T_frame_worst + T_error_flag + T_delim + T_intermission`
- **重发次数上限其实是实时系统里的资源约束**: 对一条截止期为 `D_deadline` 的报文，在最坏情况下允许的尝试次数可粗略写成:
  `N_retry_max = floor(D_deadline / T_attempt)`
  如果控制器开启无限自动重发，而 `N_retry_max` 在业务上只允许 1 或 2，那么硬件的“可靠”会反过来破坏系统整体的“准时”。
- **邮箱回压是自动重发的第二层副作用**: `bxCAN` 发送失败后邮箱会持续占用，后续低优先级或同优先级消息可能根本装不进去。于是问题不再局限于一帧是否送达，而是逐步演化成发送队列阻塞，最终拖垮应用层调度。
- **ACK 缺失与仲裁失败的时域性质完全不同**: 仲裁失败是健康竞争，失败节点立刻转接收，且不会产生错误帧；ACK 缺失则意味着“这帧已经走完整条链路，但全网没有确认者”，因此必然伴随错误处理与错误计数增长。前者是优先级问题，后者是可达性问题。
- **Error Passive 会改变错误旗标的物理存在感**: 节点从 Error Active 进入 Error Passive 后，发送的被动错误标志不再用显性位强行破坏总线。这意味着同样是 ACK/位错误，不同错误状态下对其他节点时序的扰动强度并不相同。
- **“有没有接收者”与“接收者有没有业务处理”必须分层**: ACK 只证明至少一个节点在物理和链路层接受了这帧，不能代表上层应用已消费。工程里若把 ACK 当业务确认，会把链路存在性与系统状态一致性混成一件事。
- **调试 ACK 问题时，先看物理共识，再看协议配置**: 示波器先确认 ACK 槽有没有显性位，逻辑分析仪再看错误帧位置，随后检查过滤器、静默模式、回环模式、终端电阻和节点掉电。直接从 `HAL_CAN_AddTxMessage()` 的返回值倒推，多半只会得到“邮箱忙”这种二次症状。
- **可靠与实时从来不是谁更高级，而是谁先耗尽预算**: 对诊断日志，自动重发很合理；对急停释放、PWM 更新触发或同步采样广播，过期后再送达往往比丢弃更危险。总线协议提供的是能力，上层系统必须补上截止期语义。

## 代码能力展现

下面给出一个基于 STM32 HAL `bxCAN` 的发送守卫示例。设计重点有三件事: 第一，显式估算最坏帧时长和重发预算，而不是盲信自动重发；第二，把 ACK 缺失和邮箱占用转成可观测计数；第三，对存在截止期的报文使用“有限重试 + 过期丢弃”，避免旧消息长时间堵塞总线。

```c
#include "main.h"

#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#define CAN_STD_ID_MASK                         0x07FFU
#define CAN_TX_DLC_MAX                          8U
#define CAN_TX_RETRY_CAP                        8U
#define CAN_TX_TEC_ACK_ERROR_STEP               8U
#define CAN_TX_ERROR_FLAG_BITS_ACTIVE           6U
#define CAN_TX_ERROR_DELIMITER_BITS             8U
#define CAN_TX_INTERMISSION_BITS                3U
#define CAN_TX_STD_BASE_BITS                    47U
#define CAN_TX_STD_WORST_STUFF_BITS             10U

typedef enum
{
    CAN_TX_RESULT_OK = 0,
    CAN_TX_RESULT_DEFERRED,
    CAN_TX_RESULT_EXPIRED,
    CAN_TX_RESULT_DROPPED,
    CAN_TX_RESULT_ERROR
} CanTxResult_t;

typedef struct
{
    uint16_t std_id;
    uint8_t dlc;
    uint8_t data[CAN_TX_DLC_MAX];
    uint32_t enqueue_tick_ms;
    uint32_t deadline_tick_ms;
    uint8_t max_retries;
    uint8_t retry_count;
    bool critical;
    bool pending;
} CanTxFrame_t;

typedef struct
{
    CAN_HandleTypeDef *hcan;
    uint32_t bitrate_hz;
    uint32_t worst_attempt_time_us;
    uint32_t ack_error_count;
    uint32_t expired_drop_count;
    uint32_t mailbox_busy_count;
    uint32_t success_count;
    uint32_t last_error_code;
    CanTxFrame_t active_frame;
} CanTxGuard_t;

static uint32_t CanTx_ClampU32(uint32_t value, uint32_t min_value, uint32_t max_value)
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

static uint8_t CanTx_ClampU8(uint8_t value, uint8_t min_value, uint8_t max_value)
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

static bool CanTx_IsDeadlinePassed(uint32_t now_ms, uint32_t deadline_ms)
{
    return ((int32_t)(now_ms - deadline_ms) >= 0);
}

/**
 * @brief 估算标准数据帧的最坏发送尝试时间，含 ACK 缺失后的错误帧开销。
 * @param bitrate_hz 总线波特率。
 * @param dlc 数据长度，范围 0~8。
 * @return 单次发送尝试的最坏时间，单位 us。
 *
 * @note 标准帧最坏位数可粗略近似为:
 *       N_frame_worst = N_base + N_payload + N_stuff
 *                     = 47 + 8 * dlc + 10
 *
 *       其中 47 覆盖 SOF、仲裁、控制、CRC、ACK、EOF 等基础字段，
 *       `10` 为工程上保守采用的最坏位填充近似上界。
 *
 *       当 ACK 缺失时，Error Active 节点会再发送 6 个显性错误位，
 *       其后还有错误定界与 3 bit intermission，因此:
 *       T_attempt ~= (N_frame_worst + 6 + 8 + 3) / bitrate
 */
static uint32_t CanTx_ComputeWorstAttemptUs(uint32_t bitrate_hz, uint8_t dlc)
{
    const uint32_t bounded_dlc = CanTx_ClampU32(dlc, 0U, CAN_TX_DLC_MAX);
    const uint32_t worst_bits = CAN_TX_STD_BASE_BITS +
                                (8U * bounded_dlc) +
                                CAN_TX_STD_WORST_STUFF_BITS +
                                CAN_TX_ERROR_FLAG_BITS_ACTIVE +
                                CAN_TX_ERROR_DELIMITER_BITS +
                                CAN_TX_INTERMISSION_BITS;

    if (bitrate_hz == 0U)
    {
        return 0U;
    }

    return (uint32_t)(((uint64_t)worst_bits * 1000000ULL + (bitrate_hz - 1U)) / bitrate_hz);
}

/**
 * @brief 根据截止期预算自动收敛最大重试次数。
 * @param guard 发送守卫对象。
 * @param deadline_ms 相对当前时刻的截止期，单位 ms。
 * @return 允许的最大重试次数，至少为 0，至多为 CAN_TX_RETRY_CAP。
 *
 * @note 若一帧从入队到失效总预算为 `D_deadline`，单次最坏尝试耗时为 `T_attempt`，
 *       则最多允许:
 *       N_retry_max = floor(D_deadline / T_attempt) - 1
 *
 *       这里减 1 的原因是“首次发送”本身已经占用了一次尝试预算。
 */
static uint8_t CanTx_ComputeRetryBudget(const CanTxGuard_t *guard, uint32_t deadline_ms)
{
    uint32_t total_attempts;

    if ((guard == NULL) || (guard->worst_attempt_time_us == 0U))
    {
        return 0U;
    }

    total_attempts = (deadline_ms * 1000U) / guard->worst_attempt_time_us;
    if (total_attempts == 0U)
    {
        return 0U;
    }

    if (total_attempts > 0U)
    {
        total_attempts -= 1U;
    }

    return (uint8_t)CanTx_ClampU32(total_attempts, 0U, CAN_TX_RETRY_CAP);
}

/**
 * @brief 初始化 CAN 发送守卫。
 * @param guard 发送守卫对象。
 * @param hcan HAL CAN 句柄。
 * @param bitrate_hz 当前总线波特率。
 * @retval true 初始化成功。
 * @retval false 参数非法。
 */
bool CanTxGuard_Init(CanTxGuard_t *guard, CAN_HandleTypeDef *hcan, uint32_t bitrate_hz)
{
    if ((guard == NULL) || (hcan == NULL) || (bitrate_hz == 0U))
    {
        return false;
    }

    memset(guard, 0, sizeof(*guard));
    guard->hcan = hcan;
    guard->bitrate_hz = bitrate_hz;
    guard->worst_attempt_time_us = CanTx_ComputeWorstAttemptUs(bitrate_hz, CAN_TX_DLC_MAX);
    return true;
}

static HAL_StatusTypeDef CanTx_StartMailbox(CanTxGuard_t *guard, const CanTxFrame_t *frame)
{
    CAN_TxHeaderTypeDef tx_header;
    uint32_t mailbox = 0U;

    if ((guard == NULL) || (frame == NULL))
    {
        return HAL_ERROR;
    }

    if (HAL_CAN_GetTxMailboxesFreeLevel(guard->hcan) == 0U)
    {
        guard->mailbox_busy_count++;
        return HAL_BUSY;
    }

    memset(&tx_header, 0, sizeof(tx_header));
    tx_header.StdId = frame->std_id & CAN_STD_ID_MASK;
    tx_header.IDE = CAN_ID_STD;
    tx_header.RTR = CAN_RTR_DATA;
    tx_header.DLC = frame->dlc;
    tx_header.TransmitGlobalTime = DISABLE;

    return HAL_CAN_AddTxMessage(guard->hcan, &tx_header, (uint8_t *)frame->data, &mailbox);
}

/**
 * @brief 提交一帧带截止期语义的标准数据帧。
 * @param guard 发送守卫对象。
 * @param std_id 11 位标准 ID。
 * @param payload 数据负载。
 * @param dlc 数据长度，范围 0~8。
 * @param relative_deadline_ms 相对当前的截止期，单位 ms。
 * @param critical 是否为关键帧。关键帧会按截止期预算自动给出有限重试次数。
 * @return 发送结果。
 */
CanTxResult_t CanTxGuard_Submit(CanTxGuard_t *guard,
                                uint16_t std_id,
                                const uint8_t *payload,
                                uint8_t dlc,
                                uint32_t relative_deadline_ms,
                                bool critical)
{
    CanTxFrame_t frame;
    const uint32_t now_ms = HAL_GetTick();

    if ((guard == NULL) || (payload == NULL))
    {
        return CAN_TX_RESULT_ERROR;
    }

    memset(&frame, 0, sizeof(frame));
    frame.std_id = (uint16_t)(std_id & CAN_STD_ID_MASK);
    frame.dlc = CanTx_ClampU8(dlc, 0U, CAN_TX_DLC_MAX);
    memcpy(frame.data, payload, frame.dlc);
    frame.enqueue_tick_ms = now_ms;
    frame.deadline_tick_ms = now_ms + relative_deadline_ms;
    frame.critical = critical;
    frame.max_retries = critical ? CanTx_ComputeRetryBudget(guard, relative_deadline_ms) : 0U;
    frame.pending = true;

    if (relative_deadline_ms == 0U)
    {
        guard->expired_drop_count++;
        return CAN_TX_RESULT_EXPIRED;
    }

    if (CanTx_StartMailbox(guard, &frame) != HAL_OK)
    {
        guard->active_frame = frame;
        return CAN_TX_RESULT_DEFERRED;
    }

    guard->active_frame = frame;
    return CAN_TX_RESULT_OK;
}

/**
 * @brief 在主循环中处理 ACK 缺失后的有限重试与过期丢弃。
 * @param guard 发送守卫对象。
 *
 * @note 该函数假设 ACK 缺失或其它发送错误会在错误回调中更新 `last_error_code`。
 *       若关键帧已过截止期，或重试次数超出预算，则主动中止该帧的后续发送意义。
 */
void CanTxGuard_Process(CanTxGuard_t *guard)
{
    HAL_StatusTypeDef hal_status;
    const uint32_t now_ms = HAL_GetTick();

    if ((guard == NULL) || (!guard->active_frame.pending))
    {
        return;
    }

    if (CanTx_IsDeadlinePassed(now_ms, guard->active_frame.deadline_tick_ms))
    {
        /*
         * 这里不尝试“挽救”已过期报文。对实时系统而言，
         * 过期后的成功送达可能比直接丢弃更具破坏性。
         */
        memset(&guard->active_frame, 0, sizeof(guard->active_frame));
        guard->expired_drop_count++;
        return;
    }

    if ((guard->last_error_code & HAL_CAN_ERROR_ACK) == 0U)
    {
        return;
    }

    guard->last_error_code = HAL_CAN_ERROR_NONE;
    guard->ack_error_count++;

    if (guard->active_frame.retry_count >= guard->active_frame.max_retries)
    {
        memset(&guard->active_frame, 0, sizeof(guard->active_frame));
        return;
    }

    guard->active_frame.retry_count++;
    hal_status = CanTx_StartMailbox(guard, &guard->active_frame);
    if (hal_status != HAL_OK)
    {
        return;
    }
}

/**
 * @brief 在 HAL 发送完成回调中清空活动帧。
 * @param guard 发送守卫对象。
 */
void CanTxGuard_OnTxComplete(CanTxGuard_t *guard)
{
    if (guard == NULL)
    {
        return;
    }

    if (guard->active_frame.pending)
    {
        guard->success_count++;
    }

    memset(&guard->active_frame, 0, sizeof(guard->active_frame));
}

/**
 * @brief 在 HAL 错误回调中锁存 ACK Error 等发送错误。
 * @param guard 发送守卫对象。
 *
 * @note ACK 缺失会导致 TEC 增长。经典控制器里 ACK Error 对发送错误计数的
 *       增量通常按 8 计，因此连续多次无接收者时会快速逼近 Error Passive / Bus-Off。
 *       这里不直接在中断里重发，而是把信息上抛给主循环处理，避免中断上下文失控。
 */
void CanTxGuard_OnError(CanTxGuard_t *guard)
{
    if ((guard == NULL) || (guard->hcan == NULL))
    {
        return;
    }

    guard->last_error_code = HAL_CAN_GetError(guard->hcan);

    if ((guard->last_error_code & HAL_CAN_ERROR_ACK) != 0U)
    {
        /* 仅做显式注释，不在这里直接修改 TEC；
         * TEC 由控制器硬件维护，软件只统计 ACK 缺失事件次数。
         */
        (void)CAN_TX_TEC_ACK_ERROR_STEP;
    }
}

/*
 * 典型用法:
 *
 * static CanTxGuard_t g_can1_tx_guard;
 *
 * void App_CanTxInit(void)
 * {
 *     (void)CanTxGuard_Init(&g_can1_tx_guard, &hcan1, 500000U);
 * }
 *
 * void App_SendHeartbeat(void)
 * {
 *     const uint8_t heartbeat[2] = {0xA5U, 0x5AU};
 *
 *     // 10 ms 心跳，若 10 ms 内收不到 ACK，则最多允许有限次重试。
 *     (void)CanTxGuard_Submit(&g_can1_tx_guard,
 *                             0x241U,
 *                             heartbeat,
 *                             2U,
 *                             10U,
 *                             true);
 * }
 *
 * void App_1msTask(void)
 * {
 *     CanTxGuard_Process(&g_can1_tx_guard);
 * }
 *
 * void HAL_CAN_ErrorCallback(CAN_HandleTypeDef *hcan)
 * {
 *     if (hcan == g_can1_tx_guard.hcan)
 *     {
 *         CanTxGuard_OnError(&g_can1_tx_guard);
 *     }
 * }
 *
 * void HAL_CAN_TxMailbox0CompleteCallback(CAN_HandleTypeDef *hcan)
 * {
 *     if (hcan == g_can1_tx_guard.hcan)
 *     {
 *         CanTxGuard_OnTxComplete(&g_can1_tx_guard);
 *     }
 * }
 */
```

这段实现刻意把“自动重发”从一个默认开启的硬件特性，收敛成一份带截止期的工程合同。公式层面它显式暴露了 `T_attempt` 与 `N_retry_max`，让可靠性预算和实时预算出现在同一页纸上；代码层面它避免在中断里无脑递归重发，而是把 ACK 缺失、邮箱回压、过期丢弃分层处理。对诊断帧，你完全可以把 `critical` 关掉，让它只做一次发送；对心跳、同步触发和窗口敏感的控制帧，则应该让“过期即丢弃”成为协议之上的系统原则。CAN 负责告诉你有没有人承认这帧存在，至于这帧是否还值得继续存在，必须由你的实时系统自己裁决。
