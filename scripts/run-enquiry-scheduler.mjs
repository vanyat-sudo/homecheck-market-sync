import { pathToFileURL } from "node:url";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Calls HomeCheck once to check Gmail, refresh stale listing prices and send
 * waiting enquiry replies. Only configuration problems or an unreachable app fail
 * the workflow; partial issues (e.g. one listing refresh) are reported as warnings.
 */
export async function runEnquiryScheduler({ baseUrl, getToken, request = fetch, delay = sleep, log = console.log, warn = console.warn }) {
  const base = new URL(baseUrl);
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash || base.pathname !== "/") {
    throw new Error("HOMECHECK_URL must be the HTTPS production origin, with no path or credentials.");
  }
  const audience = `${base.origin}/api/enquiry-scheduler`;
  let failures = 0;
  for (;;) {
    try {
      const token = await getToken(audience);
      const response = await request(`${audience}/run`, {
        method: "POST", headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        redirect: "error", signal: AbortSignal.timeout(240_000),
      });
      if ([401, 403].includes(response.status)) throw Object.assign(new Error("GitHub identity rejected. Check the trusted repository, branch and workflow file in HomeCheck."), { fatal: true });
      if (response.status === 404) throw Object.assign(new Error("Enquiry scheduler endpoint not found. Publish the updated HomeCheck app."), { fatal: true });
      if (response.ok && response.headers.get("content-type")?.includes("text/html")) {
        throw Object.assign(new Error("Scheduler received the website instead of its API. Publish the updated HomeCheck app and verify HOMECHECK_URL."), { fatal: true });
      }
      if (!response.ok) throw new Error(`Scheduler returned HTTP ${response.status}.`);
      const result = await response.json();
      log(JSON.stringify({ ok: result.ok, listingsRefreshed: result.listingsRefreshed, pendingReplies: result.pendingReplies }));
      for (const message of result.errors || []) warn(`::warning::${message}`);
      return result;
    } catch (error) {
      // Each run is safe to repeat: replies are leased and never resent after submission.
      if (error.fatal || ++failures >= 3) throw error;
      log(`Temporary scheduler interruption; retry ${failures}/3.`);
      await delay(10_000 * failures);
    }
  }
}

async function githubToken(audience) {
  const endpoint = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const credential = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!endpoint || !credential) throw new Error("GitHub OIDC is unavailable. Grant this job id-token: write.");
  const url = new URL(endpoint);
  url.searchParams.set("audience", audience);
  const response = await fetch(url, { headers: { Authorization: `Bearer ${credential}` }, redirect: "error", signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error("GitHub could not issue a short-lived identity token.");
  const result = await response.json();
  if (typeof result.value !== "string") throw new Error("GitHub did not issue an identity token.");
  // Mask immediately; never print bearer tokens or put them in URLs.
  console.log(`::add-mask::${result.value}`);
  return result.value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runEnquiryScheduler({ baseUrl: process.env.HOMECHECK_URL, getToken: githubToken }).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
