#!/bin/sh
# 前置安装脚本 v4 (pnpm): profile manifest 安全，cordis 单实例
set -e
export DSH_HOME=/home/node/.dsh
P=/home/node/.dsh/profiles/web
SRC=/plugins-src
export PNPM_HOME=/home/node/.local/share/pnpm

echo "== 1. init clean web profile =="
rm -rf $P
dsh --profile web --dump-config > /dev/null 2>&1 || true

echo "== 2. pnpm add deps (manifest-safe) =="
corepack pnpm --dir $P add -w dsh-web-auth@0.1.0 @kubernetes/client-node 2>&1 | tail -1

echo "== 3. install @visecy/dsh-auth-oidc bundle =="
mkdir -p $P/node_modules/@visecy/dsh-auth-oidc
cp $SRC/dist/auth-oidc-plugin.js $P/node_modules/@visecy/dsh-auth-oidc/index.js
cat > $P/node_modules/@visecy/dsh-auth-oidc/package.json << 'EOF'
{
  "name": "@visecy/dsh-auth-oidc",
  "version": "0.1.0",
  "type": "module",
  "main": "index.js",
  "exports": { ".": "./index.js" }
}
EOF

echo "== 4. profile patch =="
cp $SRC/cordis.patch.yml $P/cordis.patch.yml

echo "== 5. verify manifest + config tree =="
python3 - << 'PY'
import json
d = json.load(open('/home/node/.dsh/profiles/web/package.json'))
print('bundles:', d.get('dsh', {}).get('profile', {}).get('bundles'))
print('deps:', d.get('dependencies'))
PY
dsh --profile web --dump-config 2>&1 | grep -cE "^- id:"
echo INSTALL_DONE
