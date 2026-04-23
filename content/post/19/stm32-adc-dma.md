---
title: "技能档案：STM32 DMA 与多通道 ADC 的内存搬运哲学"
slug: "skill-stm32-dma-multi-channel-adc-memory-transport"
date: 2026-04-23T09:03:50+08:00
draft: false
description: "从采样保持电容、通道排序、定时触发到环形 DMA 半缓冲处理，系统拆解 STM32 多通道 ADC 的模拟量搬运链路。"
tags: ["STM32", "ADC", "DMA", "嵌入式", "数据采集"]
categories: ["技能档案"]
image: ""
---

## 技能概述

STM32 DMA 与多通道 ADC 的价值，不在于“少写几个搬运数组的循环”，而在于让模拟世界的连续量，以确定的时间切片、稳定的内存布局和可控的 CPU 介入频率进入数字系统。它广泛用于电池管理、电机电流观测、环境监测、功率控制与传感器前端采集，解决的核心痛点是：多个通道共享同一颗 ADC 内核，采样瞬间受开关矩阵与采样保持电容约束，数据落地又受 DMA、总线仲裁、缓存一致性与控制周期约束；如果只关心“ADC 数值是多少”，往往会忽略真正决定系统稳定性的时序边界、源阻抗、搬运窗口和误差传播。

## 核心底层概念解析

- **ADC 不是理想电压表，而是带采样保持电容的瞬时取样器**：ADC 前端会先通过模拟开关把输入信号接到一颗很小的 **Sample-and-Hold 电容** 上，再在这段短暂保持时间里完成量化。若传感器源阻抗太高、采样时间太短，电容还没充到应有电压，转换结果就已经带着系统性偏差进入内存。很多人以为 DMA 能“无损搬运”一切，实际上输入在进入 DMA 之前就可能已经失真。
- **多通道扫描的本质是时间复用，而不是“同时读了多个量”**：当 ADC Regular Group 依次扫描 Rank1、Rank2、Rank3 时，三个通道并不是同一时刻采样，而是按序列顺序一个接一个完成。若外部触发频率为 `f_trig`，通道数为 `N`，那么每次触发只是完成一帧 `N` 路扫描；对电机相电流、快速振动或脉冲功率信号而言，这种通道间时间偏移本身就可能成为误差来源。
- **DMA 不是“免费搬运工”，而是总线上的另一个主设备**：DMA 每写一次半字到 SRAM，都在和 CPU、SPI、LCD 刷新、以太网甚至另一条 DMA 流争总线。吞吐量估算并不复杂：`BW = f_trig × N × bytes_per_sample`。如果采样触发、UART 打印、屏幕刷新同时发生，真正的风险不是 HAL API 调错，而是 AHB/APB 带宽被你自己挤爆。
- **内存布局本身就是采样语义的一部分**：对多通道扫描 + DMA 而言，缓冲区往往不是“按通道分块”，而是“按帧交错”，即 `index = frame_index × channel_count + channel_rank`。这意味着 `buffer[0]`、`buffer[1]`、`buffer[2]` 表示同一个触发时刻下的不同通道，而 `buffer[3]` 才是下一次触发的新一帧。理解这一点，才能正确做平均、滤波与时间对齐。
- **定时器触发决定了采样是否可信**：Continuous Mode 看起来最省事，但采样相位会跟着软件启动时刻、ADC 空转和中断抖动一起漂。若希望把采样点严格钉在 PWM 中点、电流谷值或固定控制周期上，真正可靠的方式是 **Timer TRGO + ADC External Trigger**。数字系统最怕“平均上差不多”，因为控制系统消费的是瞬时边界，不是心理安慰。
- **半传输与全传输回调是时域边界，不只是通知机制**：Circular DMA 的 Half Complete / Complete 回调，本质上是在告诉软件“这一半缓冲区已经稳定，不会再被硬件改写”。在这个边界内做块处理，CPU 看到的是静态窗口；若直接在主循环里随手读整个 DMA Buffer，看上去省了一层回调，实则是在和硬件并发读写同一片内存。
- **ADC 误差不只来自 12 位量化本身**：真实链路里还存在 **Vref 漂移、分压电阻误差、运放失调、电流采样电阻温漂、采样时钟抖动、模拟地弹噪声、别名效应**。因此“滤波一下就好了”通常只对随机噪声有效，对比例误差、偏置误差和相位误差几乎没有帮助。工程上必须先问误差从哪一层进入，再决定该在模拟域、采样域还是数字域修正。
- **DMA 的哲学不是替 CPU 跑得更快，而是让 CPU 别再做没有信息增量的事**：单样本搬运对控制器没有意义，稳定的统计窗口、时序确定的采样帧和映射到物理单位的结果才有意义。ADC 负责把模拟世界离散化，DMA 负责把离散结果排成队，CPU 应该只在“窗口已经闭合”的时刻介入，然后直接消费已经对齐过的物理量。

## 代码能力展现

下面给出一个基于 STM32 HAL 的多通道 ADC + DMA 采样管线示例。假设 `ADC1` 的常规序列固定为 `VBAT -> ISENSE -> CMD` 三个通道，`TIM6` 以 `10 kHz` 产生 `TRGO Update` 触发 ADC，每次半缓冲处理 `32` 帧，因此软件每 `3.2 ms` 获得一组新的窗口化结果。代码重点不在“怎么启动 DMA”，而在 **如何把交错存放的原始采样，还原成有物理含义、可限幅、可供控制器直接消费的观测量**。

```c
#include "main.h"
#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#define ADC_PIPELINE_CHANNEL_COUNT           3U
#define ADC_PIPELINE_FRAMES_PER_HALF         32U
#define ADC_PIPELINE_HALF_COUNT              2U
#define ADC_PIPELINE_FRAME_COUNT             (ADC_PIPELINE_FRAMES_PER_HALF * ADC_PIPELINE_HALF_COUNT)
#define ADC_PIPELINE_BUFFER_LENGTH           (ADC_PIPELINE_CHANNEL_COUNT * ADC_PIPELINE_FRAME_COUNT)

#define ADC_FULL_SCALE_COUNTS                4095U
#define ADC_VREF_MV_DEFAULT                  3300U

#define ADC_BATTERY_DIV_UPPER_OHM            33000U
#define ADC_BATTERY_DIV_LOWER_OHM            10000U

#define ADC_SHUNT_MILLIOHM                   5U
#define ADC_CURRENT_SENSE_GAIN               20U
#define ADC_CURRENT_BIAS_MV                  1650

#define ADC_COMMAND_CENTER_COUNTS            2048U
#define ADC_COMMAND_DEADBAND_COUNTS          40U

typedef enum
{
    ADC_SCAN_CH_VBAT = 0,
    ADC_SCAN_CH_CURRENT,
    ADC_SCAN_CH_COMMAND
} AdcScanChannel_t;

typedef struct
{
    uint16_t raw_mean[ADC_PIPELINE_CHANNEL_COUNT];
    uint32_t battery_mv;
    int32_t current_ma;
    int16_t command_permille;
    uint32_t sequence;
} AnalogSnapshot_t;

typedef struct
{
    ADC_HandleTypeDef *hadc;
    TIM_HandleTypeDef *htim_trigger;
    volatile uint16_t dma_buffer[ADC_PIPELINE_BUFFER_LENGTH];
    volatile AnalogSnapshot_t latest;
    uint32_t vref_mv;
} AnalogPipeline_t;

static uint32_t ClampU32(uint32_t value, uint32_t min_value, uint32_t max_value)
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

static int32_t ClampS32(int32_t value, int32_t min_value, int32_t max_value)
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

static uint32_t AbsS32(int32_t value)
{
    return (value < 0) ? (uint32_t)(-value) : (uint32_t)value;
}

static uint32_t Analog_GetBufferIndex(uint32_t frame_index, uint32_t channel_index)
{
    /* 多通道扫描 + DMA 的线性内存映射公式：
     *
     * index = frame_index * channel_count + channel_rank
     *
     * 例如通道顺序固定为 [VBAT, CURRENT, COMMAND] 时：
     * - frame 0 占用 buffer[0..2]
     * - frame 1 占用 buffer[3..5]
     * - frame k 占用 buffer[k * 3 .. k * 3 + 2]
     *
     * 这说明 DMA Buffer 的一维数组，实际上编码了“时间 × 通道”二维信息。
     */
    return (frame_index * ADC_PIPELINE_CHANNEL_COUNT) + channel_index;
}

static uint32_t Analog_RawToAdcMv(uint16_t raw, uint32_t vref_mv)
{
    uint32_t clamped_raw;

    clamped_raw = ClampU32((uint32_t)raw, 0U, ADC_FULL_SCALE_COUNTS);
    vref_mv = ClampU32(vref_mv, 2500U, 3600U);

    /* 12-bit ADC 线性量化映射：
     *
     * Vadc_mv = raw / 4095 * Vref_mv
     *
     * 使用四舍五入，减小低码值区域的整数截断误差。
     */
    return (clamped_raw * vref_mv + (ADC_FULL_SCALE_COUNTS / 2U)) / ADC_FULL_SCALE_COUNTS;
}

static uint32_t Analog_ConvertBatteryMv(uint16_t raw, uint32_t vref_mv)
{
    uint64_t vadc_mv;
    uint64_t vbat_mv;

    vadc_mv = Analog_RawToAdcMv(raw, vref_mv);

    /* 分压还原公式：
     *
     * Vbat = Vadc * (Rupper + Rlower) / Rlower
     *
     * 该公式默认 ADC 采样点位于下拉电阻两端。
     */
    vbat_mv = vadc_mv * (ADC_BATTERY_DIV_UPPER_OHM + ADC_BATTERY_DIV_LOWER_OHM);
    vbat_mv = (vbat_mv + (ADC_BATTERY_DIV_LOWER_OHM / 2U)) / ADC_BATTERY_DIV_LOWER_OHM;

    return ClampU32((uint32_t)vbat_mv, 0U, 60000U);
}

static int32_t Analog_ConvertCurrentMa(uint16_t raw, uint32_t vref_mv)
{
    int32_t vadc_mv;
    int32_t delta_mv;
    int32_t current_ma;

    vadc_mv = (int32_t)Analog_RawToAdcMv(raw, vref_mv);
    delta_mv = vadc_mv - ADC_CURRENT_BIAS_MV;

    /* 电流采样恢复公式：
     *
     * Vsense = Vbias + I * Rshunt * Gain
     * I_ma   = (Vsense_mv - Vbias_mv) * 1000 / (Gain * Rshunt_mOhm)
     *
     * 这里保留符号位，允许测得双向电流。
     */
    current_ma = (delta_mv * 1000) / ((int32_t)ADC_CURRENT_SENSE_GAIN * (int32_t)ADC_SHUNT_MILLIOHM);

    return ClampS32(current_ma, -30000, 30000);
}

static int16_t Analog_ConvertCommandPermille(uint16_t raw)
{
    int32_t signed_error;
    int32_t effective_error;
    int32_t usable_span;
    int32_t command_permille;

    raw = (uint16_t)ClampU32(raw, 0U, ADC_FULL_SCALE_COUNTS);
    signed_error = (int32_t)raw - (int32_t)ADC_COMMAND_CENTER_COUNTS;

    if (AbsS32(signed_error) <= ADC_COMMAND_DEADBAND_COUNTS)
    {
        return 0;
    }

    if (signed_error > 0)
    {
        effective_error = signed_error - (int32_t)ADC_COMMAND_DEADBAND_COUNTS;
        usable_span = (int32_t)ADC_FULL_SCALE_COUNTS
                    - (int32_t)ADC_COMMAND_CENTER_COUNTS
                    - (int32_t)ADC_COMMAND_DEADBAND_COUNTS;
    }
    else
    {
        effective_error = signed_error + (int32_t)ADC_COMMAND_DEADBAND_COUNTS;
        usable_span = (int32_t)ADC_COMMAND_CENTER_COUNTS
                    - (int32_t)ADC_COMMAND_DEADBAND_COUNTS;
    }

    if (usable_span <= 0)
    {
        return 0;
    }

    /* 摇杆原始码值 -> 控制量千分比的线性映射：
     *
     * command = effective_error / usable_span * 1000
     *
     * 先扣除中心死区，再把剩余有效行程等比展开到 [-1000, 1000]。
     */
    command_permille = (effective_error * 1000) / usable_span;

    return (int16_t)ClampS32(command_permille, -1000, 1000);
}

static void Analog_PublishSnapshot(AnalogPipeline_t *pipeline, const AnalogSnapshot_t *snapshot)
{
    uint32_t begin_sequence;

    begin_sequence = pipeline->latest.sequence + 1U;
    if ((begin_sequence & 0x01U) == 0U)
    {
        begin_sequence++;
    }

    /* 使用奇偶序号做简易的一致性标记：
     * - 奇数表示“正在写”
     * - 偶数表示“已写完，可安全读取”
     */
    pipeline->latest.sequence = begin_sequence;
    pipeline->latest.raw_mean[ADC_SCAN_CH_VBAT] = snapshot->raw_mean[ADC_SCAN_CH_VBAT];
    pipeline->latest.raw_mean[ADC_SCAN_CH_CURRENT] = snapshot->raw_mean[ADC_SCAN_CH_CURRENT];
    pipeline->latest.raw_mean[ADC_SCAN_CH_COMMAND] = snapshot->raw_mean[ADC_SCAN_CH_COMMAND];
    pipeline->latest.battery_mv = snapshot->battery_mv;
    pipeline->latest.current_ma = snapshot->current_ma;
    pipeline->latest.command_permille = snapshot->command_permille;
    pipeline->latest.sequence = begin_sequence + 1U;
}

static void Analog_ProcessHalfBuffer(AnalogPipeline_t *pipeline, uint32_t frame_offset)
{
    uint32_t sum[ADC_PIPELINE_CHANNEL_COUNT] = {0U};
    uint32_t frame;
    uint32_t channel;
    AnalogSnapshot_t snapshot;

    memset(&snapshot, 0, sizeof(snapshot));

    for (frame = 0U; frame < ADC_PIPELINE_FRAMES_PER_HALF; ++frame)
    {
        const uint32_t logical_frame = frame_offset + frame;

        for (channel = 0U; channel < ADC_PIPELINE_CHANNEL_COUNT; ++channel)
        {
            const uint32_t index = Analog_GetBufferIndex(logical_frame, channel);

            /* 这里按“帧”而不是按“通道”遍历，是为了明确表达 DMA Buffer 的真实布局。 */
            sum[channel] += pipeline->dma_buffer[index];
        }
    }

    for (channel = 0U; channel < ADC_PIPELINE_CHANNEL_COUNT; ++channel)
    {
        snapshot.raw_mean[channel] = (uint16_t)((sum[channel] + (ADC_PIPELINE_FRAMES_PER_HALF / 2U))
                                              / ADC_PIPELINE_FRAMES_PER_HALF);
    }

    snapshot.battery_mv = Analog_ConvertBatteryMv(snapshot.raw_mean[ADC_SCAN_CH_VBAT], pipeline->vref_mv);
    snapshot.current_ma = Analog_ConvertCurrentMa(snapshot.raw_mean[ADC_SCAN_CH_CURRENT], pipeline->vref_mv);
    snapshot.command_permille = Analog_ConvertCommandPermille(snapshot.raw_mean[ADC_SCAN_CH_COMMAND]);

    Analog_PublishSnapshot(pipeline, &snapshot);
}

/**
 * @brief 启动基于定时触发与环形 DMA 的多通道 ADC 采样管线。
 * @param pipeline 采样管线对象，内部需预先绑定 ADC 与触发定时器句柄。
 * @retval HAL_OK 启动成功。
 * @retval HAL_ERROR 参数非法，或 ADC / DMA / TIM 任一环节启动失败。
 *
 * @note 代码默认 CubeMX 已完成如下静态配置：
 *       1. ADC Regular Rank 顺序固定为 [VBAT, CURRENT, COMMAND]。
 *       2. 触发源为 TIM6 TRGO Update。
 *       3. DMA 为 Circular 模式，数据宽度为 HalfWord。
 *       4. 对高源阻抗通道，Sampling Time 已放宽到足以让采样保持电容充电完成。
 */
HAL_StatusTypeDef AnalogPipeline_Start(AnalogPipeline_t *pipeline)
{
    if ((pipeline == NULL) || (pipeline->hadc == NULL) || (pipeline->htim_trigger == NULL))
    {
        return HAL_ERROR;
    }

    memset((void *)pipeline->dma_buffer, 0, sizeof(pipeline->dma_buffer));
    memset((void *)&pipeline->latest, 0, sizeof(pipeline->latest));
    pipeline->vref_mv = ClampU32(pipeline->vref_mv, 2500U, 3600U);

#if defined(ADC_SINGLE_ENDED)
    if (HAL_ADCEx_Calibration_Start(pipeline->hadc, ADC_SINGLE_ENDED) != HAL_OK)
    {
        return HAL_ERROR;
    }
#endif

    /* 启动顺序遵循“先让接收端就绪，再释放触发源”的原则：
     * 1. 先启动 ADC + DMA，保证第一个外部触发到来时已有合法落点。
     * 2. 再启动定时器，让采样节拍开始驱动整个采集链路。
     */
    if (HAL_ADC_Start_DMA(pipeline->hadc,
                          (uint32_t *)pipeline->dma_buffer,
                          ADC_PIPELINE_BUFFER_LENGTH) != HAL_OK)
    {
        return HAL_ERROR;
    }

    if (HAL_TIM_Base_Start(pipeline->htim_trigger) != HAL_OK)
    {
        (void)HAL_ADC_Stop_DMA(pipeline->hadc);
        return HAL_ERROR;
    }

    return HAL_OK;
}

/**
 * @brief 获取最近一次已经稳定发布的模拟量快照。
 * @param pipeline 采样管线对象。
 * @param out_snapshot 输出快照缓存。
 * @retval true 成功读到一致的快照。
 * @retval false 参数非法或当前尚未产生有效数据。
 */
bool AnalogPipeline_GetLatest(const AnalogPipeline_t *pipeline, AnalogSnapshot_t *out_snapshot)
{
    uint32_t seq_before;
    uint32_t seq_after;

    if ((pipeline == NULL) || (out_snapshot == NULL))
    {
        return false;
    }

    do
    {
        seq_before = pipeline->latest.sequence;
        if ((seq_before == 0U) || ((seq_before & 0x01U) != 0U))
        {
            continue;
        }

        out_snapshot->raw_mean[ADC_SCAN_CH_VBAT] = pipeline->latest.raw_mean[ADC_SCAN_CH_VBAT];
        out_snapshot->raw_mean[ADC_SCAN_CH_CURRENT] = pipeline->latest.raw_mean[ADC_SCAN_CH_CURRENT];
        out_snapshot->raw_mean[ADC_SCAN_CH_COMMAND] = pipeline->latest.raw_mean[ADC_SCAN_CH_COMMAND];
        out_snapshot->battery_mv = pipeline->latest.battery_mv;
        out_snapshot->current_ma = pipeline->latest.current_ma;
        out_snapshot->command_permille = pipeline->latest.command_permille;
        out_snapshot->sequence = pipeline->latest.sequence;

        seq_after = pipeline->latest.sequence;
    } while ((seq_before != seq_after) || ((seq_after & 0x01U) != 0U));

    return true;
}

void HAL_ADC_ConvHalfCpltCallback(ADC_HandleTypeDef *hadc)
{
    extern AnalogPipeline_t g_analog_pipeline;

    if (hadc == g_analog_pipeline.hadc)
    {
        /* DMA 已经填满前半缓冲区，此时 frame [0, 31] 稳定可读。 */
        Analog_ProcessHalfBuffer(&g_analog_pipeline, 0U);
    }
}

void HAL_ADC_ConvCpltCallback(ADC_HandleTypeDef *hadc)
{
    extern AnalogPipeline_t g_analog_pipeline;

    if (hadc == g_analog_pipeline.hadc)
    {
        /* DMA 已经填满后半缓冲区，此时 frame [32, 63] 稳定可读。 */
        Analog_ProcessHalfBuffer(&g_analog_pipeline, ADC_PIPELINE_FRAMES_PER_HALF);
    }
}

void HAL_ADC_ErrorCallback(ADC_HandleTypeDef *hadc)
{
    extern AnalogPipeline_t g_analog_pipeline;

    if (hadc == g_analog_pipeline.hadc)
    {
        /* 若出现 OVR，说明“采样、搬运、处理”三者的速率平衡被打破了。
         * 错误的本质往往不是 HAL 层面，而是触发频率、DMA 带宽或软件处理窗口配置失衡。
         */
        __HAL_ADC_CLEAR_FLAG(hadc, ADC_FLAG_OVR);
    }
}

extern ADC_HandleTypeDef hadc1;
extern TIM_HandleTypeDef htim6;

AnalogPipeline_t g_analog_pipeline =
{
    .hadc = &hadc1,
    .htim_trigger = &htim6,
    .vref_mv = ADC_VREF_MV_DEFAULT
};

HAL_StatusTypeDef App_AnalogFrontEndInit(void)
{
    return AnalogPipeline_Start(&g_analog_pipeline);
}

bool App_ReadAnalogInputs(AnalogSnapshot_t *snapshot)
{
    return AnalogPipeline_GetLatest(&g_analog_pipeline, snapshot);
}
```

这段实现真正想解决的问题，不是“如何让 ADC 数据进数组”，而是如何在 **模拟采样时序、DMA 总线搬运、数字滤波窗口和物理量映射** 之间建立稳定契约。多通道 ADC 一旦接入真实系统，`raw` 值从来都不是终点；它只是模拟世界穿过采样保持、电阻网络、运放增益、总线仲裁和整数运算之后，暂时停靠在 SRAM 里的一个中间态。把这条链路的每个边界都交代清楚，CPU 才能消费到真正可信的数据。
