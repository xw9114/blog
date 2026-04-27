---
title: "技能档案：KMP 算法及其在循环同构匹配中的深度实践"
slug: "skill-kmp-circular-matching"
date: 2026-04-27T21:05:00+08:00
draft: false
description: "深入剖析 KMP 算法的“对称美”，通过前缀表构建与破环成链技巧，解决高效字符串匹配与循环同构判定问题。"
tags: ["算法", "KMP", "字符串"]
categories: ["技能档案"]
image: ""
---

## 技能概述

熟练掌握 **KMP (Knuth-Morris-Pratt)** 字符串匹配算法及其核心衍生应用。不仅限于基础的单模式匹配，更能深刻理解 `next` 数组（前缀函数）的数学本质——即字符串前缀与后缀的最长公共匹配。在处理“循环同构”或“周期性检测”等复杂场景时，能够灵活运用“破环成链”思想配合 KMP 实现 $O(n + m)$ 的线性时间复杂度优化，规避传统暴力匹配在最坏情况下的 $O(n \times m)$ 性能陷阱。

## 核心能力矩阵

* **前缀函数 (Next Array) 深度理解**：通过双指针联动模拟“履带与弹簧”机制，利用已匹配部分的对称性实现无回溯的主串遍历，其本质是确定性有限自动机 (DFA) 的精简实现。
* **循环同构判定 (Circular Isomorphism)**：利用 $S + S$ 的拼接策略将环状搜索转化为线性搜索，配合 KMP 算法在 $2N$ 长度的空间内快速定位目标模式串。
* **状态机回退逻辑优化**：掌握 `while (j > 0 && pattern[i] != pattern[j]) j = next[j - 1]` 的递归回退原理，确保在不匹配时能通过预处理信息跳跃到下一个潜在匹配位置。

## 代码能力展现

以下展示 KMP 算法的完整 C++ 实践。不仅包含前缀表（`getNext`）的标准构建，还展示了如何结合“破环成链”思想，将其降维打击应用到“循环同构”判定这一经典变种问题中。

```cpp
#include <vector>
#include <string>

/**
 * @brief 构建前缀表 (Next 数组)
 * 核心逻辑：模式串与自身进行匹配，寻找最长相等前后缀
 * @param pattern 模式串
 * @return vector<int> 前缀表，next[i] 表示 pattern[0...i] 中相等前后缀的最大长度
 */
std::vector<int> getNext(const std::string& pattern) {
    int m = pattern.length();
    std::vector<int> next(m, 0); 
    
    // j 既是前缀末尾指针，也代表当前已匹配的长度
    int j = 0; 

    // i 是后缀末尾指针，从 1 开始遍历，模拟“履带”前行
    for (int i = 1; i < m; i++) {
        
        // 核心步骤 1：失配时，j 沿着 next 数组回退（弹簧机制）
        // 寻找更短的相等前后缀，避免暴力的指针归零
        while (j > 0 && pattern[i] != pattern[j]) {
            j = next[j - 1]; 
        }
        
        // 核心步骤 2：当前字符匹配成功，前缀长度加 1
        if (pattern[i] == pattern[j]) {
            j++;
        }
        
        // 核心步骤 3：记录当前位置 i 的最长相等前后缀长度
        next[i] = j;
    }
    
    return next;
}

/**
 * @brief 循环同构判定 (KMP 扩展应用)
 * 核心逻辑：若 s2 是 s1 的循环旋转（如 s1="waterbottle", s2="erbottlewat"），
 * 则 s2 必定是 s1+s1 ("waterbottlewaterbottle") 的子串。
 * @param s1 主串 1
 * @param s2 待匹配的模式串 2
 * @return bool 是否互为循环同构
 */
bool isCircularIsomorphic(const std::string& s1, const std::string& s2) {
    // 长度不等或为空，必定不构成同构
    if (s1.length() != s2.length() || s1.empty()) {
        return false;
    }
    
    // 破环成链：将物理上的环状结构展开为线性空间
    std::string text = s1 + s1;
    std::vector<int> next = getNext(s2);
    
    int j = 0; // 模式串指针
    // 在 2N 长度的主串中执行标准 KMP 搜索
    for (int i = 0; i < text.length(); i++) {
        // 失配时，状态机无情回退
        while (j > 0 && text[i] != s2[j]) {
            j = next[j - 1];
        }
        
        // 匹配成功，推进指针
        if (text[i] == s2[j]) {
            j++;
        }
        
        // 若 j 走到了 s2 的尽头，说明在 s1+s1 中找到了 s2
        if (j == s2.length()) {
            return true; 
        }
    }
    
    return false;
}