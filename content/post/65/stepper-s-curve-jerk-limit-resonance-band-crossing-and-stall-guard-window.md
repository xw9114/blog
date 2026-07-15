---
title: "技能档案：步进电机共振带里的 S 曲线 jerk 限幅、禁速带穿越与失步保护窗口"
slug: "skill-stepper-s-curve-jerk-limit-resonance-band-crossing-and-stall-guard-window"
date: 2026-06-19T09:58:13+08:00
draft: false
description: "从转子-负载二阶谐振、jerk 的频谱注入到禁速带快速穿越与相位误差失步判据，系统拆解步进平台为什么常死在中速共振带而不是最高速度。"
tags: ["STM32", "步进电机", "S型加减速", "机械谐振", "失步保护", "运动控制"]
categories: ["技能档案", "电机控制", "控制与融合"]
image: ""
---

## 技能概述

很多步进平台真正难调的地方，不是最高转速跑不到，也不是定时器不会发 `STEP`，而是系统一旦穿过某段中速区，电机突然发叫、扭矩塌陷、位置开始丢步，随后再怎么把 `a_max` 调小都只是把故障推迟几毫秒。3D 打印平台、丝杆模组、贴片飞拍、转盘送料和小型关节机构都在反复遇到同一类问题: **转子-负载是一套弱阻尼二阶系统，S 曲线虽然能削掉高频激励，但如果在共振带里停留太久，平滑反而会变成持续喂振**。这个主题真正要解决的痛点，不是“再讲一遍七段 S 曲线”，而是把 **谐振频带**、**jerk 限幅**、**禁速带快速穿越** 和 **相位误差失步保护** 串成一份可以落到 STM32 HAL 定时器和编码器上的时域合同。

## 核心底层概念解析

- **步进电机不是理想位置源，而是一套离散激励下的弹性旋转系统**：转子、联轴器、丝杆、皮带和负载惯量共同构成等效惯量 `J_eq`，磁场刚度与机构弹性共同构成等效刚度 `K_eq`，于是系统天然存在近似固有频率 `f_n ~= 1 / (2π) * sqrt(K_eq / J_eq)`。中速失步很多时候不是“电流不够”，而是正好把脉冲频率推到了这套二阶系统最容易吸能的那一段。
- **S 曲线抑振的本质，不是轨迹看上去圆滑，而是限制加速度变化率 `jerk`**：脉冲频率 `f_step` 的变化若过于陡峭，会把宽频能量直接打进机械结构。离散实现里更关心的是  
  `a[k+1] = a[k] + clamp(a_target - a[k], -j_max * dt, j_max * dt)`，  
  `f[k+1] = f[k] + a[k+1] * dt`。  
  这里 `a` 是步频加速度，`j_max` 限制的是“频率斜率变化得有多快”，本质上是在限制激励频谱的高频尾巴。
- **平滑不总是正确，禁速带里反而要尽快穿过去**：若共振带边界为 `[f_low, f_high]`，带宽 `Delta f = f_high - f_low`，禁速带允许停留的最长时间为 `T_cross_max`，则穿越时至少要满足  
  `|a_cross| >= Delta f / T_cross_max`。  
  这意味着控制器在共振带外可以温和地按 S 曲线拉升，在共振带内却必须承认“这里不是用来欣赏平滑性的，而是用来缩短停留时间的”。
- **开环步进的真正危险量不是速度本身，而是负载角 `delta`**：命令位置映射出的转子目标角为 `theta_cmd`，编码器或观测器看到的真实机械角为 `theta_meas`，则  
  `delta = wrap(theta_cmd - theta_meas)`。  
  电磁转矩近似满足 `tau ~= K_t * I_pk * sin(delta)`。当 `|delta|` 逐步逼近 `90°` 电角附近时，系统虽然还在发脉冲，但已经进入“再来一脚就会翻步”的危险边界。
- **失步保护窗口不是单点阈值，而是时序门控**：共振带里测得一次大相位误差，并不一定说明已经失步，它也可能只是瞬时弹性回摆。因此更稳妥的判据通常是  
  `|delta| > delta_warn` 持续 `N_guard` 个规划周期，  
  或者 `delta_rms` 在一个短窗口里持续上升。这样保护逻辑防的是“持续脱锁”，而不是偶发弹性回弹。
- **微步细分不会消灭共振，只会改变激励的频谱形状**：微步让每次相电流变化更小，低速更平顺，但它并没有删除转子-负载系统的固有频率。相反，当电流环带宽、电源电压或电感限制让相电流跟不上目标正弦时，微步在中高速区还会提前暴露相位滞后。
- **禁速带不是只靠经验抄一个表，它本质上是“频率到风险”的映射**：工程上常见做法是通过扫频试验找出 `f_low`、`f_high` 和允许相位误差 `delta_warn`，再把它们写成驱动层配置。这样上层轨迹规划就不再只知道“目标速度是多少”，而知道“这条路上有一段频带不宜久留”。
- **定时器输出的是脉冲事件，不是连续速度**：理想步频 `f_step` 需要映射到整数 ARR，满足  
  `ARR = round(f_tim / f_step) - 1`。  
  一旦 `f_step` 位于共振带附近，哪怕只有几次量化后的周期偏长，也可能让系统在危险频段多待几个毫秒。对这类区间，控制器更应保证穿越策略与定时器更新逻辑一致，而不是只在连续数学里写得漂亮。
- **减速同样会穿越共振带，甚至更容易出事**：很多系统只在加速表里避开禁速带，却忘了刹车回零也会再次进入相同频段。若剩余步数不够而又在禁速带内柔和减速，电机会一边掉速一边长时间挂在最大敏感频段，结果比加速阶段更容易掉步。
- **技术哲学上，步进 S 曲线调参不是在追求“越平滑越好”，而是在资源受限的 MCU 上分配结构允许吸收多少能量、在哪一段时间轴里必须快速离场**：`jerk`、`a_max`、禁速带宽度、相位误差阈值和定时器刷新频率，最终共同决定的是一条物理系统是否还认得你发出的那串数字脉冲。

## 代码能力展现

下面给出一个基于 **STM32 HAL** 的步进轴示例。场景假设如下：

- `TIM1` 输出 `STEP` 脉冲，`GPIO` 输出 `DIR`。
- `TIM6` 以 `1 kHz` 运行规划层，负责 jerk 限幅、禁速带穿越和失步保护。
- `TIM4` 运行编码器接口，用于读取真实机械角；若现场没有编码器，也可以把相位误差输入替换成反电势或负载角估算器。

这段代码的重点不在“会不会发脉冲”，而在把 **S 曲线加速度更新**、**禁速带最小穿越加速度**、**步频到 ARR 的线性映射** 和 **相位误差连续窗口保护** 串成一条完整链路。

```c
#include "main.h"

#include <math.h>
#include <stdbool.h>
#include <stdint.h>

#define STEPPER_PI                               3.14159265359f
#define STEPPER_TWO_PI                           6.28318530718f
#define STEPPER_PLAN_DT_S                        0.001f
#define STEPPER_FREQ_EPS_HZ                      1.0f
#define STEPPER_MIN_FREQ_HZ                      5.0f
#define STEPPER_MAX_FREQ_HZ                   120000.0f
#define STEPPER_MAX_ACCEL_HZ_S             1500000.0f
#define STEPPER_MAX_JERK_HZ_S2           800000000.0f
#define STEPPER_MAX_PHASE_ERR_DEG               60.0f
#define STEPPER_MIN_PHASE_ERR_DEG                5.0f
#define STEPPER_GUARD_HIT_MAX                    32U

typedef enum
{
    STEPPER_RUN_IDLE = 0,
    STEPPER_RUN_ACCEL,
    STEPPER_RUN_CRUISE,
    STEPPER_RUN_DECEL,
    STEPPER_RUN_STALL
} StepperRunState_t;

typedef struct
{
    float enter_hz;
    float exit_hz;
    float max_cross_time_s;
    float phase_warn_deg;
    uint8_t guard_hits_required;
} StepperResonanceBand_t;

typedef struct
{
    TIM_HandleTypeDef *htim_step;
    uint32_t step_channel;
    TIM_HandleTypeDef *htim_encoder;

    GPIO_TypeDef *dir_port;
    uint16_t dir_pin;

    uint32_t timer_clock_hz;
    uint32_t microsteps_per_rev;
    uint32_t encoder_cpr;

    float cruise_freq_hz;
    float accel_nominal_hz_s;
    float decel_nominal_hz_s;
    float jerk_limit_hz_s2;
    float min_freq_hz;
    float max_freq_hz;

    uint16_t arr_min;
    uint16_t arr_max;
} StepperAxisConfig_t;

typedef struct
{
    StepperRunState_t state;
    int8_t direction;
    bool timer_running;

    int32_t target_microsteps;
    volatile int32_t emitted_microsteps;

    float current_freq_hz;
    float current_accel_hz_s;
    float last_phase_error_deg;
    uint8_t phase_guard_hits;
} StepperMotionState_t;

typedef struct
{
    StepperAxisConfig_t cfg;
    StepperResonanceBand_t band;
    StepperMotionState_t motion;
} StepperAxis_t;

static float Stepper_ClampF(float value, float min_value, float max_value)
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

static int32_t Stepper_AbsI32(int32_t value)
{
    return (value >= 0) ? value : -value;
}

static float Stepper_WrapPmPi(float angle_rad)
{
    while (angle_rad > STEPPER_PI)
    {
        angle_rad -= STEPPER_TWO_PI;
    }

    while (angle_rad <= -STEPPER_PI)
    {
        angle_rad += STEPPER_TWO_PI;
    }

    return angle_rad;
}

static bool Stepper_IsInsideBand(const StepperResonanceBand_t *band, float freq_hz)
{
    if ((band == NULL) || (band->exit_hz <= band->enter_hz))
    {
        return false;
    }

    return ((freq_hz >= band->enter_hz) && (freq_hz <= band->exit_hz));
}

/**
 * @brief 判断本次速度规划是否会穿越共振禁速带。
 * @param band 共振带参数。
 * @param current_freq_hz 当前步频，单位 Hz。
 * @param target_freq_hz 目标步频，单位 Hz。
 * @retval true  本次路径需要跨过禁速带。
 * @retval false 当前路径不涉及禁速带。
 *
 * @note 这里关心的是“当前速度区间和目标速度区间是否把 [f_enter, f_exit]
 *       整段包住”，而不是只看当前点是否落在带内。
 */
static bool Stepper_WillCrossBand(const StepperResonanceBand_t *band,
                                  float current_freq_hz,
                                  float target_freq_hz)
{
    const float lower = fminf(current_freq_hz, target_freq_hz);
    const float upper = fmaxf(current_freq_hz, target_freq_hz);

    if ((band == NULL) || (band->exit_hz <= band->enter_hz))
    {
        return false;
    }

    return ((lower < band->enter_hz) && (upper > band->exit_hz));
}

/**
 * @brief 根据禁速带宽度与最大允许停留时间，反推出最小穿越加速度。
 * @param band 共振带参数。
 * @return 禁速带穿越所需的最小步频加速度，单位 Hz/s。
 *
 * @note 若禁速带宽度为 `Delta f = f_exit - f_enter`，允许最大停留时间为
 *       `T_cross_max`，则穿越时至少满足：
 *       |a_cross| >= Delta f / T_cross_max
 */
static float Stepper_ComputeCrossAccelHzPerS(const StepperResonanceBand_t *band)
{
    if ((band == NULL) || (band->max_cross_time_s <= 1.0e-6f) || (band->exit_hz <= band->enter_hz))
    {
        return 0.0f;
    }

    return (band->exit_hz - band->enter_hz) / band->max_cross_time_s;
}

/**
 * @brief 将目标步频映射到定时器 ARR。
 * @param axis 步进轴对象。
 * @param step_freq_hz 目标步频，单位 Hz。
 * @return 对应的 ARR 值。
 *
 * @note 线性映射公式：
 *       ARR = round(f_tim / f_step) - 1
 *
 *       这里显式做边界限幅，避免在极低速时 ARR 溢出，或在极高速时把 ARR
 *       压得过小而失去驱动器所需的 STEP 高电平宽度。
 */
static uint16_t Stepper_FrequencyToArr(const StepperAxis_t *axis, float step_freq_hz)
{
    const float safe_freq_hz = Stepper_ClampF(step_freq_hz,
                                              axis->cfg.min_freq_hz,
                                              axis->cfg.max_freq_hz);
    float arr_f = ((float)axis->cfg.timer_clock_hz / safe_freq_hz) - 1.0f;

    arr_f = Stepper_ClampF(arr_f, (float)axis->cfg.arr_min, (float)axis->cfg.arr_max);
    return (uint16_t)(arr_f + 0.5f);
}

static void Stepper_StopTimer(StepperAxis_t *axis)
{
    if ((axis == NULL) || (!axis->motion.timer_running))
    {
        return;
    }

    HAL_TIM_PWM_Stop(axis->cfg.htim_step, axis->cfg.step_channel);
    axis->motion.timer_running = false;
}

static bool Stepper_StartTimer(StepperAxis_t *axis)
{
    if (axis == NULL)
    {
        return false;
    }

    if (axis->motion.timer_running)
    {
        return true;
    }

    if (HAL_TIM_PWM_Start(axis->cfg.htim_step, axis->cfg.step_channel) != HAL_OK)
    {
        return false;
    }

    axis->motion.timer_running = true;
    return true;
}

/**
 * @brief 把当前步频写入 STEP 定时器。
 * @param axis 步进轴对象。
 * @param step_freq_hz 目标步频，单位 Hz。
 *
 * @note 这里使用近似 50% 占空比的 PWM 作为 STEP 载波，
 *       令 `CCR = (ARR + 1) / 2`。对常见驱动器而言，关键不是占空比精度，
 *       而是上升沿之间的周期稳定性。
 */
static void Stepper_SetStepFrequencyHz(StepperAxis_t *axis, float step_freq_hz)
{
    const uint16_t arr = Stepper_FrequencyToArr(axis, step_freq_hz);
    const uint16_t ccr = (uint16_t)((arr + 1U) / 2U);

    __HAL_TIM_SET_AUTORELOAD(axis->cfg.htim_step, arr);
    __HAL_TIM_SET_COMPARE(axis->cfg.htim_step, axis->cfg.step_channel, ccr);
}

/**
 * @brief 将“已发出的微步数”映射为期望机械角。
 * @param axis 步进轴对象。
 * @return 期望机械角，单位 rad。
 *
 * @note 映射公式：
 *       theta_cmd = 2 * pi * emitted_microsteps / microsteps_per_rev
 */
static float Stepper_GetCommandedAngleRad(const StepperAxis_t *axis)
{
    return (STEPPER_TWO_PI * (float)axis->motion.emitted_microsteps) /
           (float)axis->cfg.microsteps_per_rev;
}

/**
 * @brief 读取编码器机械角。
 * @param axis 步进轴对象。
 * @return 实际机械角，单位 rad。
 *
 * @note 映射公式：
 *       theta_meas = 2 * pi * encoder_count / encoder_cpr
 */
static float Stepper_GetMeasuredAngleRad(const StepperAxis_t *axis)
{
    const uint32_t encoder_count = __HAL_TIM_GET_COUNTER(axis->cfg.htim_encoder) % axis->cfg.encoder_cpr;

    return (STEPPER_TWO_PI * (float)encoder_count) / (float)axis->cfg.encoder_cpr;
}

/**
 * @brief 检查相位误差是否连续越过危险窗口。
 * @param axis 步进轴对象。
 * @return true  表示疑似失步，应立即停机或降级。
 * @return false 当前仍在安全区。
 *
 * @note 负载角定义为：
 *       delta = wrap(theta_cmd - theta_meas)
 *
 *       保护逻辑不是看到一次超限就断定失步，而是要求：
 *       |delta| > delta_warn 连续 N 次成立
 *
 *       这样可以过滤掉弹性回摆与单次采样噪声。
 */
static bool Stepper_UpdatePhaseGuard(StepperAxis_t *axis)
{
    const float theta_cmd = Stepper_GetCommandedAngleRad(axis);
    const float theta_meas = Stepper_GetMeasuredAngleRad(axis);
    const float delta_deg =
        fabsf(Stepper_WrapPmPi(theta_cmd - theta_meas)) * (180.0f / STEPPER_PI);
    const float phase_warn_deg =
        Stepper_ClampF(axis->band.phase_warn_deg,
                       STEPPER_MIN_PHASE_ERR_DEG,
                       STEPPER_MAX_PHASE_ERR_DEG);

    axis->motion.last_phase_error_deg = delta_deg;

    if (delta_deg > phase_warn_deg)
    {
        if (axis->motion.phase_guard_hits < STEPPER_GUARD_HIT_MAX)
        {
            axis->motion.phase_guard_hits++;
        }
    }
    else if (axis->motion.phase_guard_hits > 0U)
    {
        axis->motion.phase_guard_hits--;
    }

    return (axis->motion.phase_guard_hits >= axis->band.guard_hits_required);
}

/**
 * @brief 根据剩余步数估算当前是否该从加速切入减速。
 * @param axis 步进轴对象。
 * @param accel_for_brake_hz_s 用于估算制动距离的有效减速度，单位 Hz/s。
 * @return true  需要减速。
 * @return false 仍可继续加速或巡航。
 *
 * @note 将当前步频视作“速度”，则近似制动距离为：
 *       steps_stop ~= f_now^2 / (2 * a_brake)
 *
 *       这不是完整 jerk 轨迹的精确解析，但足够给出稳定、保守的切换边界。
 */
static bool Stepper_ShouldDecelerate(const StepperAxis_t *axis, float accel_for_brake_hz_s)
{
    const int32_t remaining_steps = axis->motion.target_microsteps - axis->motion.emitted_microsteps;
    const float safe_accel = fmaxf(accel_for_brake_hz_s, 1.0f);
    const float stop_steps = (axis->motion.current_freq_hz * axis->motion.current_freq_hz) /
                             (2.0f * safe_accel);

    return ((float)remaining_steps <= stop_steps);
}

/**
 * @brief 计算当前规划周期想要达到的目标加速度。
 * @param axis 步进轴对象。
 * @return 目标步频加速度，单位 Hz/s。
 *
 * @note 这一步把三种约束合并起来：
 *       1. 常规 S 曲线使用 nominal accel/decel；
 *       2. 若即将进入或已处于禁速带，至少满足 `Delta f / T_cross_max`；
 *       3. 若剩余步数不足，则转入负加速度刹车。
 */
static float Stepper_SelectTargetAccelHzPerS(const StepperAxis_t *axis)
{
    const float cross_accel = Stepper_ComputeCrossAccelHzPerS(&axis->band);
    const float current_freq = axis->motion.current_freq_hz;
    const float target_freq = axis->cfg.cruise_freq_hz;
    const bool inside_band = Stepper_IsInsideBand(&axis->band, current_freq);
    const bool will_cross_band = Stepper_WillCrossBand(&axis->band, current_freq, target_freq);
    const float accel_mag =
        fmaxf(axis->cfg.accel_nominal_hz_s,
              (inside_band || will_cross_band) ? cross_accel : axis->cfg.accel_nominal_hz_s);
    const float decel_mag =
        fmaxf(axis->cfg.decel_nominal_hz_s,
              inside_band ? cross_accel : axis->cfg.decel_nominal_hz_s);

    if (Stepper_ShouldDecelerate(axis, decel_mag))
    {
        return -decel_mag;
    }

    if (current_freq >= (axis->cfg.cruise_freq_hz - STEPPER_FREQ_EPS_HZ))
    {
        return 0.0f;
    }

    return accel_mag;
}

/**
 * @brief 启动一次带共振带避让的步进位移。
 * @param axis 步进轴对象。
 * @param relative_microsteps 相对位移，单位 microstep。
 * @retval true  启动成功。
 * @retval false 参数非法或定时器启动失败。
 */
bool Stepper_StartMove(StepperAxis_t *axis, int32_t relative_microsteps)
{
    if ((axis == NULL) || (relative_microsteps == 0))
    {
        return false;
    }

    axis->motion.state = STEPPER_RUN_ACCEL;
    axis->motion.direction = (relative_microsteps > 0) ? 1 : -1;
    axis->motion.target_microsteps = Stepper_AbsI32(relative_microsteps);
    axis->motion.emitted_microsteps = 0;
    axis->motion.current_freq_hz = axis->cfg.min_freq_hz;
    axis->motion.current_accel_hz_s = 0.0f;
    axis->motion.last_phase_error_deg = 0.0f;
    axis->motion.phase_guard_hits = 0U;

    HAL_GPIO_WritePin(axis->cfg.dir_port,
                      axis->cfg.dir_pin,
                      (axis->motion.direction > 0) ? GPIO_PIN_SET : GPIO_PIN_RESET);

    Stepper_SetStepFrequencyHz(axis, axis->motion.current_freq_hz);
    return Stepper_StartTimer(axis);
}

/**
 * @brief 规划层 `1 kHz` 更新函数。
 * @param axis 步进轴对象。
 *
 * @note 离散 S 曲线更新遵循：
 *       a[k+1] = a[k] + clamp(a_target - a[k], -j_max * dt, j_max * dt)
 *       f[k+1] = clamp(f[k] + a[k+1] * dt, f_min, f_max)
 *
 *       若相位误差窗口持续超限，则立即进入 `STALL`。
 */
void Stepper_PlannerTick1kHz(StepperAxis_t *axis)
{
    const float dt_s = STEPPER_PLAN_DT_S;
    float jerk_limit;
    float accel_step;
    float target_accel;
    float accel_error;

    if ((axis == NULL) || (axis->motion.state == STEPPER_RUN_IDLE) || (axis->motion.state == STEPPER_RUN_STALL))
    {
        return;
    }

    jerk_limit = Stepper_ClampF(axis->cfg.jerk_limit_hz_s2,
                                0.0f,
                                STEPPER_MAX_JERK_HZ_S2);
    accel_step = jerk_limit * dt_s;
    target_accel = Stepper_SelectTargetAccelHzPerS(axis);

    if (axis->motion.emitted_microsteps >= axis->motion.target_microsteps)
    {
        Stepper_StopTimer(axis);
        axis->motion.state = STEPPER_RUN_IDLE;
        axis->motion.current_freq_hz = 0.0f;
        axis->motion.current_accel_hz_s = 0.0f;
        return;
    }

    accel_error = target_accel - axis->motion.current_accel_hz_s;
    accel_error = Stepper_ClampF(accel_error, -accel_step, accel_step);
    axis->motion.current_accel_hz_s += accel_error;
    axis->motion.current_accel_hz_s = Stepper_ClampF(axis->motion.current_accel_hz_s,
                                                     -STEPPER_MAX_ACCEL_HZ_S,
                                                     STEPPER_MAX_ACCEL_HZ_S);

    axis->motion.current_freq_hz += axis->motion.current_accel_hz_s * dt_s;
    axis->motion.current_freq_hz = Stepper_ClampF(axis->motion.current_freq_hz,
                                                  axis->cfg.min_freq_hz,
                                                  axis->cfg.max_freq_hz);

    if (target_accel > 0.0f)
    {
        axis->motion.state = (axis->motion.current_freq_hz >= axis->cfg.cruise_freq_hz - STEPPER_FREQ_EPS_HZ)
                                 ? STEPPER_RUN_CRUISE
                                 : STEPPER_RUN_ACCEL;
    }
    else if (target_accel < 0.0f)
    {
        axis->motion.state = STEPPER_RUN_DECEL;
    }
    else
    {
        axis->motion.state = STEPPER_RUN_CRUISE;
    }

    Stepper_SetStepFrequencyHz(axis, axis->motion.current_freq_hz);
    (void)Stepper_StartTimer(axis);

    if (Stepper_IsInsideBand(&axis->band, axis->motion.current_freq_hz) &&
        Stepper_UpdatePhaseGuard(axis))
    {
        Stepper_StopTimer(axis);
        axis->motion.state = STEPPER_RUN_STALL;
        axis->motion.current_freq_hz = 0.0f;
        axis->motion.current_accel_hz_s = 0.0f;
    }
}

/**
 * @brief 在 STEP 定时器更新事件中累计已发微步数。
 * @param axis 步进轴对象。
 *
 * @note 这层只对“已经真实发出去的步数”负责。相位保护读取的 `theta_cmd`
 *       也基于该计数，而不是基于理想频率积分值，避免把“计划发出去的步”
 *       误当成“已经驱动磁场完成的步”。
 */
void Stepper_OnStepPulseElapsed(StepperAxis_t *axis)
{
    if ((axis == NULL) || (!axis->motion.timer_running))
    {
        return;
    }

    axis->motion.emitted_microsteps++;

    if (axis->motion.emitted_microsteps >= axis->motion.target_microsteps)
    {
        Stepper_StopTimer(axis);
        axis->motion.state = STEPPER_RUN_IDLE;
        axis->motion.current_freq_hz = 0.0f;
        axis->motion.current_accel_hz_s = 0.0f;
    }
}

extern TIM_HandleTypeDef htim1;
extern TIM_HandleTypeDef htim4;
extern TIM_HandleTypeDef htim6;

static StepperAxis_t g_stepper_axis =
{
    .cfg =
    {
        .htim_step = &htim1,
        .step_channel = TIM_CHANNEL_1,
        .htim_encoder = &htim4,
        .dir_port = GPIOB,
        .dir_pin = GPIO_PIN_0,
        .timer_clock_hz = 72000000U,
        .microsteps_per_rev = 3200U,    /* 1.8° 电机 + 16 细分 */
        .encoder_cpr = 4096U,
        .cruise_freq_hz = 28000.0f,
        .accel_nominal_hz_s = 140000.0f,
        .decel_nominal_hz_s = 170000.0f,
        .jerk_limit_hz_s2 = 22000000.0f,
        .min_freq_hz = STEPPER_MIN_FREQ_HZ,
        .max_freq_hz = STEPPER_MAX_FREQ_HZ,
        .arr_min = 599U,                /* 72 MHz / (599 + 1) = 120 kHz */
        .arr_max = 0xFFFFU
    },
    .band =
    {
        .enter_hz = 1800.0f,
        .exit_hz = 3200.0f,
        .max_cross_time_s = 0.012f,
        .phase_warn_deg = 18.0f,
        .guard_hits_required = 4U
    },
    .motion =
    {
        .state = STEPPER_RUN_IDLE,
        .direction = 1,
        .timer_running = false,
        .target_microsteps = 0,
        .emitted_microsteps = 0,
        .current_freq_hz = 0.0f,
        .current_accel_hz_s = 0.0f,
        .last_phase_error_deg = 0.0f,
        .phase_guard_hits = 0U
    }
};

void App_StepperMoveExample(void)
{
    /*
     * 例如执行 1/2 圈位移，共 1600 microsteps。
     * 启动后由 TIM6 每 1 ms 调用 Stepper_PlannerTick1kHz()，
     * TIM1 的更新事件则不断累计实际已发脉冲。
     */
    (void)Stepper_StartMove(&g_stepper_axis, 1600);
}

void HAL_TIM_PeriodElapsedCallback(TIM_HandleTypeDef *htim)
{
    if (htim->Instance == htim6.Instance)
    {
        Stepper_PlannerTick1kHz(&g_stepper_axis);
        return;
    }

    if (htim->Instance == g_stepper_axis.cfg.htim_step->Instance)
    {
        Stepper_OnStepPulseElapsed(&g_stepper_axis);
    }
}
```

这段实现最重要的，不是把 `STEP` 脉冲发得更快，而是把几件常被拆散的事情重新拧在一起了：

- `Stepper_SelectTargetAccelHzPerS()` 把常规 S 曲线和禁速带快速穿越合并在同一条加速度决策链里，承认“平滑”和“缩短危险停留时间”有时是两种不同目标。
- `Stepper_UpdatePhaseGuard()` 不把一次大相位误差直接判成失步，而是要求连续窗口成立，减少把弹性回摆误杀成故障的概率。
- `Stepper_FrequencyToArr()` 明确写出 `f_step -> ARR` 的线性映射，让共振带附近的时域预算能直接落到定时器寄存器，而不是停留在连续时间公式里。
- `Stepper_OnStepPulseElapsed()` 只统计已经真实发出的脉冲，确保负载角保护比较的是“磁场已经走了多少步”和“转子实际跟了多少角”，而不是“规划器希望它走到哪里”。

真正成熟的步进运动控制，从来不是把 `a_max` 一路调小直到“不再响”为止，而是先承认结构里存在某段不适合久留的频带，再用 jerk、穿越时间和失步窗口去管理它。只有当这几份合同在同一条时间轴上自洽，所谓“平稳”“不丢步”和“还能跑得快”才可能同时成立。
