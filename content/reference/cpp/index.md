---
title: "C++ 备忘清单"
description: "提供基本语法和方法的 C++ 快速参考备忘单"
type: reference
icon: "C++"
color: "#00599C"
toc: false
date: 2026-06-06
---

## 入门

{{< ref-cols >}}

{{< ref-card filename="hello.cpp" >}}
```cpp
#include <iostream>
int main() {
    std::cout << "Hello Quick Reference\n";
    return 0;
}
```
编译运行
{{< /ref-card >}}

{{< ref-card filename="变量" >}}
```cpp
int number = 5;          // 整数
float f = 0.95;          // 浮点数
double PI = 3.14159;     // 浮点数
char yes = 'Y';          // 字符
std::string s = "ME";    // 字符串（文本）
bool isRight = true;     // 布尔值
// 常量
const float RATE = 0.8;
```
{{< /ref-card >}}

{{< ref-card filename="原始数据类型" >}}
| 数据类型 | 大小 | 范围 |
|---------|------|------|
| `int` | 4字节 | -2³¹ 到 2³¹-1 |
| `float` | 4字节 | 无 |
| `double` | 8字节 | 无 |
| `char` | 1字节 | -128 到 127 |
| `bool` | 1字节 | true / false |
| `void` | — | 无值 |
{{< /ref-card >}}

{{< /ref-cols >}}

## 流程控制

{{< ref-cols >}}

{{< ref-card filename="if / else" >}}
```cpp
int a = 10, b = 20;
if (a > b) {
    std::cout << "a 更大\n";
} else if (a == b) {
    std::cout << "相等\n";
} else {
    std::cout << "b 更大\n";
}
```
{{< /ref-card >}}

{{< ref-card filename="for 循环" >}}
```cpp
// 基础 for
for (int i = 0; i < 5; i++) {
    std::cout << i << "\n";
}

// 范围 for（C++11）
std::vector<int> v = {1, 2, 3};
for (int x : v) {
    std::cout << x << "\n";
}
```
{{< /ref-card >}}

{{< ref-card filename="while / do-while" >}}
```cpp
// while
int n = 0;
while (n < 5) {
    n++;
}

// do-while（至少执行一次）
do {
    n--;
} while (n > 0);
```
{{< /ref-card >}}

{{< ref-card filename="switch" >}}
```cpp
int day = 3;
switch (day) {
    case 1: std::cout << "周一\n"; break;
    case 2: std::cout << "周二\n"; break;
    case 3: std::cout << "周三\n"; break;
    default: std::cout << "其他\n"; break;
}
```
{{< /ref-card >}}

{{< ref-card filename="三元运算符" >}}
```cpp
// condition ? true_val : false_val
int x = 5;
std::string res = (x > 3) ? "大" : "小";

// 等价于
std::string res2;
if (x > 3) res2 = "大";
else res2 = "小";
```
{{< /ref-card >}}

{{< /ref-cols >}}

## 函数

{{< ref-cols >}}

{{< ref-card filename="函数定义" >}}
```cpp
// 返回类型 函数名(参数列表)
int add(int a, int b) {
    return a + b;
}

// 调用
int result = add(3, 4);  // 7
```
{{< /ref-card >}}

{{< ref-card filename="默认参数 & 重载" >}}
```cpp
// 默认参数（必须在末尾）
void greet(std::string name, int times = 1) {
    for (int i = 0; i < times; i++)
        std::cout << "Hi " << name << "\n";
}
greet("Alice");        // times = 1
greet("Bob", 3);       // times = 3

// 函数重载
int square(int x) { return x * x; }
double square(double x) { return x * x; }
```
{{< /ref-card >}}

{{< ref-card filename="lambda（C++11）" >}}
```cpp
// [捕获列表](参数) -> 返回类型 { 函数体 }
auto add = [](int a, int b) -> int {
    return a + b;
};
std::cout << add(2, 3) << "\n";  // 5

// 捕获外部变量
int base = 10;
auto addBase = [base](int x) { return x + base; };
```
{{< /ref-card >}}

{{< ref-card filename="引用 & 指针参数" >}}
```cpp
// 引用传参（修改原值）
void increment(int& n) { n++; }

// 指针传参
void setZero(int* p) { *p = 0; }

int val = 5;
increment(val);   // val = 6
setZero(&val);    // val = 0
```
{{< /ref-card >}}

{{< /ref-cols >}}

## 标准库常用容器

{{< ref-cols >}}

{{< ref-card filename="vector" >}}
```cpp
#include <vector>
std::vector<int> v = {1, 2, 3};

v.push_back(4);         // 追加
v.pop_back();           // 删除末尾
v.size();               // 元素个数
v[0];                   // 下标访问（不检查越界）
v.at(0);                // 下标访问（检查越界）
v.front();              // 第一个
v.back();               // 最后一个
v.clear();              // 清空
```
{{< /ref-card >}}

{{< ref-card filename="string" >}}
```cpp
#include <string>
std::string s = "hello";

s.length();             // 5
s.size();               // 5（同 length）
s += " world";          // 拼接
s.substr(0, 5);         // "hello"
s.find("world");        // 返回位置，未找到返回 npos
s.replace(6, 5, "C++"); // 替换
std::to_string(42);     // int → string
std::stoi("42");        // string → int
```
{{< /ref-card >}}

{{< ref-card filename="map / unordered_map" >}}
```cpp
#include <map>
std::map<std::string, int> m;
m["apple"] = 1;
m["banana"] = 2;

m.count("apple");       // 1（存在）或 0
m.find("apple");        // 迭代器
m.erase("apple");       // 删除
m.size();               // 键值对数量

// 遍历
for (auto& [k, v] : m) {
    std::cout << k << ": " << v << "\n";
}
```
{{< /ref-card >}}

{{< ref-card filename="常用算法" >}}
```cpp
#include <algorithm>
std::vector<int> v = {3, 1, 4, 1, 5};

std::sort(v.begin(), v.end());          // 升序排序
std::reverse(v.begin(), v.end());       // 反转
auto it = std::find(v.begin(), v.end(), 4); // 查找
std::max_element(v.begin(), v.end());   // 最大值迭代器
std::min_element(v.begin(), v.end());   // 最小值迭代器
std::accumulate(v.begin(), v.end(), 0); // 求和（需 <numeric>）
```
{{< /ref-card >}}

{{< /ref-cols >}}

## 类与面向对象

{{< ref-cols >}}

{{< ref-card filename="类定义" >}}
```cpp
class Animal {
private:
    std::string name;
    int age;

public:
    // 构造函数
    Animal(std::string n, int a) : name(n), age(a) {}

    // 成员函数
    void speak() const {
        std::cout << name << " says hello\n";
    }

    // getter
    std::string getName() const { return name; }
};

Animal cat("Tom", 3);
cat.speak();
```
{{< /ref-card >}}

{{< ref-card filename="继承" >}}
```cpp
class Dog : public Animal {
public:
    Dog(std::string n, int a) : Animal(n, a) {}

    // 重写
    void speak() const {
        std::cout << getName() << ": Woof!\n";
    }
};

Dog d("Buddy", 2);
d.speak();            // Buddy: Woof!
```
{{< /ref-card >}}

{{< ref-card filename="访问控制" >}}
| 修饰符 | 类内 | 子类 | 外部 |
|-------|------|------|------|
| `public` | ✓ | ✓ | ✓ |
| `protected` | ✓ | ✓ | ✗ |
| `private` | ✓ | ✗ | ✗ |

结构体（`struct`）默认 `public`，类（`class`）默认 `private`。
{{< /ref-card >}}

{{< ref-card filename="智能指针（C++11）" >}}
```cpp
#include <memory>

// unique_ptr：独占所有权
auto p1 = std::make_unique<int>(42);

// shared_ptr：共享所有权
auto p2 = std::make_shared<Animal>("Leo", 5);
auto p3 = p2;  // 引用计数 +1

// 使用
(*p1)++;                // 解引用
p2->speak();            // 成员访问
p2.reset();             // 释放（计数 -1）
```
{{< /ref-card >}}

{{< /ref-cols >}}
