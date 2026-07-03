---
title: "技能档案：STM32 ADC 注入组抢占、DMA 常规组背压与过流保护时延预算"
slug: "skill-stm32-adc-injected-preemption-regular-dma-backpressure-and-overcurrent-latency-budget"
date: 2026-07-03T09:45:54+08:00
draft: false
description: "从 PWM 中点采样、注入组抢占、JDR 与 DMA 双路径到模拟看门狗和软件关断时延，系统拆解一颗 STM32 ADC 如何在控制采样、后台监测与保护动作之间安排优先级。"
tags: ["STM32", "ADC", "DMA", "注入组", "过流保护", "实时系统", "嵌入式"]
categories: ["技能档案"]
image: ""
---

## 技能概述

在电机控制、数字电源和功率电子系统里，一颗 `STM32 ADC` 往往同时背着三份工作：**常规组** 通过 `DMA` 持续搬运母线电压、温度、电位器等慢变量；**注入组** 在 `PWM` 中点抢占采样相电流，给电流环和观测器喂快照；**保护路径** 则必须在过流出现后尽快拉闸，防止铜线、MOSFET 和母线电容替软件承担迟到的代价。这个主题真正解决的，不是 HAL 函数先调哪个，而是看清一颗 `SAR ADC` 如何在有限转换时间内扮演一个分层调度器：谁能被抢占，谁必须排队，谁又必须在热容和电流上升率耗尽前完成动作。

## 核心底层概念解析

- **常规组与注入组不是两份“通道列表”，而是两种延迟等级**：常规组服务的是“吞吐量优先”的慢变量，允许排队、允许成帧、允许经 `DMA` 批量提交；注入组服务的是“相位优先”的快变量，通常跟着 `PWM` 触发点走，容忍通道数少，但不容忍采样时刻漂移。它们的差别首先是调度契约，其次才是寄存器名字。

- **一颗 ADC 的真实约束不是 API，而是转换时间**：单次转换近似满足  
  `t_conv = (t_sample + 12.5) / f_adc`。  
  这里的 `t_sample` 是采样保持窗口，`12.5 cycles` 是 SAR 逼近与数据对齐的典型固定开销。你能塞进多少常规通道、能在每个 `PWM` 周期插入几次注入采样、保护路径还能剩多少裕量，最终都要回到这条时间账本。

- **注入组的“抢占”本质上是把 ADC 变成一个两级优先队列**：当定时器把注入触发打进来时，硬件会暂停常规序列，先完成注入序列，再回到常规组继续扫。这个行为看似优雅，代价却很实在: 每一次注入都会从常规组手里拿走一段连续的转换时间，若后台通道请求速率逼近满载，DMA 缓冲区的年龄就会开始上升。

- **背压不是 DMA 溢出那一刻才出现，而是在利用率超过 1 之前就已经开始老化**：若定义  
  `rho_reg = f_reg_frame * N_reg * t_conv_reg`，  
  `rho_inj = f_inj * N_inj * t_conv_inj`，  
  `rho_cpu = f_reg_frame * t_commit`，  
  那么服务裕量就是  
  `margin = 1 - rho_reg - rho_inj - rho_cpu`。  
  只要 `margin` 趋近于 `0`，常规组样本虽然还在进 DMA，但“数据新鲜度”已经开始变坏，控制器读到的是越来越旧的慢变量。

- **DMA 只会为常规组封存“整页数据”，不会替注入组制造一致性**：常规组的 `half transfer / transfer complete` 天生是快照边界，因为一整半页 DMA Buffer 已经落稳；注入组的数据却直接住在 `JDRx`，它们没有自然的帧边界，只有触发序号和时间戳。若软件不自己维护 `sequence_id`，上层就很容易把“这次电流”和“上次母线电压”误拼成一份伪快照。

- **PWM 中点采样不是玄学，而是主动避开开关噪声和死区畸变**：半桥翻转之后，续流路径、反向恢复、电流重分布和采样电阻共模摆动都在剧烈变化。若在边沿附近采样，ADC 拿到的是一份夹杂了 `dV/dt` 注入、放大器恢复和死区畸变的电流。把注入组触发钉在中心对齐 `PWM` 的静默窗，本质上是在为采样保持电容争取一个更干净的世界。

- **电流到码值的映射是一条完整的模拟链，不是减一个偏置就结束**：典型单电阻或双电阻放大链满足  
  `V_adc = V_bias + I_phase * R_shunt * G_amp`，  
  因而  
  `I_phase = (V_adc - V_bias) / (R_shunt * G_amp)`。  
  这里的 `V_bias` 会漂、`R_shunt` 会热、`G_amp` 会饱和。过流阈值如果直接拿 ADC 码值硬比，而不把这条映射链明确写进预算，保护动作要么太迟，要么天天误报。

- **软件过流保护与硬件模拟看门狗不是同一级武器**：软件回调路径通常近似为  
  `t_trip_sw = t_conv_inj_seq + t_irq + t_gate_off`；  
  若启用 `Analog Watchdog`，可以缩成  
  `t_trip_awd = t_conv_one + t_cmp + t_irq + t_gate_off`。  
  但即便如此，真正的最坏情况还要再加上故障相对于采样点的相位差。对上升沿极陡的短路，片上 `AWD` 依然常常不如外部比较器快，这不是 HAL 优化不够，而是体系结构层级不同。

- **保护过快和保护过慢都可能是错的**：MOSFET 开关瞬间的尖峰、二极管反向恢复、采样放大器饱和回弹都可能制造窄脉冲假过流。若完全不做消隐，`AWD` 会在每次硬开通时都怀疑你短路；若消隐窗拉得太长，又会把真正的故障让过去。所谓“保护整定”，其实是在假警报率和热损伤时间常数之间做交易。

- **快慢两条采样路径必须在语义上对齐，而不是在数组下标上碰巧相邻**：电流环关心的是“第 `k` 次注入采样对应的电流”，热管理关心的是“最近一页常规组平均温度”，上层状态机则可能同时需要二者。如果软件只暴露一块不断被覆盖的全局变量，那不是共享数据，而是把时域关系揉碎后再强行拼接。

- **技术哲学上，注入组让 ADC 看起来像会抢占的处理器内核**：常规组是后台线程，注入组是高优先级中断，模拟看门狗是更硬一层的异常门闩。真正的工程问题从来不是“能不能采到”，而是**谁先得到时间、谁先占用带宽、谁又先有资格把功率级关掉**。把这层优先级秩序讲清楚，ADC 才不只是一个采样器，而是控制系统里的实时调度器。

## 代码能力展现

下面给出一段基于 **STM32 HAL** 风格的 ADC 调度模块。它刻意把一颗 ADC 拆成三条语义路径：

- 常规组 `DMA` 周期性搬运 `Vbus / NTC / Command` 这类慢变量，并只在半缓冲或满缓冲边界提交快照；
- 注入组在 `PWM` 触发下读取 `Ia / Ib`，给电流环提供相位锁定的高速样本；
- 模拟看门狗或注入回调一旦确认过流，就立即闩锁关断高级定时器输出。

代码重点不是 CubeMX 初始化细节，而是如何把 **转换时间预算、背压利用率、物理量映射、快照一致性与保护时延** 显式写进实现。

```c
#include "main.h"

#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#define ADC_ARB_REGULAR_CHANNELS            3U
#define ADC_ARB_INJECTED_CHANNELS           2U
#define ADC_ARB_REGULAR_SAMPLES_PER_BANK    16U
#define ADC_ARB_DMA_BANK_COUNT              2U
#define ADC_ARB_DMA_LENGTH                  (ADC_ARB_REGULAR_CHANNELS * ADC_ARB_REGULAR_SAMPLES_PER_BANK * ADC_ARB_DMA_BANK_COUNT)
#define ADC_ARB_ADC_FULL_SCALE              4095.0f
#define ADC_ARB_MIN_VREF_V                  1.0f
#define ADC_ARB_MIN_SHUNT_OHM               1.0e-4f
#define ADC_ARB_MIN_GAIN                    0.1f
#define ADC_ARB_MIN_ADC_CLK_HZ              1000000.0f
#define ADC_ARB_MIN_SAMPLE_CYCLES           1.5f
#define ADC_ARB_NTC_PULLUP_OHM              10000.0f
#define ADC_ARB_NTC_R0_OHM                  10000.0f
#define ADC_ARB_NTC_BETA                    3435.0f
#define ADC_ARB_NTC_T0_K                    298.15f

typedef struct
{
    float regular_conv_us;
    float injected_conv_us;
    float rho_regular;
    float rho_injected;
    float rho_cpu_commit;
    float service_margin;
    float sw_trip_latency_us;
    float awd_trip_latency_us;
} AdcArbiterTimingBudget_t;

typedef struct
{
    float vbus_v;
    float ntc_deg_c;
    float command_v;
    uint32_t frame_id;
    uint8_t valid;
} AdcRegularSnapshot_t;

typedef struct
{
    float ia_a;
    float ib_a;
    float i_abs_max_a;
    uint32_t sequence_id;
    uint8_t overcurrent;
    uint8_t valid;
} AdcInjectedSnapshot_t;

typedef struct
{
    ADC_HandleTypeDef *hadc;
    TIM_HandleTypeDef *htim_pwm;
    GPIO_TypeDef *gate_enable_port;
    uint16_t gate_enable_pin;
    float adc_clk_hz;
    float regular_sample_cycles;
    float injected_sample_cycles;
    float regular_frame_rate_hz;
    float injected_rate_hz;
    float cpu_commit_us;
    float irq_entry_us;
    float gate_disable_us;
    float awd_compare_us;
    float vref_v;
    float shunt_res_ohm;
    float amp_gain;
    float current_bias_v;
    float current_trip_a;
    float vbus_divider_ratio;
} AdcArbiterConfig_t;

typedef struct
{
    AdcArbiterConfig_t cfg;
    AdcArbiterTimingBudget_t budget;
    AdcRegularSnapshot_t regular_snapshot;
    AdcInjectedSnapshot_t injected_snapshot;
    uint32_t fault_count;
    uint8_t trip_latched;
    uint8_t initialized;
} AdcArbiter_t;

static AdcArbiter_t g_adc_arbiter;
static uint16_t g_adc_regular_dma[ADC_ARB_DMA_LENGTH];

static float AdcArbiter_ClampFloat(float value, float min_value, float max_value)
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

static float AdcArbiter_CyclesToUs(float adc_clk_hz, float sample_cycles)
{
    /* SAR ADC 单次转换时间：
     * t_conv = (t_sample + 12.5 cycles) / f_adc
     * 其中 12.5 cycles 代表逐次逼近与数据对齐的固定开销。
     */
    return ((sample_cycles + 12.5f) / adc_clk_hz) * 1.0e6f;
}

static float AdcArbiter_CodeToVoltage(uint16_t code, float vref_v)
{
    return ((float)code / ADC_ARB_ADC_FULL_SCALE) * vref_v;
}

static float AdcArbiter_CodeToCurrentA(const AdcArbiterConfig_t *cfg, uint16_t code)
{
    const float vadc = AdcArbiter_CodeToVoltage(code, cfg->vref_v);

    /* 电流链路线性映射：
     * Vadc = Vbias + Iphase * Rshunt * Gamp
     * Iphase = (Vadc - Vbias) / (Rshunt * Gamp)
     */
    return (vadc - cfg->current_bias_v) / (cfg->shunt_res_ohm * cfg->amp_gain);
}

static float AdcArbiter_CodeToVbus(const AdcArbiterConfig_t *cfg, uint16_t code)
{
    return AdcArbiter_CodeToVoltage(code, cfg->vref_v) * cfg->vbus_divider_ratio;
}

static float AdcArbiter_CodeToNtcDegC(uint16_t code, float vref_v)
{
    const float v_ntc = AdcArbiter_CodeToVoltage(code, vref_v);
    float r_ntc = 0.0f;
    float inv_t = 0.0f;

    if (v_ntc <= 0.02f || v_ntc >= (vref_v - 0.02f))
    {
        return -273.15f;
    }

    r_ntc = (v_ntc * ADC_ARB_NTC_PULLUP_OHM) / (vref_v - v_ntc);
    inv_t = (1.0f / ADC_ARB_NTC_T0_K) +
            (logf(r_ntc / ADC_ARB_NTC_R0_OHM) / ADC_ARB_NTC_BETA);

    return (1.0f / inv_t) - 273.15f;
}

static void AdcArbiter_RecalculateBudget(AdcArbiter_t *arbiter)
{
    const float t_reg_us = AdcArbiter_CyclesToUs(arbiter->cfg.adc_clk_hz,
                                                 arbiter->cfg.regular_sample_cycles);
    const float t_inj_us = AdcArbiter_CyclesToUs(arbiter->cfg.adc_clk_hz,
                                                 arbiter->cfg.injected_sample_cycles);

    arbiter->budget.regular_conv_us = t_reg_us;
    arbiter->budget.injected_conv_us = t_inj_us;

    /* 背压占用率：
     * rho_reg = f_reg_frame * N_reg * t_conv_reg
     * rho_inj = f_inj * N_inj * t_conv_inj
     * rho_cpu = f_reg_frame * t_commit
     *
     * 若三者和接近 1，说明常规组虽未立刻溢出，但提交年龄已经开始恶化。
     */
    arbiter->budget.rho_regular =
        arbiter->cfg.regular_frame_rate_hz *
        (float)ADC_ARB_REGULAR_CHANNELS *
        t_reg_us * 1.0e-6f;

    arbiter->budget.rho_injected =
        arbiter->cfg.injected_rate_hz *
        (float)ADC_ARB_INJECTED_CHANNELS *
        t_inj_us * 1.0e-6f;

    arbiter->budget.rho_cpu_commit =
        arbiter->cfg.regular_frame_rate_hz *
        arbiter->cfg.cpu_commit_us * 1.0e-6f;

    arbiter->budget.service_margin =
        1.0f - arbiter->budget.rho_regular -
        arbiter->budget.rho_injected -
        arbiter->budget.rho_cpu_commit;

    /* 这里只计算“触发已经发生以后”的数字时延。
     * 若要估最坏故障清除时间，还需要叠加故障发生点到下一次采样点之间
     * 的相位差；在中心对齐 PWM 里，这部分甚至可能接近半个开关周期。
     */
    arbiter->budget.sw_trip_latency_us =
        ((float)ADC_ARB_INJECTED_CHANNELS * t_inj_us) +
        arbiter->cfg.irq_entry_us +
        arbiter->cfg.gate_disable_us;

    arbiter->budget.awd_trip_latency_us =
        t_inj_us +
        arbiter->cfg.awd_compare_us +
        arbiter->cfg.irq_entry_us +
        arbiter->cfg.gate_disable_us;
}

static uint8_t AdcArbiter_ConfigValid(const AdcArbiterConfig_t *cfg)
{
    if (cfg == NULL || cfg->hadc == NULL || cfg->htim_pwm == NULL)
    {
        return 0U;
    }

    if (cfg->adc_clk_hz < ADC_ARB_MIN_ADC_CLK_HZ ||
        cfg->regular_sample_cycles < ADC_ARB_MIN_SAMPLE_CYCLES ||
        cfg->injected_sample_cycles < ADC_ARB_MIN_SAMPLE_CYCLES)
    {
        return 0U;
    }

    if (cfg->vref_v < ADC_ARB_MIN_VREF_V ||
        cfg->shunt_res_ohm < ADC_ARB_MIN_SHUNT_OHM ||
        cfg->amp_gain < ADC_ARB_MIN_GAIN)
    {
        return 0U;
    }

    if (cfg->regular_frame_rate_hz <= 0.0f || cfg->injected_rate_hz <= 0.0f)
    {
        return 0U;
    }

    return 1U;
}

static void AdcArbiter_LatchTrip(AdcArbiter_t *arbiter)
{
    if (arbiter->trip_latched != 0U)
    {
        return;
    }

    arbiter->trip_latched = 1U;
    arbiter->fault_count++;

    /* 保护动作必须比“等待任务层再决定”更硬。
     * 这里直接关高级定时器主输出，同时撤掉外部门极使能。
     */
    __HAL_TIM_MOE_DISABLE_UNCONDITIONALLY(arbiter->cfg.htim_pwm);

    if (arbiter->cfg.gate_enable_port != NULL)
    {
        HAL_GPIO_WritePin(arbiter->cfg.gate_enable_port,
                          arbiter->cfg.gate_enable_pin,
                          GPIO_PIN_RESET);
    }
}

static void AdcArbiter_ProcessRegularBank(AdcArbiter_t *arbiter, uint32_t bank_index)
{
    const uint32_t base = bank_index * ADC_ARB_REGULAR_CHANNELS * ADC_ARB_REGULAR_SAMPLES_PER_BANK;
    uint32_t sample = 0U;
    float vbus_sum = 0.0f;
    float ntc_sum = 0.0f;
    float cmd_sum = 0.0f;

    /* 只处理已经被 DMA 完整写满的半页，绝不读正在被写入的另一半。
     * 这样 regular_snapshot 才有资格代表一份完整的慢变量快照。
     */
    for (sample = 0U; sample < ADC_ARB_REGULAR_SAMPLES_PER_BANK; ++sample)
    {
        const uint32_t offset = base + sample * ADC_ARB_REGULAR_CHANNELS;

        vbus_sum += AdcArbiter_CodeToVbus(&arbiter->cfg, g_adc_regular_dma[offset + 0U]);
        ntc_sum += AdcArbiter_CodeToNtcDegC(g_adc_regular_dma[offset + 1U], arbiter->cfg.vref_v);
        cmd_sum += AdcArbiter_CodeToVoltage(g_adc_regular_dma[offset + 2U], arbiter->cfg.vref_v);
    }

    arbiter->regular_snapshot.vbus_v =
        vbus_sum / (float)ADC_ARB_REGULAR_SAMPLES_PER_BANK;
    arbiter->regular_snapshot.ntc_deg_c =
        ntc_sum / (float)ADC_ARB_REGULAR_SAMPLES_PER_BANK;
    arbiter->regular_snapshot.command_v =
        cmd_sum / (float)ADC_ARB_REGULAR_SAMPLES_PER_BANK;
    arbiter->regular_snapshot.frame_id++;
    arbiter->regular_snapshot.valid = 1U;
}

/**
 * @brief 初始化 ADC 调度模块并计算时间预算。
 * @param arbiter ADC 调度器对象。
 * @param config  调度配置。
 * @retval 1 初始化成功，0 初始化失败。
 *
 * @note 这一步不只是保存句柄，更重要的是把“ADC 是否忙得过来”显式算出来。
 *       当 service_margin <= 0 时，说明系统已经没有后台余量；
 *       此时就算 DMA 还没报错，常规组样本年龄也会持续变差。
 */
uint8_t AdcArbiter_Init(AdcArbiter_t *arbiter, const AdcArbiterConfig_t *config)
{
    if (arbiter == NULL || AdcArbiter_ConfigValid(config) == 0U)
    {
        return 0U;
    }

    memset(arbiter, 0, sizeof(*arbiter));
    arbiter->cfg = *config;
    arbiter->budget.service_margin = -1.0f;
    AdcArbiter_RecalculateBudget(arbiter);
    arbiter->initialized = 1U;

    return 1U;
}

/**
 * @brief 启动常规组 DMA 与注入组中断采样。
 * @param arbiter ADC 调度器对象。
 * @retval 1 启动成功，0 启动失败。
 *
 * @note 常规组负责吞吐，注入组负责相位。两条路径都启动后，
 *       HAL 回调会把它们分别封装成 regular_snapshot 与 injected_snapshot。
 */
uint8_t AdcArbiter_Start(AdcArbiter_t *arbiter)
{
    if (arbiter == NULL || arbiter->initialized == 0U)
    {
        return 0U;
    }

    memset(g_adc_regular_dma, 0, sizeof(g_adc_regular_dma));
    memset(&arbiter->regular_snapshot, 0, sizeof(arbiter->regular_snapshot));
    memset(&arbiter->injected_snapshot, 0, sizeof(arbiter->injected_snapshot));
    arbiter->trip_latched = 0U;

    if (HAL_ADC_Start_DMA(arbiter->cfg.hadc,
                          (uint32_t *)g_adc_regular_dma,
                          ADC_ARB_DMA_LENGTH) != HAL_OK)
    {
        return 0U;
    }

    if (HAL_ADCEx_InjectedStart_IT(arbiter->cfg.hadc) != HAL_OK)
    {
        (void)HAL_ADC_Stop_DMA(arbiter->cfg.hadc);
        return 0U;
    }

    return 1U;
}

/**
 * @brief 原子性读出最新快慢路径快照。
 * @param arbiter     ADC 调度器对象。
 * @param regular_out 常规组快照输出。
 * @param fast_out    注入组快照输出。
 *
 * @note 快慢路径更新来自不同中断上下文。这里用临界区复制，
 *       保证上层不会读到“新电流 + 旧母线”这种撕裂组合。
 */
void AdcArbiter_GetSnapshots(const AdcArbiter_t *arbiter,
                             AdcRegularSnapshot_t *regular_out,
                             AdcInjectedSnapshot_t *fast_out)
{
    const uint32_t primask = __get_PRIMASK();

    __disable_irq();

    if (regular_out != NULL)
    {
        *regular_out = arbiter->regular_snapshot;
    }

    if (fast_out != NULL)
    {
        *fast_out = arbiter->injected_snapshot;
    }

    if (primask == 0U)
    {
        __enable_irq();
    }
}

void HAL_ADC_ConvHalfCpltCallback(ADC_HandleTypeDef *hadc)
{
    if (hadc == g_adc_arbiter.cfg.hadc)
    {
        AdcArbiter_ProcessRegularBank(&g_adc_arbiter, 0U);
    }
}

void HAL_ADC_ConvCpltCallback(ADC_HandleTypeDef *hadc)
{
    if (hadc == g_adc_arbiter.cfg.hadc)
    {
        AdcArbiter_ProcessRegularBank(&g_adc_arbiter, 1U);
    }
}

void HAL_ADCEx_InjectedConvCpltCallback(ADC_HandleTypeDef *hadc)
{
    float ia_a = 0.0f;
    float ib_a = 0.0f;
    float i_abs_max = 0.0f;

    if (hadc != g_adc_arbiter.cfg.hadc)
    {
        return;
    }

    ia_a = AdcArbiter_CodeToCurrentA(&g_adc_arbiter.cfg, (uint16_t)HAL_ADCEx_InjectedGetValue(hadc, ADC_INJECTED_RANK_1));
    ib_a = AdcArbiter_CodeToCurrentA(&g_adc_arbiter.cfg, (uint16_t)HAL_ADCEx_InjectedGetValue(hadc, ADC_INJECTED_RANK_2));
    i_abs_max = fmaxf(fabsf(ia_a), fabsf(ib_a));

    g_adc_arbiter.injected_snapshot.ia_a = ia_a;
    g_adc_arbiter.injected_snapshot.ib_a = ib_a;
    g_adc_arbiter.injected_snapshot.i_abs_max_a = i_abs_max;
    g_adc_arbiter.injected_snapshot.sequence_id++;
    g_adc_arbiter.injected_snapshot.valid = 1U;
    g_adc_arbiter.injected_snapshot.overcurrent = 0U;

    /* 软件保护适合作为第二道门：
     * 它比任务轮询快，但仍然晚于真正的硬件比较器或片上模拟看门狗。
     */
    if (i_abs_max > g_adc_arbiter.cfg.current_trip_a)
    {
        g_adc_arbiter.injected_snapshot.overcurrent = 1U;
        AdcArbiter_LatchTrip(&g_adc_arbiter);
    }
}

void HAL_ADC_LevelOutOfWindowCallback(ADC_HandleTypeDef *hadc)
{
    if (hadc != g_adc_arbiter.cfg.hadc)
    {
        return;
    }

    /* 模拟看门狗路径更接近硬件阈值比较，触发更快；
     * 但依然需要消隐与阈值整定，否则开关尖峰会造成误闩锁。
     */
    g_adc_arbiter.injected_snapshot.overcurrent = 1U;
    AdcArbiter_LatchTrip(&g_adc_arbiter);
}

static ADC_HandleTypeDef hadc1;
static TIM_HandleTypeDef htim1;

void Application_StartAdcArbiter(void)
{
    AdcArbiterConfig_t config;

    memset(&config, 0, sizeof(config));
    config.hadc = &hadc1;
    config.htim_pwm = &htim1;
    config.gate_enable_port = GATE_EN_GPIO_Port;
    config.gate_enable_pin = GATE_EN_Pin;
    config.adc_clk_hz = 36000000.0f;
    config.regular_sample_cycles = 47.5f;
    config.injected_sample_cycles = 15.0f;
    config.regular_frame_rate_hz = 10000.0f;
    config.injected_rate_hz = 20000.0f;
    config.cpu_commit_us = 1.6f;
    config.irq_entry_us = 0.35f;
    config.gate_disable_us = 0.20f;
    config.awd_compare_us = 0.08f;
    config.vref_v = 3.3f;
    config.shunt_res_ohm = 0.005f;
    config.amp_gain = 20.0f;
    config.current_bias_v = 1.65f;
    config.current_trip_a = 18.0f;
    config.vbus_divider_ratio = 11.0f;

    if (AdcArbiter_Init(&g_adc_arbiter, &config) == 0U)
    {
        Error_Handler();
    }

    if (g_adc_arbiter.budget.service_margin <= 0.10f)
    {
        /* 余量太小意味着常规组会很快老化。
         * 与其带着隐性背压进控制环，不如在启动期就拒绝配置。
         */
        Error_Handler();
    }

    if (AdcArbiter_Start(&g_adc_arbiter) == 0U)
    {
        Error_Handler();
    }
}
```

这段代码刻意保留了几个关键工程判断：

- `service_margin` 不是调试信息，而是是否允许系统带着这组采样配置启动的硬约束；
- 常规组快照只在 `half/full transfer` 边界提交，避免上层读到被 DMA 改写中的半页；
- 注入组和常规组分开编号，避免把不同时间层级的数据误当成同一帧；
- 过流保护同时保留 `InjectedConvCplt` 软件门槛与 `Analog Watchdog` 硬件门槛，前者更容易携带上下文，后者更接近时延底线。

如果把这些约束都删掉，只剩下一句 `HAL_ADC_Start_DMA()` 和一段读 `JDR1/JDR2` 的代码，系统确实也“能跑”；但那样跑起来的，只是一台不知道自己正在透支时间预算的控制器。
