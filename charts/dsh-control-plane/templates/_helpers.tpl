{{- define "dsh-control-plane.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "dsh-control-plane.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}

{{- define "dsh-control-plane.labels" -}}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
app.kubernetes.io/name: {{ include "dsh-control-plane.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/part-of: dsh-platform
{{- end }}

{{/*
dsh-control-plane.publicRoot -- the deployment's single external-URL truth.

Returns the normalized public root (no trailing slash), e.g.
  https://dsh.example.com          (root publishing; the default)
  https://dsh.example.com/dsh      (subpath publishing; one path segment)

Resolution order (first hit wins), unchanged from the origin-only era:
  1. oauth2Proxy.publicOrigin
  2. origin of oauth2Proxy.redirectUrl
  3. origin of auth.redirectUri
  4. https://<ingress.host>   when ingress.enabled
  5. https://<istio.host>     when istio.enabled

Only the explicit oauth2Proxy.publicOrigin may carry a path; the derived
sources are origins, so subpath publishing always states its root explicitly.
One trailing slash is trimmed first (the pre-subpath behavior), then the render
fails on anything that is not https?://host[/<one segment>][/] with no query,
fragment, credentials or whitespace; a trailing slash the form allows is
normalized away before the result is used. A wrong root is a login loop, so it
must never silently render.
*/}}
{{- define "dsh-control-plane.publicRoot" -}}
{{- $root := .Values.oauth2Proxy.publicOrigin | trimSuffix "/" -}}
{{- if not $root -}}
{{- range (list .Values.oauth2Proxy.redirectUrl .Values.auth.redirectUri) -}}
{{- if not $root -}}
{{- $parsed := urlParse . -}}
{{- if and $parsed.scheme $parsed.host -}}
{{- $root = printf "%s://%s" $parsed.scheme $parsed.host -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- if and (not $root) .Values.ingress.enabled .Values.ingress.host -}}
{{- $root = printf "https://%s" .Values.ingress.host -}}
{{- end -}}
{{- if and (not $root) .Values.istio.enabled .Values.istio.host -}}
{{- $root = printf "https://%s" .Values.istio.host -}}
{{- end -}}
{{- if $root -}}
{{- $parsed := urlParse $root -}}
{{- if $parsed.error -}}
{{- fail (printf "public root %q is not a valid URL (%s): expected https?://<host>[/<prefix>] (check oauth2Proxy.publicOrigin / oauth2Proxy.redirectUrl / auth.redirectUri / ingress.host / istio.host, e.g. https://dsh.example.com or https://dsh.example.com/dsh)" $root $parsed.error) -}}
{{- end -}}
{{- if regexMatch "[[:space:]]" $root -}}
{{- fail (printf "public root %q contains whitespace: expected https?://<host>[/<prefix>] with no spaces (check oauth2Proxy.publicOrigin / oauth2Proxy.redirectUrl / auth.redirectUri / ingress.host / istio.host)" $root) -}}
{{- end -}}
{{- if or (contains "?" $root) (contains "#" $root) (contains "@" $root) -}}
{{- fail (printf "public root %q must not contain a query string, fragment or credentials: expected https?://<host>[/<prefix>] (e.g. https://dsh.example.com or https://dsh.example.com/dsh)" $root) -}}
{{- end -}}
{{- if not (regexMatch "^https?://[^/]+(/[^/]+/?)?$" $root) -}}
{{- if regexMatch "^https?://[^/]+(/[^/]+){2,}" $root -}}
{{- fail (printf "public root %q has a multi-segment path: this chart supports a single path segment only (e.g. https://dsh.example.com/dsh, not https://dsh.example.com/a/b)" $root) -}}
{{- end -}}
{{- fail (printf "public root %q is not in the supported form https?://<host>[/<prefix>] (one optional single-segment prefix; no query, fragment, credentials or whitespace); check oauth2Proxy.publicOrigin / oauth2Proxy.redirectUrl / auth.redirectUri / ingress.host / istio.host, e.g. https://dsh.example.com or https://dsh.example.com/dsh" $root) -}}
{{- end -}}
{{- /* Normalize the trailing slash the form allows (HEAD trimmed one and
       rejected any path; subpath publishing additionally accepts /<prefix>/). */}}
{{- $root = trimSuffix "/" $root -}}
{{- end -}}
{{- $root -}}
{{- end -}}

{{/*
dsh-control-plane.mountPrefix -- path component of the public root.

Returns "" for root publishing (the default; every routing template keeps its
origin-era output) or "/dsh" for subpath publishing. All routing, callback and
cookie behavior is derived from this one value, never from a second setting.

Subpath renders fail fast when the deployment cannot actually work:
  * no ingress and no istio: nothing strips the prefix before dsh web, and the
    official token exchange only accepts path "/" (so the token exchange 401s);
  * ingress that is not nginx: v1's prefix stripping and root/bare-prefix 301
    use nginx-ingress annotations; other controllers need their own review;
  * user ingress annotations that already set rewrite-target/use-regex: the
    chart renders the prefix-correct values, two owners would drift;
  * an explicit oauth2Proxy.redirectUrl outside /<prefix>/oauth2/callback: the
    IdP would send the browser to a path this deployment does not serve.
*/}}
{{- define "dsh-control-plane.mountPrefix" -}}
{{- $root := include "dsh-control-plane.publicRoot" . -}}
{{- $prefix := "" -}}
{{- if $root -}}
{{- $parsed := urlParse $root -}}
{{- $path := $parsed.path | default "" -}}
{{- if $path -}}
{{- $prefix = trimSuffix "/" $path -}}
{{- end -}}
{{- end -}}
{{- if $prefix -}}
{{- if not (or .Values.ingress.enabled .Values.istio.enabled) -}}
{{- fail (printf "public root %q carries the path prefix %q but no routing layer is enabled: the prefix must be stripped before dsh web (its token exchange only accepts path /), so enable ingress.enabled=true (ingress.className=nginx) or istio.enabled=true" $root $prefix) -}}
{{- end -}}
{{- if .Values.ingress.enabled -}}
{{- if ne (.Values.ingress.className | default "") "nginx" -}}
{{- fail (printf "public root %q carries the path prefix %q, which requires ingress.className=nginx for the ingress path (got %q): v1 uses nginx-ingress use-regex/rewrite-target and permanent-redirect annotations; disable ingress and use istio.enabled for the Istio path" $root $prefix (.Values.ingress.className | default "")) -}}
{{- end -}}
{{- range $key, $value := .Values.ingress.annotations -}}
{{- if or (contains "rewrite-target" $key) (contains "use-regex" $key) -}}
{{- fail (printf "public root %q carries the path prefix %q, and ingress.annotations already sets %q: the chart renders prefix-correct nginx.ingress.kubernetes.io/rewrite-target and use-regex itself; remove the conflicting annotation" $root $prefix $key) -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- with .Values.oauth2Proxy.redirectUrl -}}
{{- $expectedPath := printf "%s/oauth2/callback" $prefix -}}
{{- $parsed := urlParse . -}}
{{- $path := $parsed.path | default "" -}}
{{- if ne $path $expectedPath -}}
{{- fail (printf "public root %q publishes under %q, so oauth2Proxy.redirectUrl must be the prefixed callback (expected path %q, got %q): set oauth2Proxy.redirectUrl=%s/oauth2/callback or leave it empty to derive it" $root $prefix $expectedPath $path $root) -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- $prefix -}}
{{- end -}}
