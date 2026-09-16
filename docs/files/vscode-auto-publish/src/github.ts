import fetch from "node-fetch";
import { logger } from "./logger";

const API_BASE = "https://api.github.com";

export interface RepoInfo {
  owner: string;
  name: string;
  htmlUrl: string;
  cloneUrl: string; // https://github.com/owner/repo.git (sans token)
  defaultBranch: string;
}

function authHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "vscode-auto-push-extension",
  };
}

/** Récupère le login du compte propriétaire du token. */
export async function getAuthenticatedLogin(token: string): Promise<string> {
  const res = await fetch(`${API_BASE}/user`, { headers: authHeaders(token) });
  if (!res.ok) {
    throw new Error(`Impossible de vérifier le token GitHub (HTTP ${res.status}). Vérifie qu'il a le scope "repo" et "delete_repo" si tu souhaites dépublier.`);
  }
  const data = (await res.json()) as { login: string };
  return data.login;
}

/**
 * S'assure que le dépôt existe (le crée sinon), sous le compte personnel
 * ou une organisation selon `owner`. Retourne ses infos.
 */
export async function ensureRepo(
  token: string,
  owner: string,
  repoName: string,
  isPrivate: boolean,
  branch: string
): Promise<RepoInfo> {
  const authenticatedLogin = await getAuthenticatedLogin(token);
  const targetOwner = owner || authenticatedLogin;

  const getRes = await fetch(`${API_BASE}/repos/${targetOwner}/${repoName}`, {
    headers: authHeaders(token),
  });

  if (getRes.ok) {
    const data = (await getRes.json()) as any;
    logger.info(`Dépôt GitHub existant détecté : ${data.full_name}`);
    return {
      owner: targetOwner,
      name: repoName,
      htmlUrl: data.html_url,
      cloneUrl: data.clone_url,
      defaultBranch: data.default_branch || branch,
    };
  }

  if (getRes.status !== 404) {
    throw new Error(`Erreur GitHub inattendue (HTTP ${getRes.status}) lors de la vérification du dépôt.`);
  }

  logger.info(`Dépôt ${targetOwner}/${repoName} introuvable, création en cours...`);

  const isOrg = targetOwner.toLowerCase() !== authenticatedLogin.toLowerCase();
  const createUrl = isOrg ? `${API_BASE}/orgs/${targetOwner}/repos` : `${API_BASE}/user/repos`;

  const createRes = await fetch(createUrl, {
    method: "POST",
    headers: { ...authHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({
      name: repoName,
      private: isPrivate,
      description: "Projet publié automatiquement depuis VS Code (Auto Push extension).",
      auto_init: false,
    }),
  });

  if (!createRes.ok) {
    const body = await createRes.text();
    throw new Error(`Échec de création du dépôt GitHub (HTTP ${createRes.status}): ${body}`);
  }

  const created = (await createRes.json()) as any;
  logger.info(`Dépôt créé : ${created.full_name}`);

  return {
    owner: targetOwner,
    name: repoName,
    htmlUrl: created.html_url,
    cloneUrl: created.clone_url,
    defaultBranch: created.default_branch || branch,
  };
}

/**
 * Supprime le dépôt distant GitHub (DELETE /repos/{owner}/{repo}).
 */
export async function deleteRepo(token: string, owner: string, repoName: string): Promise<void> {
  const authenticatedLogin = await getAuthenticatedLogin(token);
  const targetOwner = owner || authenticatedLogin;

  logger.info(`Suppression du dépôt GitHub ${targetOwner}/${repoName}...`);

  const res = await fetch(`${API_BASE}/repos/${targetOwner}/${repoName}`, {
    method: "DELETE",
    headers: authHeaders(token),
  });

  if (res.status === 204 || res.status === 404) {
    logger.info(`Dépôt GitHub ${targetOwner}/${repoName} supprimé avec succès.`);
    return;
  }

  const body = await res.text();
  throw new Error(`Échec de suppression du dépôt GitHub (HTTP ${res.status}): ${body}`);
}

/**
 * Renomme le dépôt distant GitHub (PATCH /repos/{owner}/{oldRepoName}) avec {"name": newRepoName}.
 * Retourne le RepoInfo mis à jour.
 */
export async function renameRepo(
  token: string,
  owner: string,
  oldRepoName: string,
  newRepoName: string
): Promise<RepoInfo> {
  const authenticatedLogin = await getAuthenticatedLogin(token);
  const targetOwner = owner || authenticatedLogin;

  logger.info(`Renommage du dépôt distant GitHub ${targetOwner}/${oldRepoName} vers ${newRepoName}...`);

  const res = await fetch(`${API_BASE}/repos/${targetOwner}/${oldRepoName}`, {
    method: "PATCH",
    headers: {
      ...authHeaders(token),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name: newRepoName }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Échec du renommage du dépôt GitHub (HTTP ${res.status}): ${body}`);
  }

  const data = (await res.json()) as any;
  logger.info(`Dépôt GitHub renommé avec succès : ${data.full_name}`);
  return {
    owner: targetOwner,
    name: data.name,
    htmlUrl: data.html_url,
    cloneUrl: data.clone_url,
    defaultBranch: data.default_branch,
  };
}

