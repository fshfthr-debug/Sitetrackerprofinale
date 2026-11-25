# syntax=docker/dockerfile:1
# One image: builds the React frontend, then serves it and the API from Express.
# Build from the project root:  docker build -f deploy/Dockerfile .

# ---------- stage 0: GNU LibreDWG (DWG -> DXF) ----------
# GPL-3.0, used only as the separate `dwg2dxf` program. See
# THIRD-PARTY-NOTICES-LIBREDWG.md for the pinned version and the source offer.
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
 && make install \
 && strip --strip-unneeded /usr/local/lib/libredwg.so.* /usr/local/bin/dwg2dxf \
 && LD_LIBRARY_PATH=/usr/local/lib dwg2dxf --version

# ---------- stage 1: build the React app ----------
FROM node:20-alpine AS frontend

WORKDIR /app

# Dependency layer first, so code changes do not reinstall packages.
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY frontend/ ./

# Empty value = the browser calls /api and /auth on the same origin it was loaded
# from. That is exactly what this image does (Express serves both).
ENV REACT_APP_API_URL=""
RUN npm run build

# ---------- stage 2: runtime ----------
FROM node:20-alpine AS runtime

ENV NODE_ENV=production
ENV DWG2DXF_PATH=/usr/local/bin/dwg2dxf
WORKDIR /app

COPY --from=libredwg /usr/local/bin/dwg2dxf /usr/local/bin/dwg2dxf
COPY --from=libredwg /usr/local/lib/libredwg.so* /usr/local/lib/
# musl searches /usr/local/lib by default; this makes it explicit for any base-image change.
ENV LD_LIBRARY_PATH=/usr/local/lib
RUN chmod 755 /usr/local/bin/dwg2dxf && LD_LIBRARY_PATH=/usr/local/lib dwg2dxf --version

COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY backend/ ./
COPY THIRD-PARTY-NOTICES-LIBREDWG.md ./THIRD-PARTY-NOTICES-LIBREDWG.md

# The backend already serves ./public as static files.
COPY --from=frontend /app/build ./public

# Uploaded BIM/take-off files are written to ./uploads — mount a volume here.
RUN mkdir -p uploads && chown node:node uploads

USER node
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3001/health || exit 1

CMD ["node", "backend-v3-enhanced.js"]
