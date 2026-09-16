import simpleGit, { SimpleGit } from "simple-git";
import * as fs from "fs";
import * as path from "path";
import { logger } from "./logger";

/**
 * Construit l'argument `-c http.extraHeader=...` attendu par git pour s'authentifier
 * sur cette seule commande, sans jamais écrire le token dans .git/config.
 */
export function extraHeaderConfigArg(token: string): string {
  // GitHub accepte "x-access-token:<token>" comme identifiants Basic pour un push HTTPS.
  const encoded = Buffer.from(`x-access-token:${token}`).toString("base64");
  return `http.extraHeader=AUTHORIZATION: basic ${encoded}`;
}

export async function ensureGitRepo(workspaceRoot: string, branch: string): Promise<SimpleGit> {
  const git = simpleGit(workspaceRoot);
  const isRepo = fs.existsSync(path.join(workspaceRoot, ".git"));

  if (!isRepo) {
    logger.info("Initialisation d'un nouveau dépôt git local...");
    await git.init();
    await git.checkoutLocalBranch(branch);
  } else {
    const branches = await git.branchLocal();
    if (!branches.all.includes(branch)) {
      await git.checkoutLocalBranch(branch);
    } else {
      await git.checkout(branch);
    }
  }

  return git;
}

export async function ensureRemote(git: SimpleGit, cloneUrl: string): Promise<void> {
  const remotes = await git.getRemotes(true);
  const origin = remotes.find((r) => r.name === "origin");

  if (!origin) {
    await git.addRemote("origin", cloneUrl);
  } else if (origin.refs.push !== cloneUrl) {
    await git.remote(["set-url", "origin", cloneUrl]);
  }
}

export interface CommitResult {
  committed: boolean;
  pushed: boolean;
  sha?: string;
}

/**
 * Ajoute les fichiers (tout ou liste blanche), commit s'il y a des changements, puis push.
 * Le token n'est jamais écrit dans .git/config : il est passé via -c http.extraHeader
 * uniquement pour la commande push en cours.
 */
export async function commitAndPush(
  git: SimpleGit,
  branch: string,
  token: string,
  commitMessage: string,
  includedPaths: string[] = [],
  workspaceRoot?: string
): Promise<CommitResult> {
  if (!includedPaths || includedPaths.length === 0) {
    logger.info("git add -A (tout le projet)");
    await git.add(["-A"]);
  } else {
    // Retirer du suivi git les fichiers trackés qui ne sont plus dans la sélection
    try {
      const lsOutput = await git.raw(["ls-files"]);
      const trackedFiles = lsOutput.split(/\r?\n/).map((f) => f.trim()).filter(Boolean);
      const docsPrefix = "docs/";
      const selectedPaths = includedPaths;
      const filesToUntrack = trackedFiles.filter((f) => {
        if (f === "docs" || f.startsWith(docsPrefix)) return false; // toujours conserver docs/
        if (f === ".autopushignore") return false;
        return !selectedPaths.some((sel) => f === sel || f.startsWith(sel + "/"));
      });
      if (filesToUntrack.length > 0) {
        logger.info(`Untrack des fichiers hors sélection : ${filesToUntrack.join(", ")}`);
        await git.rm(["-r", "--cached", "--ignore-unmatch", ...filesToUntrack]);
      }
    } catch (err) {
      logger.warn(`Erreur lors de la vérification ls-files/rm : ${err}`);
    }

    const pathsToAdd = [...includedPaths];
    const root = workspaceRoot || process.cwd();
    if (fs.existsSync(path.join(root, "docs"))) {
      pathsToAdd.push("docs");
    }
    if (fs.existsSync(path.join(root, ".autopushignore"))) {
      pathsToAdd.push(".autopushignore");
    }
    logger.info(`git add (sélection) : ${pathsToAdd.join(", ")}`);
    await git.add(pathsToAdd);
  }

  const status = await git.status();
  logger.info(`Statut après git add — staged: [${status.staged.join(", ")}]`);

  if (
    status.staged.length === 0 &&
    status.created.length === 0 &&
    status.deleted.length === 0 &&
    status.modified.length === 0
  ) {
    logger.info("Rien à publier : aucun changement détecté.");
    return { committed: false, pushed: false };
  }

  const commitSummary = await git.commit(commitMessage);
  logger.info(`Commit créé: ${commitSummary.commit}`);

  await git.raw([
    "-c",
    extraHeaderConfigArg(token),
    "push",
    "-u",
    "origin",
    branch,
  ]);

  logger.info(`Push effectué sur origin/${branch}.`);
  return { committed: true, pushed: true, sha: commitSummary.commit };
}

/**
 * Untrack un chemin du suivi git (git rm -r --cached) sans toucher au fichier local,
 * puis commit et push.
 */
export async function untrackPathAndPush(
  git: SimpleGit,
  branch: string,
  token: string,
  relPath: string,
  workspaceRoot: string
): Promise<boolean> {
  logger.info(`Untrack git de : ${relPath}`);
  try {
    await git.rm(["-r", "--cached", "--ignore-unmatch", relPath]);
  } catch (err) {
    logger.warn(`Avertissement git rm --cached: ${err}`);
  }

  const pathsToAdd: string[] = [];
  if (fs.existsSync(path.join(workspaceRoot, ".autopushignore"))) {
    pathsToAdd.push(".autopushignore");
  }
  if (fs.existsSync(path.join(workspaceRoot, "docs"))) {
    pathsToAdd.push("docs");
  }
  if (pathsToAdd.length > 0) {
    await git.add(pathsToAdd);
  }

  const status = await git.status();
  if (
    status.staged.length === 0 &&
    status.deleted.length === 0 &&
    status.modified.length === 0
  ) {
    logger.info("Aucun changement de suivi à committer.");
    return false;
  }

  const commitSummary = await git.commit(`Auto Push: dépublication de ${relPath}`);
  logger.info(`Commit de dépublication créé: ${commitSummary.commit}`);

  await git.raw([
    "-c",
    extraHeaderConfigArg(token),
    "push",
    "-u",
    "origin",
    branch,
  ]);

  logger.info(`Push de dépublication effectué sur origin/${branch}.`);
  return true;
}

/**
 * Routine de migration Priorité 0 :
 * Si public/ est suivi dans git ou existe en local avec du contenu généré,
 * nettoie git et le disque local, puis committe et pousse la suppression.
 */
export async function cleanupResidualPublic(
  git: SimpleGit,
  workspaceRoot: string,
  token: string,
  branch: string
): Promise<boolean> {
  const publicDir = path.join(workspaceRoot, "public");
  let needsGitCleanup = false;

  try {
    const lsOutput = await git.raw(["ls-files", "public"]);
    if (lsOutput.trim().length > 0) {
      needsGitCleanup = true;
    }
  } catch {
    // Si la commande échoue (dépôt vide ou non initialisé), on ignore
  }

  const localExists = fs.existsSync(publicDir);

  if (!needsGitCleanup && !localExists) {
    return false;
  }

  logger.info("Migration Priorité 0 : vérification du résidu public/...");

  // 1. Untrack git
  if (needsGitCleanup) {
    try {
      await git.rm(["-r", "--cached", "--ignore-unmatch", "public"]);
      logger.info("public/ retiré du suivi git via git rm --cached.");
    } catch (err) {
      logger.warn(`Erreur git rm --cached public: ${err}`);
    }
  }

  // 2. Suppression locale si c'est du contenu généré par l'ancienne version
  if (localExists) {
    try {
      const indexHtmlPath = path.join(publicDir, "index.html");
      let isGenerated = false;
      if (fs.existsSync(indexHtmlPath)) {
        const indexContent = fs.readFileSync(indexHtmlPath, "utf8");
        if (
          indexContent.includes("lecture seule") ||
          indexContent.includes("Auto-Publish") ||
          indexContent.includes("Auto Push")
        ) {
          isGenerated = true;
        }
      }
      if (isGenerated) {
        fs.rmSync(publicDir, { recursive: true, force: true });
        logger.info("Dossier local public/ généré supprimé.");
      }
    } catch (err) {
      logger.warn(`Impossible de supprimer le dossier local public/: ${err}`);
    }
  }

  // 3. Si git a des suppressions enregistrées, committer et pousser
  const status = await git.status();
  const hasPublicStaged =
    status.deleted.some((d) => d.startsWith("public/") || d === "public") ||
    status.staged.some((s) => s.startsWith("public/") || s === "public");

  if (hasPublicStaged) {
    try {
      await git.commit("Auto Push: migration et suppression du dossier public résiduel");
      logger.info("Commit de migration public/ -> docs/ créé.");
      await git.raw([
        "-c",
        extraHeaderConfigArg(token),
        "push",
        "-u",
        "origin",
        branch,
      ]);
      logger.info("Nettoyage de public/ poussé sur GitHub avec succès.");
      return true;
    } catch (err) {
      logger.warn(`Échec du push lors de la suppression de public/: ${err}`);
    }
  }

  return false;
}

