---
title: "技能档案：平衡车 PID 的离散真相，从姿态环位置式 PD 到速度环增量式 PI"
slug: "skill-balance-car-pid-discrete-cascade-and-anti-windup"
date: 2026-05-05T15:38:34+08:00
draft: false
description: "从倒立摆线性化、姿态环位置式 PD、速度环增量式 PI 到 PWM 限幅与抗积分饱和，系统拆解平衡车 PID 为什么本质上是一场带宽分配。"
tags: ["STM32", "PID", "平衡车", "离散控制", "运动控制"]
categories: ["技能档案", "电机控制", "控制与融合"]
image: ""
---

## 技能概述

平衡车里的 PID，从来不是“调三个参数让车别倒”这么浅的命题。它真正处理的是一个欠驱动倒立摆系统：车体想倒下去，电机只能通过驱动车轮先向前或向后逃跑，再靠地面对轮子的反作用力把质心重新拉回支撑区间。这个过程同时受陀螺仪零偏、编码器量化、电池压降、电机死区、采样周期抖动与 H 桥饱和限制。工程上最痛的点，不是 `HAL_TIM_PWM_Start()` 能不能出波，而是姿态环、速度环和执行层各自该吃掉哪些误差，谁该快，谁该慢，谁又必须在饱和时学会闭嘴。

## 核心底层概念解析

- **平衡车本质上是倒立摆，而不是“两个轮子的玩具车”**：在直立平衡点附近可用小角度近似 `sin(theta) ≈ theta`，车体俯仰动力学可粗略写成 `J * theta_ddot ≈ m * g * h * theta - tau_wheel`。这里的 `m * g * h * theta` 是不断把系统推离平衡点的重力项，控制器若不在足够短的时间里给出反向轮端力矩，系统会指数发散。
- **所谓 PID，在平衡车上通常不是单环，而是带宽分层的串级控制**：内环管姿态，外环管速度。姿态环必须足够快，典型带宽会比速度环高一个量级，否则外环还没来得及纠正漂移，车体就已经先倒了。工程上更像“先保命，再谈去哪儿”，而不是把所有误差一次性塞进一个大 PID。
- **姿态环更像位置式 PD，而不是完整位置式 PID**：直立平衡点本身就是零稳态偏差目标，姿态环如果盲目堆积分，反而容易在电机饱和、路面阻塞或抬车瞬间把积分项攒爆。更稳妥的形式通常是 `u_theta[k] = K_theta * (theta_ref[k] - theta[k]) - K_omega * omega[k]`，其中微分信息直接来自陀螺仪角速度 `omega[k]`，比对误差做数值微分更不怕噪声。
- **速度环常选增量式 PI，是因为它更适合慢变量与执行饱和共存**：速度外环负责把“车想往前跑”翻译成一个小幅前倾角参考 `theta_ref`。离散增量式 PI 可写成 `delta_u_v[k] = Kp_v * (e_v[k] - e_v[k-1]) + Ki_v * T_s * e_v[k]`，再令 `u_v[k] = clamp(u_v[k-1] + delta_u_v[k], -theta_max, theta_max)`。这样做的好处，是输出天然围绕上一拍修正，不会像位置式积分那样在饱和时把绝对积分量越攒越离谱。
- **采样周期不是实现细节，而是控制律的一部分**：无论积分项里的 `Ki * T_s`，还是微分阻尼对应的等效离散极点，都直接依赖采样周期 `T_s`。若控制任务名义上每 `5 ms` 运行一次，实际却因为串口阻塞、IMU 读取超时或中断嵌套变成 `3 ms` 和 `8 ms` 来回抖，积分会失真，速度估计也会错。定时器提供的不是“方便”，而是离散控制的物理契约。
- **编码器速度不是直接可用真值，而是计数差分后的带噪估计**：若每轮等效一圈脉冲数为 `N_rev`，轮半径为 `r`，则平均线速度满足 `v[k] = r * 2 * pi * (delta_n_l[k] + delta_n_r[k]) / (2 * N_rev * T_s)`。低速时 `delta_n` 很小，量化误差会非常重，因此速度环必须比姿态环更慢，并常配合一阶低通，否则你调的不是速度，而是编码器抖动。
- **控制器输出不是“抽象努力值”，最终必须映射成受电池电压约束的 PWM**：H 桥平均输出电压近似满足 `V_motor ≈ duty * V_bat`，所以目标电压 `V_cmd` 对应的理想占空比近似为 `duty = V_cmd / V_bat`。但实际系统还存在静摩擦与驱动死区，故常要使用 `PWM = PWM_dead + duty * (ARR - PWM_dead)` 的线性补偿映射，否则命令刚离开零点时轮子根本不动。
- **抗积分饱和的关键，不是“少积分”，而是承认执行器有边界**：一旦电机已顶到最大占空比，外环再继续累积“还不够快”的误差，只会在系统重新可控时造成大幅过冲。更合理的做法，是把速度环输出限成一个可实现的俯仰参考区间，例如 `theta_ref ∈ [-0.12 rad, 0.12 rad]`，并在跌倒、抱死或离地时清空外环状态。
- **资源调度决定控制质感**：PWM 载波通常在 `10 kHz ~ 20 kHz`，姿态控制周期常在 `2 ms ~ 5 ms`，编码器测速与 IMU 融合又各有自己的更新时间。把这些任务都塞进主循环里“尽量快地跑”，最后得到的往往不是实时，而是相位噪声。可靠的平衡车系统会让 PWM、控制中断、传感器采样和慢速通信各守一条时基。
- **平衡不是“零角度”，而是让质心与轮地接触点的相对运动受控**：外环给一个前倾角参考，本质上是在允许系统暂时离开几何直立点，以换取对位置或速度的可控性。控制系统不是消灭偏差，而是在多个偏差之间做受约束的交换，这就是闭环最有意思的地方。

## 代码能力展现

下面给出一个基于 STM32 HAL 的串级控制示例。代码刻意把主题聚焦在三件事上：**姿态环位置式 PD、速度环增量式 PI、以及从目标电压到 PWM 的可实现映射**。示例假定 IMU 融合模块已经提供俯仰角 `pitch_rad` 与角速度 `pitch_rate_rad_s`，编码器定时器已经能给出每个控制周期内的左右轮增量脉冲。

```c
#include "stm32f4xx_hal.h"
#include <math.h>
#include <stdbool.h>
#include <stdint.h>

#define BALANCE_PI_F                    3.14159265358979323846f
#define BALANCE_SPEED_LPF_ALPHA_DEFAULT 0.35f

typedef struct
{
    GPIO_TypeDef *in1_port;
    uint16_t in1_pin;
    GPIO_TypeDef *in2_port;
    uint16_t in2_pin;
    TIM_HandleTypeDef *pwm_timer;
    uint32_t pwm_channel;
} BalanceMotor_t;

typedef struct
{
    TIM_HandleTypeDef *timebase_timer;   /* 1 MHz 自由运行计数器，用于实测 dt。 */
    BalanceMotor_t left_motor;
    BalanceMotor_t right_motor;
    float wheel_radius_m;
    float gear_ratio;
    float encoder_counts_per_rev;
    float control_dt_nominal_s;
    float control_dt_min_s;
    float control_dt_max_s;
    float speed_lpf_alpha;
    float angle_kp;
    float gyro_kd;
    float speed_kp;
    float speed_ki;
    float speed_trim_limit_rad;
    float motor_voltage_limit_v;
    float battery_voltage_floor_v;
    float tilt_shutdown_limit_rad;
    uint16_t pwm_arr;
    uint16_t pwm_deadzone_ticks;
} BalanceConfig_t;

typedef struct
{
    int32_t delta_left_count;
    int32_t delta_right_count;
    float pitch_rad;
    float pitch_rate_rad_s;
    float battery_voltage_v;
} BalanceFeedback_t;

typedef struct
{
    float speed_ref_m_s;
} BalanceCommand_t;

typedef struct
{
    float filtered_speed_m_s;
    float speed_error_prev;
    float speed_trim_rad;
    uint32_t last_tick_us;
    bool enabled;
} BalanceState_t;

typedef struct
{
    BalanceConfig_t cfg;
    BalanceState_t state;
} BalanceController_t;

extern TIM_HandleTypeDef htim1;
extern TIM_HandleTypeDef htim3;
extern TIM_HandleTypeDef htim5;

static BalanceController_t g_balance =
{
    .cfg =
    {
        .timebase_timer = &htim5,
        .left_motor =
        {
            .in1_port = GPIOB,
            .in1_pin = GPIO_PIN_12,
            .in2_port = GPIOB,
            .in2_pin = GPIO_PIN_13,
            .pwm_timer = &htim1,
            .pwm_channel = TIM_CHANNEL_1
        },
        .right_motor =
        {
            .in1_port = GPIOB,
            .in1_pin = GPIO_PIN_14,
            .in2_port = GPIOB,
            .in2_pin = GPIO_PIN_15,
            .pwm_timer = &htim1,
            .pwm_channel = TIM_CHANNEL_2
        },
        .wheel_radius_m = 0.0325f,
        .gear_ratio = 30.0f,
        .encoder_counts_per_rev = 13.0f,
        .control_dt_nominal_s = 0.005f,
        .control_dt_min_s = 0.0035f,
        .control_dt_max_s = 0.0065f,
        .speed_lpf_alpha = BALANCE_SPEED_LPF_ALPHA_DEFAULT,
        .angle_kp = 34.0f,
        .gyro_kd = 1.15f,
        .speed_kp = 0.065f,
        .speed_ki = 0.48f,
        .speed_trim_limit_rad = 0.12f,
        .motor_voltage_limit_v = 10.5f,
        .battery_voltage_floor_v = 7.0f,
        .tilt_shutdown_limit_rad = 0.55f,
        .pwm_arr = 1999U,
        .pwm_deadzone_ticks = 140U
    },
    .state =
    {
        .enabled = true
    }
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
 * @brief 读取本次控制步长 dt，并对定时抖动进行限幅。
 * @param controller 控制器对象。
 * @retval 实际采用的控制步长，单位 s。
 *
 * @note 增量式 PI 与速度估计都显式依赖 dt：
 *       1) delta_u[k] = Kp * (e[k] - e[k-1]) + Ki * dt * e[k]
 *       2) v[k] = delta_s / dt
 *       若 dt 因中断抖动突然过大或过小，会直接扭曲积分量与测速结果，
 *       因此这里在名义区间 [dt_min, dt_max] 内做边界限幅。
 */
static float Balance_ReadControlDt(BalanceController_t *controller)
{
    const uint32_t now_us = __HAL_TIM_GET_COUNTER(controller->cfg.timebase_timer);
    BalanceState_t *state = &controller->state;
    uint32_t delta_us = 0U;

    if (state->last_tick_us == 0U)
    {
        state->last_tick_us = now_us;
        return controller->cfg.control_dt_nominal_s;
    }

    delta_us = now_us - state->last_tick_us;
    state->last_tick_us = now_us;

    return Balance_ClampFloat((float)delta_us * 1.0e-6f,
                              controller->cfg.control_dt_min_s,
                              controller->cfg.control_dt_max_s);
}

/**
 * @brief 将编码器增量脉冲映射为车体前向速度，并做一阶低通。
 * @param controller 控制器对象。
 * @param feedback 本周期反馈量。
 * @param dt_s 实际控制步长，单位 s。
 * @retval 低通后的速度估计，单位 m/s。
 *
 * @note 速度映射关系：
 *       counts_per_wheel_rev = encoder_counts_per_rev * gear_ratio
 *       wheel_omega = 2*pi*delta_count_avg / (counts_per_wheel_rev * dt)
 *       v = wheel_radius * wheel_omega
 *       低速时 delta_count 很小，量化误差重，因此附加：
 *       v_f[k] = alpha * v_raw[k] + (1 - alpha) * v_f[k-1]
 */
static float Balance_UpdateSpeedEstimate(BalanceController_t *controller,
                                         const BalanceFeedback_t *feedback,
                                         float dt_s)
{
    const float counts_per_wheel_rev =
        controller->cfg.encoder_counts_per_rev * controller->cfg.gear_ratio;
    const float delta_count_avg =
        0.5f * ((float)feedback->delta_left_count + (float)feedback->delta_right_count);
    const float wheel_omega_rad_s =
        (2.0f * BALANCE_PI_F * delta_count_avg) / (counts_per_wheel_rev * dt_s);
    const float raw_speed_m_s = controller->cfg.wheel_radius_m * wheel_omega_rad_s;
    const float alpha = Balance_ClampFloat(controller->cfg.speed_lpf_alpha, 0.05f, 1.0f);

    controller->state.filtered_speed_m_s =
        (alpha * raw_speed_m_s) + ((1.0f - alpha) * controller->state.filtered_speed_m_s);

    return controller->state.filtered_speed_m_s;
}

/**
 * @brief 速度外环：用增量式 PI 生成俯仰参考角。
 * @param controller 控制器对象。
 * @param speed_ref_m_s 目标速度，单位 m/s。
 * @param speed_meas_m_s 当前速度估计，单位 m/s。
 * @param dt_s 实际控制步长，单位 s。
 * @retval 限幅后的俯仰参考角，单位 rad。
 *
 * @note 采用增量式 PI：
 *       delta_trim[k] = Kp_v * (e[k] - e[k-1]) + Ki_v * dt * e[k]
 *       trim[k] = clamp(trim[k-1] + delta_trim[k], -theta_max, theta_max)
 *       这里 trim 不是“积分器本体”，而是速度环交给姿态环的期望前倾角。
 *       限到 theta_max 之后，即便速度误差仍存在，也不允许外环继续索要
 *       超出可实现范围的姿态，从而抑制饱和后的积分失控。
 */
static float Balance_UpdateSpeedLoop(BalanceController_t *controller,
                                     float speed_ref_m_s,
                                     float speed_meas_m_s,
                                     float dt_s)
{
    const float error = speed_ref_m_s - speed_meas_m_s;
    const float delta_trim =
        (controller->cfg.speed_kp * (error - controller->state.speed_error_prev)) +
        (controller->cfg.speed_ki * dt_s * error);

    controller->state.speed_trim_rad =
        Balance_ClampFloat(controller->state.speed_trim_rad + delta_trim,
                           -controller->cfg.speed_trim_limit_rad,
                           controller->cfg.speed_trim_limit_rad);
    controller->state.speed_error_prev = error;

    return controller->state.speed_trim_rad;
}

/**
 * @brief 将目标电机平均电压映射为 PWM 比较值。
 * @param controller 控制器对象。
 * @param command_voltage_v 目标电机平均电压，带符号。
 * @param battery_voltage_v 当前电池电压。
 * @retval PWM 比较值，范围 [0, pwm_arr]。
 *
 * @note 近似关系：
 *       V_motor ≈ duty * V_bat
 *       duty = |V_cmd| / V_bat
 *       若考虑低占空比死区，则线性映射为：
 *       pwm = pwm_dead + duty * (ARR - pwm_dead)
 *       这样 0 附近的命令不会因为桥臂压降和静摩擦而完全失效。
 */
static uint16_t Balance_MapVoltageToPwm(const BalanceController_t *controller,
                                        float command_voltage_v,
                                        float battery_voltage_v)
{
    const float safe_vbat =
        Balance_ClampFloat(battery_voltage_v,
                           controller->cfg.battery_voltage_floor_v,
                           32.0f);
    const float limited_voltage =
        Balance_ClampFloat(fabsf(command_voltage_v),
                           0.0f,
                           controller->cfg.motor_voltage_limit_v);
    const float duty = Balance_ClampFloat(limited_voltage / safe_vbat, 0.0f, 1.0f);
    const float pwm_span = (float)controller->cfg.pwm_arr - (float)controller->cfg.pwm_deadzone_ticks;
    float pwm_f = 0.0f;

    if (duty <= 0.0f)
    {
        return 0U;
    }

    pwm_f = (float)controller->cfg.pwm_deadzone_ticks + (duty * pwm_span);
    pwm_f = Balance_ClampFloat(pwm_f, 0.0f, (float)controller->cfg.pwm_arr);
    return (uint16_t)lroundf(pwm_f);
}

/**
 * @brief 向单个电机下发带方向的 PWM 命令。
 * @param motor 电机句柄。
 * @param pwm_compare 比较值，范围 [0, ARR]。
 * @param forward true 为前进，false 为后退。
 */
static void Balance_SetMotorOutput(const BalanceMotor_t *motor,
                                   uint16_t pwm_compare,
                                   bool forward)
{
    if (pwm_compare == 0U)
    {
        /* 关闭双边输出，避免悬空状态下的随机导通。 */
        HAL_GPIO_WritePin(motor->in1_port, motor->in1_pin, GPIO_PIN_RESET);
        HAL_GPIO_WritePin(motor->in2_port, motor->in2_pin, GPIO_PIN_RESET);
        __HAL_TIM_SET_COMPARE(motor->pwm_timer, motor->pwm_channel, 0U);
        return;
    }

    HAL_GPIO_WritePin(motor->in1_port, motor->in1_pin, forward ? GPIO_PIN_SET : GPIO_PIN_RESET);
    HAL_GPIO_WritePin(motor->in2_port, motor->in2_pin, forward ? GPIO_PIN_RESET : GPIO_PIN_SET);
    __HAL_TIM_SET_COMPARE(motor->pwm_timer, motor->pwm_channel, pwm_compare);
}

/**
 * @brief 平衡控制主步骤：姿态内环位置式 PD + 速度外环增量式 PI。
 * @param controller 控制器对象。
 * @param command 目标指令。
 * @param feedback 传感器反馈。
 *
 * @note 姿态环控制律采用：
 *       u_theta[k] = K_theta * (theta_ref[k] - theta[k]) - K_omega * omega[k]
 *       其中 theta_ref 由速度外环生成，omega 直接取陀螺仪角速度。
 *       与传统位置式 PID 相比，这里故意不在姿态环叠加积分，是为了避免
 *       直立点附近的饱和累积与抬车场景下的积分爆炸。
 */
void Balance_ControlStep(BalanceController_t *controller,
                         const BalanceCommand_t *command,
                         const BalanceFeedback_t *feedback)
{
    float dt_s = 0.0f;
    float speed_meas_m_s = 0.0f;
    float tilt_ref_rad = 0.0f;
    float angle_error_rad = 0.0f;
    float motor_voltage_cmd_v = 0.0f;
    uint16_t pwm_compare = 0U;

    if ((controller == NULL) || (command == NULL) || (feedback == NULL) || (!controller->state.enabled))
    {
        return;
    }

    if (fabsf(feedback->pitch_rad) >= controller->cfg.tilt_shutdown_limit_rad)
    {
        /* 跌倒保护：车体偏角过大时立即停机，并清空外环状态。 */
        controller->state.filtered_speed_m_s = 0.0f;
        controller->state.speed_error_prev = 0.0f;
        controller->state.speed_trim_rad = 0.0f;
        Balance_SetMotorOutput(&controller->cfg.left_motor, 0U, true);
        Balance_SetMotorOutput(&controller->cfg.right_motor, 0U, true);
        return;
    }

    dt_s = Balance_ReadControlDt(controller);
    speed_meas_m_s = Balance_UpdateSpeedEstimate(controller, feedback, dt_s);
    tilt_ref_rad = Balance_UpdateSpeedLoop(controller,
                                           command->speed_ref_m_s,
                                           speed_meas_m_s,
                                           dt_s);

    angle_error_rad = tilt_ref_rad - feedback->pitch_rad;
    motor_voltage_cmd_v =
        (controller->cfg.angle_kp * angle_error_rad) -
        (controller->cfg.gyro_kd * feedback->pitch_rate_rad_s);
    motor_voltage_cmd_v =
        Balance_ClampFloat(motor_voltage_cmd_v,
                           -controller->cfg.motor_voltage_limit_v,
                           controller->cfg.motor_voltage_limit_v);

    pwm_compare = Balance_MapVoltageToPwm(controller,
                                          motor_voltage_cmd_v,
                                          feedback->battery_voltage_v);

    Balance_SetMotorOutput(&controller->cfg.left_motor, pwm_compare, motor_voltage_cmd_v >= 0.0f);
    Balance_SetMotorOutput(&controller->cfg.right_motor, pwm_compare, motor_voltage_cmd_v >= 0.0f);
}

void App_BalanceControlIsr(void)
{
    BalanceCommand_t command = {0};
    BalanceFeedback_t feedback = {0};

    /* 示例约定：
     * 1. command.speed_ref_m_s 来自更慢的遥控或速度规划层；
     * 2. feedback.pitch_rad / pitch_rate_rad_s 来自 IMU 融合结果；
     * 3. delta_left_count / delta_right_count 为当前控制周期内编码器增量。
     */
    Balance_ControlStep(&g_balance, &command, &feedback);
}

void HAL_TIM_PeriodElapsedCallback(TIM_HandleTypeDef *htim)
{
    if (htim->Instance == TIM6)
    {
        App_BalanceControlIsr();
    }
}
```

这段代码背后的关键不是“PID 写对了”，而是**把控制目标拆给了不同层级**：速度环只负责慢慢改变允许的前倾角，姿态环负责用更高带宽把车体拉回这个参考，执行层再把有限电池电压翻译成真实 PWM。平衡车真正稳定的时刻，不是误差归零的时刻，而是每一层都只承担自己那一层该承担的不确定性。
