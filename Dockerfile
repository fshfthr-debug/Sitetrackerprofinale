# syntax=docker/dockerfile:1
# One image: builds the React frontend, then serves it and the API from Express.
#
# This file lives at the repository root on purpose. The build context is the
# repository root, so every COPY below starts with sitetrackerpro-app/. That keeps
# the build identical on Render, locally and in CI, with no dockerContext setting
# to get wrong. (sitetrackerpro-app/deploy/Dockerfile is the same image for use
# from inside that folder, e.g. docker compose.)

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
FROM node:20-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY sitetrackerpro-app/backend/package.json sitetrackerpro-app/backend/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY sitetrackerpro-app/backend/ ./

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
