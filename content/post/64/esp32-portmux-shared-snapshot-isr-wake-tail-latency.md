---
title: "技能档案：ESP32 双核里的 portMUX 自旋锁、共享快照与 ISR 唤醒尾延迟预算"
slug: "skill-esp32-portmux-shared-snapshot-and-isr-wake-tail-latency-budget"
date: 2026-06-18T09:21:39+08:00
draft: false
description: "从 portMUX 自旋锁、双 bank 共享快照、直接任务通知到 ISR 唤醒尾延迟预算，系统拆解 ESP32 双核调度为什么首先是一份共享内存与最坏时延合同。"
tags: ["ESP32", "FreeRTOS", "双核调度", "portMUX", "任务通知", "实时系统"]
categories: ["技能档案"]
image: ""
---

## 技能概述

ESP32 双核系统真正难的地方，并不是“两个核怎么同时跑起来”，而是当一个核承接无线协议栈与外设中断，另一个核负责数据整理和控制计算时，如何让共享内存、跨核唤醒和临界区竞争不把实时性撕碎。很多项目表面上看是通知 API 选型问题，实际死因却是 ISR 把大块数据塞进共享结构体、长临界区拖住对侧高优先级任务、控制环拿到的是半更新快照，最后平均负载不高，尾延迟却持续越界。这个主题要解决的核心痛点，是把“双核通信”从一堆 RTOS 接口，收束成一条可预算、可限幅、可退化的共享内存时序合同。

## 核心底层概念解析

- **双核不是两台小 MCU，而是一台共享内存机器**：Core 0 和 Core 1 并不是靠串口互发消息，它们共享同一片 RAM、同一组内核对象和同一批外设仲裁。所谓跨核通信，本质上不是“把数据传过去”，而是**把某块内存的解释权和消费权交给另一条时间轴**。
- **`portMUX_TYPE` 自旋锁解决的是跨核并发，不只是本核中断屏蔽**：在单核思维里，`disable interrupt` 常常等价于“暂时没人来打扰我”；但在 ESP32 双核里，你关掉本核中断，并不能阻止另一核继续改同一份数据。`portENTER_CRITICAL()` 的关键价值，不在“代码更官方”，而在它真的把共享资源变成了跨核互斥资源。
- **任务通知负责唤醒，数据结构负责承载**：直接任务通知适合表达“该醒了”，不适合承载可变长度 payload。把大块数据塞进队列或在 ISR 里直接改共享结果，会让唤醒路径混进搬运路径，最终抬高最坏时延。稳妥的做法是只传递**描述符、索引或所有权令牌**，真正的数据留在固定槽位里。
- **双 bank 共享快照的本质，是把“正在写”和“正在读”拆成两个世界**：生产者先在非活动 bank 中写完整结果，写完后再原子切换 `active_bank`；消费者永远只读当前活动 bank。这样系统就不再依赖“读的时候正好没撞上写”，而是用结构保证**不会读到半更新状态**。
- **临界区持有时间必须从“整个对象复制”降到“元数据交换”**：若持锁区里做的是整块拷贝，则临界区成本近似满足 `T_cs_hold ≈ T_lock + N_copy / BW_mem + T_index_update`。双核实时系统不怕有锁，怕的是锁里塞了太多与互斥无关的工作。
- **ISR 到目标任务真正运行的路径，是一条可拆账的时延链**：跨核唤醒延迟可以近似写成 `T_irq_to_run = T_entry + T_isr + T_ready + T_ipi + T_sched + T_spin_wait`。其中最容易被忽视的不是 ISR 自己，而是 `T_ipi` 与 `T_spin_wait`，前者来自跨核唤醒，后者来自另一核长时间霸占自旋锁。
- **控制系统关心的是尾延迟，不是平均延迟**：若控制任务截止期为 `T_deadline`，控制计算本身需要 `T_ctrl`，安全余量为 `T_margin`，那么通信与唤醒链至少要满足 `T_irq_to_ctrl < T_deadline - T_ctrl - T_margin`。平均值再漂亮，只要最坏值越过这条线，系统就会在偶发压力下失稳。
- **核心亲和性不是调优细节，而是时序边界声明**：把 ISR 后半段工作固定到 Core 1，把控制任务固定到 Core 0，本质上是在告诉调度器“谁可以迁移，谁必须拥有稳定的局部时间轴”。双核调度的收益，很多时候来自隔离，而不是吞吐翻倍。
- **IRAM 路径不是性能优化，而是抖动治理**：若实时 ISR 或其热路径函数落在 Flash 上，当缓存暂时不可用时，原本几微秒的通知路径就可能被拖成不可预测的长尾。对硬实时链路来说，`IRAM_ATTR` 不是锦上添花，而是把执行路径从“通常很快”收束成“最坏也可估算”。
- **丢样策略必须显式设计，而不能被队列溢出隐式决定**：当生产速率大于消费速率时，系统一定会丢东西。与其让数据在双核之间排队到过期，不如显式选择“覆盖最旧样本”或“拒绝新样本”，因为这代表你已经承认系统在做实时优先级取舍，而不是假装所有数据都同样重要。
- **双核工程的关键不是把两个核都喂满，而是保护真正有截止期的那一条链**：网络、日志、遥测更在意 eventually complete；控制、保护、采样更在意 deadline。第二个核心最大的价值，往往是把高抖动工作隔离出去，让高优先级任务少等一次锁、少排一次队、少碰一次不可预期的尾巴。

## 代码能力展现

下面给出一个基于 **ESP-IDF FreeRTOS** 的双核通信示例。场景假设如下：

- `Core 0` 上的 ISR 只负责记录时间戳、投递 DMA 完成槽位描述符，并立即唤醒 `Core 1` 工作任务。
- `Core 1` 上的工作任务做耗时计算，但**不在临界区内处理数据**，而是先在本地栈完成计算，再把结果发布到共享快照。
- `Core 0` 上的控制任务只读取已经发布完成的最新快照；若唤醒尾延迟超过预算，则直接进入降级路径。

这段代码刻意避开“队列里搬大块数据”的写法，而采用 **环形描述符邮箱 + 双 bank 共享快照 + 直接任务通知 + `portMUX_TYPE` 短临界区**。重点不在“功能写全”，而在把 **资源所有权、锁持有上界和尾延迟预算** 明确写成代码结构。

```c
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_attr.h"
#include "esp_cpu.h"

#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

#define DUAL_CORE_MAILBOX_DEPTH              8U
#define DUAL_CORE_DMA_SLOT_COUNT             4U
#define DUAL_CORE_ENCODER_CPR             4096U
#define DUAL_CORE_WORKER_STACK_DEPTH      4096U
#define DUAL_CORE_CONTROL_STACK_DEPTH     3072U
#define DUAL_CORE_WORKER_PRIORITY           21U
#define DUAL_CORE_CONTROL_PRIORITY          24U
#define DUAL_CORE_WORKER_CORE                1
#define DUAL_CORE_CONTROL_CORE               0
#define DUAL_CORE_MIN_DT_US                 50U
#define DUAL_CORE_MAX_DT_US               5000U
#define DUAL_CORE_MAX_OMEGA_RAD_S        250.0f
#define DUAL_CORE_GYRO_ALPHA               0.75f

typedef struct
{
    uint16_t encoder_count;
    int16_t gyro_mdps;
    uint16_t period_us;
} DmaCaptureSlot_t;

typedef struct
{
    uint8_t dma_slot_index;
    uint16_t sample_count;
    uint32_t sequence;
    uint32_t isr_cycle_count;
} WorkDescriptor_t;

typedef struct
{
    uint32_t sequence;
    float angle_rad;
    float omega_rad_s;
    uint32_t wake_latency_us;
    bool degraded;
} ControlSnapshot_t;

typedef struct
{
    portMUX_TYPE mailbox_lock;
    volatile uint8_t write_index;
    volatile uint8_t read_index;
    volatile uint8_t pending_count;
    volatile uint32_t dropped_descriptors;
    volatile uint32_t next_sequence;
    WorkDescriptor_t mailbox[DUAL_CORE_MAILBOX_DEPTH];

    portMUX_TYPE snapshot_lock;
    volatile uint8_t active_bank;
    volatile uint32_t publish_count;
    ControlSnapshot_t snapshot_bank[2];

    TaskHandle_t worker_task;
    TaskHandle_t control_task;

    uint32_t cpu_hz;
    uint32_t wake_budget_us;
} DualCoreDispatchContext_t;

static DualCoreDispatchContext_t g_dispatch =
{
    .mailbox_lock = portMUX_INITIALIZER_UNLOCKED,
    .snapshot_lock = portMUX_INITIALIZER_UNLOCKED
};

static volatile DmaCaptureSlot_t g_dma_slots[DUAL_CORE_DMA_SLOT_COUNT];
static float g_last_angle_rad = 0.0f;

extern void App_ControlStep(const ControlSnapshot_t *snapshot);
extern void App_ControlEnterFallback(const ControlSnapshot_t *snapshot);
extern void App_DmaReleaseSlot(uint8_t slot_index);

static uint32_t DualCore_ClampU32(uint32_t value, uint32_t min_value, uint32_t max_value)
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

static float DualCore_ClampF32(float value, float min_value, float max_value)
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

static float DualCore_WrapPi(float angle_rad)
{
    while (angle_rad > (float)M_PI)
    {
        angle_rad -= 2.0f * (float)M_PI;
    }

    while (angle_rad < -(float)M_PI)
    {
        angle_rad += 2.0f * (float)M_PI;
    }

    return angle_rad;
}

/**
 * @brief 将 CPU cycle 差值映射为微秒，供尾延迟预算使用。
 * @param cycle_delta 两次采样之间的无符号 cycle 差值。
 * @param cpu_hz CPU 主频，单位 Hz。
 * @return 对应的时间，单位 us。
 *
 * @note 这里使用无符号减法处理 cycle counter 回卷，只要真实测量窗口
 *       小于一个 32 位计数器回卷周期，`cycle_now - cycle_then` 就仍然成立。
 *
 *       线性映射公式为：
 *       t_us = cycle_delta / f_cpu * 1e6
 */
static uint32_t DualCore_CyclesToUs(uint32_t cycle_delta, uint32_t cpu_hz)
{
    const uint64_t numerator = ((uint64_t)cycle_delta * 1000000ULL) + (uint64_t)cpu_hz - 1ULL;

    if (cpu_hz == 0U)
    {
        return 0U;
    }

    return (uint32_t)(numerator / (uint64_t)cpu_hz);
}

/**
 * @brief 在 ISR 中投递 DMA 完成描述符，并立即唤醒 Core 1 工作任务。
 * @param ctx 调度上下文。
 * @param dma_slot_index 已完成采样的 DMA 槽位索引。
 * @param sample_count 当前槽位包含的样本数。
 * @param isr_cycle_count ISR 入口捕获的 cycle 时间戳。
 * @param high_task_woken 供 `portYIELD_FROM_ISR()` 使用的高优先级唤醒标志。
 * @retval true  投递成功。
 * @retval false 参数非法或工作任务尚未就绪。
 *
 * @note 此处只传递“槽位所有权描述符”，不搬运整块样本数据。
 *       若在临界区内拷贝 N 字节载荷，则持锁时间近似满足：
 *       T_cs_hold ≈ T_lock + N / BW_mem + T_index_update
 *
 *       这会直接抬高另一核心高优先级任务的最坏等待时间。当前实现采取
 *       “覆盖最旧描述符”的策略，让系统在过载时显式偏向最新样本，而不是
 *       悄悄积压陈旧数据。
 */
static bool DualCore_MailboxPushFromIsr(DualCoreDispatchContext_t *ctx,
                                        uint8_t dma_slot_index,
                                        uint16_t sample_count,
                                        uint32_t isr_cycle_count,
                                        BaseType_t *high_task_woken)
{
    uint8_t write_index;
    uint32_t sequence;

    if ((ctx == NULL) || (high_task_woken == NULL) || (ctx->worker_task == NULL) ||
        (dma_slot_index >= DUAL_CORE_DMA_SLOT_COUNT))
    {
        return false;
    }

    portENTER_CRITICAL_ISR(&ctx->mailbox_lock);

    if (ctx->pending_count >= DUAL_CORE_MAILBOX_DEPTH)
    {
        ctx->read_index = (uint8_t)((ctx->read_index + 1U) % DUAL_CORE_MAILBOX_DEPTH);
        ctx->pending_count--;
        ctx->dropped_descriptors++;
    }

    write_index = ctx->write_index;
    sequence = ctx->next_sequence + 1U;

    ctx->mailbox[write_index].dma_slot_index = dma_slot_index;
    ctx->mailbox[write_index].sample_count = sample_count;
    ctx->mailbox[write_index].sequence = sequence;
    ctx->mailbox[write_index].isr_cycle_count = isr_cycle_count;

    ctx->write_index = (uint8_t)((write_index + 1U) % DUAL_CORE_MAILBOX_DEPTH);
    ctx->pending_count++;
    ctx->next_sequence = sequence;

    portEXIT_CRITICAL_ISR(&ctx->mailbox_lock);

    /* 任务通知只负责“叫醒谁”，数据仍留在共享槽位中。 */
    vTaskNotifyGiveFromISR(ctx->worker_task, high_task_woken);
    return true;
}

/**
 * @brief 从环形描述符邮箱中弹出一个待处理事件。
 * @param ctx 调度上下文。
 * @param out_desc 输出的工作描述符。
 * @retval true  成功取出一个描述符。
 * @retval false 当前邮箱为空。
 *
 * @note `pending_count`、`read_index` 和描述符元数据必须在同一把自旋锁下更新，
 *       但实际数据处理绝不能放进临界区，否则锁等待会直接折算进跨核尾延迟。
 */
static bool DualCore_MailboxPop(DualCoreDispatchContext_t *ctx, WorkDescriptor_t *out_desc)
{
    bool has_item = false;
    uint8_t read_index;

    if ((ctx == NULL) || (out_desc == NULL))
    {
        return false;
    }

    portENTER_CRITICAL(&ctx->mailbox_lock);

    if (ctx->pending_count > 0U)
    {
        read_index = ctx->read_index;
        *out_desc = ctx->mailbox[read_index];
        ctx->read_index = (uint8_t)((read_index + 1U) % DUAL_CORE_MAILBOX_DEPTH);
        ctx->pending_count--;
        has_item = true;
    }

    portEXIT_CRITICAL(&ctx->mailbox_lock);
    return has_item;
}

/**
 * @brief 将一帧采样数据映射为可供控制任务直接消费的快照。
 * @param slot DMA 采样槽内容。
 * @param desc 对应的描述符。
 * @param out_snapshot 输出控制快照。
 *
 * @note 这里显式写出从物理采样到控制状态的映射：
 *       角度映射：
 *       theta = 2 * pi * count / N_cpr
 *
 *       编码器差分速度：
 *       omega_enc = wrap(theta[k] - theta[k-1]) / dt
 *
 *       陀螺线性映射：
 *       omega_gyro = gyro_mdps * 1e-3 * pi / 180
 *
 *       融合后的速度：
 *       omega = alpha * omega_gyro + (1 - alpha) * omega_enc
 *
 *       这里的融合不是为了“更高级”，而是为了在双核链路中保留一个
 *       小而稳定的共享结果对象，避免把整段原始载荷暴露给控制任务。
 */
static void DualCore_BuildSnapshot(const DmaCaptureSlot_t *slot,
                                   const WorkDescriptor_t *desc,
                                   ControlSnapshot_t *out_snapshot)
{
    const float encoder_count = (float)slot->encoder_count;
    const float theta_rad = (2.0f * (float)M_PI * encoder_count) / (float)DUAL_CORE_ENCODER_CPR;
    const float dt_s = (float)DualCore_ClampU32(slot->period_us, DUAL_CORE_MIN_DT_US, DUAL_CORE_MAX_DT_US) * 1.0e-6f;
    const float gyro_rad_s = ((float)slot->gyro_mdps * 1.0e-3f) * ((float)M_PI / 180.0f);
    const float dtheta = DualCore_WrapPi(theta_rad - g_last_angle_rad);
    const float omega_enc = dtheta / dt_s;
    const float omega_fused = (DUAL_CORE_GYRO_ALPHA * gyro_rad_s) +
                              ((1.0f - DUAL_CORE_GYRO_ALPHA) * omega_enc);

    out_snapshot->sequence = desc->sequence;
    out_snapshot->angle_rad = theta_rad;
    out_snapshot->omega_rad_s = DualCore_ClampF32(omega_fused,
                                                  -DUAL_CORE_MAX_OMEGA_RAD_S,
                                                  DUAL_CORE_MAX_OMEGA_RAD_S);
    out_snapshot->wake_latency_us = 0U;
    out_snapshot->degraded = false;

    g_last_angle_rad = theta_rad;
}

/**
 * @brief 以双 bank 方式发布最新控制快照。
 * @param ctx 调度上下文。
 * @param snapshot 待发布的快照。
 *
 * @note 生产者始终写非活动 bank，写完后仅在短临界区内交换 `active_bank`。
 *       因此持锁时间退化为常数级元数据交换：
 *       T_cs_hold ≈ T_bank_swap + T_publish_counter
 *
 *       这比“在锁里整块复制快照”更适合跨核高优先级链路。
 */
static void DualCore_PublishSnapshot(DualCoreDispatchContext_t *ctx,
                                     const ControlSnapshot_t *snapshot)
{
    uint8_t publish_bank;

    publish_bank = (uint8_t)(ctx->active_bank ^ 1U);

    /* 非活动 bank 不会被消费者读取，因此可先在锁外完整写入。 */
    ctx->snapshot_bank[publish_bank] = *snapshot;

    portENTER_CRITICAL(&ctx->snapshot_lock);
    ctx->active_bank = publish_bank;
    ctx->publish_count++;
    portEXIT_CRITICAL(&ctx->snapshot_lock);
}

/**
 * @brief 读取最新已发布的控制快照。
 * @param ctx 调度上下文。
 * @param out_snapshot 输出的快照副本。
 * @retval true  成功读到快照。
 * @retval false 目前尚无可用快照。
 *
 * @note 读取动作在锁内完成小对象复制，确保控制任务拿到的是单次发布的完整镜像，
 *       而不是“前半段来自旧状态、后半段来自新状态”的撕裂结果。
 */
static bool DualCore_ReadLatestSnapshot(const DualCoreDispatchContext_t *ctx,
                                        ControlSnapshot_t *out_snapshot)
{
    bool has_snapshot = false;
    uint8_t active_bank;

    if ((ctx == NULL) || (out_snapshot == NULL))
    {
        return false;
    }

    portENTER_CRITICAL((portMUX_TYPE *)&ctx->snapshot_lock);

    if (ctx->publish_count > 0U)
    {
        active_bank = ctx->active_bank;
        *out_snapshot = ctx->snapshot_bank[active_bank];
        has_snapshot = true;
    }

    portEXIT_CRITICAL((portMUX_TYPE *)&ctx->snapshot_lock);
    return has_snapshot;
}

/**
 * @brief Core 1 工作任务：排空描述符邮箱，处理样本并发布快照。
 * @param arg 传入的调度上下文指针。
 *
 * @note 从 ISR 到工作任务真正开始运行的尾延迟近似满足：
 *       T_irq_to_run = T_entry + T_isr + T_ready + T_ipi + T_sched + T_spin_wait
 *
 *       其中本任务额外把 `cycle_now - cycle_irq` 折算为 `wake_latency_us`，
 *       再与预算比较。这样“是否还能把本帧当成新鲜数据使用”就不再是拍脑袋，
 *       而是一个可门控的工程量。
 */
static void DualCore_WorkerTask(void *arg)
{
    DualCoreDispatchContext_t *ctx = (DualCoreDispatchContext_t *)arg;
    WorkDescriptor_t desc;

    for (;;)
    {
        (void)ulTaskNotifyTake(pdTRUE, portMAX_DELAY);

        while (DualCore_MailboxPop(ctx, &desc))
        {
            DmaCaptureSlot_t slot_local;
            ControlSnapshot_t snapshot_local;
            uint32_t now_cycle;

            /* 将 DMA 槽内容复制到本地栈，避免后续计算持续占用共享存储体。 */
            slot_local = g_dma_slots[desc.dma_slot_index];

            DualCore_BuildSnapshot(&slot_local, &desc, &snapshot_local);

            now_cycle = esp_cpu_get_cycle_count();
            snapshot_local.wake_latency_us = DualCore_CyclesToUs(now_cycle - desc.isr_cycle_count,
                                                                 ctx->cpu_hz);
            snapshot_local.degraded = (snapshot_local.wake_latency_us > ctx->wake_budget_us);

            DualCore_PublishSnapshot(ctx, &snapshot_local);

            /* 工作任务处理完该槽位后，显式归还 DMA 所有权。 */
            App_DmaReleaseSlot(desc.dma_slot_index);

            if (ctx->control_task != NULL)
            {
                xTaskNotifyGive(ctx->control_task);
            }
        }
    }
}

/**
 * @brief Core 0 控制任务：只消费已发布完成的最新快照。
 * @param arg 传入的调度上下文指针。
 *
 * @note 若控制链截止期为 `T_deadline`，控制计算本身需要 `T_ctrl`，
 *       安全余量为 `T_margin`，则应满足：
 *       T_irq_to_ctrl < T_deadline - T_ctrl - T_margin
 *
 *       这里把超预算帧标记为 `degraded`，并直接进入降级路径，而不是继续
 *       假装这份数据仍然具有同等控制价值。
 */
static void DualCore_ControlTask(void *arg)
{
    const DualCoreDispatchContext_t *ctx = (const DualCoreDispatchContext_t *)arg;
    ControlSnapshot_t latest_snapshot;

    for (;;)
    {
        (void)ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(5U));

        if (!DualCore_ReadLatestSnapshot(ctx, &latest_snapshot))
        {
            continue;
        }

        if (latest_snapshot.degraded)
        {
            App_ControlEnterFallback(&latest_snapshot);
            continue;
        }

        App_ControlStep(&latest_snapshot);
    }
}

/**
 * @brief 初始化双核通信链路，并固定任务核心亲和性。
 * @param cpu_hz CPU 主频，单位 Hz。
 * @param wake_budget_us 允许的 ISR 到控制消费尾延迟预算，单位 us。
 * @retval true  初始化成功。
 * @retval false 任务创建失败或参数非法。
 *
 * @note 固定核心并不是为了“把两个核都用满”，而是为了让高抖动工作与
 *       deadline 敏感工作拥有不同的局部时间轴。`Core 0` 负责 ISR 与控制，
 *       `Core 1` 负责耗时处理，可以显著降低关键链路受到后台任务干扰的概率。
 */
bool DualCoreDispatch_Init(uint32_t cpu_hz, uint32_t wake_budget_us)
{
    BaseType_t worker_ok;
    BaseType_t control_ok;

    if (cpu_hz == 0U)
    {
        return false;
    }

    memset((void *)&g_dispatch.mailbox[0], 0, sizeof(g_dispatch.mailbox));
    memset((void *)&g_dispatch.snapshot_bank[0], 0, sizeof(g_dispatch.snapshot_bank));

    g_dispatch.write_index = 0U;
    g_dispatch.read_index = 0U;
    g_dispatch.pending_count = 0U;
    g_dispatch.dropped_descriptors = 0U;
    g_dispatch.next_sequence = 0U;
    g_dispatch.active_bank = 0U;
    g_dispatch.publish_count = 0U;
    g_dispatch.cpu_hz = cpu_hz;
    g_dispatch.wake_budget_us = DualCore_ClampU32(wake_budget_us, 10U, 2000U);

    worker_ok = xTaskCreatePinnedToCore(DualCore_WorkerTask,
                                        "dc_worker",
                                        DUAL_CORE_WORKER_STACK_DEPTH,
                                        &g_dispatch,
                                        DUAL_CORE_WORKER_PRIORITY,
                                        &g_dispatch.worker_task,
                                        DUAL_CORE_WORKER_CORE);

    control_ok = xTaskCreatePinnedToCore(DualCore_ControlTask,
                                         "dc_ctrl",
                                         DUAL_CORE_CONTROL_STACK_DEPTH,
                                         &g_dispatch,
                                         DUAL_CORE_CONTROL_PRIORITY,
                                         &g_dispatch.control_task,
                                         DUAL_CORE_CONTROL_CORE);

    return ((worker_ok == pdPASS) && (control_ok == pdPASS));
}

/**
 * @brief DMA 完成中断入口：只记录时间戳、投递描述符并触发调度。
 * @param dma_slot_index 已完成采样的 DMA 槽位编号。
 * @param sample_count 当前 DMA 槽位有效样本数。
 *
 * @note 这条 ISR 路径应放在 IRAM 中，并避免任何阻塞式或大块搬运操作。
 *       它只做三件事：
 *       1. 捕获事件发生时刻；
 *       2. 交出 DMA 槽位所有权描述符；
 *       3. 叫醒真正做事的任务。
 *
 *       真正的系统哲学是：ISR 负责建立时间顺序，任务负责消化时间成本。
 */
void IRAM_ATTR App_SensorDmaDoneIsr(uint8_t dma_slot_index, uint16_t sample_count)
{
    BaseType_t high_task_woken = pdFALSE;
    const uint32_t isr_cycle_count = esp_cpu_get_cycle_count();

    (void)DualCore_MailboxPushFromIsr(&g_dispatch,
                                      dma_slot_index,
                                      sample_count,
                                      isr_cycle_count,
                                      &high_task_woken);

    portYIELD_FROM_ISR(high_task_woken);
}
```

这段实现的重点不是“用了多少 RTOS API”，而是把双核系统里最容易失控的三件事拆开了：**ISR 只定义时间顺序、工作任务只承担计算成本、控制任务只消费完整快照**。真正的稳定，并不来自某个接口更高级，而来自每段路径都知道自己该拿什么、该锁多久、超时后该如何体面地退化。
