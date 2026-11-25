# syntax=docker/dockerfile:1
# One image: builds the React frontend, then serves it and the API from Express.
#
# This file lives at the repository root on purpose. The build context is the
# repository root, so every COPY below starts with sitetrackerpro-app/. That keeps
# the build identical on Render, locally and in CI, with no dockerContext setting
# to get wrong. (sitetrackerpro-app/deploy/Dockerfile is the same image for use
# from inside that folder, e.g. docker compose.)

# ---------- stage 0: GNU LibreDWG (DWG -> DXF) ----------
# LibreDWG is GPL-3.0. It is compiled here and used only as a separate command-line program
# (`dwg2dxf`), started by the API with a timeout and a memory cap; the application never links
# against it. See THIRD-PARTY-NOTICES-LIBREDWG.md for the licence, the exact version and the
# source offer that ships with the image.
#
# The version is pinned on purpose: a new upstream release is a deliberate change that needs the
# DXF reader in backend/dxf.js re-tested against real drawings.
ARG LIBREDWG_VERSION=0.13.3
FROM node:20-alpine AS libredwg
ARG LIBREDWG_VERSION
RUN apk add --no-cache build-base autoconf automake libtool pkgconf perl file xz wget
WORKDIR /src
RUN wget -q "https://ftp.gnu.org/gnu/libredwg/libredwg-${LIBREDWG_VERSION}.tar.xz" \
 && tar -xf "libredwg-${LIBREDWG_VERSION}.tar.xz" \
 && cd "libredwg-${LIBREDWG_VERSION}" \
 && ./configure --prefix=/usr/local --disable-bindings --disable-python \
 && make -j"$(nproc)" \
 && make install DESTDIR=/out \
 && /out/usr/local/bin/dwg2dxf --version

# ---------- stage 1: build the React app ----------
FROM node:20-alpine AS frontend

WORKDIR /app

# Dependency layer first, so code changes do not reinstall packages.
COPY sitetrackerpro-app/frontend/package.json sitetrackerpro-app/frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY sitetrackerpro-app/frontend/ ./

# Empty value = the browser calls /api and /auth on the same origin it was loaded
# from. That is exactly what this image does (Express serves both).
ENV REACT_APP_API_URL=""
RUN npm run build

# ---------- stage 2: runtime ----------
FROM node:20-alpine AS runtime

ENV NODE_ENV=production
ENV DWG2DXF_PATH=/usr/local/bin/dwg2dxf
WORKDIR /app

# Only the converter and its shared library cross the stage boundary: no compiler, no headers,
# no build tooling in the image that serves traffic. musl looks in /usr/local/lib by default.
COPY --from=libredwg /out/usr/local/bin/dwg2dxf /usr/local/bin/dwg2dxf
COPY --from=libredwg /out/usr/local/lib/libredwg.so* /usr/local/lib/
RUN chmod 755 /usr/local/bin/dwg2dxf

COPY sitetrackerpro-app/backend/package.json sitetrackerpro-app/backend/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY sitetrackerpro-app/backend/ ./

# The licence notice and the source offer travel with the image, next to the code that uses it.
COPY sitetrackerpro-app/THIRD-PARTY-NOTICES-LIBREDWG.md ./THIRD-PARTY-NOTICES-LIBREDWG.md

# The backend already serves ./public as static files.
COPY --from=frontend /app/build ./public

# Uploaded BIM/take-off files are written to ./uploads — mount a volume here.
RUN mkdir -p uploads && chown node:node uploads

USER node
EXPOSE 3001

# Shell form on purpose: ${PORT} is expanded at runtime, so the image also works on
# hosts that assign their own port (Render uses 10000, Fly uses 8080, compose 3001).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-3001}/health" || exit 1

CMD ["node", "backend-v3-enhanced.js"]
