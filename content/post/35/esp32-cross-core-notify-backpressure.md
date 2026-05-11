---
title: "技能档案：ESP32 双核调度的硬边界，从跨核通知到队列背压"
slug: "skill-esp32-cross-core-notify-and-queue-backpressure"
date: 2026-05-11T09:03:57+08:00
draft: false
description: "从核心亲和性、跨核任务通知、队列背压到中断唤醒延迟预算，系统拆解 ESP32 双核调度为什么首先是一场共享内存与实时合同的管理。"
tags: ["ESP32", "FreeRTOS", "双核调度", "任务通知", "实时系统"]
categories: ["技能档案"]
image: ""
---

## 技能概述

ESP32 双核调度真正解决的，不是“把两个任务分到两个核上就能自动提速”，而是当无线协议栈、外设中断、控制回路和数据处理同时争抢同一片 RAM、同一个调度器和同一组临界资源时，如何把系统从“偶尔能跑”收束成“时序可证明”。很多项目表面上卡在 API 选择，实际死因却是跨核共享状态写坏、队列积压失控、ISR 唤醒链过长，最后让实时任务败给尾延迟。这个主题的核心痛点，是把双核看成一台共享内存机器上的资源调度问题，而不是把它误解成两颗互不打扰的小 MCU。

## 核心底层概念解析

- **双核不是两台 MCU，而是一套共享内存上的竞争合同**：ESP32 双核上的任务并不是通过串口互发消息，它们共享同一片地址空间、同一套内核对象和同一组片上外设仲裁。所谓“跨核通信”，本质往往不是复制一份数据过去，而是**转移某块内存的所有权**。一旦这个所有权边界含糊，读写竞争就会比算法本身更早击穿系统。
- **核心亲和性不是调优细节，而是时序边界声明**：官方 IDF FreeRTOS 提供 `xTaskCreatePinnedToCore()`，就是因为 SMP 调度下任务并不天然只属于某一核。把控制环、采样环、通信环固定到明确核心，本质上是在告诉调度器“哪些工作允许迁移，哪些工作必须拥有稳定的局部时间轴”。不固定的任务虽然看起来更“灵活”，但也更容易把 cache 热点、临界区争用和唤醒抖动扩散到两个核。
- **直接任务通知和队列不是同类工具，它们解决的是不同层级的问题**：官方文档明确把任务通知描述为比传统信号量更轻、更快的单任务事件路径；它适合表达“某个任务现在该醒了”。而队列更像一条有长度、有拷贝成本、有背压语义的数据通道。前者解决“谁该被唤醒”，后者解决“哪份数据该被消费”。把两者混用，往往会让路径既慢又不清楚。
- **队列长度不是稳定性的来源，只是稳定性缺失时的缓冲幻觉**：若生产速率为 `lambda_prod`，消费速率为 `mu_cons`，只要长期满足 `lambda_prod >= mu_cons`，再深的队列也只是把故障推迟。其离散积压关系可以写成 `B[k+1] = clamp(B[k] + a[k] - s[k], 0, Q)`，其中 `B[k]` 是第 `k` 个时刻的积压深度，`a[k]` 是新到达工作数，`s[k]` 是本周期处理完成数，`Q` 是队列容量。当平均到达率持续大于平均服务率时，溢出时间近似满足 `T_overflow ≈ Q / (lambda_prod - mu_cons)`。队列越深，故障越晚暴露，但根因并没有被修好。
- **ISR 到任务运行的时延链，远比一次函数调用长得多**：工程里真正关心的不是“中断里有没有发通知”，而是从硬件事件到目标任务真的开始执行之间隔了多少环节。它通常近似由 `T_irq_to_run = T_entry + T_isr + T_ready + T_ipi + T_sched + T_cs_hold` 组成，分别对应中断入口、ISR 自身执行、内核把任务转成 Ready、可能的跨核唤醒、调度决策，以及被别的核心长临界区拖住的等待时间。双核里的尾延迟，很多时候就死在 `T_ipi` 和 `T_cs_hold` 这两段。
- **在 SMP 系统里，关本核中断不等于拿到共享资源**：ESP-IDF 的官方文档明确指出，单纯屏蔽当前核中断不能阻止另一核同时访问共享数据，因此临界区需要 `portMUX_TYPE` 自旋锁，而不是“我这里先 disable interrupt 一下就安全了”的单核思路。也就是说，双核里的临界区不是静止的，它在你等待锁的时候本身就是时间成本。
- **长临界区不仅伤吞吐，更伤最坏唤醒时间**：自旋锁的代价不是平均值，而是另一核恰好卡在里面时你的等待上界。若某段代码持锁 `40 us`，那么对面核上本该 `5 us` 被唤醒的高优先级任务，最坏情况也可能被拖到 `45 us` 以后。因此共享状态不应被设计成“一个大全局结构体，改的时候整块一起锁”，而应该尽量缩小成小快照、小邮箱和短持锁路径。
- **数据拷贝也是调度成本，不只是内存成本**：队列若直接搬运大块 payload，每次入队/出队都要支付 `T_copy ≈ N_bytes / BW_mem` 的搬运时间；数据量一大，背压就会先出现在内存总线，而不是 CPU 算力上。所以跨核队列最稳妥的做法往往不是“把数据塞进队列”，而是只在队列里传**描述符、索引或所有权令牌**，真正的大块数据留在固定槽位中零拷贝流转。
- **优先级的本质不是“谁更重要”，而是谁更不能被排队**：控制环、采样回路和超时恢复逻辑，关注的是 deadline；日志、遥测、格式化输出关注的是 eventual completion。若把两者都用一样的队列和一样的优先级混在一起，系统就会在压力上来时优先保护“数据尽量别丢”，而不是“控制尽量别迟到”。嵌入式实时系统里，先守 deadline，再谈吞吐。
- **双核调度的关键不是并行，而是隔离**：很多人把第二个核心理解成“多一倍算力”，但工程上它更像一个隔离舱。你把高抖动的网络协议和日志放到一边，把对时序敏感的控制与中断后半段放到另一边，收益不一定体现在 benchmark 的平均速度，却一定体现在最坏时延是否可控。
- **任务通知、队列和邮箱要形成一条分层链路，而不是随手堆 API**：比较稳的设计通常是 ISR 只做极短的时间戳、描述符投递与唤醒；工作任务负责耗时处理；最终控制任务只读取已经整理好的快照。这条链路如果被设计成“ISR 里直接做解析”“任务之间共享裸指针无保护”“所有人都能随手写结果结构体”，双核最后只会放大混乱。
- **调度问题最后都会落回数学约束**：如果某任务周期为 `T_p`，其单次最坏执行时间为 `C`，可容忍等待抖动为 `J`，那它要稳定运行，工程上至少要保证 `C + J < T_p`。双核只是给了你重新分配 `C` 和压低 `J` 的机会，并没有推翻这条不等式。
- **ESP32 双核的工程哲学不是“让所有任务都同时跑”，而是让真正重要的任务不被不重要的任务拖死**：这是资源调度，不是功能堆叠。写得好的双核系统，看上去 API 不多，但每一条唤醒链、每一段共享路径、每一次缓存命中和每一个丢包策略，都有明确的边界和理由。

## 代码能力展现

下面给出一个基于 ESP-IDF FreeRTOS 的双核调度示例。场景假设为：**Core 0** 侧承接外设 ISR 与轻量投递，**Core 1** 侧执行数据处理任务，处理完成后再跨核唤醒 **Core 0** 上的控制任务。实现上刻意采用**静态队列 + 固定槽位 + 描述符传递 + 直接任务通知 + `portMUX_TYPE` 保护共享快照**，目标不是“把功能写全”，而是把跨核通信的资源边界和最坏时延显式表达出来。

```c
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "esp_attr.h"
#include "esp_timer.h"
#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#define DISPATCH_SLOT_COUNT             8U
#define DISPATCH_QUEUE_DEPTH            6U
#define DISPATCH_PAYLOAD_BYTES          128U
#define DISPATCH_NOTIFY_INDEX           0U
#define DISPATCH_WORKER_STACK_DEPTH     3072U
#define DISPATCH_CONTROL_STACK_DEPTH    2048U
#define DISPATCH_WORKER_CORE            1
#define DISPATCH_CONTROL_CORE           0
#define DISPATCH_WORKER_PRIORITY        20U
#define DISPATCH_CONTROL_PRIORITY       23U
#define DISPATCH_WAKE_BUDGET_US         80U
#define DISPATCH_CONTROL_PERIOD_MS      1U

typedef struct
{
    uint32_t sequence;
    uint32_t irq_timestamp_us;
    uint16_t payload_bytes;
    uint8_t payload[DISPATCH_PAYLOAD_BYTES];
} DispatchSlot_t;

typedef struct
{
    uint8_t slot_index;
    uint16_t payload_bytes;
    uint32_t sequence;
    uint32_t irq_timestamp_us;
} DispatchDesc_t;

typedef struct
{
    uint32_t sequence;
    int32_t filtered_value;
    uint32_t wake_latency_us;
} DispatchResult_t;

typedef struct
{
    uint32_t queue_drop_count;
    uint32_t wake_budget_miss_count;
    uint16_t queue_high_watermark;
    uint32_t last_irq_to_worker_us;
} DispatchStats_t;

static QueueHandle_t s_desc_queue = NULL;
static StaticQueue_t s_desc_queue_ctrl;
static uint8_t s_desc_queue_storage[DISPATCH_QUEUE_DEPTH * sizeof(DispatchDesc_t)];

static TaskHandle_t s_worker_task = NULL;
static TaskHandle_t s_control_task = NULL;
static StaticTask_t s_worker_tcb;
static StaticTask_t s_control_tcb;
static StackType_t s_worker_stack[DISPATCH_WORKER_STACK_DEPTH];
static StackType_t s_control_stack[DISPATCH_CONTROL_STACK_DEPTH];

static DispatchSlot_t s_slots[DISPATCH_SLOT_COUNT];
static DispatchResult_t s_latest_result;
static DispatchStats_t s_stats;

static portMUX_TYPE s_slot_mux = portMUX_INITIALIZER_UNLOCKED;
static portMUX_TYPE s_result_mux = portMUX_INITIALIZER_UNLOCKED;
static portMUX_TYPE s_stats_mux = portMUX_INITIALIZER_UNLOCKED;

static volatile uint8_t s_next_slot = 0U;
static volatile uint32_t s_next_sequence = 0U;

static inline uint16_t Dispatch_MinU16(uint16_t a, uint16_t b)
{
    return (a < b) ? a : b;
}

static inline int32_t Dispatch_ClampI32(int32_t value, int32_t min_value, int32_t max_value)
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

/**
 * @brief 记录队列高水位和预算超限统计。
 * @param queue_depth 当前观察到的队列深度。
 * @param wake_latency_us 最近一次 ISR 到工作任务开始运行的延迟。
 *
 * @note 队列积压可以离散描述为：
 *       B[k + 1] = clamp(B[k] + a[k] - s[k], 0, Q)
 *       其中 B 是积压深度，a 是到达数，s 是服务数，Q 是队列容量。
 *       一旦长期平均 a >= s，Q 再大也只是在延后溢出时刻。
 */
static void Dispatch_UpdateStats(uint16_t queue_depth, uint32_t wake_latency_us)
{
    taskENTER_CRITICAL(&s_stats_mux);

    if (queue_depth > s_stats.queue_high_watermark)
    {
        s_stats.queue_high_watermark = queue_depth;
    }

    s_stats.last_irq_to_worker_us = wake_latency_us;

    if (wake_latency_us > DISPATCH_WAKE_BUDGET_US)
    {
        s_stats.wake_budget_miss_count++;
    }

    taskEXIT_CRITICAL(&s_stats_mux);
}

/**
 * @brief 从 ISR 路径向静态槽位写入一份样本，并将描述符投入队列。
 * @param sample_data 外设采样数据。
 * @param sample_bytes 采样数据长度。
 *
 * @note 这里刻意不把整块 payload 直接塞进队列，而只发送描述符：
 *       T_copy ≈ N_bytes / BW_mem
 *       当 payload 较大时，直接排队大块数据会把总线时间消耗在拷贝上。
 *       描述符队列传输的是“所有权”，固定槽位保存的是“实体数据”。
 */
void IRAM_ATTR Dispatch_OnPeripheralIsr(const uint8_t *sample_data, uint16_t sample_bytes)
{
    BaseType_t higher_priority_task_woken = pdFALSE;
    DispatchDesc_t desc;
    uint8_t slot_index = 0U;
    uint16_t bytes_to_copy = 0U;

    taskENTER_CRITICAL_ISR(&s_slot_mux);
    slot_index = s_next_slot;
    s_next_slot = (uint8_t)((s_next_slot + 1U) % DISPATCH_SLOT_COUNT);
    desc.sequence = ++s_next_sequence;
    taskEXIT_CRITICAL_ISR(&s_slot_mux);

    bytes_to_copy = Dispatch_MinU16(sample_bytes, DISPATCH_PAYLOAD_BYTES);

    s_slots[slot_index].sequence = desc.sequence;
    s_slots[slot_index].irq_timestamp_us = (uint32_t)esp_timer_get_time();
    s_slots[slot_index].payload_bytes = bytes_to_copy;
    memcpy(s_slots[slot_index].payload, sample_data, bytes_to_copy);

    desc.slot_index = slot_index;
    desc.payload_bytes = bytes_to_copy;
    desc.irq_timestamp_us = s_slots[slot_index].irq_timestamp_us;

    if (xQueueSendFromISR(s_desc_queue, &desc, &higher_priority_task_woken) != pdPASS)
    {
        taskENTER_CRITICAL_ISR(&s_stats_mux);
        s_stats.queue_drop_count++;
        taskEXIT_CRITICAL_ISR(&s_stats_mux);
    }
    else
    {
        /*
         * 直接任务通知用于“唤醒谁”，队列用于“交付哪份数据”。
         * 官方文档将任务通知描述为比传统信号量更轻、更快的单任务事件路径。
         */
        vTaskNotifyGiveIndexedFromISR(s_worker_task,
                                      DISPATCH_NOTIFY_INDEX,
                                      &higher_priority_task_woken);
    }

    if (higher_priority_task_woken == pdTRUE)
    {
        portYIELD_FROM_ISR();
    }
}

/**
 * @brief 在工作任务中处理固定槽位样本，并输出控制快照。
 * @param desc 描述符。
 * @param out 输出控制结果。
 *
 * @note 这里用一个极简的一阶滤波代替真实业务算法，只保留时序结构：
 *       y[k] = y[k-1] + alpha * (x[k] - y[k-1])
 *       若把 alpha = 1 / 8，则可用移位近似，降低跨核后半段算术成本。
 */
static void Dispatch_ProcessDescriptor(const DispatchDesc_t *desc, DispatchResult_t *out)
{
    static int32_t s_filter_state = 0;
    const DispatchSlot_t *slot = &s_slots[desc->slot_index];
    int32_t sum = 0;
    uint16_t i = 0U;
    int32_t avg = 0;

    for (i = 0U; i < desc->payload_bytes; ++i)
    {
        sum += slot->payload[i];
    }

    if (desc->payload_bytes > 0U)
    {
        avg = sum / (int32_t)desc->payload_bytes;
    }

    s_filter_state = s_filter_state + ((avg - s_filter_state) >> 3);

    out->sequence = desc->sequence;
    out->filtered_value = Dispatch_ClampI32(s_filter_state, -32768, 32767);
    out->wake_latency_us = (uint32_t)(esp_timer_get_time() - (int64_t)desc->irq_timestamp_us);
}

/**
 * @brief Core 1 工作任务，负责被 ISR 跨核唤醒后尽快清空描述符队列。
 * @param argument 未使用。
 *
 * @note ISR 到任务开始运行的延迟可近似写成：
 *       T_irq_to_run = T_entry + T_isr + T_ready + T_ipi + T_sched + T_cs_hold
 *       其中 T_cs_hold 往往来自另一核心长时间持有自旋锁。
 *       因此该任务的原则是：
 *       1. 被唤醒后先排空队列；
 *       2. 对共享快照仅做短持锁写入；
 *       3. 再用直接通知唤醒 Core 0 的控制任务。
 */
static void Dispatch_WorkerTask(void *argument)
{
    (void)argument;

    for (;;)
    {
        DispatchDesc_t desc;

        (void)ulTaskNotifyTakeIndexed(DISPATCH_NOTIFY_INDEX,
                                      pdTRUE,
                                      portMAX_DELAY);

        while (xQueueReceive(s_desc_queue, &desc, 0U) == pdPASS)
        {
            DispatchResult_t local_result;
            const UBaseType_t queue_depth_now = uxQueueMessagesWaiting(s_desc_queue);

            Dispatch_ProcessDescriptor(&desc, &local_result);
            Dispatch_UpdateStats((uint16_t)(queue_depth_now + 1U),
                                 local_result.wake_latency_us);

            taskENTER_CRITICAL(&s_result_mux);
            s_latest_result = local_result;
            taskEXIT_CRITICAL(&s_result_mux);

            xTaskNotifyGive(s_control_task);
        }
    }
}

/**
 * @brief Core 0 控制任务，以固定周期读取最近一次完成处理的快照。
 * @param argument 未使用。
 *
 * @note 控制任务不是消费整个历史，而是只消费“最近一次已经完成的稳定结果”。
 *       这样可以把控制链从吞吐导向改成 deadline 导向。
 *       若控制周期为 T_p，任务最坏执行时间为 C，额外等待抖动为 J，
 *       则工程上至少需要保证：
 *       C + J < T_p
 */
static void Dispatch_ControlTask(void *argument)
{
    TickType_t last_wake_tick = xTaskGetTickCount();

    (void)argument;

    for (;;)
    {
        DispatchResult_t snapshot;

        vTaskDelayUntil(&last_wake_tick, pdMS_TO_TICKS(DISPATCH_CONTROL_PERIOD_MS));

        if (ulTaskNotifyTake(pdTRUE, 0U) == 0U)
        {
            continue;
        }

        taskENTER_CRITICAL(&s_result_mux);
        snapshot = s_latest_result;
        taskEXIT_CRITICAL(&s_result_mux);

        /*
         * 这里本应执行实际控制输出，例如：
         * - 更新 PWM / DAC / GPIO
         * - 喂给上层状态机
         * - 触发超时保护
         * 保持该段逻辑短小，可避免把 Core 0 再次变成新的尾延迟源。
         */
        (void)snapshot;
    }
}

/**
 * @brief 初始化双核调度链路。
 *
 * @note 工程上的几个关键决策：
 *       1. 队列静态分配，避免运行期 heap 抖动。
 *       2. Worker 固定到 Core 1，Control 固定到 Core 0，明确时间边界。
 *       3. ISR 只投递描述符和唤醒任务，不在中断里做大计算。
 */
void Dispatch_Init(void)
{
    s_desc_queue = xQueueCreateStatic(DISPATCH_QUEUE_DEPTH,
                                      sizeof(DispatchDesc_t),
                                      s_desc_queue_storage,
                                      &s_desc_queue_ctrl);

    s_worker_task = xTaskCreateStaticPinnedToCore(Dispatch_WorkerTask,
                                                  "dispatch_worker",
                                                  DISPATCH_WORKER_STACK_DEPTH,
                                                  NULL,
                                                  DISPATCH_WORKER_PRIORITY,
                                                  s_worker_stack,
                                                  &s_worker_tcb,
                                                  DISPATCH_WORKER_CORE);

    s_control_task = xTaskCreateStaticPinnedToCore(Dispatch_ControlTask,
                                                   "dispatch_control",
                                                   DISPATCH_CONTROL_STACK_DEPTH,
                                                   NULL,
                                                   DISPATCH_CONTROL_PRIORITY,
                                                   s_control_stack,
                                                   &s_control_tcb,
                                                   DISPATCH_CONTROL_CORE);
}
```

这段代码想强调的不是“ESP32 双核该怎么调用几个 FreeRTOS API”，而是**如何把跨核共享状态、队列背压和唤醒链压缩成一个可推导的系统合同**。ISR 只交付描述符，不交付大块数据；队列只承担缓冲和背压，不承担唤醒语义；任务通知只负责把正确的任务叫醒，不负责搬运 payload；共享结果只以短临界区快照方式暴露给控制任务。真正稳定的双核系统，往往不是线程越多越热闹，而是每一段所有权、每一次唤醒和每一个最坏时延都被提前算清楚。
