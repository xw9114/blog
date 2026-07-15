---
title: "技能档案：颜色识别里的色温漂移、3x3 颜色校正矩阵与 Lab ΔE 门控"
slug: "skill-color-recognition-color-temperature-ccm-and-lab-deltae-gating"
date: 2026-06-13T10:43:52+08:00
draft: false
description: "从传感器线性 RGB、白点增益、3x3 颜色校正矩阵到 CIE Lab ΔE 判别，系统拆解颜色识别为什么常死在光源迁移和颜色空间假设失配，而不是 HSV API。"
tags: ["OpenCV", "颜色识别", "颜色校正", "Lab", "DeltaE", "机器视觉", "边缘计算"]
categories: ["技能档案", "机器视觉"]
image: ""
---

## 技能概述

颜色识别常见于产线分拣、电子元件极性识别、药片与胶囊检测、农产品分级、交通灯感知和实验室比色分析。很多项目上线前在工位灯下阈值调得很好，换一盏灯、换一台相机、换一次曝光策略后就开始误判。真正的痛点不在 `cv::inRange()` 会不会写，而在 **相机输出的 RGB 到底是不是可比较的物理量**，以及系统有没有把 **光源色温**、**传感器谱响应差异**、**ISP 非线性压缩** 和 **感知空间里的颜色距离** 串成一条可校准、可复现的映射链路。这个主题要解决的核心问题，不是再写一遍 HSV 阈值，而是把颜色识别从“像素筛选”提升到“光谱到判别距离的系统建模”。

## 核心底层概念解析

- **颜色识别首先是一条光谱积分链，不是一组现成的 BGR 数字**：物体颜色并不是物体“自带的标签”，而是光源光谱 `E(lambda)`、物体反射率 `R(lambda)`、镜头透过率和传感器三通道谱响应 `S_r/g/b(lambda)` 共同积分后的结果。摄像头看到的每个通道，本质上都近似满足  
  `C_k ~= integral(E(lambda) * R(lambda) * S_k(lambda) d lambda)`。  
  只要光源换了，哪怕物体没动，三个通道的相对比例也会改写。
- **ISP 输出通常不是线性域，直接做欧氏距离会把物理亮度关系打碎**：大多数工业相机、USB 摄像头甚至手机模组，都会在输出前做伽马压缩或类似的 tone mapping。若你在非线性 sRGB 域里直接求均值、阈值或颜色距离，等于把“乘性照明变化”误当成“加性数值变化”。颜色校正必须先回到近似线性 RGB。
- **自动曝光和自动白平衡并不是颜色识别的朋友，它们只是让画面看起来更像人眼习惯**：AE 会改写亮度分布，AWB 会改变三个通道的相对增益。对拍照来说这叫“观感更自然”，对测量来说这意味着参考坐标系在漂。若系统没有参考白块、灰卡或稳定照明，阈值实际上每天都在重定义。
- **白平衡的本质是对光源色温做一次低维增益补偿，而不是颜色世界的完整真相**：最常见的通道补偿可写成  
  `rgb_balanced = diag(g_r, g_g, g_b) * rgb_linear`。  
  它假设光源变化主要表现为三通道尺度变化，因此可以用一个对角增益矩阵拉回白点。这个模型不完美，但在窄带 LED 变化不剧烈、目标表面近似朗伯反射时，往往已经足以把很多漂移先压下去。
- **3x3 颜色校正矩阵 CCM 的角色，是把“相机自己的 RGB 坐标系”映射到“更接近标准颜色学的坐标系”**：若色卡第 `i` 个样本的测量值为 `c_cam_i`，标准值为 `c_ref_i`，则可通过最小二乘求  
  `c_ref_i ~= M * c_cam_i`，  
  `M = arg min sum ||c_ref_i - M * c_cam_i||^2`。  
  这不是魔法，而是在承认传感器三通道并不等价于标准观察者三刺激值后，用一个线性近似把两套坐标系对齐。
- **CCM 只有在线性域、未饱和、未欠曝时才有物理意义**：一旦某个通道被裁切到 `255`，或者暗部沉到噪声底，信息已经不可逆丢失。此时再套 3x3 矩阵，本质上是在对缺失维度做猜测，而不是恢复。
- **HSV 适合做快速分桶，但不适合做跨光照、跨设备的颜色判决主坐标系**：HSV 的 `H` 依赖 RGB 比例，低饱和和低亮度区会变得极不稳定；`V` 又直接受照明强度影响。它更像 ISP 时代的一种工程捷径，而不是颜色学意义上的“距离空间”。
- **Lab 的价值在于把“颜色差异”更接近映射为“可比较的判别距离”**：经过 `RGB -> XYZ -> Lab` 之后，颜色差可以先近似写成  
  `DeltaE76 = sqrt((DeltaL)^2 + (Deltaa)^2 + (Deltab)^2)`。  
  它不完美，但比在 BGR 或 HSV 上直接量半径更接近“肉眼认为差了多少”这个量。
- **`RGB -> XYZ -> Lab` 不是形式主义，而是在把设备相关颜色变成观察条件相关颜色**：`XYZ` 是颜色学里的中间世界坐标，`Lab` 则相当于在白点 `(Xn, Yn, Zn)` 附近重新拉直局部感知空间。只有先选定白点，`Lab` 中的距离才有统一语义。
- **颜色门控不能只看均值，还要看场景是否满足测量前提**：镜面高光、局部阴影、镜头暗角、传感器黑电平漂移、滚动快门下的 LED 频闪，都会让同一块 ROI 内部出现时空不一致。稳健系统通常会先拒绝“过曝、过暗、亮度起伏过大”的 ROI，再去算颜色标签。
- **参考白块往往比更复杂的分类器更值钱**：在固定工位里，只要画面里长期存在一块稳定白参考，系统就能在每帧重新估计白点增益，把色温变化的一阶误差先吃掉。很多颜色识别做不稳，不是模型太弱，而是现场不愿给一个稳定参考坐标。
- **从工程哲学看，颜色识别不是识别“这个像素像不像红色”，而是在维护一份“这个系统此刻还能不能继续信颜色”的合同**：当白点漂了、亮度裁切了、参考块丢了、频闪污染了，系统应该优先报告“当前颜色量测不可信”，而不是执着于给出一个看似确定的颜色名。

## 代码能力展现

下面给出一个基于 OpenCV C++ 的颜色校正与识别模块。它不依赖“拍脑袋调 HSV”，而是把 **sRGB 反伽马**、**白点增益补偿**、**3x3 CCM 最小二乘求解**、**`RGB -> XYZ -> Lab` 映射** 和 **ΔE 门控** 串成一条完整链路。示例假设:

- 标定阶段，画面里有一块白参考 ROI，以及若干色卡块 ROI。
- 运行阶段，系统持续看到同一块白参考，以吸收色温和轻微曝光漂移。
- 颜色判别只在 ROI 未过曝、未欠曝时放行，避免把已经丢信息的图像继续送进颜色空间。

```cpp
#include <opencv2/core.hpp>
#include <opencv2/imgproc.hpp>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <limits>
#include <string>
#include <vector>

struct ColorPatchSample_t
{
    cv::Rect roi;                  /* 色卡块 ROI。 */
    cv::Vec3f target_linear_rgb;   /* 标准线性 RGB，范围 [0, 1]。 */
};

struct ColorCalibration_t
{
    cv::Matx33f ccm;               /* 3x3 颜色校正矩阵，满足 rgb_ref ~= ccm * rgb_balanced。 */
    cv::Vec3f wb_gain;             /* 白平衡增益。 */
    cv::Vec3f white_xyz;           /* Lab 白点，D65 下常取 (0.95047, 1.0, 1.08883)。 */
    float saturation_code_limit;   /* 若 ROI 最大通道码值超过该阈值，则认为接近饱和。 */
    float darkness_code_limit;     /* 若 ROI 平均码值低于该阈值，则认为过暗。 */
    bool valid;
};

struct ColorTarget_t
{
    std::string name;
    cv::Vec3f target_lab;
    float max_delta_e76;
    float min_chroma;
};

struct ColorDecision_t
{
    std::string name;
    cv::Vec3f measured_lab;
    float measured_chroma;
    float best_delta_e76;
    bool saturated;
    bool too_dark;
    bool valid;
};

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

static cv::Rect ClampRoi(const cv::Rect &roi, const cv::Size &image_size)
{
    const int x = std::max(0, roi.x);
    const int y = std::max(0, roi.y);
    const int w = std::max(0, std::min(roi.width, image_size.width - x));
    const int h = std::max(0, std::min(roi.height, image_size.height - y));

    return cv::Rect(x, y, w, h);
}

static float SrgbToLinearUnit(float srgb_unit)
{
    const float x = ClampF(srgb_unit, 0.0f, 1.0f);

    /*
     * sRGB 反伽马:
     * 若 x <= 0.04045, linear = x / 12.92
     * 否则 linear = ((x + 0.055) / 1.055) ^ 2.4
     *
     * 这里把 ISP 输出近似拉回线性域，恢复“光能叠加”语义。
     */
    if (x <= 0.04045f)
    {
        return x / 12.92f;
    }

    return std::pow((x + 0.055f) / 1.055f, 2.4f);
}

static cv::Vec3f Bgr8ToLinearRgb(const cv::Vec3b &bgr)
{
    /*
     * OpenCV 默认通道顺序为 BGR，这里显式转成 RGB 列向量。
     */
    const float b = SrgbToLinearUnit(static_cast<float>(bgr[0]) / 255.0f);
    const float g = SrgbToLinearUnit(static_cast<float>(bgr[1]) / 255.0f);
    const float r = SrgbToLinearUnit(static_cast<float>(bgr[2]) / 255.0f);

    return cv::Vec3f(r, g, b);
}

static cv::Vec3f MeanLinearRgbRoi(const cv::Mat &frame_bgr,
                                  const cv::Rect &roi,
                                  float *max_code_value,
                                  float *mean_code_value)
{
    cv::Vec3d linear_sum(0.0, 0.0, 0.0);
    double code_sum = 0.0;
    float local_max_code = 0.0f;
    uint32_t pixel_count = 0U;
    const cv::Rect safe_roi = ClampRoi(roi, frame_bgr.size());

    if ((frame_bgr.empty()) || (frame_bgr.type() != CV_8UC3) || (safe_roi.width <= 0) || (safe_roi.height <= 0))
    {
        if (max_code_value != nullptr)
        {
            *max_code_value = 255.0f;
        }

        if (mean_code_value != nullptr)
        {
            *mean_code_value = 0.0f;
        }

        return cv::Vec3f(0.0f, 0.0f, 0.0f);
    }

    for (int y = safe_roi.y; y < (safe_roi.y + safe_roi.height); ++y)
    {
        const cv::Vec3b *row_ptr = frame_bgr.ptr<cv::Vec3b>(y);

        for (int x = safe_roi.x; x < (safe_roi.x + safe_roi.width); ++x)
        {
            const cv::Vec3b &bgr = row_ptr[x];
            const cv::Vec3f linear_rgb = Bgr8ToLinearRgb(bgr);

            linear_sum += cv::Vec3d(linear_rgb[0], linear_rgb[1], linear_rgb[2]);
            code_sum += static_cast<double>(bgr[0] + bgr[1] + bgr[2]) / 3.0;
            local_max_code = std::max(local_max_code,
                                      static_cast<float>(std::max(bgr[0], std::max(bgr[1], bgr[2]))));
            ++pixel_count;
        }
    }

    if (max_code_value != nullptr)
    {
        *max_code_value = local_max_code;
    }

    if (mean_code_value != nullptr)
    {
        *mean_code_value = static_cast<float>(code_sum / static_cast<double>(pixel_count));
    }

    if (pixel_count == 0U)
    {
        return cv::Vec3f(0.0f, 0.0f, 0.0f);
    }

    return cv::Vec3f(static_cast<float>(linear_sum[0] / static_cast<double>(pixel_count)),
                     static_cast<float>(linear_sum[1] / static_cast<double>(pixel_count)),
                     static_cast<float>(linear_sum[2] / static_cast<double>(pixel_count)));
}

static cv::Vec3f NormalizeGainVector(const cv::Vec3f &raw_gain)
{
    const float sum_gain = raw_gain[0] + raw_gain[1] + raw_gain[2];
    const float scale = (sum_gain > 1.0e-6f) ? (3.0f / sum_gain) : 1.0f;

    /*
     * 归一化增益，避免白平衡顺手把整幅图整体亮度也一起放大或缩小。
     */
    return cv::Vec3f(raw_gain[0] * scale, raw_gain[1] * scale, raw_gain[2] * scale);
}

static cv::Vec3f ApplyWhiteBalanceGain(const cv::Vec3f &linear_rgb, const cv::Vec3f &wb_gain)
{
    return cv::Vec3f(linear_rgb[0] * wb_gain[0],
                     linear_rgb[1] * wb_gain[1],
                     linear_rgb[2] * wb_gain[2]);
}

static cv::Vec3f ApplyMat3(const cv::Matx33f &matrix, const cv::Vec3f &vector)
{
    return cv::Vec3f(matrix(0, 0) * vector[0] + matrix(0, 1) * vector[1] + matrix(0, 2) * vector[2],
                     matrix(1, 0) * vector[0] + matrix(1, 1) * vector[1] + matrix(1, 2) * vector[2],
                     matrix(2, 0) * vector[0] + matrix(2, 1) * vector[1] + matrix(2, 2) * vector[2]);
}

/**
 * @brief 由色卡样本最小二乘求解 3x3 颜色校正矩阵。
 * @param measured_balanced_rgb 经过白平衡补偿后的相机线性 RGB。
 * @param target_linear_rgb 目标标准线性 RGB。
 * @param ccm 输出颜色校正矩阵。
 * @retval true 求解成功。
 * @retval false 输入非法或矩阵不可解。
 *
 * @note 目标是求解:
 *       c_ref_i ~= M * c_cam_i
 *
 *       令 A 的每一行为 c_cam_i^T，T 的每一行为 c_ref_i^T，则有:
 *       A * X ~= T
 *       X = arg min ||A * X - T||^2
 *
 *       这里先解行向量形式的 X，再取转置得到列向量形式的 M。
 */
static bool SolveColorCorrectionMatrix(const std::vector<cv::Vec3f> &measured_balanced_rgb,
                                       const std::vector<cv::Vec3f> &target_linear_rgb,
                                       cv::Matx33f *ccm)
{
    cv::Mat a_matrix;
    cv::Mat t_matrix;
    cv::Mat x_matrix;

    if ((ccm == nullptr) ||
        (measured_balanced_rgb.size() != target_linear_rgb.size()) ||
        (measured_balanced_rgb.size() < 6U))
    {
        return false;
    }

    a_matrix = cv::Mat::zeros(static_cast<int>(measured_balanced_rgb.size()), 3, CV_32F);
    t_matrix = cv::Mat::zeros(static_cast<int>(target_linear_rgb.size()), 3, CV_32F);

    for (int i = 0; i < a_matrix.rows; ++i)
    {
        a_matrix.at<float>(i, 0) = measured_balanced_rgb[static_cast<size_t>(i)][0];
        a_matrix.at<float>(i, 1) = measured_balanced_rgb[static_cast<size_t>(i)][1];
        a_matrix.at<float>(i, 2) = measured_balanced_rgb[static_cast<size_t>(i)][2];

        t_matrix.at<float>(i, 0) = target_linear_rgb[static_cast<size_t>(i)][0];
        t_matrix.at<float>(i, 1) = target_linear_rgb[static_cast<size_t>(i)][1];
        t_matrix.at<float>(i, 2) = target_linear_rgb[static_cast<size_t>(i)][2];
    }

    if (!cv::solve(a_matrix, t_matrix, x_matrix, cv::DECOMP_SVD))
    {
        return false;
    }

    *ccm = cv::Matx33f(x_matrix.at<float>(0, 0), x_matrix.at<float>(1, 0), x_matrix.at<float>(2, 0),
                       x_matrix.at<float>(0, 1), x_matrix.at<float>(1, 1), x_matrix.at<float>(2, 1),
                       x_matrix.at<float>(0, 2), x_matrix.at<float>(1, 2), x_matrix.at<float>(2, 2));
    return true;
}

static cv::Vec3f LinearRgbToXyzD65(const cv::Vec3f &linear_rgb)
{
    /*
     * 线性 sRGB -> XYZ (D65):
     * [X]   [0.4124564 0.3575761 0.1804375] [R]
     * [Y] = [0.2126729 0.7151522 0.0721750] [G]
     * [Z]   [0.0193339 0.1191920 0.9503041] [B]
     */
    return cv::Vec3f(0.4124564f * linear_rgb[0] + 0.3575761f * linear_rgb[1] + 0.1804375f * linear_rgb[2],
                     0.2126729f * linear_rgb[0] + 0.7151522f * linear_rgb[1] + 0.0721750f * linear_rgb[2],
                     0.0193339f * linear_rgb[0] + 0.1191920f * linear_rgb[1] + 0.9503041f * linear_rgb[2]);
}

static float LabPivot(float value)
{
    const float delta = 6.0f / 29.0f;
    const float delta_cube = delta * delta * delta;

    if (value > delta_cube)
    {
        return std::cbrt(value);
    }

    return (value / (3.0f * delta * delta)) + (4.0f / 29.0f);
}

static cv::Vec3f XyzToLab(const cv::Vec3f &xyz, const cv::Vec3f &white_xyz)
{
    const float fx = LabPivot(xyz[0] / std::max(white_xyz[0], 1.0e-6f));
    const float fy = LabPivot(xyz[1] / std::max(white_xyz[1], 1.0e-6f));
    const float fz = LabPivot(xyz[2] / std::max(white_xyz[2], 1.0e-6f));

    /*
     * CIE Lab:
     * L* = 116 * f(Y / Yn) - 16
     * a* = 500 * (f(X / Xn) - f(Y / Yn))
     * b* = 200 * (f(Y / Yn) - f(Z / Zn))
     */
    return cv::Vec3f((116.0f * fy) - 16.0f,
                     500.0f * (fx - fy),
                     200.0f * (fy - fz));
}

static float DeltaE76(const cv::Vec3f &lab_a, const cv::Vec3f &lab_b)
{
    const float d_l = lab_a[0] - lab_b[0];
    const float d_a = lab_a[1] - lab_b[1];
    const float d_b = lab_a[2] - lab_b[2];

    return std::sqrt((d_l * d_l) + (d_a * d_a) + (d_b * d_b));
}

static float LabChroma(const cv::Vec3f &lab)
{
    return std::sqrt((lab[1] * lab[1]) + (lab[2] * lab[2]));
}

/**
 * @brief 基于白参考块和色卡块构建颜色标定参数。
 * @param frame_bgr 输入 BGR 图像，要求为 8bit 三通道。
 * @param white_roi 白参考块 ROI。
 * @param patch_samples 色卡块样本及其标准线性 RGB。
 * @param calibration 输出标定结果。
 * @retval true 标定成功。
 * @retval false 白块无效、样本不足或矩阵求解失败。
 *
 * @note 流水线如下:
 *       1. 用白块估计通道增益: gain_k = target_white_k / measured_white_k
 *       2. 对所有色卡块先做白平衡补偿
 *       3. 通过最小二乘求 3x3 CCM
 */
bool BuildColorCalibration(const cv::Mat &frame_bgr,
                           const cv::Rect &white_roi,
                           const std::vector<ColorPatchSample_t> &patch_samples,
                           ColorCalibration_t *calibration)
{
    std::vector<cv::Vec3f> measured_balanced_rgb;
    std::vector<cv::Vec3f> target_linear_rgb;
    float white_max_code = 255.0f;
    float white_mean_code = 0.0f;
    cv::Vec3f white_linear_rgb;
    cv::Vec3f raw_gain;

    if ((calibration == nullptr) || patch_samples.empty())
    {
        return false;
    }

    white_linear_rgb = MeanLinearRgbRoi(frame_bgr, white_roi, &white_max_code, &white_mean_code);
    if ((white_max_code >= 250.0f) || (white_mean_code <= 16.0f))
    {
        /*
         * 白参考已经接近饱和或过暗时，白点估计不再可信。
         */
        return false;
    }

    raw_gain = cv::Vec3f(1.0f / std::max(white_linear_rgb[0], 1.0e-6f),
                         1.0f / std::max(white_linear_rgb[1], 1.0e-6f),
                         1.0f / std::max(white_linear_rgb[2], 1.0e-6f));
    calibration->wb_gain = NormalizeGainVector(raw_gain);

    for (const ColorPatchSample_t &sample : patch_samples)
    {
        float patch_max_code = 255.0f;
        float patch_mean_code = 0.0f;
        const cv::Vec3f measured_linear =
            MeanLinearRgbRoi(frame_bgr, sample.roi, &patch_max_code, &patch_mean_code);

        if ((patch_max_code >= 250.0f) || (patch_mean_code <= 8.0f))
        {
            continue;
        }

        measured_balanced_rgb.push_back(ApplyWhiteBalanceGain(measured_linear, calibration->wb_gain));
        target_linear_rgb.push_back(sample.target_linear_rgb);
    }

    if (!SolveColorCorrectionMatrix(measured_balanced_rgb, target_linear_rgb, &calibration->ccm))
    {
        return false;
    }

    calibration->white_xyz = cv::Vec3f(0.95047f, 1.00000f, 1.08883f);
    calibration->saturation_code_limit = 250.0f;
    calibration->darkness_code_limit = 12.0f;
    calibration->valid = true;
    return true;
}

/**
 * @brief 对目标 ROI 进行颜色判决，并在 Lab 空间用 ΔE 做门控。
 * @param frame_bgr 输入 BGR 图像。
 * @param target_roi 目标 ROI。
 * @param calibration 颜色标定参数。
 * @param targets 目标颜色表，内部存放已知标准 Lab 和阈值。
 * @return 颜色判决结果。
 *
 * @note 运行时映射链:
 *       1. rgb_linear = inverse_gamma(frame_bgr)
 *       2. rgb_balanced = diag(wb_gain) * rgb_linear
 *       3. rgb_corrected = ccm * rgb_balanced
 *       4. xyz = M_rgb2xyz * rgb_corrected
 *       5. lab = f(xyz, white_xyz)
 *       6. 取 DeltaE 最小的目标，并要求 DeltaE 小于门限
 *
 *       判决前先拒绝过曝与过暗 ROI，避免把丢失信息当成颜色差异。
 */
ColorDecision_t ClassifyColorRoi(const cv::Mat &frame_bgr,
                                 const cv::Rect &target_roi,
                                 const ColorCalibration_t &calibration,
                                 const std::vector<ColorTarget_t> &targets)
{
    ColorDecision_t decision = {};
    float roi_max_code = 255.0f;
    float roi_mean_code = 0.0f;
    cv::Vec3f corrected_rgb;

    decision.best_delta_e76 = std::numeric_limits<float>::infinity();
    decision.valid = false;

    if ((!calibration.valid) || targets.empty())
    {
        return decision;
    }

    {
        const cv::Vec3f linear_rgb = MeanLinearRgbRoi(frame_bgr, target_roi, &roi_max_code, &roi_mean_code);
        const cv::Vec3f balanced_rgb = ApplyWhiteBalanceGain(linear_rgb, calibration.wb_gain);

        corrected_rgb = ApplyMat3(calibration.ccm, balanced_rgb);

        /*
         * 颜色校正矩阵可能因噪声和最小二乘外插把值推出 [0, 1]。
         * 这里显式限幅，避免后续 XYZ/Lab 出现非物理负能量。
         */
        corrected_rgb[0] = ClampF(corrected_rgb[0], 0.0f, 1.5f);
        corrected_rgb[1] = ClampF(corrected_rgb[1], 0.0f, 1.5f);
        corrected_rgb[2] = ClampF(corrected_rgb[2], 0.0f, 1.5f);
    }

    decision.saturated = (roi_max_code >= calibration.saturation_code_limit);
    decision.too_dark = (roi_mean_code <= calibration.darkness_code_limit);

    if (decision.saturated || decision.too_dark)
    {
        return decision;
    }

    decision.measured_lab = XyzToLab(LinearRgbToXyzD65(corrected_rgb), calibration.white_xyz);
    decision.measured_chroma = LabChroma(decision.measured_lab);

    for (const ColorTarget_t &target : targets)
    {
        const float delta_e76 = DeltaE76(decision.measured_lab, target.target_lab);

        if (delta_e76 < decision.best_delta_e76)
        {
            decision.best_delta_e76 = delta_e76;
            decision.name = target.name;
            decision.valid = ((delta_e76 <= target.max_delta_e76) &&
                              (decision.measured_chroma >= target.min_chroma));
        }
    }

    return decision;
}

/*
 * 下面是一组示例目标色，可通过标准色卡或现场实测物料统计后生成。
 * 真正部署时不要直接照抄阈值，而应由稳定光源下的批量样本分布回推。
 */
static const std::vector<ColorTarget_t> g_demo_targets =
{
    { "red_cap",    cv::Vec3f(42.0f, 58.0f, 32.0f),  9.0f, 20.0f },
    { "green_cap",  cv::Vec3f(65.0f, -42.0f, 28.0f), 8.0f, 18.0f },
    { "blue_cap",   cv::Vec3f(33.0f, 15.0f, -46.0f), 8.0f, 18.0f },
    { "yellow_cap", cv::Vec3f(78.0f, -6.0f, 72.0f), 10.0f, 22.0f }
};
```

这段代码刻意把“颜色识别”拆成三件可独立验证的事:

- **先判断当前图像还有没有量测资格**：白参考和目标 ROI 只要过曝、欠曝或参考块丢失，就应拒绝给颜色结论。
- **再把设备相关颜色拉回可比较空间**：白平衡增益负责吸收一阶色温漂移，CCM 负责补偿传感器谱响应与标准颜色空间之间的线性失配。
- **最后才在 Lab 里做距离门控**：`DeltaE` 不是万能真理，但它比在 HSV 上直接拉球半径更接近“颜色差异”的工程语义。

如果现场允许，我会优先要求三样东西，而不是先加模型复杂度:

- 一块长期可见的白参考。
- 一套固定曝光或至少受控的曝光策略。
- 一次基于真实工位光源和真实相机的色卡标定。

少了这三样，再漂亮的阈值曲线也只是把漂移问题藏起来。颜色识别真正稳定的前提，不是“调到了一个好参数”，而是系统承认自己一直在跟光源、传感器和坐标系误差谈判，并且把这场谈判写进了数学映射里。
