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
| `dsh-vs.yaml` | Istio VirtualService routing `dsh.svc.example.test` to the control-plane Service (sidecar port) |
| `login-test-pod.yaml` | Runs `login-test.mjs` in-cluster (`dsh-oidc-test` namespace, script from a `login-test` ConfigMap) |
| `login-test.mjs` | The flow itself: authorize → login form → `/oauth2/callback` → `_oauth2_proxy` cookie → gated API. Asserts the pinned oauth2-proxy v7.15.5 behaviour (401 only for JSON/AJAX-shaped unauthenticated requests, 302 to the IdP otherwise) |
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
   assertion.

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
