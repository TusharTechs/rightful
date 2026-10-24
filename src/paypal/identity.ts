/**
 * Log in with PayPal: the first signal behind "one verified human, one entry".
 *
 * Firsthand asks for the narrowest scopes that answer two questions: is this a verified PayPal
 * account, and which account is it. The payer ID never leaves the server; organizers see a
 * per-ballot pseudonym instead (see src/ballot/human.ts).
 */

import { SANDBOX_WEB, type PayPalClient } from "./client.ts";

export const HUMAN_SCOPES = ["openid", "https://uri.paypal.com/services/paypalattributes"];

export function loginUrl(options: { clientId: string; redirectUri: string; state: string; scopes?: string[] }): string {
  const url = new URL("/connect/", SANDBOX_WEB);
  url.searchParams.set("flowEntry", "static");
  url.searchParams.set("client_id", options.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", (options.scopes ?? HUMAN_SCOPES).join(" "));
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("state", options.state);
  return url.toString();
}

export type UserInfo = {
  user_id?: string;
  payer_id?: string;
  /** PayPal returns this as a boolean or the strings "true"/"false" depending on the account. */
  verified_account?: boolean | string;
  [attribute: string]: unknown;
};

export function getUserInfo(client: PayPalClient, userAccessToken: string): Promise<UserInfo> {
  return client.request<UserInfo>("GET", "/v1/identity/oauth2/userinfo", {
    query: { schema: "paypalv1.1" },
    bearer: userAccessToken,
  });
}

export function isVerified(info: UserInfo): boolean {
  return info.verified_account === true || info.verified_account === "true";
}
