#!/usr/bin/env bash
# dsh-platform smoke test (kind). Requires: kind, kubectl, helm, docker.
#
# Cluster prerequisites this script does NOT create (pre-existing, unrelated to
# the oauth2-proxy sidecar): the chart pins
# `imagePullSecrets: [ghcr-pull]` and reads DSH_PG_CONNECTION_STRING from secret
# `dsh-db`, so both must exist in the namespace before the pod can start.
#
# The OIDC sign-in flow is NOT exercised here: the issuer is a dummy and
# discovery is skipped (see below). This smoke test only proves that the chart
# installs and that the control-plane pod (dsh web + oauth2-proxy sidecar)
# reaches Ready.
set -euo pipefail

CLUSTER=dsh-platform
CTX=kind-${CLUSTER}
NS=dsh-platform

echo "==> creating kind cluster"
kind create cluster --name "$CLUSTER" --wait 120s 2>/dev/null || kind get kubeconfig --name "$CLUSTER" >/dev/null

echo "==> namespace"
kubectl --context "$CTX" create ns "$NS" --dry-run=client -o yaml | kubectl --context "$CTX" apply -f -

# oauth2-proxy requires the cookie secret to decode to exactly 16, 24 or 32
# bytes; anything else makes the sidecar exit at startup with
#   cookie_secret must be 16, 24, or 32 bytes to create an AES cipher
# and because the Service targets only the sidecar, that takes the whole
# control plane down. This dev value is 32 ASCII bytes by construction, and the
# length is asserted rather than eyeballed.
COOKIE_SECRET="dev-cookie-secret-0123456789abcd"
case "${#COOKIE_SECRET}" in
  16|24|32) ;;
  *) echo "FATAL: cookie secret must be 16/24/32 bytes, got ${#COOKIE_SECRET}" >&2; exit 1 ;;
esac

echo "==> secrets (dev values)"
kubectl --context "$CTX" create secret generic dsh-oidc -n "$NS" \
  --from-literal=oidc-client-secret=dev-secret \
  --from-literal=session-secret=dev-session-secret-0123456789abcdef \
  --dry-run=client -o yaml | kubectl --context "$CTX" apply -f -

kubectl --context "$CTX" create secret generic dsh-oauth2-proxy -n "$NS" \
  --from-literal=cookie-secret="$COOKIE_SECRET" \
  --dry-run=client -o yaml | kubectl --context "$CTX" apply -f -

echo "==> helm install dsh-control-plane (dummy issuer for smoke)"
# The dummy issuer serves no discovery document, and oauth2-proxy refuses to
# start without one:
#   ... error while discovery OIDC configuration: dial tcp 127.0.0.1:0: connect: connection refused
# --skip-oidc-discovery needs a JWKS URL to replace it; the URL is never fetched
# (the key set is built lazily at token verification, and no token is verified
# here), so an unreachable one is enough for the process to start and serve
# /ping, which is what the readiness probe and `helm --wait` need.
# --cookie-secure=false keeps the smoke session cookie usable over the plain
# HTTP of a port-forwarded kind install.
helm upgrade --install dsh-control-plane ./charts/dsh-control-plane -n "$NS" \
  --set auth.oidcIssuer="http://127.0.0.1:0" \
  --set auth.oidcClientId="smoke" \
  --set auth.redirectUri="http://localhost:3080/auth/callback" \
  --set auth.oidcClientSecretRef=dsh-oidc \
  --set auth.sessionSecretRef=dsh-oidc \
  --set oauth2Proxy.cookieSecretRef=dsh-oauth2-proxy \
  --set oauth2Proxy.cookieSecretKey=cookie-secret \
  --set oauth2Proxy.extraArgs[0]=--skip-oidc-discovery=true \
  --set oauth2Proxy.extraArgs[1]=--oidc-jwks-url=http://127.0.0.1:0/jwks \
  --set oauth2Proxy.extraArgs[2]=--cookie-secure=false \
  --wait

echo "==> workspace runtime config reference (not installed)"
helm template dsh-workspace ./charts/dsh-workspace >/dev/null

echo "==> done"
kubectl --context "$CTX" get pods -n "$NS"
