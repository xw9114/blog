---
title: "技能档案：TB6612FNG 的 PWM 频率、反电动势与刹车模式"
slug: "skill-tb6612fng-pwm-frequency-back-emf-and-brake-mode"
date: 2026-05-17T09:32:00+08:00
draft: false
description: "从电枢电感、反电动势与续流路径出发，系统拆解 TB6612FNG 在 PWM 频率选择、动态刹车与反向切换中的物理约束。"
tags: ["TB6612FNG", "STM32", "PWM", "电机驱动", "反电动势", "刹车模式", "嵌入式"]
categories: ["技能档案"]
image: ""
---

## 技能概述

TB6612FNG 这类小功率 H 桥驱动，真正难的从来不是“让直流电机转起来”，而是让它在低速不抖、高速不叫、减速不炸、换向不抽。两轮差速底盘、云台小机构、拨盘执行器和平衡车辅助轮都在反复遇到同一类问题：PWM 频率选低了，电流纹波和啸叫马上出来；选高了，定时器分辨率、驱动损耗和实际有效电压又开始吃紧；速度一起来，反电动势把低占空比几乎全部吞掉；一脚收油时，是该滑行、短刹车，还是直接反向施压，本质上都在处理同一件事：如何把 MCU 的离散时序命令，翻译成绕组电流、反电动势与机械动能之间有边界的能量调度。

## 核心底层概念解析

- **TB6612FNG 输出的不是“方向信号”，而是 H 桥导通拓扑**：`IN1/IN2` 决定上下桥臂谁在导通，`PWM` 决定这种导通状态在一个周期里维持多久。电机看到的不是 GPIO 电平，而是某一时刻端子两端到底接上了 `+Vbat`、`GND`、高阻态，还是被低阻短接。
- **PWM 频率首先约束的是电流纹波，而不是听感**：对直流电机绕组可近似写成 `L * di/dt + R * i + K_e * omega = V_m`。若在一个 PWM 周期内把反电动势和转速视为慢变量，则电流峰峰值可粗略近似为 `Delta I_pp ~= V_eff * T_pwm / L`。`T_pwm` 越长，单周期内电流爬升和回落越充分，转矩脉动、啸叫和低速抖动就越明显。
- **PWM 频率又不可能无限抬高，因为数字时间分辨率会先塌**：定时器满足 `f_pwm = f_tim / ((PSC + 1) * (ARR + 1))`。`f_pwm` 提高后，`ARR` 变小，每一档占空比分辨率都更粗。对小电机来说，这意味着你可能刚好失去“能稳住慢速”的那几格细分，而只剩下“再低不动、再高猛窜”的两端。
- **反电动势不是噪声，它是速度写回驱动层的物理反馈**：电机越快，`e_b = K_e * omega` 越大。对于同样的占空比，真正落在绕组电阻和电感上的有效电压变成 `V_eff = D * Vbat - e_b - i * R_eq`。所以同一份 `Duty=20%`，静止时也许能把电机一下顶起来，高速时却可能只够维持转速，甚至连保持当前电流都不够。
- **“低占空比没反应”很多时候不是软件死区，而是反电动势与桥压降把有效电压吃没了**：TB6612FNG 内部 MOS 导通压降、线阻、刷片接触电阻和供电内阻都会进入 `R_eq` 与等效压降项。于是实际系统往往存在一段 `|D * Vbat| < |K_e * omega + V_drop|` 的区间，在这段区间内，示波器上有 PWM，机械世界里却没有足够转矩。
- **滑行与短刹车的差异，本质上是绕组回路有没有被重建**：滑行时桥臂断开，电机端子接近高阻，电流很快掉空，机械动能主要靠摩擦自然耗散；短刹车时桥臂把电机两端低阻短接，电机立刻变成一个给自己供电的发电机，电流近似满足 `i_brake ~= -K_e * omega / R_loop`，对应制动力矩 `tau_brake = K_t * i_brake`。前者是撤力，后者是主动耗能。
- **“直接反转”与“先刹后反”不是编码风格差异，而是峰值电流管理差异**：当转子仍在正向高速旋转时，若软件立即切到反向驱动，桥两端施加的并不是简单的负电压，而是“反向母线电压 + 仍然存在的正向反电动势”。这会让绕组瞬时电压差显著放大，等效电流爬升斜率 `di/dt = (V_cmd - e_b - iR) / L` 也一并抬高。
- **短刹车不是永远更好，它会把机械能更快地变成热**：刹车越狠，速度掉得越快，但桥臂、绕组和电源回路承担的热与电流冲击也越大。对轻载小惯量机构，滑行可能已经足够；对需要快速停稳的轮系，短刹车更合适；对重载反向切换，则常常要先短刹一个受控窗口，再进入反向 PWM。
- **频率选择必须同时看电感时常数与驱动芯片能力**：绕组电气时常数 `tau_e = L / R` 给出了电流自然变化速度。若 `T_pwm` 接近甚至大于 `tau_e`，系统就不再像“平均电压控制”，而更像“通一下、断一下”的粗暴斩波。反过来，若 `f_pwm` 过高，芯片开关损耗、边沿非理想与定时器分辨率又会反噬控制精度。
- **工程上的“刹车模式选择”其实是在做状态机设计**：速度高于阈值、指令接近零时，通常优先短刹；速度已经很低时，转滑行可避免停车前抖动；若指令方向和当前速度方向相反，常需要插入一个 `break-before-make` 的空窗，让桥臂和绕组中的旧能量先退场，再把新方向接进来。
- **驱动层真正守护的是闭环的可解释性**：如果频率、反电动势补偿和刹车策略都没建模，上层控制器看到的就不是“命令 - 输出”的单调关系，而是一个会随速度、供电和温升漂移的时变对象。控制算法并不是失效了，它只是被交给了一台没有被正确定义的执行器。

## 代码能力展现

下面给出一个基于 STM32 HAL 的 TB6612FNG 驱动封装。代码重点不在基础 GPIO 初始化，而在三条更容易被写错的链路上：**按定时器分辨率配置 PWM 频率**、**用反电动势与等效电阻估算所需占空比**、**在滑行/短刹车/反向驱动之间做受控切换**。示例假设上层每 `1 ms` 调用一次，输入为 `[-1000, 1000]` 的归一化力矩命令，并已有一个来自编码器或估算器的速度 `rpm`。

```c
#include "stm32f4xx_hal.h"

#include <math.h>
#include <stdbool.h>
#include <stdint.h>

#define TB6612_PWM_FREQ_MIN_HZ              8000U
#define TB6612_PWM_FREQ_MAX_HZ              40000U
#define TB6612_DUTY_MAX_PERMILLE            980U
#define TB6612_ZERO_CMD_BAND_PERMILLE       30U
#define TB6612_REVERSE_BLANK_MAX_CYCLES     50U
#define TB6612_BRAKE_HOLD_MAX_CYCLES        200U

typedef enum
{
    TB6612_MODE_COAST = 0,
    TB6612_MODE_SHORT_BRAKE,
    TB6612_MODE_DRIVE_FORWARD,
    TB6612_MODE_DRIVE_REVERSE
} Tb6612Mode_t;

typedef struct
{
    TIM_HandleTypeDef *htim_pwm;
    uint32_t pwm_channel;
    uint32_t tim_counter_hz;           /* 已经除过 PSC 的定时器计数频率。 */

    GPIO_TypeDef *in1_port;
    uint16_t in1_pin;
    GPIO_TypeDef *in2_port;
    uint16_t in2_pin;
    GPIO_TypeDef *stby_port;
    uint16_t stby_pin;

    uint32_t pwm_freq_hz;
    uint16_t pwm_arr;

    float armature_resistance_ohm;     /* 电机绕组 + 线阻 + 驱动导通电阻的等效总电阻。 */
    float armature_inductance_h;       /* 用于估算最小 PWM 频率。 */
    float bemf_constant_v_per_rad;     /* K_e，单位 V/(rad/s)。 */
    float bridge_drop_v;               /* H 桥与布线的等效导通压降。 */
    float max_current_a;               /* 归一化命令映射后的最大目标电流。 */

    float brake_enable_rpm;            /* 高于该速度，零命令时优先短刹车。 */
    float brake_release_rpm;           /* 低于该速度，短刹车可释放为滑行，形成迟滞。 */
    uint16_t reverse_blank_cycles;     /* 反向切换前插入的控制周期数。 */
    uint16_t brake_hold_cycles;        /* 短刹保持上限，避免长时间硬刹。 */

    Tb6612Mode_t mode;
    uint16_t reverse_blank_count;
    uint16_t brake_hold_count;
} Tb6612Motor_t;

static float Tb6612_ClampF32(float value, float min_value, float max_value)
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

static int16_t Tb6612_ClampS16(int16_t value, int16_t min_value, int16_t max_value)
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

static uint16_t Tb6612_ClampU16(uint16_t value, uint16_t min_value, uint16_t max_value)
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

static float Tb6612_SignNonZero(float value)
{
    return (value >= 0.0f) ? 1.0f : -1.0f;
}

static uint16_t Tb6612_AbsS16(int16_t value)
{
    int32_t temp = value;

    if (temp < 0)
    {
        temp = -temp;
    }

    return (uint16_t)temp;
}

static float Tb6612_RpmToRadPerSec(float rpm)
{
    return rpm * (2.0f * 3.14159265359f / 60.0f);
}

static int8_t Tb6612_SignWithBand(float value, float band)
{
    if (value > band)
    {
        return 1;
    }

    if (value < -band)
    {
        return -1;
    }

    return 0;
}

static void Tb6612_WriteBridge(const Tb6612Motor_t *motor, Tb6612Mode_t mode)
{
    GPIO_PinState in1 = GPIO_PIN_RESET;
    GPIO_PinState in2 = GPIO_PIN_RESET;

    switch (mode)
    {
    case TB6612_MODE_DRIVE_FORWARD:
        in1 = GPIO_PIN_SET;
        in2 = GPIO_PIN_RESET;
        break;

    case TB6612_MODE_DRIVE_REVERSE:
        in1 = GPIO_PIN_RESET;
        in2 = GPIO_PIN_SET;
        break;

    case TB6612_MODE_SHORT_BRAKE:
        /*
         * TB6612FNG 短刹车需要 IN1 = IN2，且 PWM 保持有效。
         * 这里选择 IN1 = IN2 = 1，使电机两端低阻短接。
         */
        in1 = GPIO_PIN_SET;
        in2 = GPIO_PIN_SET;
        break;

    case TB6612_MODE_COAST:
    default:
        /* 滑行模式下双输入拉低，输出级撤力。 */
        in1 = GPIO_PIN_RESET;
        in2 = GPIO_PIN_RESET;
        break;
    }

    HAL_GPIO_WritePin(motor->in1_port, motor->in1_pin, in1);
    HAL_GPIO_WritePin(motor->in2_port, motor->in2_pin, in2);
}

static void Tb6612_SetCompare(const Tb6612Motor_t *motor, uint16_t compare)
{
    __HAL_TIM_SET_COMPARE(motor->htim_pwm, motor->pwm_channel, compare);
}

static void Tb6612_ApplyMode(Tb6612Motor_t *motor, Tb6612Mode_t mode, uint16_t compare)
{
    /*
     * 更新顺序很重要：
     * 1. 若从驱动切到刹车或滑行，先撤掉旧占空比；
     * 2. 改桥臂拓扑；
     * 3. 再加载新的比较值。
     *
     * 这样能降低方向翻转瞬间把旧能量直接顶进新导通路径的概率。
     */
    Tb6612_SetCompare(motor, 0U);
    Tb6612_WriteBridge(motor, mode);
    Tb6612_SetCompare(motor, compare);
    motor->mode = mode;
}

/**
 * @brief 依据允许电流纹波估算 PWM 最小频率。
 * @param vbus_v 母线电压。
 * @param inductance_h 电枢等效电感。
 * @param max_ripple_a 允许的电流峰峰值上限。
 * @return 推荐的 PWM 最小频率，单位 Hz。
 *
 * @note 在低速、反电动势较小、占空比接近 50% 的最坏近似下，可写：
 *       Delta I_pp ~= Vbus / (4 * L * f_pwm)
 *       因而有：
 *       f_pwm >= Vbus / (4 * L * Delta I_pp_max)
 *
 *       这不是精确模型，但足够说明 PWM 频率为什么首先受电感与纹波约束。
 */
static uint32_t Tb6612_EstimateMinPwmHz(float vbus_v,
                                        float inductance_h,
                                        float max_ripple_a)
{
    float freq_hz;

    if ((vbus_v <= 0.0f) || (inductance_h <= 0.0f) || (max_ripple_a <= 0.0f))
    {
        return TB6612_PWM_FREQ_MIN_HZ;
    }

    freq_hz = vbus_v / (4.0f * inductance_h * max_ripple_a);
    freq_hz = Tb6612_ClampF32(freq_hz,
                              (float)TB6612_PWM_FREQ_MIN_HZ,
                              (float)TB6612_PWM_FREQ_MAX_HZ);

    return (uint32_t)(freq_hz + 0.5f);
}

/**
 * @brief 配置 TB6612FNG 的 PWM 频率。
 * @param motor 驱动对象。
 * @param desired_pwm_hz 目标 PWM 频率。
 * @retval true 配置成功。
 * @retval false 参数非法或分辨率不足。
 *
 * @note 定时器关系式：
 *       f_pwm = f_tim / ((PSC + 1) * (ARR + 1))
 *
 *       这里假设 PSC 已固定，`tim_counter_hz` 即为 `f_tim / (PSC + 1)`，
 *       则可直接反推：
 *       ARR = round(tim_counter_hz / f_pwm) - 1
 */
bool Tb6612_ConfigPwmFrequency(Tb6612Motor_t *motor, uint32_t desired_pwm_hz)
{
    uint32_t arr;

    if ((motor == NULL) || (motor->htim_pwm == NULL) || (motor->tim_counter_hz == 0U))
    {
        return false;
    }

    desired_pwm_hz = Tb6612_ClampU16((uint16_t)desired_pwm_hz,
                                     (uint16_t)TB6612_PWM_FREQ_MIN_HZ,
                                     (uint16_t)TB6612_PWM_FREQ_MAX_HZ);

    arr = (motor->tim_counter_hz + (desired_pwm_hz / 2U)) / desired_pwm_hz;
    if (arr == 0U)
    {
        return false;
    }

    arr -= 1U;
    if ((arr < 100U) || (arr > 0xFFFFU))
    {
        /*
         * ARR 过小会让占空比分辨率粗到难以做平滑调速；
         * ARR 过大则超出 16 位定时器能力。
         */
        return false;
    }

    motor->pwm_freq_hz = desired_pwm_hz;
    motor->pwm_arr = (uint16_t)arr;

    __HAL_TIM_SET_AUTORELOAD(motor->htim_pwm, motor->pwm_arr);
    Tb6612_SetCompare(motor, 0U);
    return true;
}

/**
 * @brief 根据目标力矩电流与当前转速估算驱动占空比。
 * @param motor 驱动对象。
 * @param torque_cmd_permille 归一化命令，范围 [-1000, 1000]。
 * @param speed_rpm 当前速度估计，单位 rpm。
 * @param vbus_v 当前母线电压。
 * @param out_mode 输出建议模式。
 * @param out_compare 输出比较值。
 * @retval true 估算成功。
 * @retval false 参数非法或母线电压异常。
 *
 * @note 采用简化的电枢模型：
 *       V_cmd ~= K_e * omega + I_ref * R_eq + sign(I_ref) * V_drop
 *
 *       其中：
 *       I_ref = torque_cmd / 1000 * I_max
 *       duty  = |V_cmd| / Vbus
 *       compare = duty * ARR
 *
 *       这条映射把速度带来的反电动势显式加入驱动层，避免在高速区继续把
 *       “同一个 PWM 比例”误当成“同一个实际转矩”。
 */
static bool Tb6612_ComputeDriveOutput(const Tb6612Motor_t *motor,
                                      int16_t torque_cmd_permille,
                                      float speed_rpm,
                                      float vbus_v,
                                      Tb6612Mode_t *out_mode,
                                      uint16_t *out_compare)
{
    float current_ref_a;
    float omega_rad_s;
    float v_required;
    float duty;
    uint32_t compare;

    if ((motor == NULL) || (out_mode == NULL) || (out_compare == NULL) || (vbus_v <= 0.1f))
    {
        return false;
    }

    torque_cmd_permille = Tb6612_ClampS16(torque_cmd_permille, -1000, 1000);
    current_ref_a = ((float)torque_cmd_permille / 1000.0f) * motor->max_current_a;
    omega_rad_s = Tb6612_RpmToRadPerSec(speed_rpm);

    if (fabsf(current_ref_a) < 1.0e-4f)
    {
        *out_mode = TB6612_MODE_COAST;
        *out_compare = 0U;
        return true;
    }

    v_required = motor->bemf_constant_v_per_rad * omega_rad_s +
                 motor->armature_resistance_ohm * current_ref_a +
                 Tb6612_SignNonZero(current_ref_a) * motor->bridge_drop_v;

    duty = fabsf(v_required) / vbus_v;
    duty = Tb6612_ClampF32(duty, 0.0f, (float)TB6612_DUTY_MAX_PERMILLE / 1000.0f);

    compare = (uint32_t)(duty * (float)motor->pwm_arr + 0.5f);
    if (compare > motor->pwm_arr)
    {
        compare = motor->pwm_arr;
    }

    *out_mode = (v_required >= 0.0f) ? TB6612_MODE_DRIVE_FORWARD : TB6612_MODE_DRIVE_REVERSE;
    *out_compare = (uint16_t)compare;
    return true;
}

/**
 * @brief 按速度与命令关系选择滑行、短刹车或驱动。
 * @param motor 驱动对象。
 * @param torque_cmd_permille 归一化命令。
 * @param speed_rpm 当前速度估计。
 * @param vbus_v 当前母线电压。
 *
 * @note 决策逻辑分三层：
 *       1. 零命令区：高速优先短刹，低速切滑行，避免临停抖动；
 *       2. 反向切换区：若当前速度方向与命令方向相反，先插入短刹空窗；
 *       3. 驱动区：再按 `K_e * omega + I_ref * R_eq` 映射实际占空比。
 */
void Tb6612_Update(Tb6612Motor_t *motor,
                   int16_t torque_cmd_permille,
                   float speed_rpm,
                   float vbus_v)
{
    const uint16_t cmd_abs = Tb6612_AbsS16(torque_cmd_permille);
    const int8_t cmd_sign = Tb6612_SignWithBand((float)torque_cmd_permille,
                                                (float)TB6612_ZERO_CMD_BAND_PERMILLE);
    const int8_t speed_sign = Tb6612_SignWithBand(speed_rpm, 1.0f);
    Tb6612Mode_t mode;
    uint16_t compare;

    if ((motor == NULL) || (motor->htim_pwm == NULL))
    {
        return;
    }

    torque_cmd_permille = Tb6612_ClampS16(torque_cmd_permille, -1000, 1000);
    motor->reverse_blank_cycles = Tb6612_ClampU16(motor->reverse_blank_cycles,
                                                  0U,
                                                  TB6612_REVERSE_BLANK_MAX_CYCLES);
    motor->brake_hold_cycles = Tb6612_ClampU16(motor->brake_hold_cycles,
                                               0U,
                                               TB6612_BRAKE_HOLD_MAX_CYCLES);

    if ((cmd_abs <= TB6612_ZERO_CMD_BAND_PERMILLE) || (vbus_v <= 0.1f))
    {
        motor->reverse_blank_count = 0U;

        if ((fabsf(speed_rpm) >= motor->brake_enable_rpm) &&
            (motor->brake_hold_count < motor->brake_hold_cycles))
        {
            /*
             * 短刹车模式下，PWM 取满量程以保证桥臂真正参与短接。
             * 此时电机近似满足：
             * i_brake ~= -K_e * omega / R_loop
             * tau_brake = K_t * i_brake
             */
            Tb6612_ApplyMode(motor, TB6612_MODE_SHORT_BRAKE, motor->pwm_arr);
            motor->brake_hold_count++;
            return;
        }

        if (fabsf(speed_rpm) <= motor->brake_release_rpm)
        {
            motor->brake_hold_count = 0U;
        }

        Tb6612_ApplyMode(motor, TB6612_MODE_COAST, 0U);
        return;
    }

    motor->brake_hold_count = 0U;

    if ((cmd_sign != 0) &&
        (speed_sign != 0) &&
        (cmd_sign != speed_sign) &&
        (fabsf(speed_rpm) >= motor->brake_enable_rpm))
    {
        if (motor->reverse_blank_count < motor->reverse_blank_cycles)
        {
            motor->reverse_blank_count++;

            /*
             * 反向命令到来时，不立即切桥臂方向，而是先给一个短刹窗口。
             * 这相当于在“旧方向的机械动能”和“新方向的电压施加”之间
             * 插入受控的 break-before-make 边界，降低瞬时冲击电流。
             */
            Tb6612_ApplyMode(motor, TB6612_MODE_SHORT_BRAKE, motor->pwm_arr);
            return;
        }
    }
    else
    {
        motor->reverse_blank_count = 0U;
    }

    if (!Tb6612_ComputeDriveOutput(motor,
                                   torque_cmd_permille,
                                   speed_rpm,
                                   vbus_v,
                                   &mode,
                                   &compare))
    {
        Tb6612_ApplyMode(motor, TB6612_MODE_COAST, 0U);
        return;
    }

    Tb6612_ApplyMode(motor, mode, compare);
}

/**
 * @brief 启动 TB6612FNG 驱动。
 * @param motor 驱动对象。
 * @retval true 启动成功。
 * @retval false 参数非法或 HAL 启动失败。
 */
bool Tb6612_Start(Tb6612Motor_t *motor)
{
    if ((motor == NULL) ||
        (motor->htim_pwm == NULL) ||
        (motor->in1_port == NULL) ||
        (motor->in2_port == NULL) ||
        (motor->stby_port == NULL))
    {
        return false;
    }

    if (!Tb6612_ConfigPwmFrequency(motor, motor->pwm_freq_hz))
    {
        return false;
    }

    motor->mode = TB6612_MODE_COAST;
    motor->reverse_blank_count = 0U;
    motor->brake_hold_count = 0U;

    HAL_GPIO_WritePin(motor->stby_port, motor->stby_pin, GPIO_PIN_SET);

    if (HAL_TIM_PWM_Start(motor->htim_pwm, motor->pwm_channel) != HAL_OK)
    {
        return false;
    }

    Tb6612_ApplyMode(motor, TB6612_MODE_COAST, 0U);
    return true;
}

extern TIM_HandleTypeDef htim3;
extern float Encoder_GetMotorSpeedRpm(void);
extern float PowerBus_GetVoltage(void);
extern int16_t BalanceControl_GetTorqueCommandPermille(void);

static Tb6612Motor_t g_drive_motor =
{
    .htim_pwm = &htim3,
    .pwm_channel = TIM_CHANNEL_1,
    .tim_counter_hz = 1000000U,          /* 例如 PSC 已配成 1 MHz 计数频率。 */
    .in1_port = GPIOB,
    .in1_pin = GPIO_PIN_12,
    .in2_port = GPIOB,
    .in2_pin = GPIO_PIN_13,
    .stby_port = GPIOB,
    .stby_pin = GPIO_PIN_14,
    .pwm_freq_hz = 20000U,
    .pwm_arr = 0U,
    .armature_resistance_ohm = 1.15f,
    .armature_inductance_h = 180e-6f,
    .bemf_constant_v_per_rad = 0.018f,
    .bridge_drop_v = 0.35f,
    .max_current_a = 2.8f,
    .brake_enable_rpm = 120.0f,
    .brake_release_rpm = 25.0f,
    .reverse_blank_cycles = 4U,
    .brake_hold_cycles = 8U,
    .mode = TB6612_MODE_COAST,
    .reverse_blank_count = 0U,
    .brake_hold_count = 0U
};

void App_MotorInit(void)
{
    uint32_t recommend_pwm_hz;

    /*
     * 例如希望电流纹波不超过 0.35 A，则先由物理模型反推一个建议值，
     * 再与工程经验值取更大者。
     */
    recommend_pwm_hz = Tb6612_EstimateMinPwmHz(7.4f,
                                               g_drive_motor.armature_inductance_h,
                                               0.35f);
    if (recommend_pwm_hz > g_drive_motor.pwm_freq_hz)
    {
        g_drive_motor.pwm_freq_hz = recommend_pwm_hz;
    }

    (void)Tb6612_Start(&g_drive_motor);
}

void App_Control1kHz(void)
{
    const float speed_rpm = Encoder_GetMotorSpeedRpm();
    const float vbus_v = PowerBus_GetVoltage();
    const int16_t torque_cmd = BalanceControl_GetTorqueCommandPermille();

    Tb6612_Update(&g_drive_motor, torque_cmd, speed_rpm, vbus_v);
}
```

这段实现真正想守住的，不是“某个定时器能不能输出 20 kHz PWM”，而是**数字命令在不同速度、不同供电和不同减速阶段下，仍然对应同一种可解释的物理动作**。`f_pwm = f_tim / ((PSC + 1) * (ARR + 1))` 管的是时间分辨率，`V_cmd ~= K_e * omega + I_ref * R_eq + V_drop` 管的是速度对驱动的反写，短刹车与反向空窗管的是能量如何从旧状态平稳交接到新状态。把这些底层约束写进驱动层之后，TB6612FNG 才不再只是一个“能转的小模块”，而是一个能被闭环控制可靠调度的执行器。
