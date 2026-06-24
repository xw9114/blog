---
title: "技能档案：STM32 ADC 双缓冲 DMA、控制快照一致性与过载退化"
slug: "skill-stm32-adc-dma-double-buffer-snapshot-consistency-and-overrun-degradation"
date: 2026-06-24T09:18:00+08:00
draft: false
description: "从采样保持、电荷注入、DMA half/full transfer 到控制环读取撕裂与降级策略，系统拆解多通道 ADC 双缓冲为何决定控制回路是否读到同一时刻的物理世界。"
tags: ["STM32", "ADC", "DMA", "双缓冲", "控制系统", "实时系统", "嵌入式"]
categories: ["技能档案"]
image: ""
---

## 技能概述
在电机电流采样、电池管理、功率变换器闭环和多路模拟量监测里，`ADC + DMA` 常被当成“省 CPU 的搬运工具”，但真正的痛点从来不是搬运，而是 **控制器是否读到了同一时刻、同一尺度、同一批次的物理量**。一旦双缓冲边界设计错误，控制环可能在一半新数据和一半旧数据上做决策；一旦过载退化没有显式策略，DMA 仍在跑，系统却已经失去了时间一致性。这个主题真正解决的是：如何把模拟世界的连续变化，可靠地切成可提交给控制算法的离散快照。

## 核心底层概念解析

- **ADC 不是“读一个寄存器”，而是一次采样保持契约**：每个通道在进入 SAR 转换前，先由采样电容对输入电压充电。采样时间不够时，电容还没逼近真实输入，数字结果就已经带着前一通道残留和源阻抗误差进入内存。所谓“多通道扫描”，本质上是把多个模拟节点轮流映射到同一颗采样电容上。

- **扫描序列的顺序本身就是误差传播路径**：若通道 `i-1` 电压很高、通道 `i` 电压很低，而 `i` 又来自高源阻抗传感器，那么采样电容上的残余电荷会让 `i` 首次采样偏高。这个误差并不神秘，近似可看成  
  `V_err[i] ~= (V_prev - V_i) * exp(-T_sample / (R_source * C_sh))`。  
  它说明时序、源阻抗和采样窗口是绑定的，而不是 CubeMX 里几个独立下拉框。

- **DMA 的价值不是“免中断”，而是把序列边界固化成内存边界**：ADC 每完成一个转换就产生一个数据字，DMA 按顺序写入数组。只有当你把 `N_channel * N_frame` 个样本定义成一个完整批次，并且只在批次边界交给上层，控制环拿到的才是“同一份世界切片”。

- **Half Transfer / Transfer Complete 不是通知点，而是时间切面**：对循环 DMA 来说，`HT` 与 `TC` 分别意味着前半区和后半区刚刚完成写入。它们不是普通回调，而是系统唯一可以无锁获得“整块数据已经稳定”的时刻。错过这个边界，再去读环形缓冲，得到的就是撕裂快照。

- **所谓双缓冲，本质上是“生产者写 A 时，消费者只能读 B”**：这和图形渲染的 front/back buffer 是同一个哲学。ADC + DMA 不关心控制环何时消费，它只负责持续把物理世界压进内存；而控制环必须只读已经封存的那一半，绝不能读当前 DMA 正在落笔的页面。

- **快照一致性比单点精度更先决定系统是否可控**：如果三相电流 `Ia, Ib, Vbus, Temp` 各自都只有 1% 误差，但其中一半来自上个 PWM 周期、另一半来自这个 PWM 周期，那么对闭环控制器来说，这不是“小误差”，而是坐标系已经裂开。控制器最怕的不是噪声，而是偷偷失去同步。

- **过载时最先坏掉的往往不是 ADC，而是消费节拍**：DMA 照常每 `T_frame` 推送一批数据，但上层任务可能因为 RTOS 抢占、浮点计算过长或串口日志阻塞而来不及处理。于是“物理采样速率没变，算法视角的数据年龄却在增长”。这就是实时系统里典型的 **背压失配**。

- **过载退化要显式建模，而不是假装系统永远跟得上**：工程上要么丢旧帧保新鲜度，要么丢新帧保连续性，要么降采样保可完成性。关键不在“哪种更高级”，而在于你是否明确知道当前控制律依赖的是“最新状态”还是“完整历史”。不写策略，系统就会用最糟糕的方式随机退化。

- **从数学上看，双缓冲是在构造离散时域中的零阶保持快照**：若第 `k` 批快照覆盖时间窗 `[kT, (k+1)T)`，控制环在 `t = (k+1)T + delta` 读取到的样本向量可记为  
  `x_hat[k] = [x_0[k], x_1[k], ..., x_n[k]]^T`。  
  只有当这些分量来自同一已封存批次，这个向量才有资格进入状态估计、PID、FOC 或保护判据。

- **缓存一致性不只属于高端 MPU，在 MCU 上也有“语义一致性”问题**：即使没有 D-Cache，仍然会有“索引刚更新但内容未消费”“事件计数溢出但状态未上报”“任务读到了上次快照却误以为是新数据”等语义层面的不一致。锁不住物理时间，就必须锁住提交语义。

- **技术哲学上，DMA 不是帮 CPU 偷懒，而是在替系统定义什么叫“这一次观测已经完成”**：嵌入式控制并不直接作用于真实连续世界，它先作用于一份离散快照。快照的边界如果不可靠，闭环就不是闭环，只是一种对残片做出的快速反应。

## 代码能力展现

下面给出一段基于 STM32 HAL 风格的多通道 ADC 双缓冲快照管理代码。它不把重点放在 `HAL_ADC_Start_DMA()` 的调用，而是放在三件真正决定工程质量的事情上：

- 如何把 `half/full transfer` 事件变成 **已封存快照**。
- 如何保证控制任务只读取 **完整批次**，不读取 DMA 正在写的半区。
- 如何在消费跟不上时做 **过载计数与显式降级**。

```cpp
#include "stm32f4xx_hal.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

#define ADC_CHANNEL_COUNT            (4U)
#define ADC_SAMPLES_PER_FRAME        (32U)
#define ADC_HALFWORD_COUNT_PER_BANK  (ADC_CHANNEL_COUNT * ADC_SAMPLES_PER_FRAME)
#define ADC_DMA_BUFFER_LENGTH        (ADC_HALFWORD_COUNT_PER_BANK * 2U)

typedef enum
{
    ADC_SNAPSHOT_DROP_NONE = 0,
    ADC_SNAPSHOT_DROP_OLD_FRAME,
    ADC_SNAPSHOT_DROP_NEW_FRAME
} AdcSnapshotDropPolicy_t;

typedef struct
{
    float ia_mean_a;
    float ib_mean_a;
    float vbus_mean_v;
    float ntc_mean_deg_c;
    uint32_t sequence_id;
    uint32_t overrun_count;
    uint32_t dropped_frame_count;
    bool valid;
} AdcSnapshot_t;

typedef struct
{
    ADC_HandleTypeDef *hadc;
    DMA_HandleTypeDef *hdma;
    volatile uint16_t dma_buffer[ADC_DMA_BUFFER_LENGTH];
    volatile uint32_t produced_sequence_id;
    volatile uint32_t consumed_sequence_id;
    volatile uint32_t overrun_count;
    volatile uint32_t dropped_frame_count;
    volatile uint8_t ready_bank_mask;
    AdcSnapshotDropPolicy_t drop_policy;
    AdcSnapshot_t last_snapshot;
} AdcDmaSnapshotContext_t;

static AdcDmaSnapshotContext_t g_adc1_dma_ctx;

static float ClampF(float value, float min_value, float max_value)
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
 * @brief 将 ADC 原始码值线性映射为相电流。
 * @param adc_code ADC 原始码值，12-bit 有效。
 * @param vref_v ADC 参考电压。
 * @param shunt_ohm 采样电阻值。
 * @param gain 电流采样放大倍数。
 * @param offset_code 零电流偏置码值。
 * @return 映射后的电流值，单位 A。
 *
 * @note 线性链路如下：
 *       1. ADC 输入电压：
 *          v_adc = ((adc_code - offset_code) / 4095) * vref_v
 *       2. 采样电阻两端压降：
 *          v_shunt = v_adc / gain
 *       3. 电流映射：
 *          i_phase = v_shunt / shunt_ohm
 *
 *       合并得：
 *          i_phase = ((adc_code - offset_code) * vref_v) / (4095 * gain * shunt_ohm)
 */
static float AdcCodeToCurrentA(uint16_t adc_code,
                               float vref_v,
                               float shunt_ohm,
                               float gain,
                               uint16_t offset_code)
{
    const int32_t signed_code = (int32_t)adc_code - (int32_t)offset_code;
    const float denominator = 4095.0f * gain * shunt_ohm;

    if ((shunt_ohm <= 1.0e-9f) || (gain <= 1.0e-9f))
    {
        return 0.0f;
    }

    return ((float)signed_code * vref_v) / denominator;
}

/**
 * @brief 将 ADC 原始码值映射为母线电压。
 * @param adc_code ADC 原始码值。
 * @param vref_v ADC 参考电压。
 * @param r_upper 分压上拉电阻。
 * @param r_lower 分压下拉电阻。
 * @return 母线电压，单位 V。
 *
 * @note 分压关系：
 *       v_adc  = (adc_code / 4095) * vref_v
 *       v_bus  = v_adc * (r_upper + r_lower) / r_lower
 */
static float AdcCodeToBusVoltageV(uint16_t adc_code,
                                  float vref_v,
                                  float r_upper,
                                  float r_lower)
{
    if (r_lower <= 1.0e-9f)
    {
        return 0.0f;
    }

    return ((float)adc_code * vref_v / 4095.0f) * ((r_upper + r_lower) / r_lower);
}

/**
 * @brief 将 NTC 分压点电压粗略映射为温度。
 * @param adc_code ADC 原始码值。
 * @param vref_v ADC 参考电压。
 * @return 温度，单位摄氏度。
 *
 * @note 这里用线性近似只为示意快照链路，不展开完整 B 参数方程。
 *       工程中应根据热敏电阻曲线表或 Steinhart-Hart 方程替换。
 */
static float AdcCodeToTemperatureDegC(uint16_t adc_code, float vref_v)
{
    const float v_adc = ((float)adc_code * vref_v) / 4095.0f;
    const float temp_deg_c = 85.0f - (50.0f * v_adc);

    return ClampF(temp_deg_c, -40.0f, 125.0f);
}

/**
 * @brief 根据 DMA 完成的半区索引，返回该半区首地址。
 * @param ctx 快照上下文。
 * @param bank_index 0 表示前半区，1 表示后半区。
 * @return 对应半区首地址；非法输入时返回 NULL。
 */
static volatile uint16_t *AdcGetBankBase(const AdcDmaSnapshotContext_t *ctx, uint8_t bank_index)
{
    if (ctx == NULL)
    {
        return NULL;
    }

    if (bank_index == 0U)
    {
        return &ctx->dma_buffer[0];
    }

    if (bank_index == 1U)
    {
        return &ctx->dma_buffer[ADC_HALFWORD_COUNT_PER_BANK];
    }

    return NULL;
}

/**
 * @brief 将一个已封存 bank 的多通道样本平均并生成物理快照。
 * @param ctx 快照上下文。
 * @param bank_index 已经写完的 DMA 半区索引。
 * @param snapshot_out 输出快照。
 * @retval true 生成成功。
 * @retval false 输入非法。
 *
 * @note 这里按交织布局读取：
 *       sample[0] = ch0, sample[1] = ch1, ..., sample[n-1] = chN
 *       frame_stride = ADC_CHANNEL_COUNT
 *
 *       对第 k 组采样和第 c 个通道，其线性地址为：
 *       idx = k * ADC_CHANNEL_COUNT + c
 *
 *       只有当整块 bank 已经封存后，这个二维映射才成立；
 *       若 DMA 仍在写，该矩阵就是撕裂的。
 */
static bool AdcBuildSnapshotFromBank(const AdcDmaSnapshotContext_t *ctx,
                                     uint8_t bank_index,
                                     AdcSnapshot_t *snapshot_out)
{
    uint32_t k = 0U;
    float ia_sum_a = 0.0f;
    float ib_sum_a = 0.0f;
    float vbus_sum_v = 0.0f;
    float ntc_sum_deg_c = 0.0f;
    volatile uint16_t *bank_base = NULL;

    if ((ctx == NULL) || (snapshot_out == NULL))
    {
        return false;
    }

    bank_base = AdcGetBankBase(ctx, bank_index);

    if (bank_base == NULL)
    {
        return false;
    }

    for (k = 0U; k < ADC_SAMPLES_PER_FRAME; ++k)
    {
        const uint32_t base = k * ADC_CHANNEL_COUNT;
        const uint16_t ia_code = bank_base[base + 0U];
        const uint16_t ib_code = bank_base[base + 1U];
        const uint16_t vbus_code = bank_base[base + 2U];
        const uint16_t ntc_code = bank_base[base + 3U];

        ia_sum_a += AdcCodeToCurrentA(ia_code, 3.3f, 0.005f, 20.0f, 2048U);
        ib_sum_a += AdcCodeToCurrentA(ib_code, 3.3f, 0.005f, 20.0f, 2048U);
        vbus_sum_v += AdcCodeToBusVoltageV(vbus_code, 3.3f, 100000.0f, 4700.0f);
        ntc_sum_deg_c += AdcCodeToTemperatureDegC(ntc_code, 3.3f);
    }

    snapshot_out->ia_mean_a = ia_sum_a / (float)ADC_SAMPLES_PER_FRAME;
    snapshot_out->ib_mean_a = ib_sum_a / (float)ADC_SAMPLES_PER_FRAME;
    snapshot_out->vbus_mean_v = vbus_sum_v / (float)ADC_SAMPLES_PER_FRAME;
    snapshot_out->ntc_mean_deg_c = ntc_sum_deg_c / (float)ADC_SAMPLES_PER_FRAME;
    snapshot_out->sequence_id = ctx->produced_sequence_id;
    snapshot_out->overrun_count = ctx->overrun_count;
    snapshot_out->dropped_frame_count = ctx->dropped_frame_count;
    snapshot_out->valid = true;

    return true;
}

/**
 * @brief 在 DMA bank 完成时提交一个“可消费快照”事件。
 * @param ctx 快照上下文。
 * @param bank_index 完成写入的 bank，0 表示前半区，1 表示后半区。
 *
 * @note ready_bank_mask 的 bit0/bit1 分别表示 bank0/bank1 已封存可读。
 *       当上层还没消费完旧 bank，新 bank 又到达时，说明消费者节拍落后于生产者。
 *       这时不应沉默覆盖，而要显式累计 overrun 并按策略丢帧。
 */
static void AdcCommitReadyBank(AdcDmaSnapshotContext_t *ctx, uint8_t bank_index)
{
    const uint8_t bank_bit = (uint8_t)(1U << bank_index);

    if (ctx == NULL)
    {
        return;
    }

    ctx->produced_sequence_id++;

    if ((ctx->ready_bank_mask & bank_bit) != 0U)
    {
        ctx->overrun_count++;

        if (ctx->drop_policy == ADC_SNAPSHOT_DROP_NEW_FRAME)
        {
            ctx->dropped_frame_count++;
            return;
        }
    }

    if ((ctx->ready_bank_mask != 0U) &&
        (ctx->drop_policy == ADC_SNAPSHOT_DROP_OLD_FRAME))
    {
        /* 保鲜优先：旧快照作废，只保留刚封存的最新 bank。 */
        ctx->ready_bank_mask = 0U;
        ctx->dropped_frame_count++;
    }

    ctx->ready_bank_mask |= bank_bit;
}

/**
 * @brief 初始化 ADC DMA 双缓冲快照上下文。
 * @param ctx 快照上下文。
 * @param hadc ADC 句柄。
 * @param hdma DMA 句柄。
 * @param drop_policy 过载丢帧策略。
 */
static void AdcSnapshotInit(AdcDmaSnapshotContext_t *ctx,
                            ADC_HandleTypeDef *hadc,
                            DMA_HandleTypeDef *hdma,
                            AdcSnapshotDropPolicy_t drop_policy)
{
    if (ctx == NULL)
    {
        return;
    }

    (void)memset((void *)ctx, 0, sizeof(*ctx));
    ctx->hadc = hadc;
    ctx->hdma = hdma;
    ctx->drop_policy = drop_policy;
}

/**
 * @brief 启动 ADC + 循环 DMA 采样。
 * @param ctx 快照上下文。
 * @retval HAL_OK 启动成功。
 * @retval 其他 HAL 状态值表示失败。
 */
static HAL_StatusTypeDef AdcSnapshotStart(AdcDmaSnapshotContext_t *ctx)
{
    if ((ctx == NULL) || (ctx->hadc == NULL))
    {
        return HAL_ERROR;
    }

    return HAL_ADC_Start_DMA(ctx->hadc,
                             (uint32_t *)ctx->dma_buffer,
                             ADC_DMA_BUFFER_LENGTH);
}

/**
 * @brief 从已封存 bank 中取出一份一致性快照。
 * @param ctx 快照上下文。
 * @param snapshot_out 输出快照。
 * @retval true 成功取到一份完整快照。
 * @retval false 当前没有完整快照可取。
 *
 * @note 关键点不在“复制数据”，而在“只消费已封存半区”。
 *       这里通过短临界区摘取 ready_bank_mask，避免任务层和中断层并发修改。
 */
static bool AdcSnapshotAcquire(AdcDmaSnapshotContext_t *ctx, AdcSnapshot_t *snapshot_out)
{
    uint32_t primask = 0U;
    uint8_t local_ready_mask = 0U;
    uint8_t selected_bank = 0xFFU;

    if ((ctx == NULL) || (snapshot_out == NULL))
    {
        return false;
    }

    primask = __get_PRIMASK();
    __disable_irq();
    local_ready_mask = ctx->ready_bank_mask;

    if ((local_ready_mask & 0x01U) != 0U)
    {
        selected_bank = 0U;
        ctx->ready_bank_mask &= (uint8_t)(~0x01U);
    }
    else if ((local_ready_mask & 0x02U) != 0U)
    {
        selected_bank = 1U;
        ctx->ready_bank_mask &= (uint8_t)(~0x02U);
    }

    if (primask == 0U)
    {
        __enable_irq();
    }

    if (selected_bank > 1U)
    {
        return false;
    }

    if (!AdcBuildSnapshotFromBank(ctx, selected_bank, snapshot_out))
    {
        return false;
    }

    ctx->consumed_sequence_id = snapshot_out->sequence_id;
    ctx->last_snapshot = *snapshot_out;

    return true;
}

/**
 * @brief DMA 半传输完成回调，在前半区写满时提交 bank0。
 * @param hdma DMA 句柄。
 */
void HAL_ADC_ConvHalfCpltCallback(ADC_HandleTypeDef *hadc)
{
    if ((hadc != NULL) && (hadc == g_adc1_dma_ctx.hadc))
    {
        AdcCommitReadyBank(&g_adc1_dma_ctx, 0U);
    }
}

/**
 * @brief DMA 全传输完成回调，在后半区写满时提交 bank1。
 * @param hdma DMA 句柄。
 */
void HAL_ADC_ConvCpltCallback(ADC_HandleTypeDef *hadc)
{
    if ((hadc != NULL) && (hadc == g_adc1_dma_ctx.hadc))
    {
        AdcCommitReadyBank(&g_adc1_dma_ctx, 1U);
    }
}

/**
 * @brief 控制任务中的快照消费示例。
 * @param argument RTOS 任务参数。
 *
 * @note 若任务本周期没拿到新快照，可继续使用 last_snapshot 或触发降级策略。
 *       不建议直接去读 dma_buffer，因为那会绕开一致性边界。
 */
void ControlTask(void *argument)
{
    AdcSnapshot_t snapshot;

    (void)argument;

    for (;;)
    {
        if (AdcSnapshotAcquire(&g_adc1_dma_ctx, &snapshot))
        {
            /* 此处拿到的是同一 bank 内的完整快照，可安全进入控制律。 */
            /* 例如：电流环、母线欠压保护、热保护都应基于 snapshot 而非裸 DMA 缓冲区。 */
        }
        else if (g_adc1_dma_ctx.last_snapshot.valid)
        {
            /* 降级模式：本周期复用上次完整快照，必要时降低控制带宽或限制输出。 */
        }

        osDelay(1U);
    }
}
```

这段代码真正要表达的工程结论有四个：

- **DMA 缓冲区不是业务数据结构，快照才是**。前者只是 ADC 正在书写的草稿纸，后者才是允许控制器引用的已签字版本。
- **双缓冲的核心不是吞吐，而是一致性**。如果任务直接遍历 `dma_buffer`，你得到的只是“看起来很快”，但不是“时间上自洽”。
- **过载必须显式计数**。`overrun_count` 和 `dropped_frame_count` 不是调试装饰，它们是系统是否还处于实时工作区间的证据。
- **降级策略要和控制目标匹配**。电流环通常更偏向“丢旧保新”，趋势监控则可能更偏向“保序不跳帧”。策略不同，系统语义就不同。

如果要继续把这套链路做实，下一步通常不是继续堆 HAL API，而是回到三个更底层的问题上：ADC 触发相位是否和 PWM 死区错开、通道排序是否考虑了源阻抗与电荷注入、以及控制任务最坏执行时间是否真的小于两次快照提交间隔。只有这三件事同时成立，`ADC + DMA` 才不只是搬运，而是真正可用于闭环控制的观测前端。
