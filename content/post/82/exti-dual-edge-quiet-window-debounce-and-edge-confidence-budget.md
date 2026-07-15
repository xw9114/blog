---
title: "技能档案：EXTI 双沿触发的静默窗消抖与边沿可信度预算"
slug: "skill-exti-dual-edge-quiet-window-debounce-and-edge-confidence-budget"
date: 2026-07-06T09:05:11+08:00
draft: false
description: "从阈值穿越抖动、机械触点反弹、同步器重采样，到 EXTI 挂起位折叠与定时器静默窗确认，系统拆解硬件中断为什么经常错把噪声当事件。"
tags: ["STM32", "EXTI", "中断", "消抖", "边沿检测", "定时器", "实时系统"]
categories: ["技能档案", "嵌入式系统"]
image: ""
---

## 技能概述
按钮、限位开关、霍尔、光耦、干簧管、继电器告警这类输入，表面上只是“来一个边沿，进一次中断”；真正的工程痛点却在于，**物理世界给出的不是理想阶跃，而是一段带有噪声、回弹、传播延迟与阈值不确定性的过渡过程**。如果系统没有把“原始边沿”“稳定状态”“中断负载”和“可接受延迟”分层处理，软件就会在抖动风暴里把一次事件记成多次，把窄脉冲当成稳定电平，或者在高负载时因为挂起位折叠而误以为中断没丢。这个主题真正解决的，不是“按钮怎么消抖”这种 API 问题，而是如何把**模拟边界 -> 数字采样 -> 时间确认 -> 事件入队**这条链路重新做成一份可信的物理映射。

## 核心底层概念解析

- **边沿不是数学上的瞬时点，而是信号穿越阈值的一段时间带**：输入比较器看到的是电压是否越过门限 `Vth`，而不是“波形应该已经变了”。如果阈值附近噪声幅值为 `DeltaV_noise`，过零斜率为 `|dV/dt|`，那么时间抖动近似满足  
  `Delta t_jitter ~= DeltaV_noise / |dV/dt|`。  
  这就是为什么长线、弱上拉、慢边沿和高阻输入，哪怕示波器上“看起来已经翻转”，中断时间戳仍然会漂。

- **机械抖动不是随机误码，而是一个欠阻尼接触系统在门限附近来回穿越**：按键、继电器、簧片、限位开关的触点接通时并不会一次性稳定，常见现象是几百微秒到数毫秒的多次反弹。对 MCU 而言，这不是一个状态，而是一串合法的上升/下降沿。如果你直接双沿触发 EXTI，硬件会很诚实地把这一串门限穿越都当成事件。

- **同步器的职责不是“修复异步信号”，而是把异步世界折算进内核时钟**：GPIO 输入进 EXTI 前，通常会经过同步器或边沿检测逻辑。任何窄于若干个内核/外设时钟周期的脉冲，都可能被漏采、压缩或在亚稳态恢复后体现为额外相位抖动。对软件来说，必须接受一个事实：**中断看到的是被重采样后的数字事件，不是原始模拟波形本体**。

- **双沿触发不等于得到了完整波形**：很多 STM32 EXTI 线路只有“挂起位 + ISR”这套语义。若同一线路在 ISR 被屏蔽或 CPU 忙于更高优先级中断期间发生多次翻转，这些边沿可能会被折叠成“一次待处理”。因此 EXTI 适合做“状态变化通知”，不适合高频精密计边。真正要测脉宽、频率、相位，应该交给 **定时器输入捕获 / 编码器模式 / DMA 快照**。

- **消抖的本质不是延时，而是等待信号进入静默窗**：最粗暴的 `delay_ms(20)` 本质上是在赌“20 ms 后一定稳定”。更合理的表述是：只有当最后一次原始边沿之后已经安静了 `Tquiet`，当前电平仍然保持候选状态，我们才承认这次状态翻转成立。于是消抖约束可以写成  
  `Tquiet >= Tbounce_max + Tsync + Tmargin`。  
  这里 `Tbounce_max` 是物理反弹上界，`Tsync` 是同步器/采样折算延迟，`Tmargin` 是软件与时钟量化冗余。

- **RC + 施密特是模拟域消抖，软件静默窗是时间域判决，它们解决的不是同一层问题**：RC 低通会把高频毛刺积分掉，但同时引入额外相位延迟。对一阶上升沿，门限到达时间近似为  
  `t_rise_to_vth ~= -tau * ln(1 - Vth / Vstep)`。  
  `tau` 过大时，原本合法的窄脉冲会被抹平；`tau` 过小时，毛刺仍会穿越阈值。硬件滤波负责减轻比较器前端压力，软件判决负责定义“什么叫稳定事件”，两者不能互相替代。

- **中断边界首先是资源调度边界**：如果原始边沿到达频率为 `f_raw`，EXTI ISR 平均执行时间为 `t_isr`，那么单条输入线对 CPU 的占用率近似  
  `rho_raw = f_raw * t_isr`。  
  只要抖动把 `f_raw` 顶高两个数量级，原本微不足道的 ISR 就会突然占满实时预算。所以 ISR 里最应该做的事是**时间戳、记账、重装定时器、退出**，而不是立刻执行业务逻辑。

- **静默窗策略天然不适合“真实窄脉冲”测量**：如果一个脉冲的高电平宽度 `Tpulse_high` 小于 `Tquiet`，那么在静默窗确认时它已经回落，软件只能得出“这不是稳定状态变化”的结论。于是系统边界可以显式写成  
  `Tpulse_min_trust > Tquiet + Tirq_block + Tsample_quantization`。  
  换句话说，静默窗消抖是为开关量状态变化设计的，不是为高速事件计数设计的。

- **时间戳要分“第一次看到”和“最终确认”两层语义**：第一次 raw edge 的时间戳更接近真实物理触发，最终 stable edge 的时间戳更适合驱动状态机。前者用于调试和误差回放，后者用于业务逻辑。把这两者混成一个 `button_pressed_time`，后面做长按、双击、限位保护时一定会被语义反噬。

- **真正靠谱的系统会把“中断”降级成“候选事件生产者”**：候选边沿只负责告诉系统“物理世界可能发生了变化”，是否接受、何时接受、是否入队，要由后面的时间窗与状态机裁决。中断不是事实本身，中断只是事实的嫌疑人列表。

## 代码能力展现

下面给出一段基于 **STM32 HAL** 的“EXTI 双沿 + 定时器静默窗确认 + 事件队列”实现。它刻意把整条链路拆成四层：

- `HAL_GPIO_EXTI_Callback()` 只记录 **原始边沿** 与 **候选电平**；
- `TIM6` 一次性定时器负责等待 **静默窗**，每次新 raw edge 到来都会重新装填；
- 到窗结束后再次读取 GPIO，确认候选电平是否真的稳定；
- 最终只把**稳定边沿事件**压入环形队列，业务层在主循环里再消费。

这段代码专门服务于“开关量状态变化”，而不是脉宽测量。若你的需求是测速、脉宽、PWM 捕获或编码器计数，请直接上定时器输入捕获，而不是试图把 EXTI 用成示波器。

```c
#include "main.h"

#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#define EDGE_QUEUE_CAPACITY                8U
#define EDGE_TIMEBASE_MIN_HZ               1000U
#define EDGE_TIMEBASE_MAX_HZ               100000000U
#define EDGE_GUARD_TIMER_MIN_HZ            1000U
#define EDGE_GUARD_TIMER_MAX_HZ            10000000U
#define EDGE_DEBOUNCE_MIN_US               20U
#define EDGE_DEBOUNCE_MAX_US               50000U
#define EDGE_MIN_REARM_US                  20U

typedef struct
{
    uint32_t raw_tick;
    uint32_t stable_tick;
    uint8_t level;
} EdgeEvent_t;

typedef struct
{
    EdgeEvent_t items[EDGE_QUEUE_CAPACITY];
    uint8_t head;
    uint8_t tail;
    uint8_t count;
    uint32_t overflow_count;
} EdgeQueue_t;

typedef struct
{
    GPIO_TypeDef *port;
    uint16_t pin;
    TIM_HandleTypeDef *htim_guard;
    TIM_HandleTypeDef *htim_timebase;
    uint32_t timebase_hz;
    uint32_t guard_timer_hz;
    uint32_t max_bounce_us;
    uint32_t sync_margin_us;
    uint32_t service_margin_us;
    uint32_t min_rearm_us;
    uint8_t active_high;
} EdgeDebounceConfig_t;

typedef struct
{
    EdgeDebounceConfig_t cfg;
    EdgeQueue_t queue;
    uint32_t quiet_window_ticks;
    uint32_t first_raw_tick;
    uint32_t last_raw_tick;
    uint32_t last_stable_tick;
    uint32_t raw_edge_count;
    uint32_t accepted_edge_count;
    uint32_t rejected_bounce_count;
    uint32_t collapsed_raw_count;
    uint8_t stable_level;
    uint8_t candidate_level;
    uint8_t timer_armed;
    uint8_t ready;
} EdgeDebounce_t;

extern TIM_HandleTypeDef htim2;   /* 1 MHz 自由运行时间戳 */
extern TIM_HandleTypeDef htim6;   /* 消抖静默窗一次性定时器 */

static EdgeDebounce_t g_limit_sw =
{
    .cfg =
    {
        .port = GPIOB,
        .pin = GPIO_PIN_12,
        .htim_guard = &htim6,
        .htim_timebase = &htim2,
        .timebase_hz = 1000000U,
        .guard_timer_hz = 1000000U,
        .max_bounce_us = 3000U,
        .sync_margin_us = 20U,
        .service_margin_us = 80U,
        .min_rearm_us = 150U,
        .active_high = 1U
    }
};

static uint32_t EdgeDebounce_ClampU32(uint32_t value, uint32_t min_value, uint32_t max_value)
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

static uint8_t EdgeDebounce_ReadLogicalLevel(const EdgeDebounceConfig_t *cfg)
{
    const GPIO_PinState pin_state = HAL_GPIO_ReadPin(cfg->port, cfg->pin);
    const uint8_t raw_level = (pin_state == GPIO_PIN_SET) ? 1U : 0U;

    return (cfg->active_high != 0U) ? raw_level : (uint8_t)(1U - raw_level);
}

static uint32_t EdgeDebounce_TimeDeltaTicks(uint32_t now_tick, uint32_t prev_tick)
{
    /* 自由运行计数器使用无符号减法，自然兼容 32 位回绕。 */
    return (now_tick - prev_tick);
}

static uint32_t EdgeDebounce_MicrosecondsToTicks(uint32_t time_us, uint32_t tick_hz)
{
    uint64_t ticks = ((uint64_t)time_us * (uint64_t)tick_hz + 999999ULL) / 1000000ULL;

    if (ticks == 0ULL)
    {
        ticks = 1ULL;
    }

    if (ticks > 0xFFFFFFFFULL)
    {
        ticks = 0xFFFFFFFFULL;
    }

    return (uint32_t)ticks;
}

/**
 * @brief 将物理反弹上界映射成静默窗 tick 数。
 * @param cfg 消抖配置。
 * @retval 静默窗对应的守护定时器 tick。
 *
 * @note 这里使用的时间预算公式是：
 *       Tquiet >= Tbounce_max + Tsync + Tservice_margin
 *
 *       其中：
 *       1. Tbounce_max      代表触点/光耦/干簧管等前端的最坏反弹持续时间；
 *       2. Tsync            代表异步输入经同步器、阈值抖动折算后的保守余量；
 *       3. Tservice_margin  代表 ISR 进入抖动、定时器重装量化、软件路径冗余。
 *
 *       最终守护定时器装载值满足：
 *       quiet_window_ticks = ceil(Tquiet * f_guard)
 */
static uint32_t EdgeDebounce_ComputeQuietWindowTicks(const EdgeDebounceConfig_t *cfg)
{
    const uint32_t timebase_hz =
        EdgeDebounce_ClampU32(cfg->timebase_hz, EDGE_TIMEBASE_MIN_HZ, EDGE_TIMEBASE_MAX_HZ);
    const uint32_t guard_hz =
        EdgeDebounce_ClampU32(cfg->guard_timer_hz, EDGE_GUARD_TIMER_MIN_HZ, EDGE_GUARD_TIMER_MAX_HZ);
    const uint32_t bounce_us =
        EdgeDebounce_ClampU32(cfg->max_bounce_us, EDGE_DEBOUNCE_MIN_US, EDGE_DEBOUNCE_MAX_US);
    const uint32_t sync_margin_us = EdgeDebounce_ClampU32(cfg->sync_margin_us, 0U, 5000U);
    const uint32_t service_margin_us = EdgeDebounce_ClampU32(cfg->service_margin_us, 0U, 5000U);
    const uint32_t quiet_window_us = bounce_us + sync_margin_us + service_margin_us;

    (void)timebase_hz; /* 保留 timebase 审计，强调时间戳时钟与守护时钟应显式检查。 */
    return EdgeDebounce_MicrosecondsToTicks(quiet_window_us, guard_hz);
}

static bool EdgeQueue_Push(EdgeQueue_t *queue, const EdgeEvent_t *event)
{
    if ((queue == NULL) || (event == NULL))
    {
        return false;
    }

    if (queue->count >= EDGE_QUEUE_CAPACITY)
    {
        queue->overflow_count++;
        return false;
    }

    queue->items[queue->head] = *event;
    queue->head = (uint8_t)((queue->head + 1U) % EDGE_QUEUE_CAPACITY);
    queue->count++;
    return true;
}

bool EdgeQueue_Pop(EdgeQueue_t *queue, EdgeEvent_t *event)
{
    if ((queue == NULL) || (event == NULL) || (queue->count == 0U))
    {
        return false;
    }

    *event = queue->items[queue->tail];
    queue->tail = (uint8_t)((queue->tail + 1U) % EDGE_QUEUE_CAPACITY);
    queue->count--;
    return true;
}

/**
 * @brief 重装一次性守护定时器，使其从“最后一次 raw edge”开始重新等待静默窗。
 * @param debounce 消抖器实例。
 *
 * @note 每出现一个新的 raw edge，之前的“快要稳定了”假设就作废，
 *       因此必须重新从零开始等待 Tquiet。
 *       这等价于在时间域里寻找：
 *       stable_edge = arg min t , subject to no raw edge in [t - Tquiet, t]
 */
static void EdgeDebounce_RestartGuardTimer(EdgeDebounce_t *debounce)
{
    TIM_HandleTypeDef *htim = debounce->cfg.htim_guard;
    uint32_t period_ticks = debounce->quiet_window_ticks;

    if (period_ticks == 0U)
    {
        period_ticks = 1U;
    }

    __HAL_TIM_DISABLE(htim);
    __HAL_TIM_SET_COUNTER(htim, 0U);
    __HAL_TIM_SET_AUTORELOAD(htim, period_ticks - 1U);
    __HAL_TIM_CLEAR_FLAG(htim, TIM_FLAG_UPDATE);
    __HAL_TIM_ENABLE_IT(htim, TIM_IT_UPDATE);
    __HAL_TIM_ENABLE(htim);

    debounce->timer_armed = 1U;
}

/**
 * @brief 初始化消抖器，并锁定初始稳定状态。
 * @param debounce 消抖器实例。
 * @retval true 初始化成功；false 初始化失败。
 *
 * @note 业务系统应在启动期显式读取一次当前逻辑电平，把它作为 stable state。
 *       否则第一批中断进来时，软件无法区分“真实翻转”与“上电默认值未知”。
 */
bool EdgeDebounce_Init(EdgeDebounce_t *debounce)
{
    if ((debounce == NULL) ||
        (debounce->cfg.port == NULL) ||
        (debounce->cfg.htim_guard == NULL) ||
        (debounce->cfg.htim_timebase == NULL))
    {
        return false;
    }

    memset(&debounce->queue, 0, sizeof(debounce->queue));
    debounce->quiet_window_ticks = EdgeDebounce_ComputeQuietWindowTicks(&debounce->cfg);
    debounce->stable_level = EdgeDebounce_ReadLogicalLevel(&debounce->cfg);
    debounce->candidate_level = debounce->stable_level;
    debounce->first_raw_tick = __HAL_TIM_GET_COUNTER(debounce->cfg.htim_timebase);
    debounce->last_raw_tick = debounce->first_raw_tick;
    debounce->last_stable_tick = debounce->first_raw_tick;
    debounce->raw_edge_count = 0U;
    debounce->accepted_edge_count = 0U;
    debounce->rejected_bounce_count = 0U;
    debounce->collapsed_raw_count = 0U;
    debounce->timer_armed = 0U;
    debounce->ready = 1U;
    return true;
}

/**
 * @brief 在 EXTI 原始边沿到来时记账，并重启静默窗。
 * @param debounce 消抖器实例。
 *
 * @note ISR 中只做 O(1) 工作：时间戳、读取当前 GPIO、重装定时器。
 *       这是因为原始边沿洪峰负载近似满足：
 *       rho_raw = f_raw * t_exti_isr
 *
 *       若在此处直接执行业务逻辑，抖动期间 f_raw 会急剧上升，
 *       最终让 CPU 在假事件上耗尽实时预算。
 */
static void EdgeDebounce_OnRawEdge(EdgeDebounce_t *debounce)
{
    const uint32_t now_tick = __HAL_TIM_GET_COUNTER(debounce->cfg.htim_timebase);
    const uint8_t level = EdgeDebounce_ReadLogicalLevel(&debounce->cfg);

    if (debounce->ready == 0U)
    {
        return;
    }

    if (debounce->timer_armed == 0U)
    {
        debounce->first_raw_tick = now_tick;
    }
    else
    {
        /* 定时器已在等待静默窗，说明当前边沿属于同一串反弹/毛刺风暴。 */
        debounce->collapsed_raw_count++;
    }

    debounce->raw_edge_count++;
    debounce->candidate_level = level;
    debounce->last_raw_tick = now_tick;

    EdgeDebounce_RestartGuardTimer(debounce);
}

/**
 * @brief 在静默窗结束时确认候选电平是否已稳定。
 * @param debounce 消抖器实例。
 *
 * @note 只有满足以下条件时才接受一次稳定边沿：
 *       1. 从最后一次 raw edge 到现在，确实已经过去了一个完整静默窗；
 *       2. 当前 GPIO 电平仍然等于候选电平；
 *       3. 候选电平与 stable_level 不同；
 *       4. 距离上一次稳定边沿至少经过 Tmin_rearm。
 *
 *       其中最小再武装时间的物理意义是：
 *       Tpulse_min_trust > Tquiet + Tmin_rearm
 *
 *       若真实应用要求捕获更窄的合法脉冲，就不应继续使用这套
 *       “等待静默 -> 认定状态变化”的开关量语义，而应切换到输入捕获方案。
 */
static void EdgeDebounce_OnQuietWindowExpired(EdgeDebounce_t *debounce)
{
    EdgeEvent_t event;
    const uint32_t now_tick = __HAL_TIM_GET_COUNTER(debounce->cfg.htim_timebase);
    const uint32_t elapsed_since_raw = EdgeDebounce_TimeDeltaTicks(now_tick, debounce->last_raw_tick);
    const uint32_t elapsed_since_stable = EdgeDebounce_TimeDeltaTicks(now_tick, debounce->last_stable_tick);
    const uint32_t min_rearm_ticks =
        EdgeDebounce_MicrosecondsToTicks(
            EdgeDebounce_ClampU32(debounce->cfg.min_rearm_us, EDGE_MIN_REARM_US, EDGE_DEBOUNCE_MAX_US),
            debounce->cfg.timebase_hz);
    const uint8_t level_now = EdgeDebounce_ReadLogicalLevel(&debounce->cfg);

    debounce->timer_armed = 0U;
    __HAL_TIM_DISABLE_IT(debounce->cfg.htim_guard, TIM_IT_UPDATE);
    __HAL_TIM_DISABLE(debounce->cfg.htim_guard);

    /* 若由于更高优先级中断阻塞，导致守护定时器虽然触发但静默窗尚未真正走满，
     * 则重新等待，不提前承认稳定。 */
    if (elapsed_since_raw < debounce->quiet_window_ticks)
    {
        EdgeDebounce_RestartGuardTimer(debounce);
        return;
    }

    /* 当前电平已经偏离候选电平，说明这不是稳定翻转，而是一次原始抖动串。 */
    if (level_now != debounce->candidate_level)
    {
        debounce->rejected_bounce_count++;
        return;
    }

    /* 候选电平与现有 stable state 相同，代表这一串原始边沿最终又弹回原位。 */
    if (level_now == debounce->stable_level)
    {
        debounce->rejected_bounce_count++;
        return;
    }

    /* 对连续窄脉冲增加再武装门槛，避免把 EMI 毛刺串解释成多个有效动作。 */
    if (elapsed_since_stable < min_rearm_ticks)
    {
        debounce->rejected_bounce_count++;
        return;
    }

    debounce->stable_level = level_now;
    debounce->last_stable_tick = now_tick;
    debounce->accepted_edge_count++;

    event.raw_tick = debounce->first_raw_tick;
    event.stable_tick = now_tick;
    event.level = level_now;

    (void)EdgeQueue_Push(&debounce->queue, &event);
}

/**
 * @brief 供 HAL EXTI 回调调用的原始边沿入口。
 * @param gpio_pin 触发回调的 GPIO pin。
 */
void EdgeDebounce_ExtiIrqHandler(uint16_t gpio_pin)
{
    if (gpio_pin == g_limit_sw.cfg.pin)
    {
        EdgeDebounce_OnRawEdge(&g_limit_sw);
    }
}

/**
 * @brief 供 HAL 定时器更新回调调用的静默窗确认入口。
 * @param htim 发生更新中断的定时器句柄。
 */
void EdgeDebounce_TimerIrqHandler(TIM_HandleTypeDef *htim)
{
    if (htim == g_limit_sw.cfg.htim_guard)
    {
        EdgeDebounce_OnQuietWindowExpired(&g_limit_sw);
    }
}

void HAL_GPIO_EXTI_Callback(uint16_t GPIO_Pin)
{
    EdgeDebounce_ExtiIrqHandler(GPIO_Pin);
}

void HAL_TIM_PeriodElapsedCallback(TIM_HandleTypeDef *htim)
{
    EdgeDebounce_TimerIrqHandler(htim);
}

void Application_InputInit(void)
{
    if (!EdgeDebounce_Init(&g_limit_sw))
    {
        Error_Handler();
    }
}

void Application_InputTask(void)
{
    EdgeEvent_t event;

    while (EdgeQueue_Pop(&g_limit_sw.queue, &event))
    {
        /* 这里开始才进入业务语义：
         * raw_tick    更接近第一次物理触发，用于调试/回放；
         * stable_tick 更接近系统确认时刻，用于状态机。
         */
        if (event.level != 0U)
        {
            LimitSwitch_OnPressed(event.raw_tick, event.stable_tick);
        }
        else
        {
            LimitSwitch_OnReleased(event.raw_tick, event.stable_tick);
        }
    }
}
```

这段实现里，有几个工程上很重要、但常被“按钮消抖模板代码”掩盖掉的点：

- 它没有在 EXTI ISR 里直接执行业务逻辑，而是坚持 **原始边沿 -> 静默窗确认 -> 事件入队** 的分层；
- 它同时保留 `raw_tick` 和 `stable_tick` 两种时间语义，避免后续长按/双击/保护逻辑把“物理首次触发”和“软件确认完成”混为一谈；
- 它把 `Tquiet` 写成了可审计的预算，而不是神秘的 `delay_ms(20)`；
- 它明确承认：**这套方案只适合状态变化，不适合真实窄脉冲计数**。

如果你在项目里已经遇到“开关量偶发双触发”“高负载时偶尔丢限位”“EMI 一来状态机乱跳”这类问题，第一优先级不是再加一层 if，而是先回到这条物理链路：边沿够不够陡？RC 和施密特是否合适？EXTI 只做了候选事件生产吗？静默窗是否基于最坏反弹时间做过预算？只有这些边界先被说清，中断才是实时系统里的契约，而不是噪声进入软件世界的快捷通道。
