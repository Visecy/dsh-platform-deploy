#!/bin/sh
# 前置安装脚本 v5 (pnpm): profile manifest 安全，cordis 单实例
#
# 认证已外置到 oauth2-proxy sidecar（见本 chart 的 templates/deployment.yaml）：
# profile 只插入 @visecy/dsh-identity-bridge，官方 webserver 行保持原样。
# 已退役、不得再出现在本脚本里的东西：dsh-web-auth（webserver fork）、
# $SRC/dist/auth-oidc-plugin.js（@visecy/dsh-auth-oidc 的 gate bundle）。
set -e
export DSH_HOME=/home/node/.dsh
P=/home/node/.dsh/profiles/web
SRC=/plugins-src
export PNPM_HOME=/home/node/.local/share/pnpm

echo "== 1. init clean web profile =="
rm -rf $P
dsh --profile web --dump-config > /dev/null 2>&1 || true

echo "== 2. install @visecy/dsh-identity-bridge FROM THE CHECKOUT =="
# Only identity-bridge: it wires the sidecar's X-Forwarded-User/-Groups into
# ctx.dshAuth and owns the official `/` handoff. @kubernetes/client-node is the
# runtime dependency of the k8s plugins, which this rig's patch does not mount.
#
# Why not from npm: @visecy/dsh-identity-bridge is NOT published yet (the first
# publish of a new package cannot use npm Trusted Publishing, so it needs a
# one-time manual bootstrap -- see dsh-platform/.github/workflows/release.yml).
# `pnpm add @visecy/dsh-identity-bridge@latest` therefore fails with 404. Manifests
# for this rig must mount a dsh-platform checkout at $SRC (e.g. a git clone of
# https://github.com/Visecy/dsh-platform at the tag under test).
if [ ! -d "$SRC/dsh-platform/packages/identity-bridge" ]; then
  echo "FATAL: no dsh-platform checkout at $SRC/dsh-platform (mount one; see oidc-test/README.md)" >&2
  exit 1
fi
corepack pnpm --dir $P add -w "file:$SRC/dsh-platform/packages/identity-bridge" 2>&1 | tail -1

echo "== 3. profile patch =="
cp $SRC/cordis.patch.yml $P/cordis.patch.yml

echo "== 4. import check (dump-config 只组装配置，不 import 插件本体) =="
(cd $P && node --input-type=module -e \
  "const m = await import('@visecy/dsh-identity-bridge'); if (m.name !== '@visecy/dsh-identity-bridge') throw new Error('unexpected plugin name: ' + m.name); console.log('identity-bridge:', m.name, typeof m.apply === 'function' ? 'apply ok' : 'APPLY MISSING')")

echo "== 5. verify manifest + config tree =="
python3 - << 'PY'
import json
d = json.load(open('/home/node/.dsh/profiles/web/package.json'))
print('bundles:', d.get('dsh', {}).get('profile', {}).get('bundles'))
print('deps:', d.get('dependencies'))
PY
dsh --profile web --dump-config 2>&1 | grep -cE "^- id:"
echo INSTALL_DONE
