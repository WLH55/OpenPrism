# 技能沙箱基础镜像（spec: 2026-10-21_11-23_技能系统Docker沙箱化）
# 服务器上构建：docker build -t openprism-skill-base:1 -f deploy/skill-base.Dockerfile deploy/
# 首次拉取 python 基础镜像如遇 Docker Hub 超时：在 /etc/docker/daemon.json 配置 registry-mirrors 后 systemctl restart docker 重试。
FROM python:3.12-slim

# apt 换腾讯云镜像源（bookworm 是 deb822 格式，旧格式兜底）
RUN sed -i 's|deb.debian.org|mirrors.cloud.tencent.com|g' /etc/apt/sources.list.d/debian.sources 2>/dev/null; \
    sed -i 's|deb.debian.org|mirrors.cloud.tencent.com|g' /etc/apt/sources.list 2>/dev/null; true

# 构建工具 + 市面技能常用系统 CLI（pdf 技能要 poppler、多媒体技能要 ffmpeg/imagemagick）
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential curl ca-certificates git unzip xz-utils \
      poppler-utils ffmpeg imagemagick \
    && rm -rf /var/lib/apt/lists/*

# Node 22（NodeSource；npm registry 换腾讯云）
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && npm config set registry https://mirrors.cloud.tencent.com/npm/

# uv（Python 依赖装进每技能独立 .venv 的工具链；pip 源换腾讯云）
RUN pip config set global.index-url https://mirrors.cloud.tencent.com/pypi/simple \
    && pip install --no-cache-dir uv

# 技能运行约定：技能文件与工作目录在 /home/skill（安装时注入，执行时挂载运行目录）
RUN mkdir -p /home/skill/run/output
WORKDIR /home/skill
