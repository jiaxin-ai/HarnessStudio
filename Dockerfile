# syntax=docker/dockerfile:1.7
ARG NODE_IMAGE=node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
FROM ${NODE_IMAGE} AS base
# Debian slim may lack an OS CA bundle before apt installs ca-certificates.
# Bootstrap from this pinned Node release's maintained trust store, never by
# disabling HTTPS certificate verification.
RUN node --input-type=module -e 'import { rootCertificates } from "node:tls"; import { mkdirSync, writeFileSync } from "node:fs"; mkdirSync("/etc/ssl/certs", {recursive:true}); writeFileSync("/etc/ssl/certs/ca-certificates.crt", rootCertificates.join("\n") + "\n");'
FROM base AS build
WORKDIR /opt/harnessstudio
RUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::Retries=3 -o Acquire::https::Timeout=30 update \
    && apt-get -o Acquire::Retries=3 -o Acquire::https::Timeout=30 install -y --no-install-recommends git ca-certificates build-essential python3 musl-tools \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global --ignore-scripts pnpm@11.7.0
# Never COPY a developer's checkout, .git, node_modules, home or credentials.
RUN git init deepseek-harness \
    && git -C deepseek-harness remote add origin https://github.com/deepseek-ai/deepseek-harness.git \
    && git -C deepseek-harness fetch --depth=1 origin 5badb15009ae1756c3afe0ae0cef1faafc290ccc \
    && git -C deepseek-harness checkout --detach FETCH_HEAD
COPY scripts/prepare.mjs scripts/container-build.mjs ./scripts/
COPY deploy/build-inputs.json ./deploy/
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
# Cache the locked, official Linux build independently from Studio UI changes.
RUN node scripts/container-build.mjs --upstream
COPY package.json package-lock.json tsconfig.json ./
COPY scripts/ ./scripts/
COPY config/ ./config/
COPY plugins/ ./plugins/
COPY apps/mock-seat/src/ ./apps/mock-seat/src/
COPY apps/sandbox-manager/src/ ./apps/sandbox-manager/src/
COPY prompts/ ./prompts/
COPY deploy/ ./deploy/
RUN node scripts/container-build.mjs --studio

FROM base AS studio
WORKDIR /opt/harnessstudio
RUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::Retries=3 -o Acquire::https::Timeout=30 update \
    && apt-get -o Acquire::Retries=3 -o Acquire::https::Timeout=30 install -y --no-install-recommends git ca-certificates poppler-utils \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global --ignore-scripts pnpm@11.7.0 \
    && mkdir -p /var/lib/harnessstudio && chown node:node /var/lib/harnessstudio
COPY --from=build --chown=node:node /opt/harnessstudio/ ./
# The upstream loader supports loading its immutable packaged binary directly.
# Its default /tmp materialization cannot dlopen from the noexec tmpfs below.
ENV NODE_ENV=production STUDIO_HOME=/var/lib/harnessstudio STUDIO_PORT=3080 STUDIO_BIND_HOST=0.0.0.0 STUDIO_MOCK_SEAT=0 STUDIO_SYSTEM_PROXY=0 NARB_DISABLE_NATIVE_CACHE=1
EXPOSE 3080
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 CMD ["node", "scripts/container-healthcheck.mjs", "studio"]
# Bootstrap owns the two mount roots, reads secret files, then drops to UID/GID
# 1000 before spawning any service. No service runs as root.
ENTRYPOINT ["node", "scripts/container-entrypoint.mjs"]
CMD ["studio"]
# Source version from bin/harnessstudio (docs/deploy-cli.md); last in the stage so the layers above stay cached.
ARG HARNESSSTUDIO_VERSION=unknown
LABEL org.harnessstudio.version=$HARNESSSTUDIO_VERSION

FROM base AS mock-seat
WORKDIR /opt/harnessstudio
RUN mkdir -p /var/lib/mock-seat && chown node:node /var/lib/mock-seat
COPY --from=build --chown=node:node /opt/harnessstudio/apps/mock-seat/lib/ ./apps/mock-seat/lib/
COPY --from=build --chown=node:node /opt/harnessstudio/scripts/container-entrypoint.mjs /opt/harnessstudio/scripts/container-healthcheck.mjs ./scripts/
ENV NODE_ENV=production STUDIO_MOCK_SEAT_ROOT=/var/lib/mock-seat STUDIO_MOCK_SEAT_HOST=0.0.0.0 STUDIO_MOCK_SEAT_PORT=8080 STUDIO_MOCK_SEAT_MAX_SEATS=16
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD ["node", "scripts/container-healthcheck.mjs", "mock-seat"]
ENTRYPOINT ["node", "scripts/container-entrypoint.mjs"]
CMD ["mock-seat"]
# Source version from bin/harnessstudio (docs/deploy-cli.md); last in the stage so the layers above stay cached.
ARG HARNESSSTUDIO_VERSION=unknown
LABEL org.harnessstudio.version=$HARNESSSTUDIO_VERSION

# sandbox_manager: starts one Linux sandbox container per conversation through the host's Docker socket.
FROM base AS sandbox-manager
WORKDIR /opt/harnessstudio
COPY --from=build /opt/harnessstudio/apps/sandbox-manager/lib/ ./apps/sandbox-manager/lib/
ENV NODE_ENV=production SANDBOX_PORT=8100
EXPOSE 8100
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["node", "-e", "require('node:net').connect(8100, '127.0.0.1').on('connect', () => process.exit(0)).on('error', () => process.exit(1))"]
CMD ["node", "apps/sandbox-manager/lib/cli.js"]
# Source version from bin/harnessstudio (docs/deploy-cli.md); last in the stage so the layers above stay cached.
ARG HARNESSSTUDIO_VERSION=unknown
LABEL org.harnessstudio.version=$HARNESSSTUDIO_VERSION

# The Agent's Linux sandbox: Python with common data, document and CAD-exchange libraries, and everyday tools.
FROM base AS sandbox
RUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::Retries=3 -o Acquire::https::Timeout=30 update \
    && apt-get -o Acquire::Retries=3 -o Acquire::https::Timeout=30 install -y --no-install-recommends \
       ca-certificates python3 python3-venv python3-pip curl wget git zip unzip p7zip-full xz-utils bzip2 jq ripgrep file less tree procps \
       imagemagick poppler-utils pandoc sqlite3 fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir --timeout 60 --retries 5 numpy pandas scipy matplotlib openpyxl xlsxwriter python-docx python-pptx pypdf pdfplumber \
       ezdxf trimesh requests beautifulsoup4 lxml pillow pyyaml
COPY deploy/sandbox/run.py /opt/harnessstudio/run.py
ENV PATH=/opt/venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin LANG=C.UTF-8 PYTHONIOENCODING=utf-8 MPLBACKEND=Agg PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /workspace
CMD ["sleep", "infinity"]
# Source version from bin/harnessstudio (docs/deploy-cli.md); last in the stage so the layers above stay cached.
ARG HARNESSSTUDIO_VERSION=unknown
LABEL org.harnessstudio.version=$HARNESSSTUDIO_VERSION

# The sandboxes' only way out: an HTTP(S) proxy that refuses the LAN, this host and private addresses.
FROM base AS sandbox-egress
RUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::Retries=3 -o Acquire::https::Timeout=30 update \
    && apt-get -o Acquire::Retries=3 -o Acquire::https::Timeout=30 install -y --no-install-recommends squid \
    && rm -rf /var/lib/apt/lists/*
COPY deploy/sandbox/squid.conf /etc/squid/squid.conf
# Started as its own user: squid that starts as root and then switches cannot reopen the container's stdout for logs.
USER proxy
EXPOSE 3128
CMD ["squid", "-N", "-f", "/etc/squid/squid.conf"]
# Source version from bin/harnessstudio (docs/deploy-cli.md); last in the stage so the layers above stay cached.
ARG HARNESSSTUDIO_VERSION=unknown
LABEL org.harnessstudio.version=$HARNESSSTUDIO_VERSION

# harnessstudio run: the batch client (cli/). Only Node and the client's own locked dependencies; it reaches Studio
# over HTTP. bin/harnessstudio runs it with --user of the caller and the working folder mounted at the same path.
FROM base AS cli
WORKDIR /opt/harnessstudio-cli
COPY cli/package.json cli/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY cli/bin/ ./bin/
COPY cli/src/ ./src/
ENV NODE_ENV=production
USER node
ENTRYPOINT ["node", "/opt/harnessstudio-cli/bin/harnessstudio.ts"]
# Source version from bin/harnessstudio (docs/deploy-cli.md); last in the stage so the layers above stay cached.
ARG HARNESSSTUDIO_VERSION=unknown
LABEL org.harnessstudio.version=$HARNESSSTUDIO_VERSION
