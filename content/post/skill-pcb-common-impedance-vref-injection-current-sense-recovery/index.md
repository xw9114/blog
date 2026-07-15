---
title: "技能档案：混合信号 PCB 的共阻抗耦合、VREF 回注与电流采样运放恢复时间"
slug: "skill-pcb-common-impedance-vref-injection-current-sense-recovery"
date: 2026-07-05T11:42:18+08:00
draft: false
description: "从共阻抗地弹、开关节点对参考网络的回注，到电流采样运放过驱恢复和物理可达电流斜率门控，系统拆解混合信号 PCB 为何会把真实相电流读成伪瞬态。"
tags: ["STM32", "PCB", "ADC", "VREFINT", "电流采样", "混合信号", "EMI"]
categories: ["技能档案", "嵌入式系统"]
image: ""
---

## 技能概述

很多混合信号板卡静态校准时一切正常，一旦功率级开始 `PWM` 翻转，电流环、过流保护和母线观测就像突然换了一套物理世界：同一相电流会被读成两个不同数值，`ADC` 参考会跟着桥臂边沿起伏，电流采样运放还没从上一个瞬态里恢复，下一次采样就已经到了。这个主题真正解决的痛点，不是“多加几个电容”或“软件滤一滤”，而是把 **共阻抗回流、参考回注、运放恢复时间与采样调度** 看成同一条误差链，明确哪些偏差来自真实负载变化，哪些只是布局和时序把测量链暂时污染了。

## 核心底层概念解析

- **共阻抗耦合不是抽象名词，而是回流路径被多条电流同时借道**：功率回路、栅极驱动回路和小信号采样回路只要共享了一段铜皮、过孔或连接器引脚，就会在这段公共阻抗上叠加误差。其一阶形式可写成  
  `V_err_shared = I_return * R_shared + L_shared * di/dt`。  
  电流环以为自己在测 `R_shunt` 两端压差，实际却把共享回路上的压降也一起量进来了。

- **开关节点对参考网络的伤害，很多时候是位移电流而不是直流压降**：半桥中点、Buck 的 `SW` 节点或驱动栅极回路对周围铜皮存在寄生电容，只要 `dv/dt` 足够陡，就会通过  
  `I_inj = C_parasitic * dv/dt`  
  把共模扰动打进 `AGND`、`VREF+`、运放输入和采样引线。板子名义开关频率也许只有几十 `kHz`，但真正制造污染的是纳秒级边沿。

- **`VREF` 被拉动时，ADC 误差不是纯加性，而是整个刻度尺一起伸缩**：理想 `N` 位 ADC 满足  
  `Code = Vin / Vdda * (2^N - 1)`。  
  对小扰动线性化后有  
  `Delta Code ~= (2^N - 1) * Delta Vin / Vdda - (2^N - 1) * Vin * Delta Vdda / Vdda^2`。  
  第一项是输入节点真的被污染，第二项是参考电压自己在跳。很多“电流采样随 PWM 相位飘”的现象，其实两项同时存在。

- **电流采样运放并不是无限快的线性器件，过驱后会进入恢复期**：开关边沿附近，输入共模可能越界、输出级可能短时饱和、输入级尾流会重新建立。即便示波器看见毛刺只持续几十纳秒，运放恢复到可用线性区往往要更久。工程上的有效消隐时间应至少满足  
  `T_blank >= T_dead + T_rr + T_opamp_recover + T_settle + T_aperture / 2`，  
  这里 `T_rr` 是二极管反向恢复或寄生振铃保守上界，`T_opamp_recover` 是放大器从过驱回到线性的时间。

- **Kelvin 采样的核心不是“从电阻脚边拉两根线”，而是让测量回路不为功率回路背锅**：若采样线从大电流铜皮外侧引出，实际读到的就不再是单纯的  
  `V_shunt = I_phase * R_shunt`，  
  而是  
  `V_meas = I_phase * R_shunt + I_return * R_trace + L_trace * di/dt`。  
  这类误差在静态标定时往往看不出来，因为 `di/dt` 接近零。

- **前端 RC 滤波并非越重越稳，它会和 ADC 采样保持电容争夺建立时间**：若前级等效源阻抗为 `Rsrc`，采样保持电容为 `Csh`，则一阶建立残差近似  
  `e_settle = exp(-T_acq / (Rsrc * Csh))`。  
  你加大的每一欧串阻、每一法并容，都在改善高频抑制和恶化采样建立之间做交易。布局没有先把噪声能量挡在外面，最后就会逼迫软件接受更短的采样窗和更大的残差。

- **“安静窗口”不只是给 ADC 的，也是给运放恢复的**：很多人只按桥臂导通区长度安排采样点，却忘了运放可能在边沿后仍处于尾部恢复。于是采样点虽然避开了尖峰峰值，却还没避开失真尾巴。真正可靠的触发点，不是固定写死在某个 `CCR` 值，而是随占空比、死区和前端恢复预算一起移动。

- **真实电流不可能在一个控制周期里无上限跳变，这给了软件区分“物理变化”和“测量污染”的门槛**：对相电感 `L` 的保守离散上界，有  
  `|di/dt| <= Vbus / L`，  
  因而相邻两次可信样本之间最多满足  
  `|Delta I|_max <= (Vbus / L) * Delta t`。  
  若采到的电流跳变量远大于这个上界，同时又伴随 `VREF` 抖动或窗口失效，那么大概率不是电机真的疯了，而是测量链被瞬态打穿了。

- **硬件保护和软件判稳应该各司其职**：比较器 `BKIN`、驱动器 `DESAT` 或片上 `AWD` 负责在最短路径上切断功率；软件门控负责决定“这份样本能不能进入控制器状态”。前者解决烧不烧，后者解决控不控。把两者混成一层逻辑，系统要么过于神经质，要么在真正故障时太慢。

- **工程调试时，先分清误差是加性还是乘性，再决定修板还是修算法**：若 `VREFINT`、母线采样和电流采样一起按同相位缩放，问题更可能在参考或地弹；若只有电流通道跳，而 `VREFINT` 稳定，则更可能是前端共模、运放恢复或 Kelvin 回路失真。调试顺序应该是同时间戳抓 `shunt/vrefint/vbus/gate`，不要只看一根电流线就开始改滤波参数。

- **示波器探头本身也可能是干扰链的一部分**：长地线探头会把原本局部的地弹扩成可观测的天线回路，最后你看到的“尖峰”里有一半来自测量方法。混合信号板排错时，弹簧地、差分探头、就近参考点和双通道相关观察，往往比再焊一个电容更能缩短闭环时间。

- **技术哲学上，混合信号 PCB 的本质不是“让波形看起来平”，而是维护一条可信的物理映射**：控制器想知道的是“此刻真实电流是多少”，而不是“前端、参考、回流和 ADC 共同生成了什么码值”。一切布局、滤波、消隐和算法门控，最终都在为这条映射保真。

## 代码能力展现

下面给出一个基于 **STM32 HAL** 的“噪声感知电流采样监视器”。它刻意把一份电流样本拆成三层含义：

- `TIM1 CH4` 根据当前占空比把注入转换触发点放到运放恢复后的安静窗口；
- `ADC1` 注入组同拍采 `shunt` 与 `VREFINT`，先把参考漂移显式折回换算链；
- 软件再用 **物理可达电流斜率门控** 判断这次跳变究竟像真实负载变化，还是像一次共阻抗/恢复期污染。

这段代码不试图替代真正的硬件比较器保护，它的职责是让进入电流环的样本尽量可信。

```c
#include "main.h"

#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#define PCB_SENSE_ADC_FULL_SCALE_F      4095.0f
#define PCB_SENSE_MIN_VDDA_V            2.7f
#define PCB_SENSE_MAX_VDDA_V            3.6f
#define PCB_SENSE_MIN_DT_S              1.0e-6f
#define PCB_SENSE_MAX_DT_S              5.0e-3f
#define PCB_SENSE_MIN_PHASE_L_H         1.0e-6f
#define PCB_SENSE_MIN_GAIN              0.1f
#define PCB_SENSE_MIN_SHUNT_OHM         1.0e-4f

typedef struct
{
    TIM_HandleTypeDef *htim_pwm;
    TIM_HandleTypeDef *htim_timebase;
    ADC_HandleTypeDef *hadc;
    uint32_t adc_trigger_channel;
    uint32_t timebase_hz;
    uint16_t pwm_arr_ticks;
    uint16_t deadtime_ticks;
    uint16_t ringing_guard_ticks;
    uint16_t opamp_recovery_ticks;
    uint16_t adc_aperture_ticks;
    uint16_t minimum_quiet_ticks;
    uint16_t vrefint_cal_code;
    float vrefint_cal_voltage_v;
    float shunt_ohm;
    float amp_gain;
    float bias_ratio;
    float phase_inductance_h;
    float vbus_estimate_v;
    float current_limit_a;
    float current_glitch_margin_a;
    float vdda_jump_limit_v;
    float current_lpf_alpha;
} PcbSenseConfig_t;

typedef struct
{
    float vdda_v;
    float current_raw_a;
    float current_valid_a;
    float current_filtered_a;
    float max_delta_i_a;
    float dt_s;
    uint16_t trigger_tick;
    uint16_t rejected_samples;
    uint8_t quiet_window_valid;
    uint8_t used_previous_sample;
    uint32_t frame_id;
} PcbSenseFrame_t;

typedef struct
{
    PcbSenseConfig_t cfg;
    PcbSenseFrame_t latest;
    uint32_t sample_tick_z1;
    float current_valid_z1_a;
    float current_filtered_z1_a;
    float vdda_z1_v;
    uint8_t ready;
} PcbSenseMonitor_t;

extern ADC_HandleTypeDef hadc1;
extern TIM_HandleTypeDef htim1;
extern TIM_HandleTypeDef htim2;

static PcbSenseMonitor_t g_pcb_sense =
{
    .cfg =
    {
        .htim_pwm = &htim1,
        .htim_timebase = &htim2,
        .hadc = &hadc1,
        .adc_trigger_channel = TIM_CHANNEL_4,
        .timebase_hz = 1000000U,          /* TIM2 以 1 MHz 自由运行，用于样本时间戳。 */
        .pwm_arr_ticks = 3600U,
        .deadtime_ticks = 72U,
        .ringing_guard_ticks = 96U,
        .opamp_recovery_ticks = 120U,
        .adc_aperture_ticks = 18U,
        .minimum_quiet_ticks = 220U,
        .vrefint_cal_code = 1506U,        /* 示例值，实际项目应替换为芯片出厂校准值。 */
        .vrefint_cal_voltage_v = 3.3f,
        .shunt_ohm = 0.003f,
        .amp_gain = 20.0f,
        .bias_ratio = 0.5f,
        .phase_inductance_h = 180.0e-6f,
        .vbus_estimate_v = 24.0f,
        .current_limit_a = 40.0f,
        .current_glitch_margin_a = 1.5f,
        .vdda_jump_limit_v = 0.05f,
        .current_lpf_alpha = 0.25f
    }
};

static float PcbSense_ClampF(float value, float min_value, float max_value)
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

static float PcbSense_TickDeltaToSeconds(uint32_t now_tick,
                                         uint32_t prev_tick,
                                         uint32_t tick_hz)
{
    return (float)(now_tick - prev_tick) / (float)tick_hz;
}

/**
 * @brief 依据当前占空比计算注入采样触发点，避开边沿与运放恢复期。
 * @param cfg 板级采样配置。
 * @param duty_ticks 当前有效占空比，单位为定时器 tick。
 * @param sample_tick 输出的 ADC 触发点。
 * @retval true 表示当前 duty 下存在可靠静默窗，false 表示不应采样。
 *
 * @note 低边电流采样时，安静窗口并不等于“低边导通就能采”，
 *       还必须给死区、寄生振铃、运放过驱恢复和 ADC 孔径留出保护带：
 *       Tblank = Tdead + Tring + Topamp_recover + Taperture / 2
 *       Tquiet = Tlow_conduction - 2 * Tblank
 *       只有当 Tquiet >= Tquiet_min 时，这份采样才配进入控制环。
 */
static bool PcbSense_ComputeQuietSampleTick(const PcbSenseConfig_t *cfg,
                                            uint16_t duty_ticks,
                                            uint16_t *sample_tick)
{
    const uint16_t blank_ticks = (uint16_t)(cfg->deadtime_ticks +
                                            cfg->ringing_guard_ticks +
                                            cfg->opamp_recovery_ticks +
                                            (cfg->adc_aperture_ticks / 2U));
    uint16_t quiet_start = 0U;
    uint16_t quiet_end = 0U;
    uint16_t quiet_width = 0U;

    if ((cfg == NULL) || (sample_tick == NULL) || (duty_ticks >= cfg->pwm_arr_ticks))
    {
        return false;
    }

    /*
     * 这里假设使用中心对齐 PWM，且低边安静导通区位于 compare 之后到周期顶点之前。
     * 占空比升高会直接压缩低边导通区，因此 sample tick 不能写死成常数。
     */
    quiet_start = (uint16_t)(duty_ticks + blank_ticks);
    quiet_end = (uint16_t)(cfg->pwm_arr_ticks - blank_ticks);

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
 * @brief 根据 VREFINT 标定值反推当前模拟电源 VDDA。
 * @param cfg 板级采样配置。
 * @param vrefint_code 本拍 VREFINT 注入采样码值。
 * @retval 估计得到的 VDDA，单位 V。
 *
 * @note 出厂标定近似关系：
 *       VDDA_now ~= Vcal * Code_cal / Code_now
 *       这样可以把参考电压被地弹或供电纹波拉动的影响，
 *       重新折回到所有基于 ADC 码值的物理量换算里。
 */
static float PcbSense_EstimateVdda(const PcbSenseConfig_t *cfg, uint16_t vrefint_code)
{
    float vdda_v = cfg->vrefint_cal_voltage_v;

    if (vrefint_code != 0U)
    {
        vdda_v = (cfg->vrefint_cal_voltage_v * (float)cfg->vrefint_cal_code) /
                 (float)vrefint_code;
    }

    return PcbSense_ClampF(vdda_v, PCB_SENSE_MIN_VDDA_V, PCB_SENSE_MAX_VDDA_V);
}

/**
 * @brief 将当前 ADC 码值换算成相电流。
 * @param cfg 板级采样配置。
 * @param shunt_code 本拍分流电阻采样码值。
 * @param vdda_v 当前估计的模拟电源电压。
 * @retval 相电流，单位 A。
 *
 * @note 理想换算链为：
 *       Vpin   = Code / 4095 * VDDA
 *       Vbias  = bias_ratio * VDDA
 *       Iphase = (Vpin - Vbias) / (Rshunt * Gain)
 *
 *       一旦共阻抗耦合和运放恢复期把 Vpin 扭曲，这个映射就会被污染。
 *       因此这里先完成“参考补偿后的理想还原”，后续再叠加可信度门控。
 */
static float PcbSense_CodeToPhaseCurrent(const PcbSenseConfig_t *cfg,
                                         uint16_t shunt_code,
                                         float vdda_v)
{
    const float vpin_v = ((float)shunt_code * vdda_v) / PCB_SENSE_ADC_FULL_SCALE_F;
    const float vbias_v = cfg->bias_ratio * vdda_v;
    const float gain = PcbSense_ClampF(cfg->amp_gain, PCB_SENSE_MIN_GAIN, 500.0f);
    const float shunt_ohm = PcbSense_ClampF(cfg->shunt_ohm, PCB_SENSE_MIN_SHUNT_OHM, 0.5f);
    const float current_a = (vpin_v - vbias_v) / (shunt_ohm * gain);

    return PcbSense_ClampF(current_a, -cfg->current_limit_a, cfg->current_limit_a);
}

/**
 * @brief 估算相邻两次可信样本之间允许的最大电流变化。
 * @param cfg 板级采样配置。
 * @param dt_s 与上一次可信样本的时间间隔。
 * @retval 保守的最大允许电流跃迁，单位 A。
 *
 * @note 对相电感的保守上界：
 *       |di/dt| <= Vbus / L
 *       因此 |Delta I|max <= (Vbus / L) * dt
 *
 *       这不是精确的电机状态方程，而是判断“当前跳变是否物理可达”的
 *       安全上界。若测得跃迁远超这个极限，再结合 VREF 抖动或窗口失效，
 *       就应该怀疑是测量链被边沿污染，而不是负载真的跳了那么多。
 */
static float PcbSense_MaxPhysicalDeltaI(const PcbSenseConfig_t *cfg, float dt_s)
{
    const float vbus_v = PcbSense_ClampF(cfg->vbus_estimate_v, 1.0f, 100.0f);
    const float inductance_h =
        PcbSense_ClampF(cfg->phase_inductance_h, PCB_SENSE_MIN_PHASE_L_H, 1.0f);

    return (vbus_v / inductance_h) * dt_s;
}

/**
 * @brief 根据占空比更新 TIM 的 ADC 触发比较值。
 * @param monitor 电流采样监视器。
 * @param duty_ticks 当前有效占空比，单位为 tick。
 * @retval true 表示触发点有效并已写回，false 表示当前 duty 下应暂停信任样本。
 */
static bool PcbSense_UpdateInjectedTrigger(PcbSenseMonitor_t *monitor, uint16_t duty_ticks)
{
    uint16_t trigger_tick = 0U;
    const bool valid = PcbSense_ComputeQuietSampleTick(&monitor->cfg,
                                                       duty_ticks,
                                                       &trigger_tick);

    monitor->latest.quiet_window_valid = (uint8_t)valid;

    if (!valid)
    {
        return false;
    }

    monitor->latest.trigger_tick = trigger_tick;
    __HAL_TIM_SET_COMPARE(monitor->cfg.htim_pwm,
                          monitor->cfg.adc_trigger_channel,
                          trigger_tick);
    return true;
}

/**
 * @brief 提交一份“参考补偿 + 物理斜率门控”后的可信电流样本。
 * @param monitor 电流采样监视器。
 * @param shunt_code 注入组 rank1 的电流采样码值。
 * @param vrefint_code 注入组 rank2 的 VREFINT 采样码值。
 *
 * @note 若同时出现以下任一现象，优先保留上一份可信样本：
 *       1. 当前 duty 下已经没有可靠静默窗；
 *       2. 电流跃迁超过 |Delta I|max + margin；
 *       3. 同拍检测到明显的 VDDA 跳变。
 *
 *       这样做的目标不是“让波形更好看”，而是阻止运放恢复期的伪尖峰
 *       直接进入 PI 控制器积分状态。
 */
static void PcbSense_CommitInjectedSample(PcbSenseMonitor_t *monitor,
                                          uint16_t shunt_code,
                                          uint16_t vrefint_code)
{
    PcbSenseFrame_t *frame = &monitor->latest;
    const float vdda_v = PcbSense_EstimateVdda(&monitor->cfg, vrefint_code);
    const float current_raw_a = PcbSense_CodeToPhaseCurrent(&monitor->cfg,
                                                            shunt_code,
                                                            vdda_v);
    const uint32_t sample_tick = __HAL_TIM_GET_COUNTER(monitor->cfg.htim_timebase);
    const float alpha = PcbSense_ClampF(monitor->cfg.current_lpf_alpha, 0.02f, 1.0f);

    frame->frame_id++;
    frame->used_previous_sample = 0U;
    frame->vdda_v = vdda_v;
    frame->current_raw_a = current_raw_a;
    frame->dt_s = 0.0f;
    frame->max_delta_i_a = 0.0f;

    if (monitor->ready == 0U)
    {
        monitor->ready = 1U;
        monitor->sample_tick_z1 = sample_tick;
        monitor->current_valid_z1_a = current_raw_a;
        monitor->current_filtered_z1_a = current_raw_a;
        monitor->vdda_z1_v = vdda_v;

        frame->current_valid_a = current_raw_a;
        frame->current_filtered_a = current_raw_a;
        return;
    }

    frame->dt_s = PcbSense_ClampF(
        PcbSense_TickDeltaToSeconds(sample_tick,
                                    monitor->sample_tick_z1,
                                    monitor->cfg.timebase_hz),
        PCB_SENSE_MIN_DT_S,
        PCB_SENSE_MAX_DT_S);
    frame->max_delta_i_a = PcbSense_MaxPhysicalDeltaI(&monitor->cfg, frame->dt_s);

    {
        const float current_jump_a = fabsf(current_raw_a - monitor->current_valid_z1_a);
        const float vdda_jump_v = fabsf(vdda_v - monitor->vdda_z1_v);
        const bool impossible_step =
            current_jump_a > (frame->max_delta_i_a + monitor->cfg.current_glitch_margin_a);
        const bool noisy_reference = vdda_jump_v > monitor->cfg.vdda_jump_limit_v;
        const bool invalid_window = (frame->quiet_window_valid == 0U);

        if (invalid_window || (impossible_step && noisy_reference))
        {
            frame->used_previous_sample = 1U;
            frame->rejected_samples++;
            frame->current_valid_a = monitor->current_valid_z1_a;
            frame->current_filtered_a = monitor->current_filtered_z1_a;
            return;
        }
    }

    monitor->sample_tick_z1 = sample_tick;
    monitor->current_valid_z1_a = current_raw_a;
    monitor->current_filtered_z1_a +=
        alpha * (current_raw_a - monitor->current_filtered_z1_a);
    monitor->vdda_z1_v = vdda_v;

    frame->current_valid_a = monitor->current_valid_z1_a;
    frame->current_filtered_a = monitor->current_filtered_z1_a;
}

/**
 * @brief 启动 PCB 混合信号电流采样监视器。
 * @param monitor 电流采样监视器。
 * @param initial_duty_ticks 初始占空比，单位为 tick。
 * @retval 1 启动成功，0 启动失败。
 *
 * @note 启动顺序上，必须先验证静默窗是否存在，再开启注入组与触发输出。
 *       若当前 duty 下连可信窗口都没有，继续采样只会让软件拿到一堆
 *       必须丢弃的数据，不如在启动期直接拒绝配置。
 */
uint8_t PcbSense_Start(PcbSenseMonitor_t *monitor, uint16_t initial_duty_ticks)
{
    if ((monitor == NULL) ||
        (monitor->cfg.hadc == NULL) ||
        (monitor->cfg.htim_pwm == NULL) ||
        (monitor->cfg.htim_timebase == NULL))
    {
        return 0U;
    }

    memset(&monitor->latest, 0, sizeof(monitor->latest));
    monitor->ready = 0U;

    if (!PcbSense_UpdateInjectedTrigger(monitor, initial_duty_ticks))
    {
        return 0U;
    }

    if (HAL_TIM_OC_Start(monitor->cfg.htim_pwm, monitor->cfg.adc_trigger_channel) != HAL_OK)
    {
        return 0U;
    }

    if (HAL_ADCEx_InjectedStart_IT(monitor->cfg.hadc) != HAL_OK)
    {
        (void)HAL_TIM_OC_Stop(monitor->cfg.htim_pwm, monitor->cfg.adc_trigger_channel);
        return 0U;
    }

    return 1U;
}

/**
 * @brief 占空比改变后重算注入采样相位。
 * @param duty_ticks 新占空比，单位为 tick。
 * @retval true 表示新的触发点仍在可信静默窗中。
 */
bool PcbSense_OnDutyChanged(uint16_t duty_ticks)
{
    return PcbSense_UpdateInjectedTrigger(&g_pcb_sense, duty_ticks);
}

/**
 * @brief 更新当前母线电压估计，用于物理电流斜率门控。
 * @param vbus_v 最新母线电压估计，单位 V。
 */
void PcbSense_SetBusEstimateV(float vbus_v)
{
    g_pcb_sense.cfg.vbus_estimate_v = PcbSense_ClampF(vbus_v, 1.0f, 100.0f);
}

void HAL_ADCEx_InjectedConvCpltCallback(ADC_HandleTypeDef *hadc)
{
    uint16_t shunt_code = 0U;
    uint16_t vrefint_code = 0U;

    if (hadc != g_pcb_sense.cfg.hadc)
    {
        return;
    }

    shunt_code = (uint16_t)HAL_ADCEx_InjectedGetValue(hadc, ADC_INJECTED_RANK_1);
    vrefint_code = (uint16_t)HAL_ADCEx_InjectedGetValue(hadc, ADC_INJECTED_RANK_2);

    PcbSense_CommitInjectedSample(&g_pcb_sense, shunt_code, vrefint_code);
}

void Application_StartPcbSense(void)
{
    if (PcbSense_Start(&g_pcb_sense, 1200U) == 0U)
    {
        Error_Handler();
    }
}
```

这段代码刻意做了几件“看起来保守、实际上省命”的事：

- 同拍读取 `VREFINT`，先判断刻度尺有没有被地弹拖走，再解释电流码值；
- 把运放恢复时间写进 `T_blank`，避免采样点只是离开了尖峰，却还没离开失真尾巴；
- 用 `|Delta I|max <= (Vbus / L) * Delta t` 做物理上界门控，阻止不可能的电流跳变污染控制器状态；
- 在静默窗失效时优先沿用上一份可信样本，而不是把“明知可疑”的值硬塞给 `PI`。

如果布局已经把参考、回流和前端耦合控制得足够干净，这套门控平时几乎不会说话；但一旦板子开始在边沿附近自我污染，它会第一时间提醒你，问题不在“电机突然失控”，而在“你测到的那份电流根本不是同一个物理世界里的电流”。
