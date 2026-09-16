import * as vscode from "vscode";

export interface AutoPushConfig {
  enabled: boolean;
  githubToken: string;
  repoName: string;
  branch: string;
  includedPaths: string[];
  extraIgnorePatterns: string[];
  intervalMinutes: number;
}

const HEAVY_FOLDER_PATTERNS = [
  /^node_modules(\/|$)/,
  /^out(\/|$)/,
  /^dist(\/|$)/,
  /^build(\/|$)/,
  /^\.git(\/|$)/,
  /^venv(\/|$)/,
  /^\.venv(\/|$)/,
  /^__pycache__(\/|$)/,
  /^\.next(\/|$)/,
  /^target(\/|$)/,
  /^bin(\/|$)/,
  /^obj(\/|$)/,
];

export function isHeavyFolder(relPath: string): boolean {
  const normalized = normalizePath(relPath);
  return HEAVY_FOLDER_PATTERNS.some((re) => re.test(normalized));
}

export function getConfig(folder: vscode.WorkspaceFolder): AutoPushConfig {
  const cfg = vscode.workspace.getConfiguration("autoPush", folder.uri);
  return {
    enabled: cfg.get<boolean>("enabled", false),
    githubToken: cfg.get<string>("githubToken", "").trim(),
    repoName: cfg.get<string>("repoName", "").trim(),
    branch: cfg.get<string>("branch", "main").trim() || "main",
    includedPaths: cfg.get<string[]>("includedPaths", []),
    extraIgnorePatterns: cfg.get<string[]>("extraIgnorePatterns", []),
    intervalMinutes: cfg.get<number>("intervalMinutes", 0),
  };
}

export function getTarget(): vscode.ConfigurationTarget {
  return vscode.ConfigurationTarget.WorkspaceFolder;
}

export async function getToken(context: vscode.ExtensionContext): Promise<string> {
  const token = await context.secrets.get("autoPush.githubToken");
  return token || "";
}

export async function setToken(context: vscode.ExtensionContext, token: string): Promise<void> {
  await context.secrets.store("autoPush.githubToken", token.trim());
}

export async function resolveGithubToken(
  context: vscode.ExtensionContext,
  folder: vscode.WorkspaceFolder
): Promise<string> {
  const secretToken = await getToken(context);
  if (secretToken) return secretToken;

  const cfg = getConfig(folder);
  if (cfg.githubToken) return cfg.githubToken;

  return "";
}

export function sanitizeRepoName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

export async function isAutoPushEnabled(folder: vscode.WorkspaceFolder): Promise<boolean> {
  return getConfig(folder).enabled;
}

export async function setAutoPushEnabled(folder: vscode.WorkspaceFolder, enabled: boolean): Promise<void> {
  const cfg = vscode.workspace.getConfiguration("autoPush", folder.uri);
  await cfg.update("enabled", enabled, getTarget());
}

export async function addIncludedPath(folder: vscode.WorkspaceFolder, relPath: string): Promise<string[]> {
  const cfg = vscode.workspace.getConfiguration("autoPush", folder.uri);
  const current = cfg.get<string[]>("includedPaths", []);
  const normalized = normalizePath(relPath);

  if (!normalized) return current;

  const set = new Set(current.map(normalizePath));
  set.add(normalized);
  const updated = Array.from(set);

  await cfg.update("includedPaths", updated, getTarget());
  return updated;
}

export async function removeIncludedPath(folder: vscode.WorkspaceFolder, relPath: string): Promise<string[]> {
  const cfg = vscode.workspace.getConfiguration("autoPush", folder.uri);
  const current = cfg.get<string[]>("includedPaths", []);
  const normalized = normalizePath(relPath);

  const updated = current.map(normalizePath).filter((p) => p !== normalized);

  await cfg.update("includedPaths", updated, getTarget());
  return updated;
}

export async function resetIncludedPaths(folder: vscode.WorkspaceFolder): Promise<void> {
  const cfg = vscode.workspace.getConfiguration("autoPush", folder.uri);
  await cfg.update("includedPaths", [], getTarget());
}