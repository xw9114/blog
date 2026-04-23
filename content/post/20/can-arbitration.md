---
title: "技能档案：CAN 总线仲裁的底层逻辑，从“线与”电路到非破坏性竞争"
slug: "skill-can-bus-arbitration-wired-and-non-destructive-contention"
date: 2026-04-23T19:04:40+08:00
draft: false
description: "从显性/隐性位、同步采样点、位填充到错误封闭，系统拆解 CAN 总线为何能在冲突中完成非破坏性仲裁。"
tags: ["CAN", "STM32", "总线", "工业通信", "嵌入式"]
categories: ["技能档案"]
image: ""
---

## 技能概述

CAN 总线的价值，从来不只是“两根线挂很多节点”。它真正解决的是工业现场和车载系统里最难受的那个矛盾：多个控制器都想在有限带宽里抢占发送机会，但系统又不能接受以太网早期 CSMA/CD 那种“撞了再重发”的不确定延迟。电机控制器、BMS、VCU、伺服驱动、工业 I/O 站点之所以偏爱 CAN，是因为它把竞争前移到比特级时域，让仲裁、同步、重传和错误封闭都发生在一套严格的物理契约里。工程上真正的痛点不是 `HAL_CAN_AddTxMessage()` 调不调得通，而是你是否理解显性位如何压制隐性位、采样点如何吞掉传播延迟、ID 编排如何映射调度优先级，以及错误节点为什么必须被 TEC/REC 机制“请出总线”。

## 核心底层概念解析

- **显性位与隐性位不是抽象逻辑，而是收发器对差分总线的物理占有**：CAN 的“0/1”并不等价于 MCU GPIO 的高低电平。发送 **显性位** 时，收发器主动拉开 `CANH` 与 `CANL` 的差分；发送 **隐性位** 时，节点释放驱动，由终端电阻和偏置网络把总线恢复到空闲态。多个节点同时驱动时，显性位天然压过隐性位，于是总线表现出一种带物理基础的 **线与（wired-AND）** 行为。
- **仲裁本质是“边发边听”**：每个发送节点在输出当前位的同时，也会采样总线实际电平。若某节点打算发 **隐性 1**，却在采样点读到 **显性 0**，它立刻知道总线上存在更高优先级报文，于是停止发送、转入接收。因为显性位会覆盖隐性位，获胜报文的比特流没有被破坏，所以这叫 **非破坏性竞争**，它和“碰撞后双方都损坏”的总线模型完全不是一个世界观。
- **低 ID 高优先级，不是协议任性，而是位级比较的必然结果**：标准帧 11 位 ID 从高位到低位依次参与仲裁，越早出现显性位的一方越占优势。因此高优先级语义必须放在 ID 的高位，才能更早决定胜负。CAN ID 不是“报文编号”，它其实是分布式调度器的一部分。
- **位时序不是一个波特率参数，而是一整段时域预算**：一个 CAN 位时间通常拆成 `SyncSeg + BS1 + BS2`，采样点位于 `SyncSeg + BS1` 结束处。其核心约束是：
  `bitrate = f_can / (Prescaler × (1 + BS1 + BS2))`
  `sample_point = (1 + BS1) / (1 + BS1 + BS2)`
  这两个式子决定了你能容纳多少传播延迟、相位误差和晶振漂移。波特率配对正确，只代表“平均节拍差不多”；采样点错误，才是真正会让长线、分支和边沿抖动把系统拖垮的根因。
- **采样点越靠后并不总是更稳**：把采样点向后推，确实能给总线传播留更多余量，但也会压缩 `BS2` 的相位修正窗口。`BS2` 太短时，重同步能力变差；`BS2` 太长时，带宽效率和容错都受影响。工程里常见的 `80%~87.5%` 采样点不是玄学经验，而是传播时延、振荡器偏差和重同步余量之间的折中。
- **位填充不是浪费，而是为了持续制造同步边沿**：CAN 连续发送 5 个相同比特后，发送器必须自动插入一个反相填充位。它牺牲了部分净载荷效率，却保证长时间不会没有电平翻转，让各节点 PLL/重同步逻辑能持续修正本地时钟漂移。没有足够边沿密度，再漂亮的波特率公式也会被实物晶振误差击穿。
- **仲裁成功不等于帧一定送达**：ID 阶段赢了，只意味着拿到发送权。后面还有 **CRC 校验、ACK 槽、位错误、格式错误、填充错误** 等一整套完整性检查。发送节点若在 ACK 槽读不到显性位，说明没有任何接收方承认这帧存在，它会触发错误处理和后续重传。
- **错误封闭是网络层面的自我保护，而不是对单节点的惩罚**：CAN 用 **TEC/REC** 两个计数器持续衡量节点的发送/接收错误历史。节点进入 Error Passive 以后会降低“破坏力”，再严重就直接进入 **Bus-Off**，主动退出总线。这背后的哲学很明确：宁可牺牲一个行为异常的控制器，也不能让它反复把整条总线拖进错误风暴。
- **报文带宽评估不能只看 8 字节负载**：仲裁字段、控制字段、CRC、ACK、EOF、Intermission 以及位填充都会吞噬有效带宽。工程上若用“8 字节 / 500 kbps = 很快”这类口算估载，通常会在多节点同时上线、诊断报文打开、错误重发增加时被现实教育。
- **ID 设计本身就是系统架构设计**：把“急停、电流环、状态心跳、日志诊断”全部塞进随机 ID，等于把调度权交给偶然。把优先级、功能码、节点号按位域拆开，才是在用协议层结构反向约束系统行为。CAN 的优雅之处就在这里：数字 ID 最终会变成物理时域里的先后次序。

## 代码能力展现

下面给出一个基于 STM32 HAL 的经典 `bxCAN` 服务示例。代码做三件事：一是根据目标波特率和采样点搜索可用位时序；二是把 11 位标准 ID 显式拆成“优先级 + 功能码 + 节点号”，让仲裁顺序可读、可审计；三是在 `Bus-Off` 后做最小恢复调度。重点不是 API 调用本身，而是把 **时域参数、仲裁优先级和异常恢复** 统一成一套工程上可落地的约束。

```c
#include "main.h"
#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#define CAN_STD_ID_MASK                     0x7FFU
#define CAN_PRIORITY_MAX                    7U
#define CAN_FUNCTION_MAX                    15U
#define CAN_NODE_MAX                        15U

#define CAN_BAUD_MIN_HZ                     50000U
#define CAN_BAUD_MAX_HZ                     1000000U
#define CAN_SAMPLE_POINT_MIN_PERMILLE       700U
#define CAN_SAMPLE_POINT_MAX_PERMILLE       900U

#define CAN_PRESCALER_MIN                   1U
#define CAN_PRESCALER_MAX                   1024U
#define CAN_BS1_MIN_TQ                      1U
#define CAN_BS1_MAX_TQ                      16U
#define CAN_BS2_MIN_TQ                      2U
#define CAN_BS2_MAX_TQ                      8U
#define CAN_SJW_MIN_TQ                      1U
#define CAN_SJW_MAX_TQ                      4U
#define CAN_TOTAL_TQ_MIN                    8U
#define CAN_TOTAL_TQ_MAX                    25U

#define CAN_BITRATE_ERROR_LIMIT_PPM         5000U
#define CAN_BUSOFF_RECOVERY_DELAY_MS        10U

typedef enum
{
    CAN_PRIORITY_EMERGENCY = 0U,
    CAN_PRIORITY_CONTROL   = 1U,
    CAN_PRIORITY_FEEDBACK  = 2U,
    CAN_PRIORITY_STATUS    = 4U,
    CAN_PRIORITY_DIAG      = 6U,
    CAN_PRIORITY_LOG       = 7U
} CanPriority_t;

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
    bool bus_off_latched;
    uint32_t recovery_deadline_ms;
} CanService_t;

static uint32_t Can_ClampU32(uint32_t value, uint32_t min_value, uint32_t max_value)
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

static uint32_t Can_AbsDiffU32(uint32_t lhs, uint32_t rhs)
{
    return (lhs >= rhs) ? (lhs - rhs) : (rhs - lhs);
}

static uint32_t Can_Bs1ToHal(uint8_t bs1_tq)
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
        default:  return CAN_BS1_16TQ;
    }
}

static uint32_t Can_Bs2ToHal(uint8_t bs2_tq)
{
    switch (bs2_tq)
    {
        case 2U: return CAN_BS2_2TQ;
        case 3U: return CAN_BS2_3TQ;
        case 4U: return CAN_BS2_4TQ;
        case 5U: return CAN_BS2_5TQ;
        case 6U: return CAN_BS2_6TQ;
        case 7U: return CAN_BS2_7TQ;
        default: return CAN_BS2_8TQ;
    }
}

static uint32_t Can_SjwToHal(uint8_t sjw_tq)
{
    switch (sjw_tq)
    {
        case 2U: return CAN_SJW_2TQ;
        case 3U: return CAN_SJW_3TQ;
        case 4U: return CAN_SJW_4TQ;
        default: return CAN_SJW_1TQ;
    }
}

static uint16_t Can_ComposeStdId(CanPriority_t priority, uint8_t function_code, uint8_t node_id)
{
    const uint16_t safe_priority = (uint16_t)Can_ClampU32((uint32_t)priority, 0U, CAN_PRIORITY_MAX);
    const uint16_t safe_function = (uint16_t)Can_ClampU32((uint32_t)function_code, 0U, CAN_FUNCTION_MAX);
    const uint16_t safe_node = (uint16_t)Can_ClampU32((uint32_t)node_id, 0U, CAN_NODE_MAX);

    /* 11-bit 标准 ID 位域设计：
     * [10:8] -> priority
     * [7:4]  -> function
     * [3:0]  -> node
     *
     * 映射公式：
     * std_id = (priority << 8) | (function << 4) | node
     *
     * CAN 仲裁按位从 MSB 向 LSB 比较，且显性 0 会压过隐性 1。
     * 因此“越重要的语义越放在高位，且编码值越小优先级越高”。
     */
    return (uint16_t)(((safe_priority & 0x07U) << 8U)
                    | ((safe_function & 0x0FU) << 4U)
                    |  (safe_node & 0x0FU));
}

static bool Can_FindBitTiming(uint32_t can_kernel_hz,
                              uint32_t target_bitrate_hz,
                              uint16_t target_sample_point_permille,
                              CanBitTiming_t *out_timing)
{
    bool found = false;
    uint64_t best_score = UINT64_MAX;
    uint32_t total_tq;

    if ((can_kernel_hz == 0U) || (out_timing == NULL))
    {
        return false;
    }

    target_bitrate_hz = Can_ClampU32(target_bitrate_hz, CAN_BAUD_MIN_HZ, CAN_BAUD_MAX_HZ);
    target_sample_point_permille = (uint16_t)Can_ClampU32(target_sample_point_permille,
                                                          CAN_SAMPLE_POINT_MIN_PERMILLE,
                                                          CAN_SAMPLE_POINT_MAX_PERMILLE);

    memset(out_timing, 0, sizeof(*out_timing));

    for (total_tq = CAN_TOTAL_TQ_MIN; total_tq <= CAN_TOTAL_TQ_MAX; ++total_tq)
    {
        const uint64_t denominator = (uint64_t)target_bitrate_hz * (uint64_t)total_tq;
        const uint64_t prescaler_rounded = (denominator == 0U)
                                         ? 0U
                                         : (((uint64_t)can_kernel_hz + (denominator / 2U)) / denominator);
        const uint32_t prescaler = (uint32_t)prescaler_rounded;
        uint32_t bs2_tq;

        if ((prescaler < CAN_PRESCALER_MIN) || (prescaler > CAN_PRESCALER_MAX))
        {
            continue;
        }

        for (bs2_tq = CAN_BS2_MIN_TQ; bs2_tq <= CAN_BS2_MAX_TQ; ++bs2_tq)
        {
            const uint32_t bs1_tq = total_tq - 1U - bs2_tq;
            const uint32_t actual_bitrate_hz = can_kernel_hz / (prescaler * total_tq);
            const uint32_t bitrate_error_ppm =
                (uint32_t)(((uint64_t)Can_AbsDiffU32(actual_bitrate_hz, target_bitrate_hz) * 1000000ULL
                          + ((uint64_t)target_bitrate_hz / 2ULL))
                         / (uint64_t)target_bitrate_hz);
            const uint16_t sample_point_permille =
                (uint16_t)((((1U + bs1_tq) * 1000U) + (total_tq / 2U)) / total_tq);
            const uint32_t sample_error =
                Can_AbsDiffU32((uint32_t)sample_point_permille, (uint32_t)target_sample_point_permille);
            const uint8_t sjw_tq = (uint8_t)((bs2_tq > CAN_SJW_MAX_TQ) ? CAN_SJW_MAX_TQ : bs2_tq);
            uint64_t score;

            if ((bs1_tq < CAN_BS1_MIN_TQ) || (bs1_tq > CAN_BS1_MAX_TQ))
            {
                continue;
            }

            if (bitrate_error_ppm > CAN_BITRATE_ERROR_LIMIT_PPM)
            {
                continue;
            }

            /* 位时序搜索目标：
             * 1. 先让波特率误差足够小，避免节点平均节拍偏离。
             * 2. 再让采样点逼近目标值，为传播延迟与相位抖动留余量。
             *
             * 公式：
             * bitrate      = f_can / (Prescaler * (1 + BS1 + BS2))
             * sample_point = (1 + BS1) / (1 + BS1 + BS2)
             */
            score = ((uint64_t)bitrate_error_ppm * 1000ULL)
                  + ((uint64_t)sample_error * 10ULL)
                  + ((total_tq < 10U) ? 100ULL : 0ULL);

            if ((!found) || (score < best_score))
            {
                found = true;
                best_score = score;
                out_timing->prescaler = (uint16_t)prescaler;
                out_timing->bs1_tq = (uint8_t)bs1_tq;
                out_timing->bs2_tq = (uint8_t)bs2_tq;
                out_timing->sjw_tq = sjw_tq;
                out_timing->actual_bitrate_hz = actual_bitrate_hz;
                out_timing->sample_point_permille = sample_point_permille;
                out_timing->bitrate_error_ppm = bitrate_error_ppm;
            }
        }
    }

    return found;
}

/**
 * @brief 初始化 CAN 服务，并根据目标位时序约束自动装载 bxCAN 参数。
 * @param service CAN 服务对象。
 * @param hcan HAL CAN 句柄。
 * @param can_kernel_hz bxCAN 核时钟，通常等于 APB1 外设时钟。
 * @param target_bitrate_hz 目标波特率，范围建议 50 kbps ~ 1 Mbps。
 * @param target_sample_point_permille 目标采样点，典型值 800~875。
 * @retval HAL_OK 初始化成功。
 * @retval HAL_ERROR 参数非法、位时序不可达，或 HAL 初始化失败。
 *
 * @note 该函数只负责时序与启动逻辑；接收过滤器策略应由上层按业务单独配置。
 */
HAL_StatusTypeDef CanService_Init(CanService_t *service,
                                  CAN_HandleTypeDef *hcan,
                                  uint32_t can_kernel_hz,
                                  uint32_t target_bitrate_hz,
                                  uint16_t target_sample_point_permille)
{
    CanBitTiming_t timing;

    if ((service == NULL) || (hcan == NULL))
    {
        return HAL_ERROR;
    }

    memset(service, 0, sizeof(*service));
    service->hcan = hcan;

    if (!Can_FindBitTiming(can_kernel_hz,
                           target_bitrate_hz,
                           target_sample_point_permille,
                           &timing))
    {
        return HAL_ERROR;
    }

    hcan->Init.Prescaler = timing.prescaler;
    hcan->Init.SyncJumpWidth = Can_SjwToHal(timing.sjw_tq);
    hcan->Init.TimeSeg1 = Can_Bs1ToHal(timing.bs1_tq);
    hcan->Init.TimeSeg2 = Can_Bs2ToHal(timing.bs2_tq);
    hcan->Init.TimeTriggeredMode = DISABLE;
    hcan->Init.AutoBusOff = DISABLE;
    hcan->Init.AutoWakeUp = ENABLE;
    hcan->Init.AutoRetransmission = ENABLE;
    hcan->Init.ReceiveFifoLocked = DISABLE;
    /* 关闭按请求先后排序，保留按标识符优先级选择待发邮箱的默认语义。 */
    hcan->Init.TransmitFifoPriority = DISABLE;

    if (HAL_CAN_Init(hcan) != HAL_OK)
    {
        return HAL_ERROR;
    }

    if (HAL_CAN_Start(hcan) != HAL_OK)
    {
        return HAL_ERROR;
    }

    if (HAL_CAN_ActivateNotification(hcan, CAN_IT_BUSOFF) != HAL_OK)
    {
        return HAL_ERROR;
    }

    return HAL_OK;
}

/**
 * @brief 发送一帧标准数据帧，并把仲裁优先级显式映射到标准 ID。
 * @param service CAN 服务对象。
 * @param priority 报文优先级，数值越小，仲裁优先级越高。
 * @param function_code 业务功能码，用于区分控制/反馈/诊断类别。
 * @param node_id 节点号，建议限制在 0~15 以保持位域清晰。
 * @param payload 待发送数据缓冲区。
 * @param dlc 数据长度，范围 0~8。
 * @retval HAL_OK 报文已成功装入某个发送邮箱。
 * @retval HAL_BUSY 当前没有空闲邮箱，通常意味着低优先级帧应等待后续窗口。
 * @retval HAL_ERROR 参数非法、总线处于 Bus-Off，或 HAL 层发送失败。
 */
HAL_StatusTypeDef CanService_TransmitStandard(CanService_t *service,
                                              CanPriority_t priority,
                                              uint8_t function_code,
                                              uint8_t node_id,
                                              const uint8_t *payload,
                                              uint8_t dlc)
{
    CAN_TxHeaderTypeDef tx_header;
    uint32_t mailbox;
    uint8_t tx_data[8] = {0U};

    if ((service == NULL) || (service->hcan == NULL) || (dlc > 8U))
    {
        return HAL_ERROR;
    }

    if (service->bus_off_latched)
    {
        return HAL_ERROR;
    }

    if (payload != NULL)
    {
        memcpy(tx_data, payload, dlc);
    }

    if (HAL_CAN_GetTxMailboxesFreeLevel(service->hcan) == 0U)
    {
        /* 邮箱满并不等于总线故障。
         * 更常见的原因是：上一批低优先级报文尚未完成仲裁或发送。
         */
        return HAL_BUSY;
    }

    tx_header.StdId = Can_ComposeStdId(priority, function_code, node_id) & CAN_STD_ID_MASK;
    tx_header.ExtId = 0U;
    tx_header.IDE = CAN_ID_STD;
    tx_header.RTR = CAN_RTR_DATA;
    tx_header.DLC = dlc;
    tx_header.TransmitGlobalTime = DISABLE;

    return HAL_CAN_AddTxMessage(service->hcan, &tx_header, tx_data, &mailbox);
}

/**
 * @brief 在主循环中处理 Bus-Off 后的最小恢复策略。
 * @param service CAN 服务对象。
 * @param now_ms 当前毫秒节拍，通常来自 HAL_GetTick()。
 *
 * @note Bus-Off 的本质不是“再试一次”，而是先停止继续污染总线，
 *       等待一段冷却时间后再重新上线。这里使用固定 10 ms 延迟，
 *       实际项目应按网络负载、上位机策略和安全等级扩展。
 */
void CanService_Process(CanService_t *service, uint32_t now_ms)
{
    if ((service == NULL) || (service->hcan == NULL) || (!service->bus_off_latched))
    {
        return;
    }

    if ((int32_t)(now_ms - service->recovery_deadline_ms) < 0)
    {
        return;
    }

    (void)HAL_CAN_Stop(service->hcan);

    if (HAL_CAN_Start(service->hcan) == HAL_OK)
    {
        service->bus_off_latched = false;
        service->recovery_deadline_ms = 0U;
        (void)HAL_CAN_ActivateNotification(service->hcan, CAN_IT_BUSOFF);
    }
    else
    {
        service->recovery_deadline_ms = now_ms + CAN_BUSOFF_RECOVERY_DELAY_MS;
    }
}

void HAL_CAN_ErrorCallback(CAN_HandleTypeDef *hcan)
{
    extern CanService_t g_can1_service;

    if ((hcan == NULL) || (hcan != g_can1_service.hcan))
    {
        return;
    }

    if ((HAL_CAN_GetError(hcan) & HAL_CAN_ERROR_BOF) != 0U)
    {
        /* 进入 Bus-Off 说明该节点的错误历史已经严重到不能继续占用总线。
         * 这里不立即重启，而是把恢复动作交给主循环，避免在中断上下文里做重初始化。
         */
        g_can1_service.bus_off_latched = true;
        g_can1_service.recovery_deadline_ms = HAL_GetTick() + CAN_BUSOFF_RECOVERY_DELAY_MS;
    }
}

extern CAN_HandleTypeDef hcan1;

CanService_t g_can1_service = {0};

HAL_StatusTypeDef App_CanStackInit(void)
{
    /* 示例：APB1 为 42 MHz，目标波特率 500 kbps，采样点 87.5%。
     * 若时序搜索失败，往往不是 HAL 问题，而是时钟树、目标波特率
     * 和采样点三者组合在当前硬件条件下不可同时满足。
     */
    return CanService_Init(&g_can1_service, &hcan1, 42000000U, 500000U, 875U);
}

void App_CanTask(void)
{
    static uint32_t last_heartbeat_ms = 0U;
    uint8_t heartbeat[2];
    const uint32_t now_ms = HAL_GetTick();

    CanService_Process(&g_can1_service, now_ms);

    if ((now_ms - last_heartbeat_ms) < 10U)
    {
        return;
    }

    last_heartbeat_ms = now_ms;
    heartbeat[0] = 0xA5U;
    heartbeat[1] = 0x5AU;

    /* 心跳帧故意放在较低优先级。
     * 一旦总线上出现急停、电流环或故障广播，它们会凭更小的 ID 自动抢占。
     */
    (void)CanService_TransmitStandard(&g_can1_service,
                                      CAN_PRIORITY_STATUS,
                                      0x03U,
                                      0x01U,
                                      heartbeat,
                                      2U);
}
```

这段实现试图表达的，不是“CAN 初始化模板”本身，而是一个更底层的事实：**总线竞争、时钟容差、优先级调度和错误恢复，其实共享同一条时域链路**。标准 ID 不是静态编号，而是在显性/隐性位竞争中兑现优先级的调度语义；位时序参数不是寄存器填空，而是传播延迟、采样点和重同步窗口的数学边界；`Bus-Off` 也不是偶发异常，而是协议主动把失控节点从公共介质上摘掉的保护机制。理解了这些，CAN 才不再只是“能收能发”的外设，而是一个把数字抽象压回物理现实的工程协议。
