---
title: "技能档案：硬件中断的边界，从 EXTI 触发沿到定时器消抖确认窗"
slug: "skill-exti-edge-trigger-and-timer-debounce-window"
date: 2026-05-04T12:06:21+08:00
draft: false
description: "从机械触点反弹、RC 充放电、施密特阈值到 EXTI 挂起位与定时器确认窗，系统拆解硬件中断为何只能感知边沿而不能直接代表稳定状态。"
tags: ["STM32", "EXTI", "硬件中断", "信号消抖", "时序"]
categories: ["技能档案", "嵌入式系统"]
image: ""
---

## 技能概述

硬件中断的价值，从来不是“比轮询更快”这么简单，而是在资源有限的 MCU 里，把真正值得 CPU 立即响应的状态变化，从持续流动的电平背景里剥离出来。按键输入、限位开关、霍尔边沿、故障脚、光电对管和隔离输入都会依赖这套机制，但工程痛点也正出在这里：物理世界给出的从来不是理想数字方波，而是带有机械反弹、线缆电容、上拉阻抗、比较器阈值和共模扰动的模拟过程。真正的中断设计不是写一个 `HAL_GPIO_EXTI_Callback()` 就结束，而是要回答三个底层问题: 哪个边沿值得被捕获，捕获之后多久才能承认它是真的，以及这段确认过程该如何在不阻塞系统的前提下完成。

## 核心底层概念解析

- **EXTI 捕获的是边沿，不是“状态已经稳定”**：GPIO 线上电压只要跨过输入阈值，边沿检测逻辑就可能置位挂起寄存器。对于 STM32 这类 MCU，中断控制器看到的是“发生过一次跨阈值事件”，而不是“引脚已经稳定保持高电平 5 ms”。这就是为什么触点反弹经常表现为一次按下触发多次中断，本质上不是代码写错，而是硬件忠实汇报了每一次跨阈值抖动。
- **机械触点的抖动，本质是弹性系统的多次碰撞而不是单次跳变**：金属簧片闭合时会发生接触、回弹、再接触，时间尺度常在几十微秒到几毫秒之间。若把理想状态记为 `s(t) ∈ {0, 1}`，真实触点输出更接近一串带随机间隔的脉冲列。也就是说，消抖并不是“滤掉噪声点”，而是要把一段暂态碰撞过程压缩回一次离散状态迁移。
- **上升沿和下降沿往往并不对称，因为线缆和输入网络在做 RC 充放电**：若输入由 `R_pullup` 上拉、线缆与管脚总电容为 `C_line`，则电平上升过程近似满足 `V(t) = VDD * (1 - exp(-t / (R_pullup * C_line)))`。跨过高阈值 `V_IH` 所需时间为 `t_rise = -R_pullup * C_line * ln(1 - V_IH / VDD)`。下降沿若由低阻导通放电，则时间常数可能完全不同。工程上看到的“同一按键按下干净、松开乱跳”，很多时候不是玄学，而是充放电路径根本不一样。
- **施密特触发器能减少阈值抖动，但不能替你完成消抖**：施密特输入通过 `V_IH` 与 `V_IL` 的迟滞窗口抑制慢边沿附近的亚稳态徘徊，可它并不会消灭真实的多次跨阈值反弹。若反弹幅度足够大，电压仍会反复越过两个阈值，于是 EXTI 依旧会多次置位。迟滞解决的是“一个边沿附近来回抖”，消抖处理的是“物理接点反复撞击”。
- **中断优先级解决的是谁先响应，不解决谁才是真的**：很多系统在首次中断里立即翻转状态变量，等于默认相信第一条边沿就是事实。这个假设只对带宽极窄、波形很干净的信号成立。对于按键、限位、继电器反馈这类低速但脏的信号，更合理的做法是把 EXTI 当作唤醒提示，把“真值判决”交给后续时间窗确认。
- **消抖时间窗不是拍脑袋的常数，而是物理与离散采样的合成下界**：若最大机械反弹时间为 `T_bounce_max`，RC 充放电到阈值所需时间为 `T_rc_th`，再预留安全裕量 `T_margin`，则确认窗至少应满足 `T_confirm >= T_bounce_max + T_rc_th + T_margin`。一旦落到定时器离散采样域，采样次数又要满足 `N = ceil(T_confirm / T_sample)`。从模拟暂态到数字判决，这里存在一层非常明确的数学映射。
- **积分式数字消抖，本质是一个带饱和的离散低通滤波器**：设原始采样值 `x[k] ∈ {0, 1}`，积分器状态 `acc[k] ∈ [0, N]`，则可构造 `acc[k+1] = clamp(acc[k] + (2*x[k] - 1), 0, N)`。当 `acc == N` 判为稳定高，当 `acc == 0` 判为稳定低。这个结构比简单的“连续若干次相同才确认”更平滑，因为它允许个别反向样本存在，但会在统计意义上压制反弹。
- **EXTI + 定时器的职责分离，本质上是一种资源调度策略**：EXTI 负责在第一时间把 CPU 从主循环或低功耗里叫醒，定时器负责在接下来的确认窗里按固定时基采样和判决。这样做避免了在中断里 `HAL_Delay()` 之类的阻塞式反模式，也避免让主循环一直高频轮询一个大部分时间都不变的引脚。
- **共享 EXTI 线意味着“屏蔽中断”必须细到线路而不是粗到整个 IRQ**：像 `EXTI15_10_IRQn` 这类共享中断向量上，多个引脚共用一个 NVIC 通道。若你在消抖期间直接 `HAL_NVIC_DisableIRQ()`，等于连同别的线一起静音。更稳妥的是只屏蔽对应 EXTI line 的 mask bit，让别的引脚照常工作。
- **不是所有边沿都应该消抖，信号类别必须和带宽假设匹配**：机械按键、拨码、限位开关适合毫秒级确认窗；故障保护脚可能只允许几十微秒确认；高速编码器 A/B 相、脉冲计数输入如果照搬按键消抖，等于主动丢边沿。所谓“中断的边界”，其实就是承认每类信号都有自己的物理带宽和误差模型。
- **真正稳健的中断系统，第一反应不是立刻改状态，而是先建立状态机**：候选边沿、确认中、确认成功、误触发回退、重新布防，这些阶段都应该有明确的状态迁移。中断不是业务逻辑入口，而是状态机的一次触发条件。把它当成事实本身，系统就会被抖动牵着走；把它当成证据的一部分，系统才会真正稳。

## 代码能力展现

下面给出一个基于 STM32 HAL 的 EXTI 消抖实现。这个示例刻意不用“中断里延时 20 ms 再读一次引脚”的偷懒写法，而是把链路拆成三层: **EXTI 抢占式捕获候选边沿、TIM 定时采样形成确认窗、积分式数字滤波输出稳定事件**。代码同时把 RC 到阈值的充放电时间、确认窗与离散样本数的映射写进注释里，方便从物理约束直接反推参数。

```c
#include "stm32f4xx_hal.h"
#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#define EDGE_DEBOUNCE_MIN_SAMPLE_US      50U
#define EDGE_DEBOUNCE_MAX_SAMPLE_US      5000U
#define EDGE_DEBOUNCE_DEFAULT_GUARD_US   200U
#define EDGE_DEBOUNCE_MAX_INTEGRATOR     255U

typedef enum
{
    EDGE_EVENT_NONE = 0,
    EDGE_EVENT_RISING,
    EDGE_EVENT_FALLING
} EdgeEventType_t;

typedef struct
{
    GPIO_TypeDef *port;
    uint16_t pin;
    TIM_HandleTypeDef *sample_timer;
    bool active_high;
    uint32_t sample_period_us;
    uint32_t max_bounce_us;
    uint32_t guard_us;
    float pull_resistor_ohm;
    float discharge_resistor_ohm;
    float line_capacitance_pf;
    float vih_ratio;
    float vil_ratio;
} EdgeDebounceConfig_t;

typedef struct
{
    bool pending;
    EdgeEventType_t type;
    uint32_t timestamp_ms;
    GPIO_PinState stable_level;
} EdgeEvent_t;

typedef struct
{
    EdgeDebounceConfig_t cfg;
    bool candidate_active;
    uint8_t integrator;
    uint8_t integrator_limit;
    uint16_t sample_counter;
    uint16_t confirm_samples;
    GPIO_PinState stable_level;
    EdgeEvent_t event;
} EdgeDebounce_t;

static uint32_t Edge_ClampU32(uint32_t value, uint32_t min_value, uint32_t max_value)
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

static uint8_t Edge_ClampU8(uint32_t value, uint8_t min_value, uint8_t max_value)
{
    if (value < min_value)
    {
        return min_value;
    }

    if (value > max_value)
    {
        return max_value;
    }

    return (uint8_t)value;
}

static float Edge_ClampFloat(float value, float min_value, float max_value)
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

static uint32_t Edge_CeilDivU32(uint32_t numerator, uint32_t denominator)
{
    return (numerator + denominator - 1U) / denominator;
}

static void Edge_MaskExtiLine(uint16_t pin, bool masked)
{
    if (masked)
    {
        EXTI->IMR &= ~(uint32_t)pin;
    }
    else
    {
        EXTI->IMR |= (uint32_t)pin;
    }
}

static GPIO_PinState Edge_ReadRawLevel(const EdgeDebounce_t *debounce)
{
    return HAL_GPIO_ReadPin(debounce->cfg.port, debounce->cfg.pin);
}

/**
 * @brief 估算 RC 上升沿跨过高阈值所需的最短时间。
 * @param pull_resistor_ohm 上拉电阻，单位 Ohm。
 * @param line_capacitance_pf 线缆与输入等效电容，单位 pF。
 * @param vih_ratio 高阈值相对 VDD 的比例，例如 0.7 表示 V_IH = 0.7 * VDD。
 * @retval 跨阈值所需时间，单位 us。
 *
 * @note 充电公式:
 *       V(t) = VDD * (1 - exp(-t / (R * C)))
 *       当 V(t) = V_IH = vih_ratio * VDD 时:
 *       t_rise = -R * C * ln(1 - vih_ratio)
 *       这是边沿被 EXTI “看见”之前至少要经历的模拟时间。
 */
static uint32_t Edge_ComputeRiseThresholdUs(float pull_resistor_ohm,
                                            float line_capacitance_pf,
                                            float vih_ratio)
{
    const float capacitance_f = Edge_ClampFloat(line_capacitance_pf, 1.0f, 1.0e9f) * 1.0e-12f;
    const float tau_s = Edge_ClampFloat(pull_resistor_ohm, 1.0f, 1.0e9f) * capacitance_f;
    const float ratio = Edge_ClampFloat(vih_ratio, 0.05f, 0.95f);
    const float time_s = -tau_s * logf(1.0f - ratio);

    return (uint32_t)lroundf(time_s * 1.0e6f);
}

/**
 * @brief 估算 RC 下降沿跌破低阈值所需的最短时间。
 * @param discharge_resistor_ohm 放电等效电阻，单位 Ohm。
 * @param line_capacitance_pf 线缆与输入等效电容，单位 pF。
 * @param vil_ratio 低阈值相对 VDD 的比例，例如 0.3 表示 V_IL = 0.3 * VDD。
 * @retval 跌破阈值所需时间，单位 us。
 *
 * @note 放电公式:
 *       V(t) = VDD * exp(-t / (R * C))
 *       当 V(t) = V_IL = vil_ratio * VDD 时:
 *       t_fall = -R * C * ln(vil_ratio)
 */
static uint32_t Edge_ComputeFallThresholdUs(float discharge_resistor_ohm,
                                            float line_capacitance_pf,
                                            float vil_ratio)
{
    const float capacitance_f = Edge_ClampFloat(line_capacitance_pf, 1.0f, 1.0e9f) * 1.0e-12f;
    const float tau_s = Edge_ClampFloat(discharge_resistor_ohm, 1.0f, 1.0e9f) * capacitance_f;
    const float ratio = Edge_ClampFloat(vil_ratio, 0.05f, 0.95f);
    const float time_s = -tau_s * logf(ratio);

    return (uint32_t)lroundf(time_s * 1.0e6f);
}

/**
 * @brief 根据机械反弹与 RC 过阈时间，计算建议确认窗。
 * @param cfg 消抖配置。
 * @retval 建议确认窗，单位 us。
 *
 * @note 至少满足:
 *       T_confirm >= T_bounce_max + max(T_rise_to_VIH, T_fall_to_VIL) + T_guard
 *       这样既覆盖机械反弹，也覆盖慢边沿跨阈值的模拟延迟。
 */
static uint32_t Edge_ComputeConfirmWindowUs(const EdgeDebounceConfig_t *cfg)
{
    const uint32_t rise_us =
        Edge_ComputeRiseThresholdUs(cfg->pull_resistor_ohm, cfg->line_capacitance_pf, cfg->vih_ratio);
    const uint32_t fall_us =
        Edge_ComputeFallThresholdUs(cfg->discharge_resistor_ohm, cfg->line_capacitance_pf, cfg->vil_ratio);
    const uint32_t rc_us = (rise_us >= fall_us) ? rise_us : fall_us;

    return cfg->max_bounce_us + rc_us + cfg->guard_us;
}

/**
 * @brief 初始化 EXTI + 定时器协同消抖器。
 * @param debounce 消抖状态句柄。
 * @param cfg 消抖参数。
 *
 * @note 离散积分器上限使用:
 *       N = ceil(T_confirm / T_sample)
 *       积分器状态 acc ∈ [0, N]
 *       acc[k + 1] = clamp(acc[k] + (2*x[k] - 1), 0, N)
 *       当 acc == N 判为稳定高，当 acc == 0 判为稳定低。
 */
void EdgeDebounce_Init(EdgeDebounce_t *debounce, const EdgeDebounceConfig_t *cfg)
{
    const uint32_t confirm_window_us = Edge_ComputeConfirmWindowUs(cfg);
    const uint32_t sample_period_us =
        Edge_ClampU32(cfg->sample_period_us, EDGE_DEBOUNCE_MIN_SAMPLE_US, EDGE_DEBOUNCE_MAX_SAMPLE_US);
    const uint32_t required_samples = Edge_CeilDivU32(confirm_window_us, sample_period_us);

    if ((debounce == NULL) || (cfg == NULL))
    {
        return;
    }

    memset(debounce, 0, sizeof(*debounce));
    debounce->cfg = *cfg;
    debounce->cfg.sample_period_us = sample_period_us;
    debounce->cfg.guard_us = (cfg->guard_us == 0U) ? EDGE_DEBOUNCE_DEFAULT_GUARD_US : cfg->guard_us;
    debounce->confirm_samples = (uint16_t)Edge_ClampU32(required_samples, 1U, EDGE_DEBOUNCE_MAX_INTEGRATOR);
    debounce->integrator_limit = Edge_ClampU8(debounce->confirm_samples, 1U, EDGE_DEBOUNCE_MAX_INTEGRATOR);
    debounce->stable_level = Edge_ReadRawLevel(debounce);
    debounce->integrator = (debounce->stable_level == GPIO_PIN_SET) ? debounce->integrator_limit : 0U;
}

/**
 * @brief 在 EXTI 回调里登记候选边沿，并启动定时确认窗。
 * @param debounce 消抖状态句柄。
 * @param gpio_pin 本次中断上报的 GPIO pin mask。
 *
 * @note 这里故意不在 EXTI 里直接改业务状态，而是把 EXTI 当作“候选边沿出现”的
 *       抢占式提示。真正的稳定判决留给后续定时采样完成。
 */
void EdgeDebounce_OnExti(EdgeDebounce_t *debounce, uint16_t gpio_pin)
{
    if ((debounce == NULL) || (gpio_pin != debounce->cfg.pin))
    {
        return;
    }

    if (debounce->candidate_active)
    {
        return;
    }

    debounce->candidate_active = true;
    debounce->sample_counter = 0U;

    /* 共享 EXTI IRQ 时，只屏蔽当前线路，避免误伤同一向量下的其他输入。 */
    Edge_MaskExtiLine(debounce->cfg.pin, true);

    __HAL_TIM_SET_COUNTER(debounce->cfg.sample_timer, 0U);
    HAL_TIM_Base_Start_IT(debounce->cfg.sample_timer);
}

/**
 * @brief 在定时器采样中断里推进积分式数字消抖。
 * @param debounce 消抖状态句柄。
 *
 * @note 每次采样读取当前原始电平 x[k]:
 *       x[k] = 1 -> acc 增 1
 *       x[k] = 0 -> acc 减 1
 *       acc 在 [0, N] 内饱和限幅
 *       这样做的直觉是：稳定高样本持续“充电”，稳定低样本持续“放电”，
 *       零星反弹只能短暂拉回积分器，无法轻易推翻整体趋势。
 */
void EdgeDebounce_OnSampleTick(EdgeDebounce_t *debounce)
{
    GPIO_PinState raw_level;
    GPIO_PinState new_stable_level;
    bool decision_ready = false;

    if ((debounce == NULL) || (!debounce->candidate_active))
    {
        return;
    }

    raw_level = Edge_ReadRawLevel(debounce);
    debounce->sample_counter++;

    if (raw_level == GPIO_PIN_SET)
    {
        if (debounce->integrator < debounce->integrator_limit)
        {
            debounce->integrator++;
        }
    }
    else
    {
        if (debounce->integrator > 0U)
        {
            debounce->integrator--;
        }
    }

    if ((debounce->integrator == 0U) || (debounce->integrator == debounce->integrator_limit))
    {
        decision_ready = true;
    }
    else if (debounce->sample_counter >= debounce->confirm_samples)
    {
        decision_ready = true;
    }

    if (!decision_ready)
    {
        return;
    }

    if (debounce->integrator == debounce->integrator_limit)
    {
        new_stable_level = GPIO_PIN_SET;
    }
    else if (debounce->integrator == 0U)
    {
        new_stable_level = GPIO_PIN_RESET;
    }
    else
    {
        /* 超时但尚未顶到上下轨时，用当前原始电平作最终裁决。
         * 这比无条件保持旧状态更合理，因为确认窗本身已经覆盖了
         * T_bounce_max + T_rc_th + margin，说明残余不确定性已经足够小。
         */
        new_stable_level = raw_level;
    }

    HAL_TIM_Base_Stop_IT(debounce->cfg.sample_timer);
    debounce->candidate_active = false;

    if (new_stable_level != debounce->stable_level)
    {
        debounce->stable_level = new_stable_level;
        debounce->event.pending = true;
        debounce->event.type = (new_stable_level == GPIO_PIN_SET) ? EDGE_EVENT_RISING : EDGE_EVENT_FALLING;
        debounce->event.timestamp_ms = HAL_GetTick();
        debounce->event.stable_level = new_stable_level;
    }

    debounce->integrator = (debounce->stable_level == GPIO_PIN_SET) ? debounce->integrator_limit : 0U;
    Edge_MaskExtiLine(debounce->cfg.pin, false);
}

/**
 * @brief 读取一次稳定边沿事件。
 * @param debounce 消抖状态句柄。
 * @param out_event 输出事件。
 * @retval true  取到了新事件。
 * @retval false 当前没有待处理事件。
 */
bool EdgeDebounce_PopEvent(EdgeDebounce_t *debounce, EdgeEvent_t *out_event)
{
    if ((debounce == NULL) || (out_event == NULL) || (!debounce->event.pending))
    {
        return false;
    }

    *out_event = debounce->event;
    debounce->event.pending = false;
    debounce->event.type = EDGE_EVENT_NONE;
    return true;
}

static EdgeDebounce_t g_limit_switch_debounce;

void App_LimitSwitchDebounceInit(TIM_HandleTypeDef *htim6)
{
    const EdgeDebounceConfig_t cfg =
    {
        .port = GPIOC,
        .pin = GPIO_PIN_13,
        .sample_timer = htim6,
        .active_high = false,
        .sample_period_us = 250U,
        .max_bounce_us = 3500U,
        .guard_us = 300U,
        .pull_resistor_ohm = 10000.0f,
        .discharge_resistor_ohm = 150.0f,
        .line_capacitance_pf = 2200.0f,
        .vih_ratio = 0.70f,
        .vil_ratio = 0.30f
    };

    EdgeDebounce_Init(&g_limit_switch_debounce, &cfg);
}

void HAL_GPIO_EXTI_Callback(uint16_t GPIO_Pin)
{
    EdgeDebounce_OnExti(&g_limit_switch_debounce, GPIO_Pin);
}

void HAL_TIM_PeriodElapsedCallback(TIM_HandleTypeDef *htim)
{
    if (htim == g_limit_switch_debounce.cfg.sample_timer)
    {
        EdgeDebounce_OnSampleTick(&g_limit_switch_debounce);
    }
}

void App_PollLimitSwitchEvent(void)
{
    EdgeEvent_t event;

    if (!EdgeDebounce_PopEvent(&g_limit_switch_debounce, &event))
    {
        return;
    }

    if (event.type == EDGE_EVENT_FALLING)
    {
        /* 例: 低有效限位开关被确认按下，执行安全停机。 */
    }
    else if (event.type == EDGE_EVENT_RISING)
    {
        /* 例: 限位解除，允许状态机进入重新布防阶段。 */
    }
}
```

这段代码真正要表达的是一种分工哲学：**EXTI 负责抓住“系统可能有事发生了”的第一拍，定时器负责在自己的时基里判断“它到底是不是真的”，状态机负责决定“接下来业务该怎么走”**。中断一旦越过了这条边界，直接扛起真值判决与业务状态修改，就会被物理世界的抖动拖着跑。把边沿当成证据、把确认窗当成审判过程、把稳定事件当成最终输出，硬件中断才真正从“能响”升级成“可信”。
