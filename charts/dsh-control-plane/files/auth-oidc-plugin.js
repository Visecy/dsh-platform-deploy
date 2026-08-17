// packages/auth-oidc/src/plugin.ts
import z from "@deepseek-ai/schemastery";

// packages/auth-oidc/src/oidc-client.ts
import { createHash, randomBytes, createPublicKey } from "node:crypto";
var OidcClient = class {
  discovery;
  jwks;
  config;
  constructor(config) {
    this.config = config;
  }
  async getDiscovery() {
    if (this.discovery !== void 0) return this.discovery;
    const res = await fetch(this.config.discoveryUrl ?? this.config.issuer.replace(/\/$/, "") + "/.well-known/openid-configuration");
    if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status}`);
    this.discovery = await res.json();
    return this.discovery;
  }
  /** Build the authorize URL with PKCE; returns { url, verifier, state }. */
  async buildAuthorizeUrl() {
    const d = await this.getDiscovery();
    const verifier = base64url(randomBytes(32));
    const challenge = base64url(createHash("sha256").update(verifier).digest());
    const state = base64url(randomBytes(16));
    const params = new URLSearchParams({
      response_type: "code",
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      scope: (this.config.scopes ?? ["openid", "profile", "email"]).join(" "),
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      nonce: base64url(randomBytes(16))
    });
    for (const [k, v] of Object.entries(this.config.authorizeParams ?? {})) params.set(k, v);
    return { url: d.authorization_endpoint + "?" + params.toString(), verifier, state };
  }
  /** Exchange the authorization code (PKCE verifier) for tokens. */
  async exchangeCode(code, verifier) {
    const d = await this.getDiscovery();
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.config.redirectUri,
      client_id: this.config.clientId,
      code_verifier: verifier
    });
    if (this.config.clientSecret !== void 0) body.set("client_secret", this.config.clientSecret);
    const res = await fetch(d.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
    if (!res.ok) throw new Error(`token exchange failed: ${res.status} ${await res.text()}`);
    return await res.json();
  }
  /** Verify the ID token signature via JWKS and decode claims. */
  async verifyIdToken(idToken) {
    const [headerB64, payloadB64, sigB64] = idToken.split(".");
    if (headerB64 === void 0 || payloadB64 === void 0 || sigB64 === void 0) {
      throw new Error("malformed id_token");
    }
    const header = JSON.parse(base64urlDecode(headerB64));
    const d = await this.getDiscovery();
    if (this.jwks === void 0) {
      const res = await fetch(d.jwks_uri);
      if (!res.ok) throw new Error(`jwks fetch failed: ${res.status}`);
      this.jwks = await res.json();
    }
    const key = this.jwks.keys.find((k) => k.kid === header.kid);
    if (key === void 0) throw new Error("no matching jwk for id_token");
    const publicKey = createPublicKey({ key, format: "jwk" });
    const { verify } = await import("node:crypto");
    const valid = verify(null, Buffer.from(headerB64 + "." + payloadB64), publicKey, Buffer.from(sigB64, "base64url"));
    if (!valid) throw new Error("id_token signature verification failed");
    const claims = JSON.parse(base64urlDecode(payloadB64));
    if (claims.iss !== void 0 && claims.iss !== d.issuer && claims.iss !== this.config.issuer) {
      throw new Error("id_token issuer mismatch");
    }
    if (claims.aud !== void 0 && claims.aud !== this.config.clientId) {
      throw new Error("id_token audience mismatch");
    }
    return claims;
  }
  /** Fetch userinfo (fallback claims source). */
  async userinfo(accessToken) {
    const d = await this.getDiscovery();
    const res = await fetch(d.userinfo_endpoint, { headers: { authorization: `Bearer ${accessToken}` } });
    if (!res.ok) throw new Error(`userinfo failed: ${res.status}`);
    return await res.json();
  }
  /** Refresh an access token. */
  async refresh(refreshToken) {
    const d = await this.getDiscovery();
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: this.config.clientId
    });
    if (this.config.clientSecret !== void 0) body.set("client_secret", this.config.clientSecret);
    const res = await fetch(d.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
    if (!res.ok) throw new Error(`refresh failed: ${res.status}`);
    return await res.json();
  }
};
function base64url(buf) {
  return buf.toString("base64url");
}
function base64urlDecode(s) {
  return Buffer.from(s, "base64url").toString("utf8");
}

// packages/auth-oidc/src/session.ts
import { createHmac, timingSafeEqual } from "node:crypto";
var SessionCodec = class {
  secret;
  constructor(secret) {
    this.secret = Buffer.from(secret, "utf8");
  }
  encode(claims) {
    const payload = {
      ...claims,
      exp: claims.exp ?? Math.floor(Date.now() / 1e3) + 12 * 60 * 60
      // 12h default
    };
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const sig = this.sign(body);
    return body + "." + sig;
  }
  decode(token) {
    const dot = token.indexOf(".");
    if (dot === -1) return void 0;
    const body = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const expected = this.sign(body);
    if (!safeEqual(sig, expected)) return void 0;
    let claims;
    try {
      claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    } catch {
      return void 0;
    }
    if (claims.exp < Math.floor(Date.now() / 1e3)) return void 0;
    return claims;
  }
  sign(body) {
    return createHmac("sha256", this.secret).update(body).digest("base64url");
  }
};
function safeEqual(a, b) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

// packages/auth-oidc/src/webserver.ts
import { createServer } from "node:http";
var GateWebServer = class {
  exact = /* @__PURE__ */ new Map();
  prefixes = [];
  upgrades = /* @__PURE__ */ new Map();
  fallbackHandler;
  upgradeFallbackHandler;
  server;
  options;
  constructor(options = {}) {
    this.options = options;
  }
  register(route) {
    if (route.kind === "exact") {
      if (this.exact.has(route.path)) throw new Error(`duplicate exact route: ${route.path}`);
      this.exact.set(route.path, route);
    } else {
      if (this.prefixes.some((r) => r.path === route.path)) throw new Error(`duplicate prefix route: ${route.path}`);
      this.prefixes.push(route);
    }
    return () => {
      if (route.kind === "exact") this.exact.delete(route.path);
      else this.prefixes = this.prefixes.filter((r) => r !== route);
    };
  }
  registerUpgrade(route) {
    if (this.upgrades.has(route.path)) throw new Error(`duplicate upgrade route: ${route.path}`);
    this.upgrades.set(route.path, route);
    return () => {
      this.upgrades.delete(route.path);
    };
  }
  /** Upgrade fallback (proxy path) for upgrades matching no registered route. */
  registerUpgradeFallback(handler) {
    this.upgradeFallbackHandler = handler;
    return () => {
      this.upgradeFallbackHandler = void 0;
    };
  }
  registerFallback(handler) {
    if (this.fallbackHandler !== void 0) throw new Error("fallback already registered");
    this.fallbackHandler = handler;
    return () => {
      this.fallbackHandler = void 0;
    };
  }
  async listen(port = 0, host = "127.0.0.1") {
    const server = createServer((req, res) => void this.handle(req, res));
    server.on("upgrade", (req, socket, head) => {
      void this.handleUpgrade(req, socket, head);
    });
    this.server = server;
    await new Promise((resolve) => server.listen(port, host, () => resolve()));
    const addr = server.address();
    return typeof addr === "object" && addr !== null ? addr.port : port;
  }
  close() {
    return new Promise((resolve) => {
      if (this.server === void 0) return resolve();
      this.server.close(() => resolve());
      this.server.closeAllConnections();
    });
  }
  async handle(req, res) {
    try {
      if (this.options.gate !== void 0) {
        const verdict = await this.options.gate(req, res);
        if (verdict === "responded") return;
      }
      const pathname = pathOf(req);
      const exact = this.exact.get(pathname);
      if (exact !== void 0) return await exact.handler(req, res);
      const prefix = this.prefixes.find((r) => pathname.startsWith(r.path));
      if (prefix !== void 0) return await prefix.handler(req, res);
      if (this.fallbackHandler !== void 0) return await this.fallbackHandler(req, res);
      res.writeHead(404);
      res.end("not found");
    } catch (err) {
      res.writeHead(400);
      res.end(String(err));
    }
  }
  handleUpgrade(req, socket, head) {
    void (async () => {
      try {
        if (this.options.gate !== void 0) {
          const fakeRes = new ServerResponse(req);
          const verdict = await this.options.gate(req, fakeRes);
          if (verdict === "responded") {
            fakeRes.end();
            socket.destroy();
            return;
          }
        }
        const pathname = pathOf(req);
        const route = this.upgrades.get(pathname);
        if (route === void 0) {
          if (this.upgradeFallbackHandler !== void 0) {
            this.upgradeFallbackHandler(req, socket, head);
            return;
          }
          socket.destroy();
          return;
        }
        route.handler(req, socket, head);
      } catch {
        socket.destroy();
      }
    })();
  }
};
function pathOf(req) {
  return new URL(req.url ?? "/", "http://dsh.internal").pathname;
}

// packages/auth-oidc/src/index.ts
var AuthPlugin = class {
  oidc;
  sessions;
  server;
  pending = /* @__PURE__ */ new Map();
  baseUrl = "";
  cookieName;
  publicPaths;
  adminGroups;
  port;
  host;
  config;
  constructor(config) {
    this.config = config;
    this.oidc = new OidcClient(config.oidc);
    this.sessions = new SessionCodec(config.sessionSecret);
    this.cookieName = config.cookieName ?? "dsh_session";
    this.publicPaths = config.publicPaths ?? ["/healthz"];
    this.adminGroups = config.adminGroups ?? ["dsh-admins"];
    this.port = config.port ?? 0;
    this.host = config.host ?? "127.0.0.1";
    this.server = new GateWebServer({ gate: (req, res) => this.gate(req, res) });
    this.registerAuthRoutes();
  }
  async start() {
    const port = await this.server.listen(this.port, this.host);
    this.baseUrl = `http://127.0.0.1:${port}`;
    return this.baseUrl;
  }
  currentUser(req) {
    const cookie = readCookie(req, this.cookieName);
    if (cookie === void 0) return void 0;
    return this.sessions.decode(cookie);
  }
  async loginUrl() {
    const p = await this.oidc.buildAuthorizeUrl();
    this.pending.set(p.state, { verifier: p.verifier });
    if (this.pending.size > 1e3) {
      const oldest = this.pending.keys().next().value;
      if (oldest !== void 0) this.pending.delete(oldest);
    }
    return p.url;
  }
  async handleCallback(code, state) {
    const pending = this.pending.get(state);
    if (pending === void 0) throw new Error("unknown or expired login state");
    this.pending.delete(state);
    const tokens = await this.oidc.exchangeCode(code, pending.verifier);
    if (tokens.id_token === void 0) throw new Error("no id_token in token response");
    const claims = await this.oidc.verifyIdToken(tokens.id_token);
    const sub = String(claims.sub ?? "");
    if (sub === "") throw new Error("id_token missing sub");
    const groups = asGroups(claims);
    return {
      sub,
      email: claims.email,
      name: claims.name,
      groups,
      roles: groups.some((g) => this.adminGroups.includes(g)) ? ["user", "admin"] : ["user"],
      exp: Math.floor(Date.now() / 1e3) + 12 * 60 * 60
    };
  }
  logout(req, res) {
    res.setHeader("set-cookie", `${this.cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    res.writeHead(302, { location: "/" });
    res.end();
  }
  // ── gate ────────────────────────────────────────────────────────────────
  async gate(req, res) {
    const pathname = new URL(req.url ?? "/", "http://dsh.internal").pathname;
    if (pathname === "/auth/login" || pathname === "/auth/callback" || pathname === "/auth/logout") return "allow";
    if (this.publicPaths.some((p) => pathname === p || pathname.startsWith(p + "/"))) return "allow";
    const user = this.currentUser(req);
    if (user !== void 0) {
      res.setHeader("x-dsh-user", user.sub);
      return "allow";
    }
    if (req.headers.accept?.includes("text/html") === true || pathname === "/") {
      const url = await this.loginUrl();
      res.writeHead(302, { location: url });
      res.end();
      return "responded";
    }
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: { code: "UNAUTHENTICATED", message: "login required" } }));
    return "responded";
  }
  registerAuthRoutes() {
    this.server.register({
      kind: "exact",
      path: "/auth/login",
      handler: async (_req, res) => {
        const url = await this.loginUrl();
        res.writeHead(302, { location: url });
        res.end();
      }
    });
    this.server.register({
      kind: "exact",
      path: "/auth/callback",
      handler: async (req, res) => {
        const url = new URL(req.url ?? "/", "http://dsh.internal");
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        if (code === null || state === null) {
          res.writeHead(400);
          res.end("missing code or state");
          return;
        }
        try {
          const session = await this.handleCallback(code, state);
          const token = this.sessions.encode(session);
          res.setHeader("set-cookie", `${this.cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax`);
          res.writeHead(302, { location: "/" });
          res.end();
        } catch (e) {
          res.writeHead(400);
          res.end(`login failed: ${e.message}`);
        }
      }
    });
    this.server.register({
      kind: "exact",
      path: "/auth/logout",
      handler: (req, res) => {
        this.logout(req, res);
      }
    });
  }
  async close() {
    await this.server.close();
  }
};
function readCookie(req, name2) {
  const header = req.headers.cookie;
  if (header === void 0) return void 0;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name2) return rest.join("=");
  }
  return void 0;
}
function asGroups(claims) {
  const g = claims.groups;
  if (Array.isArray(g)) return g.map(String);
  if (typeof g === "string") return g.split(",").map((s) => s.trim()).filter(Boolean);
  return [];
}

// packages/auth-oidc/src/plugin.ts
var name = "@visecy/dsh-auth-oidc";
var Config = z.object({
  oidc: z.object({
    issuer: z.string().required(),
    clientId: z.string().required(),
    clientSecret: z.string(),
    redirectUri: z.string().required(),
    discoveryUrl: z.string(),
    scopes: z.array(z.string())
  }).required(),
  sessionSecret: z.string().required(),
  cookieName: z.string(),
  publicPaths: z.array(z.string()),
  adminGroups: z.array(z.string())
});
function apply(ctx, config) {
  const auth = new AuthPlugin(config);
  ctx.inject(["webServer"], (serverCtx) => {
    serverCtx.effect(() => serverCtx.webServer.register({
      kind: "exact",
      path: "/auth/login",
      handler: async (_req, res) => {
        const url = await auth.loginUrl();
        res.writeHead(302, { location: url });
        res.end();
      }
    }), "dsh-auth-oidc: /auth/login");
    serverCtx.effect(() => serverCtx.webServer.register({
      kind: "exact",
      path: "/auth/callback",
      handler: async (req, res) => {
        const url = new URL(req.url ?? "/", "http://dsh.internal");
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        if (code === null || state === null) {
          res.writeHead(400);
          res.end("missing code or state");
          return;
        }
        try {
          const session = await auth.handleCallback(code, state);
          const token = auth.sessions.encode(session);
          const cookieName = auth.config.cookieName ?? "dsh_session";
          res.setHeader("set-cookie", `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax`);
          res.writeHead(302, { location: "/" });
          res.end();
        } catch (e) {
          res.writeHead(400);
          res.end(`login failed: ${e.message}`);
        }
      }
    }), "dsh-auth-oidc: /auth/callback");
    serverCtx.effect(() => serverCtx.webServer.register({
      kind: "exact",
      path: "/auth/logout",
      handler: (req, res) => {
        auth.logout(req, res);
      }
    }), "dsh-auth-oidc: /auth/logout");
    const gate = async (req, res, kind) => {
      const pathname = new URL(req.url ?? "/", "http://dsh.internal").pathname;
      if (pathname === "/auth/login" || pathname === "/auth/callback" || pathname === "/auth/logout") return true;
      const publicPaths = auth.config.publicPaths ?? ["/healthz"];
      if (publicPaths.some((p) => pathname === p || pathname.startsWith(p + "/"))) return true;
      const user = auth.currentUser(req);
      if (user !== void 0) {
        res.setHeader("x-dsh-user", user.sub);
        return true;
      }
      if (kind === "upgrade" || pathname === "/api" || pathname.startsWith("/api/") || req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: { code: "UNAUTHENTICATED", message: "login required" } }));
        return false;
      }
      const url = await auth.loginUrl();
      res.writeHead(302, { location: url });
      res.end();
      return false;
    };
    serverCtx.effect(() => serverCtx.webServer.registerGate(gate), "dsh-auth-oidc: request gate");
  });
  ctx.provide("dshAuth", {
    currentUser: (req) => auth.currentUser(req)
  });
}
export {
  Config,
  apply,
  name
};
