import * as vscode from "vscode";
import * as path from "path";
import { logger } from "./logger";

export interface AutoPushConfig {
  enabled: boolean;
  githubOwner: string;
  repoName: string;
  isPrivate: boolean;
  branch: string;
  debounceMs: number;
  extraIgnorePatterns: string[];
  publicSiteUrl: string;
  includedPaths: string[];
  intervalMinutes: number;
}

export function getTarget(): vscode.ConfigurationTarget {
  return vscode.workspace.workspaceFile
    ? vscode.ConfigurationTarget.WorkspaceFolder
    : vscode.ConfigurationTarget.Workspace;
}

export function isAutoPushEnabled(folder: vscode.WorkspaceFolder): boolean {
  const cfg = vscode.workspace.getConfiguration("autoPush", folder.uri);
  const inspect = cfg.inspect<boolean>("enabled");
  const val = cfg.get<boolean>("enabled", false);
  logger.info(`[ENABLED-TRACE] isAutoPushEnabled("${folder.name}"): val=${val}, inspect=${JSON.stringify(inspect)}`);
  return val;
}

export async function setAutoPushEnabled(folder: vscode.WorkspaceFolder, enabled: boolean): Promise<void> {
  const stack = new Error().stack?.split("\n").slice(1, 4).map((s) => s.trim()).join(" -> ") || "unknown";
  const target = getTarget();
  const targetName = target === vscode.ConfigurationTarget.WorkspaceFolder ? "WorkspaceFolder" : "Workspace";
  logger.info(`[ENABLED-TRACE] setAutoPushEnabled START: val=${enabled}, folder="${folder.name}", target=${targetName}, caller=${stack}`);
  const cfg = vscode.workspace.getConfiguration("autoPush", folder.uri);
  await cfg.update("enabled", enabled, target);
  const afterInspect = cfg.inspect<boolean>("enabled");
  const afterVal = cfg.get<boolean>("enabled", false);
  logger.info(`[ENABLED-TRACE] setAutoPushEnabled DONE: set=${enabled}, effective=${afterVal}, inspect=${JSON.stringify(afterInspect)}`);
}

export function getConfig(folder: vscode.WorkspaceFolder): AutoPushConfig {
  const cfg = vscode.workspace.getConfiguration("autoPush", folder.uri);
  const defaultRepoName = sanitizeRepoName(path.basename(folder.uri.fsPath));

  return {
    enabled: isAutoPushEnabled(folder),
    githubOwner: cfg.get<string>("githubOwner", "").trim(),
    repoName: cfg.get<string>("repoName", "").trim() || defaultRepoName,
    isPrivate: cfg.get<boolean>("private", false),
    branch: cfg.get<string>("branch", "main").trim() || "main",
    debounceMs: cfg.get<number>("debounceMs", 3000),
    extraIgnorePatterns: cfg.get<string[]>("extraIgnorePatterns", []),
    publicSiteUrl: cfg.get<string>("publicSiteUrl", "").trim(),
    includedPaths: cfg.get<string[]>("includedPaths", []).map((p) => normalizePath(p)).filter(Boolean),
    intervalMinutes: cfg.get<number>("intervalMinutes", 0),
  };
}

export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
}

export function sanitizeRepoName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "auto-pushed-project";
}

const HEAVY_FOLDER_PATTERNS = [
  /^node_modules(\/|$)/, /^out(\/|$)/, /^dist(\/|$)/, /^build(\/|$)/,
  /^\.git(\/|$)/, /^venv(\/|$)/, /^\.venv(\/|$)/, /^__pycache__(\/|$)/,
  /^\.next(\/|$)/, /^target(\/|$)/, /^bin(\/|$)/, /^obj(\/|$)/,
];

export function isHeavyFolder(relPath: string): boolean {
  const normalized = normalizePath(relPath);
  return HEAVY_FOLDER_PATTERNS.some((re) => re.test(normalized));
}

const GITHUB_TOKEN_SECRET_KEY = "autoPush.githubToken";

// GitHub token in SecretStorage
export async function getToken(context: vscode.ExtensionContext): Promise<string | undefined> {
  return context.secrets.get(GITHUB_TOKEN_SECRET_KEY);
}

export async function setToken(context: vscode.ExtensionContext, token: string): Promise<void> {
  await context.secrets.store(GITHUB_TOKEN_SECRET_KEY, token);
}

export async function clearToken(context: vscode.ExtensionContext): Promise<void> {
  await context.secrets.delete(GITHUB_TOKEN_SECRET_KEY);
}

/**
 * Tente d'obtenir le token depuis SecretStorage ou via l'authentification GitHub intégrée (OAuth).
 * Si interactive = true, invite l'utilisateur via popup / saisie.
 */
export async function resolveGithubToken(
  context: vscode.ExtensionContext,
  interactive: boolean = false
): Promise<string | undefined> {
  const stored = await getToken(context);
  if (stored) return stored;

  try {
    const session = await vscode.authentication.getSession("github", ["repo"], {
      createIfNone: interactive,
    });
    if (session?.accessToken) {
      await setToken(context, session.accessToken);
      return session.accessToken;
    }
  } catch {
    // Échec de la session intégrée
  }

  if (interactive) {
    const input = await vscode.window.showInputBox({
      prompt: "Colle ton Personal Access Token GitHub (scope 'repo' ou 'Contents: Read and write' + 'Pages: Read and write' requis)",
      password: true,
      ignoreFocusOut: true,
    });
    if (input) {
      const clean = input.trim();
      await setToken(context, clean);
      return clean;
    }
  }

  return undefined;
}

// Selection helpers
export async function addIncludedPath(folder: vscode.WorkspaceFolder, relPath: string): Promise<string[]> {
  const norm = normalizePath(relPath);
  if (!norm) return [];
  const cfg = vscode.workspace.getConfiguration("autoPush", folder.uri);
  const current = cfg.get<string[]>("includedPaths", []).map(normalizePath).filter(Boolean);
  if (!current.includes(norm)) {
    const updated = [...current, norm];
    await cfg.update("includedPaths", updated, getTarget());
    return updated;
  }
  return current;
}

export async function removeIncludedPath(folder: vscode.WorkspaceFolder, relPath: string): Promise<string[]> {
  const norm = normalizePath(relPath);
  const cfg = vscode.workspace.getConfiguration("autoPush", folder.uri);
  const current = cfg.get<string[]>("includedPaths", []).map(normalizePath).filter(Boolean);
  const updated = current.filter((p) => p !== norm);
  await cfg.update("includedPaths", updated, getTarget());
  return updated;
}

export async function resetIncludedPaths(folder: vscode.WorkspaceFolder): Promise<void> {
  const cfg = vscode.workspace.getConfiguration("autoPush", folder.uri);
  await cfg.update("includedPaths", [], getTarget());
}
