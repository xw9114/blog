---
title: "技能档案：电机驱动 (TB6612FNG) 与死区控制"
slug: "skill-tb6612fng-motor-driver-deadzone-control"
date: 2026-04-22T10:21:42+08:00
draft: false
description: "从 H 桥导通路径、反电动势到 PWM 占空比补偿与换向死区，系统拆解 TB6612FNG 电机驱动的控制底层。"
tags: ["嵌入式", "电机驱动", "TB6612FNG", "PWM", "控制系统"]
categories: ["技能档案"]
image: ""
---

## 技能概述

电机驱动 (TB6612FNG) 与死区控制的价值，不在于“让电机转起来”，而在于把 MCU 输出的低功率数字逻辑，转译成直流电机可吸收、可换向、可调制的能量流。它广泛用于平衡车、双轮差速底盘、云台、机械臂与小型泵阀控制，解决的核心痛点是：PWM 占空比和机械转矩并非线性对应，低占空比会被静摩擦、反电动势与桥臂压降吞掉，换向瞬间还可能出现电流冲击与控制抖动，最终导致“指令已出、执行不动”或“刚一反转就猛抽一下”。

## 核心底层概念解析

- **TB6612FNG 本质上是一组 CMOS H 桥，而不是一个“黑盒驱动板”**：`AIN1/AIN2` 与 `BIN1/BIN2` 决定桥臂导通拓扑，`PWMA/PWMB` 决定导通时间占比，`STBY` 决定整颗芯片是否参与能量交换。MCU 发出的不是“前进”命令，而是对四个 MOS 管导通时序的离散裁决。
- **电机看到的不是占空比，而是平均端电压与绕组电流**：在 PWM 周期足够高、绕组电感足够大时，可近似认为 `V_avg ≈ Duty × V_bat - V_drop`。但真正决定能否起转的是 **电磁转矩** 是否大于 **静摩擦 + 负载转矩**。所以 5% 的 PWM 也许在示波器上存在，在机械世界里却等于零。
- **所谓“死区”首先是机电系统的启动死区**：小车悬空测试能转，不代表落地后能转。**碳刷接触电阻、齿轮箱背隙、静摩擦、供电内阻、驱动压降** 会共同抬高起转门槛。控制器若不显式补偿这段区间，低速调节就会表现为长时间无响应，随后突然越过阈值猛然启动。
- **换向死区是另一层安全边界**：当前进桥臂刚关断、反向桥臂立刻导通时，电机绕组电流不会瞬间归零，反电动势也不会礼貌地等你。若软件在相邻控制周期直接翻转方向，桥臂与绕组中残余能量会把瞬态电流抬高，表现为电流尖峰、供电下沉、EMI 增强与机械冲击。工程上需要一个很短的 **break-before-make** 时间窗，让能量先退场，再让新方向接管。
- **短刹车与滑行不是一回事**：TB6612FNG 可通过输入组合让电机进入 **Short Brake** 或 **Stop/Coast**。短刹车是把电机端子低阻短接，让反电动势迅速耗散；滑行则是切断驱动，让转子靠惯性与负载自然衰减。前者像强行收束能量，后者像撤掉推力。控制器必须知道自己想要的是“快停”还是“顺滑过零”。
- **PWM 频率是在听觉、开关损耗与电流纹波之间做折中**：频率太低，电机会啸叫、转矩脉动明显；频率太高，MOS 开关损耗、驱动器发热和定时器分辨率都会变差。对小型直流电机，工程上常把 PWM 放到 10 kHz 到 20 kHz 区间，本质上是在时间分辨率与能量平滑度之间找平衡。
- **死区补偿不是为了“造假线性”，而是为了恢复可控性**：当输入 `u` 映射到执行端时，真实系统往往存在 `|u| < u_dead` 几乎无响应的平段。把控制量先跨过启动门槛，再在剩余区间内线性展开，本质上是在重建“数字命令 -> 机械输出”的单调关系。闭环控制最怕的不是非线性，而是不可预测的非线性。
- **驱动层是控制系统的能量接口，而不是附属配件**：PID 算法再漂亮，若驱动层没有处理死区、限幅、换向保护与待机控制，最终都会在执行端失真。控制回路里每一位数值都想指挥物理世界，而驱动芯片就是这道翻译工作的最后一层语法。

## 代码能力展现

下面给出一个基于 STM32 HAL 的 TB6612FNG 单电机驱动示例：上层输入统一使用 `[-1000, 1000]` 的归一化控制量，驱动层负责完成启动死区补偿、方向翻转死区保护、PWM 占空比映射与 GPIO 桥臂控制。代码重点不在“把 IN1/IN2 拉高拉低”，而在 **如何把不理想的机电执行器重新整理成一个可预测、可限幅、可闭环的输出对象**。

```c
#include "stm32f4xx_hal.h"
#include <stdint.h>

#define TB6612_CMD_MAX_PERMILLE          1000
#define TB6612_PWM_PERIOD_MIN            100U
#define TB6612_START_DUTY_MAX_PERMILLE   950U
#define TB6612_REVERSE_DEADTIME_MAX      100U

typedef enum
{
    TB6612_DIR_COAST = 0,
    TB6612_DIR_FORWARD,
    TB6612_DIR_REVERSE
} Tb6612Direction_t;

typedef struct
{
    TIM_HandleTypeDef *htim_pwm;
    uint32_t pwm_channel;

    GPIO_TypeDef *in1_port;
    uint16_t in1_pin;
    GPIO_TypeDef *in2_port;
    uint16_t in2_pin;
    GPIO_TypeDef *stby_port;
    uint16_t stby_pin;

    uint16_t pwm_period;
    uint16_t start_duty_permille;
    uint16_t command_threshold_permille;
    uint16_t reverse_deadtime_ticks;

    uint16_t reverse_guard_ticks;
    Tb6612Direction_t active_dir;
} Tb6612Motor_t;

static uint16_t ClampU16(uint16_t value, uint16_t min_value, uint16_t max_value)
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

static int16_t ClampS16(int16_t value, int16_t min_value, int16_t max_value)
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

static uint16_t AbsS16(int16_t value)
{
    int32_t temp = value;

    if (temp < 0)
    {
        temp = -temp;
    }

    return (uint16_t)temp;
}

static void Tb6612_WriteBridge(Tb6612Motor_t *motor, Tb6612Direction_t dir)
{
    GPIO_PinState in1 = GPIO_PIN_RESET;
    GPIO_PinState in2 = GPIO_PIN_RESET;

    switch (dir)
    {
        case TB6612_DIR_FORWARD:
            in1 = GPIO_PIN_SET;
            in2 = GPIO_PIN_RESET;
            break;

        case TB6612_DIR_REVERSE:
            in1 = GPIO_PIN_RESET;
            in2 = GPIO_PIN_SET;
            break;

        case TB6612_DIR_COAST:
        default:
            /* 双输入同时拉低，桥臂断开，电机进入滑行。 */
            in1 = GPIO_PIN_RESET;
            in2 = GPIO_PIN_RESET;
            break;
    }

    HAL_GPIO_WritePin(motor->in1_port, motor->in1_pin, in1);
    HAL_GPIO_WritePin(motor->in2_port, motor->in2_pin, in2);
}

static void Tb6612_ApplyCoast(Tb6612Motor_t *motor)
{
    __HAL_TIM_SET_COMPARE(motor->htim_pwm, motor->pwm_channel, 0U);
    Tb6612_WriteBridge(motor, TB6612_DIR_COAST);
}

static uint16_t Tb6612_MapCommandToCompare(Tb6612Motor_t *motor, uint16_t abs_command_permille)
{
    uint32_t effective_permille;
    uint32_t numerator;
    uint32_t compare;
    uint16_t threshold;
    uint16_t start_duty;

    threshold = ClampU16(motor->command_threshold_permille, 0U, 999U);
    start_duty = ClampU16(motor->start_duty_permille, 0U, TB6612_START_DUTY_MAX_PERMILLE);
    abs_command_permille = ClampU16(abs_command_permille, 0U, TB6612_CMD_MAX_PERMILLE);

    if (abs_command_permille <= threshold)
    {
        return 0U;
    }

    /* 启动死区补偿的线性映射公式：
     *
     * duty_eff = duty_start
     *          + (cmd_abs - cmd_th) * (1000 - duty_start) / (1000 - cmd_th)
     *
     * 其中：
     * - cmd_abs    为输入控制量绝对值，范围 [0, 1000]。
     * - cmd_th     为启动阈值，低于该值时视为“命令存在但转矩不足以起转”。
     * - duty_start 为刚越过阈值时施加的最小有效 PWM，占空比千分比。
     *
     * 这样做的目的，不是把非线性系统伪装成理想线性系统，
     * 而是确保命令一旦越过启动门槛，就能立刻得到足以克服静摩擦的能量。
     */
    numerator = (uint32_t)(abs_command_permille - threshold) * (TB6612_CMD_MAX_PERMILLE - start_duty);
    effective_permille = (uint32_t)start_duty + numerator / (TB6612_CMD_MAX_PERMILLE - threshold);

    /* PWM 比较值计算公式：
     * compare = duty_eff / 1000 * pwm_period
     *
     * 这里使用四舍五入，减小低占空比区域的量化误差。
     */
    compare = ((effective_permille * motor->pwm_period) + 500U) / 1000U;

    return ClampU16((uint16_t)compare, 0U, motor->pwm_period);
}

/**
 * @brief 启动 TB6612FNG 单路电机 PWM 输出并释放待机。
 * @param motor 电机驱动句柄，需预先填好 PWM 句柄、通道、GPIO 与参数。
 * @retval HAL_OK 启动成功。
 * @retval HAL_ERROR 参数非法或 HAL 启动失败。
 */
HAL_StatusTypeDef Tb6612_Start(Tb6612Motor_t *motor)
{
    if ((motor == NULL) ||
        (motor->htim_pwm == NULL) ||
        (motor->in1_port == NULL) ||
        (motor->in2_port == NULL) ||
        (motor->stby_port == NULL))
    {
        return HAL_ERROR;
    }

    motor->pwm_period = ClampU16(motor->pwm_period, TB6612_PWM_PERIOD_MIN, 65535U);
    motor->start_duty_permille = ClampU16(motor->start_duty_permille, 0U, TB6612_START_DUTY_MAX_PERMILLE);
    motor->command_threshold_permille = ClampU16(motor->command_threshold_permille, 0U, 999U);
    motor->reverse_deadtime_ticks = ClampU16(motor->reverse_deadtime_ticks, 0U, TB6612_REVERSE_DEADTIME_MAX);
    motor->reverse_guard_ticks = 0U;
    motor->active_dir = TB6612_DIR_COAST;

    __HAL_TIM_SET_AUTORELOAD(motor->htim_pwm, motor->pwm_period);
    __HAL_TIM_SET_COMPARE(motor->htim_pwm, motor->pwm_channel, 0U);

    if (HAL_TIM_PWM_Start(motor->htim_pwm, motor->pwm_channel) != HAL_OK)
    {
        return HAL_ERROR;
    }

    /* STBY 拉高后，H 桥才真正具备输出能力。 */
    HAL_GPIO_WritePin(motor->stby_port, motor->stby_pin, GPIO_PIN_SET);
    Tb6612_ApplyCoast(motor);

    return HAL_OK;
}

/**
 * @brief 以固定控制周期更新电机驱动输出。
 * @param motor 电机驱动句柄。
 * @param command_permille 归一化控制量，范围建议为 [-1000, 1000]。
 *
 * @note 建议在 1 kHz 左右的控制节拍中调用。若需要 3 ms 的换向死区，
 *       则可将 reverse_deadtime_ticks 设为 3。
 */
void Tb6612_Update(Tb6612Motor_t *motor, int16_t command_permille)
{
    Tb6612Direction_t desired_dir;
    uint16_t abs_command;
    uint16_t compare;

    if (motor == NULL)
    {
        return;
    }

    command_permille = ClampS16(command_permille,
                                -TB6612_CMD_MAX_PERMILLE,
                                TB6612_CMD_MAX_PERMILLE);
    abs_command = AbsS16(command_permille);

    if (command_permille > 0)
    {
        desired_dir = TB6612_DIR_FORWARD;
    }
    else if (command_permille < 0)
    {
        desired_dir = TB6612_DIR_REVERSE;
    }
    else
    {
        desired_dir = TB6612_DIR_COAST;
    }

    compare = Tb6612_MapCommandToCompare(motor, abs_command);
    if ((compare == 0U) || (desired_dir == TB6612_DIR_COAST))
    {
        /* 低于起转阈值时，不让电机在无效 PWM 中抖动。 */
        motor->reverse_guard_ticks = 0U;
        motor->active_dir = TB6612_DIR_COAST;
        Tb6612_ApplyCoast(motor);
        return;
    }

    if ((motor->active_dir != TB6612_DIR_COAST) && (motor->active_dir != desired_dir))
    {
        if (motor->reverse_guard_ticks < motor->reverse_deadtime_ticks)
        {
            motor->reverse_guard_ticks++;

            /* 换向死区控制：
             * 先撤掉 PWM 并断开桥臂，让绕组电流与反电动势先衰减一小段时间，
             * 避免前后桥臂在相邻控制周期中“硬切换”。
             */
            Tb6612_ApplyCoast(motor);
            return;
        }

        motor->reverse_guard_ticks = 0U;
    }
    else
    {
        motor->reverse_guard_ticks = 0U;
    }

    if (motor->active_dir != desired_dir)
    {
        /* 改向前先清空比较值，再改桥臂方向，降低瞬时贯通风险。 */
        __HAL_TIM_SET_COMPARE(motor->htim_pwm, motor->pwm_channel, 0U);
        Tb6612_WriteBridge(motor, desired_dir);
        motor->active_dir = desired_dir;
    }

    __HAL_TIM_SET_COMPARE(motor->htim_pwm, motor->pwm_channel, compare);
}

/**
 * @brief 让电机进入短刹车模式，用于需要快速回收速度的场景。
 * @param motor 电机驱动句柄。
 *
 * @note TB6612FNG 的短刹车可通过 IN1=IN2=1 实现。
 *       这里先撤掉 PWM，再让两侧桥臂同时拉高。
 */
void Tb6612_Brake(Tb6612Motor_t *motor)
{
    if (motor == NULL)
    {
        return;
    }

    __HAL_TIM_SET_COMPARE(motor->htim_pwm, motor->pwm_channel, 0U);
    HAL_GPIO_WritePin(motor->in1_port, motor->in1_pin, GPIO_PIN_SET);
    HAL_GPIO_WritePin(motor->in2_port, motor->in2_pin, GPIO_PIN_SET);
    motor->reverse_guard_ticks = 0U;
    motor->active_dir = TB6612_DIR_COAST;
}

extern TIM_HandleTypeDef htim3;
extern int16_t BalanceController_GetMotorCommand(void);

/* 示例：PWM 周期 ARR = 999，对应 0~100% 共 1000 个计数刻度。 */
static Tb6612Motor_t g_left_motor =
{
    .htim_pwm = &htim3,
    .pwm_channel = TIM_CHANNEL_1,
    .in1_port = GPIOB,
    .in1_pin = GPIO_PIN_12,
    .in2_port = GPIOB,
    .in2_pin = GPIO_PIN_13,
    .stby_port = GPIOB,
    .stby_pin = GPIO_PIN_14,
    .pwm_period = 999U,
    .start_duty_permille = 180U,
    .command_threshold_permille = 70U,
    .reverse_deadtime_ticks = 3U,
    .reverse_guard_ticks = 0U,
    .active_dir = TB6612_DIR_COAST
};

void App_MotorInit(void)
{
    (void)Tb6612_Start(&g_left_motor);
}

void App_ControlTick(void)
{
    int16_t torque_cmd;

    /* 例如上层控制器输出范围为 [-1000, 1000]：
     * -1000 表示最大反转驱动。
     * 0     表示不输出有效驱动。
     * 1000  表示最大正转驱动。
     */
    torque_cmd = BalanceController_GetMotorCommand();
    Tb6612_Update(&g_left_motor, torque_cmd);
}
```

这段实现真正想解决的问题，不是“怎么点亮一个电机驱动模块”，而是如何让控制器输出跨过机电系统的非理想区间，仍然保持可预测、可复现、可保护。对 TB6612FNG 而言，PWM 只是时间占比；对直流电机而言，真正被消费的是电流、转矩与换向过程中的能量秩序。驱动层一旦把这些细节处理干净，控制算法才算真正接上了物理世界。
