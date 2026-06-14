# 月栖之地

这是一个基于 [Hugo](https://gohugo.io/) 的静态博客项目，当前启用主题为 `Stack`，部署地址配置为 `https://xw911-blog.vercel.app/`。

## 项目结构

```text
blog
├─ hugo.toml                  # Hugo 主配置，当前 theme = "Stack"
├─ config/_default/
│  ├─ menu.toml               # 导航菜单配置
│  └─ params.toml             # 主题参数、侧边栏、文章、评论、图片处理配置
├─ content/                   # 站点内容源文件
│  ├─ post/                   # 主文章内容
│  ├─ notes/                  # 知识笔记
│  ├─ reference/              # 速查页内容
│  ├─ page/                   # 关于、归档、链接、搜索等独立页面
│  └─ categories/             # 分类页面内容
├─ layouts/                   # 自定义 Hugo 模板覆盖
│  ├─ reference/list.html
│  ├─ reference/single.html
│  ├─ _partials/sidebar/left.html
│  └─ _shortcodes/            # 自定义短代码
├─ assets/                    # Hugo Pipes 资源
│  ├─ scss/custom.scss        # 自定义样式
│  ├─ img/avatar.jpg          # 头像资源
│  └─ icons/                  # 自定义图标
├─ static/                    # 静态直出资源
├─ data/                      # 数据文件，例如链接数据
├─ archetypes/                # 新内容模板
├─ themes/
│  ├─ Stack/                  # 当前使用主题
│  └─ LoveIt/                 # 保留主题
├─ public/                    # Hugo 构建产物
├─ resources/                 # Hugo 缓存与资源产物
└─ img2ref.py / img2ref_gui.py # 本地内容辅助脚本
```

## 主要配置

- 站点语言：`zh-CN`
- 默认内容语言：`zh-cn`
- 当前主题：`Stack`
- 文章永久链接：`/p/:slug/`
- 页面永久链接：`/:slug/`
- 首页输出：`HTML`、`RSS`、`JSON`
- Markdown 渲染允许 HTML：`unsafe = true`

## 内容组织

- `content/post/`：博客主文章。
- `content/notes/`：知识笔记类内容。
- `content/reference/`：速查内容，目前包含 `cpp`、`python`、`opencv`、`deep learning` 等方向。
- `content/page/`：站点功能页面，例如关于、归档、链接、搜索。

## 维护说明

- 日常内容编辑优先修改 `content/`。
- 站点导航和主题参数优先修改 `config/_default/`。
- 页面结构定制优先修改 `layouts/`。
- 样式定制优先修改 `assets/scss/custom.scss`。
- `public/` 与 `resources/` 通常为构建产物或缓存，不作为主要源文件维护。
