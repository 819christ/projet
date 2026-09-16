import fetch from "node-fetch";
import { logger } from "./logger";

const API_BASE = "https://api.github.com";

function authHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "vscode-auto-push-extension",
  };
}

/**
 * Retourne les infos du site GitHub Pages d'un dépôt, ou null si Pages n'est pas activé.
 */
export async function getPagesInfo(
  token: string,
  owner: string,
  repo: string
): Promise<{ url: string } | null> {
  const res = await fetch(`${API_BASE}/repos/${owner}/${repo}/pages`, {
    headers: authHeaders(token),
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub Pages API error (HTTP ${res.status}): ${body}`);
  }
  const data = (await res.json()) as Record<string, unknown>;
  const htmlUrl = typeof data.html_url === "string" ? data.html_url : undefined;
  return { url: htmlUrl || `https://${owner}.github.io/${repo}/` };
}

/**
 * Active GitHub Pages sur le dépôt (branche donnée, dossier /docs).
 * Retourne l'URL du site public.
 * Note : la page peut mettre 1-2 minutes à être accessible après activation.
 */
export async function enablePages(
  token: string,
  owner: string,
  repo: string,
  branch: string
): Promise<string> {
  logger.info(
    `Activation de GitHub Pages pour ${owner}/${repo} (branche ${branch}, dossier /docs)...`
  );
  const res = await fetch(`${API_BASE}/repos/${owner}/${repo}/pages`, {
    method: "POST",
    headers: {
      ...authHeaders(token),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ source: { branch, path: "/docs" } }),
  });

  if (res.status === 201 || res.status === 200) {
    const data = (await res.json()) as Record<string, unknown>;
    const htmlUrl = typeof data.html_url === "string" ? data.html_url : undefined;
    const url = htmlUrl || `https://${owner}.github.io/${repo}/`;
    logger.info(`GitHub Pages activé : ${url}`);
    return url;
  }

  // 409 = déjà activé
  if (res.status === 409) {
    logger.info("GitHub Pages déjà activé — récupération de l'URL existante.");
    const info = await getPagesInfo(token, owner, repo);
    return info?.url || `https://${owner}.github.io/${repo}/`;
  }

  const body = await res.text();
  throw new Error(`Échec d'activation GitHub Pages (HTTP ${res.status}): ${body}`);
}
