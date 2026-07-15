---
title: "技能档案：MPU6050 六面体标定、交叉轴失准与 3x3 姿态前补偿"
slug: "skill-mpu6050-six-position-calibration-cross-axis-misalignment-and-3x3-compensation"
date: 2026-06-26T09:40:00+08:00
draft: false
description: "从六面体静态标定、比例因子与零偏分离，到交叉轴失准的 3x3 补偿矩阵，系统拆解 MPU6050 姿态解算前为什么必须先把传感器坐标系校直。"
tags: ["MPU6050", "IMU", "姿态解算", "标定", "矩阵补偿", "STM32", "嵌入式"]
categories: ["技能档案", "控制与融合"]
image: ""
---

## 技能概述
在平衡车、云台、两轮腿足平台和低成本导航里，很多人把 MPU6050 的问题理解成“零偏没调好”或“滤波参数不对”，但真正更早出现的误差，往往来自 **传感器三轴并不真正正交、各轴灵敏度并不一致、封装坐标和机构坐标也未必完全重合**。如果这些误差不先在姿态解算前被补偿，后面的互补滤波、卡尔曼滤波甚至控制器整定，都会在一套歪掉的坐标系上工作。这个主题真正解决的是：如何用六面体静态标定，把重力这个天然基准映射成一组可求解的零偏、比例因子与交叉轴耦合参数，并最终落成 MCU 上可实时执行的 `3x3` 补偿矩阵。

## 核心底层概念解析

- **加速度计看到的不是“姿态角”，而是比力向量**：静止时它测到的主要是重力在传感器坐标系下的投影，理想情况下满足 `||a|| = g`。姿态解算之所以能从加速度反推横滚和俯仰，本质是拿一个已知模长的物理向量去约束坐标系方向。

- **六面体标定不是仪式，而是在构造六个线性独立的约束面**：当 `+X/-X/+Y/-Y/+Z/-Z` 六个朝向依次静置时，理想输出应分别接近 `(+g,0,0)`、`(-g,0,0)` 等六个点。现实输出若偏离这些点，就说明零偏、比例因子和轴间耦合在同时存在。

- **零偏与比例因子至少要先从一维意义上分离**：对某一轴 `x`，若正向静置平均值为 `m_x^+`，反向为 `m_x^-`，则可先得到  
  `b_x = (m_x^+ + m_x^-) / 2`，  
  `s_x = (2g) / (m_x^+ - m_x^-)`。  
  前者回答“零点漂到哪里了”，后者回答“每个 LSB 实际代表多少物理量”。

- **只做逐轴缩放仍然不够，因为三轴常常并不严格正交**：封装焊接、MEMS 结构误差和 PCB 装配偏角会让 `x/y/z` 三轴之间带上少量投影串扰。于是当你明明只让 `x` 轴受重力，`y` 或 `z` 上仍会出现稳定偏置，这不是噪声，而是 **交叉轴失准**。

- **交叉轴失准可以用一个接近单位阵的 `3x3` 矩阵建模**：把原始加速度向量记为 `r`，补偿后向量记为 `a_c`，可写成  
  `a_c = M * (r - b)`。  
  其中 `b` 是三维零偏，`M` 同时吸收比例因子和非正交耦合。理想情况下 `M` 是对角阵，现实里则含有小的非对角项。

- **六面体数据足够支持一个线性最小二乘补偿**：每个静置姿态都对应一个已知参考向量 `a_ref_i`，于是可以求  
  `M = arg min Σ ||a_ref_i - M * (r_i - b)||^2`。  
  这意味着标定的核心不是“记六组数”，而是把物理朝向约束压成一个矩阵拟合问题。

- **为什么先求零偏再求矩阵更稳**：若把 `b` 与 `M` 一起全量拟合，会形成更强的参数耦合，对低成本 IMU 的噪声与静置不充分更敏感。工程上先用正反朝向均值解出 `b`，再在去偏后的数据上拟合 `M`，通常更稳，也更符合 KISS。

- **姿态解算真正依赖的是“方向一致的归一化向量”**：无论是互补滤波还是 Mahony/Madgwick，都会先把加速度向量单位化。若补偿前向量已经被拉歪，那么归一化只能保留歪掉的方向，不会自动修正失准。

- **误差预算里要区分静态可标定误差与动态不可完全标定误差**：零偏、比例因子、交叉轴可通过静态六面体显著压低；而振动整流误差、温漂、安装松动和时变零偏则不会被一次离线标定彻底解决。标定不是终局，只是把确定性几何误差先剥离。

- **数学上，补偿矩阵是在把“传感器内部坐标系”重新映射回“理想正交坐标系”**：这一步如果省略，后续滤波器就是在错误基底上做正确代数，结果仍然会偏。很多人以为滤波能兜底，实际上滤波只会更稳定地输出这个偏差。

- **工程上必须显式限制静止样本的离散程度**：六面体标定依赖“每次放稳”。若窗口内方差太大，说明手还没离开、桌面在震、风扇在抖，算出来的不是姿态面，而是一团厚点云。进入拟合前先做方差门控，比事后抱怨“矩阵怎么不准”更有效。

- **技术哲学上，姿态解算前补偿的本质，是先承认传感器并不天生生活在欧氏理想世界**：数字系统喜欢把三轴看成标准基，但物理器件从来不会天然满足这份抽象。标定的意义，就是在软件里补上一份把真实器件拉回理想模型的契约。

## 代码能力展现

下面给出一段基于 STM32 HAL 风格的 MPU6050 六面体标定与运行时补偿代码。重点不放在 I2C 读写 API 本身，而放在三件更关键的事情上：

- 如何从六个静置面提取 **稳定均值样本**。
- 如何先解 **零偏**，再拟合 **`3x3` 补偿矩阵**。
- 如何把补偿结果无缝接到姿态解算前的 **实时向量预处理**。

```cpp
#include "stm32f4xx_hal.h"

#include <math.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

#define MPU6050_I2C_ADDR_8BIT        (0x68U << 1)
#define MPU6050_REG_ACCEL_XOUT_H     (0x3BU)
#define MPU6050_CAL_SAMPLE_COUNT     (256U)
#define MPU6050_ONE_G_MPS2           (9.80665f)
#define MPU6050_ACCEL_LSB_PER_G      (4096.0f)   /* 假设当前量程为 +/-8g。 */
#define MPU6050_STABLE_STDDEV_LIMIT  (0.015f)    /* 单轴标准差门限，单位 g。 */
#define MPU6050_VECTOR_NORM_MIN_G    (0.50f)
#define MPU6050_VECTOR_NORM_MAX_G    (1.50f)

typedef struct
{
    float x;
    float y;
    float z;
} Vec3f_t;

typedef struct
{
    float m[3][3];
} Mat3f_t;

typedef enum
{
    MPU6050_FACE_POS_X = 0,
    MPU6050_FACE_NEG_X,
    MPU6050_FACE_POS_Y,
    MPU6050_FACE_NEG_Y,
    MPU6050_FACE_POS_Z,
    MPU6050_FACE_NEG_Z,
    MPU6050_FACE_COUNT
} Mpu6050FaceId_t;

typedef struct
{
    Vec3f_t raw_mean_g[MPU6050_FACE_COUNT];
    bool face_valid[MPU6050_FACE_COUNT];
} Mpu6050SixFaceDataset_t;

typedef struct
{
    Vec3f_t bias_g;
    Mat3f_t correction;
    bool valid;
} Mpu6050AccelCalibration_t;

static I2C_HandleTypeDef *g_mpu6050_i2c = NULL;

static float ClampF(float value, float min_value, float max_value)
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

static Vec3f_t Vec3fAdd(Vec3f_t a, Vec3f_t b)
{
    Vec3f_t out = { a.x + b.x, a.y + b.y, a.z + b.z };
    return out;
}

static Vec3f_t Vec3fSub(Vec3f_t a, Vec3f_t b)
{
    Vec3f_t out = { a.x - b.x, a.y - b.y, a.z - b.z };
    return out;
}

static Vec3f_t Vec3fScale(Vec3f_t v, float s)
{
    Vec3f_t out = { v.x * s, v.y * s, v.z * s };
    return out;
}

static float Vec3fDot(Vec3f_t a, Vec3f_t b)
{
    return (a.x * b.x) + (a.y * b.y) + (a.z * b.z);
}

static float Vec3fNorm(Vec3f_t v)
{
    return sqrtf(Vec3fDot(v, v));
}

static Vec3f_t Mat3fMulVec3(const Mat3f_t *m, Vec3f_t v)
{
    Vec3f_t out = { 0.0f, 0.0f, 0.0f };

    if (m == NULL)
    {
        return out;
    }

    out.x = (m->m[0][0] * v.x) + (m->m[0][1] * v.y) + (m->m[0][2] * v.z);
    out.y = (m->m[1][0] * v.x) + (m->m[1][1] * v.y) + (m->m[1][2] * v.z);
    out.z = (m->m[2][0] * v.x) + (m->m[2][1] * v.y) + (m->m[2][2] * v.z);

    return out;
}

static void Mat3fSetIdentity(Mat3f_t *m)
{
    if (m == NULL)
    {
        return;
    }

    (void)memset(m, 0, sizeof(*m));
    m->m[0][0] = 1.0f;
    m->m[1][1] = 1.0f;
    m->m[2][2] = 1.0f;
}

/**
 * @brief 读取 MPU6050 原始加速度三轴数据并映射为 g。
 * @param i2c I2C 句柄。
 * @param accel_g_out 输出三轴加速度，单位 g。
 * @retval true 读取成功。
 * @retval false I2C 访问失败。
 *
 * @note 原始码值到物理量映射公式：
 *       a_g = accel_raw / LSB_PER_G
 *
 *       若量程为 +/-8g，则 LSB_PER_G = 4096。
 */
static bool Mpu6050ReadAccelG(I2C_HandleTypeDef *i2c, Vec3f_t *accel_g_out)
{
    uint8_t raw_buf[6] = { 0 };
    int16_t raw_x = 0;
    int16_t raw_y = 0;
    int16_t raw_z = 0;

    if ((i2c == NULL) || (accel_g_out == NULL))
    {
        return false;
    }

    if (HAL_I2C_Mem_Read(i2c,
                         MPU6050_I2C_ADDR_8BIT,
                         MPU6050_REG_ACCEL_XOUT_H,
                         I2C_MEMADD_SIZE_8BIT,
                         raw_buf,
                         sizeof(raw_buf),
                         50U) != HAL_OK)
    {
        return false;
    }

    raw_x = (int16_t)((raw_buf[0] << 8) | raw_buf[1]);
    raw_y = (int16_t)((raw_buf[2] << 8) | raw_buf[3]);
    raw_z = (int16_t)((raw_buf[4] << 8) | raw_buf[5]);

    accel_g_out->x = (float)raw_x / MPU6050_ACCEL_LSB_PER_G;
    accel_g_out->y = (float)raw_y / MPU6050_ACCEL_LSB_PER_G;
    accel_g_out->z = (float)raw_z / MPU6050_ACCEL_LSB_PER_G;

    return true;
}

/**
 * @brief 采集一组静置窗口样本，并计算均值与标准差。
 * @param i2c I2C 句柄。
 * @param sample_count 采样数量。
 * @param mean_g_out 输出三轴均值，单位 g。
 * @param stddev_g_out 输出三轴标准差，单位 g。
 * @retval true 窗口采集成功。
 * @retval false 读取失败或输入非法。
 *
 * @note 只有窗口方差足够小，才能认为这一面“放稳了”。
 *       这一步是在用统计量过滤掉人为扰动和平台振动。
 */
static bool Mpu6050CollectStableWindow(I2C_HandleTypeDef *i2c,
                                       uint32_t sample_count,
                                       Vec3f_t *mean_g_out,
                                       Vec3f_t *stddev_g_out)
{
    uint32_t i = 0U;
    Vec3f_t sum = { 0.0f, 0.0f, 0.0f };
    Vec3f_t sq_sum = { 0.0f, 0.0f, 0.0f };

    if ((i2c == NULL) || (mean_g_out == NULL) || (stddev_g_out == NULL) || (sample_count == 0U))
    {
        return false;
    }

    for (i = 0U; i < sample_count; ++i)
    {
        Vec3f_t sample = { 0.0f, 0.0f, 0.0f };

        if (!Mpu6050ReadAccelG(i2c, &sample))
        {
            return false;
        }

        sum = Vec3fAdd(sum, sample);
        sq_sum.x += sample.x * sample.x;
        sq_sum.y += sample.y * sample.y;
        sq_sum.z += sample.z * sample.z;

        HAL_Delay(2U);
    }

    mean_g_out->x = sum.x / (float)sample_count;
    mean_g_out->y = sum.y / (float)sample_count;
    mean_g_out->z = sum.z / (float)sample_count;

    stddev_g_out->x = sqrtf(fmaxf((sq_sum.x / (float)sample_count) - (mean_g_out->x * mean_g_out->x), 0.0f));
    stddev_g_out->y = sqrtf(fmaxf((sq_sum.y / (float)sample_count) - (mean_g_out->y * mean_g_out->y), 0.0f));
    stddev_g_out->z = sqrtf(fmaxf((sq_sum.z / (float)sample_count) - (mean_g_out->z * mean_g_out->z), 0.0f));

    return true;
}

static Vec3f_t Mpu6050GetFaceReferenceG(Mpu6050FaceId_t face_id)
{
    switch (face_id)
    {
        case MPU6050_FACE_POS_X: return (Vec3f_t){ +1.0f,  0.0f,  0.0f };
        case MPU6050_FACE_NEG_X: return (Vec3f_t){ -1.0f,  0.0f,  0.0f };
        case MPU6050_FACE_POS_Y: return (Vec3f_t){  0.0f, +1.0f,  0.0f };
        case MPU6050_FACE_NEG_Y: return (Vec3f_t){  0.0f, -1.0f,  0.0f };
        case MPU6050_FACE_POS_Z: return (Vec3f_t){  0.0f,  0.0f, +1.0f };
        case MPU6050_FACE_NEG_Z: return (Vec3f_t){  0.0f,  0.0f, -1.0f };
        default:                 return (Vec3f_t){  0.0f,  0.0f,  0.0f };
    }
}

/**
 * @brief 记录某一静置面的均值样本。
 * @param dataset 六面体数据集。
 * @param face_id 当前朝向。
 * @param mean_g 该面的三轴均值，单位 g。
 * @param stddev_g 该面的三轴标准差，单位 g。
 * @retval true 当前样本有效并已记录。
 * @retval false 当前面不够稳定，应重新放置。
 *
 * @note 稳定性判据同时检查：
 *       1. 各轴标准差是否足够小；
 *       2. 向量模长是否仍接近 1g。
 */
static bool Mpu6050StoreFaceSample(Mpu6050SixFaceDataset_t *dataset,
                                   Mpu6050FaceId_t face_id,
                                   Vec3f_t mean_g,
                                   Vec3f_t stddev_g)
{
    const float norm_g = Vec3fNorm(mean_g);

    if ((dataset == NULL) || (face_id >= MPU6050_FACE_COUNT))
    {
        return false;
    }

    if ((stddev_g.x > MPU6050_STABLE_STDDEV_LIMIT) ||
        (stddev_g.y > MPU6050_STABLE_STDDEV_LIMIT) ||
        (stddev_g.z > MPU6050_STABLE_STDDEV_LIMIT))
    {
        return false;
    }

    if ((norm_g < MPU6050_VECTOR_NORM_MIN_G) || (norm_g > MPU6050_VECTOR_NORM_MAX_G))
    {
        return false;
    }

    dataset->raw_mean_g[face_id] = mean_g;
    dataset->face_valid[face_id] = true;
    return true;
}

/**
 * @brief 由六面体正反朝向均值解算三轴零偏。
 * @param dataset 六面体数据集。
 * @param bias_g_out 输出零偏，单位 g。
 * @retval true 解算成功。
 * @retval false 六面数据不完整。
 *
 * @note 对每一轴：
 *       b_axis = (m_axis^+ + m_axis^-) / 2
 *
 *       因为理想正反朝向应围绕 0 对称，均值中心就是零偏。
 */
static bool Mpu6050SolveBiasFromSixFaces(const Mpu6050SixFaceDataset_t *dataset,
                                         Vec3f_t *bias_g_out)
{
    if ((dataset == NULL) || (bias_g_out == NULL))
    {
        return false;
    }

    if (!dataset->face_valid[MPU6050_FACE_POS_X] || !dataset->face_valid[MPU6050_FACE_NEG_X] ||
        !dataset->face_valid[MPU6050_FACE_POS_Y] || !dataset->face_valid[MPU6050_FACE_NEG_Y] ||
        !dataset->face_valid[MPU6050_FACE_POS_Z] || !dataset->face_valid[MPU6050_FACE_NEG_Z])
    {
        return false;
    }

    bias_g_out->x = 0.5f * (dataset->raw_mean_g[MPU6050_FACE_POS_X].x +
                            dataset->raw_mean_g[MPU6050_FACE_NEG_X].x);
    bias_g_out->y = 0.5f * (dataset->raw_mean_g[MPU6050_FACE_POS_Y].y +
                            dataset->raw_mean_g[MPU6050_FACE_NEG_Y].y);
    bias_g_out->z = 0.5f * (dataset->raw_mean_g[MPU6050_FACE_POS_Z].z +
                            dataset->raw_mean_g[MPU6050_FACE_NEG_Z].z);

    return true;
}

/**
 * @brief 利用六面体数据拟合加速度 `3x3` 补偿矩阵。
 * @param dataset 六面体数据集。
 * @param bias_g 已求得的零偏，单位 g。
 * @param correction_out 输出补偿矩阵。
 * @retval true 拟合成功。
 * @retval false 输入非法或矩阵病态。
 *
 * @note 这里用六组方程分别拟合 M 的三行。对任意参考轴 q:
 *       q_ref_i = m_q0 * x_i + m_q1 * y_i + m_q2 * z_i
 *       其中 [x_i, y_i, z_i]^T = r_i - b
 *
 *       把六组数据写成 A * row_q^T = y_q，
 *       再通过正规方程求解：
 *       row_q^T = inv(A^T * A) * A^T * y_q
 *
 *       这样既保留了对角比例因子，也允许出现小的非对角交叉轴补偿项。
 */
static bool Mpu6050SolveCorrectionMatrix(const Mpu6050SixFaceDataset_t *dataset,
                                         Vec3f_t bias_g,
                                         Mat3f_t *correction_out)
{
    float ata[3][3] = { 0 };
    float aty[3][3] = { 0 };
    float inv[3][3] = { 0 };
    float det = 0.0f;
    uint32_t i = 0U;

    if ((dataset == NULL) || (correction_out == NULL))
    {
        return false;
    }

    for (i = 0U; i < MPU6050_FACE_COUNT; ++i)
    {
        const Vec3f_t x = Vec3fSub(dataset->raw_mean_g[i], bias_g);
        const Vec3f_t y = Mpu6050GetFaceReferenceG((Mpu6050FaceId_t)i);

        ata[0][0] += x.x * x.x;
        ata[0][1] += x.x * x.y;
        ata[0][2] += x.x * x.z;
        ata[1][0] += x.y * x.x;
        ata[1][1] += x.y * x.y;
        ata[1][2] += x.y * x.z;
        ata[2][0] += x.z * x.x;
        ata[2][1] += x.z * x.y;
        ata[2][2] += x.z * x.z;

        /* aty 的第 q 列对应参考向量第 q 维。 */
        aty[0][0] += x.x * y.x;
        aty[1][0] += x.y * y.x;
        aty[2][0] += x.z * y.x;
        aty[0][1] += x.x * y.y;
        aty[1][1] += x.y * y.y;
        aty[2][1] += x.z * y.y;
        aty[0][2] += x.x * y.z;
        aty[1][2] += x.y * y.z;
        aty[2][2] += x.z * y.z;
    }

    det =
        ata[0][0] * (ata[1][1] * ata[2][2] - ata[1][2] * ata[2][1]) -
        ata[0][1] * (ata[1][0] * ata[2][2] - ata[1][2] * ata[2][0]) +
        ata[0][2] * (ata[1][0] * ata[2][1] - ata[1][1] * ata[2][0]);

    if (fabsf(det) < 1.0e-6f)
    {
        return false;
    }

    inv[0][0] =  (ata[1][1] * ata[2][2] - ata[1][2] * ata[2][1]) / det;
    inv[0][1] = -(ata[0][1] * ata[2][2] - ata[0][2] * ata[2][1]) / det;
    inv[0][2] =  (ata[0][1] * ata[1][2] - ata[0][2] * ata[1][1]) / det;
    inv[1][0] = -(ata[1][0] * ata[2][2] - ata[1][2] * ata[2][0]) / det;
    inv[1][1] =  (ata[0][0] * ata[2][2] - ata[0][2] * ata[2][0]) / det;
    inv[1][2] = -(ata[0][0] * ata[1][2] - ata[0][2] * ata[1][0]) / det;
    inv[2][0] =  (ata[1][0] * ata[2][1] - ata[1][1] * ata[2][0]) / det;
    inv[2][1] = -(ata[0][0] * ata[2][1] - ata[0][1] * ata[2][0]) / det;
    inv[2][2] =  (ata[0][0] * ata[1][1] - ata[0][1] * ata[1][0]) / det;

    /*
     * M = (A^T A)^-1 * A^T Y
     * 这里 correction_out->m[row][col] 中：
     * row 表示补偿后的 x/y/z 轴，
     * col 表示原始去偏后的输入分量。
     */
    for (uint32_t row = 0U; row < 3U; ++row)
    {
        for (uint32_t col = 0U; col < 3U; ++col)
        {
            correction_out->m[row][col] =
                (inv[row][0] * aty[0][col]) +
                (inv[row][1] * aty[1][col]) +
                (inv[row][2] * aty[2][col]);
        }
    }

    return true;
}

/**
 * @brief 执行完整的六面体标定流程。
 * @param i2c I2C 句柄。
 * @param calib_out 输出标定结果。
 * @retval true 标定成功。
 * @retval false 任一面采集失败或拟合失败。
 *
 * @note 调用者应在 UI 或上位机提示用户依次放置六个静置面。
 *       这里为突出算法主干，省略人机交互细节。
 */
static bool Mpu6050RunSixFaceCalibration(I2C_HandleTypeDef *i2c,
                                         Mpu6050AccelCalibration_t *calib_out)
{
    Mpu6050SixFaceDataset_t dataset;
    Vec3f_t bias_g = { 0.0f, 0.0f, 0.0f };

    if ((i2c == NULL) || (calib_out == NULL))
    {
        return false;
    }

    (void)memset(&dataset, 0, sizeof(dataset));
    Mat3fSetIdentity(&calib_out->correction);
    calib_out->bias_g = (Vec3f_t){ 0.0f, 0.0f, 0.0f };
    calib_out->valid = false;

    for (uint32_t face = 0U; face < MPU6050_FACE_COUNT; ++face)
    {
        Vec3f_t mean_g = { 0.0f, 0.0f, 0.0f };
        Vec3f_t stddev_g = { 0.0f, 0.0f, 0.0f };

        if (!Mpu6050CollectStableWindow(i2c,
                                        MPU6050_CAL_SAMPLE_COUNT,
                                        &mean_g,
                                        &stddev_g))
        {
            return false;
        }

        if (!Mpu6050StoreFaceSample(&dataset,
                                    (Mpu6050FaceId_t)face,
                                    mean_g,
                                    stddev_g))
        {
            return false;
        }
    }

    if (!Mpu6050SolveBiasFromSixFaces(&dataset, &bias_g))
    {
        return false;
    }

    if (!Mpu6050SolveCorrectionMatrix(&dataset, bias_g, &calib_out->correction))
    {
        return false;
    }

    calib_out->bias_g = bias_g;
    calib_out->valid = true;
    return true;
}

/**
 * @brief 对实时加速度样本应用六面体标定结果。
 * @param raw_accel_g 原始三轴加速度，单位 g。
 * @param calib 标定结果。
 * @return 补偿后的三轴加速度，单位 g。
 *
 * @note 运行时补偿公式：
 *       a_corr = M * (a_raw - b)
 *
 *       这一步应放在姿态解算前，而不是在算完角度后再“补角度”。
 */
static Vec3f_t Mpu6050ApplyAccelCalibration(Vec3f_t raw_accel_g,
                                            const Mpu6050AccelCalibration_t *calib)
{
    Vec3f_t unbiased = raw_accel_g;

    if ((calib == NULL) || !calib->valid)
    {
        return raw_accel_g;
    }

    unbiased = Vec3fSub(raw_accel_g, calib->bias_g);
    return Mat3fMulVec3(&calib->correction, unbiased);
}

/**
 * @brief 计算基于补偿加速度的横滚与俯仰角。
 * @param accel_corr_g 补偿后的三轴加速度，单位 g。
 * @param roll_rad_out 输出横滚角，单位 rad。
 * @param pitch_rad_out 输出俯仰角，单位 rad。
 * @retval true 计算成功。
 * @retval false 向量模长异常，不适合作为重力参考。
 *
 * @note 这里采用静态常见定义：
 *       roll  = atan2(a_y, a_z)
 *       pitch = atan2(-a_x, sqrt(a_y^2 + a_z^2))
 *
 *       只有补偿后的重力向量方向可信，这两个角才有意义。
 */
static bool Mpu6050AccelToTilt(Vec3f_t accel_corr_g,
                               float *roll_rad_out,
                               float *pitch_rad_out)
{
    const float norm_g = Vec3fNorm(accel_corr_g);

    if ((roll_rad_out == NULL) || (pitch_rad_out == NULL))
    {
        return false;
    }

    if ((norm_g < MPU6050_VECTOR_NORM_MIN_G) || (norm_g > MPU6050_VECTOR_NORM_MAX_G))
    {
        return false;
    }

    *roll_rad_out = atan2f(accel_corr_g.y, accel_corr_g.z);
    *pitch_rad_out = atan2f(-accel_corr_g.x,
                            sqrtf((accel_corr_g.y * accel_corr_g.y) +
                                  (accel_corr_g.z * accel_corr_g.z)));
    return true;
}

void Example_Mpu6050AttitudePreprocessStep(const Mpu6050AccelCalibration_t *calib)
{
    Vec3f_t raw_accel_g = { 0.0f, 0.0f, 0.0f };
    Vec3f_t accel_corr_g = { 0.0f, 0.0f, 0.0f };
    float roll_rad = 0.0f;
    float pitch_rad = 0.0f;

    if (g_mpu6050_i2c == NULL)
    {
        return;
    }

    if (!Mpu6050ReadAccelG(g_mpu6050_i2c, &raw_accel_g))
    {
        return;
    }

    accel_corr_g = Mpu6050ApplyAccelCalibration(raw_accel_g, calib);

    if (!Mpu6050AccelToTilt(accel_corr_g, &roll_rad, &pitch_rad))
    {
        return;
    }

    /*
     * roll_rad / pitch_rad 可继续送入互补滤波或卡尔曼滤波。
     * 如果补偿前坐标系是歪的，后级滤波只会更稳定地输出这个歪角度；
     * 因此姿态前补偿应被视为观测模型的一部分，而不是可选优化项。
     */
    (void)roll_rad;
    (void)pitch_rad;
}
```

这段代码真正要表达的工程结论有四个：

- **先解几何，再谈滤波**。`bias + 3x3 correction` 解决的是观测模型本身，互补滤波和卡尔曼滤波解决的是时域融合，二者不能互相替代。
- **六面体标定的价值在于把重力变成可求解约束**。没有这六个已知姿态面，所谓“交叉轴补偿”通常只能停留在猜参数。
- **矩阵补偿应落在原始向量层，而不是角度层**。因为失准发生在坐标变换之前，等角度算出来再修，已经把非线性误差带进去了。
- **静置门控和边界限幅不是装饰**。窗口不稳、模长异常或矩阵病态时宁可拒绝标定，也不要把一套看起来“有结果”的坏参数写进 Flash。

如果继续往工程深处走，下一步通常不是把代码写得更花，而是补上三件事：温度分段标定、安装坐标到机体坐标的外参旋转，以及陀螺零偏与加速度矩阵联合验证。只有这样，MPU6050 才不是“便宜能用”的姿态源，而是一个被约束、被校直、可进入闭环系统的观测前端。
