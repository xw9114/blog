---
title: "技能档案：CAN 接收路径的资源隔离，从过滤器分桶到 FIFO 背压与报文过期预算"
slug: "skill-can-filter-banking-rx-fifo-backpressure-and-deadline-guard"
date: 2026-07-08T09:05:32+08:00
draft: false
description: "从标识符掩码、bxCAN 过滤器分桶、双 FIFO 背压到软队列过期丢弃，系统拆解 CAN 接收为什么常死在仲裁之后的资源隔离而非物理连线。"
tags: ["CAN", "STM32", "bxCAN", "过滤器", "FIFO", "实时系统"]
categories: ["技能档案", "工业通信"]
image: ""
---

## 技能概述

很多工程师以为 CAN 最难的是仲裁、波特率和终端电阻；真正把系统拖垮的，却常常是仲裁结束之后节点内部那条不被示波器直接看见的接收链：**过滤器没分桶、硬件 FIFO 只有 3 帧、ISR 里做了过多解析、软队列没做过期淘汰**，最后把仍然有控制意义的报文和已经失去时效的诊断报文一起塞爆。这个主题真正要解决的，不是 `HAL_CAN_GetRxMessage()` 该怎么写，而是如何把 **过滤器 -> 双 FIFO -> 中断排空 -> 软件队列 -> 截止期调度** 设计成一条受控资源路径，让 CAN 非破坏性仲裁带来的总线秩序，真正延续到节点内部。

## 核心底层概念解析

- **总线仲裁只解决“谁先发”，不解决“谁接得住”**：收发器把差分位流还原出来以后，报文还要穿过 **位采样 -> 标识符比较 -> 过滤器 bank -> FIFO0/FIFO1 -> 中断服务 -> 软件队列 -> 任务分发** 这条链。物理层没有错误，并不代表节点内部没有丢帧；很多“CAN 不稳定”其实是接收调度失稳。

- **过滤器不是权限表，而是硬件前端分类器**：对标准帧 ID，常用的掩码判据可以写成  
  `match <=> ((id_rx ^ id_ref) & id_mask) == 0`。  
  它表达的不是“只能收某一个 ID”，而是“哪些位必须相同，哪些位允许自由变化”。例如要接收 `0x180 ~ 0x18F`，可以取 `id_ref = 0x180`、`id_mask = 0x7F0`，因为低 4 bit 不参与比较。

- **bxCAN 过滤器寄存器里的标准帧 ID 不是原样摆进去，而是左移对齐后的硬件编码**：工程里常见的映射是  
  `id_hw = (id_std & 0x7FF) << 5`。  
  这一步看似只是寄存器细节，实际是在把“11 bit 报文标识符”映射到“过滤器比较器的位平面”。如果这层映射错了，后面的所有 FIFO、优先级和时限分析都会建立在假输入上。

- **硬件 FIFO 的深度极小，所以它不是缓存池，而是喘息窗**：bxCAN 的每个接收 FIFO 只有 **3 帧** 深度。它的积压关系可以写成  
  `B[k+1] = clamp(B[k] + A[k] - S[k], 0, Q_hw)`，其中 `Q_hw = 3`。  
  只要某一小段时间里到达帧数 `A[k]` 连续大于服务帧数 `S[k]`，溢出就会在亚毫秒级发生。硬件 FIFO 不是用来“先堆着以后慢慢看”的，它只是给 ISR 争取几帧时间。

- **双 FIFO 不是“两个名字不同的邮箱”，而是接收隔离域**：把运动控制心跳、驱动状态这类**短截止期**报文送到 `FIFO0`，把诊断、标定、日志镜像这类**长截止期**报文送到 `FIFO1`，本质上是在硬件层把两类流量拆开。否则一波低优先级批量上报也能把高优先级状态消息堵在同一条接收队列前。

- **接收溢出首先是本地调度失败，不是总线协议失败**：仲裁、ACK、CRC 都可能完全正确，但如果 ISR 来不及把 FIFO 排空，或者任务来不及消费软件队列，最终丢帧仍然会发生。此时系统失败位置已经从“线上的位时序”转移到“节点内部的服务时间预算”。

- **ISR 的职责应该是排空、时间戳和入队，而不是解释业务语义**：若单帧 ISR 平均执行时间为 `C_isr`，平均到达率为 `lambda_rx`，那么中断负载近似满足  
  `rho_isr = lambda_rx * C_isr`。  
  一旦你在 ISR 里做状态机解析、浮点换算、查表或打印日志，`C_isr` 会立刻膨胀，尾延迟先杀掉的也不是平均吞吐，而是最短截止期那批报文。

- **不是每一帧“成功收到了”就仍然有意义，控制系统关心的是年龄**：若某帧到达时间戳为 `t_arrive`，当前时刻为 `t_now`，定时器频率为 `f_tim`，则  
  `age_us = (t_now - t_arrive) * 10^6 / f_tim`。  
  只有当 `age_us <= D_msg` 时，这帧才仍满足它的控制合同。对位置环、电流环和驱动心跳而言，**过期控制帧往往比丢帧更危险**，因为它会把过去的世界错误地投射到现在。

- **软件队列的丢弃策略必须和物理语义一致**：日志类报文适合“宁可丢最新，也要保留完整顺序”；控制类报文则更常见“优先淘汰已过期旧帧，再给新鲜帧让路”。所谓鲁棒，不是永不丢帧，而是**明确知道该丢哪一种帧才不会伤害系统闭环**。

- **过滤器 bank 是稀缺资源，不能把它当成无限 if-else**：在带双 CAN 的 bxCAN 芯片上，`SlaveStartFilterBank` 甚至还决定了 CAN1/CAN2 如何瓜分 bank。也就是说，过滤器不仅是匹配逻辑，还是一份硬件资源分配表；分配策略混乱，后面想补做隔离时会发现根本没有 bank 可用。

- **接收路径的工程调试，重点是重建积压时间线**：看 `RX_FOVx` 标志、看 FIFO 高水位、看软件队列高水位、看过期丢弃计数，再把它们和总线峰值时刻对齐。你要回答的问题不是“HAL 为什么偶尔返回错”，而是“哪一层开始排队、排了多久、哪类流量把谁堵死了”。

- **CAN 的技术哲学不该停在“线与仲裁很优雅”，而要继续落到节点内部的资源合同**：总线已经帮你把竞争做成了非破坏性的，接收节点若仍把所有流量混在一个 FIFO、一个 ISR 和一个队列里，那只是把冲突从物理层搬进了软件层。

## 代码能力展现

下面给出一段基于 **STM32 HAL bxCAN** 的接收路由器示例。它刻意只做仲裁之后的那半段工作：

- 用两个过滤器 bank，把 `0x180 ~ 0x18F` 的控制帧送入 `FIFO0`；
- 把 `0x600 ~ 0x6FF` 的诊断帧送入 `FIFO1`；
- ISR 里只做 **排空 FIFO、记录时间戳、压入软件队列**；
- 任务上下文优先消费控制帧，并对**已过期帧**做主动丢弃；
- 通过 **FIFO 高水位 / 过期计数 / 溢出计数** 暴露接收路径是否开始失去合同。

代码默认使用 `TIM2` 的 `1 MHz` 自由运行计数器做时间基准，位时序和收发器硬件已在别处配置完成。示例只覆盖**标准数据帧**，没有提前把扩展帧、远程帧或上层协议栈一并塞进来，这样边界更清楚，也更符合 YAGNI。

```c
#include "main.h"

#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#define CAN_RX_STD_ID_MASK                    0x07FFU
#define CAN_RX_MAX_DATA_BYTES                 8U
#define CAN_RX_SW_QUEUE_DEPTH                 16U
#define CAN_RX_FIFO_HW_DEPTH                  3U
#define CAN_RX_TIMEBASE_MIN_HZ                1000U
#define CAN_RX_TIMEBASE_MAX_HZ                10000000U

#define CAN_RX_FIFO0_DEADLINE_US              2000U
#define CAN_RX_FIFO1_DEADLINE_US              20000U
#define CAN_RX_BACKGROUND_SERVICE_QUOTA       2U

#define CAN_RX_FILTER_BANK_FIFO0             0U
#define CAN_RX_FILTER_BANK_FIFO1             1U
#define CAN_RX_SLAVE_START_FILTER_BANK       14U

typedef enum
{
    CAN_RX_CLASS_CRITICAL = 0U,
    CAN_RX_CLASS_BACKGROUND,
    CAN_RX_CLASS_COUNT
} CanRxClass_t;

typedef struct
{
    uint16_t id_ref;
    uint16_t id_mask;
    uint32_t deadline_us;
    uint32_t fifo;
    CanRxClass_t rx_class;
} CanRxRule_t;

typedef struct
{
    CAN_RxHeaderTypeDef header;
    uint8_t data[CAN_RX_MAX_DATA_BYTES];
    uint32_t arrival_tick;
    uint32_t deadline_us;
} CanRxFrame_t;

typedef struct
{
    CanRxFrame_t items[CAN_RX_SW_QUEUE_DEPTH];
    uint8_t head;
    uint8_t tail;
    uint8_t count;
    uint8_t high_watermark;
    uint32_t dropped_expired;
    uint32_t dropped_full;
} CanRxQueue_t;

typedef struct
{
    CAN_HandleTypeDef *hcan;
    TIM_HandleTypeDef *htim_tick;
    uint32_t timebase_hz;
    CanRxQueue_t queues[CAN_RX_CLASS_COUNT];
    uint32_t fifo_irq_count[2];
    uint32_t fifo_overrun_count[2];
    uint32_t rule_mismatch_count;
    uint32_t hal_error_count;
    uint8_t ready;
} CanRxRouter_t;

extern CAN_HandleTypeDef hcan1;
extern TIM_HandleTypeDef htim2;

static CanRxRouter_t g_can_rx =
{
    .hcan = &hcan1,
    .htim_tick = &htim2,
    .timebase_hz = 1000000U
};

static const CanRxRule_t k_can_rx_rules[] =
{
    /* 控制帧：0x180 ~ 0x18F，低 4 bit 留给节点号或子通道。 */
    { .id_ref = 0x180U, .id_mask = 0x7F0U, .deadline_us = CAN_RX_FIFO0_DEADLINE_US, .fifo = CAN_RX_FIFO0, .rx_class = CAN_RX_CLASS_CRITICAL },
    /* 诊断帧：0x600 ~ 0x6FF，允许整段业务分配。 */
    { .id_ref = 0x600U, .id_mask = 0x700U, .deadline_us = CAN_RX_FIFO1_DEADLINE_US, .fifo = CAN_RX_FIFO1, .rx_class = CAN_RX_CLASS_BACKGROUND }
};

static uint32_t CanRx_ClampU32(uint32_t value, uint32_t min_value, uint32_t max_value)
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

static uint32_t CanRx_TimeDeltaTicks(uint32_t now_tick, uint32_t prev_tick)
{
    /* 使用无符号减法兼容 32 位自由运行计数器回绕。 */
    return (now_tick - prev_tick);
}

static uint32_t CanRx_TicksToUs(uint32_t delta_ticks, uint32_t timebase_hz)
{
    const uint32_t tick_hz =
        CanRx_ClampU32(timebase_hz, CAN_RX_TIMEBASE_MIN_HZ, CAN_RX_TIMEBASE_MAX_HZ);
    const uint64_t time_us = ((uint64_t)delta_ticks * 1000000ULL) / (uint64_t)tick_hz;

    if (time_us > 0xFFFFFFFFULL)
    {
        return 0xFFFFFFFFUL;
    }

    return (uint32_t)time_us;
}

static uint32_t CanRx_FrameAgeUs(const CanRxFrame_t *frame, uint32_t now_tick, uint32_t timebase_hz)
{
    return CanRx_TicksToUs(CanRx_TimeDeltaTicks(now_tick, frame->arrival_tick), timebase_hz);
}

static bool CanRx_IsFrameExpired(const CanRxFrame_t *frame, uint32_t now_tick, uint32_t timebase_hz)
{
    return (CanRx_FrameAgeUs(frame, now_tick, timebase_hz) > frame->deadline_us);
}

/**
 * @brief 将标准帧 ID 映射为 bxCAN 过滤器高 16 位的左对齐格式。
 * @param std_id 11 bit 标准帧 ID。
 * @retval 过滤器寄存器高 16 位编码。
 *
 * @note bxCAN 对标准帧常用的比较编码可近似写成：
 *       id_hw = (std_id & 0x7FF) << 5
 *
 *       配合掩码模式后，命中条件等价于：
 *       ((rx_id_hw ^ ref_id_hw) & mask_hw) == 0
 *
 *       例如接收 0x180 ~ 0x18F：
 *       ref_id  = 0x180
 *       id_mask = 0x7F0
 *       因为低 4 bit 被屏蔽，不参与比较。
 */
static uint16_t CanRx_StdIdToFilterHigh(uint16_t std_id)
{
    return (uint16_t)((std_id & CAN_RX_STD_ID_MASK) << 5);
}

static bool CanRx_IsStdDataFrame(const CAN_RxHeaderTypeDef *header)
{
    if (header == NULL)
    {
        return false;
    }

    return ((header->IDE == CAN_ID_STD) && (header->RTR == CAN_RTR_DATA));
}

static bool CanRx_IsStdIdMatched(uint16_t std_id, const CanRxRule_t *rule)
{
    if (rule == NULL)
    {
        return false;
    }

    return (((std_id ^ rule->id_ref) & rule->id_mask) == 0U);
}

/**
 * @brief 在软件队列头部回收已经失去时效的旧帧。
 * @param queue 目标软件队列。
 * @param now_tick 当前时间戳。
 * @param timebase_hz 时间基准频率。
 *
 * @note 对控制报文来说，“旧但还没处理”的帧并不是资产。
 *       当 age_us > deadline_us 时，继续保留它只会阻塞新鲜帧，
 *       因此这里优先在 head 侧回收过期旧帧，为新输入让路。
 */
static void CanRx_QueueDiscardExpiredHead(CanRxQueue_t *queue, uint32_t now_tick, uint32_t timebase_hz)
{
    if (queue == NULL)
    {
        return;
    }

    while (queue->count > 0U)
    {
        CanRxFrame_t *head_frame = &queue->items[queue->tail];

        if (!CanRx_IsFrameExpired(head_frame, now_tick, timebase_hz))
        {
            break;
        }

        queue->tail = (uint8_t)((queue->tail + 1U) % CAN_RX_SW_QUEUE_DEPTH);
        queue->count--;
        queue->dropped_expired++;
    }
}

static bool CanRx_QueuePush(CanRxQueue_t *queue,
                            const CanRxFrame_t *frame,
                            uint32_t now_tick,
                            uint32_t timebase_hz)
{
    if ((queue == NULL) || (frame == NULL))
    {
        return false;
    }

    CanRx_QueueDiscardExpiredHead(queue, now_tick, timebase_hz);

    if (queue->count >= CAN_RX_SW_QUEUE_DEPTH)
    {
        queue->dropped_full++;
        return false;
    }

    queue->items[queue->head] = *frame;
    queue->head = (uint8_t)((queue->head + 1U) % CAN_RX_SW_QUEUE_DEPTH);
    queue->count++;

    if (queue->count > queue->high_watermark)
    {
        queue->high_watermark = queue->count;
    }

    return true;
}

static bool CanRx_QueuePopFresh(CanRxQueue_t *queue,
                                CanRxFrame_t *frame,
                                uint32_t now_tick,
                                uint32_t timebase_hz)
{
    if ((queue == NULL) || (frame == NULL))
    {
        return false;
    }

    CanRx_QueueDiscardExpiredHead(queue, now_tick, timebase_hz);

    if (queue->count == 0U)
    {
        return false;
    }

    *frame = queue->items[queue->tail];
    queue->tail = (uint8_t)((queue->tail + 1U) % CAN_RX_SW_QUEUE_DEPTH);
    queue->count--;
    return true;
}

/**
 * @brief 配置一个标准帧掩码过滤器，并把它分配到指定 FIFO。
 * @param hcan CAN 句柄。
 * @param bank 过滤器 bank 号。
 * @param fifo 目标 FIFO，使用 CAN_RX_FIFO0 或 CAN_RX_FIFO1。
 * @param std_id_ref 标准帧参考 ID。
 * @param std_id_mask 标准帧掩码。
 * @retval true 配置成功；false 配置失败。
 *
 * @note 过滤器的数学含义是：
 *       accept if ((id_rx ^ id_ref) & id_mask) == 0
 *
 *       这等价于“mask 为 1 的位必须相等，mask 为 0 的位可以变化”。
 *       通过把控制流量和背景流量落到不同 FIFO，上层就获得了硬件级隔离域。
 */
static bool CanRx_ConfigureStdMaskFilter(CAN_HandleTypeDef *hcan,
                                         uint32_t bank,
                                         uint32_t fifo,
                                         uint16_t std_id_ref,
                                         uint16_t std_id_mask)
{
    CAN_FilterTypeDef filter;

    if (hcan == NULL)
    {
        return false;
    }

    memset(&filter, 0, sizeof(filter));
    filter.FilterBank = bank;
    filter.FilterMode = CAN_FILTERMODE_IDMASK;
    filter.FilterScale = CAN_FILTERSCALE_32BIT;
    filter.FilterFIFOAssignment = fifo;
    filter.FilterActivation = ENABLE;
    filter.SlaveStartFilterBank = CAN_RX_SLAVE_START_FILTER_BANK;

    filter.FilterIdHigh = CanRx_StdIdToFilterHigh(std_id_ref);
    filter.FilterIdLow = 0U;
    filter.FilterMaskIdHigh = CanRx_StdIdToFilterHigh(std_id_mask);
    filter.FilterMaskIdLow = 0U;

    return (HAL_CAN_ConfigFilter(hcan, &filter) == HAL_OK);
}

/**
 * @brief 从指定硬件 FIFO 中持续排空报文，并压入对应的软件队列。
 * @param router 接收路由器实例。
 * @param rule 当前 FIFO 对应的匹配规则。
 *
 * @note ISR 只做三件事：
 *       1. 读出硬件 FIFO，避免 3 帧浅队列被继续顶满；
 *       2. 记录 arrival_tick，保留时效审计能力；
 *       3. 压入软件队列，推迟业务解析到任务上下文。
 *
 *       这样单帧 ISR 服务时间近似收敛为：
 *       C_isr ~= C_read_fifo + C_timestamp + C_memcpy + C_enqueue
 *       而不是被业务层解析逻辑无限放大。
 */
static void CanRx_DrainFifo(CanRxRouter_t *router, const CanRxRule_t *rule)
{
    CanRxQueue_t *queue;

    if ((router == NULL) || (rule == NULL) || (router->ready == 0U))
    {
        return;
    }

    queue = &router->queues[rule->rx_class];

    while (HAL_CAN_GetRxFifoFillLevel(router->hcan, rule->fifo) > 0U)
    {
        CanRxFrame_t frame;
        uint8_t data[CAN_RX_MAX_DATA_BYTES] = {0U};
        const uint32_t now_tick = __HAL_TIM_GET_COUNTER(router->htim_tick);
        const uint8_t fifo_index = (rule->fifo == CAN_RX_FIFO0) ? 0U : 1U;
        uint8_t length = 0U;

        memset(&frame, 0, sizeof(frame));

        if (HAL_CAN_GetRxMessage(router->hcan, rule->fifo, &frame.header, data) != HAL_OK)
        {
            router->hal_error_count++;
            break;
        }

        if (!CanRx_IsStdDataFrame(&frame.header))
        {
            router->rule_mismatch_count++;
            continue;
        }

        if (!CanRx_IsStdIdMatched((uint16_t)frame.header.StdId, rule))
        {
            /* 理论上不应发生；若发生，说明过滤器配置与软件认知已经分叉。 */
            router->rule_mismatch_count++;
            continue;
        }

        length = (uint8_t)((frame.header.DLC <= CAN_RX_MAX_DATA_BYTES) ?
                           frame.header.DLC : CAN_RX_MAX_DATA_BYTES);

        if (length > 0U)
        {
            memcpy(frame.data, data, length);
        }

        frame.arrival_tick = now_tick;
        frame.deadline_us = rule->deadline_us;

        if (!CanRx_QueuePush(queue, &frame, now_tick, router->timebase_hz))
        {
            /* 软件队列顶满说明接收路径已经失去本地时效合同。 */
            router->fifo_overrun_count[fifo_index]++;
        }
    }
}

static void App_OnCriticalCanFrame(const CanRxFrame_t *frame)
{
    /* 这里再进入业务语义，例如：
     * - 电机驱动器状态字
     * - 心跳/使能确认
     * - 位置或电流环上行反馈
     *
     * 刻意不在 ISR 里做这些事，是为了让硬件 FIFO 的 3 帧预算
     * 尽可能只承担“搬运”而不是“解释”。
     */
    (void)frame;
}

static void App_OnBackgroundCanFrame(const CanRxFrame_t *frame)
{
    /* 例如：
     * - 标定回读
     * - 调试遥测
     * - 设备信息与低频诊断
     */
    (void)frame;
}

/**
 * @brief 初始化接收过滤器、启动 CAN 并激活接收通知。
 * @retval true 初始化成功；false 初始化失败。
 *
 * @note 本示例假定位时序已经由 CubeMX 或外层驱动配置完成。
 *       这里专注的是仲裁之后的本地接收资源隔离，而不是重复讲一遍波特率计算。
 */
bool CanRxRouter_Init(void)
{
    memset(g_can_rx.queues, 0, sizeof(g_can_rx.queues));
    g_can_rx.fifo_irq_count[0] = 0U;
    g_can_rx.fifo_irq_count[1] = 0U;
    g_can_rx.fifo_overrun_count[0] = 0U;
    g_can_rx.fifo_overrun_count[1] = 0U;
    g_can_rx.rule_mismatch_count = 0U;
    g_can_rx.hal_error_count = 0U;
    g_can_rx.ready = 0U;

    if (!CanRx_ConfigureStdMaskFilter(g_can_rx.hcan,
                                      CAN_RX_FILTER_BANK_FIFO0,
                                      CAN_RX_FIFO0,
                                      k_can_rx_rules[0].id_ref,
                                      k_can_rx_rules[0].id_mask))
    {
        return false;
    }

    if (!CanRx_ConfigureStdMaskFilter(g_can_rx.hcan,
                                      CAN_RX_FILTER_BANK_FIFO1,
                                      CAN_RX_FIFO1,
                                      k_can_rx_rules[1].id_ref,
                                      k_can_rx_rules[1].id_mask))
    {
        return false;
    }

    if (HAL_CAN_Start(g_can_rx.hcan) != HAL_OK)
    {
        return false;
    }

    if (HAL_CAN_ActivateNotification(g_can_rx.hcan,
                                     CAN_IT_RX_FIFO0_MSG_PENDING |
                                     CAN_IT_RX_FIFO1_MSG_PENDING |
                                     CAN_IT_RX_FIFO0_OVERRUN |
                                     CAN_IT_RX_FIFO1_OVERRUN) != HAL_OK)
    {
        return false;
    }

    g_can_rx.ready = 1U;
    return true;
}

/**
 * @brief 在任务上下文中分级消费软件队列。
 *
 * @note 控制帧的时效合同可写成：
 *       T_deadline > T_hw_fifo_wait + T_isr + T_sw_queue_wait + T_task_sched
 *
 *       因此即便报文已经进入软件队列，只要 age_us > deadline_us，
 *       也应主动丢弃，而不是把“过时事实”送进控制器。
 *
 *       这里先清空 critical 队列，再按配额消费 background 队列，
 *       目的是避免背景流量反过来拖慢控制流量。
 */
void CanRxRouter_Process(void)
{
    CanRxFrame_t frame;
    uint8_t background_budget = CAN_RX_BACKGROUND_SERVICE_QUOTA;
    const uint32_t now_tick = __HAL_TIM_GET_COUNTER(g_can_rx.htim_tick);

    while (CanRx_QueuePopFresh(&g_can_rx.queues[CAN_RX_CLASS_CRITICAL],
                               &frame,
                               now_tick,
                               g_can_rx.timebase_hz))
    {
        App_OnCriticalCanFrame(&frame);
    }

    while ((background_budget > 0U) &&
           CanRx_QueuePopFresh(&g_can_rx.queues[CAN_RX_CLASS_BACKGROUND],
                               &frame,
                               now_tick,
                               g_can_rx.timebase_hz))
    {
        App_OnBackgroundCanFrame(&frame);
        background_budget--;
    }
}

void HAL_CAN_RxFifo0MsgPendingCallback(CAN_HandleTypeDef *hcan)
{
    if ((hcan == g_can_rx.hcan) && (g_can_rx.ready != 0U))
    {
        g_can_rx.fifo_irq_count[0]++;
        CanRx_DrainFifo(&g_can_rx, &k_can_rx_rules[0]);
    }
}

void HAL_CAN_RxFifo1MsgPendingCallback(CAN_HandleTypeDef *hcan)
{
    if ((hcan == g_can_rx.hcan) && (g_can_rx.ready != 0U))
    {
        g_can_rx.fifo_irq_count[1]++;
        CanRx_DrainFifo(&g_can_rx, &k_can_rx_rules[1]);
    }
}

void HAL_CAN_ErrorCallback(CAN_HandleTypeDef *hcan)
{
    if ((hcan == g_can_rx.hcan) && (g_can_rx.ready != 0U))
    {
        const uint32_t error = HAL_CAN_GetError(hcan);

        if ((error & HAL_CAN_ERROR_RX_FOV0) != 0U)
        {
            g_can_rx.fifo_overrun_count[0]++;
        }

        if ((error & HAL_CAN_ERROR_RX_FOV1) != 0U)
        {
            g_can_rx.fifo_overrun_count[1]++;
        }

        if ((error & (HAL_CAN_ERROR_RX_FOV0 | HAL_CAN_ERROR_RX_FOV1)) == 0U)
        {
            g_can_rx.hal_error_count++;
        }
    }
}

uint8_t CanRxRouter_GetFifoHighWatermark(uint32_t fifo)
{
    if (fifo == CAN_RX_FIFO0)
    {
        return g_can_rx.queues[CAN_RX_CLASS_CRITICAL].high_watermark;
    }

    if (fifo == CAN_RX_FIFO1)
    {
        return g_can_rx.queues[CAN_RX_CLASS_BACKGROUND].high_watermark;
    }

    return 0U;
}
```

这段实现里，有几个很关键的工程边界：

- 它没有把所有报文都塞进同一个入口，而是先用**过滤器 bank + 双 FIFO**做硬件级分流；
- 它承认 **`Q_hw = 3` 的 FIFO 不是缓存池**，因此 ISR 只做排空和入队，不做业务解释；
- 它把 **报文年龄 `age_us`** 纳入消费条件，而不是把“收到”误当成“仍然有效”；
- 它对背景流量引入消费配额，让控制流量始终拥有更短的本地等待路径；
- 它暴露了 `high_watermark / dropped_expired / fifo_overrun_count` 这些计数器，方便你把问题从“玄学丢帧”重建成一条可审计的积压时间线。

如果你的 CAN 总线在示波器上看起来一切正常，节点却偶发漏掉驱动状态、心跳乱跳、诊断一开就拖慢控制，那就别再只盯着 ACK、终端电阻和波特率了。很多时候，真正该优化的不是“线上还能不能再快一点”，而是**仲裁之后这条接收资源路径有没有被设计成一份明确的时效合同**。过滤器、FIFO、中断和软件队列，从来不是 API 堆叠，它们是节点内部对总线秩序的最后一次兑现。
