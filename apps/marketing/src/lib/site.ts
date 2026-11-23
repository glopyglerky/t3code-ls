export const GITHUB_REPOSITORY_URL = "https://github.com/pingdotgg/t3code";

export const IOS_APP_STORE_URL =
  "https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824";

export const ANDROID_PLAY_STORE_URL =
  "https://play.google.com/store/apps/details?id=com.t3tools.t3code";

// Runs at build time, so each deploy picks up the current count.
async function fetchGithubStars(): Promise<string | null> {
  const token = process.env.GITHUB_TOKEN;
  try {
    const response = await fetch("https://api.github.com/repos/pingdotgg/t3code", {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) throw new Error(`GitHub API responded ${response.status}`);
    const { stargazers_count: stars } = (await response.json()) as { stargazers_count: number };
    if (!Number.isSafeInteger(stars) || stars < 0) return null;
    return stars < 1000 ? String(stars) : `${Math.floor(stars / 1000)}k+`;
  } catch {
    return null;
  }
}

export const MARKETING_STATS = {
  githubStars: await fetchGithubStars(),
  users: "500,000",
} as const;
