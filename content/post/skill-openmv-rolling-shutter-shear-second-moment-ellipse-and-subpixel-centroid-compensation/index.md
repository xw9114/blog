---
title: "技能档案：OpenMV 动态目标追踪里的滚动快门剪切、二阶矩椭圆与亚像素质心补偿"
slug: "skill-openmv-rolling-shutter-shear-second-moment-ellipse-and-subpixel-centroid-compensation"
date: 2026-08-07T20:46:12+08:00
draft: false
description: "从行时差、3x3 二项式空域滤波、二阶中心矩椭圆到滚动快门剪切补偿与亚像素质心外推，系统拆解 OpenMV 在高速目标跟踪里为何真正受限于测量时标与形状退化，而不是 blob API。"
tags: ["OpenMV", "STM32", "机器视觉", "目标追踪", "滚动快门", "空域滤波", "亚像素"]
categories: ["技能档案"]
image: ""
---

## 技能概述

`OpenMV` 做动态目标追踪，真正难的往往不是“这一帧里有没有找到目标”，而是**在目标高速运动、机体本身也在抖动的前提下，如何把一团被曝光积分和逐行读出扭曲过的像素，重新整理成一个能送进舵机或云台闭环的、时间上对齐的角度误差**。很多项目在静态场景下 `find_blobs()` 看起来很稳，一上快目标或快速转头就开始“锁住但打不中”，根因通常不是阈值没调好，而是没有处理滚动快门行时差、拖影带来的形状退化，以及质心测量和控制时刻之间的时间错位。这个主题要解决的核心痛点，就是把动态追踪从“找色块”提升成“修正测量时标与形状退化”的系统问题。

## 核心底层概念解析

- **滚动快门不是一张同时拍下来的平面，而是一段按行展开的时间切片**：若传感器逐行读出，每一行的有效成像时刻近似满足 `t_row(y) = t_vsync + y * T_row + T_exp / 2`。这意味着图像坐标里的 `y` 不只是空间位置，也暗含了时间顺序。目标或机体一旦在曝光期间运动，同一帧内部就会自带时间梯度。

- **高速目标在滚动快门下首先表现为剪切，而不是“普通噪声”**：若目标在像平面上的水平速度为 `v_u`，则行间时间差会形成近似位移 `Delta u_rs(y) ~= v_u * (y - y_0) * T_row`。如果机体绕垂直轴旋转且小角近似成立，则又有 `v_u ~= f_x * omega_yaw`。所以很多“斜着拉开的色块”，本质上是角速度被焦距映射进了像素平面。

- **曝光拖影是时间积分的结果，不能仅靠阈值把它“调没”**：曝光时间为 `T_exp` 时，目标沿主运动方向的拖影长度近似 `L_blur ~= |v_img| * T_exp`。缩短曝光能减小拖影，却会牺牲光子数和信噪比；拉高增益又会把随机噪声、固定图样噪声和颜色漂移放大。边缘视觉的约束，永远是**时域清晰度**与**光照预算**之间的交易。

- **3x3 二项式核比简单均值核更适合作为前端空域低通**：常用核  
  `K = (1 / 16) * [[1, 2, 1], [2, 4, 2], [1, 2, 1]]`  
  是离散高斯的廉价近似。它比 `3x3` 盒式均值更少拉平边缘，又能压掉孤立亮点和行噪声。对动态追踪来说，空域滤波的目标不是把图“抹好看”，而是让后续质心和二阶矩少被高频毛刺劫持。

- **亚像素质心不应该用包围盒中心替代，而应由图像矩直接定义**：对候选区域的加权亮度场 `I(x, y)`，有 `M00 = Sigma I`、`M10 = Sigma xI`、`M01 = Sigma yI`，于是 `u = M10 / M00`、`v = M01 / M00`。只要前景边缘被拖影拉长或局部饱和，包围盒中心就会系统偏离，而加权质心至少仍在“能量中心”意义上可解释。

- **二阶中心矩给出的不是一个抽象矩阵，而是目标在像面上的惯性椭圆**：令 `mu20`、`mu02`、`mu11` 为二阶中心矩，则主轴角度  
  `phi = 0.5 * atan2(2 * mu11, mu20 - mu02)`，  
  主轴方差  
  `lambda_1,2 = 0.5 * [(mu20 + mu02) ± sqrt((mu20 - mu02)^2 + 4 * mu11^2)]`。  
  这两个特征值告诉你目标是接近圆斑，还是已经被拉成一条偏心很大的拖影椭圆。

- **主轴额外方差可以反推拖影长度，而不是只把“长条形目标”当异常丢掉**：若静态目标经标定后的主轴基线方差为 `sigma_0^2`，而运动时主轴上多出的模糊近似来自均匀线性拖影，则有 `sigma_blur^2 ~= L_blur^2 / 12`，于是  
  `L_blur ~= sqrt(max(0, 12 * (lambda_1 - sigma_0^2)))`。  
  这让你能区分“真的出现了细长反光条”和“同一个目标只是因为曝光与运动被拉长了”。

- **真正该送进控制器的，不是 frame done 时刻的质心，而是被外推到控制参考时刻的质心**：质心对应的有效时间更接近  
  `t_c = t_vsync + T_exp / 2 + v * T_row`。  
  若当前控制参考时刻为 `t_ref`，且像素速度估计为 `v_hat = [v_u, v_v]`，则应做  
  `u_ref = u_raw + v_u * (t_ref - t_c)`，  
  `v_ref = v_raw + v_v * (t_ref - t_c)`。  
  不做这步，控制器闭环用到的其实是“几毫秒前那团像素的中心”。

- **像素误差只有在时标对齐后，才有资格映射成舵机角误差**：相机内参为 `f_x`、`f_y`、主点为 `(c_x, c_y)` 时，小系统常用  
  `theta_yaw = atan((u_ref - c_x) / f_x)`，  
  `theta_pitch = atan((v_ref - c_y) / f_y)`。  
  这里最关键的不是反正切本身，而是 `u_ref`、`v_ref` 已经被纠正到控制器真正工作的那一拍。

- **形状门控比“单纯面积门槛”更接近高速追踪的真实失效模式**：把 `shape_ratio = lambda_1 / max(lambda_2, epsilon)` 与 `fill_ratio = A_blob / A_bbox` 一起看，能同时识别两类错误：一类是拖影过重、已经退化成近似线段的目标；另一类是碎裂噪点拼出的稀疏假目标。边缘节点要做的不是盲目追求“都别漏”，而是拒绝那些已经丧失几何解释权的测量。

- **OpenMV 这类小系统真正值钱的不是更复杂的检测器，而是更诚实的测量模型**：先接受传感器逐行读出这件事，再用低成本空域滤波稳定矩估计，用二阶矩解释形状退化，用时间外推把质心对齐到控制时刻。这样做的哲学是：**把每个 CPU 周期都用在恢复测量物理意义上，而不是把错误更快地送进闭环。**

## 代码能力展现

下面给出一个基于 **STM32 HAL 风格** 的 OpenMV 目标测量精修模块。它假设前级粗检测已经给出一个候选窗口，例如颜色阈值、模板匹配或上一拍预测窗已经把目标大致框住；这段代码不重复实现整套检测器，而是专注四件真正影响高速跟踪精度的事：

- 用 `3x3` 二项式核对候选窗做廉价空域低通；
- 用加权图像矩求亚像素质心与二阶中心矩；
- 用主轴椭圆估计拖影长度和形状可信度；
- 用滚动快门行时差把质心外推到控制参考时刻，再映射成角误差。

```c
#include "stm32f4xx_hal.h"

#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#define OMV_RS_MAX_PATCH_W            96U
#define OMV_RS_MAX_PATCH_H            96U
#define OMV_RS_MAX_PIXELS             (OMV_RS_MAX_PATCH_W * OMV_RS_MAX_PATCH_H)
#define OMV_RS_MIN_MASS               32.0f
#define OMV_RS_MIN_VARIANCE           1.0e-4f
#define OMV_RS_MIN_DT_S               1.0e-4f
#define OMV_RS_MAX_DT_S               0.100f
#define OMV_RS_MAX_TIME_EXTRAP_S      0.030f
#define OMV_RS_MAX_VEL_PX_S           3000.0f

typedef struct
{
    uint16_t x;
    uint16_t y;
    uint16_t w;
    uint16_t h;
    uint8_t threshold;
} OpenMvCandidatePatch_t;

typedef struct
{
    float fx_px;
    float fy_px;
    float cx_px;
    float cy_px;
} OpenMvCameraIntrinsics_t;

typedef struct
{
    float line_time_s;
    float exposure_s;
    float static_major_var_px2;
    float min_fill_ratio;
    float max_shape_ratio;
    float velocity_lpf;
    OpenMvCameraIntrinsics_t camera;
} OpenMvRsMeasureConfig_t;

typedef struct
{
    bool valid;
    float u_ref_px;
    float v_ref_px;
    float vu_px_s;
    float vv_px_s;
    uint32_t last_ref_us;
} OpenMvRsTrackState_t;

typedef struct
{
    bool valid;
    uint16_t active_pixels;
    uint32_t centroid_time_us;
    float u_raw_px;
    float v_raw_px;
    float u_ref_px;
    float v_ref_px;
    float lambda_major_px2;
    float lambda_minor_px2;
    float major_axis_rad;
    float blur_length_px;
    float fill_ratio;
    float shape_ratio;
    float yaw_error_rad;
    float pitch_error_rad;
} OpenMvRsMeasurement_t;

typedef struct
{
    uint8_t filtered[OMV_RS_MAX_PIXELS];
    uint8_t mask[OMV_RS_MAX_PIXELS];
} OpenMvRsScratch_t;

static float OpenMv_ClampF(float value, float min_value, float max_value)
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

static uint16_t OpenMv_ClampI32ToU16(int32_t value, uint16_t min_value, uint16_t max_value)
{
    if (value < (int32_t)min_value)
    {
        return min_value;
    }

    if (value > (int32_t)max_value)
    {
        return max_value;
    }

    return (uint16_t)value;
}

/**
 * @brief 在候选窗内执行 3x3 二项式空域滤波并完成阈值化。
 * @param gray_frame 灰度图首地址，按行连续存放。
 * @param frame_stride_px 一行像素跨度，通常等于图像宽度。
 * @param patch 候选窗口，坐标以整帧像素系表示。
 * @param scratch 工作缓冲区，内部保存滤波结果和二值 mask。
 * @param frame_w_px 整帧宽度。
 * @param frame_h_px 整帧高度。
 *
 * @note 核函数为：
 *       K = (1 / 16) * [[1, 2, 1],
 *                       [2, 4, 2],
 *                       [1, 2, 1]]
 *
 *       与盒式均值相比，该核更接近离散 Gaussian，能在抑制孤立噪点的同时，
 *       尽量少引入额外的质心偏移。
 */
static void OpenMvRs_FilterAndThreshold(const uint8_t *gray_frame,
                                        uint16_t frame_stride_px,
                                        uint16_t frame_w_px,
                                        uint16_t frame_h_px,
                                        const OpenMvCandidatePatch_t *patch,
                                        OpenMvRsScratch_t *scratch)
{
    for (uint16_t py = 0U; py < patch->h; ++py)
    {
        for (uint16_t px = 0U; px < patch->w; ++px)
        {
            uint32_t sum = 0U;
            const uint16_t idx = (uint16_t)((py * patch->w) + px);

            for (int32_t ky = -1; ky <= 1; ++ky)
            {
                const uint16_t fy = OpenMv_ClampI32ToU16((int32_t)patch->y + (int32_t)py + ky,
                                                         0U,
                                                         (uint16_t)(frame_h_px - 1U));
                const uint8_t wy = (uint8_t)((ky == 0) ? 2U : 1U);

                for (int32_t kx = -1; kx <= 1; ++kx)
                {
                    const uint16_t fx = OpenMv_ClampI32ToU16((int32_t)patch->x + (int32_t)px + kx,
                                                             0U,
                                                             (uint16_t)(frame_w_px - 1U));
                    const uint8_t wx = (uint8_t)((kx == 0) ? 2U : 1U);

                    sum += (uint32_t)(wx * wy) * gray_frame[(fy * frame_stride_px) + fx];
                }
            }

            scratch->filtered[idx] = (uint8_t)(sum >> 4);
            scratch->mask[idx] = (scratch->filtered[idx] >= patch->threshold) ? 1U : 0U;
        }
    }
}

/**
 * @brief 基于阈值后的候选窗，计算加权质心、二阶中心矩与形状门控所需统计量。
 * @param patch 候选窗口。
 * @param scratch 工作缓冲区。
 * @param out [out] 输出测量结果的几何部分。
 * @retval true  候选区域满足最小质量要求。
 * @retval false 质量不足或无有效前景。
 *
 * @note 这里使用“超阈值亮度”作为权重：
 *       w(x, y) = I_f(x, y) - T + 1, when I_f >= T
 *
 *       然后计算：
 *       M00 = Sigma w
 *       M10 = Sigma x * w
 *       M01 = Sigma y * w
 *       u = M10 / M00, v = M01 / M00
 *
 *       二阶中心矩与主轴特征值满足：
 *       mu20 = Sigma (x - u)^2 * w / M00
 *       mu02 = Sigma (y - v)^2 * w / M00
 *       mu11 = Sigma (x - u)(y - v) * w / M00
 *       lambda_1,2 = 0.5 * [(mu20 + mu02) ± sqrt((mu20 - mu02)^2 + 4 * mu11^2)]
 */
static bool OpenMvRs_AccumulateMoments(const OpenMvCandidatePatch_t *patch,
                                       const OpenMvRsScratch_t *scratch,
                                       OpenMvRsMeasurement_t *out)
{
    float m00 = 0.0f;
    float m10 = 0.0f;
    float m01 = 0.0f;
    float m20 = 0.0f;
    float m02 = 0.0f;
    float m11 = 0.0f;
    uint16_t x_min = patch->w;
    uint16_t y_min = patch->h;
    uint16_t x_max = 0U;
    uint16_t y_max = 0U;
    uint16_t active_pixels = 0U;

    for (uint16_t py = 0U; py < patch->h; ++py)
    {
        for (uint16_t px = 0U; px < patch->w; ++px)
        {
            const uint16_t idx = (uint16_t)((py * patch->w) + px);

            if (scratch->mask[idx] == 0U)
            {
                continue;
            }

            {
                const float x = (float)(patch->x + px);
                const float y = (float)(patch->y + py);
                const float w = (float)(scratch->filtered[idx] - patch->threshold + 1U);

                m00 += w;
                m10 += x * w;
                m01 += y * w;
                m20 += x * x * w;
                m02 += y * y * w;
                m11 += x * y * w;
            }

            if (px < x_min)
            {
                x_min = px;
            }

            if (py < y_min)
            {
                y_min = py;
            }

            if (px > x_max)
            {
                x_max = px;
            }

            if (py > y_max)
            {
                y_max = py;
            }

            active_pixels++;
        }
    }

    if ((m00 < OMV_RS_MIN_MASS) || (active_pixels == 0U))
    {
        return false;
    }

    out->u_raw_px = m10 / m00;
    out->v_raw_px = m01 / m00;

    {
        const float mu20 = (m20 / m00) - (out->u_raw_px * out->u_raw_px);
        const float mu02 = (m02 / m00) - (out->v_raw_px * out->v_raw_px);
        const float mu11 = (m11 / m00) - (out->u_raw_px * out->v_raw_px);
        const float trace = mu20 + mu02;
        const float delta = sqrtf((mu20 - mu02) * (mu20 - mu02) + (4.0f * mu11 * mu11));

        out->lambda_major_px2 = OpenMv_ClampF(0.5f * (trace + delta), OMV_RS_MIN_VARIANCE, 1.0e6f);
        out->lambda_minor_px2 = OpenMv_ClampF(0.5f * (trace - delta), OMV_RS_MIN_VARIANCE, 1.0e6f);
        out->major_axis_rad = 0.5f * atan2f(2.0f * mu11, mu20 - mu02);
    }

    {
        const uint32_t bbox_w = (uint32_t)(x_max - x_min + 1U);
        const uint32_t bbox_h = (uint32_t)(y_max - y_min + 1U);
        const uint32_t bbox_area = bbox_w * bbox_h;

        out->active_pixels = active_pixels;
        out->fill_ratio = (bbox_area > 0U) ? ((float)active_pixels / (float)bbox_area) : 0.0f;
        out->shape_ratio = out->lambda_major_px2 / OpenMv_ClampF(out->lambda_minor_px2,
                                                                 OMV_RS_MIN_VARIANCE,
                                                                 1.0e6f);
    }

    return true;
}

/**
 * @brief 将亚像素质心从“质心所在行的曝光中点”外推到控制参考时刻。
 * @param cfg 测量配置，包含行时间、曝光时间和相机内参。
 * @param state 追踪状态，内部保存上一拍估计速度。
 * @param frame_start_us 当前帧 VSYNC 起点时间戳，单位 us。
 * @param reference_us 控制参考时间戳，单位 us。
 * @param meas [in,out] 原始几何测量与修正后的结果。
 *
 * @note 质心对应的有效时间近似：
 *       t_c = t_vsync + T_exp / 2 + v_raw * T_row
 *
 *       若上一拍已估出像素速度 (v_u, v_v)，则外推到控制参考时刻：
 *       u_ref = u_raw + v_u * (t_ref - t_c)
 *       v_ref = v_raw + v_v * (t_ref - t_c)
 *
 *       这样做不是“预测未来”，而是把逐行曝光生成的测量对齐到控制器真正闭环的那一拍。
 */
static void OpenMvRs_TimeAlignMeasurement(const OpenMvRsMeasureConfig_t *cfg,
                                          const OpenMvRsTrackState_t *state,
                                          uint32_t frame_start_us,
                                          uint32_t reference_us,
                                          OpenMvRsMeasurement_t *meas)
{
    const float centroid_offset_s = (0.5f * cfg->exposure_s) + (meas->v_raw_px * cfg->line_time_s);
    const float dt_ref_s = OpenMv_ClampF(((float)((int32_t)(reference_us - frame_start_us)) * 1.0e-6f) - centroid_offset_s,
                                         -OMV_RS_MAX_TIME_EXTRAP_S,
                                         OMV_RS_MAX_TIME_EXTRAP_S);

    meas->centroid_time_us = frame_start_us + (uint32_t)lroundf(centroid_offset_s * 1.0e6f);

    if ((state != NULL) && state->valid)
    {
        meas->u_ref_px = meas->u_raw_px + (state->vu_px_s * dt_ref_s);
        meas->v_ref_px = meas->v_raw_px + (state->vv_px_s * dt_ref_s);
    }
    else
    {
        meas->u_ref_px = meas->u_raw_px;
        meas->v_ref_px = meas->v_raw_px;
    }

    meas->yaw_error_rad =
        atanf((meas->u_ref_px - cfg->camera.cx_px) / cfg->camera.fx_px);
    meas->pitch_error_rad =
        atanf(-(meas->v_ref_px - cfg->camera.cy_px) / cfg->camera.fy_px);
}

/**
 * @brief 处理一块候选窗口，输出滚动快门修正后的视觉测量。
 * @param gray_frame 灰度图首地址。
 * @param frame_stride_px 图像行跨度。
 * @param frame_w_px 图像宽度。
 * @param frame_h_px 图像高度。
 * @param patch 候选窗口。
 * @param cfg 测量配置。
 * @param state 上一拍追踪状态，可为 NULL。
 * @param frame_start_us 当前帧 VSYNC 起点时间戳。
 * @param reference_us 本次控制参考时间戳。
 * @param scratch 工作缓冲区。
 * @param out [out] 最终测量结果。
 * @retval true  当前候选窗口给出了可用测量。
 * @retval false 当前测量应拒绝。
 *
 * @note 拖影长度估计采用均匀线性模糊近似：
 *       sigma_blur^2 ~= L_blur^2 / 12
 *       L_blur ~= sqrt(max(0, 12 * (lambda_major - sigma0^2)))
 *
 *       其中 sigma0^2 为静态标定下目标在主轴方向的基线方差。
 */
bool OpenMvRs_RefineCandidateMeasurement(const uint8_t *gray_frame,
                                         uint16_t frame_stride_px,
                                         uint16_t frame_w_px,
                                         uint16_t frame_h_px,
                                         const OpenMvCandidatePatch_t *patch,
                                         const OpenMvRsMeasureConfig_t *cfg,
                                         const OpenMvRsTrackState_t *state,
                                         uint32_t frame_start_us,
                                         uint32_t reference_us,
                                         OpenMvRsScratch_t *scratch,
                                         OpenMvRsMeasurement_t *out)
{
    float extra_var_px2;

    if ((gray_frame == NULL) || (patch == NULL) || (cfg == NULL) || (scratch == NULL) || (out == NULL))
    {
        return false;
    }

    if ((patch->w == 0U) || (patch->h == 0U) ||
        (patch->w > OMV_RS_MAX_PATCH_W) || (patch->h > OMV_RS_MAX_PATCH_H))
    {
        return false;
    }

    memset(out, 0, sizeof(*out));

    OpenMvRs_FilterAndThreshold(gray_frame, frame_stride_px, frame_w_px, frame_h_px, patch, scratch);

    if (!OpenMvRs_AccumulateMoments(patch, scratch, out))
    {
        return false;
    }

    extra_var_px2 = out->lambda_major_px2 - cfg->static_major_var_px2;
    out->blur_length_px = (extra_var_px2 > 0.0f) ? sqrtf(12.0f * extra_var_px2) : 0.0f;

    if ((out->fill_ratio < cfg->min_fill_ratio) || (out->shape_ratio > cfg->max_shape_ratio))
    {
        return false;
    }

    OpenMvRs_TimeAlignMeasurement(cfg, state, frame_start_us, reference_us, out);
    out->valid = true;
    return true;
}

/**
 * @brief 用最新测量更新像素速度状态，供下一拍滚动快门时间对齐使用。
 * @param cfg 配置，内部给出速度一阶低通系数。
 * @param state [in,out] 追踪状态。
 * @param meas 当前已通过门控的测量。
 * @param reference_us 当前控制参考时间戳。
 *
 * @note 速度估计使用一阶低通：
 *       v_est[k] = (1 - alpha) * v_est[k-1] + alpha * ((x[k] - x[k-1]) / dt)
 *
 *       这里不追求最强动态模型，只保留一个足够便宜的速度先验，
 *       目的是让下一帧的质心能被外推到同一控制时间轴上。
 */
void OpenMvRs_UpdateTrackState(const OpenMvRsMeasureConfig_t *cfg,
                               OpenMvRsTrackState_t *state,
                               const OpenMvRsMeasurement_t *meas,
                               uint32_t reference_us)
{
    float dt_s;
    float inst_vu_px_s;
    float inst_vv_px_s;
    float alpha;

    if ((cfg == NULL) || (state == NULL) || (meas == NULL) || (!meas->valid))
    {
        return;
    }

    if (!state->valid)
    {
        state->valid = true;
        state->u_ref_px = meas->u_ref_px;
        state->v_ref_px = meas->v_ref_px;
        state->vu_px_s = 0.0f;
        state->vv_px_s = 0.0f;
        state->last_ref_us = reference_us;
        return;
    }

    dt_s = OpenMv_ClampF((float)((int32_t)(reference_us - state->last_ref_us)) * 1.0e-6f,
                         OMV_RS_MIN_DT_S,
                         OMV_RS_MAX_DT_S);

    inst_vu_px_s = OpenMv_ClampF((meas->u_ref_px - state->u_ref_px) / dt_s,
                                 -OMV_RS_MAX_VEL_PX_S,
                                 OMV_RS_MAX_VEL_PX_S);
    inst_vv_px_s = OpenMv_ClampF((meas->v_ref_px - state->v_ref_px) / dt_s,
                                 -OMV_RS_MAX_VEL_PX_S,
                                 OMV_RS_MAX_VEL_PX_S);

    alpha = OpenMv_ClampF(cfg->velocity_lpf, 0.0f, 1.0f);

    state->vu_px_s = ((1.0f - alpha) * state->vu_px_s) + (alpha * inst_vu_px_s);
    state->vv_px_s = ((1.0f - alpha) * state->vv_px_s) + (alpha * inst_vv_px_s);
    state->u_ref_px = meas->u_ref_px;
    state->v_ref_px = meas->v_ref_px;
    state->last_ref_us = reference_us;
}

static OpenMvRsTrackState_t g_openmv_rs_state;
static OpenMvRsScratch_t g_openmv_rs_scratch;

bool App_OpenMvMeasureCandidateHAL(const uint8_t *frame_gray,
                                   uint16_t frame_width_px,
                                   uint16_t frame_height_px,
                                   uint32_t frame_start_us,
                                   uint32_t control_ref_us,
                                   const OpenMvCandidatePatch_t *candidate,
                                   OpenMvRsMeasurement_t *result)
{
    const OpenMvRsMeasureConfig_t cfg =
    {
        .line_time_s = 17.5e-6f,
        .exposure_s = 2.2e-3f,
        .static_major_var_px2 = 5.8f,
        .min_fill_ratio = 0.38f,
        .max_shape_ratio = 9.0f,
        .velocity_lpf = 0.22f,
        .camera =
        {
            .fx_px = 128.0f,
            .fy_px = 128.0f,
            .cx_px = 80.0f,
            .cy_px = 60.0f
        }
    };

    if (!OpenMvRs_RefineCandidateMeasurement(frame_gray,
                                             frame_width_px,
                                             frame_width_px,
                                             frame_height_px,
                                             candidate,
                                             &cfg,
                                             &g_openmv_rs_state,
                                             frame_start_us,
                                             control_ref_us,
                                             &g_openmv_rs_scratch,
                                             result))
    {
        return false;
    }

    OpenMvRs_UpdateTrackState(&cfg, &g_openmv_rs_state, result, control_ref_us);

    /* 到这里，result->yaw_error_rad / pitch_error_rad 就已经是对齐到控制参考时刻、
     * 并经过滚动快门与拖影形状门控修正后的视觉误差量。
     */
    return true;
}
```

这段实现真正想强调的，不是又造了一个“OpenMV 版 blob 函数”，而是把视觉测量拆成了三份更底层的合同：

- **空间合同**：先用廉价的二项式低通压住高频毛刺，再用加权矩而不是包围盒中心定义质心。
- **形状合同**：用二阶矩主轴判断这团像素究竟还是一个目标，还是已经退化成无意义的拖影线段。
- **时间合同**：把质心从“这一行被曝光的时刻”外推到“控制器真正闭环的时刻”，再去谈像素到角度的映射。

高速目标跟踪里最难的，往往不是识别出“这是不是目标”，而是承认**同一帧内部不同像素并不处在同一个时间上**。只要这一点没被写进算法，后面再漂亮的 PID、再硬的舵机、再高的更新率，都会在错误的测量时标上白白消耗带宽。
