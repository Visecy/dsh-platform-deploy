# oidc-test — end-to-end OIDC login rig (dev only)

A throwaway rig that proves the **sidecar** authentication path with a real IdP:
browser-less login against dex → `oauth2-proxy` session cookie → gated `/api`
proxied to `dsh web`. It is the manual counterpart to the platform repo's
`scripts/smoke-zero-patch.mjs`, which boots the same composition in-process.

**Not a deployment template.** Everything here is dev-only (test passwords,
`--cookie-secure=false`-style shortcuts, a static dex user). It is kept in-tree
because it is the only end-to-end proof of the login handoff, and because the
placeholder host names document the shape of the real setup.

## Files

| File | Purpose |
|---|---|
| `dex-config.yaml` | dex IdP: static client `dsh-platform` (secret `test-client-secret`), static user `admin@test.local` / `test-password` (bcrypt in the file), issuer + callback + host on `oidc-test.svc.example.test` / `dsh.svc.example.test` |
| `dsh-vs.yaml` | Istio VirtualService routing `dsh.svc.example.test` to the control-plane Service (sidecar port), root mode |
| `subpath-vs.yaml` | Istio VirtualService for subpath mode: strips `/<prefix>/` before the sidecar and 301s `/` + `/<prefix>` to `/<prefix>/` (mirrors the chart's prefix rendering) |
| `login-test-pod.yaml` | Runs `login-test.mjs` in-cluster (`dsh-oidc-test` namespace, script from a `login-test` ConfigMap) |
| `login-test.mjs` | The flow itself: authorize → login form → approval → `/oauth2/callback` → `_oauth2_proxy` cookie → launch-token handoff → `dsh-auth` cookie → app/assets/plugins/API/WebSocket. Asserts the pinned oauth2-proxy v7.15.5 behaviour (401 only for JSON/AJAX-shaped unauthenticated requests, 302 to the IdP otherwise) and in `DSH_PREFIX` mode the P2 subpath chain + B7 basepath assertions |
| `install/install-plugins.sh` | Builds a profile inside a pod: installs `@visecy/dsh-identity-bridge` **from a dsh-platform checkout** and copies `install/cordis.patch.yml` |
| `install/cordis.patch.yml` | The profile patch the rig applies (identity-bridge only; the official webserver row stays untouched) |
| `node_modules/` | **Not tracked** (bcryptjs for the dex password hash). Run `npm install` here if you need it |

## Host names are placeholders

`svc.example.test` is not a real domain and `.test` never resolves publicly: add
the names to `/etc/hosts` (or your local DNS) pointing at the gateway, e.g.

```
127.0.0.1  dsh.svc.example.test oidc-test.svc.example.test
```

## Running it

1. Create the `dsh-oidc-test` namespace and apply `dex-config.yaml`
   (`ghcr.io/dexidp/dex:v2.42.0`), then `dsh-vs.yaml` on a cluster whose Istio
   gateway matches the one in the chart values.
2. Put the login script in a ConfigMap named `login-test` and apply
   `login-test-pod.yaml`.
3. `kubectl -n dsh-oidc-test logs login-test` — it exits non-zero on a failed
   assertion and prints the PASS/FAIL matrix plus the full redirect table
   (status + Location + Set-Cookie per hop).

### Subpath mode (P2 e2e gate)

`login-test.mjs` takes `DSH_PREFIX` (no trailing slash, e.g. `/dsh`; empty = root
mode). Subpath mode verifies the P2 chain end to end and is the release gate for
risk **B7** (oauth2-proxy losing the basepath after login):

1. register **both** callbacks at the IdP for the transition period:
   `https://<host>/oauth2/callback` (root) and
   `https://<host>/<prefix>/oauth2/callback` (subpath; dex config
   `redirectURIs`);
2. run the control plane with `oauth2Proxy.publicOrigin=https://<host>/<prefix>`
   (the chart derives the prefixed redirect URL and `--cookie-path=/<prefix>/`
   from that single value; root mode renders byte-identically to the pre-P2
   chart);
3. expose it through `subpath-vs.yaml` (Istio) — the prefix must be stripped
   before dsh web, and `/` + `/<prefix>` must 301 to `/<prefix>/`;
4. run the pod with the extra env, e.g.

   ```
   DSH_URL=https://<host> DSH_PREFIX=/dsh \
   SIDECAR_URL=http://dsh-control-plane-dsh-control-plane.dsh-platform.svc.cluster.local:4180
   ```

   `SIDECAR_URL` enables the untrusted-Host fence control (the connection fence
   must answer 403 for a forged authority even behind the sidecar); it needs
   `Host`-header control, which the script does over raw `node:http`.

The key assertion is #12 "post-login browser lands under `/<prefix>/`": the
callback hop is recorded with its `Location` header, and **if oauth2-proxy drops
the basepath (`Location: /`), the script asserts the 301 (`M1`) restores
`/<prefix>/`** — that is the observed v7.15.5 behaviour (2026-10-20 P2 cluster
e2e: 31/31 assertions passed, B7 manifested and was recovered by M1). Without the
M1 301 the browser lands on `/` and the login chain dies there.

For the plugin-install path, run `install/install-plugins.sh` inside a pod that
has a dsh-platform checkout mounted at `/plugins-src/dsh-platform`, a `dsh` CLI,
and pnpm (the shipped control-plane image satisfies all three). The script fails
loudly when the checkout is missing:

```
FATAL: no dsh-platform checkout at /plugins-src/dsh-platform
```

`@visecy/dsh-identity-bridge` is deliberately not installed from npm: it is not
published yet (its first publish needs a one-time Trusted-Publishing bootstrap —
see `dsh-platform/.github/workflows/release.yml`). The same is true for the
image, which installs every platform plugin from its own checkout.
