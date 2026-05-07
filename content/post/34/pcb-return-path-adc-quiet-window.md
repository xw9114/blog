---
title: "技能档案：PCB 高频布局的硬约束，从回流路径到 ADC 采样静默窗"
slug: "skill-pcb-return-path-and-adc-quiet-window"
date: 2026-05-07T09:59:38+08:00
draft: false
description: "从回流路径、开关节点 dV/dt、地弹噪声到 ADC 采样静默窗，系统拆解混合信号 PCB 为什么首先是一场寄生参数与时间窗预算。"
tags: ["STM32", "PCB", "ADC", "EMI", "混合信号"]
categories: ["技能档案"]
image: ""
---

## 技能概述

PCB 高频布局与混合信号干扰抑制，真正解决的不是“线怎么走才好看”，而是当电机 PWM、DCDC 开关、电流采样、ADC 参考与 MCU 数字翻转同时存在时，如何让错误的能量不要沿着错误的路径回流。很多板子原理图没错、固件也能跑，最后却死在地弹噪声、采样抖动、参考漂移和偶发误触发上。这个主题的核心痛点，是把电流环路、寄生参数、采样窗口和数字调度看成同一条物理链路，而不是把它们拆成“硬件问题”和“软件问题”各自甩锅。

## 核心底层概念解析

- **高频干扰首先是边沿问题，不只是频率问题**：很多工程师盯着 `20 kHz`、`100 kHz` 这样的开关频率，但真正把噪声打进整块板子的往往是纳秒级上升沿和下降沿。寄生电感上的电压尖峰满足 `V_L = L_parasitic * di/dt`，寄生电容中的位移电流满足 `I_C = C_parasitic * dv/dt`。只要 `di/dt` 和 `dv/dt` 足够陡，哪怕名义频率不高，板子仍然会像一个主动发射源。
- **回流电流走的是最小阻抗路径，不是最短路径，更不是你脑补的路径**：在低频下，电流也许还能大致按最小电阻回去；但在高频下，回流更倾向于紧贴信号正向路径下方的参考平面闭合，以最小化环路电感。若你在关键信号下方切断地平面、挖开缝隙或跨分割布线，回流就会被迫绕远路，环路面积瞬间放大，磁场辐射和串扰也一起抬头。
- **“模拟地”和“数字地”不是两个政治阵营，而是电流类型的管理问题**：很多板子喜欢机械地做“分地”，结果不是隔离了噪声，而是让回流跨缝、过桥、绕大圈。对绝大多数混合信号板，**连续完整的参考平面**比“名义上分开的地岛”更重要。真正应该隔离的是大电流开关回路与小信号测量回路，而不是用名字把铜皮分家。
- **开关节点铜皮不是越大越安全，它往往是最该被克制的区域**：半桥中点、Buck 的 SW 节点、本体二极管换流点，这些位置同时承受高 `dv/dt` 和高寄生耦合能力。节点面积越大，等效对周围的寄生电容越大，越容易把位移电流注入到地平面、采样线和参考网络里。这里的设计哲学不是“加粗就稳”，而是**只让必须承载开关电流的最小铜面积暴露出来**。
- **混合信号精度常常不是坏在 ADC 分辨率，而是坏在采样瞬间的参考与源阻抗**：ADC 采样保持电容在采样窗内要从输入源取电荷。如果前级源阻抗太大、RC 滤波太重或参考电压自身在抖，采样值就会偏离真实值。其一阶充电误差近似满足 `e_settle = exp(-T_sample / (R_source * C_sh))`，因此若希望误差小于 `epsilon`，必须满足 `T_sample >= -R_source * C_sh * ln(epsilon)`。这意味着“前面串个 10 k 电阻再加个 100 nF 滤波”未必是无脑安全方案。
- **参考电压不是背景板，它直接定义了 LSB 的物理尺度**：`N` 位 ADC 的理想量化步距是 `LSB = Vref / 2^N`。只要 `Vref` 自己被地弹噪声或供电纹波拖着跳，整个转换结果都会被同步缩放。工程里常见的“采样值跟着 PWM 相位飘”，很多不是信号真的在变，而是 `Vref+` 或模拟地基准在被开关电流推着晃。
- **分流电阻的测量回路必须使用 Kelvin 语义，而不是功率铜皮语义**：测量放大器需要看到的是分流电阻两端的真实压差，而不是功率回路在铜皮上的附加压降。若采样线直接从大电流铜皮外侧拉走，实际读到的就是 `V_shunt + I * R_copper + L_copper * di/dt`。在低阻电流采样里，这点额外误差足以把软件校准全部吞掉。
- **抑制噪声不只靠空间隔离，还要靠时间隔离**：对于 PWM 电机驱动、同步 Buck 或 Class-D 一类系统，开关沿后的几十到几百纳秒通常伴随反向恢复、电流振铃和共模跳变。若 ADC 正好在这个窗口采样，布局再好也会吃到毛刺。因此工程上常引入**采样静默窗**：等开关边沿过去、振铃衰减、采样保持电容也有足够建立时间后，再由定时器在相对安静的导通中段触发 ADC。
- **采样静默窗本质上是时间预算，不是玄学经验**：若死区时间为 `T_dead`，振铃衰减保守上界为 `T_ring`，前端建立时间为 `T_settle`，ADC 有效孔径近似为 `T_aperture`，那么静默窗至少要满足 `T_quiet >= T_dead + T_ring + T_settle + T_aperture / 2`。软件里设置一个“中间点采样”只是最后一步，前提仍是布局先让这个窗口真的存在。
- **共模干扰和差模误差要分开处理**：共模干扰常来自大面积开关节点对空间的电容耦合，优先靠减小耦合面积、控制回流与改善参考平面；差模误差则更多与采样引线不对称、分流布局、前级 RC 和放大器输入失配有关。把所有异常都归因于“EMI 太大”只会让问题失焦。
- **过孔不是原罪，跨层回流失配才是**：信号换层并不可怕，可怕的是换层后参考平面也跟着变，且附近没有就近回流通道或缝合过孔。高速数字线、采样时钟、PWM 同步触发线一旦跨参考不连续区域，就会在板子里制造一条看不见的大环路。
- **软件滤波只能降低被看见的噪声，不能消灭被注入的噪声**：均值滤波、卡尔曼滤波、中值滤波能抑制随机分量，却无法修正系统性偏移。例如每次 PWM 上升沿后都把电流采样拉高 80 mA，这不是“噪声大一点”，而是采样相位错了。真正有效的顺序，永远是先缩小耦合路径，再把采样对齐到安静时段，最后才轮到数字滤波清理剩余噪声。
- **PCB 的本质不是元件摆放，而是能量闭环管理**：功率环路负责把能量推到负载，小信号环路负责把物理状态送回控制器。前者追求低阻抗与低环感，后者追求高完整性与高重复性。所谓“高频布局经验”，本质就是让每类电流都回到它应该回去的地方，不要在参考、采样和时序上互相伤害。

## 代码能力展现

下面给出一个基于 STM32 HAL 的混合信号采样示例。场景假设为带 PWM 功率级的电流采样板卡：`TIM1` 负责中心对齐 PWM，`ADC1 + DMA` 周期采样**分流电流、母线电压与 VREFINT**，软件根据占空比重新计算 ADC 触发点，让采样尽量落在开关边沿之后的静默窗中段；同时使用**去极值均值**和 **VREFINT 反推 VDDA**，把布局残余噪声与参考漂移从数据里尽量剥离出来。

```c
#include "stm32f4xx_hal.h"
#include <stdbool.h>
#include <stdint.h>

#define PCB_ADC_BITS                 12U
#define PCB_ADC_MAX_CODE             ((1U << PCB_ADC_BITS) - 1U)
#define PCB_ADC_CHANNEL_COUNT        3U   /* current, bus_voltage, vrefint */
#define PCB_GROUPS_PER_HALF          8U
#define PCB_DMA_HALF_LENGTH          (PCB_GROUPS_PER_HALF * PCB_ADC_CHANNEL_COUNT)
#define PCB_DMA_TOTAL_LENGTH         (2U * PCB_DMA_HALF_LENGTH)

typedef struct
{
    TIM_HandleTypeDef *pwm_timer;
    ADC_HandleTypeDef *adc;
    uint32_t adc_trigger_channel;
    uint16_t pwm_arr_ticks;
    uint16_t deadtime_ticks;
    uint16_t ringing_guard_ticks;
    uint16_t adc_aperture_ticks;
    uint16_t minimum_quiet_ticks;
    uint16_t max_code_spread;
    float shunt_resistor_ohm;
    float current_sense_gain;
    float current_bias_ratio;
    float divider_top_ohm;
    float divider_bottom_ohm;
    float current_limit_a;
    float vrefint_cal_voltage_v;
    uint16_t vrefint_cal_code;
} PcbMixedSignalConfig_t;

typedef struct
{
    float phase_current_a;
    float bus_voltage_v;
    float vdda_v;
    uint16_t adc_trigger_tick;
    uint16_t rejected_windows;
    bool quiet_window_valid;
    bool frame_noisy;
} PcbMixedSignalFrame_t;

typedef struct
{
    PcbMixedSignalConfig_t cfg;
    uint16_t dma_buffer[PCB_DMA_TOTAL_LENGTH];
    PcbMixedSignalFrame_t latest;
} PcbMixedSignalMonitor_t;

extern ADC_HandleTypeDef hadc1;
extern TIM_HandleTypeDef htim1;

static PcbMixedSignalMonitor_t g_pcb_monitor =
{
    .cfg =
    {
        .pwm_timer = &htim1,
        .adc = &hadc1,
        .adc_trigger_channel = TIM_CHANNEL_4,
        .pwm_arr_ticks = 2000U,
        .deadtime_ticks = 72U,
        .ringing_guard_ticks = 120U,
        .adc_aperture_ticks = 24U,
        .minimum_quiet_ticks = 180U,
        .max_code_spread = 36U,
        .shunt_resistor_ohm = 0.005f,
        .current_sense_gain = 20.0f,
        .current_bias_ratio = 0.5f,
        .divider_top_ohm = 47000.0f,
        .divider_bottom_ohm = 3300.0f,
        .current_limit_a = 35.0f,
        .vrefint_cal_voltage_v = 3.3f,
        .vrefint_cal_code = 1500U /* 示例值，项目中应替换为芯片出厂校准值。 */
    }
};

static float PcbMixedSignal_ClampFloat(float value, float min_value, float max_value)
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
 * @brief 计算 PWM 周期中的 ADC 触发点，使采样落在开关静默窗中段。
 * @param cfg 板级采样配置。
 * @param duty_ticks 当前有效占空比，单位为定时器 tick。
 * @param sample_tick 输出的采样触发点。
 * @retval true 表示静默窗有效；false 表示当前占空比下安静区间不足。
 *
 * @note 这里假设采用中心对齐 PWM，且低边导通中段噪声最小。
 *       若上升/下降沿之后需要留出死区、振铃衰减和采样建立时间，则：
 *       T_guard = T_dead + T_ring + T_aperture / 2
 *       T_quiet = T_low_conduction - 2 * T_guard
 *       仅当 T_quiet >= T_quiet_min 时，采样才有物理意义。
 */
static bool PcbMixedSignal_ComputeQuietSampleTick(const PcbMixedSignalConfig_t *cfg,
                                                  uint16_t duty_ticks,
                                                  uint16_t *sample_tick)
{
    const uint16_t guard_ticks = (uint16_t)(cfg->deadtime_ticks +
                                            cfg->ringing_guard_ticks +
                                            (cfg->adc_aperture_ticks / 2U));
    uint16_t quiet_start = 0U;
    uint16_t quiet_end = 0U;
    uint16_t quiet_width = 0U;

    if ((sample_tick == NULL) || (duty_ticks >= cfg->pwm_arr_ticks))
    {
        return false;
    }

    /*
     * 对低边分流采样来说，中心对齐 PWM 上半周内：
     * - 低边导通大致发生在 compare 事件之后；
     * - 靠近边沿处仍会被二极管反向恢复、MOSFET 结电容放电和寄生振铃污染。
     * 因此我们不在导通起点采样，而是在“去掉两端保护带”后的中段采样。
     */
    quiet_start = (uint16_t)(duty_ticks + guard_ticks);

    if (cfg->pwm_arr_ticks <= guard_ticks)
    {
        return false;
    }

    quiet_end = (uint16_t)(cfg->pwm_arr_ticks - guard_ticks);

    if (quiet_end <= quiet_start)
    {
        return false;
    }

    quiet_width = (uint16_t)(quiet_end - quiet_start);

    if (quiet_width < cfg->minimum_quiet_ticks)
    {
        return false;
    }

    *sample_tick = (uint16_t)(quiet_start + (quiet_width / 2U));
    return true;
}

/**
 * @brief 根据当前占空比更新 TIM1 的 ADC 触发比较值。
 * @param monitor 混合信号监视器。
 * @param duty_ticks 当前 PWM 占空比，单位为 tick。
 * @retval true 表示触发点已更新；false 表示当前 duty 下没有可靠静默窗。
 */
static bool PcbMixedSignal_UpdateAdcTrigger(PcbMixedSignalMonitor_t *monitor, uint16_t duty_ticks)
{
    uint16_t sample_tick = 0U;
    const bool valid = PcbMixedSignal_ComputeQuietSampleTick(&monitor->cfg,
                                                             duty_ticks,
                                                             &sample_tick);

    monitor->latest.quiet_window_valid = valid;

    if (!valid)
    {
        return false;
    }

    monitor->latest.adc_trigger_tick = sample_tick;
    __HAL_TIM_SET_COMPARE(monitor->cfg.pwm_timer,
                          monitor->cfg.adc_trigger_channel,
                          sample_tick);
    return true;
}

/**
 * @brief 将 ADC 码值换算为引脚电压。
 * @param adc_code 原始 ADC 码值。
 * @param vdda_v 当前模拟电源电压。
 * @retval 输入引脚处电压，单位 V。
 *
 * @note 理想 N 位 ADC 满量程关系：
 *       V_pin = adc_code / (2^N - 1) * VDDA
 *       先利用 VREFINT 反推 VDDA，再做电压还原，可把参考漂移显式纳入计算。
 */
static float PcbMixedSignal_CodeToPinVoltage(uint16_t adc_code, float vdda_v)
{
    return ((float)adc_code * vdda_v) / (float)PCB_ADC_MAX_CODE;
}

/**
 * @brief 使用 VREFINT 平均码值反推本周期的 VDDA。
 * @param cfg 板级采样配置。
 * @param vrefint_code VREFINT 的平均 ADC 码值。
 * @retval 估计得到的 VDDA，单位 V。
 *
 * @note VREFINT 出厂标定的基本关系：
 *       VDDA_now ≈ V_cal * Code_cal / Code_now
 *       这样可以将参考电压随供电和地弹的漂移，折算回采样换算链路里。
 */
static float PcbMixedSignal_EstimateVdda(const PcbMixedSignalConfig_t *cfg, uint16_t vrefint_code)
{
    if (vrefint_code == 0U)
    {
        return cfg->vrefint_cal_voltage_v;
    }

    return (cfg->vrefint_cal_voltage_v * (float)cfg->vrefint_cal_code) / (float)vrefint_code;
}

/**
 * @brief 将电流采样码值换算为相电流。
 * @param cfg 板级采样配置。
 * @param current_code 电流采样平均码值。
 * @param vdda_v 当前模拟电源电压。
 * @retval 相电流，单位 A。
 *
 * @note 假设运放输出以半电源为偏置，则：
 *       V_bias = bias_ratio * VDDA
 *       V_shunt = V_pin - V_bias
 *       I_phase = V_shunt / (R_shunt * Gain)
 *       该公式把分流电阻、前级增益和参考漂移统一映射到物理电流。
 */
static float PcbMixedSignal_CodeToCurrent(const PcbMixedSignalConfig_t *cfg,
                                          uint16_t current_code,
                                          float vdda_v)
{
    const float v_pin = PcbMixedSignal_CodeToPinVoltage(current_code, vdda_v);
    const float v_bias = cfg->current_bias_ratio * vdda_v;
    const float v_shunt = v_pin - v_bias;
    const float denom = cfg->shunt_resistor_ohm * cfg->current_sense_gain;

    if (denom <= 1.0e-9f)
    {
        return 0.0f;
    }

    return PcbMixedSignal_ClampFloat(v_shunt / denom,
                                     -cfg->current_limit_a,
                                     cfg->current_limit_a);
}

/**
 * @brief 将母线分压码值换算为真实母线电压。
 * @param cfg 板级采样配置。
 * @param bus_code 母线电压平均码值。
 * @param vdda_v 当前模拟电源电压。
 * @retval 母线电压，单位 V。
 *
 * @note 分压还原关系：
 *       V_bus = V_pin * (R_top + R_bottom) / R_bottom
 *       该式只在分压回路回流干净、ADC 参考稳定时才成立。
 */
static float PcbMixedSignal_CodeToBusVoltage(const PcbMixedSignalConfig_t *cfg,
                                             uint16_t bus_code,
                                             float vdda_v)
{
    const float v_pin = PcbMixedSignal_CodeToPinVoltage(bus_code, vdda_v);

    if (cfg->divider_bottom_ohm <= 1.0e-6f)
    {
        return 0.0f;
    }

    return v_pin * ((cfg->divider_top_ohm + cfg->divider_bottom_ohm) / cfg->divider_bottom_ohm);
}

/**
 * @brief 对一个 DMA 半缓冲窗口做去极值均值统计，并输出物理量。
 * @param monitor 混合信号监视器。
 * @param source 指向 DMA 半缓冲起始地址。
 * @param frame 输出结果。
 *
 * @note 这里每次统计 8 组 interleaved 采样：
 *       [I0, VBUS0, VREF0, I1, VBUS1, VREF1, ...]
 *       软件去掉每个通道的最大值和最小值，再对中间样本求均值。
 *       这样无法修正系统性串扰，但能抑制偶发毛刺和未完全衰减的边沿污染。
 */
static void PcbMixedSignal_ProcessWindow(PcbMixedSignalMonitor_t *monitor,
                                         const uint16_t *source,
                                         PcbMixedSignalFrame_t *frame)
{
    uint32_t sum_i = 0U;
    uint32_t sum_bus = 0U;
    uint32_t sum_ref = 0U;
    uint16_t min_i = 0xFFFFU;
    uint16_t max_i = 0U;
    uint16_t min_bus = 0xFFFFU;
    uint16_t max_bus = 0U;
    uint16_t min_ref = 0xFFFFU;
    uint16_t max_ref = 0U;
    uint16_t index = 0U;
    uint16_t avg_i = 0U;
    uint16_t avg_bus = 0U;
    uint16_t avg_ref = 0U;

    frame->frame_noisy = false;

    for (index = 0U; index < PCB_GROUPS_PER_HALF; ++index)
    {
        const uint16_t code_i = source[index * PCB_ADC_CHANNEL_COUNT + 0U];
        const uint16_t code_bus = source[index * PCB_ADC_CHANNEL_COUNT + 1U];
        const uint16_t code_ref = source[index * PCB_ADC_CHANNEL_COUNT + 2U];

        sum_i += code_i;
        sum_bus += code_bus;
        sum_ref += code_ref;

        if (code_i < min_i) { min_i = code_i; }
        if (code_i > max_i) { max_i = code_i; }
        if (code_bus < min_bus) { min_bus = code_bus; }
        if (code_bus > max_bus) { max_bus = code_bus; }
        if (code_ref < min_ref) { min_ref = code_ref; }
        if (code_ref > max_ref) { max_ref = code_ref; }
    }

    /*
     * 去极值均值：
     * avg = (sum - min - max) / (N - 2)
     * 若 spread 仍然过大，说明本窗口可能仍被边沿、回流跳变或参考抖动污染。
     */
    avg_i = (uint16_t)((sum_i - min_i - max_i) / (PCB_GROUPS_PER_HALF - 2U));
    avg_bus = (uint16_t)((sum_bus - min_bus - max_bus) / (PCB_GROUPS_PER_HALF - 2U));
    avg_ref = (uint16_t)((sum_ref - min_ref - max_ref) / (PCB_GROUPS_PER_HALF - 2U));

    if (((max_i - min_i) > monitor->cfg.max_code_spread) ||
        ((max_bus - min_bus) > monitor->cfg.max_code_spread) ||
        ((max_ref - min_ref) > monitor->cfg.max_code_spread))
    {
        frame->frame_noisy = true;
        frame->rejected_windows++;
    }

    frame->vdda_v = PcbMixedSignal_EstimateVdda(&monitor->cfg, avg_ref);
    frame->phase_current_a = PcbMixedSignal_CodeToCurrent(&monitor->cfg, avg_i, frame->vdda_v);
    frame->bus_voltage_v = PcbMixedSignal_CodeToBusVoltage(&monitor->cfg, avg_bus, frame->vdda_v);
}

/**
 * @brief 启动中心对齐 PWM 同步采样链路。
 * @param monitor 混合信号监视器。
 * @param duty_ticks 初始 PWM 占空比，单位 tick。
 * @retval HAL 状态码。
 *
 * @note 调用顺序上，必须先更新 ADC 触发点，再开启 PWM 与 DMA。
 *       若当前 duty 下连最小静默窗都不存在，宁可拒绝启动，也不要采一堆注定失真的数据。
 */
HAL_StatusTypeDef PcbMixedSignal_Start(PcbMixedSignalMonitor_t *monitor, uint16_t duty_ticks)
{
    if (!PcbMixedSignal_UpdateAdcTrigger(monitor, duty_ticks))
    {
        return HAL_ERROR;
    }

    if (HAL_TIM_PWM_Start(monitor->cfg.pwm_timer, TIM_CHANNEL_1) != HAL_OK)
    {
        return HAL_ERROR;
    }

    if (HAL_TIM_PWM_Start(monitor->cfg.pwm_timer, TIM_CHANNEL_2) != HAL_OK)
    {
        return HAL_ERROR;
    }

    if (HAL_TIM_OC_Start(monitor->cfg.pwm_timer, monitor->cfg.adc_trigger_channel) != HAL_OK)
    {
        return HAL_ERROR;
    }

    return HAL_ADC_Start_DMA(monitor->cfg.adc,
                             (uint32_t *)monitor->dma_buffer,
                             PCB_DMA_TOTAL_LENGTH);
}

/**
 * @brief 在 PWM 占空比更新后重算 ADC 采样相位。
 * @param duty_ticks 新占空比，单位 tick。
 * @retval true 表示新的触发点有效。
 *
 * @note 这一步体现了“布局与调度是一体的”：
 *       占空比改变后，低噪声导通区长度也会跟着改变，
 *       采样点必须重新落到安静区中段，而不是永远固定在一个魔法数字上。
 */
bool PcbMixedSignal_OnDutyChanged(uint16_t duty_ticks)
{
    return PcbMixedSignal_UpdateAdcTrigger(&g_pcb_monitor, duty_ticks);
}

void HAL_ADC_ConvHalfCpltCallback(ADC_HandleTypeDef *hadc)
{
    if (hadc != g_pcb_monitor.cfg.adc)
    {
        return;
    }

    PcbMixedSignal_ProcessWindow(&g_pcb_monitor,
                                 &g_pcb_monitor.dma_buffer[0],
                                 &g_pcb_monitor.latest);
}

void HAL_ADC_ConvCpltCallback(ADC_HandleTypeDef *hadc)
{
    if (hadc != g_pcb_monitor.cfg.adc)
    {
        return;
    }

    PcbMixedSignal_ProcessWindow(&g_pcb_monitor,
                                 &g_pcb_monitor.dma_buffer[PCB_DMA_HALF_LENGTH],
                                 &g_pcb_monitor.latest);
}
```

这段代码没有神奇地“修好 PCB”，它做的是把板级约束显式搬进采样调度里：先承认边沿附近不干净，再用定时器把 ADC 触发点放到静默窗中段；先承认参考会漂，再用 `VREFINT` 反推 `VDDA`；先承认毛刺偶发存在，再用去极值均值抑制窗口内离群值。真正靠谱的混合信号系统，往往就是这样：布局先给出可采样的物理前提，固件再把这份前提守住。
