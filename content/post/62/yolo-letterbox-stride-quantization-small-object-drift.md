---
title: "技能档案：YOLO 边缘部署里的 Letterbox 坐标逆映射、Stride 栅格量化与小目标框漂移补偿"
slug: "skill-yolo-edge-letterbox-inverse-mapping-stride-quantization-and-small-object-box-drift-compensation"
date: 2026-06-17T09:04:56+08:00
draft: false
description: "从像素中心坐标、letterbox 逆仿射、stride 栅格分辨率到 INT8 回归误差上界，系统拆解边缘端 YOLO 为什么常不是没检出，而是框在小目标上持续漂移。"
tags: ["YOLO", "Edge AI", "Letterbox", "量化", "坐标映射", "机器视觉", "边缘计算"]
categories: ["技能档案"]
image: ""
---

## 技能概述

很多边缘端 YOLO 工程并不是“目标没看到”，而是已经看到了，却把框稳定地画错了半个目标宽度。常见症状包括：小目标在屏幕边缘抖动更大、同一个物体在 `stride=8` 和 `stride=16` 检测头之间来回跳、模型输入和原始画面比例不一致时框会持续偏左偏上、量化后框中心在静止场景里也会一格一格地挪。真正的痛点不在 `NMS` 会不会写，而在 **相机像素中心、letterbox 仿射、检测头栅格、INT8 回归步距** 这几层坐标合同是否被完整打通。这个主题要解决的核心问题，就是把“框为什么漂”还原成一份可计算、可补偿、可门控的误差预算，而不是继续靠经验去调 `conf threshold`。

## 核心底层概念解析

- **`letterbox` 不是缩放图片，而是在两个坐标系之间建立一份仿射合同**：若原图尺寸为 `(W_f, H_f)`，网络输入为 `(W_in, H_in)`，则缩放系数为  
  `s = min(W_in / W_f, H_in / H_f)`，  
  填充为  
  `pad_x = (W_in - s * W_f) / 2`，  
  `pad_y = (H_in - s * H_f) / 2`。  
  这意味着原图点并不是“被拉进模型里”，而是先乘以 `s`，再平移到带黑边的网络平面。
- **真正该映射的是像素中心，不是像素左上角**：若预处理库采用 half-pixel center 约定，则更准确的关系应写成  
  `u_in = s * (u_f + 0.5) + pad_x - 0.5`，  
  `v_in = s * (v_f + 0.5) + pad_y - 0.5`。  
  逆映射则为  
  `u_f = (u_in + 0.5 - pad_x) / s - 0.5`，  
  `v_f = (v_in + 0.5 - pad_y) / s - 0.5`。  
  很多部署代码直接用边界坐标做反算，系统性偏差正是从这 `0.5 px` 开始累积。
- **`stride` 定义的是检测头能分辨的空间栅格，而不是一个实现细节**：对某个头，中心点通常按  
  `c_x = (i + sigma(t_x)) * stride`，  
  `c_y = (j + sigma(t_y)) * stride`  
  解码。`i/j` 是网格索引，`sigma(t)` 只是把中心限制在单元格附近。对小目标来说，这意味着它的中心测量首先被投影到了一个有限栅格上。
- **小目标最先受伤的不是分类置信度，而是几何分辨率**：若目标在网络输入中的宽高接近 `stride`，那么一个网格单元就已经吃掉了目标大半个投影。此时哪怕分类分支很自信，回归分支也只是在用很少的几何自由度解释一个很小的物体。
- **INT8 回归误差会通过 `sigmoid` 的斜率直接映射成中心漂移**：若 `t_x` 的量化步距为 `scale_tx`，半个量化台阶对应 `Delta t_x = scale_tx / 2`，则中心误差近似满足  
  `Delta c_x ~= stride * sigma'(t_x) * Delta t_x`。  
  因为 `sigma'(t) <= 1/4`，最坏情况下有  
  `|Delta c_x| <= stride * scale_tx / 8`。  
  再映回原图后，误差还会被 `1 / s` 放大。
- **宽高分支的量化误差不是常数，而会随目标尺度指数放大**：YOLO 常用  
  `w = a_w * exp(t_w)`，  
  `h = a_h * exp(t_h)`。  
  因此有  
  `partial w / partial t_w = w`，  
  `partial h / partial t_h = h`。  
  这意味着同一个 `INT8` 步距，在大框上会转化成更大的绝对宽高误差；在小框上虽然绝对误差更小，但相对误差反而可能更大。
- **`pad_x/pad_y` 若被提前取整，会引入稳定但隐蔽的偏移项**：`letterbox` 黑边常是浮点值，例如 `pad_x = 6.5`。若预处理保留了 `6.5`，后处理却拿 `6` 或 `7` 反推，系统就会在整个画面上引入近似常值偏差，而且这个偏差会随 `1 / s` 再次放大。
- **在输入平面做 `clip` 和在原图平面做 `clip` 不是一回事**：IoU 对统一缩放和平移是近似不变的，但前提是框没有先被裁切。若你在带黑边的输入平面先裁掉了框，再反算回原图，边缘目标的形状和中心都会被二次扭曲。
- **多检测头切换时的“跳框”，常常是栅格分辨率和量化误差在重新分配责任**：`stride=8` 头通常给出更细的中心分辨率，`stride=16` 头通常有更稳定的语义上下文。小目标若同时被两层看到，真正该比较的不是哪个 `score` 更高，而是谁的 **中心误差上界 / 目标最短边** 更小。
- **误差预算应该进入框的可信度，而不是只进入调试日志**：如果某个框的  
  `epsilon_center / min(w, h)`  
  已经超过 `20%`，那它即便分类正确，也不适合直接驱动抓取、瞄准或裁切。稳健系统应该把这种框标记为 `degraded`，而不是假装自己拿到的是一条高精度几何测量。
- **时域稳定性不是后处理的附属品，而是几何误差的最后一道缓冲**：当静止物体的中心抖动幅度已经接近量化上界时，说明系统处在“几何信息不足”的边缘。此时继续靠更高的 `score` 硬选，只会放大框抖动；更合理的做法是降权、跨帧融合，或优先使用更低 `stride` 的头。
- **从工程哲学看，YOLO 的框不是模型直接“看见”的物体边界，而是若干近似映射叠加后的最优解释**：传感器、缩放器、填充器、量化器、检测头和后处理各自都在改写坐标语义。只有把每一层误差都显式记账，框的漂移才会从“玄学”变成“边界条件”。 

## 代码能力展现

下面给出一个面向 **STM32 HAL 工程中的边缘端后处理模块** 的 C 代码示例。场景假设卷积主干已经由 NPU、DSP 或外部加速器完成，MCU 负责把某个检测头的单元输出解码为原图坐标，并基于 **letterbox 逆映射**、**half-pixel center** 和 **INT8 误差上界** 决定这个框是否值得信。代码重点不是再写一遍 `sigmoid + exp + NMS`，而是把“框为什么会漂”明确映射成几条可以进入守卫逻辑的数学量。

```c
#include "main.h"

#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#define YOLO_GEOM_MAX_CLASSES                 8U
#define YOLO_GEOM_MAX_HEAD_CANDIDATES         3U
#define YOLO_GEOM_SIGMOID_LIMIT             8.0f
#define YOLO_GEOM_EXP_LIMIT                 6.0f
#define YOLO_GEOM_MIN_BOX_SIDE_PX           2.0f

typedef struct
{
    float scale;
    int32_t zero_point;
} YoloQuantParam_t;

typedef struct
{
    uint16_t frame_w;
    uint16_t frame_h;
    uint16_t net_w;
    uint16_t net_h;
    bool use_half_pixel_centers;
} YoloImageGeometry_t;

typedef struct
{
    float resize_scale;
    float pad_x;
    float pad_y;
    bool use_half_pixel_centers;
} YoloLetterboxMap_t;

typedef struct
{
    uint16_t stride_px;
    float anchor_w_px;
    float anchor_h_px;

    YoloQuantParam_t q_tx;
    YoloQuantParam_t q_ty;
    YoloQuantParam_t q_tw;
    YoloQuantParam_t q_th;
    YoloQuantParam_t q_obj;
    YoloQuantParam_t q_cls;

    float score_threshold;
    float class_threshold;
    float min_box_w_px;
    float min_box_h_px;
    float max_relative_center_error;
    float max_relative_size_error;
} YoloHeadConfig_t;

typedef struct
{
    YoloImageGeometry_t image;
    YoloHeadConfig_t head;
    uint8_t class_count;
} YoloDecodeConfig_t;

typedef struct
{
    float x1;
    float y1;
    float x2;
    float y2;
    float score;
    uint8_t class_id;

    float center_error_bound_px;
    float width_error_bound_px;
    float height_error_bound_px;

    bool degraded;
    bool valid;
} YoloDecodedBox_t;

static float YoloGeom_ClampFloat(float value, float min_value, float max_value)
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

static float YoloGeom_MinFloat(float a, float b)
{
    return (a < b) ? a : b;
}

static float YoloGeom_MaxFloat(float a, float b)
{
    return (a > b) ? a : b;
}

static float YoloGeom_DequantizeI8(int8_t q, YoloQuantParam_t qp)
{
    return qp.scale * ((float)q - (float)qp.zero_point);
}

static float YoloGeom_Sigmoid(float x)
{
    const float limited = YoloGeom_ClampFloat(x, -YOLO_GEOM_SIGMOID_LIMIT, YOLO_GEOM_SIGMOID_LIMIT);
    return 1.0f / (1.0f + expf(-limited));
}

/**
 * @brief 建立原图到网络输入平面的 letterbox 几何映射。
 * @param image 图像几何配置。
 * @param out_map 输出 letterbox 仿射参数。
 * @retval true  映射构建成功。
 * @retval false 参数非法。
 *
 * @note 若原图尺寸为 `(W_f, H_f)`，网络输入为 `(W_in, H_in)`，则：
 *       `s = min(W_in / W_f, H_in / H_f)`
 *       `pad_x = (W_in - s * W_f) / 2`
 *       `pad_y = (H_in - s * H_f) / 2`
 *
 *       注意这里显式保留 `pad_x / pad_y` 的浮点值，不做提前取整，
 *       因为 `0.5 px` 的黑边误差回映到原图后会被 `1 / s` 放大。
 */
static bool YoloGeom_BuildLetterboxMap(const YoloImageGeometry_t *image,
                                       YoloLetterboxMap_t *out_map)
{
    float sx;
    float sy;
    float scale;

    if ((image == NULL) || (out_map == NULL) ||
        (image->frame_w == 0U) || (image->frame_h == 0U) ||
        (image->net_w == 0U) || (image->net_h == 0U))
    {
        return false;
    }

    sx = (float)image->net_w / (float)image->frame_w;
    sy = (float)image->net_h / (float)image->frame_h;
    scale = YoloGeom_MinFloat(sx, sy);

    out_map->resize_scale = scale;
    out_map->pad_x = 0.5f * ((float)image->net_w - ((float)image->frame_w * scale));
    out_map->pad_y = 0.5f * ((float)image->net_h - ((float)image->frame_h * scale));
    out_map->use_half_pixel_centers = image->use_half_pixel_centers;
    return true;
}

/**
 * @brief 将网络输入平面的点逆映射回原图平面。
 * @param map letterbox 仿射参数。
 * @param input_x 输入平面的 x 坐标。
 * @param input_y 输入平面的 y 坐标。
 * @param frame_x 输出原图 x 坐标。
 * @param frame_y 输出原图 y 坐标。
 *
 * @note 若预处理采用 half-pixel center 约定，则：
 *       `u_f = (u_in + 0.5 - pad_x) / s - 0.5`
 *       `v_f = (v_in + 0.5 - pad_y) / s - 0.5`
 *
 *       若忽略这组 `0.5`，系统会在整幅图上引入近似常值偏差，
 *       对小目标框尤其明显。
 */
static void YoloGeom_InputPointToFrame(const YoloLetterboxMap_t *map,
                                       float input_x,
                                       float input_y,
                                       float *frame_x,
                                       float *frame_y)
{
    const float scale = YoloGeom_MaxFloat(map->resize_scale, 1.0e-6f);

    if (map->use_half_pixel_centers)
    {
        *frame_x = ((input_x + 0.5f) - map->pad_x) / scale - 0.5f;
        *frame_y = ((input_y + 0.5f) - map->pad_y) / scale - 0.5f;
    }
    else
    {
        *frame_x = (input_x - map->pad_x) / scale;
        *frame_y = (input_y - map->pad_y) / scale;
    }
}

/**
 * @brief 计算中心回归在原图平面的量化误差上界。
 * @param stride_px 检测头 stride。
 * @param t_real 已反量化的回归 logit。
 * @param qp 对应 INT8 量化参数。
 * @param map letterbox 几何映射。
 * @return 中心点在原图平面的绝对误差上界，单位 px。
 *
 * @note 中心解码为：
 *       `c_x = (i + sigma(t_x)) * stride`
 *
 *       量化半步长为：
 *       `Delta t_x = scale_tx / 2`
 *
 *       一阶近似有：
 *       `Delta c_x ~= stride * sigma'(t_x) * Delta t_x`
 *       其中 `sigma'(t) = sigma(t) * (1 - sigma(t))`
 *
 *       最后再除以 `s`，映射回原图平面。
 */
static float YoloGeom_ComputeCenterErrorBoundFramePx(uint16_t stride_px,
                                                     float t_real,
                                                     YoloQuantParam_t qp,
                                                     const YoloLetterboxMap_t *map)
{
    const float p = YoloGeom_Sigmoid(t_real);
    const float sigma_prime = p * (1.0f - p);
    const float delta_t = fabsf(qp.scale) * 0.5f;
    const float delta_center_input = (float)stride_px * sigma_prime * delta_t;

    return delta_center_input / YoloGeom_MaxFloat(map->resize_scale, 1.0e-6f);
}

/**
 * @brief 计算宽高回归在原图平面的量化误差上界。
 * @param size_input_px 已解码的输入平面宽或高。
 * @param qp 对应 INT8 量化参数。
 * @param map letterbox 几何映射。
 * @return 宽或高在原图平面的绝对误差上界，单位 px。
 *
 * @note YOLO 常用：
 *       `w = a_w * exp(t_w)`
 *       因而：
 *       `partial w / partial t_w = w`
 *
 *       若量化半步长为 `Delta t_w = scale_tw / 2`，则有：
 *       `Delta w ~= w * Delta t_w`
 *       再除以 `s` 映回原图。
 */
static float YoloGeom_ComputeSizeErrorBoundFramePx(float size_input_px,
                                                   YoloQuantParam_t qp,
                                                   const YoloLetterboxMap_t *map)
{
    const float delta_t = fabsf(qp.scale) * 0.5f;
    const float delta_size_input = size_input_px * delta_t;
    return delta_size_input / YoloGeom_MaxFloat(map->resize_scale, 1.0e-6f);
}

/**
 * @brief 解码单个网格单元的 YOLO 候选框，并给出几何误差预算。
 * @param cfg 解码配置，含图像几何、检测头量化参数与门限。
 * @param cell_x 网格列索引。
 * @param cell_y 网格行索引。
 * @param tensor_cell 单元张量，布局为 `[tx, ty, tw, th, obj, cls0, cls1, ...]`。
 * @param out_box 输出框及其误差上界。
 * @retval true  解码成功，`out_box->valid` 说明结果是否可用。
 * @retval false 参数非法或映射构建失败。
 *
 * @note 解码公式为：
 *       `cx_in = (cell_x + sigma(tx)) * stride`
 *       `cy_in = (cell_y + sigma(ty)) * stride`
 *       `w_in  = anchor_w * exp(tw)`
 *       `h_in  = anchor_h * exp(th)`
 *
 *       之后通过 `letterbox` 逆映射回原图，再根据：
 *       `epsilon_center / min(w, h)`
 *       `epsilon_size / w(h)`
 *       决定是否将该框标记为 `degraded`。
 */
static bool YoloGeom_DecodeSingleCandidate(const YoloDecodeConfig_t *cfg,
                                           uint16_t cell_x,
                                           uint16_t cell_y,
                                           const int8_t *tensor_cell,
                                           YoloDecodedBox_t *out_box)
{
    YoloLetterboxMap_t map;
    float best_cls_prob = 0.0f;
    uint8_t best_cls_id = 0U;
    float tx;
    float ty;
    float tw;
    float th;
    float obj_prob;
    float score;
    float cx_input;
    float cy_input;
    float w_input;
    float h_input;
    float x1;
    float y1;
    float x2;
    float y2;
    float box_w_frame;
    float box_h_frame;
    float relative_center_error;
    float relative_size_error;

    if ((cfg == NULL) || (tensor_cell == NULL) || (out_box == NULL) ||
        (cfg->class_count == 0U) || (cfg->class_count > YOLO_GEOM_MAX_CLASSES))
    {
        return false;
    }

    memset(out_box, 0, sizeof(*out_box));

    if (!YoloGeom_BuildLetterboxMap(&cfg->image, &map))
    {
        return false;
    }

    obj_prob = YoloGeom_Sigmoid(YoloGeom_DequantizeI8(tensor_cell[4], cfg->head.q_obj));

    for (uint8_t cls = 0U; cls < cfg->class_count; ++cls)
    {
        const float cls_prob =
            YoloGeom_Sigmoid(YoloGeom_DequantizeI8(tensor_cell[5U + cls], cfg->head.q_cls));

        if (cls_prob > best_cls_prob)
        {
            best_cls_prob = cls_prob;
            best_cls_id = cls;
        }
    }

    score = obj_prob * best_cls_prob;
    if ((best_cls_prob < cfg->head.class_threshold) || (score < cfg->head.score_threshold))
    {
        out_box->valid = false;
        return true;
    }

    tx = YoloGeom_DequantizeI8(tensor_cell[0], cfg->head.q_tx);
    ty = YoloGeom_DequantizeI8(tensor_cell[1], cfg->head.q_ty);
    tw = YoloGeom_DequantizeI8(tensor_cell[2], cfg->head.q_tw);
    th = YoloGeom_DequantizeI8(tensor_cell[3], cfg->head.q_th);

    cx_input = ((float)cell_x + YoloGeom_Sigmoid(tx)) * (float)cfg->head.stride_px;
    cy_input = ((float)cell_y + YoloGeom_Sigmoid(ty)) * (float)cfg->head.stride_px;
    w_input = cfg->head.anchor_w_px * expf(YoloGeom_ClampFloat(tw, -YOLO_GEOM_EXP_LIMIT, YOLO_GEOM_EXP_LIMIT));
    h_input = cfg->head.anchor_h_px * expf(YoloGeom_ClampFloat(th, -YOLO_GEOM_EXP_LIMIT, YOLO_GEOM_EXP_LIMIT));

    YoloGeom_InputPointToFrame(&map, cx_input - (0.5f * w_input), cy_input - (0.5f * h_input), &x1, &y1);
    YoloGeom_InputPointToFrame(&map, cx_input + (0.5f * w_input), cy_input + (0.5f * h_input), &x2, &y2);

    out_box->x1 = YoloGeom_ClampFloat(x1, 0.0f, (float)cfg->image.frame_w - 1.0f);
    out_box->y1 = YoloGeom_ClampFloat(y1, 0.0f, (float)cfg->image.frame_h - 1.0f);
    out_box->x2 = YoloGeom_ClampFloat(x2, 0.0f, (float)cfg->image.frame_w - 1.0f);
    out_box->y2 = YoloGeom_ClampFloat(y2, 0.0f, (float)cfg->image.frame_h - 1.0f);
    out_box->score = score;
    out_box->class_id = best_cls_id;

    box_w_frame = out_box->x2 - out_box->x1;
    box_h_frame = out_box->y2 - out_box->y1;
    if ((box_w_frame < YoloGeom_MaxFloat(cfg->head.min_box_w_px, YOLO_GEOM_MIN_BOX_SIDE_PX)) ||
        (box_h_frame < YoloGeom_MaxFloat(cfg->head.min_box_h_px, YOLO_GEOM_MIN_BOX_SIDE_PX)))
    {
        out_box->valid = false;
        return true;
    }

    out_box->center_error_bound_px =
        YoloGeom_MaxFloat(YoloGeom_ComputeCenterErrorBoundFramePx(cfg->head.stride_px, tx, cfg->head.q_tx, &map),
                          YoloGeom_ComputeCenterErrorBoundFramePx(cfg->head.stride_px, ty, cfg->head.q_ty, &map));
    out_box->width_error_bound_px = YoloGeom_ComputeSizeErrorBoundFramePx(w_input, cfg->head.q_tw, &map);
    out_box->height_error_bound_px = YoloGeom_ComputeSizeErrorBoundFramePx(h_input, cfg->head.q_th, &map);

    relative_center_error =
        out_box->center_error_bound_px / YoloGeom_MaxFloat(YoloGeom_MinFloat(box_w_frame, box_h_frame), 1.0f);
    relative_size_error =
        YoloGeom_MaxFloat(out_box->width_error_bound_px / YoloGeom_MaxFloat(box_w_frame, 1.0f),
                          out_box->height_error_bound_px / YoloGeom_MaxFloat(box_h_frame, 1.0f));

    /*
     * 当中心误差或尺寸误差已经占到框尺寸的显著比例时，
     * 该框并非“错了”，而是“几何信息不足，继续使用需要降权”。
     */
    out_box->degraded = (relative_center_error > cfg->head.max_relative_center_error) ||
                        (relative_size_error > cfg->head.max_relative_size_error);
    out_box->valid = true;
    return true;
}

static float YoloGeom_ComputeStabilityScore(const YoloDecodedBox_t *box)
{
    const float min_side = YoloGeom_MaxFloat(YoloGeom_MinFloat(box->x2 - box->x1, box->y2 - box->y1), 1.0f);
    const float size_error_ratio =
        YoloGeom_MaxFloat(box->width_error_bound_px / YoloGeom_MaxFloat(box->x2 - box->x1, 1.0f),
                          box->height_error_bound_px / YoloGeom_MaxFloat(box->y2 - box->y1, 1.0f));
    const float penalty =
        1.0f +
        (2.5f * (box->center_error_bound_px / min_side)) +
        (1.5f * size_error_ratio) +
        (box->degraded ? 0.8f : 0.0f);

    return box->score / penalty;
}

/**
 * @brief 在多个检测头候选框中选择几何稳定性更好的一个。
 * @param candidates 候选框数组，通常来自 `stride=8/16/32` 等不同头。
 * @param count 候选框个数。
 * @param out_best 输出最稳定的候选框。
 * @retval true  选取成功。
 * @retval false 没有可用框。
 *
 * @note 选择依据不是只看 `score`，而是看：
 *       `stability = score / (1 + center_error_ratio + size_error_ratio + degraded_penalty)`
 *
 *       这样在小目标场景里，较低 `stride` 头即便 `score` 略低，
 *       只要几何误差上界明显更小，仍可能被优先选中。
 */
static bool YoloGeom_SelectMostStableCandidate(const YoloDecodedBox_t *candidates,
                                               uint8_t count,
                                               YoloDecodedBox_t *out_best)
{
    float best_score = -1.0f;
    bool found = false;

    if ((candidates == NULL) || (out_best == NULL) || (count == 0U))
    {
        return false;
    }

    for (uint8_t i = 0U; i < count; ++i)
    {
        if (!candidates[i].valid)
        {
            continue;
        }

        if (YoloGeom_ComputeStabilityScore(&candidates[i]) > best_score)
        {
            best_score = YoloGeom_ComputeStabilityScore(&candidates[i]);
            *out_best = candidates[i];
            found = true;
        }
    }

    return found;
}

void App_YoloSmallObjectGeometryExample(void)
{
    YoloDecodedBox_t candidates[YOLO_GEOM_MAX_HEAD_CANDIDATES] = {0};
    YoloDecodedBox_t best_box = {0};

    static const YoloDecodeConfig_t k_p3_cfg =
    {
        .image =
        {
            .frame_w = 640U,
            .frame_h = 480U,
            .net_w = 320U,
            .net_h = 320U,
            .use_half_pixel_centers = true
        },
        .head =
        {
            .stride_px = 8U,
            .anchor_w_px = 18.0f,
            .anchor_h_px = 24.0f,
            .q_tx = {.scale = 0.0625f, .zero_point = 0},
            .q_ty = {.scale = 0.0625f, .zero_point = 0},
            .q_tw = {.scale = 0.0625f, .zero_point = 0},
            .q_th = {.scale = 0.0625f, .zero_point = 0},
            .q_obj = {.scale = 0.1250f, .zero_point = 0},
            .q_cls = {.scale = 0.1250f, .zero_point = 0},
            .score_threshold = 0.35f,
            .class_threshold = 0.30f,
            .min_box_w_px = 6.0f,
            .min_box_h_px = 6.0f,
            .max_relative_center_error = 0.18f,
            .max_relative_size_error = 0.25f
        },
        .class_count = 2U
    };

    static const YoloDecodeConfig_t k_p4_cfg =
    {
        .image =
        {
            .frame_w = 640U,
            .frame_h = 480U,
            .net_w = 320U,
            .net_h = 320U,
            .use_half_pixel_centers = true
        },
        .head =
        {
            .stride_px = 16U,
            .anchor_w_px = 42.0f,
            .anchor_h_px = 58.0f,
            .q_tx = {.scale = 0.0625f, .zero_point = 0},
            .q_ty = {.scale = 0.0625f, .zero_point = 0},
            .q_tw = {.scale = 0.0625f, .zero_point = 0},
            .q_th = {.scale = 0.0625f, .zero_point = 0},
            .q_obj = {.scale = 0.1250f, .zero_point = 0},
            .q_cls = {.scale = 0.1250f, .zero_point = 0},
            .score_threshold = 0.35f,
            .class_threshold = 0.30f,
            .min_box_w_px = 6.0f,
            .min_box_h_px = 6.0f,
            .max_relative_center_error = 0.18f,
            .max_relative_size_error = 0.25f
        },
        .class_count = 2U
    };

    /*
     * 这里的张量示例布局为：
     * [tx, ty, tw, th, obj, cls0, cls1]
     * 假设它们来自不同检测头中“响应最强”的单元。
     */
    static const int8_t k_p3_tensor_cell[7] = { 7, -3, 4, 6, 13, 2, 12 };
    static const int8_t k_p4_tensor_cell[7] = { 1, -1, -4, -2, 15, 1, 13 };

    (void)YoloGeom_DecodeSingleCandidate(&k_p3_cfg, 21U, 17U, k_p3_tensor_cell, &candidates[0]);
    (void)YoloGeom_DecodeSingleCandidate(&k_p4_cfg, 10U, 8U, k_p4_tensor_cell, &candidates[1]);

    if (!YoloGeom_SelectMostStableCandidate(candidates, 2U, &best_box))
    {
        return;
    }

    /*
     * 上层可依据 best_box.degraded 决定后续策略：
     * 1. degraded = false：框可直接进入裁剪、瞄准或跟踪环。
     * 2. degraded = true：优先跨帧融合，或等待更低 stride 头再次确认。
     * 3. center_error_bound_px 很大：说明当前框更多是“分类命中”，
     *    而不是“高精度几何量测”。
     */
    (void)best_box;
}
```

这段实现有几个工程要点值得单独强调：

- `YoloGeom_BuildLetterboxMap()` 保留了浮点 `pad_x/pad_y`，避免把黑边误差提前固化成系统性偏移。
- `YoloGeom_InputPointToFrame()` 显式支持 half-pixel center 逆映射，修掉了许多部署链路里最常见、也最难被肉眼立刻发现的半像素级偏差。
- `YoloGeom_ComputeCenterErrorBoundFramePx()` 和 `YoloGeom_ComputeSizeErrorBoundFramePx()` 不是调试花活，而是把回归量化误差真正翻译成了原图平面的几何上界。
- `YoloGeom_DecodeSingleCandidate()` 不是只给一个框，而是同时给出“这个框在当前头、当前量化步距、当前缩放关系下到底还有多可信”。
- `YoloGeom_SelectMostStableCandidate()` 让多检测头之间的选择从“谁分数高谁赢”变成“谁在当前尺度上的几何解释更稳定谁赢”。

如果现场仍然看到小目标框持续漂移，排查顺序应当非常明确：

- 先核对预处理和后处理是否使用了同一套 `letterbox` 与 half-pixel 约定。
- 再核对 `pad_x/pad_y` 是否被一端保留为浮点、另一端偷偷取整。
- 再看 `center_error_bound_px / min(w, h)` 是否已经接近或超过你的业务容忍度。
- 最后才去怀疑 `NMS`、类别阈值或“模型是不是不够大”。

真正成熟的边缘端 YOLO 部署，不会把框漂移理解成“偶发小 bug”，而会把它当成 **像素坐标、网络坐标、栅格坐标与量化坐标之间的一次合同违约**。把这份合同逐项补齐，框的位置才会从“差不多对”走向“在物理上值得信”。 
