/**
 * Minimal OAuth 2.1 authorization server for the courier-tracking-api MCP
 * endpoint. ChatGPT's MCP custom-connector dialog requires this (it calls
 * Dynamic Client Registration + the OAuth metadata endpoints before it will
 * talk to the MCP server).
 *
 * Single-tenant: the "user" is whoever holds `MCP_AUTH_TOKEN`.
 * Storage is in-memory: if the Fly machine restarts, clients will re-prompt.
 */

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { Request, RequestHandler, Response } from "express";
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
  InvalidGrantError,
  InvalidRequestError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";

const ACCESS_TTL_SEC = 3600;
const REFRESH_TTL_SEC = 30 * 24 * 3600;
const CODE_TTL_SEC = 5 * 60;
const PENDING_TTL_SEC = 10 * 60;

interface PendingAuth {
  client: OAuthClientInformationFull;
  params: AuthorizationParams;
  expiresAt: number;
}

interface CodeRecord {
  client: OAuthClientInformationFull;
  params: AuthorizationParams;
  expiresAt: number;
}

interface AccessRecord {
  type: "access";
  clientId: string;
  scopes: string[];
  expiresAt: number;
  resource?: URL;
}

interface RefreshRecord {
  type: "refresh";
  clientId: string;
  scopes: string[];
  expiresAt: number;
  resource?: URL;
}

type TokenRecord = AccessRecord | RefreshRecord;

class InMemoryClientsStore implements OAuthRegisteredClientsStore {
  private clients = new Map<string, OAuthClientInformationFull>();

  async getClient(id: string): Promise<OAuthClientInformationFull | undefined> {
    return this.clients.get(id);
  }

  async registerClient(
    meta: OAuthClientInformationFull,
  ): Promise<OAuthClientInformationFull> {
    this.clients.set(meta.client_id, meta);
    return meta;
  }
}

function timingSafeEq(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return c;
    }
  });
}

export class CourierMcpOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore = new InMemoryClientsStore();

  private readonly pending = new Map<string, PendingAuth>();
  private readonly codes = new Map<string, CodeRecord>();
  private readonly tokens = new Map<string, TokenRecord>();

  constructor(private readonly adminToken: string) {}

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    if (!client.redirect_uris.includes(params.redirectUri)) {
      throw new InvalidRequestError("Unregistered redirect_uri");
    }

    this.gcExpired();

    const pendingId = randomUUID();
    this.pending.set(pendingId, {
      client,
      params,
      expiresAt: Date.now() + PENDING_TTL_SEC * 1000,
    });

    res.set("content-type", "text/html; charset=utf-8");
    res.status(200).send(this.loginPage(pendingId, client));
  }

  approveHandler: RequestHandler = (req: Request, res: Response): void => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const pendingId = typeof body.pending_id === "string" ? body.pending_id : "";
    const adminToken = typeof body.admin_token === "string" ? body.admin_token : "";

    if (!pendingId || !adminToken) {
      res.status(400).send("Missing pending_id or admin_token");
      return;
    }

    const pending = this.pending.get(pendingId);
    if (!pending || pending.expiresAt < Date.now()) {
      this.pending.delete(pendingId);
      res.status(400).send("Authorization request expired — try again.");
      return;
    }

    if (!timingSafeEq(adminToken, this.adminToken)) {
      res.set("content-type", "text/html; charset=utf-8");
      res.status(200).send(this.loginPage(pendingId, pending.client, true));
      return;
    }

    this.pending.delete(pendingId);

    const code = randomUUID();
    this.codes.set(code, {
      client: pending.client,
      params: pending.params,
      expiresAt: Date.now() + CODE_TTL_SEC * 1000,
    });

    const redirect = new URL(pending.params.redirectUri);
    redirect.searchParams.set("code", code);
    if (pending.params.state) redirect.searchParams.set("state", pending.params.state);

    res.redirect(302, redirect.toString());
  };

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const rec = this.codes.get(authorizationCode);
    if (!rec || rec.expiresAt < Date.now()) {
      throw new InvalidGrantError("Authorization code expired or invalid");
    }
    if (rec.client.client_id !== client.client_id) {
      throw new InvalidGrantError("Client mismatch");
    }
    return rec.params.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<OAuthTokens> {
    const rec = this.codes.get(authorizationCode);
    this.codes.delete(authorizationCode);

    if (!rec || rec.expiresAt < Date.now()) {
      throw new InvalidGrantError("Authorization code expired or invalid");
    }
    if (rec.client.client_id !== client.client_id) {
      throw new InvalidGrantError("Client mismatch");
    }

    return this.issueTokens(client.client_id, rec.params.scopes ?? ["mcp:tools"]);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
  ): Promise<OAuthTokens> {
    const rec = this.tokens.get(refreshToken);
    if (!rec || rec.type !== "refresh" || rec.expiresAt < Date.now()) {
      this.tokens.delete(refreshToken);
      throw new InvalidGrantError("Refresh token expired or invalid");
    }
    if (rec.clientId !== client.client_id) {
      throw new InvalidGrantError("Client mismatch");
    }

    this.tokens.delete(refreshToken);
    return this.issueTokens(client.client_id, rec.scopes);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const rec = this.tokens.get(token);
    if (!rec || rec.type !== "access") throw new InvalidTokenError("Unknown access token");
    if (rec.expiresAt < Date.now()) {
      this.tokens.delete(token);
      throw new InvalidTokenError("Access token expired");
    }
    return {
      token,
      clientId: rec.clientId,
      scopes: rec.scopes,
      expiresAt: Math.floor(rec.expiresAt / 1000),
    };
  }

  isAdminToken(token: string): boolean {
    return timingSafeEq(token, this.adminToken);
  }

  private issueTokens(clientId: string, scopes: string[]): OAuthTokens {
    const accessToken = randomUUID();
    const refreshToken = randomUUID();
    const now = Date.now();

    this.tokens.set(accessToken, {
      type: "access",
      clientId,
      scopes,
      expiresAt: now + ACCESS_TTL_SEC * 1000,
    });
    this.tokens.set(refreshToken, {
      type: "refresh",
      clientId,
      scopes,
      expiresAt: now + REFRESH_TTL_SEC * 1000,
    });

    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: ACCESS_TTL_SEC,
      refresh_token: refreshToken,
      scope: scopes.join(" "),
    };
  }

  private gcExpired(): void {
    const now = Date.now();
    for (const [k, v] of this.pending) if (v.expiresAt < now) this.pending.delete(k);
    for (const [k, v] of this.codes) if (v.expiresAt < now) this.codes.delete(k);
    for (const [k, v] of this.tokens) if (v.expiresAt < now) this.tokens.delete(k);
  }

  private loginPage(
    pendingId: string,
    client: OAuthClientInformationFull,
    wrongPassword = false,
  ): string {
    const name = escapeHtml(client.client_name ?? client.client_id);
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Courier Tracking MCP — Authorize</title>
<style>
  body{font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f5f5f5}
  .card{background:#fff;padding:2rem;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.1);max-width:380px;width:100%}
  h1{font-size:1.25rem;margin:0 0 .5rem}
  p{color:#555;font-size:.9rem;margin:0 0 1.25rem}
  label{display:block;font-size:.85rem;margin-bottom:.35rem;font-weight:500}
  input[type=password]{width:100%;padding:.55rem;border:1px solid #ccc;border-radius:4px;font-size:.95rem;box-sizing:border-box}
  button{margin-top:1rem;width:100%;padding:.6rem;background:#4f46e5;color:#fff;border:none;border-radius:4px;font-size:1rem;cursor:pointer}
  button:hover{background:#4338ca}
  .err{color:#dc2626;font-size:.85rem;margin-top:.5rem}
</style></head><body>
<div class="card">
  <h1>Authorize ${name}</h1>
  <p>Enter your <strong>MCP_AUTH_TOKEN</strong> to grant access.</p>
  <form method="POST" action="/oauth/approve">
    <input type="hidden" name="pending_id" value="${escapeHtml(pendingId)}">
    <label for="admin_token">Admin token</label>
    <input type="password" id="admin_token" name="admin_token" required autofocus>
    ${wrongPassword ? '<p class="err">Wrong token — try again.</p>' : ""}
    <button type="submit">Authorize</button>
  </form>
</div></body></html>`;
  }
}
