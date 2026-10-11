#!/usr/bin/env bash
# Smoke test for the workspace sandbox daemon (deployed by workspace-smoke.yaml).
# Run INSIDE the cluster, from a pod that can reach the daemon:
#   kubectl exec -it <pod> -- bash /tmp/daemon-smoke.sh
#
# Request/response shapes are the ones packages/sandbox-daemon/src/index.ts
# actually serves; keep them in sync when the daemon's routes change.
set -u
DAEMON="${DAEMON:-dsh-ws-smoke-svc.dsh-platform.svc.cluster.local:4390}"
BASE="http://$DAEMON"
pass=0; fail=0
ok() { pass=$((pass+1)); echo "PASS: $1"; }
bad() { fail=$((fail+1)); echo "FAIL: $1"; }
post() { curl -s -X POST -H 'content-type: application/json' -d "$2" "$BASE$1"; }
jget() { python3 -c "import json,sys;d=json.load(sys.stdin);print(eval('d'+sys.argv[1]))" "$2" 2>/dev/null; }

# 1. healthz
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/healthz")
[ "$code" = "200" ] && ok "healthz 200" || bad "healthz got $code"

# 2. files/write + files/read roundtrip (content is BASE64 on the wire)
CONTENT="hello from smoke test"
B64=$(printf '%s' "$CONTENT" | base64 | tr -d '\n')
out=$(post /files/write "{\"path\":\"smoke.txt\",\"content\":\"$B64\"}")
echo "$out" | grep -q '"operation"' && ok "files/write" || bad "files/write: $out"
out=$(post /files/read '{"path":"smoke.txt"}')
roundtrip=$(echo "$out" | jget x '.data.bytes' | base64 -d 2>/dev/null)
[ "$roundtrip" = "$CONTENT" ] && ok "files/read roundtrip" || bad "files/read: $out"

# 3. files/info + list
info=$(post /files/info '{"path":"smoke.txt"}')
echo "$info" | grep -q '"size"' && ok "files/info size" || bad "files/info: $info"
list=$(post /files/list '{"path":"/"}')
echo "$list" | grep -q smoke.txt && ok "files/list contains smoke.txt" || bad "files/list: $list"

# 4. commands/run is ASYNC: it returns a handle, output and exit come from
#    /commands/<cmdId>/output and /commands/<cmdId>/status.
run=$(post /commands/run '{"spec":{"argv":["bash","-lc","echo daemon-ok; exit 7"],"cwd":"/"}}')
cmdId=$(echo "$run" | jget x '.data.cmdId')
[ -n "$cmdId" ] && ok "commands/run handle cmdId=$cmdId" || bad "commands/run: $run"
sleep 1
out=$(curl -s "$BASE/commands/$cmdId/output?stream=stdout&from=0")
echo "$out" | grep -q "daemon-ok" && ok "commands/run stdout" || bad "commands/run stdout: $out"
status=$(curl -s "$BASE/commands/$cmdId/status")
echo "$status" | grep -q '"phase": *"exited"' && ok "commands/run exited" || bad "commands/run status: $status"
echo "$status" | grep -q '"exitCode": *7' && ok "commands/run exitCode 7" || bad "commands/run exit: $status"

# 5. resolve-executable
rex=$(post /commands/resolve-executable '{"command":"bash"}')
echo "$rex" | grep -q '/bash' && ok "resolve-executable bash" || bad "resolve: $rex"

# 6. pty spawn + kill (create takes {spec: PtySpec})
pty=$(post /ptys '{"spec":{"argv":["bash"],"cwd":"/","rows":24,"cols":80}}')
ptyId=$(echo "$pty" | jget x '.data.ptyId')
[ -n "$ptyId" ] && ok "pty spawn id=$ptyId" || bad "pty spawn: $pty"
res=$(post "/ptys/$ptyId/terminate" '{"graceMs":2000}')
echo "$res" | grep -q '"phase"' && ok "pty terminate" || bad "pty terminate: $res"

# 7. no commands left behind
left=$(curl -s "$BASE/commands")
echo "$left" | grep -q "$cmdId" && bad "command $cmdId still listed" || ok "command list drained"

echo
echo "RESULT: $pass passed, $fail failed"
[ "$fail" = "0" ]
