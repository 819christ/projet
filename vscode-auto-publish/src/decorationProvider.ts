import * as vscode from "vscode";
import * as path from "path";
import { getConfig, normalizePath } from "./config";

/**
 * Fournit un badge visuel orange dans l'explorateur de fichiers de VS Code :
 * - Mode "tout le projet" : badge unique "AP" sur le dossier racine du workspace uniquement, aucun badge sur les fichiers individuels.
 * - Mode "sélection personnalisée" : badge orange "●" uniquement sur les chemins explicitement listés dans autoPush.includedPaths.
 * - Non sélectionné ou inactif : aucun badge.
 */
export class AutoPushDecorationProvider implements vscode.FileDecorationProvider {
  private _onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations: vscode.Event<vscode.Uri | vscode.Uri[] | undefined> =
    this._onDidChangeFileDecorations.event;

  /**
   * Déclenche un rafraîchissement immédiat de toutes les décorations.
   */
  public refresh(): void {
    this._onDidChangeFileDecorations.fire(undefined);
  }

  provideFileDecoration(
    uri: vscode.Uri,
    _token: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.FileDecoration> {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) return undefined;

    const cfg = getConfig(folder);
    if (!cfg.enabled) return undefined;

    const isRoot = uri.fsPath.replace(/[\\/]+$/, "").toLowerCase() === folder.uri.fsPath.replace(/[\\/]+$/, "").toLowerCase();

    // Mode "tout le projet" : aucun badge sur les fichiers individuels,
    // mais badge unique "AP" sur le dossier racine du workspace.
    if (!cfg.includedPaths || cfg.includedPaths.length === 0) {
      if (isRoot) {
        return {
          badge: "AP",
          color: new vscode.ThemeColor("autoPush.badgeColor"),
          tooltip: "Auto Push : Projet entier sous surveillance",
          propagate: false,
        };
      }
      return undefined;
    }

    // Mode sélection personnalisée : un badge par chemin explicitement listé, pas plus.
    if (isRoot) {
      return undefined;
    }

    const relPath = normalizePath(path.relative(folder.uri.fsPath, uri.fsPath));
    if (!relPath) return undefined;

    const isExplicitlySelected = cfg.includedPaths.includes(relPath);

    if (isExplicitlySelected) {
      return {
        badge: "●",
        color: new vscode.ThemeColor("autoPush.badgeColor"),
        tooltip: "Auto Push : Inclus dans la sélection personnalisée",
        propagate: false,
      };
    }

    return undefined;
  }
}
