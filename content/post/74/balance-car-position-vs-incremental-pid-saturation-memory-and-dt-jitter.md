---
title: "技能档案：平衡车位置式 PID 与增量式 PID 的离散实现差异、饱和记忆与采样抖动"
slug: "skill-balance-car-position-vs-incremental-pid-saturation-memory-and-dt-jitter"
date: 2026-06-29T11:53:58+08:00
draft: false
description: "从倒立摆离散化、位置式与增量式 PID 的状态记忆、执行器饱和、编码器量化到采样抖动，系统拆解平衡车为何换一种 PID 写法就像换了一套误差分配契约。"
tags: ["STM32", "PID", "平衡车", "离散控制", "位置式PID", "增量式PID"]
categories: ["技能档案"]
image: ""
---

## 技能概述

平衡车里的 `PID` 从来不是把 `Kp/Ki/Kd` 填进公式就结束的题目。对同一台车、同一组参数，单纯把控制器从**位置式**改成**增量式**，闭环手感都可能明显变化，原因不在于“数学突然变了”，而在于 **误差被记忆在什么状态里、饱和后谁继续累积、采样抖动和量化噪声又先污染哪一项**。这个主题真正解决的，不是背出两条离散公式，而是把倒立摆的时域约束、执行器边界和数字实现的状态记忆串成一条完整链路，看清楚为什么“同名 PID”在 MCU 上常常并不是同一种工程对象。

## 核心底层概念解析

- **平衡车首先是一个右半平面不稳定系统**：在直立点附近，俯仰动力学可线性化为 `J * theta_ddot = m * g * h * theta - tau_wheel`。重力项天然把系统推出平衡点，控制器哪怕一个采样周期给错方向，都会直接损失相位裕量。位置式和增量式的差异，最终都要回到这条不稳定极点能否被及时拉回。

- **位置式与增量式在理想线性、固定采样、永不饱和的条件下同源**：若连续控制律写成 `u = Kp * e + Ki * integral(e) + Kd * de/dt`，离散后可得到  
  `u[k] = Kp * e[k] + I[k] + D[k]`，  
  也可写成  
  `Delta u[k] = u[k] - u[k-1]`。  
  纸面上两者只是不同的状态表示；一旦进入有限字长、驱动限幅和调度抖动的 MCU 世界，它们就不再等价。

- **位置式 PID 记住的是“绝对控制意图”**：典型写法是  
  `u[k] = Kp * e[k] + I[k] - Kd * omega[k]`，  
  `I[k] = I[k-1] + Ki * T_s * e[k]`。  
  它把“我此刻一共想给电机多大电压”直接保存在积分和总输出里，优点是可解释性强，缺点是**一旦饱和，绝对意图很容易继续膨胀**。

- **增量式 PID 记住的是“相对修正量”**：如果对同一个 `P + I - D_meas` 结构做差分，可得  
  `Delta u[k] = Kp * (e[k] - e[k-1]) + Ki * T_s * e[k] - Kd * (omega[k] - omega[k-1])`，  
  `u[k] = u[k-1] + Delta u[k]`。  
  它不是每拍重算一个绝对目标，而是在上一拍输出上做小步修正，因此更像“沿着现有电压轨迹推一把”，这对执行器分辨率有限的系统很有吸引力。

- **两种形式真正分叉的地方，是饱和后的状态记忆**：位置式里若没有抗积分饱和，`I[k]` 会在 `PWM` 顶到头之后继续变大；增量式里即便输出被夹住，`u[k-1]` 仍然是被限幅后的历史结果，若再允许 `Delta u` 同向继续累积，也会形成另一种“饱和记忆”。区别不在于谁天然不会积分饱和，而在于**该冻结哪一段状态、冻结条件是否和执行器边界对齐**。

- **采样抖动会在两种实现里投影到不同位置**：`T_s` 进入积分项的方式都是 `Ki * T_s * e[k]`，但位置式把它直接写进 `I[k]`，增量式则写进 `Delta u[k]` 再累加到 `u[k]`。同样一次 `5 ms` 漂到 `8 ms` 的调度抖动，在位置式里像“本拍积分多吃了一口”，在增量式里像“本拍输出多迈了一步”，它们对瞬态手感的影响并不一样。

- **量化噪声会先污染差分项**：平衡车速度估计来自编码器计数差分，姿态阻尼常来自陀螺仪角速度。增量式天然更依赖“本拍和上一拍的差”，因此对 `e[k] - e[k-1]`、`omega[k] - omega[k-1]` 这类差分更敏感；位置式虽然也要处理导数项，但其主输出仍由当前绝对误差主导，低速区通常更容易读懂和调参。

- **参考突变与导数踢也会改变你对两种实现的判断**：在平衡车里，导数项若直接对误差做差分，遥控给一个速度阶跃就会把 `theta_ref` 的跳变放大成一记导数踢。更可靠的工程做法是让 `D` 项盯着测量量 `omega`，也就是把阻尼理解为对真实角速度的反作用，而不是对参考边沿的敏感放大。

- **电池压降、桥臂压降和静摩擦让“同一个 u”不等于“同一个力矩”**：控制器算出来的是目标平均电压，真正作用到轮上的却是 `V_motor ~= duty * V_bat - V_drop`。当 `V_bat` 下滑、`H` 桥死区又吃掉一段低占空比区间时，位置式和增量式看到的“输出没效果”会被记忆成不同的内部状态，这也是同参异感的根源之一。

- **资源调度决定你看到的是控制差异，还是时间戳差异**：`IMU` 读取、姿态融合、编码器快照和控制 ISR 若不在同一时间基下，位置式/增量式的对比实验就会被 `dt` 漂移和旧数据混入污染。很多人以为自己在比较算法，实际上比较的是谁对调度噪声更不耐受。

- **技术哲学上，两种 PID 的区别不是公式排版，而是闭环状态放在哪儿记账**：位置式把“总账”记在积分和绝对输出里，增量式把“流水账”记在上一拍输出和本拍修正里。只要系统存在限幅、噪声和时基不确定性，这两种记账方式就一定会导向不同的工程行为。

## 代码能力展现

下面给出一段基于 **STM32 HAL** 的平衡车姿态环实现。代码刻意让**同一套物理控制律**同时支持位置式和增量式两种离散状态表示，便于把差异压缩到“状态如何记忆、饱和如何处理、抖动如何投影”这三件事上，而不是混入完全不同的控制结构。

```c
#include "main.h"

#include <math.h>
#include <stdbool.h>
#include <stdint.h>

#define BALANCE_DT_DEFAULT_S                 0.005f
#define BALANCE_DT_MIN_S                     0.0035f
#define BALANCE_DT_MAX_S                     0.0065f

typedef enum
{
    BALANCE_PID_FORM_POSITION = 0,
    BALANCE_PID_FORM_INCREMENTAL = 1
} BalancePidForm_t;

typedef struct
{
    GPIO_TypeDef *in1_port;
    uint16_t in1_pin;
    GPIO_TypeDef *in2_port;
    uint16_t in2_pin;
    TIM_HandleTypeDef *htim_pwm;
    uint32_t tim_channel;
} BalanceMotorBridge_t;

typedef struct
{
    BalancePidForm_t form;
    float kp;
    float ki;
    float kd;
    float integrator_v;
    float integrator_limit_v;
    float output_limit_v;
    float delta_limit_v;
    float anti_windup_gain;
    float error_z1;
    float gyro_z1;
    float last_output_v;
} BalancePid_t;

typedef struct
{
    TIM_HandleTypeDef *htim_timebase;
    BalanceMotorBridge_t left_motor;
    BalanceMotorBridge_t right_motor;
    BalancePid_t tilt_pid;
    float pitch_ref_limit_rad;
    float shutdown_pitch_rad;
    float battery_floor_v;
    uint16_t pwm_arr;
    uint16_t pwm_deadzone_ticks;
    uint32_t last_tick_us;
    bool enabled;
} BalanceController_t;

typedef struct
{
    float pitch_ref_rad;
    float pitch_rad;
    float gyro_rad_s;
    float battery_voltage_v;
} BalanceFeedback_t;

extern TIM_HandleTypeDef htim1;
extern TIM_HandleTypeDef htim5;

static BalanceController_t g_balance =
{
    .htim_timebase = &htim5,
    .left_motor =
    {
        .in1_port = GPIOB,
        .in1_pin = GPIO_PIN_12,
        .in2_port = GPIOB,
        .in2_pin = GPIO_PIN_13,
        .htim_pwm = &htim1,
        .tim_channel = TIM_CHANNEL_1
    },
    .right_motor =
    {
        .in1_port = GPIOB,
        .in1_pin = GPIO_PIN_14,
        .in2_port = GPIOB,
        .in2_pin = GPIO_PIN_15,
        .htim_pwm = &htim1,
        .tim_channel = TIM_CHANNEL_2
    },
    .tilt_pid =
    {
        .form = BALANCE_PID_FORM_POSITION,
        .kp = 32.0f,
        .ki = 18.0f,
        .kd = 1.15f,
        .integrator_v = 0.0f,
        .integrator_limit_v = 3.0f,
        .output_limit_v = 10.5f,
        .delta_limit_v = 1.8f,
        .anti_windup_gain = 0.35f,
        .error_z1 = 0.0f,
        .gyro_z1 = 0.0f,
        .last_output_v = 0.0f
    },
    .pitch_ref_limit_rad = 0.15f,
    .shutdown_pitch_rad = 0.60f,
    .battery_floor_v = 7.0f,
    .pwm_arr = 1999U,
    .pwm_deadzone_ticks = 130U,
    .last_tick_us = 0U,
    .enabled = true
};

static float Balance_ClampFloat(float value, float min_value, float max_value)
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
 * @brief 读取实际控制步长 dt，并对调度抖动做边界限幅。
 * @param controller 平衡车控制器。
 * @retval 本拍采用的 dt，单位 s。
 *
 * @note 对离散 PID，dt 不是附属参数，而是控制律本身的一部分：
 *       1. 位置式积分: I[k] = I[k-1] + Ki * dt * e[k]
 *       2. 增量式积分增量: Delta_u_i[k] = Ki * dt * e[k]
 *
 *       因此若 ISR 被串口、日志或低优先级任务打断，dt 漂移会直接改写
 *       每拍“积分吃进去多少”。这里把 dt 限在经验可信区间，避免单次异常
 *       调度把控制器状态拉飞。
 */
static float Balance_ReadDt(BalanceController_t *controller)
{
    const uint32_t now_us = __HAL_TIM_GET_COUNTER(controller->htim_timebase);
    uint32_t delta_us = 0U;

    if (controller->last_tick_us == 0U)
    {
        controller->last_tick_us = now_us;
        return BALANCE_DT_DEFAULT_S;
    }

    delta_us = now_us - controller->last_tick_us;
    controller->last_tick_us = now_us;

    return Balance_ClampFloat((float)delta_us * 1.0e-6f,
                              BALANCE_DT_MIN_S,
                              BALANCE_DT_MAX_S);
}

/**
 * @brief 把目标平均电机电压映射成 PWM 比较值。
 * @param controller 平衡车控制器。
 * @param voltage_cmd_v 目标电机平均电压，允许带符号。
 * @param battery_voltage_v 当前电池电压。
 * @retval PWM 比较值，范围 [0, ARR]。
 *
 * @note 线性映射关系：
 *       V_motor ~= duty * V_bat
 *       duty = |V_cmd| / V_bat
 *
 *       若考虑桥臂死区与静摩擦，则低占空比区域需要抬升：
 *       pwm = pwm_dead + duty * (ARR - pwm_dead)
 *
 *       这样 0 附近的微小控制电压不会全部淹没在驱动压降里。
 */
static uint16_t Balance_MapVoltageToPwm(const BalanceController_t *controller,
                                        float voltage_cmd_v,
                                        float battery_voltage_v)
{
    const float safe_vbat =
        Balance_ClampFloat(battery_voltage_v, controller->battery_floor_v, 32.0f);
    const float limited_voltage =
        Balance_ClampFloat(fabsf(voltage_cmd_v), 0.0f, controller->tilt_pid.output_limit_v);
    const float duty = Balance_ClampFloat(limited_voltage / safe_vbat, 0.0f, 1.0f);
    const float pwm_span = (float)controller->pwm_arr - (float)controller->pwm_deadzone_ticks;
    float pwm_f = 0.0f;

    if (duty <= 0.0f)
    {
        return 0U;
    }

    pwm_f = (float)controller->pwm_deadzone_ticks + duty * pwm_span;
    pwm_f = Balance_ClampFloat(pwm_f, 0.0f, (float)controller->pwm_arr);
    return (uint16_t)lroundf(pwm_f);
}

/**
 * @brief 清空 PID 内部状态。
 * @param pid PID 对象。
 */
static void BalancePid_Reset(BalancePid_t *pid)
{
    if (pid == NULL)
    {
        return;
    }

    pid->integrator_v = 0.0f;
    pid->error_z1 = 0.0f;
    pid->gyro_z1 = 0.0f;
    pid->last_output_v = 0.0f;
}

/**
 * @brief 位置式 PID：显式维护积分器和绝对输出。
 * @param pid PID 对象。
 * @param pitch_ref_rad 目标俯仰角，单位 rad。
 * @param pitch_rad 实测俯仰角，单位 rad。
 * @param gyro_rad_s 实测俯仰角速度，单位 rad/s。
 * @param dt_s 本拍控制步长，单位 s。
 * @retval 限幅后的目标电机平均电压，单位 V。
 *
 * @note 这里采用平衡车里更常见的 `P + I - D_meas` 结构：
 *       error = pitch_ref - pitch
 *       I[k] = I[k-1] + Ki * dt * error
 *       u_unsat = Kp * error + I[k] - Kd * gyro
 *
 *       与直接对误差做差分相比，`-Kd * gyro` 的写法可以减少参考突变带来的
 *       导数踢，因为阻尼项盯的是物理角速度而不是指令边沿。
 *
 *       抗饱和采用 back-calculation：
 *       I[k] <- I_candidate + Kaw * (u_sat - u_unsat)
 *       当执行器顶到边界时，反向把多余意图从积分器里抽回来。
 */
static float BalancePid_UpdatePosition(BalancePid_t *pid,
                                       float pitch_ref_rad,
                                       float pitch_rad,
                                       float gyro_rad_s,
                                       float dt_s)
{
    const float error = pitch_ref_rad - pitch_rad;
    const float integrator_candidate =
        pid->integrator_v + pid->ki * dt_s * error;
    const float u_unsat =
        pid->kp * error + integrator_candidate - pid->kd * gyro_rad_s;
    const float u_sat =
        Balance_ClampFloat(u_unsat, -pid->output_limit_v, pid->output_limit_v);
    const float anti_windup =
        pid->anti_windup_gain * (u_sat - u_unsat);

    pid->integrator_v =
        Balance_ClampFloat(integrator_candidate + anti_windup,
                           -pid->integrator_limit_v,
                           pid->integrator_limit_v);
    pid->error_z1 = error;
    pid->gyro_z1 = gyro_rad_s;
    pid->last_output_v = u_sat;

    return u_sat;
}

/**
 * @brief 增量式 PID：在上一拍输出上叠加本拍修正量。
 * @param pid PID 对象。
 * @param pitch_ref_rad 目标俯仰角，单位 rad。
 * @param pitch_rad 实测俯仰角，单位 rad。
 * @param gyro_rad_s 实测俯仰角速度，单位 rad/s。
 * @param dt_s 本拍控制步长，单位 s。
 * @retval 限幅后的目标电机平均电压，单位 V。
 *
 * @note 为了与位置式保持同一物理含义，这里对同一个 `P + I - D_meas`
 *       结构做离散增量化，而不是换一套完全不同的控制律：
 *
 *       Delta_u[k] =
 *           Kp * (e[k] - e[k-1]) +
 *           Ki * dt * e[k] -
 *           Kd * (gyro[k] - gyro[k-1])
 *
 *       u[k] = clamp(u[k-1] + Delta_u[k], -Umax, Umax)
 *
 *       这种写法的好处是输出天然围绕上一拍小步修正；坏处是它更依赖差分量，
 *       因而对编码器/IMU 噪声与 dt 抖动更敏感。
 */
static float BalancePid_UpdateIncremental(BalancePid_t *pid,
                                          float pitch_ref_rad,
                                          float pitch_rad,
                                          float gyro_rad_s,
                                          float dt_s)
{
    const float error = pitch_ref_rad - pitch_rad;
    const float delta_p = pid->kp * (error - pid->error_z1);
    float delta_i = pid->ki * dt_s * error;
    const float delta_d = -pid->kd * (gyro_rad_s - pid->gyro_z1);
    float delta_u = delta_p + delta_i + delta_d;
    float u_candidate = 0.0f;
    float u_sat = 0.0f;

    /*
     * 限制单拍电压跳变，避免一次异常采样把桥臂命令直接打满。
     * 这相当于给控制器附加一个离散 slew-rate 限制。
     */
    delta_u = Balance_ClampFloat(delta_u, -pid->delta_limit_v, pid->delta_limit_v);
    u_candidate = pid->last_output_v + delta_u;
    u_sat = Balance_ClampFloat(u_candidate, -pid->output_limit_v, pid->output_limit_v);

    /*
     * 若已经饱和且本拍积分仍试图继续朝同一方向推，就冻结积分增量。
     * 这样做的物理含义是：执行器已经没有更多可交付电压，不再允许
     * “不可实现的额外意图”继续写进内部状态。
     */
    if (((u_sat >= pid->output_limit_v) && (error > 0.0f)) ||
        ((u_sat <= -pid->output_limit_v) && (error < 0.0f)))
    {
        delta_i = 0.0f;
        delta_u = Balance_ClampFloat(delta_p + delta_i + delta_d,
                                     -pid->delta_limit_v,
                                     pid->delta_limit_v);
        u_candidate = pid->last_output_v + delta_u;
        u_sat = Balance_ClampFloat(u_candidate, -pid->output_limit_v, pid->output_limit_v);
    }

    pid->error_z1 = error;
    pid->gyro_z1 = gyro_rad_s;
    pid->last_output_v = u_sat;

    return u_sat;
}

/**
 * @brief 统一的 PID 更新入口。
 * @param pid PID 对象。
 * @param pitch_ref_rad 目标俯仰角，单位 rad。
 * @param pitch_rad 实测俯仰角，单位 rad。
 * @param gyro_rad_s 实测俯仰角速度，单位 rad/s。
 * @param dt_s 本拍控制步长，单位 s。
 * @retval 目标电机平均电压，单位 V。
 */
static float BalancePid_Update(BalancePid_t *pid,
                               float pitch_ref_rad,
                               float pitch_rad,
                               float gyro_rad_s,
                               float dt_s)
{
    if (pid->form == BALANCE_PID_FORM_INCREMENTAL)
    {
        return BalancePid_UpdateIncremental(pid,
                                            pitch_ref_rad,
                                            pitch_rad,
                                            gyro_rad_s,
                                            dt_s);
    }

    return BalancePid_UpdatePosition(pid,
                                     pitch_ref_rad,
                                     pitch_rad,
                                     gyro_rad_s,
                                     dt_s);
}

/**
 * @brief 向 H 桥下发带方向的 PWM 命令。
 * @param motor 电机桥臂。
 * @param pwm_compare PWM 比较值。
 * @param forward true 表示前进，false 表示后退。
 */
static void Balance_ApplyBridge(const BalanceMotorBridge_t *motor,
                                uint16_t pwm_compare,
                                bool forward)
{
    if (pwm_compare == 0U)
    {
        HAL_GPIO_WritePin(motor->in1_port, motor->in1_pin, GPIO_PIN_RESET);
        HAL_GPIO_WritePin(motor->in2_port, motor->in2_pin, GPIO_PIN_RESET);
        __HAL_TIM_SET_COMPARE(motor->htim_pwm, motor->tim_channel, 0U);
        return;
    }

    HAL_GPIO_WritePin(motor->in1_port, motor->in1_pin, forward ? GPIO_PIN_SET : GPIO_PIN_RESET);
    HAL_GPIO_WritePin(motor->in2_port, motor->in2_pin, forward ? GPIO_PIN_RESET : GPIO_PIN_SET);
    __HAL_TIM_SET_COMPARE(motor->htim_pwm, motor->tim_channel, pwm_compare);
}

/**
 * @brief 平衡车姿态环一步控制。
 * @param controller 平衡车控制器。
 * @param feedback 传感器反馈与上层给出的俯仰参考。
 *
 * @note 这里把 `pitch_ref_rad` 看成来自更慢速度环或遥控映射的外部参考。
 *       姿态内环只做两件事：
 *       1. 用位置式或增量式 PID 计算目标平均电机电压；
 *       2. 再把该电压按当前电池电压映射到可实现 PWM。
 *
 *       若车体偏角过大，则立即停机并清空内部记忆，避免抬车或跌倒状态下
 *       的状态继续累积，下一次落地时直接以打满命令起跳。
 */
void Balance_ControlStep(BalanceController_t *controller,
                         const BalanceFeedback_t *feedback)
{
    float dt_s = 0.0f;
    float pitch_ref_rad = 0.0f;
    float motor_voltage_cmd_v = 0.0f;
    uint16_t pwm_compare = 0U;
    bool forward = true;

    if ((controller == NULL) || (feedback == NULL) || (!controller->enabled))
    {
        return;
    }

    if (fabsf(feedback->pitch_rad) >= controller->shutdown_pitch_rad)
    {
        BalancePid_Reset(&controller->tilt_pid);
        Balance_ApplyBridge(&controller->left_motor, 0U, true);
        Balance_ApplyBridge(&controller->right_motor, 0U, true);
        return;
    }

    dt_s = Balance_ReadDt(controller);
    pitch_ref_rad =
        Balance_ClampFloat(feedback->pitch_ref_rad,
                           -controller->pitch_ref_limit_rad,
                           controller->pitch_ref_limit_rad);

    motor_voltage_cmd_v =
        BalancePid_Update(&controller->tilt_pid,
                          pitch_ref_rad,
                          feedback->pitch_rad,
                          feedback->gyro_rad_s,
                          dt_s);
    motor_voltage_cmd_v =
        Balance_ClampFloat(motor_voltage_cmd_v,
                           -controller->tilt_pid.output_limit_v,
                           controller->tilt_pid.output_limit_v);

    pwm_compare =
        Balance_MapVoltageToPwm(controller,
                                motor_voltage_cmd_v,
                                feedback->battery_voltage_v);
    forward = (motor_voltage_cmd_v >= 0.0f);

    Balance_ApplyBridge(&controller->left_motor, pwm_compare, forward);
    Balance_ApplyBridge(&controller->right_motor, pwm_compare, forward);
}

void App_BalanceUsePositionPid(void)
{
    g_balance.tilt_pid.form = BALANCE_PID_FORM_POSITION;
    BalancePid_Reset(&g_balance.tilt_pid);
}

void App_BalanceUseIncrementalPid(void)
{
    g_balance.tilt_pid.form = BALANCE_PID_FORM_INCREMENTAL;
    BalancePid_Reset(&g_balance.tilt_pid);
}

void App_BalanceControlIsr(void)
{
    BalanceFeedback_t feedback = {0};

    /*
     * 示例约定：
     * 1. pitch_ref_rad 由更慢的速度环或遥控输入给出；
     * 2. pitch_rad / gyro_rad_s 来自 IMU 融合结果；
     * 3. battery_voltage_v 来自 ADC 分压采样。
     *
     * 做位置式/增量式 A/B 对比时，必须保证这些输入来自同一时间戳快照，
     * 否则比较到的不是 PID 形式差异，而是数据时基差异。
     */
    Balance_ControlStep(&g_balance, &feedback);
}

void HAL_TIM_PeriodElapsedCallback(TIM_HandleTypeDef *htim)
{
    if (htim->Instance == TIM6)
    {
        App_BalanceControlIsr();
    }
}
```

这段代码里最关键的，不是把两套公式都实现出来，而是把它们放在**同一个物理约束下做对比**：同样的目标俯仰角、同样的电池压降、同样的 `PWM` 限幅和同样的 `dt` 抖动，最后看的就是“状态被写进哪里”。

工程上可以把经验先压缩成三句判断：

- **位置式 PID** 更适合你想清楚看见 `P/I/D` 各自出了多少力，并愿意认真做抗积分饱和的时候。
- **增量式 PID** 更适合执行器分辨率有限、输出需要小步修正的场景，但它对差分噪声和采样抖动通常更敏感。
- **平衡车最忌讳的是把两者当成完全等价的语法糖**。一旦系统里同时存在电机死区、电池压降、姿态噪声和控制任务抖动，位置式与增量式就不只是“写法不同”，而是两种不同的误差记账方式。

真正成熟的平衡车调参，不是先问“该用哪一种 PID”，而是先问：**你的饱和边界在哪里、你的时间基准稳不稳、你的内部状态准备让谁来记账**。这三个问题答清楚之后，位置式还是增量式，才会变成一个可以被验证的工程选择。
