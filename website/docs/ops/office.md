# Office 预览（LibreOffice）

Word / PowerPoint → PDF 查看器；表格（`xls` / `xlsx` / `xlsm` / `ods`）→ 每 sheet 一份 CSV。转换在 **Agent** 上跑，Hub 不装 LibreOffice，Agent 也不捆绑它。

## 特点

- **仅无头**：始终 `soffice --headless`，不需要 GUI / 显示器。
- **Rootless**：解压到家目录即可，无需 sudo 或系统包。
- **可选**：没有可用的 `soffice` 时，Office 文件仍可下载，预览入口不可用；浏览器设置里也可关闭转换。

## 1. 安装 LibreOffice（rootless）

**Debian / Ubuntu 风格**（deb）：

```bash
VERSION=26.2.5
PREFIX="$HOME/opt/libreoffice"
mkdir -p /tmp/lo-dl "$PREFIX" && cd /tmp/lo-dl
curl -L -O \
  "https://download.documentfoundation.org/libreoffice/stable/${VERSION}/deb/x86_64/LibreOffice_${VERSION}_Linux_x86-64_deb.tar.gz"
tar -xzf "LibreOffice_${VERSION}_Linux_x86-64_deb.tar.gz"
cd LibreOffice_*_Linux_x86-64_deb/DEBS
for deb in *.deb; do dpkg-deb -x "$deb" "$PREFIX"; done
```

**Rocky / RHEL 风格**（rpm）：

```bash
VERSION=26.2.5
PREFIX="$HOME/opt/libreoffice"
mkdir -p /tmp/lo-dl "$PREFIX" && cd /tmp/lo-dl
curl -L -O \
  "https://download.documentfoundation.org/libreoffice/stable/${VERSION}/rpm/x86_64/LibreOffice_${VERSION}_Linux_x86-64_rpm.tar.gz"
tar -xzf "LibreOffice_${VERSION}_Linux_x86-64_rpm.tar.gz"
cd LibreOffice_*_Linux_x86-64_rpm/RPMS
for rpm in *.rpm; do rpm2cpio "$rpm" | (cd "$PREFIX" && cpio -idm); done
```

将 `VERSION` 换成 [Document Foundation](https://www.libreoffice.org/download/download-libreoffice/) 上的当前稳定版。

## 2. 指向 soffice

```bash
export FILEBOX_AGENT_SOFFICE="$HOME/opt/libreoffice/opt/libreoffice26.2/program/soffice"
# 或：
# export FILEBOX_AGENT_SOFFICE_DIR="$HOME/opt/libreoffice/opt/libreoffice26.2/program"
```

可选上限（默认示意；缓存至少要能放下一个完整转换结果）：

```bash
# FILEBOX_AGENT_OFFICE_TIMEOUT_SECS=120
# FILEBOX_AGENT_OFFICE_MAX_SRC_BYTES=536870912     # 512 MiB
# FILEBOX_AGENT_OFFICE_MAX_PDF_BYTES=1073741824    # 1 GiB 派生输出合计
# FILEBOX_AGENT_OFFICE_MAX_LOG_BYTES=8388608       # 8 MiB
# FILEBOX_AGENT_OFFICE_MAX_MEMORY_BYTES=2147483648 # 2 GiB RSS（Linux）
# FILEBOX_AGENT_OFFICE_CACHE_BYTES=1073741824      # 1 GiB 磁盘缓存
```

重启 Agent。转换按请求执行，带进度与取消；损坏或截断结果会丢弃并重转，不会从坏缓存提供。

## 3. 验证

```bash
"$FILEBOX_AGENT_SOFFICE" --headless --version
```

UI Settings 中可关闭 Office 转换。若之后卸掉 LibreOffice，预览失败但文件浏览不受影响。
