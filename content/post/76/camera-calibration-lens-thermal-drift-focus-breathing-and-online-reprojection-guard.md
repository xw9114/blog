---
title: "技能档案：相机标定里的镜头温漂、对焦呼吸与在线重投影守卫"
slug: "skill-camera-calibration-thermal-drift-focus-breathing-online-reprojection-guard"
date: 2026-07-01T09:06:03+08:00
draft: false
description: "从针孔焦距热漂移、对焦呼吸引发的内参缩放到分区重投影残差与在线健康评分，系统拆解“标定一次就永久可用”为什么只是实验室幻觉。"
tags: ["OpenCV", "相机标定", "温漂", "对焦呼吸", "重投影误差", "机器视觉", "边缘计算"]
categories: ["技能档案"]
image: ""
---

## 技能概述

很多团队把相机标定当成一次性工序：打印棋盘格、跑完 `calibrateCamera()`、把 `cameraMatrix` 和 `distCoeffs` 固化进程序，然后默认视觉到物理世界的映射从此稳定。但一旦设备进温箱、镜头重新合焦、塑胶支架吃热膨胀、产线景深被迫调整，系统最先崩的往往不是识别模型，而是**像素到毫米的度量契约本身**。这个主题解决的核心痛点，不是“标定 API 怎么调用”，而是如何理解镜头温漂与对焦呼吸为什么会悄悄改写有效焦距、为什么全局 `RMS` 很低仍可能在视场边缘持续失真，以及如何用在线重投影守卫把失效中的标定先识别出来，再决定要不要继续信任这套内参。

## 核心底层概念解析

- **相机标定不是一张表，而是一份光学几何合同**：针孔模型写成  
  `u = f_x * X / Z + c_x`，`v = f_y * Y / Z + c_y`。  
  这里真正被固化的不是几个数字，而是“镜头组、传感器、安装位置、工作温度、焦点位置”共同签下的一份近似合同。合同条件一变，`f_x/f_y/c_x/c_y` 的有效值就可能跟着漂。

- **镜头温漂首先影响的不是清晰度，而是等效焦距和主点稳定性**：塑胶镜座、胶水层、金属支架和传感器封装都有不同热膨胀系数，玻璃折射率也随温度变化。结果不是简单的“有点糊”，而是入射角到像平面的映射系数被改写。对一阶模型，可以把它近似成  
  `f_x(T) = f_x0 * (1 + alpha_x * Delta T)`，`f_y(T) = f_y0 * (1 + alpha_y * Delta T)`。

- **对焦呼吸不是摄影圈术语，它会直接污染机器视觉的长度尺度**：很多镜头在调焦时会改变镜片组间距，导致视场角和等效焦距一起变化。换句话说，合焦动作并不只是在调模糊，而是在改 `f`。当单目测距依赖  
  `Z = f * L / l_px`  
  时，就有  
  `Delta Z / Z ~= Delta f / f - Delta l_px / l_px`。  
  哪怕 `f` 只漂了 `1%`，物距也会原样带入 `1%` 的系统性偏差。

- **全局重投影 `RMS` 很低，不代表标定健康**：`RMS` 是把所有角点误差压成一个标量，容易把边缘异常、径向结构性漂移和单方向拉伸平均掉。真正该看的是  
  `e_i = p_i - p_hat_i`  
  在图像上的空间分布：是中心小边缘大，还是只在某个角落系统偏移，还是 `x` 向比 `y` 向更差。

- **畸变参数失效常先在边缘暴露，而不是先把平均误差拉爆**：镜头热漂后，`k1/k2` 不一定立刻整体崩坏，但边缘射线的弯折误差会先冒头。所以很多设备在实验室里 `mean error = 0.2 px`，上机后仍会出现“中心对、边缘偏”的现象。失效不是瞬间坍塌，而是从视场外环先开始松动。

- **主点漂移本质上是光轴与像面相对关系在移动**：`c_x/c_y` 不是神圣常数，它们只是当前装配状态下的最佳像素原点。镜头座受热、模组受振、螺纹镜头重复装配后，主点会以像素级别缓慢挪动。对高倍率、小视场或亚像素定位任务来说，这已经足够让末端机械偏差超规格。

- **在线守卫不是“重新标定”，而是先问这套内参还值不值得信**：完整在线自标定代价很高，也容易把场景结构误吸进参数。更实用的做法是保持 `KISS`：只做一阶温漂补偿、一个各向同性焦距呼吸缩放，再把剩余问题交给重投影残差来诊断。能解释的先解释，解释不了的及时降权。

- **温漂补偿适合建模成低维、一阶、连续的漂移**：比如  
  `f_x^T = f_x0 * (1 + alpha_x * Delta T)`，  
  `c_x^T = c_x0 + beta_x * Delta T`。  
  这是典型的 `YAGNI` 选择：不急着引入高阶多项式，不把每个畸变项都做成温度函数，先抓最常见、最有物理意义的漂移源。

- **对焦呼吸更适合被估计成一个在线尺度因子，而不是完全重求全部内参**：若当前姿态下归一化成像坐标为 `x_n = X_c / Z_c`，`y_n = Y_c / Z_c`，则可以通过最小二乘估计一个统一的 `s_focus`，让  
  `u - c_x ~= s_focus * f_x^T * x_n`，  
  `v - c_y ~= s_focus * f_y^T * y_n`。  
  这相当于承认“镜头在变焦距，但先把它当作一阶等比例缩放”。

- **标定健康度应该是分层的，而不是二值的**：`mean reprojection`、`edge/center error ratio`、`focus scale jump`、`marker area` 应该共同构成一份健康评分。系统可以处于“还能用但该降权”的退化态，而不是非黑即白地继续闭环或完全停机。

- **参考靶标面积太小，再聪明的守卫也会退化成噪声放大器**：当在线参考板只占几十个像素时，亚像素角点噪声会轻易盖过真实温漂。守卫系统本身也有可观测性边界，不能假装从几枚模糊角点里恢复完整的光学变化。

- **技术哲学上，标定从来不是“求完就结束”，而是“映射是否还可信”的持续审计**：像素世界和物理世界之间的桥梁，不是一次求出的矩阵，而是被温度、机械和光学不断冲刷的一条边界。成熟系统不会盲信旧标定，而会持续质问它还剩多少可信度。

## 代码能力展现

下面给出一个基于 OpenCV C++ 的在线标定守卫模块。它不是做“全自动在线重标定”，而是把问题收敛成三层：

- **第一层**：依据镜头温度做一阶内参漂移补偿；
- **第二层**：在当前姿态上估计一个各向同性的对焦呼吸尺度 `s_focus`；
- **第三层**：用分区重投影残差、焦距跳变和参考靶标面积判断当前标定是否进入退化区。

这样做的价值在于：既承认光学系统会漂，也避免把在线守卫写成一个无限膨胀、不可验证的“万能自标定器”。

```cpp
#include <opencv2/calib3d.hpp>
#include <opencv2/core.hpp>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <limits>
#include <vector>

struct ThermalCalibrationModel_t
{
    cv::Mat camera_matrix_ref;          /* 基准内参，要求为 CV_64F 的 3x3 矩阵。 */
    cv::Mat distortion_coeffs_ref;      /* 基准畸变参数，在线阶段保持不变，仅由残差诊断其失效趋势。 */
    float reference_temp_c;             /* 标定完成时的镜头温度。 */
    float fx_temp_coeff_ppm_per_c;      /* fx 的温漂系数，单位 ppm / degC。 */
    float fy_temp_coeff_ppm_per_c;      /* fy 的温漂系数，单位 ppm / degC。 */
    float cx_shift_px_per_c;            /* 主点 x 的温漂，单位 px / degC。 */
    float cy_shift_px_per_c;            /* 主点 y 的温漂，单位 px / degC。 */
    float max_focus_scale_delta;        /* 允许的最大对焦呼吸比例偏移，例如 0.03 表示 +/-3%。 */
    float max_mean_reproj_px;           /* 平均重投影误差上限。 */
    float max_edge_center_ratio;        /* 边缘 / 中心误差比上限。 */
    float max_focus_scale_step;         /* 相邻两次有效尺度估计允许的最大跳变。 */
    float radial_edge_threshold;        /* 用于区分中心区和边缘区的归一化半径阈值。 */
    float min_marker_area_px;           /* 在线参考靶标的最小投影面积。 */
};

struct ReprojectionMetrics_t
{
    float mean_px;
    float rms_px;
    float max_px;
    float center_mean_px;
    float edge_mean_px;
    float edge_center_ratio;
};

struct CalibrationGuardState_t
{
    bool initialized;
    float last_focus_scale;
    cv::Mat rvec;
    cv::Mat tvec;
};

struct OnlineCalibrationGuardResult_t
{
    cv::Mat camera_matrix_pred;
    cv::Mat camera_matrix_eff;
    cv::Mat rvec;
    cv::Mat tvec;
    ReprojectionMetrics_t reproj;
    float thermal_scale_x;
    float thermal_scale_y;
    float focus_scale;
    float focus_scale_step;
    float marker_area_px;
    bool degraded;
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

/**
 * @brief 计算在线参考靶标在图像中的投影面积。
 * @param image_points 参考靶标的图像点，要求按轮廓顺序排列。
 * @retval 投影面积，单位 px^2；若点数不足则返回 0。
 */
static float ComputeMarkerAreaPx(const std::vector<cv::Point2f> &image_points)
{
    if (image_points.size() < 3U)
    {
        return 0.0f;
    }

    return static_cast<float>(std::fabs(cv::contourArea(image_points)));
}

/**
 * @brief 根据镜头温度预测当前一阶内参。
 * @param model 温漂模型。
 * @param lens_temp_c 当前镜头温度。
 * @param thermal_scale_x 输出 fx 的温漂比例。
 * @param thermal_scale_y 输出 fy 的温漂比例。
 * @retval 预测得到的 3x3 内参矩阵。
 *
 * @note 一阶模型采用：
 *       fx(T) = fx0 * (1 + alpha_x * 1e-6 * DeltaT)
 *       fy(T) = fy0 * (1 + alpha_y * 1e-6 * DeltaT)
 *       cx(T) = cx0 + beta_x * DeltaT
 *       cy(T) = cy0 + beta_y * DeltaT
 *
 *       这里刻意只补偿最主要的线性漂移项，避免在线阶段把参数维度扩得过大。
 */
static cv::Mat PredictIntrinsicsByTemperature(const ThermalCalibrationModel_t &model,
                                              float lens_temp_c,
                                              float *thermal_scale_x,
                                              float *thermal_scale_y)
{
    const float delta_t = lens_temp_c - model.reference_temp_c;
    const float scale_x = 1.0f + 1.0e-6f * model.fx_temp_coeff_ppm_per_c * delta_t;
    const float scale_y = 1.0f + 1.0e-6f * model.fy_temp_coeff_ppm_per_c * delta_t;
    cv::Mat camera_matrix = model.camera_matrix_ref.clone();

    camera_matrix.at<double>(0, 0) *= static_cast<double>(scale_x);
    camera_matrix.at<double>(1, 1) *= static_cast<double>(scale_y);
    camera_matrix.at<double>(0, 2) += static_cast<double>(model.cx_shift_px_per_c * delta_t);
    camera_matrix.at<double>(1, 2) += static_cast<double>(model.cy_shift_px_per_c * delta_t);

    if (thermal_scale_x != nullptr)
    {
        *thermal_scale_x = scale_x;
    }

    if (thermal_scale_y != nullptr)
    {
        *thermal_scale_y = scale_y;
    }

    return camera_matrix;
}

/**
 * @brief 计算分区重投影误差，避免全局 RMS 掩盖边缘漂移。
 * @param object_points 在线参考靶标的物点。
 * @param image_points 对应图像点。
 * @param camera_matrix 当前用于投影的内参。
 * @param distortion_coeffs 畸变参数。
 * @param rvec 旋转向量。
 * @param tvec 平移向量。
 * @param image_size 图像尺寸。
 * @param radial_edge_threshold 归一化半径阈值，超过则视为边缘点。
 * @retval 分区误差统计。
 *
 * @note 对每个角点计算：
 *       e_i = ||p_i - p_hat_i||
 *
 *       然后同时统计：
 *       1. 全局 mean / RMS / max
 *       2. 中心区 mean
 *       3. 边缘区 mean
 *       4. edge_center_ratio = edge_mean / center_mean
 *
 *       当热漂主要污染畸变外环时，`edge_center_ratio` 往往比全局 RMS 更早报警。
 */
static ReprojectionMetrics_t ComputeReprojectionMetrics(const std::vector<cv::Point3f> &object_points,
                                                        const std::vector<cv::Point2f> &image_points,
                                                        const cv::Mat &camera_matrix,
                                                        const cv::Mat &distortion_coeffs,
                                                        const cv::Mat &rvec,
                                                        const cv::Mat &tvec,
                                                        const cv::Size &image_size,
                                                        float radial_edge_threshold)
{
    std::vector<cv::Point2f> projected_points;
    ReprojectionMetrics_t metrics{};
    double sum_error = 0.0;
    double sum_sq_error = 0.0;
    double center_sum = 0.0;
    double edge_sum = 0.0;
    int center_count = 0;
    int edge_count = 0;
    const double cx = camera_matrix.at<double>(0, 2);
    const double cy = camera_matrix.at<double>(1, 2);
    const double frame_radius =
        std::sqrt(std::max(cx, static_cast<double>(image_size.width) - cx) *
                  std::max(cx, static_cast<double>(image_size.width) - cx) +
                  std::max(cy, static_cast<double>(image_size.height) - cy) *
                  std::max(cy, static_cast<double>(image_size.height) - cy));

    if ((object_points.size() != image_points.size()) || object_points.empty() || (frame_radius <= 1.0))
    {
        metrics.mean_px = std::numeric_limits<float>::infinity();
        metrics.rms_px = std::numeric_limits<float>::infinity();
        metrics.max_px = std::numeric_limits<float>::infinity();
        metrics.center_mean_px = std::numeric_limits<float>::infinity();
        metrics.edge_mean_px = std::numeric_limits<float>::infinity();
        metrics.edge_center_ratio = std::numeric_limits<float>::infinity();
        return metrics;
    }

    cv::projectPoints(object_points, rvec, tvec, camera_matrix, distortion_coeffs, projected_points);

    for (size_t i = 0U; i < projected_points.size(); ++i)
    {
        const cv::Point2f delta = image_points[i] - projected_points[i];
        const double error = std::sqrt(static_cast<double>(delta.x) * static_cast<double>(delta.x) +
                                       static_cast<double>(delta.y) * static_cast<double>(delta.y));
        const double rx = static_cast<double>(image_points[i].x) - cx;
        const double ry = static_cast<double>(image_points[i].y) - cy;
        const double r_norm = std::sqrt((rx * rx) + (ry * ry)) / frame_radius;

        sum_error += error;
        sum_sq_error += error * error;
        metrics.max_px = std::max(metrics.max_px, static_cast<float>(error));

        if (r_norm >= static_cast<double>(radial_edge_threshold))
        {
            edge_sum += error;
            ++edge_count;
        }
        else
        {
            center_sum += error;
            ++center_count;
        }
    }

    metrics.mean_px = static_cast<float>(sum_error / static_cast<double>(projected_points.size()));
    metrics.rms_px = static_cast<float>(std::sqrt(sum_sq_error / static_cast<double>(projected_points.size())));
    metrics.center_mean_px = (center_count > 0) ? static_cast<float>(center_sum / center_count) : metrics.mean_px;
    metrics.edge_mean_px = (edge_count > 0) ? static_cast<float>(edge_sum / edge_count) : metrics.mean_px;
    metrics.edge_center_ratio =
        metrics.edge_mean_px / std::max(metrics.center_mean_px, 1.0e-6f);

    return metrics;
}

/**
 * @brief 在当前姿态上估计各向同性的对焦呼吸尺度。
 * @param object_points 物点。
 * @param image_points 图像点。
 * @param camera_matrix_pred 温漂补偿后的预测内参。
 * @param rvec 初始姿态的旋转向量。
 * @param tvec 初始姿态的平移向量。
 * @param max_focus_scale_delta 尺度允许偏移范围。
 * @retval 各向同性尺度 `s_focus`。
 *
 * @note 假设对焦呼吸主要体现为焦距整体缩放：
 *       u - cx ~= s_focus * fx_T * x_n
 *       v - cy ~= s_focus * fy_T * y_n
 *
 *       其中 `x_n = X_c / Z_c`，`y_n = Y_c / Z_c`。
 *       对所有点做最小二乘，可得到：
 *       s_focus = sum((u-cx)*a_i + (v-cy)*b_i) / sum(a_i^2 + b_i^2)
 *       a_i = fx_T * x_n_i, b_i = fy_T * y_n_i
 *
 *       该尺度直接作用在 `fx/fy` 上，本质上就是把“焦点变化引发的视角伸缩”压成一维量。
 */
static float EstimateFocusBreathingScale(const std::vector<cv::Point3f> &object_points,
                                         const std::vector<cv::Point2f> &image_points,
                                         const cv::Mat &camera_matrix_pred,
                                         const cv::Mat &rvec,
                                         const cv::Mat &tvec,
                                         float max_focus_scale_delta)
{
    cv::Mat rotation_matrix;
    const double fx = camera_matrix_pred.at<double>(0, 0);
    const double fy = camera_matrix_pred.at<double>(1, 1);
    const double cx = camera_matrix_pred.at<double>(0, 2);
    const double cy = camera_matrix_pred.at<double>(1, 2);
    double numerator = 0.0;
    double denominator = 0.0;

    if ((object_points.size() != image_points.size()) || object_points.empty())
    {
        return 1.0f;
    }

    cv::Rodrigues(rvec, rotation_matrix);

    for (size_t i = 0U; i < object_points.size(); ++i)
    {
        const cv::Mat point_w = (cv::Mat_<double>(3, 1) <<
            static_cast<double>(object_points[i].x),
            static_cast<double>(object_points[i].y),
            static_cast<double>(object_points[i].z));
        const cv::Mat point_c = (rotation_matrix * point_w) + tvec;
        const double z_c = point_c.at<double>(2, 0);

        if (z_c <= 1.0e-6)
        {
            continue;
        }

        /*
         * 这里的 a_i/b_i 是“若尺度正确，像点离主点应该落在哪个半径上”的预测值。
         * 通过把观测值 `(u-cx, v-cy)` 向预测向量投影，就能估计出统一缩放比例。
         */
        {
            const double x_n = point_c.at<double>(0, 0) / z_c;
            const double y_n = point_c.at<double>(1, 0) / z_c;
            const double a_i = fx * x_n;
            const double b_i = fy * y_n;
            const double du = static_cast<double>(image_points[i].x) - cx;
            const double dv = static_cast<double>(image_points[i].y) - cy;

            numerator += (du * a_i) + (dv * b_i);
            denominator += (a_i * a_i) + (b_i * b_i);
        }
    }

    if (denominator <= 1.0e-12)
    {
        return 1.0f;
    }

    return ClampF(static_cast<float>(numerator / denominator),
                  1.0f - max_focus_scale_delta,
                  1.0f + max_focus_scale_delta);
}

/**
 * @brief 把对焦呼吸尺度应用到温漂预测内参上。
 * @param camera_matrix_pred 温漂补偿后的预测内参。
 * @param focus_scale 对焦呼吸尺度。
 * @retval 生效内参。
 */
static cv::Mat ApplyFocusScale(const cv::Mat &camera_matrix_pred, float focus_scale)
{
    cv::Mat camera_matrix_eff = camera_matrix_pred.clone();

    camera_matrix_eff.at<double>(0, 0) *= static_cast<double>(focus_scale);
    camera_matrix_eff.at<double>(1, 1) *= static_cast<double>(focus_scale);
    return camera_matrix_eff;
}

/**
 * @brief 在线评估当前标定是否仍可被信任。
 * @param object_points 在线参考靶标物点。
 * @param image_points 在线参考靶标图像点。
 * @param image_size 图像尺寸。
 * @param lens_temp_c 当前镜头温度。
 * @param model 在线守卫模型与门限。
 * @param state_inout 守卫状态，会缓存上一次有效的呼吸尺度与姿态。
 * @param result 输出评估结果。
 * @retval true 当前内参可继续用于上层。
 * @retval false 当前观测已进入不可接受区。
 *
 * @note 处理流程：
 *       1. 先做温漂预测，得到 `K_pred`
 *       2. 用 `K_pred` 求一次初始 PnP
 *       3. 在初始姿态上估计 `s_focus`
 *       4. 构造 `K_eff = scale_focus(K_pred)` 后再次求解 PnP
 *       5. 计算分区重投影残差并结合面积 / 跳变门限给出健康结论
 *
 *       这不是完整在线自标定，而是一个“低维补偿 + 显式守卫”的工程折中。
 */
bool EvaluateOnlineCalibrationGuard(const std::vector<cv::Point3f> &object_points,
                                    const std::vector<cv::Point2f> &image_points,
                                    const cv::Size &image_size,
                                    float lens_temp_c,
                                    const ThermalCalibrationModel_t &model,
                                    CalibrationGuardState_t *state_inout,
                                    OnlineCalibrationGuardResult_t *result)
{
    cv::Mat rvec_init = cv::Mat::zeros(3, 1, CV_64F);
    cv::Mat tvec_init = cv::Mat::zeros(3, 1, CV_64F);
    cv::Mat rvec_refined = cv::Mat::zeros(3, 1, CV_64F);
    cv::Mat tvec_refined = cv::Mat::zeros(3, 1, CV_64F);
    OnlineCalibrationGuardResult_t local_result{};
    bool solve_ok = false;

    if ((result == nullptr) || (object_points.size() != image_points.size()) || object_points.size() < 4U)
    {
        return false;
    }

    local_result.marker_area_px = ComputeMarkerAreaPx(image_points);
    if (local_result.marker_area_px < model.min_marker_area_px)
    {
        *result = local_result;
        return false;
    }

    local_result.camera_matrix_pred =
        PredictIntrinsicsByTemperature(model,
                                       lens_temp_c,
                                       &local_result.thermal_scale_x,
                                       &local_result.thermal_scale_y);

    if ((state_inout != nullptr) && state_inout->initialized)
    {
        rvec_init = state_inout->rvec.clone();
        tvec_init = state_inout->tvec.clone();
    }

    solve_ok = cv::solvePnP(object_points,
                            image_points,
                            local_result.camera_matrix_pred,
                            model.distortion_coeffs_ref,
                            rvec_init,
                            tvec_init,
                            (state_inout != nullptr) && state_inout->initialized,
                            cv::SOLVEPNP_ITERATIVE);
    if (!solve_ok)
    {
        *result = local_result;
        return false;
    }

    local_result.focus_scale =
        EstimateFocusBreathingScale(object_points,
                                    image_points,
                                    local_result.camera_matrix_pred,
                                    rvec_init,
                                    tvec_init,
                                    model.max_focus_scale_delta);
    local_result.camera_matrix_eff =
        ApplyFocusScale(local_result.camera_matrix_pred, local_result.focus_scale);

    rvec_refined = rvec_init.clone();
    tvec_refined = tvec_init.clone();
    solve_ok = cv::solvePnP(object_points,
                            image_points,
                            local_result.camera_matrix_eff,
                            model.distortion_coeffs_ref,
                            rvec_refined,
                            tvec_refined,
                            true,
                            cv::SOLVEPNP_ITERATIVE);
    if (!solve_ok)
    {
        *result = local_result;
        return false;
    }

    local_result.rvec = rvec_refined.clone();
    local_result.tvec = tvec_refined.clone();
    local_result.reproj =
        ComputeReprojectionMetrics(object_points,
                                   image_points,
                                   local_result.camera_matrix_eff,
                                   model.distortion_coeffs_ref,
                                   local_result.rvec,
                                   local_result.tvec,
                                   image_size,
                                   model.radial_edge_threshold);

    if ((state_inout != nullptr) && state_inout->initialized)
    {
        local_result.focus_scale_step =
            std::fabs(local_result.focus_scale - state_inout->last_focus_scale);
    }
    else
    {
        local_result.focus_scale_step = 0.0f;
    }

    local_result.degraded =
        (local_result.reproj.edge_center_ratio > model.max_edge_center_ratio) ||
        (std::fabs(local_result.focus_scale - 1.0f) > (0.5f * model.max_focus_scale_delta)) ||
        (local_result.focus_scale_step > model.max_focus_scale_step);

    local_result.valid =
        std::isfinite(local_result.reproj.mean_px) &&
        (local_result.reproj.mean_px <= model.max_mean_reproj_px);

    if (!local_result.valid)
    {
        *result = local_result;
        return false;
    }

    if (state_inout != nullptr)
    {
        state_inout->initialized = true;
        state_inout->last_focus_scale = local_result.focus_scale;
        state_inout->rvec = local_result.rvec.clone();
        state_inout->tvec = local_result.tvec.clone();
    }

    *result = local_result;
    return true;
}

void Example_RunOnlineCalibrationGuard(void)
{
    /*
     * 示例使用一个平面参考板上的 8 个特征点。
     * 真实工程里它可以是 AprilTag 角点、治具上的钢珠中心，或玻璃标尺刻线点。
     */
    const std::vector<cv::Point3f> object_points{
        {-40.0f, -30.0f, 0.0f},
        {  0.0f, -30.0f, 0.0f},
        { 40.0f, -30.0f, 0.0f},
        {-40.0f,   0.0f, 0.0f},
        { 40.0f,   0.0f, 0.0f},
        {-40.0f,  30.0f, 0.0f},
        {  0.0f,  30.0f, 0.0f},
        { 40.0f,  30.0f, 0.0f}
    };

    const std::vector<cv::Point2f> image_points{
        {536.4f, 284.2f},
        {638.7f, 281.9f},
        {742.8f, 279.5f},
        {533.8f, 360.1f},
        {745.5f, 355.7f},
        {531.2f, 436.3f},
        {637.6f, 433.4f},
        {748.1f, 428.8f}
    };

    const ThermalCalibrationModel_t model{
        (cv::Mat_<double>(3, 3) <<
            1212.0, 0.0, 640.0,
            0.0, 1210.5, 360.0,
            0.0, 0.0, 1.0),
        (cv::Mat_<double>(1, 5) << -0.091, 0.026, 0.0008, -0.0005, 0.0),
        24.0f,     /* 参考温度 */
        135.0f,    /* fx 温漂 ppm / degC */
        148.0f,    /* fy 温漂 ppm / degC */
        0.012f,    /* cx 漂移 px / degC */
        -0.009f,   /* cy 漂移 px / degC */
        0.030f,    /* 对焦呼吸允许 +/-3% */
        0.45f,     /* 平均重投影误差上限 */
        1.80f,     /* 边缘 / 中心误差比上限 */
        0.008f,    /* 相邻呼吸尺度估计允许最大跳变 */
        0.62f,     /* 半径超过 62% 视为边缘 */
        2400.0f    /* 在线参考板最小面积 */
    };

    static CalibrationGuardState_t s_state{ false, 1.0f, cv::Mat(), cv::Mat() };
    OnlineCalibrationGuardResult_t result{};

    if (!EvaluateOnlineCalibrationGuard(object_points,
                                        image_points,
                                        cv::Size(1280, 720),
                                        41.5f,
                                        model,
                                        &s_state,
                                        &result))
    {
        return;
    }

    /*
     * 上层系统可基于 result 做不同级别动作：
     * 1. valid = false：停止把视觉量测直接送进控制闭环。
     * 2. degraded = true：允许继续运行，但降低视觉权重，等待维护或重新标定。
     * 3. focus_scale_step 持续偏大：优先排查镜头是否被反复调焦或锁紧结构是否松动。
     * 4. edge_center_ratio 偏大：优先怀疑畸变模型外环失配，而不是中心区几何本体。
     */
    (void)result;
}
```

这段代码真正做的不是“把温漂修没”，而是把问题拆成三层有边界的工程动作：

- **可预测的线性漂移**，交给温度模型先做一阶补偿；
- **难以直接建模但常近似为缩放的漂移**，交给 `s_focus` 去吸收；
- **剩下仍解释不了的误差**，交给分区重投影残差去报警。

这样系统不会因为一次 `RMS` 好看就长期自我麻痹，也不会一看到误差上涨就动辄全量重标定。对产线设备、边缘视觉模组和带螺纹镜头的嵌入式相机来说，最实用的能力往往不是“永不漂移”，而是**知道自己已经开始漂了多少、漂到什么程度该降权、漂到什么程度必须重标**。这才是标定从实验室数据变成现场工程能力的分水岭。
