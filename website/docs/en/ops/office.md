# Office preview (LibreOffice)

Word / PowerPoint → PDF viewer; spreadsheets (`xls` / `xlsx` / `xlsm` / `ods`) → one CSV per sheet. Conversion runs on the **Agent**; the Hub does not install LibreOffice, and the Agent does not bundle it.

![PowerPoint preview example](/screenshots/08f-preview-office.png)

## Highlights

- **Headless only**: always `soffice --headless` — no GUI / display required.
- **Rootless**: unpack under your home directory; no sudo or system package required.
- **Optional**: without a usable `soffice`, Office files remain downloadable but preview is unavailable; Settings can also disable conversion.

## 1. Install LibreOffice (rootless)

**Debian / Ubuntu style** (deb):

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

**Rocky / RHEL style** (rpm):

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

Replace `VERSION` with the current stable from [Document Foundation](https://www.libreoffice.org/download/download-libreoffice/). If the system already has `soffice` (e.g. `/usr/bin/soffice`), point at that instead.

## 2. Point at soffice

```bash
export FILEBOX_AGENT_SOFFICE="$HOME/opt/libreoffice/opt/libreoffice26.2/program/soffice"
# or:
# export FILEBOX_AGENT_SOFFICE_DIR="$HOME/opt/libreoffice/opt/libreoffice26.2/program"
```

Optional limits (defaults shown; cache must fit at least one full conversion result):

```bash
# FILEBOX_AGENT_OFFICE_TIMEOUT_SECS=120
# FILEBOX_AGENT_OFFICE_MAX_SRC_BYTES=536870912     # 512 MiB
# FILEBOX_AGENT_OFFICE_MAX_PDF_BYTES=1073741824    # 1 GiB derived output total
# FILEBOX_AGENT_OFFICE_MAX_LOG_BYTES=8388608       # 8 MiB
# FILEBOX_AGENT_OFFICE_MAX_MEMORY_BYTES=2147483648 # 2 GiB RSS (Linux)
# FILEBOX_AGENT_OFFICE_CACHE_BYTES=1073741824      # 1 GiB disk cache
```

Restart the Agent. Conversions run on demand with progress and cancel; corrupted or truncated results are discarded and re-converted — never served from a bad cache.

## 3. Verify

```bash
"$FILEBOX_AGENT_SOFFICE" --headless --version
```

Open a `.docx` / `.pptx` / `.xlsx` in the UI — you should land in PDF or CSV preview. Settings can disable Office conversion. If LibreOffice is later removed, preview fails but browsing is unaffected.
