---
title: "技能档案：STM32 ADC 采样时间、源阻抗与通道串扰误差预算"
slug: "skill-stm32-adc-sampling-time-source-impedance-and-channel-crosstalk-budget"
date: 2026-05-29T16:27:59+08:00
draft: false
description: "从采样保持电容充放电、源阻抗、通道切换残留到定时触发与 DMA 帧布局，系统拆解多通道 ADC 为什么常败在误差预算，而不是分辨率位数。"
tags: ["STM32", "ADC", "DMA", "采样时间", "源阻抗", "串扰", "定时触发"]
categories: ["技能档案", "嵌入式系统"]
image: ""
---

## 技能概述

STM32 的 ADC + DMA 常被描述成一条“模拟量自动搬进内存”的流水线，但真正决定这条链路是否可信的，往往不是 `12-bit`、不是 `HAL_ADC_Start_DMA()`，而是采样保持电容有没有在规定时间内充到位、上一个通道留下的电荷有没有污染下一个高阻节点、定时触发有没有把采样点钉在正确的时相上。无论是母线电压采样、相电流观测、NTC 温度监测还是电位器命令输入，这个主题解决的核心痛点都不是“如何拿到 ADC 数值”，而是如何把模拟前端、采样时序、DMA 帧布局和物理量还原组织成一份可计算、可验证、可调试的误差预算。

## 核心底层概念解析

- **采样保持电容** 不是抽象模块，而是一颗必须被真实充放电的小电容：ADC 在采样窗口里通过模拟开关把输入节点接到 **S/H 电容** 上，若源阻抗高、采样窗短，电容还没来得及接近目标电压，量化就已经开始。进入 DMA 的不是“真实电压”，而是“在截止时刻尚未充满的电压”。
- **源阻抗** 关心的是戴维宁等效，而不是“电阻看起来有多大”**：分压网络、NTC 桥、运放输出、RC 抗混叠滤波都会共同决定 ADC 引脚看到的等效输出阻抗。采样误差满足  
  `V_err / V_step = exp(-t_sample / ((R_source + R_on) * C_sh))`，  
  工程上真正该填进预算表的，是 `R_source`，不是随手挑一只电阻值。
- **采样时间** 不是“越短越快越高级”**：STM32 的 `3 cycles`、`15 cycles`、`56 cycles`、`480 cycles` 不是性能等级，而是模拟前端允许的充电时间。给低阻电流采样用长采样窗，可能只是白白牺牲吞吐；给高阻 NTC 仍用短采样窗，则会系统性低估或高估电压。
- **通道串扰** 很多时候不是 PCB 串音，而是前一通道遗留在电容上的电荷**：ADC 从 `3.0 V` 的母线分压切到 `0.4 V` 的高阻 NTC 节点时，S/H 电容上的旧电荷会通过高阻节点缓慢泄放。若还沿用同样的短采样窗，第二个通道看到的偏差可能远大于 1 LSB。
- **通道排序** 本质上是模拟资源调度，不只是 CubeMX 里的 Rank 编号**：低阻、快变、关键控制量通常应优先保证时相；高阻、慢变通道则适合排在后面，甚至直接复制一个“预充电 Rank + 有效 Rank”，丢弃第一次、保留第二次，以时间换确定性。
- **定时触发** 决定的是采样相位，而不是启动方式**：连续转换模式虽然省事，但采样瞬间会漂在软件启动延迟、中断阻塞和 ADC 自身空转之上。对电机电流、开关电源纹波或同步采样场景，只有 **Timer TRGO** 才能把采样点稳定钉在 PWM 中点、静默窗或固定控制时基上。
- **DMA 帧布局** 不是一维数组，而是“时间 × 物理 Rank”的折叠存储**：一旦为了高阻通道加入重复采样，DMA Buffer 里的元素就不再等于“逻辑通道数”。此时 `index = frame * physical_rank_count + rank` 才是正确语义；若软件还按“通道数固定”解读数据，后续滤波与物理量还原都会错位。
- **分辨率位数通常不是主误差项**：很多系统里，真正的首要误差来自 `Vref` 漂移、采样窗不足、分压电阻误差、运放失调、地弹噪声和时序抖动。工程上先做模拟链路与采样链路预算，再讨论数字滤波，顺序不能反。
- **高阻慢变量不等于可以随便采**：温度、电池包均衡电压、光敏电阻这类量变化慢，但常伴随高阻抗与强噪声耦合。它们对带宽不敏感，却对采样窗、前级 RC、通道切换残留和平均窗口更敏感。
- **控制系统消费的是时相正确的观测，而不是平均上差不多的数字**：如果相电流采样点已经漂出 PWM 中点，那么哪怕 DMA 搬运零丢包、均值看起来也平滑，电流环消费到的仍旧是错误时刻的电流。
- **技术哲学上，ADC + DMA 不是“少占 CPU”，而是把模拟世界压缩进数字系统前，先把时域契约和误差来源说清楚**：只要采样链路的前半段不可信，后面的缓存、滤波、控制和日志都只是在高效率地传播一个已经被扭曲过的事实。

## 代码能力展现

下面给出一个基于 STM32 HAL 的多通道 ADC 前端示例。场景假设为：`TIM8 TRGO` 以固定频率触发 `ADC1`，扫描顺序包含相电流、母线电压和 NTC 温度三个逻辑量；其中 NTC 节点源阻抗较高，因此额外插入一个“预充电 Rank”，第一次采样只用来让 S/H 电容靠近 NTC 电压，第二次采样才作为有效值写入逻辑结果。代码重点不是“怎么把 ADC 跑起来”，而是如何把 **源阻抗 -> 采样周期 -> 物理 Rank -> DMA 帧解析 -> 物理量还原** 这一整条误差链显式表达出来。

```c
#include "main.h"

#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#define ADC_FRONTEND_ADC_CLK_HZ                 30000000.0f
#define ADC_FRONTEND_VREF_MV_DEFAULT            3300U
#define ADC_FRONTEND_FULL_SCALE_COUNTS          4095U

#define ADC_FRONTEND_SAMPLE_CAP_F               8.0e-12f
#define ADC_FRONTEND_PIN_PARASITIC_F            4.0e-12f
#define ADC_FRONTEND_SWITCH_RES_OHM             1000.0f
#define ADC_FRONTEND_SETTLING_GUARD             1.20f

#define ADC_FRONTEND_FRAMES_PER_HALF            32U
#define ADC_FRONTEND_HALF_COUNT                 2U
#define ADC_FRONTEND_MAX_PHYSICAL_RANKS         4U
#define ADC_FRONTEND_DMA_FRAME_COUNT            (ADC_FRONTEND_FRAMES_PER_HALF * ADC_FRONTEND_HALF_COUNT)
#define ADC_FRONTEND_DMA_BUFFER_LENGTH          (ADC_FRONTEND_DMA_FRAME_COUNT * ADC_FRONTEND_MAX_PHYSICAL_RANKS)

#define ADC_FRONTEND_BUS_DIV_UPPER_OHM          33000.0f
#define ADC_FRONTEND_BUS_DIV_LOWER_OHM          10000.0f

#define ADC_FRONTEND_PHASE_BIAS_MV              1650.0f
#define ADC_FRONTEND_SHUNT_MILLIOHM             5.0f
#define ADC_FRONTEND_CURRENT_GAIN               20.0f

#define ADC_FRONTEND_NTC_PULLUP_OHM             10000.0f
#define ADC_FRONTEND_NTC_R0_OHM                 10000.0f
#define ADC_FRONTEND_NTC_BETA                   3435.0f
#define ADC_FRONTEND_NTC_T0_K                   298.15f

typedef enum
{
    ADC_LOGICAL_PHASE_CURRENT = 0,
    ADC_LOGICAL_BUS_VOLTAGE,
    ADC_LOGICAL_NTC_TEMPERATURE,
    ADC_LOGICAL_COUNT
} AdcLogicalChannel_t;

typedef struct
{
    uint32_t sample_time_macro;
    float sample_cycles;
} AdcSampleOption_t;

typedef struct
{
    AdcLogicalChannel_t logical_channel;
    uint32_t adc_channel;
    float source_impedance_ohm;
    float max_residual_ratio;
    bool duplicate_and_discard_first;
} AdcLogicalDescriptor_t;

typedef struct
{
    uint32_t adc_channel;
    uint32_t sample_time_macro;
    float actual_sample_cycles;
    uint8_t logical_channel;
    bool discard_sample;
} AdcPhysicalRank_t;

typedef struct
{
    uint8_t physical_rank_count;
    AdcPhysicalRank_t ranks[ADC_FRONTEND_MAX_PHYSICAL_RANKS];
} AdcScanPlan_t;

typedef struct
{
    uint16_t raw_mean[ADC_LOGICAL_COUNT];
    uint32_t bus_mv;
    int32_t phase_current_ma;
    int32_t ntc_centi_deg_c;
    uint32_t sequence;
} AdcSnapshot_t;

typedef struct
{
    ADC_HandleTypeDef *hadc;
    TIM_HandleTypeDef *htim_trigger;
    uint32_t vref_mv;
    AdcScanPlan_t plan;
    volatile uint16_t dma_buffer[ADC_FRONTEND_DMA_BUFFER_LENGTH];
    volatile AdcSnapshot_t latest;
} AdcFrontEnd_t;

static const AdcSampleOption_t k_adc_sample_options[] =
{
    {ADC_SAMPLETIME_3CYCLES,   3.0f},
    {ADC_SAMPLETIME_15CYCLES, 15.0f},
    {ADC_SAMPLETIME_28CYCLES, 28.0f},
    {ADC_SAMPLETIME_56CYCLES, 56.0f},
    {ADC_SAMPLETIME_84CYCLES, 84.0f},
    {ADC_SAMPLETIME_112CYCLES, 112.0f},
    {ADC_SAMPLETIME_144CYCLES, 144.0f},
    {ADC_SAMPLETIME_480CYCLES, 480.0f}
};

static const AdcLogicalDescriptor_t k_adc_logical_channels[ADC_LOGICAL_COUNT] =
{
    /*
     * 这里填的是 ADC 引脚看到的戴维宁等效输出阻抗，而不是电路图里“最大的那只电阻”。
     * - 相电流运放输出通常是低阻节点；
     * - 母线分压看到的是 Rupper || Rlower；
     * - NTC 分压在室温附近往往是几千到几万欧，且会随温度变化。
     */
    {ADC_LOGICAL_PHASE_CURRENT,  ADC_CHANNEL_1,  50.0f,                                 1.0f / 4096.0f, false},
    {ADC_LOGICAL_BUS_VOLTAGE,    ADC_CHANNEL_2, (ADC_FRONTEND_BUS_DIV_UPPER_OHM * ADC_FRONTEND_BUS_DIV_LOWER_OHM) /
                                                   (ADC_FRONTEND_BUS_DIV_UPPER_OHM + ADC_FRONTEND_BUS_DIV_LOWER_OHM),
                                                                                         1.0f / 4096.0f, false},
    {ADC_LOGICAL_NTC_TEMPERATURE, ADC_CHANNEL_3, 47000.0f,                               1.0f / 8192.0f, true}
};

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

/**
 * @brief 根据源阻抗和残余误差上限估算所需采样周期数。
 * @param adc_clk_hz ADC 内核时钟，单位 Hz。
 * @param source_impedance_ohm ADC 引脚看到的戴维宁等效输出阻抗，单位 Ohm。
 * @param residual_ratio 允许的归一化残余误差 `eps = |Verr| / |Vstep|`。
 * @return 满足约束所需的最小 Sample Time cycles。
 *
 * @note 采样保持电容充电模型近似为：
 *       Vcap(t) = Vin + (Vprev - Vin) * exp(-t / tau)
 *       tau     = (Rsource + Ron) * (Csh + Cparasitic)
 *
 *       若希望 `|Verr| / |Vstep| <= eps`，则有：
 *       t_sample >= -tau * ln(eps)
 *       cycles   >= t_sample * f_adc
 *
 *       这里再乘一个 guard 系数，用来覆盖温漂、寄生参数与布局不确定性。
 */
static float AdcCalcRequiredSampleCycles(float adc_clk_hz,
                                         float source_impedance_ohm,
                                         float residual_ratio)
{
    const float bounded_adc_clk_hz = ClampF(adc_clk_hz, 1000000.0f, 80000000.0f);
    const float bounded_r_source = ClampF(source_impedance_ohm, 1.0f, 1000000.0f);
    const float bounded_eps = ClampF(residual_ratio, 1.0e-6f, 0.25f);
    const float effective_cap_f = ADC_FRONTEND_SAMPLE_CAP_F + ADC_FRONTEND_PIN_PARASITIC_F;
    const float tau_s = (bounded_r_source + ADC_FRONTEND_SWITCH_RES_OHM) * effective_cap_f;
    const float required_sample_time_s = (-tau_s * logf(bounded_eps)) * ADC_FRONTEND_SETTLING_GUARD;

    return required_sample_time_s * bounded_adc_clk_hz;
}

static uint32_t AdcPickSampleTime(float required_cycles, float *out_actual_cycles)
{
    size_t i;

    for (i = 0U; i < (sizeof(k_adc_sample_options) / sizeof(k_adc_sample_options[0])); ++i)
    {
        if (required_cycles <= k_adc_sample_options[i].sample_cycles)
        {
            if (out_actual_cycles != NULL)
            {
                *out_actual_cycles = k_adc_sample_options[i].sample_cycles;
            }

            return k_adc_sample_options[i].sample_time_macro;
        }
    }

    if (out_actual_cycles != NULL)
    {
        *out_actual_cycles = k_adc_sample_options[(sizeof(k_adc_sample_options) / sizeof(k_adc_sample_options[0])) - 1U].sample_cycles;
    }

    return k_adc_sample_options[(sizeof(k_adc_sample_options) / sizeof(k_adc_sample_options[0])) - 1U].sample_time_macro;
}

static bool AdcAppendPhysicalRank(AdcScanPlan_t *plan,
                                  uint32_t adc_channel,
                                  uint32_t sample_time_macro,
                                  float actual_sample_cycles,
                                  AdcLogicalChannel_t logical_channel,
                                  bool discard_sample)
{
    AdcPhysicalRank_t *rank;

    if ((plan == NULL) || (plan->physical_rank_count >= ADC_FRONTEND_MAX_PHYSICAL_RANKS))
    {
        return false;
    }

    rank = &plan->ranks[plan->physical_rank_count];
    rank->adc_channel = adc_channel;
    rank->sample_time_macro = sample_time_macro;
    rank->actual_sample_cycles = actual_sample_cycles;
    rank->logical_channel = (uint8_t)logical_channel;
    rank->discard_sample = discard_sample;
    plan->physical_rank_count++;

    return true;
}

/**
 * @brief 生成物理扫描计划，并为高阻节点插入“预充电 Rank”。
 * @param plan 输出扫描计划。
 * @retval true 生成成功。
 * @retval false 物理 Rank 空间不足。
 *
 * @note 对 `duplicate_and_discard_first = true` 的通道：
 *       - 第一拍仅用于把 S/H 电容从前一通道残余电压拉向当前节点电压；
 *       - 第二拍才作为有效观测值参与 DMA 后处理。
 *
 *       这是一种典型的“用一次额外采样换取确定性”的工程折中，
 *       尤其适用于高阻 NTC、分压检测与 RC 滤波后的慢变量节点。
 */
static bool AdcBuildScanPlan(AdcScanPlan_t *plan)
{
    size_t i;

    if (plan == NULL)
    {
        return false;
    }

    memset(plan, 0, sizeof(*plan));

    for (i = 0U; i < ADC_LOGICAL_COUNT; ++i)
    {
        const AdcLogicalDescriptor_t *desc = &k_adc_logical_channels[i];
        float actual_cycles = 0.0f;
        const float required_cycles =
            AdcCalcRequiredSampleCycles(ADC_FRONTEND_ADC_CLK_HZ,
                                        desc->source_impedance_ohm,
                                        desc->max_residual_ratio);
        const uint32_t sample_time =
            AdcPickSampleTime(required_cycles, &actual_cycles);

        if (desc->duplicate_and_discard_first)
        {
            if (!AdcAppendPhysicalRank(plan,
                                       desc->adc_channel,
                                       sample_time,
                                       actual_cycles,
                                       desc->logical_channel,
                                       true))
            {
                return false;
            }
        }

        if (!AdcAppendPhysicalRank(plan,
                                   desc->adc_channel,
                                   sample_time,
                                   actual_cycles,
                                   desc->logical_channel,
                                   false))
        {
            return false;
        }
    }

    return true;
}

static uint32_t AdcPhysicalIndex(uint32_t frame_index,
                                 uint32_t physical_rank_index,
                                 uint32_t physical_rank_count)
{
    /*
     * DMA Buffer 的真实布局是“时间帧 × 物理 Rank”：
     *
     * index = frame_index * physical_rank_count + physical_rank_index
     *
     * 一旦为了高阻节点插入重复采样，physical_rank_count 往往大于逻辑通道数，
     * 所以后处理必须按物理 Rank 解码，再映射回逻辑通道。
     */
    return (frame_index * physical_rank_count) + physical_rank_index;
}

static uint32_t AdcRawToMv(uint16_t raw, uint32_t vref_mv)
{
    const uint32_t bounded_raw = ClampU32((uint32_t)raw, 0U, ADC_FRONTEND_FULL_SCALE_COUNTS);
    const uint32_t bounded_vref_mv = ClampU32(vref_mv, 2500U, 3600U);

    return (bounded_raw * bounded_vref_mv + (ADC_FRONTEND_FULL_SCALE_COUNTS / 2U)) /
           ADC_FRONTEND_FULL_SCALE_COUNTS;
}

static uint32_t AdcConvertBusMv(uint16_t raw, uint32_t vref_mv)
{
    const uint32_t vadc_mv = AdcRawToMv(raw, vref_mv);
    const float bus_mv = ((float)vadc_mv *
                         (ADC_FRONTEND_BUS_DIV_UPPER_OHM + ADC_FRONTEND_BUS_DIV_LOWER_OHM)) /
                         ADC_FRONTEND_BUS_DIV_LOWER_OHM;

    return ClampU32((uint32_t)lroundf(bus_mv), 0U, 60000U);
}

static int32_t AdcConvertPhaseCurrentMa(uint16_t raw, uint32_t vref_mv)
{
    const float vadc_mv = (float)AdcRawToMv(raw, vref_mv);
    const float delta_mv = vadc_mv - ADC_FRONTEND_PHASE_BIAS_MV;

    /*
     * 电流采样恢复公式：
     * Vsense = Vbias + I * Rshunt * Gain
     * I_ma   = (Vsense_mv - Vbias_mv) * 1000 / (Gain * Rshunt_mOhm)
     */
    const float current_ma = (delta_mv * 1000.0f) /
                             (ADC_FRONTEND_CURRENT_GAIN * ADC_FRONTEND_SHUNT_MILLIOHM);

    return ClampS32((int32_t)lroundf(current_ma), -40000, 40000);
}

static int32_t AdcConvertNtcCentiDegC(uint16_t raw, uint32_t vref_mv)
{
    const float vadc_mv = (float)ClampU32(AdcRawToMv(raw, vref_mv), 1U, vref_mv - 1U);
    const float r_ntc_ohm =
        (ADC_FRONTEND_NTC_PULLUP_OHM * vadc_mv) / ((float)vref_mv - vadc_mv);
    const float temperature_k =
        1.0f / ((1.0f / ADC_FRONTEND_NTC_T0_K) +
                (logf(r_ntc_ohm / ADC_FRONTEND_NTC_R0_OHM) / ADC_FRONTEND_NTC_BETA));
    const float temperature_c = temperature_k - 273.15f;

    /*
     * NTC 反算链路：
     * Vadc = Vref * Rntc / (Rpullup + Rntc)
     * Rntc = Rpullup * Vadc / (Vref - Vadc)
     * 1/T  = 1/T0 + (1/B) * ln(Rntc / R0)
     */
    return ClampS32((int32_t)lroundf(temperature_c * 100.0f), -4000, 15000);
}

static void AdcPublishSnapshot(AdcFrontEnd_t *front_end, const AdcSnapshot_t *snapshot)
{
    uint32_t begin_sequence;

    begin_sequence = front_end->latest.sequence + 1U;
    if ((begin_sequence & 0x01U) == 0U)
    {
        begin_sequence++;
    }

    /* 使用奇偶序号做轻量一致性保护：
     * - 奇数表示“正在写”
     * - 偶数表示“已完成，可安全读取”
     */
    front_end->latest.sequence = begin_sequence;
    front_end->latest.raw_mean[ADC_LOGICAL_PHASE_CURRENT] = snapshot->raw_mean[ADC_LOGICAL_PHASE_CURRENT];
    front_end->latest.raw_mean[ADC_LOGICAL_BUS_VOLTAGE] = snapshot->raw_mean[ADC_LOGICAL_BUS_VOLTAGE];
    front_end->latest.raw_mean[ADC_LOGICAL_NTC_TEMPERATURE] = snapshot->raw_mean[ADC_LOGICAL_NTC_TEMPERATURE];
    front_end->latest.bus_mv = snapshot->bus_mv;
    front_end->latest.phase_current_ma = snapshot->phase_current_ma;
    front_end->latest.ntc_centi_deg_c = snapshot->ntc_centi_deg_c;
    front_end->latest.sequence = begin_sequence + 1U;
}

static void AdcProcessFrames(AdcFrontEnd_t *front_end, uint32_t first_frame_index, uint32_t frame_count)
{
    uint32_t sum[ADC_LOGICAL_COUNT] = {0U};
    uint32_t valid_count[ADC_LOGICAL_COUNT] = {0U};
    uint32_t frame_index;
    uint32_t rank_index;
    AdcSnapshot_t snapshot;

    memset(&snapshot, 0, sizeof(snapshot));

    for (frame_index = 0U; frame_index < frame_count; ++frame_index)
    {
        const uint32_t logical_frame = first_frame_index + frame_index;

        for (rank_index = 0U; rank_index < front_end->plan.physical_rank_count; ++rank_index)
        {
            const AdcPhysicalRank_t *rank = &front_end->plan.ranks[rank_index];
            const uint32_t raw_index =
                AdcPhysicalIndex(logical_frame, rank_index, front_end->plan.physical_rank_count);
            const uint16_t raw = front_end->dma_buffer[raw_index];

            if (rank->discard_sample)
            {
                /* 第一拍只做“电容预充电”，不把它当成有效物理观测值。 */
                continue;
            }

            sum[rank->logical_channel] += raw;
            valid_count[rank->logical_channel]++;
        }
    }

    for (rank_index = 0U; rank_index < ADC_LOGICAL_COUNT; ++rank_index)
    {
        if (valid_count[rank_index] == 0U)
        {
            continue;
        }

        snapshot.raw_mean[rank_index] =
            (uint16_t)((sum[rank_index] + (valid_count[rank_index] / 2U)) / valid_count[rank_index]);
    }

    snapshot.bus_mv = AdcConvertBusMv(snapshot.raw_mean[ADC_LOGICAL_BUS_VOLTAGE], front_end->vref_mv);
    snapshot.phase_current_ma = AdcConvertPhaseCurrentMa(snapshot.raw_mean[ADC_LOGICAL_PHASE_CURRENT],
                                                         front_end->vref_mv);
    snapshot.ntc_centi_deg_c = AdcConvertNtcCentiDegC(snapshot.raw_mean[ADC_LOGICAL_NTC_TEMPERATURE],
                                                      front_end->vref_mv);

    AdcPublishSnapshot(front_end, &snapshot);
}

static HAL_StatusTypeDef AdcConfigureRanks(ADC_HandleTypeDef *hadc, const AdcScanPlan_t *plan)
{
    uint32_t i;

    for (i = 0U; i < plan->physical_rank_count; ++i)
    {
        ADC_ChannelConfTypeDef config;

        memset(&config, 0, sizeof(config));
        config.Channel = plan->ranks[i].adc_channel;
        config.Rank = i + 1U;
        config.SamplingTime = plan->ranks[i].sample_time_macro;

        if (HAL_ADC_ConfigChannel(hadc, &config) != HAL_OK)
        {
            return HAL_ERROR;
        }
    }

    return HAL_OK;
}

/**
 * @brief 初始化基于定时触发与 DMA 的 ADC 前端。
 * @param front_end 前端对象，需绑定 `ADC_HandleTypeDef` 与触发定时器句柄。
 * @retval HAL_OK 初始化成功。
 * @retval HAL_ERROR 扫描计划生成失败、Rank 配置失败或 DMA / 定时器启动失败。
 *
 * @note 默认前提：
 *       1. ADC 工作在 External Trigger 模式，而非 Continuous 模式；
 *       2. DMA 为 Circular 模式，数据宽度为 HalfWord；
 *       3. 触发源已在 CubeMX 中配置为 `TIMx TRGO Update`；
 *       4. 本函数只负责把“物理 Rank 计划”与 DMA 解释规则绑定起来。
 */
HAL_StatusTypeDef AdcFrontEnd_Init(AdcFrontEnd_t *front_end)
{
    if ((front_end == NULL) || (front_end->hadc == NULL) || (front_end->htim_trigger == NULL))
    {
        return HAL_ERROR;
    }

    memset((void *)&front_end->plan, 0, sizeof(front_end->plan));
    memset((void *)front_end->dma_buffer, 0, sizeof(front_end->dma_buffer));
    memset((void *)&front_end->latest, 0, sizeof(front_end->latest));
    front_end->vref_mv = ClampU32(front_end->vref_mv, 2500U, 3600U);

    if (!AdcBuildScanPlan(&front_end->plan))
    {
        return HAL_ERROR;
    }

    if (AdcConfigureRanks(front_end->hadc, &front_end->plan) != HAL_OK)
    {
        return HAL_ERROR;
    }

    /*
     * 启动顺序遵循“先接收端、后触发源”的原则：
     * 先让 ADC + DMA 拿到合法落点，再释放定时触发，
     * 避免第一个采样沿到来时接收侧尚未准备好。
     */
    if (HAL_ADC_Start_DMA(front_end->hadc,
                          (uint32_t *)front_end->dma_buffer,
                          front_end->plan.physical_rank_count * ADC_FRONTEND_DMA_FRAME_COUNT) != HAL_OK)
    {
        return HAL_ERROR;
    }

    if (HAL_TIM_Base_Start(front_end->htim_trigger) != HAL_OK)
    {
        (void)HAL_ADC_Stop_DMA(front_end->hadc);
        return HAL_ERROR;
    }

    return HAL_OK;
}

/**
 * @brief 获取最近一次已经稳定发布的 ADC 快照。
 * @param front_end 前端对象。
 * @param out_snapshot 输出快照。
 * @retval true 读取到一致快照。
 * @retval false 参数非法或当前尚无有效数据。
 */
bool AdcFrontEnd_GetLatest(const AdcFrontEnd_t *front_end, AdcSnapshot_t *out_snapshot)
{
    uint32_t seq_before;
    uint32_t seq_after;

    if ((front_end == NULL) || (out_snapshot == NULL))
    {
        return false;
    }

    do
    {
        seq_before = front_end->latest.sequence;
        if ((seq_before == 0U) || ((seq_before & 0x01U) != 0U))
        {
            continue;
        }

        out_snapshot->raw_mean[ADC_LOGICAL_PHASE_CURRENT] = front_end->latest.raw_mean[ADC_LOGICAL_PHASE_CURRENT];
        out_snapshot->raw_mean[ADC_LOGICAL_BUS_VOLTAGE] = front_end->latest.raw_mean[ADC_LOGICAL_BUS_VOLTAGE];
        out_snapshot->raw_mean[ADC_LOGICAL_NTC_TEMPERATURE] = front_end->latest.raw_mean[ADC_LOGICAL_NTC_TEMPERATURE];
        out_snapshot->bus_mv = front_end->latest.bus_mv;
        out_snapshot->phase_current_ma = front_end->latest.phase_current_ma;
        out_snapshot->ntc_centi_deg_c = front_end->latest.ntc_centi_deg_c;
        out_snapshot->sequence = front_end->latest.sequence;

        seq_after = front_end->latest.sequence;
    } while ((seq_before != seq_after) || ((seq_after & 0x01U) != 0U));

    return true;
}

void HAL_ADC_ConvHalfCpltCallback(ADC_HandleTypeDef *hadc)
{
    extern AdcFrontEnd_t g_adc_frontend;

    if (hadc == g_adc_frontend.hadc)
    {
        /* 前半缓冲区稳定，对应 frame [0, 31]。 */
        AdcProcessFrames(&g_adc_frontend, 0U, ADC_FRONTEND_FRAMES_PER_HALF);
    }
}

void HAL_ADC_ConvCpltCallback(ADC_HandleTypeDef *hadc)
{
    extern AdcFrontEnd_t g_adc_frontend;

    if (hadc == g_adc_frontend.hadc)
    {
        /* 后半缓冲区稳定，对应 frame [32, 63]。 */
        AdcProcessFrames(&g_adc_frontend,
                         ADC_FRONTEND_FRAMES_PER_HALF,
                         ADC_FRONTEND_FRAMES_PER_HALF);
    }
}

void HAL_ADC_ErrorCallback(ADC_HandleTypeDef *hadc)
{
    extern AdcFrontEnd_t g_adc_frontend;

    if (hadc == g_adc_frontend.hadc)
    {
        /*
         * OVR 不是“偶发 HAL 小毛病”，而是在提醒你：
         * 采样速率、DMA 吞吐和软件处理窗口之间的契约已经被破坏。
         */
        __HAL_ADC_CLEAR_FLAG(hadc, ADC_FLAG_OVR);
    }
}

extern ADC_HandleTypeDef hadc1;
extern TIM_HandleTypeDef htim8;

AdcFrontEnd_t g_adc_frontend =
{
    .hadc = &hadc1,
    .htim_trigger = &htim8,
    .vref_mv = ADC_FRONTEND_VREF_MV_DEFAULT
};

HAL_StatusTypeDef App_AnalogFrontEndInit(void)
{
    return AdcFrontEnd_Init(&g_adc_frontend);
}

bool App_ReadAdcSnapshot(AdcSnapshot_t *snapshot)
{
    return AdcFrontEnd_GetLatest(&g_adc_frontend, snapshot);
}
```

这段代码真正想建立的是一条“从模拟节点到控制器输入”的解释链。它不把 `SamplingTime` 当成拍脑袋的枚举值，而是从 `R_source`、`C_sh` 和可接受残余误差推回去；也不把 DMA 数组当成天然等于逻辑通道的缓冲区，而是显式承认物理 Rank 与逻辑通道可以不同。只要这条链路里的每个边界都被说清楚，后面的平均、滤波、校准和闭环控制才是在处理真实世界，而不是在给一个早已失真的原始样本做精致包装。
