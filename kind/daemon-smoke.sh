#!/usr/bin/env bash
# Smoke test for the workspace sandbox daemon (deployed by workspace-smoke.yaml).
# Run inside the cluster (control plane pod or any pod in dsh-platform).
# Usage: kubectl exec -it <pod> -- bash /tmp/daemon-smoke.sh
set -u
DAEMON="${DAEMON:-dsh-ws-smoke-svc.dsh-platform.svc.cluster.local:4390}"
BASE="http://$DAEMON"
pass=0; fail=0
ok() { pass=$((pass+1)); echo "PASS: $1"; }
bad() { fail=$((fail+1)); echo "FAIL: $1"; }

# 1. healthz
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/healthz")
[ "$code" = "200" ] && ok "healthz 200" || bad "healthz got $code"

# 2. files/write + files/read roundtrip
body='{"path":"smoke.txt","content":"hello from smoke test","version":null}'
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d "$body" "$BASE/files/write")
[ "$code" = "200" ] && ok "files/write 200" || bad "files/write got $code"
out=$(curl -s -X POST -H 'content-type: application/json' -d '{"path":"smoke.txt"}' "$BASE/files/read")
echo "$out" | grep -q "hello from smoke test" && ok "files/read roundtrip" || bad "files/read got: $out"

# 3. files/info + list
info=$(curl -s -X POST -H 'content-type: application/json' -d '{"path":"smoke.txt"}' "$BASE/files/info")
echo "$info" | grep -q '"size":' && ok "files/info size" || bad "files/info: $info"
list=$(curl -s -X POST -H 'content-type: application/json' -d '{"path":"/"}' "$BASE/files/list")
echo "$list" | grep -q smoke.txt && ok "files/list contains smoke.txt" || bad "files/list: $list"

# 4. commands/run (echo + exit code)
run=$(curl -s -X POST -H 'content-type: application/json' -d '{"command":"echo daemon-ok && exit 7","cwd":"/workspace"}' "$BASE/commands/run")
echo "$run" | grep -q daemon-ok && ok "commands/run output" || bad "commands/run: $run"
echo "$run" | grep -q '"exitCode":7' && ok "commands/run exitCode 7" || bad "commands/run exit: $run"

# 5. resolve-executable
rex=$(curl -s -X POST -H 'content-type: application/json' -d '{"command":"bash"}' "$BASE/commands/resolve-executable")
echo "$rex" | grep -q '/bash' && ok "resolve-executable bash" || bad "resolve: $rex"

# 6. pty spawn + resize + kill
pty=$(curl -s -X POST -H 'content-type: application/json' -d '{"command":"bash","cwd":"/workspace","cols":80,"rows":24}' "$BASE/ptys")
pid=$(echo "$pty" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("pid",""))' 2>/dev/null)
[ -n "$pid" ] && ok "pty spawn pid=$pid" || bad "pty spawn: $pty"
code=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$BASE/ptys/$pid")
[ "$code" = "200" ] && ok "pty kill 200" || bad "pty kill got $code"

# 7. command isolation: terminated process group gone
sleep 2
pids=$(curl -s "$BASE/commands")
echo "$pids" | grep -q "$pid" && bad "pty pid $pid still listed" || ok "process group cleaned"

echo
echo "RESULT: $pass passed, $fail failed"
[ "$fail" = "0" ]
