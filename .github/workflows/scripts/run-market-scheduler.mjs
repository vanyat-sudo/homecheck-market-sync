import { pathToFileURL } from "node:url";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function runMarketScheduler({
  baseUrl, getToken, request = fetch, delay = sleep,
  now = Date.now, maxDurationMs = 30 * 60_000, log = console.log,
}) {
  const base = new URL(baseUrl);
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash || base.pathname !== "/") {
    throw new Error("HOMECHECK_URL must be the HTTPS production origin, with no path or credentials.");
  }
  const prefix = `${base.origin}/api/market-tracker-scheduler`;
  const deadline = now() + maxDurationMs;
  const call = async (path, method = "GET") => {
    let failures = 0;
    while (now() < deadline) {
      try {
        const token = await getToken(prefix);
        const response = await request(`${prefix}${path}`, {
          method, headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
          redirect: "error", signal: AbortSignal.timeout(120_000),
        });
        if ([401, 403].includes(response.status)) throw Object.assign(new Error("GitHub identity rejected. Check the trusted repository, branch and audience in HomeCheck."), { fatal: true });
        if (response.status === 404) throw Object.assign(new Error("Scheduler endpoint or run not found. Publish the updated HomeCheck app before activating this workflow."), { fatal: true });
        if (response.ok && response.headers.get("content-type")?.includes("text/html")) {
          throw Object.assign(new Error("Scheduler received the website instead of its API. Publish the updated HomeCheck app and verify HOMECHECK_URL."), { fatal: true });
        }
        if (response.status === 409) {
          log("Another market sync owns the collection lease; waiting without starting a duplicate.");
          await delay(15_000);
          continue;
        }
        if (!response.ok) throw new Error(`Scheduler returned HTTP ${response.status}.`);
        // An empty/truncated response may follow a committed checkpoint.
        // Retry the same endpoint; start and step are both resumable/idempotent.
        return await response.json();
      } catch (error) {
        if (error.fatal || ++failures >= 8) throw error;
        log(`Temporary scheduler interruption; retry ${failures}/8.`);
        await delay(Math.min(5000 * failures, 30_000));
      }
    }
    throw new Error("Market sync exceeded the 30-minute runtime budget.");
  };
  await call("/health");
  const started = await call("/start", "POST");
  if (started.skipped && started.status === "complete") {
    log("Today's scheduled collection is already complete. No additional source requests made.");
    return started;
  }
  if (!Number.isInteger(started.runId) || started.runId <= 0) throw new Error("Scheduler did not return a valid collection ID.");
  const runId = started.runId;
  log(`Scheduled collection ${runId} started/resumed.`);
  while (now() < deadline) {
    const progress = await call(`/runs/${runId}/step`, "POST");
    if (progress.runId !== runId) throw new Error("Scheduler returned a different collection ID.");
    if (progress.status === "running") {
      await delay(progress.busy ? 3000 : 250);
      continue;
    }
    const final = await call(`/runs/${runId}`);
    log(JSON.stringify({ runId, status: final.status, requests: final.requests, credits: final.credits, scopes: final.scopes }));
    if (final.status !== "complete") throw new Error("Market collection was incomplete; last good data is preserved. See Tracker's coverage ledger.");
    return final;
  }
  throw new Error("Market sync exceeded the 30-minute runtime budget; saved progress is retained.");
}

async function githubToken(audience) {
  const endpoint = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const credential = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!endpoint || !credential) throw new Error("GitHub OIDC is unavailable. Grant this job id-token: write.");
  const url = new URL(endpoint);
  url.searchParams.set("audience", audience);
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${credential}` },
    redirect: "error", signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error("GitHub could not issue a short-lived identity token.");
  const result = await response.json();
  if (typeof result.value !== "string") throw new Error("GitHub did not issue an identity token.");
  // Mask immediately; never print bearer tokens or put them in URLs.
  console.log(`::add-mask::${result.value}`);
  return result.value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runMarketScheduler({ baseUrl: process.env.HOMECHECK_URL, getToken: githubToken }).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
