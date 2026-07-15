---
title: "技能档案：TB6612FNG 续流路径、快慢衰减与换向回灌保护"
slug: "skill-tb6612-current-decay-recirculation-and-regenerative-clamp"
date: 2026-06-30T10:59:32+08:00
draft: false
description: "从 H 桥续流路径、快慢衰减、电感电流斜率到母线回灌与换向死区保护，系统拆解 TB6612FNG 的真正难点为什么从来不在 PWM 能不能转。"
tags: ["STM32", "TB6612FNG", "直流电机", "H桥", "续流", "回灌保护"]
categories: ["技能档案", "电机控制"]
image: ""
---

## 技能概述

`TB6612FNG` 常被当成“比 `L298N` 更省电的直流电机驱动板”一笔带过，但真正把小车、云台或双轮底盘做稳之后，工程师最先撞上的痛点往往不是“转不转”，而是**减速时电流往哪儿走、换向时旧电流多久肯归零、刹车能量回到母线后电源能不能接得住**。这个主题解决的，不是 `AIN1/AIN2/PWMA` 的真值表记忆题，而是把电机绕组的电感、电枢反电动势、H 桥续流路径、母线电容和 `STM32` 的时序调度串成一份完整的能量契约，看清楚为什么同样一颗 `TB6612FNG`，有人觉得它“很好用”，有人却总在急停、反转和电池掉电边界上翻车。

## 核心底层概念解析

- **电机首先不是负载电阻，而是一只带反电动势的电感**：对一相直流电机，最基本的电压平衡就是  
  `V_ab = L * di/dt + R * i + K_e * omega`。  
  这里 `i` 不能突变，意味着你把桥臂状态从驱动切到关断时，电流不会“听话地归零”，它只会沿着**当下唯一导通的续流路径**继续找出口。

- **`TB6612FNG` 的模式切换，本质上是在切换电流出口**：同一条绕组电流，在正转驱动、短刹车、停止高阻三种状态下，看到的是完全不同的端电压边界。驱动阶段是“你给它多少母线电压”；刹车阶段是“你把电机两端短在一起，让它自己耗散”；高阻阶段则是“你把桥臂松开，让电流去二极管和母线里找路”。

- **`PWMA` 直接做占空比调制时，默认得到的不是滑行关断，而是短刹车关断**：`TB6612FNG` 的真值表决定了当 `AIN1/AIN2` 固定为一个方向，而 `PWMA` 拉低时，输出会落入 **Short brake**，而不是 **Stop / Hi-Z**。这意味着很多人以为自己在做普通 PWM，实际上做的是 **brake chopping**，关断相的电流并没有被“放掉”，而是在桥臂内部做慢衰减回流。

- **慢衰减的物理含义，是给电感一个较小的反向压降**：若关断相被切到短刹车，电机端口近似满足 `V_ab ~= 0`，于是  
  `di/dt ~= -(R * i + K_e * omega) / L`。  
  电流下降得慢，平均电流更连续，低速力矩纹波更小，但代价是**刹车更硬、能量更多地在桥臂和绕组里打转**。

- **快衰减的物理含义，是让电感看见接近母线反向的压差**：若关断相切到 **Stop / Hi-Z**，电流会通过体二极管或同步导通路径向母线回灌，绕组等效上看到更大的反向电压，近似有  
  `di/dt ~= -(V_m + R * i + K_e * omega) / L`。  
  这样电流掉得更快，指令跟随更利落，但母线会突然被“喂”一口能量，电源若不能吸收，就会把 `VM` 顶高。

- **回灌电压不是玄学，它来自电感储能守恒**：绕组当前储能  
  `E_L = 0.5 * L * i^2`。  
  若这笔能量在很短时间内主要灌进母线电容 `C_bus`，则电容电压抬升近似满足  
  `Delta V ~= E_L / (C_bus * V_bus)`。  
  所以长导线实验电源、小电解电容和激进换向，是最容易把 `TB6612FNG` 顶到过压保护边缘的组合。

- **“内部带死区”不等于系统级换向可以零等待**：芯片内部为了避免上下桥臂直通，会插入纳秒级防直通死区；但电机电流的衰减常数是 `L / R` 量级，通常在微秒到毫秒之间。也就是说，**晶体管已经安全了，不代表绕组电流已经安全了**。软件仍需要在反向前给旧电流一个释放窗口。

- **短刹车和滑行不是“谁更高级”，而是谁更匹配当前资源边界**：若你要压住低速抖动、保持轮子不被外力轻易推走，短刹车更合适；若你已经逼近母线过压、供电又是不能吸能的台式电源，滑行反而更安全。驱动策略不该固定写死，而该成为**母线、电流、速度与热设计共同决定的调度结果**。

- **PWM 频率会把同一条续流路径放大成不同的纹波结果**：在驱动导通时间 `D * T_s` 内，电流上升近似为  
  `Delta I_on ~= (V_m - K_e * omega - R * i) * D * T_s / L`；  
  在关断时间 `(1 - D) * T_s` 内，电流再按快衰减或慢衰减的斜率下降。频率越低，单周期纹波越大；频率越高，开关损耗和时序中断压力又会上去。真正要调的不是“越高越好”，而是**电流纹波、效率和控制带宽的折中点**。

- **电源类型决定了你能不能承受回灌**：锂电池天生更像一个能吸收回灌的化学缓冲器，而很多实验电源对回流电流很不友好，甚至会因为能量倒灌触发保护或把输出抬高。很多“驱动偶发复位”，本质上不是 MCU 软件问题，而是母线没有一个合格的能量下水道。

- **调度层如果不认识换向状态，控制器再聪明也会把桥臂打进硬边界**：速度环、姿态环或轨迹规划若只会吐出一个带符号占空比，而不知道桥臂正处在“等待旧电流泄放”的窗口里，就会出现控制器已经要求反转、执行器却还在安全等待的相位错位。这个错位如果不显式建模，最终会表现成“偶发顿挫”和“同参数不同电量下手感不一样”。

- **技术哲学上，H 桥控制不是给电机分配占空比，而是在管理能量退路**：驱动状态决定能量怎么送进去，续流状态决定能量怎么退出来，保护状态决定你是否愿意为了安全牺牲瞬态性能。真正成熟的代码，必须把这三种意图写成状态机，而不是只留一个 `setDuty()`。

## 代码能力展现

下面给出一段基于 **STM32 HAL** 的 `TB6612FNG` 驱动示例。代码刻意不把 `PWMA` 当作唯一的 PWM 入口，而是采用**定时器周期起点驱动、比较点切换关断相状态**的方式，让同一套硬件在每个 PWM 周期内同时支持：

- **慢衰减 / 短刹车关断**：关断相切到 `AIN1 = AIN2 = 1`
- **快衰减 / 高阻滑行关断**：关断相切到 `AIN1 = AIN2 = 0`
- **反向前释放窗口**：旧方向电流未降到安全阈值前，只允许滑行，不允许立刻反相导通
- **母线回灌保护**：当 `VM` 已接近上限时，强制优先滑行，避免继续把能量压回电源

```c
#include "main.h"

#include <math.h>
#include <stdbool.h>
#include <stdint.h>

#define TB6612_PWM_FREQ_HZ                    20000U
#define TB6612_DUTY_TICKS_MIN                 0U
#define TB6612_REVERSE_DEADTIME_US           80U
#define TB6612_VDROP_ON_V                   0.35f
#define TB6612_CURRENT_RELEASE_A            0.20f
#define TB6612_BUS_OVERVOLTAGE_V            8.80f
#define TB6612_BUS_RECOVER_V                8.20f

typedef enum
{
    TB6612_DIR_FORWARD = 0,
    TB6612_DIR_REVERSE = 1
} Tb6612Direction_t;

typedef enum
{
    TB6612_DECAY_SLOW_BRAKE = 0,
    TB6612_DECAY_FAST_COAST = 1
} Tb6612DecayMode_t;

typedef enum
{
    TB6612_PHASE_DRIVE = 0,
    TB6612_PHASE_BRAKE = 1,
    TB6612_PHASE_COAST = 2
} Tb6612Phase_t;

typedef struct
{
    TIM_HandleTypeDef *htim_pwm;
    uint32_t pwm_channel;
    uint32_t phase_channel;
    GPIO_TypeDef *ain1_port;
    uint16_t ain1_pin;
    GPIO_TypeDef *ain2_port;
    uint16_t ain2_pin;
    GPIO_TypeDef *stby_port;
    uint16_t stby_pin;
    TIM_HandleTypeDef *htim_timebase;
    uint16_t pwm_arr;
    uint16_t pwm_deadzone_ticks;
    float bus_voltage_v;
    float current_est_a;
    float command_voltage_v;
    float command_limit_v;
    float current_release_a;
    float bus_overvoltage_v;
    float bus_recover_v;
    uint32_t reverse_deadtime_us;
    uint32_t reverse_hold_until_us;
    uint16_t duty_ticks;
    Tb6612Direction_t active_dir;
    Tb6612Direction_t pending_dir;
    Tb6612DecayMode_t decay_mode;
    Tb6612Phase_t phase;
    bool reverse_pending;
    bool regen_clamp_active;
    bool enabled;
} Tb6612Motor_t;

extern TIM_HandleTypeDef htim1;
extern TIM_HandleTypeDef htim5;

static Tb6612Motor_t g_tb6612_motor =
{
    .htim_pwm = &htim1,
    .pwm_channel = TIM_CHANNEL_1,
    .phase_channel = TIM_CHANNEL_2,
    .ain1_port = GPIOB,
    .ain1_pin = GPIO_PIN_12,
    .ain2_port = GPIOB,
    .ain2_pin = GPIO_PIN_13,
    .stby_port = GPIOB,
    .stby_pin = GPIO_PIN_14,
    .htim_timebase = &htim5,
    .pwm_arr = 999U,
    .pwm_deadzone_ticks = 34U,
    .bus_voltage_v = 7.40f,
    .current_est_a = 0.0f,
    .command_voltage_v = 0.0f,
    .command_limit_v = 6.20f,
    .current_release_a = TB6612_CURRENT_RELEASE_A,
    .bus_overvoltage_v = TB6612_BUS_OVERVOLTAGE_V,
    .bus_recover_v = TB6612_BUS_RECOVER_V,
    .reverse_deadtime_us = TB6612_REVERSE_DEADTIME_US,
    .reverse_hold_until_us = 0U,
    .duty_ticks = 0U,
    .active_dir = TB6612_DIR_FORWARD,
    .pending_dir = TB6612_DIR_FORWARD,
    .decay_mode = TB6612_DECAY_SLOW_BRAKE,
    .phase = TB6612_PHASE_COAST,
    .reverse_pending = false,
    .regen_clamp_active = false,
    .enabled = true
};

static float Tb6612_ClampFloat(float value, float min_value, float max_value)
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

static uint16_t Tb6612_ClampTicks(uint16_t value, uint16_t min_value, uint16_t max_value)
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
 * @brief 读取单调递增的微秒时间基。
 * @param motor 电机对象。
 * @retval 当前时间戳，单位 us。
 */
static uint32_t Tb6612_ReadTimeUs(const Tb6612Motor_t *motor)
{
    return __HAL_TIM_GET_COUNTER(motor->htim_timebase);
}

/**
 * @brief 设置 H 桥的瞬时桥臂状态。
 * @param motor 电机对象。
 * @param phase 当前 PWM 子相位。
 * @param dir 导通方向，仅在 DRIVE 相位有效。
 *
 * @note `TB6612FNG` 关键状态映射如下：
 *       1. DRIVE_FWD  : AIN1=1, AIN2=0
 *       2. DRIVE_REV  : AIN1=0, AIN2=1
 *       3. BRAKE      : AIN1=1, AIN2=1
 *       4. COAST/STOP : AIN1=0, AIN2=0
 *
 *       这里把 `PWMA` 对应的 `pwm_channel` 维持在接近 100% 使能，只把
 *       `phase_channel` 当成“相位切换时标”，由它的比较中断在一个 PWM 周期内
 *       切换 AIN1/AIN2，从而明确控制“关断相到底是短刹车还是高阻滑行”。
 */
static void Tb6612_SetPhase(Tb6612Motor_t *motor,
                            Tb6612Phase_t phase,
                            Tb6612Direction_t dir)
{
    GPIO_PinState ain1 = GPIO_PIN_RESET;
    GPIO_PinState ain2 = GPIO_PIN_RESET;

    switch (phase)
    {
    case TB6612_PHASE_DRIVE:
        ain1 = (dir == TB6612_DIR_FORWARD) ? GPIO_PIN_SET : GPIO_PIN_RESET;
        ain2 = (dir == TB6612_DIR_FORWARD) ? GPIO_PIN_RESET : GPIO_PIN_SET;
        break;

    case TB6612_PHASE_BRAKE:
        ain1 = GPIO_PIN_SET;
        ain2 = GPIO_PIN_SET;
        break;

    case TB6612_PHASE_COAST:
    default:
        ain1 = GPIO_PIN_RESET;
        ain2 = GPIO_PIN_RESET;
        break;
    }

    HAL_GPIO_WritePin(motor->ain1_port, motor->ain1_pin, ain1);
    HAL_GPIO_WritePin(motor->ain2_port, motor->ain2_pin, ain2);
    motor->phase = phase;
}

/**
 * @brief 把目标平均电机电压映射为 PWM 导通占空比。
 * @param motor 电机对象。
 * @param target_voltage_v 目标平均电机电压，允许带符号。
 * @retval 导通比较值，范围 [0, ARR]。
 *
 * @note 线性映射近似：
 *       V_avg ~= D * (V_bus - V_drop_on)
 *       D ~= |V_cmd| / (V_bus - V_drop_on)
 *
 *       若考虑静摩擦与桥臂死区，低占空比区需要抬升到可交付区间：
 *       compare = deadzone + D * (ARR - deadzone)
 *
 *       这里故意只把它当成“一阶平均模型”，因为真正的瞬时电流纹波已经在
 *       PWM 子相位状态机里由快衰减 / 慢衰减路径决定。
 */
static uint16_t Tb6612_MapVoltageToDutyTicks(const Tb6612Motor_t *motor, float target_voltage_v)
{
    const float safe_vbus =
        Tb6612_ClampFloat(motor->bus_voltage_v, 4.5f, 15.0f);
    const float effective_v =
        Tb6612_ClampFloat(safe_vbus - TB6612_VDROP_ON_V, 0.5f, safe_vbus);
    const float limited_cmd =
        Tb6612_ClampFloat(fabsf(target_voltage_v), 0.0f, motor->command_limit_v);
    const float duty =
        Tb6612_ClampFloat(limited_cmd / effective_v, 0.0f, 1.0f);
    const float span =
        (float)motor->pwm_arr - (float)motor->pwm_deadzone_ticks;
    float compare_f = 0.0f;

    if (duty <= 0.0f)
    {
        return 0U;
    }

    compare_f = (float)motor->pwm_deadzone_ticks + duty * span;
    compare_f = Tb6612_ClampFloat(compare_f, 0.0f, (float)motor->pwm_arr);
    return Tb6612_ClampTicks((uint16_t)lroundf(compare_f),
                             TB6612_DUTY_TICKS_MIN,
                             motor->pwm_arr);
}

/**
 * @brief 判断当前母线是否应该进入回灌保护。
 * @param motor 电机对象。
 * @retval true  进入或保持回灌钳位。
 * @retval false 母线已恢复到可正常工作区间。
 *
 * @note 回灌保护不是根据“命令是否为负”判断，而是根据母线是否已经过高。
 *       一旦 `VM` 已逼近上限，再继续用短刹车吸收电流，只会让更多能量压回
 *       供电网络。因此这里采用带迟滞的钳位：
 *       1. V_bus >= V_ov  -> 立即进入钳位
 *       2. V_bus <= V_rec -> 允许退出钳位
 */
static bool Tb6612_UpdateRegenClamp(Tb6612Motor_t *motor)
{
    if (motor->bus_voltage_v >= motor->bus_overvoltage_v)
    {
        motor->regen_clamp_active = true;
    }
    else if (motor->bus_voltage_v <= motor->bus_recover_v)
    {
        motor->regen_clamp_active = false;
    }

    return motor->regen_clamp_active;
}

/**
 * @brief 更新目标电压命令，并在换向前插入电流释放窗口。
 * @param motor 电机对象。
 * @param target_voltage_v 新的带符号目标电压。
 * @param bus_voltage_v 当前母线电压。
 * @param current_est_a 当前电枢电流估计。
 *
 * @note 换向保护逻辑：
 *       1. 若目标方向与当前导通方向相反，且 |i| 尚大于释放阈值，
 *          则先进入 COAST 释放窗口；
 *       2. 只有当 `|i| <= I_release` 且 `t >= t_hold` 时，才允许切到新方向；
 *       3. 释放窗口内 `duty = 0`，避免旧电流尚未退去时强行反向导通。
 *
 *       这比单纯插一个固定 delay 更稳，因为判据同时包含了“时间”和“电流”。
 */
void Tb6612_SubmitCommand(Tb6612Motor_t *motor,
                          float target_voltage_v,
                          float bus_voltage_v,
                          float current_est_a)
{
    const float limited_cmd =
        Tb6612_ClampFloat(target_voltage_v, -motor->command_limit_v, motor->command_limit_v);
    const Tb6612Direction_t requested_dir =
        (limited_cmd >= 0.0f) ? TB6612_DIR_FORWARD : TB6612_DIR_REVERSE;
    const uint32_t now_us = Tb6612_ReadTimeUs(motor);
    const bool direction_changed = (requested_dir != motor->active_dir);
    bool clamp_active = false;

    motor->command_voltage_v = limited_cmd;
    motor->bus_voltage_v = Tb6612_ClampFloat(bus_voltage_v, 0.0f, 24.0f);
    motor->current_est_a = Tb6612_ClampFloat(current_est_a, -20.0f, 20.0f);
    clamp_active = Tb6612_UpdateRegenClamp(motor);

    if (!motor->enabled)
    {
        motor->duty_ticks = 0U;
        return;
    }

    if (direction_changed)
    {
        motor->pending_dir = requested_dir;
        motor->reverse_pending = true;
        motor->reverse_hold_until_us = now_us + motor->reverse_deadtime_us;
    }

    if (motor->reverse_pending)
    {
        const bool current_released = (fabsf(motor->current_est_a) <= motor->current_release_a);
        const bool time_elapsed = ((int32_t)(now_us - motor->reverse_hold_until_us) >= 0);

        if (current_released && time_elapsed)
        {
            motor->active_dir = motor->pending_dir;
            motor->reverse_pending = false;
        }
        else
        {
            motor->duty_ticks = 0U;
            return;
        }
    }

    if (clamp_active)
    {
        /*
         * 母线已高时，优先放掉电流而不是继续短刹车。
         * 这里不强行改方向，只是把占空比清零，并让 PWM 关断相走 COAST。
         */
        motor->decay_mode = TB6612_DECAY_FAST_COAST;
        motor->duty_ticks = 0U;
        return;
    }

    motor->duty_ticks = Tb6612_MapVoltageToDutyTicks(motor, motor->command_voltage_v);
}

/**
 * @brief 在 PWM 周期起点进入导通相或全周期关断相。
 * @param motor 电机对象。
 *
 * @note 若 `duty_ticks == 0`，整个周期都保持关断相：
 *       1. 慢衰减模式 -> BRAKE
 *       2. 快衰减模式 -> COAST
 *
 *       若 `duty_ticks > 0`，则先进入 DRIVE，相当于在 PWM 周期起点把平均电压
 *       注入绕组，等待比较中断再切入关断相。
 */
static void Tb6612_OnPwmPeriodStart(Tb6612Motor_t *motor)
{
    if (!motor->enabled)
    {
        HAL_GPIO_WritePin(motor->stby_port, motor->stby_pin, GPIO_PIN_RESET);
        Tb6612_SetPhase(motor, TB6612_PHASE_COAST, motor->active_dir);
        return;
    }

    HAL_GPIO_WritePin(motor->stby_port, motor->stby_pin, GPIO_PIN_SET);

    if (motor->reverse_pending || motor->regen_clamp_active)
    {
        Tb6612_SetPhase(motor, TB6612_PHASE_COAST, motor->active_dir);
        return;
    }

    if (motor->duty_ticks == 0U)
    {
        const Tb6612Phase_t off_phase =
            (motor->decay_mode == TB6612_DECAY_SLOW_BRAKE) ? TB6612_PHASE_BRAKE
                                                            : TB6612_PHASE_COAST;
        Tb6612_SetPhase(motor, off_phase, motor->active_dir);
        return;
    }

    Tb6612_SetPhase(motor, TB6612_PHASE_DRIVE, motor->active_dir);
}

/**
 * @brief 在 PWM 导通时间结束时切入关断相。
 * @param motor 电机对象。
 *
 * @note 两种关断相对应两种不同的电流衰减哲学：
 *       1. BRAKE: `V_ab ~= 0`，`di/dt` 主要由 `-(R*i + Ke*omega)/L` 决定
 *       2. COAST: 电流回灌母线，`|di/dt|` 更大，但对供电更苛刻
 */
static void Tb6612_OnPwmPulseEnd(Tb6612Motor_t *motor)
{
    const Tb6612Phase_t off_phase =
        (motor->decay_mode == TB6612_DECAY_SLOW_BRAKE) ? TB6612_PHASE_BRAKE
                                                        : TB6612_PHASE_COAST;

    if (motor->duty_ticks == 0U)
    {
        return;
    }

    if (motor->duty_ticks >= motor->pwm_arr)
    {
        /*
         * 100% 占空比没有关断窗口，整周期保持 DRIVE。
         */
        return;
    }

    Tb6612_SetPhase(motor, off_phase, motor->active_dir);
}

/**
 * @brief 切换电流衰减模式。
 * @param motor 电机对象。
 * @param decay_mode 目标衰减模式。
 */
void Tb6612_SetDecayMode(Tb6612Motor_t *motor, Tb6612DecayMode_t decay_mode)
{
    if (motor == NULL)
    {
        return;
    }

    motor->decay_mode = decay_mode;
}

/**
 * @brief 在控制环里用目标扭矩近似选择衰减模式。
 * @param motor 电机对象。
 * @param velocity_ref_rad_s 目标角速度。
 * @param velocity_meas_rad_s 实测角速度。
 *
 * @note 一个实用经验是：
 *       1. 速度误差较小、希望低纹波稳态时，用慢衰减；
 *       2. 速度误差很大、需要快速卸电流时，用快衰减。
 *
 *       这里用速度误差绝对值做一个简单示例，不把模式切换写死在初始化阶段。
 */
void Tb6612_SelectDecayByVelocityError(Tb6612Motor_t *motor,
                                       float velocity_ref_rad_s,
                                       float velocity_meas_rad_s)
{
    const float velocity_error = velocity_ref_rad_s - velocity_meas_rad_s;

    if (fabsf(velocity_error) > 18.0f)
    {
        motor->decay_mode = TB6612_DECAY_FAST_COAST;
    }
    else
    {
        motor->decay_mode = TB6612_DECAY_SLOW_BRAKE;
    }
}

/**
 * @brief 示例：把期望电压、电流估计和母线电压一起提交到驱动层。
 *
 * @note `current_est_a` 可以来自采样电阻、霍尔电流计，或者低成本场景下由
 *       观测器粗估。即便是粗估，只要能告诉软件“旧电流大概还没放干净”，
 *       换向保护就会比纯固定延时稳得多。
 */
void App_Tb6612ControlStep(float target_voltage_v,
                           float bus_voltage_v,
                           float current_est_a,
                           float velocity_ref_rad_s,
                           float velocity_meas_rad_s)
{
    Tb6612_SelectDecayByVelocityError(&g_tb6612_motor,
                                      velocity_ref_rad_s,
                                      velocity_meas_rad_s);
    Tb6612_SubmitCommand(&g_tb6612_motor,
                         target_voltage_v,
                         bus_voltage_v,
                         current_est_a);
    __HAL_TIM_SET_COMPARE(g_tb6612_motor.htim_pwm,
                          g_tb6612_motor.pwm_channel,
                          g_tb6612_motor.pwm_arr);
    __HAL_TIM_SET_COMPARE(g_tb6612_motor.htim_pwm,
                          g_tb6612_motor.phase_channel,
                          g_tb6612_motor.duty_ticks);
}

void HAL_TIM_PeriodElapsedCallback(TIM_HandleTypeDef *htim)
{
    if (htim->Instance == TIM1)
    {
        Tb6612_OnPwmPeriodStart(&g_tb6612_motor);
    }
}

void HAL_TIM_OC_DelayElapsedCallback(TIM_HandleTypeDef *htim)
{
    if (htim->Instance == TIM1)
    {
        Tb6612_OnPwmPulseEnd(&g_tb6612_motor);
    }
}
```

这段代码里最重要的，不是“把电机转起来”，而是把三件经常被混在一起的事情拆开了：

- **平均电压命令**：由控制环决定，希望电机在这个周期内平均吃进多少能量。
- **PWM 子相位状态**：由驱动层决定，导通之后到底切去短刹车还是高阻滑行。
- **保护窗口调度**：由电流和母线状态决定，什么时候必须暂时牺牲响应，先让能量退回到安全边界内。

工程上可以先记住四句判断：

- **低速稳态抑纹波**优先时，先用慢衰减；它让电流更连续，但也更容易把刹车做得很“硬”。
- **急减速、急换向或大误差跟踪**优先时，快衰减更利落，但要先确认母线、电源和吸收网络接得住回灌。
- **反向死区不能只靠芯片内部防直通**；真正该等的是绕组电流释放，而不是 MOS 管纳秒级切换。
- **台式电源 + 长线 + 小电容** 是 `TB6612FNG` 最危险的组合之一；很多复位、过压和莫名抖动，根源都在母线没有被当成能量容器来设计。

如果后续继续往深处做，下一步最有价值的不是再调一次 `PWM` 频率，而是把这三项量出来：**关断相真实电流斜率、回灌时母线抬升波形、换向时电流过零所需时间**。一旦这三条曲线被示波器和代码里的状态机对齐，`TB6612FNG` 这种看起来“很简单”的小 H 桥，才算真正进入可验证、可维护的工程状态。
