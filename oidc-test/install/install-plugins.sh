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
# 与 dsh-web-platform 镜像一致：插件版本跟随 PLUGIN_VERSION（未设置时 latest）
PLUGIN_VERSION="${PLUGIN_VERSION:-latest}"

echo "== 1. init clean web profile =="
rm -rf $P
dsh --profile web --dump-config > /dev/null 2>&1 || true

echo "== 2. pnpm add @visecy/dsh-identity-bridge@${PLUGIN_VERSION} =="
# 只有 identity-bridge：它把 sidecar 注入的 X-Forwarded-User/-Groups 接到
# ctx.dshAuth 并接管官方 `/` handoff。@kubernetes/client-node 是 k8s 系列插件
# 的运行期依赖，本 rig 的 patch 不装配它们，因此不再安装。
corepack pnpm --dir $P add -w "@visecy/dsh-identity-bridge@${PLUGIN_VERSION}" 2>&1 | tail -1

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
