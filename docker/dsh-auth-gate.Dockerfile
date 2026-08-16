# OIDC auth gate image: runs the registerGate + proxy in front of dsh web.
# Node 24 runs TypeScript directly (type stripping).
FROM node:24-slim
WORKDIR /app
# build context: dsh-platform repo root
COPY packages/auth-oidc/package.json ./
COPY packages/auth-oidc/src ./src
RUN npm install --omit=dev --ignore-scripts 2>/dev/null || true
RUN useradd -u 1000 -m gate
USER 1000
EXPOSE 3080
ENV GATE_PORT=3080 GATE_UPSTREAM=http://127.0.0.1:3000
ENTRYPOINT ["node", "src/main.ts"]
