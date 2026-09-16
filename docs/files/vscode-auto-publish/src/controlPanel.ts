import * as vscode from "vscode";
import * as path from "path";
import {
  getConfig,
  normalizePath,
  addIncludedPath,
  removeIncludedPath,
  resolveGithubToken,
  sanitizeRepoName,
  getTarget,
  setAutoPushEnabled,
} from "./config";
import { ensureRepo, renameRepo, RepoInfo } from "./github";
import { ensureGitRepo, ensureRemote } from "./gitOps";
import { logger } from "./logger";

export interface ControlPanelCallbacks {
  onPublishNow: (folder: vscode.WorkspaceFolder) => Promise<void>;
  onStateChanged: () => void;
}

export class AutoPushControlPanel {
  private static currentPanel: AutoPushControlPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private currentFolder: vscode.WorkspaceFolder | undefined;
  private callbacks: ControlPanelCallbacks;
  private context: vscode.ExtensionContext;

  private constructor(
    panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    folder: vscode.WorkspaceFolder,
    callbacks: ControlPanelCallbacks
  ) {
    this.panel = panel;
    this.context = context;
    this.currentFolder = folder;
    this.callbacks = callbacks;

    this.panel.webview.html = this.getHtml();

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    this.panel.webview.onDidReceiveMessage(
      async (message) => {
        try {
          await this.handleMessage(message);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          vscode.window.showErrorMessage(`Auto Push : ${msg}`);
          logger.error("Erreur dans le panneau de contrôle", err);
        }
      },
      null,
      this.disposables
    );

    // Envoyer l'état initial
    this.postState();
  }

  public static show(
    context: vscode.ExtensionContext,
    folder: vscode.WorkspaceFolder,
    callbacks: ControlPanelCallbacks
  ) {
    const column = vscode.window.activeTextEditor
      ? vscode.ViewColumn.Beside
      : vscode.ViewColumn.One;

    if (AutoPushControlPanel.currentPanel) {
      AutoPushControlPanel.currentPanel.currentFolder = folder;
      AutoPushControlPanel.currentPanel.panel.reveal(column);
      AutoPushControlPanel.currentPanel.postState();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "autoPushControlPanel",
      "Auto Push — Contrôle",
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );

    AutoPushControlPanel.currentPanel = new AutoPushControlPanel(panel, context, folder, callbacks);
  }

  public static updateIfVisible(folder?: vscode.WorkspaceFolder) {
    if (AutoPushControlPanel.currentPanel) {
      if (folder) {
        AutoPushControlPanel.currentPanel.currentFolder = folder;
      }
      AutoPushControlPanel.currentPanel.postState();
    }
  }

  public dispose() {
    AutoPushControlPanel.currentPanel = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      const d = this.disposables.pop();
      if (d) d.dispose();
    }
  }

  public postState() {
    if (!this.currentFolder) return;
    const cfg = getConfig(this.currentFolder);
    this.panel.webview.postMessage({
      type: "state",
      data: {
        folderName: this.currentFolder.name,
        folderPath: this.currentFolder.uri.fsPath,
        enabled: cfg.enabled,
        repoName: cfg.repoName,
        githubOwner: cfg.githubOwner,
        branch: cfg.branch,
        publicSiteUrl: cfg.publicSiteUrl,
        includedPaths: cfg.includedPaths,
      },
    });
  }

  private async handleMessage(message: { command: string; payload?: any }) {
    if (!this.currentFolder) return;
    const folder = this.currentFolder;

    switch (message.command) {
      case "activate": {
        await this.handleActivateChoice(folder);
        break;
      }

      case "renameRepo": {
        await this.handleRenameRepo(folder);
        break;
      }

      case "addPath": {
        await this.handleAddPath(folder);
        break;
      }

      case "removePath": {
        const pathToRemove = message.payload?.path;
        if (typeof pathToRemove === "string") {
          const remaining = await removeIncludedPath(folder, pathToRemove);
          this.callbacks.onStateChanged();
          this.postState();
          if (remaining.length === 0) {
            vscode.window.showInformationMessage(
              `"${pathToRemove}" retiré. La sélection est maintenant vide : tout le projet sera publié.`
            );
          } else {
            vscode.window.showInformationMessage(`"${pathToRemove}" retiré de la sélection Auto Push.`);
          }
        }
        break;
      }

      case "publishNow": {
        await this.callbacks.onPublishNow(folder);
        this.postState();
        break;
      }

      case "openPublicSite": {
        const cfg = getConfig(folder);
        if (cfg.publicSiteUrl) {
          vscode.env.openExternal(vscode.Uri.parse(cfg.publicSiteUrl));
        } else {
          vscode.window.showWarningMessage("Aucun site public configuré pour ce projet.");
        }
        break;
      }

      case "openSettings": {
        await vscode.commands.executeCommand("workbench.action.openSettings", "autoPush");
        break;
      }

      case "disableProject": {
        const confirm = await vscode.window.showWarningMessage(
          `Désactiver Auto Push pour "${folder.name}" ?\n\n(Cette action arrête la publication automatique. Les dépôts et sites distants ne sont PAS supprimés).`,
          { modal: true },
          "Désactiver"
        );
        if (confirm === "Désactiver") {
          await setAutoPushEnabled(folder, false);
          vscode.window.showInformationMessage(`Auto Push désactivé pour "${folder.name}".`);
          this.callbacks.onStateChanged();
          this.postState();
        }
        break;
      }
    }
  }

  private async handleActivateChoice(folder: vscode.WorkspaceFolder) {
    const choice = await vscode.window.showQuickPick(
      [
        {
          label: "🌍 Tout le projet",
          description: "Publie l'intégralité du dossier du projet",
          mode: "all",
        },
        {
          label: "🎯 Personnaliser la sélection",
          description: "Choisir un ou plusieurs fichiers ou dossiers spécifiques à publier",
          mode: "custom",
        },
      ],
      {
        placeHolder: "Comment souhaitez-vous publier ce projet ?",
        ignoreFocusOut: true,
      }
    );

    if (!choice) return;

    const wsCfg = vscode.workspace.getConfiguration("autoPush", folder.uri);

    if (choice.mode === "all") {
      await wsCfg.update("includedPaths", [], getTarget());
      await setAutoPushEnabled(folder, true);
      this.callbacks.onStateChanged();
      this.postState();
      vscode.window.showInformationMessage(`Auto Push activé pour tout le projet "${folder.name}". Publication immédiate...`);
      await this.callbacks.onPublishNow(folder);
      this.postState();
    } else if (choice.mode === "custom") {
      const selectedUris = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: true,
        canSelectMany: true,
        defaultUri: folder.uri,
        openLabel: "Sélectionner pour Auto Push",
        title: "Sélectionnez les fichiers ou dossiers à inclure dans Auto Push",
      });

      if (!selectedUris || selectedUris.length === 0) {
        vscode.window.showWarningMessage("Aucun fichier sélectionné. Activation annulée.");
        return;
      }

      const paths: string[] = [];
      for (const u of selectedUris) {
        const rel = normalizePath(path.relative(folder.uri.fsPath, u.fsPath));
        if (rel && !paths.includes(rel)) paths.push(rel);
      }

      await wsCfg.update("includedPaths", paths, getTarget());
      await setAutoPushEnabled(folder, true);
      this.callbacks.onStateChanged();
      this.postState();
      vscode.window.showInformationMessage(
        `Auto Push activé avec ${paths.length} élément(s) sélectionné(s). Publication immédiate...`
      );
      await this.callbacks.onPublishNow(folder);
      this.postState();
    }
  }

  private async handleRenameRepo(folder: vscode.WorkspaceFolder) {
    const cfg = getConfig(folder);
    const oldName = cfg.repoName;

    const newNameInput = await vscode.window.showInputBox({
      prompt: "Nouveau nom pour le dépôt GitHub et le projet :",
      value: oldName,
      ignoreFocusOut: true,
      validateInput: (val) => {
        const sanitized = sanitizeRepoName(val);
        return sanitized ? undefined : "Le nom saisi est invalide.";
      },
    });

    if (!newNameInput) return;
    const newName = sanitizeRepoName(newNameInput);
    if (newName === oldName) return;

    const token = await resolveGithubToken(this.context, true);
    if (!token) {
      vscode.window.showErrorMessage("Token GitHub requis pour renommer le dépôt distant.");
      return;
    }

    try {
      // Renommer sur GitHub si le dépôt existe
      const targetOwner = cfg.githubOwner;
      const renamedInfo = await renameRepo(token, targetOwner, oldName, newName);

      // Mettre à jour l'URL remote git locale si elle existe
      try {
        const git = await ensureGitRepo(folder.uri.fsPath, cfg.branch);
        await git.remote(["set-url", "origin", renamedInfo.cloneUrl]);
        logger.info(`Remote git local 'origin' mis à jour vers : ${renamedInfo.cloneUrl}`);
      } catch (err) {
        logger.warn(`Impossible de mettre à jour le remote git local : ${err}`);
      }

      // Mettre à jour la configuration locale
      const wsCfg = vscode.workspace.getConfiguration("autoPush", folder.uri);
      await wsCfg.update("repoName", newName, getTarget());

      vscode.window.showInformationMessage(`Dépôt distant renommé avec succès en "${newName}".`);
      this.callbacks.onStateChanged();
      this.postState();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Échec du renommage du dépôt : ${msg}`);
      logger.error("Erreur lors du renommage du dépôt", err);
    }
  }

  private async handleAddPath(folder: vscode.WorkspaceFolder) {
    const selectedUris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: true,
      canSelectMany: true,
      defaultUri: folder.uri,
      openLabel: "Ajouter à la sélection",
      title: "Ajouter des fichiers ou dossiers à la sélection Auto Push",
    });

    if (!selectedUris || selectedUris.length === 0) return;

    for (const u of selectedUris) {
      const rel = normalizePath(path.relative(folder.uri.fsPath, u.fsPath));
      if (rel) {
        await addIncludedPath(folder, rel);
      }
    }

    this.callbacks.onStateChanged();
    this.postState();
    vscode.window.showInformationMessage("Élément(s) ajouté(s) à la sélection Auto Push.");
  }

  private getHtml(): string {
    return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Auto Push</title>
<style>
  :root {
    --vscode-font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    --accent: #007acc;
    --accent-hover: #0062a3;
    --accent-orange: #ff8c00;
    --bg-card: var(--vscode-editor-background, #1e1e1e);
    --border: var(--vscode-widget-border, #3c3c3c);
    --text: var(--vscode-foreground, #cccccc);
    --text-muted: var(--vscode-descriptionForeground, #888888);
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: var(--vscode-font-family);
    color: var(--text);
    padding: 1.25rem;
    line-height: 1.5;
  }
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 1.25rem;
    padding-bottom: 0.75rem;
    border-bottom: 1px solid var(--border);
  }
  .title-group {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  h1 { font-size: 1.2rem; font-weight: 600; }
  .status-badge {
    padding: 0.2rem 0.55rem;
    border-radius: 12px;
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
  }
  .status-badge.on { background: rgba(46, 160, 67, 0.2); color: #3fb950; border: 1px solid #2ea043; }
  .status-badge.off { background: rgba(248, 81, 73, 0.2); color: #f85149; border: 1px solid #da3633; }

  .card {
    background: var(--vscode-sideBar-background, #252526);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 1rem;
    margin-bottom: 1rem;
  }
  .card-title {
    font-size: 0.82rem;
    font-weight: 600;
    text-transform: uppercase;
    color: var(--text-muted);
    letter-spacing: 0.5px;
    margin-bottom: 0.6rem;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .repo-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 0.95rem;
    font-weight: 500;
  }
  .edit-icon {
    cursor: pointer;
    font-size: 0.95rem;
    color: var(--text-muted);
    padding: 0.2rem 0.4rem;
    border-radius: 3px;
  }
  .edit-icon:hover { color: var(--text); background: rgba(255,255,255,0.1); }

  /* Blender-style file list */
  .list-box {
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--vscode-input-background, #1e1e1e);
    min-height: 120px;
    max-height: 220px;
    overflow-y: auto;
  }
  .list-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.4rem 0.6rem;
    font-family: ui-monospace, monospace;
    font-size: 0.85rem;
    border-bottom: 1px solid rgba(255,255,255,0.05);
    cursor: pointer;
  }
  .list-item:hover { background: rgba(255,255,255,0.05); }
  .list-item.selected { background: rgba(0, 122, 204, 0.25); color: #fff; }
  .list-item.all-mode {
    font-style: italic;
    color: var(--text-muted);
    cursor: default;
  }
  .list-actions {
    display: flex;
    gap: 0.35rem;
    margin-top: 0.5rem;
    justify-content: flex-end;
  }

  .btn {
    background: var(--vscode-button-background, #0e639c);
    color: var(--vscode-button-foreground, #ffffff);
    border: none;
    padding: 0.45rem 0.9rem;
    border-radius: 3px;
    cursor: pointer;
    font-size: 0.85rem;
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
  }
  .btn:hover { background: var(--vscode-button-hoverBackground, #1177bb); }
  .btn-small { padding: 0.2rem 0.55rem; font-size: 0.85rem; }
  .btn-secondary {
    background: var(--vscode-button-secondaryBackground, #3a3d41);
    color: var(--vscode-button-secondaryForeground, #ffffff);
  }
  .btn-secondary:hover { background: var(--vscode-button-secondaryHoverBackground, #45494e); }
  .btn-danger {
    background: transparent;
    border: 1px solid #da3633;
    color: #f85149;
  }
  .btn-danger:hover {
    background: rgba(218, 54, 51, 0.15);
  }

  .notice-text {
    font-size: 0.8rem;
    color: var(--text-muted);
    margin-top: 0.4rem;
  }
  .links-row {
    display: flex;
    gap: 1rem;
    margin-top: 0.5rem;
    font-size: 0.85rem;
  }
  a { color: #3794ff; text-decoration: none; cursor: pointer; }
  a:hover { text-decoration: underline; }

  /* Inactive state */
  .inactive-card {
    text-align: center;
    padding: 2.5rem 1.5rem;
  }
  .inactive-card h2 { font-size: 1.15rem; margin-bottom: 0.5rem; }
  .inactive-card p { color: var(--text-muted); font-size: 0.9rem; margin-bottom: 1.5rem; }
</style>
</head>
<body>

<div class="header">
  <div class="title-group">
    <h1>Auto Push</h1>
    <span id="statusBadge" class="status-badge off">OFF</span>
  </div>
  <div id="quickLinks" class="links-row" style="display:none;">
    <a id="publicSiteLink" target="_blank">🌐 Site public</a>
    <a id="settingsLink">⚙️ Réglages avancés</a>
  </div>
</div>

<!-- État NON ACTIVÉ -->
<div id="inactiveView" class="card inactive-card">
  <h2 id="inactiveFolderName">Projet</h2>
  <p>Ce projet n'est pas encore synchronisé avec GitHub ni publié publiquement.</p>
  <button id="activateBtn" class="btn" style="padding: 0.6rem 1.4rem; font-size: 0.95rem;">
    ⚡ Activer Auto Push
  </button>
</div>

<!-- État ACTIVÉ -->
<div id="activeView" style="display:none;">
  <!-- Nom du projet -->
  <div class="card">
    <div class="card-title">Dépôt GitHub</div>
    <div class="repo-row">
      <div>
        <span id="repoNameDisplay" style="font-family:ui-monospace, monospace; font-size:1rem;"></span>
        <span id="branchDisplay" style="color:var(--text-muted); font-size:0.8rem; margin-left:0.4rem;"></span>
      </div>
      <span id="renameBtn" class="edit-icon" title="Renommer le dépôt GitHub distant">✏️</span>
    </div>
  </div>

  <!-- Liste Blender des fichiers publiés -->
  <div class="card">
    <div class="card-title">
      <span>Contenu publié</span>
      <span id="selectionSummary" style="font-size:0.75rem; text-transform:none; font-weight:normal;"></span>
    </div>
    <div class="list-box" id="pathsList"></div>
    <div class="list-actions">
      <button id="addPathBtn" class="btn btn-secondary btn-small" title="Ajouter un chemin">+</button>
      <button id="removePathBtn" class="btn btn-secondary btn-small" title="Retirer le chemin sélectionné">−</button>
    </div>
    <div id="emptyNotice" class="notice-text" style="display:none;">
      ℹ️ La sélection est vide : tout le projet sera publié.
    </div>
  </div>

  <!-- Actions -->
  <div style="display:flex; justify-content:space-between; align-items:center; margin-top:1.25rem;">
    <button id="publishNowBtn" class="btn">
      🚀 Publier maintenant
    </button>
    <button id="disableBtn" class="btn btn-danger btn-small">
      Désactiver ce projet
    </button>
  </div>
</div>

<script>
(function() {
  const vscode = acquireVsCodeApi();

  // Elements
  const statusBadge = document.getElementById('statusBadge');
  const inactiveView = document.getElementById('inactiveView');
  const activeView = document.getElementById('activeView');
  const quickLinks = document.getElementById('quickLinks');
  const publicSiteLink = document.getElementById('publicSiteLink');
  const settingsLink = document.getElementById('settingsLink');

  const inactiveFolderName = document.getElementById('inactiveFolderName');
  const activateBtn = document.getElementById('activateBtn');

  const repoNameDisplay = document.getElementById('repoNameDisplay');
  const branchDisplay = document.getElementById('branchDisplay');
  const renameBtn = document.getElementById('renameBtn');

  const pathsList = document.getElementById('pathsList');
  const selectionSummary = document.getElementById('selectionSummary');
  const emptyNotice = document.getElementById('emptyNotice');
  const addPathBtn = document.getElementById('addPathBtn');
  const removePathBtn = document.getElementById('removePathBtn');

  const publishNowBtn = document.getElementById('publishNowBtn');
  const disableBtn = document.getElementById('disableBtn');

  let currentPaths = [];
  let selectedIndex = -1;

  // Réception de l'état depuis l'extension
  window.addEventListener('message', event => {
    const msg = event.data;
    if (msg.type === 'state') {
      render(msg.data);
    }
  });

  function render(data) {
    if (!data.enabled) {
      statusBadge.textContent = 'OFF';
      statusBadge.className = 'status-badge off';
      inactiveView.style.display = 'block';
      activeView.style.display = 'none';
      quickLinks.style.display = 'none';
      inactiveFolderName.textContent = data.folderName;
    } else {
      statusBadge.textContent = 'ON';
      statusBadge.className = 'status-badge on';
      inactiveView.style.display = 'none';
      activeView.style.display = 'block';
      quickLinks.style.display = 'flex';

      repoNameDisplay.textContent = (data.githubOwner ? data.githubOwner + '/' : '') + data.repoName;
      branchDisplay.textContent = '(' + (data.branch || 'main') + ')';

      if (data.publicSiteUrl) {
        publicSiteLink.style.display = 'inline';
        publicSiteLink.href = data.publicSiteUrl;
      } else {
        publicSiteLink.style.display = 'none';
      }

      currentPaths = data.includedPaths || [];
      renderPathsList();
    }
  }

  function renderPathsList() {
    pathsList.innerHTML = '';
    if (currentPaths.length === 0) {
      selectionSummary.textContent = 'Tout le projet';
      emptyNotice.style.display = 'block';
      const item = document.createElement('div');
      item.className = 'list-item all-mode';
      item.textContent = '🌍 Tout le projet (aucun filtre actif)';
      pathsList.appendChild(item);
      removePathBtn.disabled = true;
    } else {
      selectionSummary.textContent = currentPaths.length + ' chemin(s) sélectionné(s)';
      emptyNotice.style.display = 'none';
      removePathBtn.disabled = false;

      currentPaths.forEach((p, idx) => {
        const item = document.createElement('div');
        item.className = 'list-item' + (idx === selectedIndex ? ' selected' : '');
        item.textContent = '🎯 ' + p;
        item.addEventListener('click', () => {
          selectedIndex = idx;
          renderPathsList();
        });
        pathsList.appendChild(item);
      });
    }
  }

  // Événements boutons
  activateBtn.addEventListener('click', () => {
    vscode.postMessage({ command: 'activate' });
  });

  renameBtn.addEventListener('click', () => {
    vscode.postMessage({ command: 'renameRepo' });
  });

  addPathBtn.addEventListener('click', () => {
    vscode.postMessage({ command: 'addPath' });
  });

  removePathBtn.addEventListener('click', () => {
    if (selectedIndex >= 0 && selectedIndex < currentPaths.length) {
      const p = currentPaths[selectedIndex];
      selectedIndex = -1;
      vscode.postMessage({ command: 'removePath', payload: { path: p } });
    } else if (currentPaths.length > 0) {
      // Retirer le dernier si aucun sélectionné
      const p = currentPaths[currentPaths.length - 1];
      vscode.postMessage({ command: 'removePath', payload: { path: p } });
    }
  });

  publishNowBtn.addEventListener('click', () => {
    publishNowBtn.textContent = '⏳ Publication...';
    vscode.postMessage({ command: 'publishNow' });
    setTimeout(() => { publishNowBtn.textContent = '🚀 Publier maintenant'; }, 3000);
  });

  disableBtn.addEventListener('click', () => {
    vscode.postMessage({ command: 'disableProject' });
  });

  settingsLink.addEventListener('click', () => {
    vscode.postMessage({ command: 'openSettings' });
  });
})();
</script>
</body>
</html>`;
  }
}
