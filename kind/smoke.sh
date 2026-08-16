#!/usr/bin/env bash
# dsh-platform smoke test (kind). Requires: kind, kubectl, helm, docker.
set -euo pipefail

CLUSTER=dsh-platform
CTX=kind-${CLUSTER}
NS=dsh-platform

echo "==> creating kind cluster"
kind create cluster --name "$CLUSTER" --wait 120s 2>/dev/null || kind get kubeconfig --name "$CLUSTER" >/dev/null

echo "==> namespace"
kubectl --context "$CTX" create ns "$NS" --dry-run=client -o yaml | kubectl --context "$CTX" apply -f -

echo "==> secrets (dev values)"
kubectl --context "$CTX" create secret generic dsh-oidc -n "$NS" \
  --from-literal=oidc-client-secret=dev-secret \
  --from-literal=session-secret=dev-session-secret-0123456789abcdef \
  --dry-run=client -o yaml | kubectl --context "$CTX" apply -f -

echo "==> helm install dsh-control-plane (dummy issuer for smoke)"
helm upgrade --install dsh-control-plane ./charts/dsh-control-plane -n "$NS" \
  --set auth.oidcIssuer="http://127.0.0.1:0" \
  --set auth.oidcClientId="smoke" \
  --set auth.redirectUri="http://localhost:3080/auth/callback" \
  --set auth.oidcClientSecretRef=dsh-oidc \
  --set auth.sessionSecretRef=dsh-oidc \
  --wait

echo "==> workspace runtime config reference (not installed)"
helm template dsh-workspace ./charts/dsh-workspace >/dev/null

echo "==> done"
kubectl --context "$CTX" get pods -n "$NS"
