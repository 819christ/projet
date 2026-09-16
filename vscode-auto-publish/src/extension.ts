import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import {
  getConfig,
  getToken,
  setToken,
  resolveGithubToken,
  sanitizeRepoName,
  normalizePath,
  addIncludedPath,
  removeIncludedPath,
  resetIncludedPaths,
  getTarget,
  isAutoPushEnabled,
  setAutoPushEnabled,
  isHeavyFolder,
} from "./config";
import { ensureGitRepo, commitAndPushDocs, testGithubConnection } from "./githubClient";
import { generateSite, collectRelPaths, isLikelyBinary } from "./siteGenerator";
import { scanForSecrets } from "./secretScanner";
import { logger } from "./logger";

class AutoPushDecorationProvider implements vscode.FileDecorationProvider {
  private _onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

  refresh() {
    this._onDidChangeFileDecorations.fire(undefined);
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) return undefined;

    const cfg = getConfig(folder);
    if (!cfg.enabled || cfg.includedPaths.length === 0) return undefined;

    const rel = normalizePath(path.relative(folder.uri.fsPath, uri.fsPath));
    if (!rel) return undefined;

    const isIncluded = cfg.includedPaths.some((inc) => {
      const normInc = normalizePath(inc);
      return rel === normInc || rel.startsWith(normInc + "/");
    });

    if (isIncluded) {
      return {
        badge: "✓",
        tooltip: "Auto Push: Inclus dans la publication",
        color: new vscode.ThemeColor("gitDecoration.addedResourceForeground"),
      };
    }
    return undefined;
  }
}

let statusBarItem: vscode.StatusBarItem;
const decorationProvider = new AutoPushDecorationProvider();
const debounceTimers = new Map<string, NodeJS.Timeout>();
let intervalTimer: NodeJS.Timeout | undefined;

function setupIntervalCheck(context: vscode.ExtensionContext) {
  if (intervalTimer) {
    clearInterval(intervalTimer);
    intervalTimer = undefined;
  }
  const folder = currentFolder();
  if (!folder) return;
  const cfg = getConfig(folder);
  if (!cfg.enabled || !cfg.intervalMinutes || cfg.intervalMinutes <= 0) return;

  intervalTimer = setInterval(async () => {
    try {
      const git = await ensureGitRepo(folder.uri.fsPath, cfg.branch);
      const status = await git.status();
      const hasChanges =
        status.staged.length ||
        status.created.length ||
        status.deleted.length ||
        status.modified.length ||
        status.not_added.length;
      if (hasChanges) {
        logger.info("Vérification périodique : changements détectés, publication automatique...");
        await publishFolder(context, folder, false);
      }
    } catch (err) {
      logger.error("Vérification périodique échouée", err);
    }
  }, cfg.intervalMinutes * 60 * 1000);
}

function currentFolder(): vscode.WorkspaceFolder | undefined {
  if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
    return vscode.workspace.workspaceFolders[0];
  }
  return undefined;
}

export function activate(context: vscode.ExtensionContext) {
  logger.info("Auto Push est activé.");

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = "autoPush.toggleEnable";
  context.subscriptions.push(statusBarItem);

  context.subscriptions.push(
    vscode.window.registerFileDecorationProvider(decorationProvider)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("autoPush.publishNow", (uri?: vscode.Uri) =>
      publishNowCommand(context, uri)
    ),
    vscode.commands.registerCommand("autoPush.toggleEnable", (uri?: vscode.Uri) =>
      toggleEnableCommand(context, uri)
    ),
    vscode.commands.registerCommand("autoPush.addToSelection", (uri?: vscode.Uri) =>
      addToSelectionCommand(context, uri)
    ),
    vscode.commands.registerCommand("autoPush.removeFromSelection", (uri?: vscode.Uri) =>
      removeFromSelectionCommand(context, uri)
    ),
    vscode.commands.registerCommand("autoPush.resetSelection", (uri?: vscode.Uri) =>
      resetSelectionCommand(context, uri)
    )
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("autoPush")) {
        refreshStatusBar();
        decorationProvider.refresh();
        setupIntervalCheck(context);
      }
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => handleFileSave(context, doc))
  );

  setupIntervalCheck(context);
  refreshStatusBar();
}

export function deactivate() {
  if (intervalTimer) {
    clearInterval(intervalTimer);
  }
}

function refreshStatusBar() {
  const folder = currentFolder();
  if (!folder) {
    statusBarItem.hide();
    return;
  }

  const cfg = getConfig(folder);
  if (cfg.enabled) {
    const count = cfg.includedPaths.length;
    statusBarItem.text = `$(sync) Auto Push: Actif${count > 0 ? ` (${count})` : ""}`;
    statusBarItem.tooltip = `Auto Push est ACTIF sur "${folder.name}". Cliquer pour modifier.`;
    statusBarItem.show();
  } else {
    statusBarItem.text = "$(sync-ignored) Auto Push: Inactif";
    statusBarItem.tooltip = `Auto Push est INACTIF sur "${folder.name}". Cliquer pour activer.`;
    statusBarItem.show();
  }
}

async function resolveTargetUri(uri?: vscode.Uri): Promise<{ folder: vscode.WorkspaceFolder; relPath: string } | undefined> {
  let targetUri = uri;
  if (!targetUri) {
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor) targetUri = activeEditor.document.uri;
  }

  if (!targetUri) {
    const folder = currentFolder();
    if (!folder) {
      vscode.window.showErrorMessage("Aucun dossier de travail ouvert.");
      return undefined;
    }
    return { folder, relPath: "" };
  }

  const folder = vscode.workspace.getWorkspaceFolder(targetUri);
  if (!folder) {
    vscode.window.showErrorMessage("Le fichier sélectionné n'appartient à aucun dossier du workspace.");
    return undefined;
  }

  const relPath = normalizePath(path.relative(folder.uri.fsPath, targetUri.fsPath));
  return { folder, relPath };
}

async function addToSelectionCommand(context: vscode.ExtensionContext, uri?: vscode.Uri) {
  try {
    const resolved = await resolveTargetUri(uri);
    if (!resolved) return;
    const { folder, relPath } = resolved;
    if (!relPath) {
      vscode.window.showInformationMessage("La racine du projet ne peut pas être ajoutée en tant que chemin filtré.");
      return;
    }

    // Bloque les dossiers lourds / générés (node_modules, out, dist, .git, etc.)
    if (isHeavyFolder(relPath)) {
      const proceed = await vscode.window.showWarningMessage(
        `"${relPath}" ressemble à un dossier de dépendances ou généré (node_modules, out, build...). L'ajouter risque de faire échouer la publication (trop de fichiers) ou de la ralentir énormément.`,
        "Ajouter quand même",
        "Annuler"
      );
      if (proceed !== "Ajouter quand même") return;
    }

    const cfg = getConfig(folder);
    const isAlreadyActive = cfg.enabled;

    if (isAlreadyActive) {
      // Avertit avant de faire basculer silencieusement "tout le projet" vers une sélection restreinte
      if (cfg.includedPaths.length === 0) {
        const proceed = await vscode.window.showWarningMessage(
          `Actuellement, tout le projet est publié. Ajouter "${relPath}" va limiter la publication à ce chemin uniquement — le reste du projet ne sera plus publié tant que la sélection n'est pas vidée.`,
          "Limiter la publication à cette sélection",
          "Annuler"
        );
        if (proceed !== "Limiter la publication à cette sélection") return;
      }

      const updated = await addIncludedPath(folder, relPath);
      logger.info(`Chemin ajouté à la sélection : ${relPath}`);
      refreshStatusBar();
      decorationProvider.refresh();
      const choice = await vscode.window.showInformationMessage(
        `"${relPath}" ajouté à la sélection Auto Push.`,
        "Publier maintenant"
      );
      if (choice === "Publier maintenant") {
        await publishActiveFolder(context, true);
      }
    } else {
      const choice = await vscode.window.showInformationMessage(
        `Auto Push n'est pas encore activé sur ce projet. Activer maintenant et publier uniquement "${relPath}" ?`,
        "Activer et publier ce chemin",
        "Annuler"
      );
      if (choice === "Activer et publier ce chemin") {
        const wsCfg = vscode.workspace.getConfiguration("autoPush", folder.uri);
        await wsCfg.update("includedPaths", [relPath], getTarget());
        await setAutoPushEnabled(folder, true);
        refreshStatusBar();
        decorationProvider.refresh();
        vscode.window.showInformationMessage(`"${relPath}" ajouté à la sélection Auto Push.`);
        await publishActiveFolder(context, true);
      }
    }
  } catch (err) {
    logger.error("Échec de l'ajout à la sélection", err);
    vscode.window.showErrorMessage(`Auto Push: impossible d'ajouter à la sélection. ${err instanceof Error ? err.message : ""}`);
  }
}

async function removeFromSelectionCommand(context: vscode.ExtensionContext, uri?: vscode.Uri) {
  try {
    const resolved = await resolveTargetUri(uri);
    if (!resolved || !resolved.relPath) return;

    const { folder, relPath } = resolved;
    await removeIncludedPath(folder, relPath);
    logger.info(`Chemin retiré de la sélection : ${relPath}`);
    refreshStatusBar();
    decorationProvider.refresh();
    vscode.window.showInformationMessage(`"${relPath}" retiré de la sélection Auto Push.`);
  } catch (err) {
    logger.error("Échec du retrait de la sélection", err);
    vscode.window.showErrorMessage("Auto Push: impossible de retirer de la sélection.");
  }
}

async function resetSelectionCommand(context: vscode.ExtensionContext, uri?: vscode.Uri) {
  try {
    const folder = currentFolder();
    if (!folder) return;

    await resetIncludedPaths(folder);
    logger.info("Sélection réinitialisée : tout le projet est désormais inclus.");
    refreshStatusBar();
    decorationProvider.refresh();
    vscode.window.showInformationMessage("Sélection Auto Push réinitialisée : tout le projet sera publié.");
  } catch (err) {
    logger.error("Échec de la réinitialisation de la sélection", err);
  }
}

async function toggleEnableCommand(context: vscode.ExtensionContext, uri?: vscode.Uri) {
  const folder = currentFolder();
  if (!folder) return;

  const cfg = getConfig(folder);
  const nextState = !cfg.enabled;
  await setAutoPushEnabled(folder, nextState);
  refreshStatusBar();
  decorationProvider.refresh();
  setupIntervalCheck(context);

  if (nextState) {
    const choice = await vscode.window.showInformationMessage(
      `Auto Push est maintenant ACTIF pour "${folder.name}".`,
      "Publier maintenant"
    );
    if (choice === "Publier maintenant") {
      await publishActiveFolder(context, true);
    }
  } else {
    vscode.window.showInformationMessage(`Auto Push est désormais INACTIF pour "${folder.name}".`);
  }
}

async function publishNowCommand(context: vscode.ExtensionContext, uri?: vscode.Uri) {
  await publishActiveFolder(context, true);
}

async function publishActiveFolder(context: vscode.ExtensionContext, userInitiated: boolean) {
  const folder = currentFolder();
  if (!folder) {
    if (userInitiated) vscode.window.showErrorMessage("Auto Push: aucun dossier ouvert.");
    return;
  }
  await publishFolder(context, folder, userInitiated);
}

async function handleFileSave(context: vscode.ExtensionContext, doc: vscode.TextDocument) {
  const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
  if (!folder) return;

  const cfg = getConfig(folder);
  if (!cfg.enabled) return;

  const relPath = normalizePath(path.relative(folder.uri.fsPath, doc.uri.fsPath));
  if (relPath.startsWith("docs/") || relPath === "docs") return;

  const folderPath = folder.uri.fsPath;
  if (debounceTimers.has(folderPath)) {
    clearTimeout(debounceTimers.get(folderPath)!);
  }

  const timer = setTimeout(async () => {
    debounceTimers.delete(folderPath);
    logger.info(`Changement détecté (${relPath}), publication automatique...`);
    await publishFolder(context, folder, false);
  }, 2000);

  debounceTimers.set(folderPath, timer);
}

async function publishFolder(
  context: vscode.ExtensionContext,
  folder: vscode.WorkspaceFolder,
  userInitiated: boolean
) {
  try {
    const cfg = getConfig(folder);
    let token = await resolveGithubToken(context, folder);

    if (!token) {
      if (!userInitiated) return;

      const input = await vscode.window.showInputBox({
        prompt: "Entrez votre jeton d'accès GitHub (PAT) avec accès aux dépôts",
        password: true,
        ignoreFocusOut: true,
      });

      if (!input) {
        vscode.window.showWarningMessage("Auto Push: jeton GitHub requis pour publier.");
        return;
      }

      token = input.trim();
      await setToken(context, token);
    }

    const isTokenValid = await testGithubConnection(token);
    if (!isTokenValid) {
      vscode.window.showErrorMessage("Auto Push: jeton GitHub invalide ou expiré.");
      return;
    }

    const repoName = cfg.repoName ? sanitizeRepoName(cfg.repoName) : sanitizeRepoName(folder.name);
    const workspaceRoot = folder.uri.fsPath;

    // Détection de secrets potentiels
    const candidatePaths = collectRelPaths(workspaceRoot, cfg.extraIgnorePatterns, cfg.includedPaths);
    const flagged: { file: string; issues: string[] }[] = [];
    for (const relPath of candidatePaths) {
      const fullPath = path.join(workspaceRoot, relPath);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.size > 2 * 1024 * 1024 || isLikelyBinary(fullPath)) continue;
        const content = fs.readFileSync(fullPath, "utf8");
        const issues = scanForSecrets(content);
        if (issues.length > 0) flagged.push({ file: relPath, issues });
      } catch {
        // fichier illisible, on l'ignore pour le scan
      }
    }

    if (flagged.length > 0) {
      const list = flagged.map((f) => `- ${f.file} (${f.issues.join(", ")})`).join("\n");
      const choice = await vscode.window.showWarningMessage(
        `Contenu ressemblant à un secret détecté dans ${flagged.length} fichier(s) :\n${list}`,
        { modal: true },
        "Publier quand même",
        "Annuler la publication"
      );
      if (choice !== "Publier quand même") {
        logger.info("Publication annulée suite à la détection de secrets potentiels.");
        return;
      }
    }

    const git = await ensureGitRepo(workspaceRoot, cfg.branch);

    const siteMeta = {
      projectName: folder.name,
      repoHtmlUrl: `https://github.com/user/${repoName}`,
      branch: cfg.branch,
    };

    const count = generateSite(workspaceRoot, cfg.extraIgnorePatterns, cfg.includedPaths, siteMeta);

    if (count === 0) {
      if (userInitiated) {
        vscode.window.showWarningMessage("Auto Push: aucun fichier éligible à la publication.");
      }
      return;
    }

    const result = await commitAndPushDocs(git, token, repoName, cfg.branch);

    if (result.pushed) {
      const siteUrl = result.pagesUrl || `https://github.com/user/${repoName}`;
      if (userInitiated) {
        const choice = await vscode.window.showInformationMessage(
          `Auto Push: publication réussie (${count} fichier(s)) !`,
          "Ouvrir le site"
        );
        if (choice === "Ouvrir le site") {
          vscode.env.openExternal(vscode.Uri.parse(siteUrl));
        }
      } else {
        vscode.window.setStatusBarMessage(`$(check) Auto Push synchronisé (${count} fichiers)`, 4000);
      }
    }
  } catch (err) {
    logger.error("Erreur durant la publication", err);
    if (userInitiated) {
      vscode.window.showErrorMessage(
        `Auto Push: échec de la publication. ${err instanceof Error ? err.message : ""}`
      );
    }
  }
}