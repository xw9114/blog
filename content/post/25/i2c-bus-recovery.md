---
title: "技能档案：I2C 通信协议底层逻辑，从开漏仲裁、时钟拉伸到总线恢复"
slug: "skill-i2c-open-drain-arbitration-clock-stretch-and-bus-recovery"
date: 2026-04-26T10:05:36+08:00
draft: false
description: "从 RC 上升沿、线与仲裁、时钟拉伸到 9 脉冲总线恢复，系统拆解 I2C 为何常败给物理边界而非寄存器配置。"
tags: ["I2C", "STM32", "总线恢复", "时序", "嵌入式"]
categories: ["技能档案"]
image: ""
---

## 技能概述

I2C 的价值，从来不只是“省两根线”。它真正解决的是板级系统里多器件低速同步通信的组织问题：EEPROM、IMU、温湿度传感器、PMIC、RTC 都想共享同一对信号线，但系统又不能接受每颗器件各拉一组片选和时钟的布线成本。工程上的真正痛点，不是 `HAL_I2C_Mem_Read()` 能不能返回 `HAL_OK`，而是你是否理解开漏输出为什么需要上拉电阻、总线电容为什么会把上升沿拖慢、从机为什么能用时钟拉伸强行打断主机节奏，以及掉电抖动后为什么总线会卡死在 `BUSY`。I2C 的难点，本质上是把一条看似“数字”的双线总线，重新当作带 RC 上升沿、共享仲裁与状态恢复的物理系统来管理。

## 核心底层概念解析

- **开漏输出不是实现细节，而是 I2C 能共享总线的前提**：I2C 设备只能主动把线拉低，不能主动把线推高，高电平由上拉电阻提供。只要任意一个器件拉低，总线就是低电平，因此 SDA/SCL 天然满足 **线与（wired-AND）** 语义。这既避免了两个器件一个拉高、一个拉低时的硬短路，也让多主仲裁成为可能。
- **I2C 的上升沿是模拟 RC 过程，不是理想方波**：总线释放后，电压按照 RC 曲线缓慢上升，30% 到 70% 区间的上升时间近似满足 `t_r ≈ 0.8473 * R_pullup * C_bus`。如果上拉电阻过大、排线过长、器件输入电容叠加过多，波形还没来得及到达高电平阈值，下一个采样点已经到了，最终表现为偶发 NACK、位错误或“看起来偶尔能通”的玄学故障。
- **标准模式和快速模式的核心差别，不只是 100 kHz 与 400 kHz**：真正约束设计的，是协议对上升时间的预算。标准模式允许约 `1000 ns` 的上升时间，快速模式常见上限约 `300 ns`。这意味着同一块板子在 100 kHz 下稳定，不代表切到 400 kHz 仍然可靠，因为 `R_pullup * C_bus` 可能早已把时序裕量吃光。
- **Start / Stop 条件本质上是“在 SCL 为高时，SDA 发生边沿”**：数据位只有在 SCL 低电平阶段才允许变化，SCL 高电平时 SDA 必须稳定；唯独起始与停止条件反过来，必须在 SCL 高电平期间让 SDA 发生高低翻转。也就是说，I2C 真正编码的不是某个电平本身，而是边沿出现时刻与时钟窗口之间的契约。
- **仲裁失败的判据不是软件变量，而是“我放手了，但线上仍然是低”**：多主场景下，一个主机若打算发送逻辑 1，实际上做的是“释放 SDA”；如果它在 SCL 高电平采样时发现总线仍被别人拉低，就说明另一个主机正在发送逻辑 0，它必须立刻认输退出。这种“边发边听”的物理闭环，才是 I2C 仲裁的底层逻辑。
- **时钟拉伸（Clock Stretching）不是从机拖延症，而是节奏主导权的临时让渡**：主机本来负责产生 SCL，但从机可以在主机释放 SCL 后继续把它拉低，直到自己准备好下一个比特。对主机而言，一个低电平周期的实际持续时间就变成 `t_low_effective = t_low_master + t_stretch_slave`。如果驱动层没有等待上升沿的超时机制，所谓“同步通信”很容易变成无限阻塞。
- **ACK / NACK 并不只是第九个脉冲的礼貌回执，它还是状态机边界**：写寄存器时，地址阶段 NACK 往往意味着器件不在线、地址错或总线噪声；而 EEPROM 在内部写周期里主动 NACK，则属于“器件在线但还没准备好”。对驱动层而言，NACK 不是单一错误码，而是需要结合事务阶段、器件类型和重试策略一起解释的状态信号。
- **总线卡死往往来自“半个字节”而不是“整次传输”**：最典型的故障是 MCU 复位、热插拔或噪声毛刺发生在字节中途，从机还以为自己正处于接收状态，于是持续把 SDA 拉低等待剩余时钟。主机重启后看到的就是 `BUSY` 永远不清。此时必须人工补齐若干 SCL 脉冲，把从机状态机推到字节边界，再构造一个合法 STOP 把双方一起拉回空闲态。
- **“9 个 SCL 脉冲”不是迷信，而是为了跨过最坏情况下的 8 位数据 + 1 位 ACK**：如果从机被卡在任意一个位阶段，最多补满一个字节周期就有机会释放 SDA。因此工程上常见的总线恢复动作，是在确保单主安全的前提下，把 I2C 外设切回 GPIO 开漏模式，手动输出 9 个 SCL 脉冲，再生成一次 STOP。
- **I2C 的可靠性不在某次收发是否成功，而在失败时能否把物理状态机重新收敛**：超时、NACK、仲裁丢失、毛刺和掉电都不可避免。优秀的 I2C 驱动，不是简单包装 HAL API，而是把上升沿预算、时钟拉伸等待、错误分类、重试窗口与总线恢复路径一起纳入控制闭环。

## 代码能力展现

下面给出一个基于 STM32 HAL 的稳健 I2C 总线服务示例。代码聚焦三件事：一是用 `R_pullup * C_bus` 估算物理上升沿预算；二是在内存读事务里显式处理 `BUSY`、NACK、超时与仲裁相关错误；三是在总线卡死时把 I2C 外设临时降级为 GPIO 开漏输出，通过 **9 个 SCL 脉冲 + STOP** 做总线恢复。重点不是堆 API，而是把 **物理连线 -> 时序等待 -> 错误恢复** 这条链路在 STM32 上做实。

```c
#include "main.h"
#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#define I2C_RISE_TIME_COEFF_30_TO_70       0.8473f
#define I2C_STD_MODE_RISE_TIME_NS          1000.0f
#define I2C_FAST_MODE_RISE_TIME_NS         300.0f

#define I2C_RECOVERY_PULSE_COUNT           9U
#define I2C_RECOVERY_HALF_CYCLE_US         5U
#define I2C_TRANSFER_TIMEOUT_MIN_MS        2U
#define I2C_TRANSFER_TIMEOUT_MAX_MS        100U

typedef enum
{
    I2C_REG_ADDR_8BIT = 0U,
    I2C_REG_ADDR_16BIT
} I2cRegisterAddressSize_t;

typedef struct
{
    I2C_HandleTypeDef *hi2c;
    GPIO_TypeDef *scl_port;
    uint16_t scl_pin;
    GPIO_TypeDef *sda_port;
    uint16_t sda_pin;
    uint32_t bus_speed_hz;
    uint32_t stretch_timeout_us;
    uint32_t bus_free_timeout_us;
    uint8_t max_retry;
} I2cRobustBus_t;

extern void App_DelayUs(uint32_t delay_us);

static uint32_t I2c_ClampU32(uint32_t value, uint32_t min_value, uint32_t max_value)
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

static void I2c_DriveLow(GPIO_TypeDef *port, uint16_t pin)
{
    HAL_GPIO_WritePin(port, pin, GPIO_PIN_RESET);
}

static void I2c_ReleaseLine(GPIO_TypeDef *port, uint16_t pin)
{
    /* 开漏输出写 1 的真实含义不是“主动拉高”，而是释放总线，
     * 让外部上拉电阻把线恢复到高电平。
     */
    HAL_GPIO_WritePin(port, pin, GPIO_PIN_SET);
}

static bool I2c_IsLineHigh(GPIO_TypeDef *port, uint16_t pin)
{
    return (HAL_GPIO_ReadPin(port, pin) == GPIO_PIN_SET);
}

/**
 * @brief 估算 I2C 总线 30%~70% 区间的上升时间。
 * @param pullup_ohm 上拉电阻阻值，单位 ohm。
 * @param bus_cap_pf 总线等效电容，单位 pF。
 * @return 估算得到的上升时间，单位 ns。
 *
 * @note RC 上升沿在 30%~70% 区间的近似公式：
 *       t_r(ns) ≈ 0.8473 * R_pullup(ohm) * C_bus(F) * 1e9
 *               = 0.8473 * R_pullup * C_bus(pF) * 1e-3
 *
 *       这不是协议层参数，而是板级布线、电阻和器件输入电容共同决定的物理现实。
 */
static float I2c_EstimateRiseTimeNs(uint32_t pullup_ohm, uint32_t bus_cap_pf)
{
    return I2C_RISE_TIME_COEFF_30_TO_70
         * (float)pullup_ohm
         * (float)bus_cap_pf
         * 1.0e-3f;
}

/**
 * @brief 检查当前 I2C 速度目标下，上升沿预算是否仍在协议约束内。
 * @param pullup_ohm 上拉电阻阻值，单位 ohm。
 * @param bus_cap_pf 总线等效电容，单位 pF。
 * @param bus_speed_hz 目标 I2C 速率，典型值 100000 或 400000。
 * @param out_rise_time_ns 可选输出参数，用于回传估算上升时间。
 * @retval true  上升沿预算满足当前目标速率。
 * @retval false 上升沿过慢，建议降低速率或减小 RC 常数。
 *
 * @note 这里采用常见约束：
 *       - 标准模式 (100 kHz) : t_r <= 1000 ns
 *       - 快速模式 (400 kHz) : t_r <= 300 ns
 */
bool I2c_CheckRiseTimeBudget(uint32_t pullup_ohm,
                             uint32_t bus_cap_pf,
                             uint32_t bus_speed_hz,
                             float *out_rise_time_ns)
{
    const float rise_time_ns = I2c_EstimateRiseTimeNs(pullup_ohm, bus_cap_pf);
    const float rise_limit_ns = (bus_speed_hz <= 100000U)
                              ? I2C_STD_MODE_RISE_TIME_NS
                              : I2C_FAST_MODE_RISE_TIME_NS;

    if (out_rise_time_ns != NULL)
    {
        *out_rise_time_ns = rise_time_ns;
    }

    return (rise_time_ns <= rise_limit_ns);
}

/**
 * @brief 等待某条 I2C 线真正回到高电平。
 * @param port GPIO 端口。
 * @param pin GPIO 引脚。
 * @param timeout_us 超时时间，单位 us。
 * @retval true  线在超时内回到高电平。
 * @retval false 超时仍为低电平。
 *
 * @note 对 SCL 来说，这一步同时覆盖了时钟拉伸场景：
 *       主机虽然已经“释放”了 SCL，但从机仍可能继续把它钳在低电平。
 */
static bool I2c_WaitLineHigh(GPIO_TypeDef *port, uint16_t pin, uint32_t timeout_us)
{
    uint32_t elapsed_us = 0U;

    while (!I2c_IsLineHigh(port, pin))
    {
        if (elapsed_us >= timeout_us)
        {
            return false;
        }

        App_DelayUs(1U);
        ++elapsed_us;
    }

    return true;
}

/**
 * @brief 等待 SDA 与 SCL 同时回到空闲态。
 * @param bus 稳健 I2C 总线对象。
 * @retval true  在超时内看到总线空闲。
 * @retval false 总线始终未回到空闲态。
 *
 * @note I2C 空闲态判据：SCL = 1 且 SDA = 1。
 */
static bool I2c_WaitBusIdle(const I2cRobustBus_t *bus)
{
    uint32_t elapsed_us = 0U;

    while ((!I2c_IsLineHigh(bus->scl_port, bus->scl_pin))
        || (!I2c_IsLineHigh(bus->sda_port, bus->sda_pin)))
    {
        if (elapsed_us >= bus->bus_free_timeout_us)
        {
            return false;
        }

        App_DelayUs(1U);
        ++elapsed_us;
    }

    return true;
}

static void I2c_ConfigPinsAsOpenDrainGpio(const I2cRobustBus_t *bus)
{
    GPIO_InitTypeDef gpio_init = {0};

    gpio_init.Mode = GPIO_MODE_OUTPUT_OD;
    gpio_init.Pull = GPIO_NOPULL;
    gpio_init.Speed = GPIO_SPEED_FREQ_VERY_HIGH;

    gpio_init.Pin = bus->scl_pin;
    HAL_GPIO_Init(bus->scl_port, &gpio_init);

    gpio_init.Pin = bus->sda_pin;
    HAL_GPIO_Init(bus->sda_port, &gpio_init);

    I2c_ReleaseLine(bus->scl_port, bus->scl_pin);
    I2c_ReleaseLine(bus->sda_port, bus->sda_pin);
}

static bool I2c_ShouldRecoverBus(uint32_t error_code)
{
    return ((error_code & HAL_I2C_ERROR_BERR) != 0U)
        || ((error_code & HAL_I2C_ERROR_ARLO) != 0U)
        || ((error_code & HAL_I2C_ERROR_TIMEOUT) != 0U)
        || ((error_code & HAL_I2C_ERROR_OVR) != 0U);
}

/**
 * @brief 估算一次 I2C 寄存器读事务所需的最小超时预算。
 * @param bus_speed_hz I2C 总线速率。
 * @param register_addr_size 寄存器地址宽度，8bit 或 16bit。
 * @param payload_bytes 负载字节数。
 * @return 建议使用的 HAL 超时参数，单位 ms。
 *
 * @note 近似位数模型：
 *       1. 地址写阶段       : 9 bit   (7-bit 地址 + R/W + ACK)
 *       2. 寄存器地址阶段   : 9 * N bit
 *       3. 重复起始读地址   : 9 bit
 *       4. 数据阶段         : 9 * payload_bytes bit
 *       5. 起始/停止/软件余量: 18 bit
 *
 *       timeout_ms ≈ ceil(total_bits / bus_speed_hz * 1000) + guard_ms
 */
static uint32_t I2c_EstimateMemReadTimeoutMs(uint32_t bus_speed_hz,
                                             I2cRegisterAddressSize_t register_addr_size,
                                             uint16_t payload_bytes)
{
    const uint32_t reg_bytes = (register_addr_size == I2C_REG_ADDR_16BIT) ? 2U : 1U;
    const uint32_t total_bits = 9U
                              + (9U * reg_bytes)
                              + 9U
                              + (9U * (uint32_t)payload_bytes)
                              + 18U;
    const uint32_t safe_bus_speed_hz = I2c_ClampU32(bus_speed_hz, 10000U, 1000000U);
    const uint32_t transfer_ms = (uint32_t)((((uint64_t)total_bits * 1000ULL)
                                           + (uint64_t)safe_bus_speed_hz - 1ULL)
                                          / (uint64_t)safe_bus_speed_hz);
    const uint32_t timeout_ms = transfer_ms + 2U;

    return I2c_ClampU32(timeout_ms,
                        I2C_TRANSFER_TIMEOUT_MIN_MS,
                        I2C_TRANSFER_TIMEOUT_MAX_MS);
}

/**
 * @brief 使用 GPIO 位级脉冲恢复卡死的 I2C 总线。
 * @param bus 稳健 I2C 总线对象。
 * @retval true  恢复成功，总线重新回到空闲。
 * @retval false 恢复失败，总线仍被钳住或外设重建失败。
 *
 * @note 恢复流程：
 *       1. 关闭 I2C 外设，避免外设继续占有引脚。
 *       2. 切换为 GPIO 开漏输出并释放 SDA/SCL。
 *       3. 若 SDA 被拉低，则补 9 个 SCL 脉冲，让从机状态机跨过
 *          “最坏情况下的 8 位数据 + 1 位 ACK”边界。
 *       4. 手动构造一次 STOP：先确保 SDA 为低，再在 SCL 为高时释放 SDA。
 *       5. 重新初始化 I2C 外设。
 *
 *       该方法默认总线为单主场景。多主系统中，人工脉冲恢复前必须先确认
 *       没有其他主机仍在合法发送，否则会把“恢复动作”变成新的冲突源。
 */
bool I2c_RecoverBus(I2cRobustBus_t *bus)
{
    uint32_t pulse_index;
    bool bus_idle;

    if ((bus == NULL) || (bus->hi2c == NULL))
    {
        return false;
    }

    (void)HAL_I2C_DeInit(bus->hi2c);
    I2c_ConfigPinsAsOpenDrainGpio(bus);

    if (!I2c_WaitLineHigh(bus->scl_port, bus->scl_pin, bus->stretch_timeout_us))
    {
        (void)HAL_I2C_Init(bus->hi2c);
        return false;
    }

    for (pulse_index = 0U;
         (pulse_index < I2C_RECOVERY_PULSE_COUNT) && (!I2c_IsLineHigh(bus->sda_port, bus->sda_pin));
         ++pulse_index)
    {
        /* 每个脉冲都先拉低再释放高电平，模拟一个完整时钟。
         * 释放高电平后必须等待 SCL 真正变高，避免忽略从机的时钟拉伸。
         */
        I2c_DriveLow(bus->scl_port, bus->scl_pin);
        App_DelayUs(I2C_RECOVERY_HALF_CYCLE_US);

        I2c_ReleaseLine(bus->scl_port, bus->scl_pin);
        if (!I2c_WaitLineHigh(bus->scl_port, bus->scl_pin, bus->stretch_timeout_us))
        {
            (void)HAL_I2C_Init(bus->hi2c);
            return false;
        }

        App_DelayUs(I2C_RECOVERY_HALF_CYCLE_US);
    }

    /* 显式构造 STOP：
     * 1. 先把 SCL 拉低，建立允许 SDA 变化的数据窗口。
     * 2. 再把 SDA 拉低，准备一个“合法的低电平数据位”。
     * 3. 释放 SCL 为高，最后释放 SDA 产生低->高边沿。
     */
    I2c_DriveLow(bus->scl_port, bus->scl_pin);
    App_DelayUs(I2C_RECOVERY_HALF_CYCLE_US);
    I2c_DriveLow(bus->sda_port, bus->sda_pin);
    App_DelayUs(I2C_RECOVERY_HALF_CYCLE_US);

    I2c_ReleaseLine(bus->scl_port, bus->scl_pin);
    if (!I2c_WaitLineHigh(bus->scl_port, bus->scl_pin, bus->stretch_timeout_us))
    {
        (void)HAL_I2C_Init(bus->hi2c);
        return false;
    }

    App_DelayUs(I2C_RECOVERY_HALF_CYCLE_US);
    I2c_ReleaseLine(bus->sda_port, bus->sda_pin);
    App_DelayUs(I2C_RECOVERY_HALF_CYCLE_US);

    bus_idle = I2c_WaitBusIdle(bus);

    if (HAL_I2C_Init(bus->hi2c) != HAL_OK)
    {
        return false;
    }

    return bus_idle;
}

/**
 * @brief 带错误分类、超时预算和总线恢复的一次寄存器读事务。
 * @param bus 稳健 I2C 总线对象。
 * @param device_addr_7bit 7-bit 从机地址，不包含最低位 R/W。
 * @param register_addr 目标寄存器地址。
 * @param register_addr_size 寄存器地址宽度。
 * @param rx_buffer 接收缓冲区。
 * @param rx_size 待读取字节数。
 * @retval HAL_OK    事务成功完成。
 * @retval HAL_BUSY  总线持续忙，且恢复未成功。
 * @retval HAL_ERROR 参数非法、恢复失败或外设层返回不可恢复错误。
 * @retval HAL_TIMEOUT 时钟拉伸或事务超时。
 *
 * @note 处理策略：
 *       - 若进入事务前 `I2C_FLAG_BUSY` 已置位，先尝试恢复总线。
 *       - `HAL_I2C_ERROR_AF` 常见于器件 NACK，例如 EEPROM 正在内部写周期；
 *         这里允许短暂延时后重试。
 *       - `BERR / ARLO / TIMEOUT / OVR` 视为总线状态机可能已失配，执行恢复。
 */
HAL_StatusTypeDef I2c_MemReadRobust(I2cRobustBus_t *bus,
                                    uint16_t device_addr_7bit,
                                    uint16_t register_addr,
                                    I2cRegisterAddressSize_t register_addr_size,
                                    uint8_t *rx_buffer,
                                    uint16_t rx_size)
{
    const uint16_t device_addr_8bit = (uint16_t)((device_addr_7bit & 0x7FU) << 1U);
    const uint32_t mem_addr_size = (register_addr_size == I2C_REG_ADDR_16BIT)
                                 ? I2C_MEMADD_SIZE_16BIT
                                 : I2C_MEMADD_SIZE_8BIT;
    const uint32_t timeout_ms = I2c_EstimateMemReadTimeoutMs(bus->bus_speed_hz,
                                                             register_addr_size,
                                                             rx_size);
    uint8_t attempt;

    if ((bus == NULL) || (bus->hi2c == NULL) || (rx_buffer == NULL) || (rx_size == 0U))
    {
        return HAL_ERROR;
    }

    for (attempt = 0U; attempt <= bus->max_retry; ++attempt)
    {
        HAL_StatusTypeDef status;
        uint32_t error_code;

        if (__HAL_I2C_GET_FLAG(bus->hi2c, I2C_FLAG_BUSY) != RESET)
        {
            if (!I2c_RecoverBus(bus))
            {
                return HAL_BUSY;
            }
        }

        status = HAL_I2C_Mem_Read(bus->hi2c,
                                  device_addr_8bit,
                                  register_addr,
                                  mem_addr_size,
                                  rx_buffer,
                                  rx_size,
                                  timeout_ms);

        if (status == HAL_OK)
        {
            return HAL_OK;
        }

        error_code = HAL_I2C_GetError(bus->hi2c);

        if ((error_code & HAL_I2C_ERROR_AF) != 0U)
        {
            /* NACK 不一定代表“总线坏了”。
             * 例如 EEPROM 正在内部写周期时，会在地址阶段主动 NACK。
             */
            HAL_Delay(1U);
            continue;
        }

        if ((status == HAL_TIMEOUT)
         || I2c_ShouldRecoverBus(error_code)
         || (__HAL_I2C_GET_FLAG(bus->hi2c, I2C_FLAG_BUSY) != RESET))
        {
            if (!I2c_RecoverBus(bus))
            {
                return (status == HAL_TIMEOUT) ? HAL_TIMEOUT : HAL_ERROR;
            }

            continue;
        }

        return status;
    }

    return HAL_TIMEOUT;
}

extern I2C_HandleTypeDef hi2c1;

static I2cRobustBus_t g_imu_i2c_bus =
{
    .hi2c = &hi2c1,
    .scl_port = GPIOB,
    .scl_pin = GPIO_PIN_8,
    .sda_port = GPIOB,
    .sda_pin = GPIO_PIN_9,
    .bus_speed_hz = 400000U,
    .stretch_timeout_us = 1500U,
    .bus_free_timeout_us = 200U,
    .max_retry = 2U
};

bool App_ValidateImuI2cPhysicalBudget(void)
{
    float rise_time_ns = 0.0f;

    /* 示例物理预算：
     * R_pullup = 2.2k ohm, C_bus = 90 pF
     * t_r ≈ 0.8473 * 2200 * 90e-12 * 1e9 ≈ 168 ns
     * 对 400 kHz 快速模式仍在 300 ns 预算以内。
     */
    return I2c_CheckRiseTimeBudget(2200U, 90U, g_imu_i2c_bus.bus_speed_hz, &rise_time_ns);
}

HAL_StatusTypeDef App_Mpu6050_ReadAccelGyro(uint8_t raw_buffer[14])
{
    if ((raw_buffer == NULL) || (!App_ValidateImuI2cPhysicalBudget()))
    {
        return HAL_ERROR;
    }

    /* MPU6050 从 0x3B 开始连续输出 14 字节：
     * ACCEL_X/Y/Z, TEMP, GYRO_X/Y/Z
     */
    return I2c_MemReadRobust(&g_imu_i2c_bus,
                             0x68U,
                             0x3BU,
                             I2C_REG_ADDR_8BIT,
                             raw_buffer,
                             14U);
}
```

这段实现真正想表达的，不是“再包一层 HAL”本身，而是一个更底层的事实：**I2C 的失败，往往不是出在函数调用，而是出在物理边界和状态机边界没有被显式管理**。上升沿预算决定你能跑多快，时钟拉伸等待决定你是否尊重从机节奏，NACK 解释决定你是在处理器件忙还是总线坏，9 脉冲恢复则决定系统在异常掉电和噪声打断后能否重新收敛。理解了这些，I2C 才不再是一条“偶尔读不出来”的双线，而是一条可建模、可恢复、可审计的工程总线。
