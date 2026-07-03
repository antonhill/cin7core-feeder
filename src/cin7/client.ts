export interface Cin7Credentials {
  accountId: string;
  applicationKey: string;
  baseUrl: string;
}

export interface Cin7TestResult {
  ok: boolean;
  status: number;
  message: string;
}

/**
 * Minimal read-only connectivity check: lists 1 product. Confirms the
 * account ID / application key headers and base URL actually authenticate
 * against a live Cin7 Core instance — see docs/cin7-api-findings.md for the
 * verified auth scheme and rate-limit behaviour (60/min, 503 on exceed).
 */
export async function testConnection(creds: Cin7Credentials): Promise<Cin7TestResult> {
  const url = `${creds.baseUrl.replace(/\/$/, "")}/Product?page=1&limit=1`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: {
        "api-auth-accountid": creds.accountId,
        "api-auth-applicationkey": creds.applicationKey,
        Accept: "application/json",
      },
    });
  } catch (e) {
    return { ok: false, status: 0, message: `Network error: ${e instanceof Error ? e.message : "unknown"}` };
  }

  if (response.status === 503) {
    return { ok: false, status: 503, message: "Rate limited (60 calls/min) — try again shortly." };
  }
  if (response.status === 403) {
    return { ok: false, status: 403, message: "Authentication failed — check the account ID and application key." };
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    return { ok: false, status: response.status, message: `Unexpected response: ${body.slice(0, 200)}` };
  }

  return { ok: true, status: response.status, message: "Connected successfully." };
}
