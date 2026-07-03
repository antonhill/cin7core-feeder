"use client";

import { useEffect, useState } from "react";

const ORG_ID_KEY = "cin7feeder.orgId";
const SECRET_KEY = "cin7feeder.secret";

/**
 * Shares the Organization ID + passphrase across pages so navigating between
 * Import and Settings doesn't mean retyping them every time. Org ID (not
 * sensitive, just an identifier) persists in localStorage; the passphrase
 * goes in sessionStorage instead, so it clears when the tab/browser closes
 * rather than sitting around indefinitely.
 */
export function useOrgSession() {
  const [orgId, setOrgIdState] = useState("");
  const [secret, setSecretState] = useState("");

  useEffect(() => {
    // Hydrating from browser-only storage necessarily happens post-mount —
    // reading it during the initial render would mismatch the server-rendered
    // (storage-less) markup. Justified exception to the "no setState in
    // effect" rule, which otherwise steers toward useSyncExternalStore
    // (overkill here: nothing outside this hook writes to these keys).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOrgIdState(localStorage.getItem(ORG_ID_KEY) ?? "");
    setSecretState(sessionStorage.getItem(SECRET_KEY) ?? "");
  }, []);

  function setOrgId(value: string) {
    setOrgIdState(value);
    localStorage.setItem(ORG_ID_KEY, value);
  }

  function setSecret(value: string) {
    setSecretState(value);
    sessionStorage.setItem(SECRET_KEY, value);
  }

  return { orgId, setOrgId, secret, setSecret };
}
