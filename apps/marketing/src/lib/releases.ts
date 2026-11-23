const REPO = "pingdotgg/t3code";

export const RELEASES_URL = `https://github.com/${REPO}/releases`;
export const NIGHTLY_RELEASES_URL = `${RELEASES_URL}?q=nightly&expanded=true`;

const LATEST_API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
// GitHub's latest endpoint excludes prereleases; the newest nightly comes from the ordered release list.
const LIST_API_URL = `https://api.github.com/repos/${REPO}/releases?per_page=10`;

export type ReleaseChannel = "stable" | "nightly";

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

export interface Release {
  tag_name: string;
  html_url: string;
  published_at: string;
  assets: ReleaseAsset[];
}

const routePart = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,199}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function decodeRelease(value: unknown, channel: ReleaseChannel): Release | undefined {
  if (!isRecord(value)) return;
  const { tag_name, published_at, assets, draft, prerelease } = value;
  if (
    typeof tag_name !== "string" ||
    !routePart.test(tag_name) ||
    tag_name.includes("-nightly.") !== (channel === "nightly") ||
    draft === true ||
    (channel === "stable" && prerelease === true) ||
    typeof published_at !== "string" ||
    !Number.isFinite(Date.parse(published_at)) ||
    !Array.isArray(assets)
  ) return;

  const downloads: ReleaseAsset[] = [];
  for (const asset of assets) {
    if (!isRecord(asset) || typeof asset.name !== "string" || !routePart.test(asset.name)) continue;
    const url = `${RELEASES_URL}/download/${tag_name}/${asset.name}`;
    if (asset.browser_download_url === url) {
      downloads.push({ name: asset.name, browser_download_url: url });
    }
  }
  return { tag_name, html_url: `${RELEASES_URL}/tag/${tag_name}`, published_at, assets: downloads };
}

export async function fetchLatestRelease(channel: ReleaseChannel = "stable"): Promise<Release> {
  const key = `t3code-${channel}-release`;
  try {
    const cached = sessionStorage.getItem(key);
    const release = cached ? decodeRelease(JSON.parse(cached), channel) : undefined;
    if (release) return release;
  } catch {
    // Browsers may deny storage or retain malformed data from an earlier build.
  }

  const response = await fetch(channel === "nightly" ? LIST_API_URL : LATEST_API_URL);
  if (!response.ok) throw new Error(`GitHub API responded ${response.status}`);
  const body: unknown = await response.json();
  let release: Release | undefined;
  if (channel === "nightly") {
    for (const entry of Array.isArray(body) ? body : []) {
      release = decodeRelease(entry, channel);
      if (release) break;
    }
  } else {
    release = decodeRelease(body, channel);
  }
  if (!release) throw new Error(`No usable ${channel} release`);
  try {
    sessionStorage.setItem(key, JSON.stringify(release));
  } catch {
    // The current response is usable even without a cache write.
  }
  return release;
}
