---
title: "技能档案：STM32 ADC DMA 的 D-Cache 一致性、半传输提交与 Cache Line 可见性"
slug: "skill-stm32-adc-dma-dcache-coherency-half-transfer-and-cacheline-visibility"
date: 2026-07-24T22:20:31+08:00
draft: false
description: "从 AXI SRAM 与 DTCM 的可达性、32-byte cache line 对齐、half/full transfer 提交边界到 SCB_InvalidateDCache_by_Addr 的失效范围计算，系统拆解 STM32H7 上 ADC DMA 为什么不是“搬到了内存就算 CPU 可见”。"
tags: ["STM32", "STM32H7", "ADC", "DMA", "D-Cache", "Cortex-M7", "实时系统"]
categories: ["技能档案"]
image: ""
---

## 技能概述

在 `STM32H7` 这类带 `Cortex-M7 D-Cache` 的平台上，`ADC + DMA` 最容易制造的一类错觉，就是**示波器、寄存器和 DMA 都告诉你“数据已经进内存了”，控制环却仍然在读上一拍的世界**。问题不在 `HAL_ADC_Start_DMA()` 有没有成功，而在于你是否真正闭合了三条合同：**DMA 能不能到达那片 SRAM、Cache Line 有没有被失效、half/full transfer 边界有没有被翻译成软件可消费的快照提交点**。这个主题要解决的核心痛点，不是再讲一遍搬运 API，而是把“外设写入”与“CPU 可见”这两个常被混为一谈的时序边界彻底剥开，让高速采样链路不再因为缓存一致性而悄悄读穿旧样本。

## 核心底层概念解析

- **`DMA 写到 SRAM` 不等于 `CPU 立即看见新数据`**：`Cortex-M7` 的 `D-Cache` 缓存的是 CPU 视角下的内存副本，而大多数 STM32 的 `DMA/BDMA/MDMA` 写的是 SRAM 本体，不会顺手更新 CPU cache。于是外设早已把新样本打进了 AXI SRAM，CPU 却还可能从旧 cache line 里读到上一帧数据。所谓“采样错乱”，很多时候并不是 ADC 错了，而是**可见性边界没闭合**。

- **`DTCM`、`AXI SRAM`、`SRAM1/2/3` 的差别，不只是速度差，而是“DMA 是否有资格到场”**：在不少 `STM32H7` 方案里，`DTCM` 只挂在 CPU TCM 端口，普通 DMA 根本到不了；`AXI SRAM` 虽然可被 DMA 访问，却又受 D-Cache 影响。这意味着 DMA 缓冲区的第一个合同，不是“数组声明出来了没有”，而是**它究竟落在了一片既能被外设写、又能被 CPU 以正确一致性读取的内存上**。

- **`Cache Line` 才是 CPU 可见性的最小货币单位**：对大多数 `Cortex-M7`，`D-Cache line` 大小是 `32 byte`。如果 DMA 写入区间起始地址为 `A`、长度为 `N`、cache line 长度为 `L`，则失效范围必须按  
  `A_inv = floor(A / L) * L`，  
  `N_inv = ceil((A mod L + N) / L) * L`  
  计算。也就是说，软件根本不是对“你想读的那几个样本”做失效，而是在**按整条 cache line 的边界做可见性结算**。

- **`volatile` 只能阻止编译器偷懒，不能替你做 cache coherence**：把 DMA 缓冲区声明成 `volatile` 很重要，因为它告诉编译器“这片内存可能被外部世界修改”；但 `volatile` 不会驱逐 cache，不会执行 `SCB_InvalidateDCache_by_Addr()`，也不会替你处理共享 line。它解决的是**优化器语义**，而不是**硬件一致性语义**。

- **半传输/全传输回调只是“DMA 写完了”，还不是“CPU 已经能安全读了”**：`HT/TC` 事件定义了时间边界，说明某半块 SRAM 已不再被 DMA 改写；但对 M7 来说，还必须在这个边界之后显式做 `Invalidate`，再通过 `DMB` 把“失效完成”与“发布 ready 标记”排序好。于是可见性延迟更接近  
  `T_visible ~= T_dma_boundary + T_cache_maint + T_sched`。  
  如果忽略其中任何一项，控制任务读到的就可能不是“刚写完的半块”，而是“刚写完但我还没真正看见的半块”。

- **`Dirty cache line` 甚至会反过来污染 DMA 结果**：若 CPU 在 DMA 启动前用 `memset()` 写过缓冲区，而这片 line 仍保持 dirty，后续某次 cache write-back 就可能把旧值重新写回 SRAM，把 DMA 刚写进去的新样本覆盖掉。因此 DMA 启动前常常必须对整块缓冲区执行 `CleanInvalidate`，这不是仪式，而是在阻止**CPU 的陈旧脏行反向踩坏外设数据**。

- **DMA 缓冲区不能和普通变量混住同一条 cache line**：如果一个 cache line 里既有 DMA 正在写的采样区，又有 CPU 正在改的状态变量，那么对该 line 执行 invalidate 时，CPU 尚未写回的状态变量就可能被丢掉；执行 clean 时，又可能把旧采样覆写回去。这就是为什么工程上要把 DMA buffer 放进**独立 section + 32-byte 对齐 + 不与其他对象拼行**的专用区域。

- **`B_half` 决定的是一次维护要付多少 cache 成本，而 `T_half` 决定你多久必须付一次**：若每个通道样本宽度为 `2 byte`、通道数为 `N_ch`、半缓冲帧数为 `N_f`，则  
  `B_half = 2 * N_ch * N_f`。  
  若 ADC 由定时器以序列频率 `f_seq` 触发，则  
  `T_half = N_f / f_seq`。  
  于是 cache 维护占用率可粗略写成  
  `ρ_cache ~= T_invalidate / T_half`。  
  这说明你切大 half-buffer 会增加单次维护成本，但切太小又会提高维护频率，本质上是在**缓存维护抖动**与**数据年龄**之间做时域交易。

- **“快照一致”与“数据新鲜”是两份不同合同**：哪怕 half-buffer 的可见性完全正确，如果控制任务处理速度跟不上，DMA 下一轮回来时同一半区仍未被消费，旧快照一样会被覆盖。前者是 cache coherence 问题，后者是生产消费节拍失配。它们都可能表现成“偶发读错”，但根因完全不同，修法也完全不同。

- **`__DMB()` 的价值不在于提高速度，而在于禁止错误的提交顺序**：如果你先设置 `ready_mask`，再去 invalidate，消费者线程就可能在失效完成前读到“新数据已就绪”的标记。`DMB` 的本质，是在说：**先让样本在 CPU 视角下变得可见，再允许软件世界承认它可消费**。

- **调试时最该怀疑的，不是 ADC 精度，而是“这份数据究竟属于谁的时间轴”**：一旦现象表现为“停在某个优化级别才错”“开 log 就好、关 log 就坏”“DMA 统计正常但控制量偶发回跳”，优先检查缓存区 placement、invalidate 范围、共享 cache line 与 ready 发布顺序。因为这类 bug 往往不是模拟误差，而是**内存一致性把时间戳偷换了**。

- **技术哲学上，D-Cache 不是纯收益，它要求你为“更快的本地视图”支付“更复杂的真相同步成本”**：没有 cache 的 MCU 里，“SRAM 里的东西大概率就是 CPU 看到的东西”；有 cache 的 M7 里，CPU 看到的是一份更快、也更可能过期的世界副本。高速系统真正要学会的，不是抱怨 cache 麻烦，而是承认**性能从来不是白给的，它总要以时序合同和一致性纪律来偿还**。

## 代码能力展现

下面给出一段基于 **STM32 HAL 风格** 的 `ADC + DMA + D-Cache` 采样骨架。代码刻意不把重点放在“怎样把 ADC 跑起来”，而是放在四个真正决定这条链路是否可信的环节上：

- 把 DMA 缓冲区放进 **DMA 可达且独占 cache line** 的 SRAM 区域；
- 用 `half/full transfer` 回调定义**已写完的时间边界**；
- 用 `SCB_CleanInvalidateDCache_by_Addr()` 与 `SCB_InvalidateDCache_by_Addr()` 闭合**CPU 可见性边界**；
- 在消费端只读取**最新且已提交**的快照，并显式统计“来不及消费而被覆盖”的失帧。

```c
#include "main.h"

#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#define ADC_DMA_CACHE_LINE_BYTES                 32U
#define ADC_DMA_CHANNEL_COUNT                     4U
#define ADC_DMA_FRAMES_PER_HALF                  32U
#define ADC_DMA_HALFWORDS_PER_HALF               (ADC_DMA_CHANNEL_COUNT * ADC_DMA_FRAMES_PER_HALF)
#define ADC_DMA_TOTAL_HALFWORDS                  (2U * ADC_DMA_HALFWORDS_PER_HALF)
#define ADC_DMA_MAX_VREF_V                       3.6f
#define ADC_DMA_MIN_SHUNT_OHM                    1.0e-5f
#define ADC_DMA_MIN_GAIN                         1.0e-3f
#define ADC_DMA_MIN_DIVIDER_OHM                  1.0f
#define ADC_DMA_MAX_TEMP_DEGC                  125.0f
#define ADC_DMA_MIN_TEMP_DEGC                  -40.0f

typedef struct
{
    float ia_mean_a;
    float ib_mean_a;
    float vbus_mean_v;
    float ntc_mean_deg_c;
    uint32_t sequence_id;
    uint32_t overwritten_frame_count;
    uint32_t skipped_stale_count;
    bool valid;
} AdcDmaSnapshot_t;

typedef struct
{
    ADC_HandleTypeDef *hadc;
    volatile uint16_t *dma_buffer;

    volatile uint8_t ready_mask;
    volatile uint32_t produced_sequence;
    volatile uint32_t overwritten_frame_count;
    volatile uint32_t skipped_stale_count;
    volatile uint32_t cache_maint_count;
    volatile uint32_t bank_sequence[2];

    float vref_v;
    float shunt_ohm;
    float shunt_gain;
    uint16_t current_offset_code;
    float vbus_r_upper_ohm;
    float vbus_r_lower_ohm;
} AdcDmaCacheContext_t;

extern ADC_HandleTypeDef hadc1;

/* 这块缓冲区必须放在 DMA 可访问的 SRAM 中。
 * 以 STM32H7 为例，通常应映射到 AXI SRAM 或 SRAM1/2/3，而不是 DTCM。
 * 同时必须 32-byte 对齐，避免半缓冲区与其他变量共享 cache line。
 */
__attribute__((section(".axisram.adc_dma"), aligned(ADC_DMA_CACHE_LINE_BYTES)))
static uint16_t g_adc1_dma_buffer[ADC_DMA_TOTAL_HALFWORDS];

static AdcDmaCacheContext_t g_adc1_dma_ctx;

static float AdcDma_ClampF(float value, float min_value, float max_value)
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

static uint32_t AdcDma_AlignDownU32(uint32_t value, uint32_t align)
{
    if (align == 0U)
    {
        return value;
    }

    return value & ~(align - 1U);
}

static uint32_t AdcDma_AlignUpU32(uint32_t value, uint32_t align)
{
    if (align == 0U)
    {
        return value;
    }

    return (value + align - 1U) & ~(align - 1U);
}

static uint32_t AdcDma_EnterCritical(void)
{
    const uint32_t primask = __get_PRIMASK();

    __disable_irq();
    return primask;
}

static void AdcDma_ExitCritical(uint32_t primask)
{
    if ((primask & 0x1U) == 0U)
    {
        __enable_irq();
    }
}

/**
 * @brief 对 DMA 缓冲区执行 Clean + Invalidate，清除 CPU 旧脏数据并丢弃旧 cache 视图。
 * @param addr 起始地址。
 * @param size_bytes 数据长度，单位 byte。
 *
 * @note 对于 cache line 长度为 L 的 M7，必须按整行维护：
 *       A_aligned = floor(A / L) * L
 *       N_aligned = ceil((A mod L + N) / L) * L
 *
 *       启动 DMA 前做 CleanInvalidate 的目的有两层：
 *       1. 若 CPU 之前 memset 过缓冲区，脏行不会在之后写回并覆盖 DMA 结果；
 *       2. CPU 之后读取该区间时，不会沿用旧 cache line 的陈旧副本。
 */
static void AdcDma_CleanInvalidateByAddr(void *addr, uint32_t size_bytes)
{
#if defined(__DCACHE_PRESENT) && (__DCACHE_PRESENT == 1U)
    uint32_t base;
    uint32_t span;

    if ((addr == NULL) || (size_bytes == 0U))
    {
        return;
    }

    base = AdcDma_AlignDownU32((uint32_t)addr, ADC_DMA_CACHE_LINE_BYTES);
    span = AdcDma_AlignUpU32((((uint32_t)addr - base) + size_bytes), ADC_DMA_CACHE_LINE_BYTES);

    SCB_CleanInvalidateDCache_by_Addr((uint32_t *)base, (int32_t)span);
#else
    (void)addr;
    (void)size_bytes;
#endif
}

/**
 * @brief 对 DMA 已写完的半缓冲区做 Invalidate，使 CPU 下一次读取直接回到 SRAM。
 * @param addr 起始地址。
 * @param size_bytes 数据长度，单位 byte。
 *
 * @note 对 ADC 外设到内存的单向流而言，DMA 完成后通常不需要 clean，只需要 invalidate。
 *       因为目标是丢掉 CPU 的旧 cache line，让新的 load 从 SRAM 重新取样本。
 */
static void AdcDma_InvalidateByAddr(const void *addr, uint32_t size_bytes)
{
#if defined(__DCACHE_PRESENT) && (__DCACHE_PRESENT == 1U)
    uint32_t base;
    uint32_t span;

    if ((addr == NULL) || (size_bytes == 0U))
    {
        return;
    }

    base = AdcDma_AlignDownU32((uint32_t)addr, ADC_DMA_CACHE_LINE_BYTES);
    span = AdcDma_AlignUpU32((((uint32_t)addr - base) + size_bytes), ADC_DMA_CACHE_LINE_BYTES);

    SCB_InvalidateDCache_by_Addr((uint32_t *)base, (int32_t)span);
#else
    (void)addr;
    (void)size_bytes;
#endif
}

/**
 * @brief 将 ADC 原始码值映射为相电流。
 * @param adc_code 原始 12-bit ADC 码值。
 * @param vref_v 当前 ADC 参考电压，单位 V。
 * @param shunt_ohm 采样电阻，单位 ohm。
 * @param gain 电流采样放大倍数。
 * @param offset_code 零电流偏置码值。
 * @return 相电流，单位 A。
 *
 * @note 线性映射链路如下：
 *       Vadc = adc_code / 4095 * Vref
 *       Voffset = offset_code / 4095 * Vref
 *       Vshunt = (Vadc - Voffset) / Gain
 *       Iphase = Vshunt / Rshunt
 *
 *       合并后得到：
 *       Iphase = ((adc_code - offset_code) * Vref) / (4095 * Gain * Rshunt)
 */
static float AdcDma_CodeToCurrentA(uint16_t adc_code,
                                   float vref_v,
                                   float shunt_ohm,
                                   float gain,
                                   uint16_t offset_code)
{
    const int32_t signed_code = (int32_t)adc_code - (int32_t)offset_code;
    const float denominator = 4095.0f * gain * shunt_ohm;

    if ((shunt_ohm < ADC_DMA_MIN_SHUNT_OHM) || (gain < ADC_DMA_MIN_GAIN))
    {
        return 0.0f;
    }

    return ((float)signed_code * vref_v) / denominator;
}

/**
 * @brief 将 ADC 原始码值映射为母线电压。
 * @param adc_code 原始 ADC 码值。
 * @param vref_v 当前参考电压，单位 V。
 * @param r_upper 分压上拉电阻，单位 ohm。
 * @param r_lower 分压下拉电阻，单位 ohm。
 * @return 母线电压，单位 V。
 *
 * @note 分压关系：
 *       Vadc = adc_code / 4095 * Vref
 *       Vbus = Vadc * (Rupper + Rlower) / Rlower
 */
static float AdcDma_CodeToBusVoltageV(uint16_t adc_code,
                                      float vref_v,
                                      float r_upper,
                                      float r_lower)
{
    if ((r_upper < ADC_DMA_MIN_DIVIDER_OHM) || (r_lower < ADC_DMA_MIN_DIVIDER_OHM))
    {
        return 0.0f;
    }

    return ((float)adc_code * vref_v / 4095.0f) * ((r_upper + r_lower) / r_lower);
}

/**
 * @brief 将 NTC 分压点 ADC 码值粗略映射为摄氏温度。
 * @param adc_code 原始 ADC 码值。
 * @param vref_v 当前参考电压，单位 V。
 * @return 温度，单位 degC。
 *
 * @note 这里用线性近似只为突出“从 coherent snapshot 到物理量”的链路，
 *       真正产品中应换成查表或 Steinhart-Hart 方程。
 */
static float AdcDma_CodeToTempDegC(uint16_t adc_code, float vref_v)
{
    const float v_adc = ((float)adc_code * vref_v) / 4095.0f;
    const float temp_deg_c = 112.0f - 23.0f * v_adc;

    return AdcDma_ClampF(temp_deg_c, ADC_DMA_MIN_TEMP_DEGC, ADC_DMA_MAX_TEMP_DEGC);
}

static volatile uint16_t *AdcDma_GetBankBase(const AdcDmaCacheContext_t *ctx, uint8_t bank)
{
    if ((ctx == NULL) || (ctx->dma_buffer == NULL) || (bank > 1U))
    {
        return NULL;
    }

    return &ctx->dma_buffer[(uint32_t)bank * ADC_DMA_HALFWORDS_PER_HALF];
}

/**
 * @brief 把一个已经可见的 half-buffer 聚合成同一批次的物理快照。
 * @param ctx DMA + cache 上下文。
 * @param bank 0 表示前半区，1 表示后半区。
 * @param sequence_id 该 half-buffer 的发布序号。
 * @param out [out] 聚合后的物理快照。
 * @retval true  快照构建成功。
 * @retval false 参数非法。
 *
 * @note 每个 half-buffer 的数据大小满足：
 *       B_half = N_channel * N_frame_half * sizeof(uint16_t)
 *
 *       只要 bank 对应区间已经完成 DMA 写入并执行过 invalidate，
 *       CPU 在这里读到的就是同一批次的稳定快照，而不是撕裂中的环形区。
 */
static bool AdcDma_BuildSnapshotFromBank(const AdcDmaCacheContext_t *ctx,
                                         uint8_t bank,
                                         uint32_t sequence_id,
                                         AdcDmaSnapshot_t *out)
{
    volatile uint16_t *base;
    uint32_t frame;
    uint32_t sum_ia = 0U;
    uint32_t sum_ib = 0U;
    uint32_t sum_vbus = 0U;
    uint32_t sum_ntc = 0U;

    if ((ctx == NULL) || (out == NULL))
    {
        return false;
    }

    base = AdcDma_GetBankBase(ctx, bank);
    if (base == NULL)
    {
        return false;
    }

    for (frame = 0U; frame < ADC_DMA_FRAMES_PER_HALF; ++frame)
    {
        const uint32_t idx = frame * ADC_DMA_CHANNEL_COUNT;

        /* 假设扫描顺序固定为：
         * [0] Ia, [1] Ib, [2] Vbus, [3] NTC
         */
        sum_ia += base[idx + 0U];
        sum_ib += base[idx + 1U];
        sum_vbus += base[idx + 2U];
        sum_ntc += base[idx + 3U];
    }

    out->ia_mean_a = AdcDma_CodeToCurrentA((uint16_t)(sum_ia / ADC_DMA_FRAMES_PER_HALF),
                                           ctx->vref_v,
                                           ctx->shunt_ohm,
                                           ctx->shunt_gain,
                                           ctx->current_offset_code);

    out->ib_mean_a = AdcDma_CodeToCurrentA((uint16_t)(sum_ib / ADC_DMA_FRAMES_PER_HALF),
                                           ctx->vref_v,
                                           ctx->shunt_ohm,
                                           ctx->shunt_gain,
                                           ctx->current_offset_code);

    out->vbus_mean_v = AdcDma_CodeToBusVoltageV((uint16_t)(sum_vbus / ADC_DMA_FRAMES_PER_HALF),
                                                ctx->vref_v,
                                                ctx->vbus_r_upper_ohm,
                                                ctx->vbus_r_lower_ohm);

    out->ntc_mean_deg_c = AdcDma_CodeToTempDegC((uint16_t)(sum_ntc / ADC_DMA_FRAMES_PER_HALF),
                                                ctx->vref_v);

    out->sequence_id = sequence_id;
    out->overwritten_frame_count = ctx->overwritten_frame_count;
    out->skipped_stale_count = ctx->skipped_stale_count;
    out->valid = true;
    return true;
}

/**
 * @brief 在 HT/TC 边界发布一个 half-buffer，使其对 CPU “既写完、又可见”。
 * @param ctx DMA + cache 上下文。
 * @param bank 0 表示前半区，1 表示后半区。
 *
 * @note 发布顺序必须满足：
 *       1. DMA 已经结束写该 half-buffer（由 HT/TC 事件保证）
 *       2. 失效对应 cache line
 *       3. 执行 DMB，禁止后续 ready 标志越过前面的 invalidate
 *       4. 再更新 sequence 与 ready_mask
 *
 *       若同一 bank 在被消费前又被 DMA 绕回写满，说明旧快照已丢失，
 *       overwritten_frame_count 必须递增，而不是假装系统一直跟得上。
 */
static void AdcDma_PublishBank(AdcDmaCacheContext_t *ctx, uint8_t bank)
{
    volatile uint16_t *base;
    const uint8_t bank_bit = (uint8_t)(1U << bank);
    const uint32_t byte_len = ADC_DMA_HALFWORDS_PER_HALF * sizeof(uint16_t);
    uint32_t primask;

    if ((ctx == NULL) || (bank > 1U))
    {
        return;
    }

    base = AdcDma_GetBankBase(ctx, bank);
    if (base == NULL)
    {
        return;
    }

    AdcDma_InvalidateByAddr((const void *)base, byte_len);
    __DMB();

    primask = AdcDma_EnterCritical();

    if ((ctx->ready_mask & bank_bit) != 0U)
    {
        ctx->overwritten_frame_count++;
    }

    ctx->produced_sequence++;
    ctx->bank_sequence[bank] = ctx->produced_sequence;
    ctx->ready_mask = (uint8_t)(ctx->ready_mask | bank_bit);
    ctx->cache_maint_count++;

    AdcDma_ExitCritical(primask);
}

/**
 * @brief 初始化 ADC DMA D-Cache 一致性上下文。
 * @param ctx [out] 上下文对象。
 * @param hadc 目标 ADC 句柄。
 */
void AdcDmaCache_Init(AdcDmaCacheContext_t *ctx, ADC_HandleTypeDef *hadc)
{
    if ((ctx == NULL) || (hadc == NULL))
    {
        return;
    }

    memset(ctx, 0, sizeof(*ctx));

    ctx->hadc = hadc;
    ctx->dma_buffer = g_adc1_dma_buffer;
    ctx->vref_v = 3.3f;
    ctx->shunt_ohm = 0.005f;
    ctx->shunt_gain = 20.0f;
    ctx->current_offset_code = 2048U;
    ctx->vbus_r_upper_ohm = 100000.0f;
    ctx->vbus_r_lower_ohm = 4700.0f;
}

/**
 * @brief 启动 ADC 循环 DMA，并在启动前清理整块缓冲区的一致性状态。
 * @param ctx DMA + cache 上下文。
 * @retval true  启动成功。
 * @retval false 启动失败。
 *
 * @note 启动前先 memset 再 CleanInvalidate 的原因，是把 CPU 可能留下的 dirty line 清空。
 *       对于 M7 平台，这一步是“DMA 可见性卫生”的基础动作，不应省略。
 */
bool AdcDmaCache_Start(AdcDmaCacheContext_t *ctx)
{
    if ((ctx == NULL) || (ctx->hadc == NULL) || (ctx->dma_buffer == NULL))
    {
        return false;
    }

    memset((void *)ctx->dma_buffer, 0, sizeof(g_adc1_dma_buffer));
    AdcDma_CleanInvalidateByAddr((void *)ctx->dma_buffer, sizeof(g_adc1_dma_buffer));

    ctx->ready_mask = 0U;
    ctx->produced_sequence = 0U;
    ctx->overwritten_frame_count = 0U;
    ctx->skipped_stale_count = 0U;
    ctx->cache_maint_count = 0U;
    ctx->bank_sequence[0] = 0U;
    ctx->bank_sequence[1] = 0U;

    if (HAL_ADC_Start_DMA(ctx->hadc, (uint32_t *)ctx->dma_buffer, ADC_DMA_TOTAL_HALFWORDS) != HAL_OK)
    {
        return false;
    }

    return true;
}

/**
 * @brief 获取当前最新的一份 coherent snapshot。
 * @param ctx DMA + cache 上下文。
 * @param out [out] 输出快照。
 * @retval true  成功取到至少一份已提交快照。
 * @retval false 当前没有可消费快照。
 *
 * @note 若两个 bank 同时 ready，说明消费者落后于生产者。
 *       这里采取“丢旧保新”策略：
 *       1. 挑 sequence_id 更大的 bank 作为最新快照
 *       2. 把另一个 stale bank 计入 skipped_stale_count
 *
 *       这样做的工程含义是：优先保证控制环看到更接近当前的物理状态，
 *       而不是执意把已经过期的快照补读回来。
 */
bool AdcDmaCache_TryAcquireLatest(AdcDmaCacheContext_t *ctx, AdcDmaSnapshot_t *out)
{
    uint32_t primask;
    uint8_t ready_mask;
    uint8_t selected_bank;
    uint32_t selected_seq;
    uint8_t stale_bank = 0xFFU;

    if ((ctx == NULL) || (out == NULL))
    {
        return false;
    }

    primask = AdcDma_EnterCritical();
    ready_mask = ctx->ready_mask;

    if ((ready_mask & 0x03U) == 0U)
    {
        AdcDma_ExitCritical(primask);
        return false;
    }

    if ((ready_mask & 0x03U) == 0x03U)
    {
        if (ctx->bank_sequence[1] >= ctx->bank_sequence[0])
        {
            selected_bank = 1U;
            stale_bank = 0U;
        }
        else
        {
            selected_bank = 0U;
            stale_bank = 1U;
        }

        ctx->ready_mask = (uint8_t)(ctx->ready_mask & ~(1U << stale_bank));
        ctx->skipped_stale_count++;
    }
    else
    {
        selected_bank = ((ready_mask & 0x01U) != 0U) ? 0U : 1U;
    }

    selected_seq = ctx->bank_sequence[selected_bank];
    ctx->ready_mask = (uint8_t)(ctx->ready_mask & ~(1U << selected_bank));

    AdcDma_ExitCritical(primask);
    __DMB();

    return AdcDma_BuildSnapshotFromBank(ctx, selected_bank, selected_seq, out);
}

void HAL_ADC_ConvHalfCpltCallback(ADC_HandleTypeDef *hadc)
{
    if (hadc == g_adc1_dma_ctx.hadc)
    {
        AdcDma_PublishBank(&g_adc1_dma_ctx, 0U);
    }
}

void HAL_ADC_ConvCpltCallback(ADC_HandleTypeDef *hadc)
{
    if (hadc == g_adc1_dma_ctx.hadc)
    {
        AdcDma_PublishBank(&g_adc1_dma_ctx, 1U);
    }
}

/**
 * @brief 示例：在 10 kHz 控制任务里取最新可见快照。
 * @param ia_a [out] A 相平均电流。
 * @param ib_a [out] B 相平均电流。
 * @param vbus_v [out] 母线电压。
 * @retval true  本周期拿到新快照。
 * @retval false 本周期没有新快照。
 *
 * @note 如果控制任务周期为 Tctrl，而 half-buffer 提交周期为 Thalf，则
 *       数据年龄上界可粗略写为：
 *       age_max <= Thalf + Tctrl + Tcache_maint
 *
 *       这条预算告诉你：仅仅“平均值稳定”还不够，快照年龄也必须留在闭环允许范围内。
 */
bool App_ControlLoopFetchLatest(float *ia_a, float *ib_a, float *vbus_v)
{
    AdcDmaSnapshot_t snapshot;

    if ((ia_a == NULL) || (ib_a == NULL) || (vbus_v == NULL))
    {
        return false;
    }

    if (!AdcDmaCache_TryAcquireLatest(&g_adc1_dma_ctx, &snapshot))
    {
        return false;
    }

    if (!snapshot.valid)
    {
        return false;
    }

    *ia_a = snapshot.ia_mean_a;
    *ib_a = snapshot.ib_mean_a;
    *vbus_v = snapshot.vbus_mean_v;

    /* 如果 overwritten_frame_count 或 skipped_stale_count 持续增长，
     * 说明系统虽然“没有读到旧 cache line”，却已经在节拍上跟丢了。
     * 这时应优先优化控制任务耗时、减小日志、放大 half-buffer，
     * 或重新评估 ADC 触发频率，而不是继续怀疑缓存 API 是否失效。
     */
    return true;
}

void App_AdcDmaPipelineInit(void)
{
    AdcDmaCache_Init(&g_adc1_dma_ctx, &hadc1);
    (void)AdcDmaCache_Start(&g_adc1_dma_ctx);
}
```

这段实现真正想强调的，不是“`SCB_InvalidateDCache_by_Addr()` 该怎么背”，而是三条更硬的系统结论：

- **DMA 缓冲区的正确性先取决于放哪，再取决于怎么读**。如果它落在 `DTCM` 或与普通变量共享 cache line，再漂亮的回调逻辑也只是把错误包装得更整齐。
- **`HT/TC` 是时间完成边界，`Invalidate + DMB` 是可见性完成边界**。前者回答“外设写完了吗”，后者回答“CPU 真能看见了吗”；只有两者都成立，快照才有资格进入控制律。
- **缓存一致性修好以后，系统仍可能因为消费速度不够而丢帧**。这时该看的不是 ADC 码值，而是 `overwritten_frame_count`、`skipped_stale_count` 与控制任务预算。因为真正的闭环从来不只要求“读到数据”，还要求“在来得及的时间里读到正确那一份数据”。
