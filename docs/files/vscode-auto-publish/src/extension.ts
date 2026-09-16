import * as vscode from "vscode";
import * as path from "path";
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
} from "./config";
import { ensureRepo, deleteRepo, RepoInfo } from "./github";
import {
  ensureGitRepo,
  ensureRemote,
  commitAndPush,
  untrackPathAndPush,
  cleanupResidualPublic,
} from "./gitOps";
import { generateSite, addToAutoPushIgnore } from "./siteGenerator";
import { getPagesInfo, enablePages } from "./githubPages";
import { AutoPushDecorationProvider } from "./decorationProvider";
import { AutoPushControlPanel } from "./controlPanel";
import { logger } from "./logger";

let statusBarItem: vscode.StatusBarItem;
let panelStatusBarItem: vscode.StatusBarItem;
let decorationProvider: AutoPushDecorationProvider;

const debounceTimers = new Map<string, NodeJS.Timeout>();
const repoInfoCache = new Map<string, RepoInfo>();
const publishing = new Set<string>();

export function activate(context: vscode.ExtensionContext) {
  logger.info("Auto Push : activation de l'extension...");

  // 1. Icône principale d'état et d'action rapide
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = "autoPush.activateProject";
  context.subscriptions.push(statusBarItem);

  // 2. Icône secondaire pour ouvrir le panneau interactif (codicon garanti standard)
  panelStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  panelStatusBarItem.command = "autoPush.openControlPanel";
  panelStatusBarItem.text = "$(settings-gear)";
  panelStatusBarItem.tooltip = "Auto Push : Ouvrir le panneau de contrôle";
  panelStatusBarItem.show();
  context.subscriptions.push(panelStatusBarItem);

  // 3. Badges de décoration dans l'explorateur
  decorationProvider = new AutoPushDecorationProvider();
  context.subscriptions.push(vscode.window.registerFileDecorationProvider(decorationProvider));

  // Enregistrement de toutes les commandes avec gestion d'erreurs
  context.subscriptions.push(
    vscode.commands.registerCommand("autoPush.openControlPanel", () => openControlPanelCommand(context)),
    vscode.commands.registerCommand("autoPush.activateProject", () => activateProjectCommand(context)),
    vscode.commands.registerCommand("autoPush.setToken", () => setTokenCommand(context)),
    vscode.commands.registerCommand("autoPush.toggle", () => toggleCommand()),
    vscode.commands.registerCommand("autoPush.publishNow", () => publishActiveFolder(context, true)),
    vscode.commands.registerCommand("autoPush.openPublicSite", () => openPublicSite()),
    vscode.commands.registerCommand("autoPush.openRepo", () => openRepo()),
    vscode.commands.registerCommand("autoPush.addToSelection", (uri?: vscode.Uri) => addToSelectionCommand(context, uri)),
    vscode.commands.registerCommand("autoPush.removeFromSelection", (uri?: vscode.Uri) => removeFromSelectionCommand(uri)),
    vscode.commands.registerCommand("autoPush.resetSelection", () => resetSelectionCommand()),
    vscode.commands.registerCommand("autoPush.unpublishPath", (uri?: vscode.Uri) => unpublishPathCommand(context, uri)),
    vscode.commands.registerCommand("autoPush.unpublishAll", () => unpublishAllCommand(context)),
    vscode.commands.registerCommand("autoPush.unpublishEverything", () => unpublishAllCommand(context))
  );

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => scheduleFromSave(context, doc))
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("autoPush")) {
        refreshStatusBar();
        decorationProvider.refresh();
      }
    })
  );

  // Onboarding au premier démarrage
  const welcomed = context.globalState.get<boolean>("autoPush.welcomed", false);
  if (!welcomed) {
    context.globalState.update("autoPush.welcomed", true);
    vscode.window
      .showInformationMessage(
        "Bienvenue dans Auto Push ! Connectez GitHub pour publier automatiquement votre code et vos sites publics.",
        "Connecter GitHub",
        "Plus tard"
      )
      .then((choice) => {
        if (choice === "Connecter GitHub") {
          resolveGithubToken(context, true).then((token) => {
            if (token) {
              vscode.window.showInformationMessage("GitHub connecté avec succès à Auto Push !");
            }
          });
        }
      });
  }

  refreshStatusBar();
  logger.info("Extension Auto Push activée avec succès.");
}

export function deactivate() {
  for (const t of debounceTimers.values()) clearTimeout(t);
}

// ---------- Commandes de tokens ----------

async function setTokenCommand(context: vscode.ExtensionContext) {
  const token = await resolveGithubToken(context, true);
  if (token) {
    vscode.window.showInformationMessage("Token GitHub enregistré de façon sécurisée (VS Code SecretStorage).");
  }
}

// ---------- Panneau interactif ----------

function openControlPanelCommand(context: vscode.ExtensionContext) {
  const folder = currentFolder();
  if (!folder) {
    vscode.window.showWarningMessage("Ouvre un dossier de projet d'abord.");
    return;
  }
  AutoPushControlPanel.show(context, folder, {
    onPublishNow: async (f) => {
      await publishFolder(context, f, true);
    },
    onStateChanged: () => {
      refreshStatusBar();
      decorationProvider.refresh();
    },
  });
}

// ---------- Activation en un clic ----------

async function activateProjectCommand(context: vscode.ExtensionContext) {
  const folder = currentFolder();
  if (!folder) {
    vscode.window.showWarningMessage("Ouvre un dossier de projet d'abord.");
    return;
  }

  try {
    await setAutoPushEnabled(folder, true);
    refreshStatusBar();
    vscode.window.showInformationMessage(`Auto Push activé pour "${folder.name}". Publication immédiate en cours...`);
    await publishActiveFolder(context, true);
  } catch (err) {
    logger.error("Erreur lors de l'activation du projet", err);
    vscode.window.showErrorMessage(`Auto Push: échec de l'activation du projet. ${err instanceof Error ? err.message : ""}`);
  }
}

async function toggleCommand() {
  const folder = currentFolder();
  if (!folder) {
    vscode.window.showWarningMessage("Ouvre un dossier de projet d'abord.");
    return;
  }
  try {
    const current = isAutoPushEnabled(folder);
    await setAutoPushEnabled(folder, !current);
    vscode.window.showInformationMessage(`Auto Push ${!current ? "activé" : "désactivé"} pour ce projet.`);
    refreshStatusBar();
  } catch (err) {
    logger.error("Erreur toggle", err);
    vscode.window.showErrorMessage(`Auto Push: échec de l'activation/désactivation. ${err instanceof Error ? err.message : ""}`);
  }
}

async function openPublicSite() {
  const folder = currentFolder();
  if (!folder) return;
  const cfg = getConfig(folder);
  if (!cfg.publicSiteUrl) {
    vscode.window.showWarningMessage(
      "Aucune URL de site public configurée. Publiez d'abord le projet pour activer GitHub Pages."
    );
    return;
  }
  vscode.env.openExternal(vscode.Uri.parse(cfg.publicSiteUrl));
}

async function openRepo() {
  const folder = currentFolder();
  if (!folder) return;
  const info = repoInfoCache.get(folder.uri.fsPath);
  if (!info) {
    vscode.window.showInformationMessage("Le dépôt n'a pas encore été créé/détecté. Lance une publication d'abord.");
    return;
  }
  vscode.env.openExternal(vscode.Uri.parse(info.htmlUrl));
}

// ---------- Gestion de la sélection ----------

async function resolveTargetUri(uri?: vscode.Uri): Promise<{ folder: vscode.WorkspaceFolder; relPath: string } | undefined> {
  const targetUri = uri || vscode.window.activeTextEditor?.document.uri;
  if (!targetUri) {
    const folder = currentFolder();
    if (!folder) {
      vscode.window.showWarningMessage("Ouvre un dossier de projet d'abord.");
      return undefined;
    }
    const entered = await vscode.window.showInputBox({
      prompt: "Chemin relatif du fichier ou dossier à cibler (ex: src ou README.md)",
      placeHolder: "src",
    });
    if (!entered) return undefined;
    return { folder, relPath: normalizePath(entered) };
  }

  const folder = vscode.workspace.getWorkspaceFolder(targetUri) || currentFolder();
  if (!folder) {
    vscode.window.showWarningMessage("L'élément sélectionné ne fait pas partie de l'espace de travail.");
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

    const cfg = getConfig(folder);
    const isAlreadyActive = cfg.enabled;

    if (isAlreadyActive) {
      // 2. Projet déjà activé : ajoute le chemin et propose de publier immédiatement
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
      // 3. Projet pas encore activé : activation scopée
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

async function removeFromSelectionCommand(uri?: vscode.Uri) {
  try {
    const folder = currentFolder();
    if (!folder) {
      vscode.window.showWarningMessage("Ouvre un dossier de projet d'abord.");
      return;
    }

    const cfg = getConfig(folder);
    if (!cfg.enabled) {
      vscode.window.showInformationMessage("Auto Push n'est pas actif sur ce projet, rien à retirer.");
      return;
    }

    if (cfg.includedPaths.length === 0) {
      vscode.window.showInformationMessage("Aucune sélection active (tout le projet est actuellement publié).");
      return;
    }

    let relPathToRemove: string | undefined;

    if (uri) {
      const rel = normalizePath(path.relative(folder.uri.fsPath, uri.fsPath));
      if (cfg.includedPaths.includes(rel)) {
        relPathToRemove = rel;
      }
    }

    if (!relPathToRemove) {
      relPathToRemove = await vscode.window.showQuickPick(cfg.includedPaths, {
        placeHolder: "Sélectionne le chemin à retirer de la liste blanche",
      });
    }

    if (!relPathToRemove) return;

    await removeIncludedPath(folder, relPathToRemove);
    refreshStatusBar();
    decorationProvider.refresh();
    vscode.window.showInformationMessage(`"${relPathToRemove}" retiré de la sélection Auto Push.`);
    logger.info(`Chemin retiré de la sélection : ${relPathToRemove}`);
  } catch (err) {
    logger.error("Échec du retrait de sélection", err);
    vscode.window.showErrorMessage(`Auto Push: erreur lors du retrait de sélection. ${err instanceof Error ? err.message : ""}`);
  }
}

async function resetSelectionCommand() {
  try {
    const folder = currentFolder();
    if (!folder) {
      vscode.window.showWarningMessage("Ouvre un dossier de projet d'abord.");
      return;
    }

    const choice = await vscode.window.showWarningMessage(
      "Voulez-vous réinitialiser la sélection et publier à nouveau l'ensemble du projet ?",
      "Confirmer",
      "Annuler"
    );
    if (choice !== "Confirmer") return;

    await resetIncludedPaths(folder);
    refreshStatusBar();
    decorationProvider.refresh();
    vscode.window.showInformationMessage("Sélection réinitialisée : tout le projet sera désormais publié.");
    logger.info("Sélection réinitialisée à tout le projet.");
  } catch (err) {
    logger.error("Échec de la réinitialisation de sélection", err);
    vscode.window.showErrorMessage(`Auto Push: erreur lors de la réinitialisation. ${err instanceof Error ? err.message : ""}`);
  }
}

// ---------- Dépublication ----------

async function unpublishPathCommand(context: vscode.ExtensionContext, uri?: vscode.Uri) {
  try {
    const resolved = await resolveTargetUri(uri);
    if (!resolved) return;
    const { folder, relPath } = resolved;
    if (!relPath) {
      vscode.window.showWarningMessage("Pour dépublier tout le projet, utilisez la commande 'Auto Push: Tout dépublier'.");
      return;
    }

    const cfg = getConfig(folder);
    if (!cfg.enabled) {
      vscode.window.showInformationMessage("Rien à dépublier : Auto Push n'est pas actif sur ce projet.");
      return;
    }

    const confirm = await vscode.window.showWarningMessage(
      `Voulez-vous vraiment dépublier "${relPath}" ?\nLe fichier local restera intact, mais il sera retiré du suivi git, ajouté à .autopushignore, et supprimé du dépôt distant.`,
      { modal: true },
      "Dépublier"
    );
    if (confirm !== "Dépublier") return;

    const token = await resolveGithubToken(context, true);
    if (!token) {
      vscode.window.showErrorMessage("Auto Push: aucun token GitHub configuré.");
      return;
    }

    addToAutoPushIgnore(folder.uri.fsPath, relPath);

    if (cfg.includedPaths.includes(relPath)) {
      await removeIncludedPath(folder, relPath);
    }

    // Régénérer le site public sans ce fichier
    const refreshedCfg = getConfig(folder);
    const repoName = sanitizeRepoName(refreshedCfg.repoName);
    const repoInfo = await ensureRepo(token, refreshedCfg.githubOwner, repoName, refreshedCfg.isPrivate, refreshedCfg.branch);

    generateSite(folder.uri.fsPath, refreshedCfg.extraIgnorePatterns, refreshedCfg.includedPaths, {
      repoHtmlUrl: repoInfo.htmlUrl,
      publicSiteUrl: refreshedCfg.publicSiteUrl,
      projectName: folder.name,
      branch: refreshedCfg.branch,
    });

    const git = await ensureGitRepo(folder.uri.fsPath, refreshedCfg.branch);
    await ensureRemote(git, repoInfo.cloneUrl);
    await untrackPathAndPush(git, refreshedCfg.branch, token, relPath, folder.uri.fsPath);

    vscode.window.showInformationMessage(`"${relPath}" dépublié (retiré du dépôt distant, fichier local conservé).`);
    refreshStatusBar();
    decorationProvider.refresh();
  } catch (err) {
    logger.error(`Échec de la dépublication de ${uri?.fsPath || "chemin"}`, err);
    vscode.window.showErrorMessage(`Auto Push: échec de la dépublication. ${err instanceof Error ? err.message : ""}`);
  }
}

async function unpublishAllCommand(context: vscode.ExtensionContext) {
  const folder = currentFolder();
  if (!folder) {
    vscode.window.showWarningMessage("Ouvre un dossier de projet d'abord.");
    return;
  }

  const cfg = getConfig(folder);
  if (!cfg.enabled) {
    vscode.window.showInformationMessage("Rien à dépublier : Auto Push n'est pas actif sur ce projet.");
    return;
  }

  const repoName = sanitizeRepoName(cfg.repoName);

  // 1ère confirmation
  const firstConfirm = await vscode.window.showWarningMessage(
    `Attention : cette action va supprimer définitivement le dépôt distant GitHub (${cfg.githubOwner || "votre compte"}/${repoName}) et son site GitHub Pages associé. Les fichiers locaux ne seront pas touchés.`,
    { modal: true },
    "Continuer"
  );
  if (firstConfirm !== "Continuer") return;

  // 2ème confirmation par saisie exacte
  const typedName = await vscode.window.showInputBox({
    prompt: `Tapez exactement "${repoName}" pour confirmer la suppression définitive :`,
    placeHolder: repoName,
    ignoreFocusOut: true,
  });

  if (typedName !== repoName) {
    vscode.window.showWarningMessage("Suppression annulée : le nom saisi ne correspond pas.");
    return;
  }

  const token = await resolveGithubToken(context, true);
  if (!token) {
    vscode.window.showErrorMessage("Auto Push: aucun token GitHub configuré.");
    return;
  }

  logger.info(`Début de la dépublication totale pour le projet ${repoName}...`);

  try {
    // 1. DELETE GitHub repo (supprime automatiquement le dépôt et GitHub Pages)
    await deleteRepo(token, cfg.githubOwner, repoName);
    logger.info(`Dépôt distant GitHub ${repoName} supprimé.`);

    // 2. Remettre autoPush.enabled à false et autoPush.publicSiteUrl à ""
    await setAutoPushEnabled(folder, false);
    const wsCfg = vscode.workspace.getConfiguration("autoPush", folder.uri);
    await wsCfg.update("publicSiteUrl", "", getTarget());

    repoInfoCache.delete(folder.uri.fsPath);
    refreshStatusBar();
    decorationProvider.refresh();

    vscode.window.showInformationMessage(
      `Le projet distant (${repoName}) a été totalement dépublié de GitHub (dépôt et site GitHub Pages). Les fichiers locaux sont intacts.`
    );
  } catch (err) {
    logger.error("Échec de la dépublication totale", err);
    vscode.window.showErrorMessage(`Auto Push: échec de la dépublication totale. ${err instanceof Error ? err.message : ""}`);
  }
}

// ---------- Déclenchement automatique ----------

function currentFolder(): vscode.WorkspaceFolder | undefined {
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active) {
    const f = vscode.workspace.getWorkspaceFolder(active);
    if (f) return f;
  }
  return vscode.workspace.workspaceFolders?.[0];
}

function scheduleFromSave(context: vscode.ExtensionContext, doc: vscode.TextDocument) {
  const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
  if (!folder) return;

  const cfg = getConfig(folder);
  if (!cfg.enabled) return;

  const key = folder.uri.fsPath;
  const existing = debounceTimers.get(key);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    debounceTimers.delete(key);
    publishFolder(context, folder, false).catch((err) => {
      logger.error(`Publication automatique échouée pour ${folder.name}`, err);
      vscode.window.showErrorMessage(`Auto Push: échec de la publication (${folder.name}). Voir le panneau de sortie "Auto Push".`);
    });
  }, Math.max(500, cfg.debounceMs));

  debounceTimers.set(key, timer);
}

async function publishActiveFolder(context: vscode.ExtensionContext, manual: boolean) {
  const folder = currentFolder();
  if (!folder) {
    vscode.window.showWarningMessage("Ouvre un dossier de projet d'abord.");
    return;
  }
  try {
    await publishFolder(context, folder, manual);
  } catch (err) {
    logger.error("Publication manuelle échouée", err);
    vscode.window.showErrorMessage(`Auto Push: échec de la publication. ${err instanceof Error ? err.message : ""}`);
  }
}

// ---------- Cœur de la publication ----------

async function publishFolder(context: vscode.ExtensionContext, folder: vscode.WorkspaceFolder, manual: boolean) {
  const key = folder.uri.fsPath;
  if (publishing.has(key)) {
    logger.info("Publication déjà en cours, on ignore ce déclenchement.");
    return;
  }
  publishing.add(key);
  statusBarItem.text = "$(sync~spin) Auto Push...";
  statusBarItem.tooltip = `Publication en cours pour ${folder.name}`;
  statusBarItem.show();

  try {
    const cfg = getConfig(folder);
    if (!cfg.enabled && manual === false) return;

    const token = await resolveGithubToken(context, manual);
    if (!token) {
      if (manual) {
        const choice = await vscode.window.showWarningMessage(
          "Auto Push: aucun token GitHub configuré.",
          "Connecter GitHub"
        );
        if (choice === "Connecter GitHub") await setTokenCommand(context);
      }
      return;
    }

    const repoName = sanitizeRepoName(cfg.repoName);
    const repoInfo = await ensureRepo(token, cfg.githubOwner, repoName, cfg.isPrivate, cfg.branch);
    repoInfoCache.set(key, repoInfo);

    // Tentative d'activation GitHub Pages si pas encore d'URL configurée
    let activePublicUrl = cfg.publicSiteUrl;
    if (!activePublicUrl) {
      try {
        let pagesInfo = await getPagesInfo(token, repoInfo.owner, repoName);
        if (!pagesInfo) {
          const url = await enablePages(token, repoInfo.owner, repoName, cfg.branch);
          pagesInfo = { url };
        }
        if (pagesInfo?.url) {
          activePublicUrl = pagesInfo.url;
          const wsCfg = vscode.workspace.getConfiguration("autoPush", folder.uri);
          await wsCfg.update("publicSiteUrl", pagesInfo.url, getTarget());
        }
      } catch (err) {
        logger.warn(`GitHub Pages non activé automatiquement : ${err instanceof Error ? err.message : err}`);
      }
    }

    const git = await ensureGitRepo(folder.uri.fsPath, cfg.branch);
    await ensureRemote(git, repoInfo.cloneUrl);

    // Migration Priorité 0 : nettoyage et suppression de tout résidu public/
    await cleanupResidualPublic(git, folder.uri.fsPath, token, cfg.branch);

    const filesIncluded = generateSite(
      folder.uri.fsPath,
      cfg.extraIgnorePatterns,
      cfg.includedPaths,
      {
        repoHtmlUrl: repoInfo.htmlUrl,
        publicSiteUrl: activePublicUrl,
        projectName: folder.name,
        branch: cfg.branch,
      }
    );

    const result = await commitAndPush(
      git,
      cfg.branch,
      token,
      `Auto Push: ${new Date().toISOString()}`,
      cfg.includedPaths,
      folder.uri.fsPath
    );

    if (result.pushed) {
      statusBarItem.text = `$(check) Auto Push OK`;
      statusBarItem.tooltip = `Dernière publication: ${new Date().toLocaleTimeString()} — ${filesIncluded} fichiers`;

      if (manual) {
        if (activePublicUrl) {
          const choice = await vscode.window.showInformationMessage(
            `Site public GitHub Pages prêt : ${activePublicUrl} (Note : la génération par GitHub peut prendre 1 à 2 minutes avant d'être accessible)`,
            "Copier l'URL",
            "Ouvrir le site"
          );
          if (choice === "Copier l'URL") {
            await vscode.env.clipboard.writeText(activePublicUrl);
          } else if (choice === "Ouvrir le site") {
            vscode.env.openExternal(vscode.Uri.parse(activePublicUrl));
          }
        } else {
          const choice = await vscode.window.showInformationMessage(
            `Publié sur ${repoInfo.htmlUrl} (${filesIncluded} fichier(s) dans le site public).`,
            "Copier l'URL GitHub",
            "Ouvrir le dépôt"
          );
          if (choice === "Copier l'URL GitHub") {
            await vscode.env.clipboard.writeText(repoInfo.htmlUrl);
          } else if (choice === "Ouvrir le dépôt") {
            vscode.env.openExternal(vscode.Uri.parse(repoInfo.htmlUrl));
          }
        }
      }
    } else {
      statusBarItem.text = `$(check) Auto Push (à jour)`;
      statusBarItem.tooltip = "Aucun changement à publier.";
      if (manual && activePublicUrl) {
        const choice = await vscode.window.showInformationMessage(
          `Site public GitHub Pages déjà à jour : ${activePublicUrl}`,
          "Copier l'URL",
          "Ouvrir le site"
        );
        if (choice === "Copier l'URL") {
          await vscode.env.clipboard.writeText(activePublicUrl);
        } else if (choice === "Ouvrir le site") {
          vscode.env.openExternal(vscode.Uri.parse(activePublicUrl));
        }
      }
    }
  } finally {
    publishing.delete(key);
    setTimeout(refreshStatusBar, 4000);
  }
}

function refreshStatusBar() {
  const folder = currentFolder();
  if (!folder) {
    statusBarItem.hide();
    panelStatusBarItem.hide();
    return;
  }
  const cfg = getConfig(folder);
  const filterCount = cfg.includedPaths.length;
  const filterLabel = filterCount > 0 ? ` [${filterCount} filtré(s)]` : "";

  statusBarItem.command = cfg.enabled ? "autoPush.publishNow" : "autoPush.activateProject";

  statusBarItem.text = cfg.enabled
    ? `$(radio-tower) Auto Push: ON${filterLabel}`
    : `$(circle-slash) Auto Push: OFF`;

  const mdTooltip = new vscode.MarkdownString();
  mdTooltip.isTrusted = true;
  mdTooltip.appendMarkdown(`### Auto Push — ${folder.name}\n\n`);
  mdTooltip.appendMarkdown(`- **Statut** : ${cfg.enabled ? "✅ Activé (ON)" : "⏸️ Désactivé (OFF)"}\n`);
  mdTooltip.appendMarkdown(`- **Dépôt GitHub** : \`${cfg.repoName}\` (${cfg.branch})\n`);
  mdTooltip.appendMarkdown(`- **Périmètre** : ${filterCount > 0 ? `🎯 ${filterCount} chemin(s) filtré(s)` : "🌍 Tout le projet"}\n\n`);
  if (cfg.publicSiteUrl) {
    mdTooltip.appendMarkdown(`- **Site public** : [${cfg.publicSiteUrl}](${cfg.publicSiteUrl})\n\n`);
  }
  if (cfg.enabled) {
    mdTooltip.appendMarkdown(`*Cliquez ici pour publier immédiatement, ou sur l'icône $(settings-gear) pour le panneau de contrôle.*`);
  } else {
    mdTooltip.appendMarkdown(`*Cliquez ici pour activer Auto Push sur ce projet, ou sur l'icône $(settings-gear) pour le panneau de contrôle.*`);
  }
  statusBarItem.tooltip = mdTooltip;
  statusBarItem.show();

  panelStatusBarItem.show();

  // Mise à jour du panneau Webview en temps réel
  AutoPushControlPanel.updateIfVisible(folder);
}

