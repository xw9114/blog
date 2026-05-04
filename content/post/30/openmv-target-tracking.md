---
title: "技能档案：OpenMV 动态目标追踪与空域滤波，从 ROI 门控到质心预测"
slug: "skill-openmv-dynamic-target-tracking-spatial-filtering-and-roi-gating"
date: 2026-04-30T10:08:29+08:00
draft: false
description: "从曝光拖影、3x3 空域滤波、连通域矩到 alpha-beta 预测与 ROI 门控，系统拆解 OpenMV 动态目标追踪为何本质上是时空噪声管理。"
tags: ["OpenMV", "STM32", "机器视觉", "目标追踪", "边缘计算"]
categories: ["技能档案"]
image: ""
---

## 技能概述

OpenMV 动态目标追踪真正难的地方，从来不是“这一帧里有没有找到色块”，而是如何让一个资源极紧的边缘视觉节点，在有限曝光、有限 SRAM、有限 CPU 周期和不断抖动的机体姿态里，持续给控制器输出一条可信、稳定、低延迟的目标误差信号。云台锁定、巡线车、空中平台追踪着陆标记、视觉炮台和移动球体跟随之所以依赖这项能力，是因为它把原本充满噪声的像素团块，压缩成一个可以进入控制闭环的状态量。真正的痛点不在 `find_blobs()` 能否返回列表，而在于你是否理解曝光拖影如何污染阈值分割、空域滤波如何在降噪与边缘迟钝之间做取舍、ROI 如何同时承担算力调度和误检抑制、以及质心预测为何必须和时间基准绑定。

## 核心底层概念解析

- **相机看到的不是目标本体，而是曝光时间里的能量积分**：当目标在像面上的速度为 `v_img`，曝光时间为 `T_exp` 时，近似拖影长度满足 `L_blur ≈ v_img * T_exp`。一旦 `L_blur` 接近目标本身的特征宽度，阈值分割得到的就不再是“一个块”，而是一条被时间卷积拉长的亮带。动态目标追踪的第一道误差，往往在传感器积分阶段就已经种下。
- **空域滤波的本质，是在像素平面上主动限制高频噪声带宽**：无论是 3x3 均值、3x3 中值，还是形态学开闭运算，目标都不是“让图更好看”，而是让后续阈值判决少被孤立噪点、热噪声、JPEG 风格块状扰动和边缘振铃绑架。代价同样明确：滤波窗口越大，边缘越钝，质心延迟越重。
- **二值化不是图像处理里的一个小步骤，而是一次不可逆的统计裁决**：像素灰度一旦被阈值裁成 `0/1`，很多细节就回不来了。因此工程上常会先在 LAB 或灰度域做空域净化，再阈值，再连通域。顺序反了，噪声就会被“合法化”为假目标。
- **ROI 不是一个裁剪框，而是嵌入式视觉系统的算力预算器**：整帧扫描复杂度近似 `O(W * H)`，若把搜索收敛到 `w_roi * h_roi`，算量就按面积比缩减。对 `160x120` 的 QQVGA 画面而言，若把搜索窗压到 `64x64`，单帧遍历量会降到原来的约 `21%`。ROI 在这里同时承担两项职责：一是给 MCU 节流，二是把误检概率关在预测窗口之外。
- **连通域的质心不是“看起来在中间”，而是图像矩的结果**：对二值目标区域 `B(x, y)`，零阶矩 `M00 = Σ B(x, y)` 对应面积，一阶矩 `M10 = Σ x * B(x, y)`、`M01 = Σ y * B(x, y)` 对应位置加权和，质心满足 `cx = M10 / M00`、`cy = M01 / M00`。这意味着只要分割边缘发生系统偏斜，质心就会跟着漂。
- **动态追踪的关键不是“每帧都重新找”，而是“先预测，再验证”**：若仅依赖每一帧独立检测，目标短暂遮挡、边缘抖动或一帧曝光过饱和都会让跟踪中心突然跳跃。更稳妥的做法是先用运动模型预测当前位置，再在预测邻域内做门控搜索，把检测从“全局发现问题”降成“局部验证假设”。
- **alpha-beta 滤波之所以适合 OpenMV，不是因为它最先进，而是因为它足够便宜**：在常速度假设下，离散模型可写成 `x_pred = x_prev + v_prev * dt`，残差 `r = z - x_pred`，更新为 `x = x_pred + alpha * r`、`v = v_prev + beta * r / dt`。它本质上是一个去掉矩阵求逆的轻量状态估计器，用很小的算力换取比“直接用当前质心”更低的抖动。
- **门控距离是误检与失锁之间的工程妥协**：门限设太大，背景里随便一个亮斑都可能被错误接管；门限设太小，目标稍微加速或机体抖一下就会被判丢失。所谓鲁棒跟踪，不是把门限设死，而是让门限、目标面积和 ROI 大小一起围绕系统动态范围协同变化。
- **像素误差最终必须翻译回控制坐标系**：若相机焦距为 `fx`、`fy`，主点为 `(cx, cy)`，则目标偏航和俯仰方向的小角误差近似为 `theta_yaw = atan((u - cx) / fx)`、`theta_pitch = atan((v - cy) / fy)`。从这里开始，视觉误差才真正进入云台、电机或舵机闭环。也就是说，追踪器不是图像模块，而是控制系统的前端传感器。
- **空域滤波和时域滤波必须彼此让路**：空域窗口太大，会让目标边缘和质心都变慢；时域滤波太重，又会把真实加速度当成噪声吃掉。很多“追不住快速目标”的问题，本质不是算法没找到，而是滤波器把目标运动本身抹平了。
- **OpenMV 这类边缘视觉节点的哲学，不是追求最复杂的模型，而是把每个 CPU 周期都花在能显著降低误检和抖动的地方**：先在像素层压噪，再在几何层提质心，再在时域层做预测，最后再把剩余误差交给控制器。这条链路看似朴素，却比一味堆更大的网络更符合小系统的物理边界。

## 代码能力展现

下面给出一个基于 STM32 HAL 场景的 OpenMV 式动态目标追踪核心示例。代码假设上游已经通过 DCMI + DMA 或 OpenMV 帧缓冲拿到一帧 `QQVGA(160x120)` 灰度图，本段不重复展开传感器驱动，而是聚焦四个真正决定稳定性的环节：**ROI 限域、3x3 空域滤波与阈值化、最大连通域矩质心提取、alpha-beta 预测更新与像素到角误差映射**。

```c
#include "stm32f4xx_hal.h"
#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#define OPENMV_TRACK_FRAME_MAX_W         160U
#define OPENMV_TRACK_FRAME_MAX_H         120U
#define OPENMV_TRACK_MAX_PIXELS          (OPENMV_TRACK_FRAME_MAX_W * OPENMV_TRACK_FRAME_MAX_H)
#define OPENMV_TRACK_MIN_DT_S            0.001f
#define OPENMV_TRACK_MAX_DT_S            0.100f
#define OPENMV_TRACK_MIN_ROI_SIZE        24U
#define OPENMV_TRACK_FULL_REACQUIRE_LOSS 3U

typedef struct
{
    uint16_t x;
    uint16_t y;
    uint16_t w;
    uint16_t h;
} OpenMvRoi_t;

typedef struct
{
    float fx_px;
    float fy_px;
    float cx_px;
    float cy_px;
} OpenMvCameraModel_t;

typedef struct
{
    bool valid;
    uint16_t area_px;
    uint16_t x_min;
    uint16_t y_min;
    uint16_t x_max;
    uint16_t y_max;
    float centroid_x_px;
    float centroid_y_px;
    float confidence;
} OpenMvBlob_t;

typedef struct
{
    uint16_t frame_width_px;
    uint16_t frame_height_px;
    uint8_t gray_threshold;
    uint16_t min_blob_area_px;
    float alpha;
    float beta;
    float gate_distance_px;
    uint16_t search_margin_px;
    uint16_t reacquire_margin_px;
    OpenMvCameraModel_t camera;
} OpenMvTrackConfig_t;

typedef struct
{
    OpenMvTrackConfig_t cfg;
    OpenMvRoi_t roi;
    bool locked;
    uint8_t lost_frames;
    float est_x_px;
    float est_y_px;
    float vel_x_px_s;
    float vel_y_px_s;
    uint32_t last_timestamp_ms;
    uint8_t mask[OPENMV_TRACK_MAX_PIXELS];
    uint8_t scratch[OPENMV_TRACK_MAX_PIXELS];
    uint16_t queue[OPENMV_TRACK_MAX_PIXELS];
} OpenMvTracker_t;

typedef struct
{
    bool locked;
    OpenMvBlob_t measurement;
    OpenMvRoi_t next_roi;
    float tracked_x_px;
    float tracked_y_px;
    float yaw_error_rad;
    float pitch_error_rad;
    float residual_px;
} OpenMvTrackResult_t;

static uint16_t OpenMv_ClampU16(uint16_t value, uint16_t min_value, uint16_t max_value)
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

static float OpenMv_ClampFloat(float value, float min_value, float max_value)
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

static OpenMvRoi_t OpenMv_MakeClampedRoi(const OpenMvTrackConfig_t *cfg,
                                         float center_x_px,
                                         float center_y_px,
                                         uint16_t desired_w,
                                         uint16_t desired_h)
{
    OpenMvRoi_t roi;
    int32_t left;
    int32_t top;

    desired_w = OpenMv_ClampU16(desired_w, OPENMV_TRACK_MIN_ROI_SIZE, cfg->frame_width_px);
    desired_h = OpenMv_ClampU16(desired_h, OPENMV_TRACK_MIN_ROI_SIZE, cfg->frame_height_px);

    left = (int32_t)lroundf(center_x_px - ((float)desired_w * 0.5f));
    top = (int32_t)lroundf(center_y_px - ((float)desired_h * 0.5f));

    if (left < 0)
    {
        left = 0;
    }

    if (top < 0)
    {
        top = 0;
    }

    if ((left + desired_w) > cfg->frame_width_px)
    {
        left = (int32_t)cfg->frame_width_px - (int32_t)desired_w;
    }

    if ((top + desired_h) > cfg->frame_height_px)
    {
        top = (int32_t)cfg->frame_height_px - (int32_t)desired_h;
    }

    roi.x = (uint16_t)left;
    roi.y = (uint16_t)top;
    roi.w = desired_w;
    roi.h = desired_h;
    return roi;
}

/**
 * @brief 初始化 OpenMV 风格的轻量目标追踪器。
 * @param tracker 追踪器状态句柄，内部持有 ROI、速度状态与工作缓冲区。
 * @param cfg 追踪参数配置，包括阈值、门控半径、相机模型与搜索窗口策略。
 *
 * @note 这里默认将初始 ROI 设为整帧，适合首次捕获目标；一旦进入锁定状态，
 *       后续会自动缩到预测附近，借此把 CPU 周期集中花在最可能出现目标的位置。
 */
void OpenMvTracker_Init(OpenMvTracker_t *tracker, const OpenMvTrackConfig_t *cfg)
{
    if ((tracker == NULL) || (cfg == NULL))
    {
        return;
    }

    memset(tracker, 0, sizeof(*tracker));
    tracker->cfg = *cfg;
    tracker->roi.x = 0U;
    tracker->roi.y = 0U;
    tracker->roi.w = cfg->frame_width_px;
    tracker->roi.h = cfg->frame_height_px;
}

/**
 * @brief 在 ROI 内执行 3x3 均值滤波并立即完成灰度阈值化。
 * @param gray_frame 灰度帧首地址，按行连续存放。
 * @param frame_stride_px 一行像素跨度，通常等于图像宽度。
 * @param roi 当前搜索窗口。
 * @param threshold 灰度阈值，滤波后的像素大于等于该值时标为前景。
 * @param mask 输出二值掩码，ROI 内索引采用 row-major 排布。
 *
 * @note 数学形式为：
 *       I_f(x, y) = (1 / 9) * sum(sum(I(x + i, y + j))), i, j ∈ {-1, 0, 1}
 *       B(x, y) = 1, when I_f(x, y) >= threshold; else 0
 *       先低通再阈值化，能够以极低算力压掉孤立高频噪声。
 */
static void OpenMv_BoxFilterThreshold3x3(const uint8_t *gray_frame,
                                         uint16_t frame_stride_px,
                                         const OpenMvRoi_t *roi,
                                         uint8_t threshold,
                                         uint8_t *mask)
{
    for (uint16_t ry = 0U; ry < roi->h; ++ry)
    {
        for (uint16_t rx = 0U; rx < roi->w; ++rx)
        {
            uint32_t sum = 0U;

            for (int32_t ky = -1; ky <= 1; ++ky)
            {
                const uint16_t py =
                    OpenMv_ClampI32ToU16((int32_t)roi->y + (int32_t)ry + ky, 0U, (uint16_t)(OPENMV_TRACK_FRAME_MAX_H - 1U));

                for (int32_t kx = -1; kx <= 1; ++kx)
                {
                    const uint16_t px =
                        OpenMv_ClampI32ToU16((int32_t)roi->x + (int32_t)rx + kx, 0U, (uint16_t)(OPENMV_TRACK_FRAME_MAX_W - 1U));
                    sum += gray_frame[(py * frame_stride_px) + px];
                }
            }

            mask[(ry * roi->w) + rx] = ((sum / 9U) >= threshold) ? 1U : 0U;
        }
    }
}

/**
 * @brief 对二值掩码执行 3x3 多数滤波，去掉孤立噪点并填补极小空洞。
 * @param tracker 追踪器句柄，借用内部 scratch 缓冲区作为中间结果。
 * @param roi 当前 ROI。
 *
 * @note 多数滤波规则为：
 *       B_f(x, y) = 1, when sum(sum(B(x + i, y + j))) >= 5
 *       它比直接膨胀/腐蚀更克制，适合在 MCU 上做一次轻量的空间一致性约束。
 */
static void OpenMv_BinaryMajority3x3(OpenMvTracker_t *tracker, const OpenMvRoi_t *roi)
{
    for (uint16_t ry = 0U; ry < roi->h; ++ry)
    {
        for (uint16_t rx = 0U; rx < roi->w; ++rx)
        {
            uint8_t votes = 0U;

            for (int32_t ky = -1; ky <= 1; ++ky)
            {
                const uint16_t sy =
                    OpenMv_ClampI32ToU16((int32_t)ry + ky, 0U, (uint16_t)(roi->h - 1U));

                for (int32_t kx = -1; kx <= 1; ++kx)
                {
                    const uint16_t sx =
                        OpenMv_ClampI32ToU16((int32_t)rx + kx, 0U, (uint16_t)(roi->w - 1U));
                    votes += tracker->mask[(sy * roi->w) + sx];
                }
            }

            tracker->scratch[(ry * roi->w) + rx] = (votes >= 5U) ? 1U : 0U;
        }
    }

    memcpy(tracker->mask, tracker->scratch, (size_t)roi->w * (size_t)roi->h);
}

/**
 * @brief 在当前 ROI 的二值掩码中提取最大连通域，并计算面积、包围盒与质心。
 * @param tracker 追踪器句柄，内部 queue 用作 flood-fill 队列。
 * @param roi 当前搜索窗口。
 * @param out_blob 输出的最大目标测量值。
 *
 * @note 对二值区域 B(x, y)：
 *       M00 = sum(B), M10 = sum(x * B), M01 = sum(y * B)
 *       cx = M10 / M00, cy = M01 / M00
 *       这里显式使用图像矩而不是“包围盒中心”，因为矩质心更能反映真实前景分布。
 */
static void OpenMv_ExtractLargestBlob(OpenMvTracker_t *tracker,
                                      const OpenMvRoi_t *roi,
                                      OpenMvBlob_t *out_blob)
{
    static const int8_t kNeighborX[8] = {1, 1, 0, -1, -1, -1, 0, 1};
    static const int8_t kNeighborY[8] = {0, 1, 1, 1, 0, -1, -1, -1};

    memset(out_blob, 0, sizeof(*out_blob));

    for (uint16_t ry = 0U; ry < roi->h; ++ry)
    {
        for (uint16_t rx = 0U; rx < roi->w; ++rx)
        {
            const uint16_t seed_index = (ry * roi->w) + rx;
            uint16_t head = 0U;
            uint16_t tail = 0U;
            uint32_t area = 0U;
            uint32_t m10 = 0U;
            uint32_t m01 = 0U;
            uint16_t min_x = rx;
            uint16_t max_x = rx;
            uint16_t min_y = ry;
            uint16_t max_y = ry;

            if (tracker->mask[seed_index] == 0U)
            {
                continue;
            }

            tracker->mask[seed_index] = 2U;
            tracker->queue[tail++] = seed_index;

            while (head < tail)
            {
                const uint16_t current_index = tracker->queue[head++];
                const uint16_t cx_local = (uint16_t)(current_index % roi->w);
                const uint16_t cy_local = (uint16_t)(current_index / roi->w);
                const uint16_t cx_frame = (uint16_t)(roi->x + cx_local);
                const uint16_t cy_frame = (uint16_t)(roi->y + cy_local);

                area++;
                m10 += cx_frame;
                m01 += cy_frame;

                if (cx_local < min_x)
                {
                    min_x = cx_local;
                }

                if (cx_local > max_x)
                {
                    max_x = cx_local;
                }

                if (cy_local < min_y)
                {
                    min_y = cy_local;
                }

                if (cy_local > max_y)
                {
                    max_y = cy_local;
                }

                for (uint8_t k = 0U; k < 8U; ++k)
                {
                    const int32_t nx = (int32_t)cx_local + kNeighborX[k];
                    const int32_t ny = (int32_t)cy_local + kNeighborY[k];

                    if ((nx < 0) || (ny < 0) || (nx >= roi->w) || (ny >= roi->h))
                    {
                        continue;
                    }

                    const uint16_t next_index = (uint16_t)((ny * roi->w) + nx);

                    if (tracker->mask[next_index] == 1U)
                    {
                        tracker->mask[next_index] = 2U;
                        tracker->queue[tail++] = next_index;
                    }
                }
            }

            if ((area >= tracker->cfg.min_blob_area_px) && (area > out_blob->area_px))
            {
                const uint32_t bbox_area =
                    (uint32_t)(max_x - min_x + 1U) * (uint32_t)(max_y - min_y + 1U);
                const float fill_ratio = (bbox_area > 0U) ? ((float)area / (float)bbox_area) : 0.0f;
                const float area_ratio = (float)area / (float)(roi->w * roi->h);

                out_blob->valid = true;
                out_blob->area_px = (uint16_t)area;
                out_blob->x_min = (uint16_t)(roi->x + min_x);
                out_blob->x_max = (uint16_t)(roi->x + max_x);
                out_blob->y_min = (uint16_t)(roi->y + min_y);
                out_blob->y_max = (uint16_t)(roi->y + max_y);
                out_blob->centroid_x_px = (float)m10 / (float)area;
                out_blob->centroid_y_px = (float)m01 / (float)area;
                out_blob->confidence = OpenMv_ClampFloat(fill_ratio * area_ratio * 4.0f, 0.0f, 1.0f);
            }
        }
    }
}

/**
 * @brief 处理一帧灰度图，输出目标跟踪结果与下一帧 ROI。
 * @param tracker 追踪器状态句柄。
 * @param gray_frame 当前灰度帧首地址。
 * @param frame_stride_px 帧行跨度，单位像素。
 * @param timestamp_ms 当前帧时间戳，单位 ms。
 * @param out_result 输出追踪结果。
 * @retval HAL_OK 本帧处理成功。
 * @retval HAL_ERROR 参数非法或图像尺寸越界。
 *
 * @note 时间更新采用 alpha-beta 预测器：
 *       x_pred = x_prev + v_prev * dt
 *       r = z - x_pred
 *       x_new = x_pred + alpha * r
 *       v_new = v_prev + beta * r / dt
 *       同时把像素误差映射为视轴角误差：
 *       theta_yaw = atan((u - cx) / fx)
 *       theta_pitch = atan((v - cy) / fy)
 */
HAL_StatusTypeDef OpenMvTracker_Update(OpenMvTracker_t *tracker,
                                       const uint8_t *gray_frame,
                                       uint16_t frame_stride_px,
                                       uint32_t timestamp_ms,
                                       OpenMvTrackResult_t *out_result)
{
    OpenMvBlob_t blob = {0};
    OpenMvRoi_t work_roi;
    float dt_s;
    float pred_x_px;
    float pred_y_px;
    float residual_x_px = 0.0f;
    float residual_y_px = 0.0f;

    if ((tracker == NULL) || (gray_frame == NULL) || (out_result == NULL))
    {
        return HAL_ERROR;
    }

    if ((tracker->cfg.frame_width_px > OPENMV_TRACK_FRAME_MAX_W) ||
        (tracker->cfg.frame_height_px > OPENMV_TRACK_FRAME_MAX_H))
    {
        return HAL_ERROR;
    }

    memset(out_result, 0, sizeof(*out_result));

    if (tracker->last_timestamp_ms == 0U)
    {
        tracker->last_timestamp_ms = timestamp_ms;
    }

    dt_s = (float)(timestamp_ms - tracker->last_timestamp_ms) * 0.001f;
    dt_s = OpenMv_ClampFloat(dt_s, OPENMV_TRACK_MIN_DT_S, OPENMV_TRACK_MAX_DT_S);

    if (tracker->locked)
    {
        pred_x_px = tracker->est_x_px + (tracker->vel_x_px_s * dt_s);
        pred_y_px = tracker->est_y_px + (tracker->vel_y_px_s * dt_s);
        work_roi = OpenMv_MakeClampedRoi(&tracker->cfg, pred_x_px, pred_y_px, tracker->roi.w, tracker->roi.h);
    }
    else
    {
        pred_x_px = 0.5f * (float)tracker->cfg.frame_width_px;
        pred_y_px = 0.5f * (float)tracker->cfg.frame_height_px;
        work_roi = tracker->roi;
    }

    OpenMv_BoxFilterThreshold3x3(gray_frame, frame_stride_px, &work_roi, tracker->cfg.gray_threshold, tracker->mask);
    OpenMv_BinaryMajority3x3(tracker, &work_roi);
    OpenMv_ExtractLargestBlob(tracker, &work_roi, &blob);

    if (blob.valid)
    {
        residual_x_px = blob.centroid_x_px - pred_x_px;
        residual_y_px = blob.centroid_y_px - pred_y_px;

        /* 门控逻辑的作用，不是拒绝一切偏差，而是避免背景里偶然冒出的高亮块
         * 直接接管整个轨迹。若残差越界，则本帧视作测量无效，改走丢失分支。
         */
        if (tracker->locked)
        {
            const float residual_norm =
                sqrtf((residual_x_px * residual_x_px) + (residual_y_px * residual_y_px));

            if (residual_norm > tracker->cfg.gate_distance_px)
            {
                blob.valid = false;
            }
        }
    }

    if (blob.valid)
    {
        const uint16_t blob_w = (uint16_t)(blob.x_max - blob.x_min + 1U);
        const uint16_t blob_h = (uint16_t)(blob.y_max - blob.y_min + 1U);
        const uint16_t next_w = (uint16_t)(blob_w + blob_w + tracker->cfg.search_margin_px);
        const uint16_t next_h = (uint16_t)(blob_h + blob_h + tracker->cfg.search_margin_px);

        tracker->est_x_px = pred_x_px + (tracker->cfg.alpha * residual_x_px);
        tracker->est_y_px = pred_y_px + (tracker->cfg.alpha * residual_y_px);
        tracker->vel_x_px_s += (tracker->cfg.beta * residual_x_px) / dt_s;
        tracker->vel_y_px_s += (tracker->cfg.beta * residual_y_px) / dt_s;
        tracker->locked = true;
        tracker->lost_frames = 0U;
        tracker->roi = OpenMv_MakeClampedRoi(&tracker->cfg, tracker->est_x_px, tracker->est_y_px, next_w, next_h);
    }
    else
    {
        tracker->lost_frames++;
        tracker->est_x_px = pred_x_px;
        tracker->est_y_px = pred_y_px;

        if (tracker->lost_frames >= OPENMV_TRACK_FULL_REACQUIRE_LOSS)
        {
            tracker->locked = false;
            tracker->vel_x_px_s = 0.0f;
            tracker->vel_y_px_s = 0.0f;
            tracker->roi.x = 0U;
            tracker->roi.y = 0U;
            tracker->roi.w = tracker->cfg.frame_width_px;
            tracker->roi.h = tracker->cfg.frame_height_px;
        }
        else
        {
            const uint16_t expand_w = (uint16_t)(tracker->roi.w + tracker->cfg.reacquire_margin_px);
            const uint16_t expand_h = (uint16_t)(tracker->roi.h + tracker->cfg.reacquire_margin_px);
            tracker->roi = OpenMv_MakeClampedRoi(&tracker->cfg, pred_x_px, pred_y_px, expand_w, expand_h);
        }
    }

    tracker->last_timestamp_ms = timestamp_ms;

    out_result->locked = tracker->locked;
    out_result->measurement = blob;
    out_result->next_roi = tracker->roi;
    out_result->tracked_x_px = tracker->est_x_px;
    out_result->tracked_y_px = tracker->est_y_px;
    out_result->residual_px = sqrtf((residual_x_px * residual_x_px) + (residual_y_px * residual_y_px));
    out_result->yaw_error_rad =
        atanf((tracker->est_x_px - tracker->cfg.camera.cx_px) / tracker->cfg.camera.fx_px);
    out_result->pitch_error_rad =
        atanf(-(tracker->est_y_px - tracker->cfg.camera.cy_px) / tracker->cfg.camera.fy_px);

    return HAL_OK;
}

static OpenMvTracker_t g_openmv_tracker;

void App_OpenMvTrackerInit(void)
{
    const OpenMvTrackConfig_t cfg =
    {
        .frame_width_px = 160U,
        .frame_height_px = 120U,
        .gray_threshold = 145U,
        .min_blob_area_px = 18U,
        .alpha = 0.70f,
        .beta = 0.18f,
        .gate_distance_px = 28.0f,
        .search_margin_px = 18U,
        .reacquire_margin_px = 24U,
        .camera =
        {
            .fx_px = 128.0f,
            .fy_px = 128.0f,
            .cx_px = 80.0f,
            .cy_px = 60.0f
        }
    };

    OpenMvTracker_Init(&g_openmv_tracker, &cfg);
}

HAL_StatusTypeDef App_ProcessOpenMvFrame(const uint8_t *gray_frame, uint32_t frame_timestamp_ms)
{
    OpenMvTrackResult_t result;

    if (OpenMvTracker_Update(&g_openmv_tracker,
                             gray_frame,
                             g_openmv_tracker.cfg.frame_width_px,
                             frame_timestamp_ms,
                             &result) != HAL_OK)
    {
        return HAL_ERROR;
    }

    /* 到这里，yaw_error_rad / pitch_error_rad 就已经是可以直接送进云台
     * 或底盘控制器的视觉误差量，而不再只是“图像上偏了多少像素”。
     */
    if (result.locked && result.measurement.valid)
    {
        /* 例如：VisionGimbal_SetError(result.yaw_error_rad, result.pitch_error_rad); */
    }

    return HAL_OK;
}
```

这段实现真正想强调的，不是“OpenMV 也能做个追踪器”，而是边缘视觉系统必须把每一层噪声都压回它该待的位置。3x3 空域滤波先把像素层的尖噪点削平，二值多数滤波再把孤立误检从空间一致性上踢出去；连通域图像矩把“看起来像在这儿”的感觉变成可审计的质心坐标；alpha-beta 预测器则把上一帧的速度信息带进来，让 ROI 不再像无头苍蝇一样全图乱扫。最终输出的不是某个 API 返回的 blob，而是一对已经映射到相机视轴的角误差。这才是动态目标追踪真正接入闭环控制时，工程上最值钱的那部分能力。
