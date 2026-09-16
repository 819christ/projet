import * as fs from "fs";
import * as path from "path";
import ignore, { Ignore } from "ignore";
import { normalizePath } from "./config";
import { logger } from "./logger";

export interface SiteMeta {
  projectName: string;
  repoHtmlUrl: string;
  branch: string;
}

const MAX_FILE_BYTES = 1024 * 1024; // 1 Mo max par fichier affichable
const SHELL_VERSION = "v2-dynamic-1";

// Exporte pour réutilisation dans le scan de secrets (Point 4)
export function isLikelyBinary(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  const binaryExtensions = new Set([
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".svg",
    ".pdf", ".zip", ".tar", ".gz", ".7z", ".rar",
    ".exe", ".dll", ".so", ".dylib", ".bin",
    ".mp3", ".mp4", ".wav", ".avi", ".mov",
    ".ttf", ".woff", ".woff2", ".eot",
    ".sqlite", ".db", ".wasm",
  ]);
  return binaryExtensions.has(ext);
}

function loadIgnore(workspaceRoot: string, extraIgnorePatterns: string[]): Ignore {
  const ig = ignore();
  ig.add([
    ".git",
    "node_modules",
    "out",
    "dist",
    "build",
    ".env",
    ".env.*",
    "*.log",
    ".DS_Store",
    "Thumbs.db",
    "docs",
  ]);

  const gitignorePath = path.join(workspaceRoot, ".gitignore");
  if (fs.existsSync(gitignorePath)) {
    try {
      const content = fs.readFileSync(gitignorePath, "utf8");
      ig.add(content);
    } catch (err) {
      logger.warn(`Impossible de lire .gitignore: ${err}`);
    }
  }

  if (extraIgnorePatterns && extraIgnorePatterns.length > 0) {
    ig.add(extraIgnorePatterns);
  }

  return ig;
}

function walk(dir: string, rootDir: string, ig: Ignore, results: string[]) {
  let list: string[];
  try {
    list = fs.readdirSync(dir);
  } catch {
    return;
  }

  for (const file of list) {
    const fullPath = path.join(dir, file);
    const rel = path.relative(rootDir, fullPath).split(path.sep).join("/");

    if (!rel) continue;

    if (ig.ignores(rel) || ig.ignores(rel + "/")) {
      continue;
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(fullPath);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      walk(fullPath, rootDir, ig, results);
    } else if (stat.isFile()) {
      results.push(rel);
    }
  }
}

// Extraction de la collecte des chemins (Point 4)
export function collectRelPaths(
  workspaceRoot: string,
  extraIgnorePatterns: string[],
  includedPaths: string[]
): string[] {
  const ig = loadIgnore(workspaceRoot, extraIgnorePatterns);
  const relPaths: string[] = [];

  if (!includedPaths || includedPaths.length === 0) {
    walk(workspaceRoot, workspaceRoot, ig, relPaths);
  } else {
    for (const item of includedPaths) {
      const norm = normalizePath(item);
      if (!norm) continue;
      const fullPath = path.join(workspaceRoot, norm);
      if (!fs.existsSync(fullPath)) continue;
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        walk(fullPath, workspaceRoot, ig, relPaths);
      } else if (stat.isFile()) {
        const rel = path.relative(workspaceRoot, fullPath).split(path.sep).join("/");
        if (!ig.ignores(rel)) relPaths.push(rel);
      }
    }
  }
  return Array.from(new Set(relPaths)).sort((a, b) => a.localeCompare(b));
}

// Nouvelle fonction generateSite basée sur le manifeste (Point 5)
export function generateSite(
  workspaceRoot: string,
  extraIgnorePatterns: string[],
  includedPaths: string[],
  meta: SiteMeta
): number {
  const docsDir = path.join(workspaceRoot, "docs");
  fs.mkdirSync(docsDir, { recursive: true });

  const uniqueRelPaths = collectRelPaths(workspaceRoot, extraIgnorePatterns, includedPaths);
  const manifestFiles: { p: string; s: number }[] = [];

  for (const relPath of uniqueRelPaths) {
    const srcPath = path.join(workspaceRoot, relPath);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(srcPath);
    } catch {
      continue;
    }
    if (stat.size > MAX_FILE_BYTES) {
      logger.warn(`Fichier ignoré (trop volumineux pour le site public): ${relPath}`);
      continue;
    }
    if (isLikelyBinary(srcPath)) continue;
    manifestFiles.push({ p: relPath, s: stat.size });
  }

  // Le manifeste (léger, texte seul) est régénéré à chaque publication.
  const manifest = {
    generatedAt: new Date().toISOString(),
    projectName: meta.projectName,
    repoHtmlUrl: meta.repoHtmlUrl,
    branch: meta.branch,
    files: manifestFiles,
  };
  fs.writeFileSync(path.join(docsDir, "manifest.json"), JSON.stringify(manifest), "utf8");

  // La coquille (HTML/CSS/JS) n'est (re)générée que si absente ou si sa version a changé
  const indexPath = path.join(docsDir, "index.html");
  const ownerRepo = extractOwnerRepo(meta.repoHtmlUrl);
  const needsShellRewrite =
    !fs.existsSync(indexPath) ||
    !fs.readFileSync(indexPath, "utf8").includes(`SHELL_VERSION:${SHELL_VERSION}`);

  if (needsShellRewrite && ownerRepo) {
    const shell = buildDynamicShellHtml(meta, ownerRepo.owner, ownerRepo.repo);
    fs.writeFileSync(indexPath, shell, "utf8");
    logger.info("Coquille du site (docs/index.html) régénérée.");
  }

  logger.info(`Manifeste régénéré : ${manifestFiles.length} fichier(s) publiés.`);
  return manifestFiles.length;
}

function extractOwnerRepo(repoHtmlUrl: string): { owner: string; repo: string } | null {
  const m = repoHtmlUrl.match(/github\.com\/([^/]+)\/([^/]+)\/?$/);
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

function escapeHtml(unsafe: string): string {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function buildDynamicShellHtml(meta: SiteMeta, owner: string, repo: string): string {
  return `<!-- SHELL_VERSION:${SHELL_VERSION} -->
<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escapeHtml(meta.projectName)} — code source (lecture seule)</title>
<meta name="robots" content="index,follow" />
<style>
  :root {
    --bg-main: #1e1e1e; --bg-sidebar: #252526; --bg-header: #333333;
    --bg-hover: #2a2d2e; --bg-selected: #37373d; --text-main: #cccccc;
    --text-bright: #ffffff; --text-muted: #888888; --accent: #007acc;
    --accent-orange: #ff8c00; --border: #3c3c3c; --code-bg: #1e1e1e;
    --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: var(--bg-main); color: var(--text-main); display: flex; flex-direction: column; height: 100vh; overflow: hidden; }
  header { background: var(--bg-header); border-bottom: 1px solid var(--border); padding: 0.6rem 1rem; display: flex; align-items: center; justify-content: space-between; flex-shrink: 0; gap: 1rem; }
  .header-left { display: flex; align-items: center; gap: 0.75rem; min-width: 0; }
  .project-title { font-size: 1.05rem; font-weight: 600; color: var(--text-bright); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .badge-branch { background: #0e639c; color: #fff; padding: 0.15rem 0.45rem; border-radius: 3px; font-size: 0.75rem; font-family: var(--font-mono); }
  .header-links a { color: var(--text-muted); text-decoration: none; font-size: 0.85rem; }
  .header-links a:hover { color: var(--text-bright); text-decoration: underline; }
  .layout { display: flex; flex: 1; min-height: 0; }
  aside { width: 320px; background: var(--bg-sidebar); border-right: 1px solid var(--border); display: flex; flex-direction: column; flex-shrink: 0; }
  .sidebar-search { padding: 0.5rem; border-bottom: 1px solid var(--border); }
  .search-input { width: 100%; background: #3c3c3c; border: 1px solid transparent; color: var(--text-bright); padding: 0.4rem 0.6rem; border-radius: 3px; font-size: 0.85rem; outline: none; }
  .search-input:focus { border-color: var(--accent); }
  .sidebar-header { padding: 0.4rem 0.8rem; font-size: 0.75rem; font-weight: 700; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; display: flex; justify-content: space-between; align-items: center; }
  .tree-container { flex: 1; overflow-y: auto; padding: 0.25rem 0; font-family: var(--font-mono); font-size: 0.85rem; }
  .tree-node { user-select: none; }
  .tree-row { display: flex; align-items: center; padding: 0.22rem 0.5rem; cursor: pointer; border-radius: 2px; white-space: nowrap; }
  .tree-row:hover { background: var(--bg-hover); }
  .tree-row.active { background: var(--bg-selected); color: var(--text-bright); font-weight: 600; }
  .chevron { width: 16px; text-align: center; display: inline-block; color: var(--text-muted); font-size: 0.7rem; transition: transform 0.12s; }
  .chevron.open { transform: rotate(90deg); }
  .icon { margin-right: 0.35rem; font-size: 0.9rem; }
  .label { overflow: hidden; text-overflow: ellipsis; }
  .tree-children { display: none; }
  .tree-children.open { display: block; }
  main { flex: 1; display: flex; flex-direction: column; min-width: 0; background: var(--bg-main); }
  .file-toolbar { background: var(--bg-sidebar); border-bottom: 1px solid var(--border); padding: 0.4rem 1rem; display: flex; align-items: center; justify-content: space-between; font-size: 0.85rem; flex-shrink: 0; }
  .file-path { font-family: var(--font-mono); color: var(--text-bright); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .file-actions { display: flex; align-items: center; gap: 0.5rem; flex-shrink: 0; }
  .btn { background: #3a3d41; border: 1px solid #454545; color: var(--text-bright); padding: 0.25rem 0.6rem; border-radius: 3px; cursor: pointer; font-size: 0.8rem; text-decoration: none; display: inline-flex; align-items: center; gap: 0.3rem; }
  .btn:hover { background: #45494e; }
  .editor-wrapper { flex: 1; overflow: auto; display: flex; background: var(--code-bg); }
  .code-viewer { counter-reset: line; font-family: var(--font-mono); font-size: 0.85rem; line-height: 1.45; padding: 1rem 0; width: 100%; overflow-x: auto; }
  .code-line { counter-increment: line; display: flex; min-height: 1.45em; padding: 0 1rem 0 0; }
  .code-line:hover { background: rgba(255,255,255,0.03); }
  .code-line::before { content: counter(line); display: inline-block; width: 3.5em; padding-right: 1.2em; text-align: right; color: #6e7681; user-select: none; flex-shrink: 0; border-right: 1px solid var(--border); margin-right: 1em; }
  .line-text { white-space: pre; color: #e6edf3; tab-size: 2; }
  .empty-state { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 2rem; text-align: center; color: var(--text-muted); }
  .empty-state h2 { color: var(--text-bright); margin-bottom: 0.75rem; font-size: 1.3rem; }
  .empty-state p { max-width: 520px; line-height: 1.5; font-size: 0.95rem; margin-bottom: 1rem; }
  .instruction-box { background: #252526; border: 1px solid var(--border); border-radius: 6px; padding: 1rem 1.5rem; max-width: 600px; text-align: left; color: var(--text-main); font-size: 0.88rem; line-height: 1.6; }
  .instruction-box strong { color: var(--accent-orange); }
  .status-msg { padding: 2rem; color: var(--text-muted); }
  @media (max-width: 768px) { aside { width: 220px; } }
</style>
</head>
<body>
<header>
  <div class="header-left">
    <span class="project-title">${escapeHtml(meta.projectName)}</span>
    <span class="badge-branch" id="branchBadge">${escapeHtml(meta.branch)}</span>
    <span style="color:var(--text-muted); font-size:0.8rem;">(Lecture seule)</span>
  </div>
  <div class="header-links">
    <a href="https://github.com/${owner}/${repo}" target="_blank" rel="noopener">Dépôt GitHub ↗</a>
  </div>
</header>
<div class="layout">
  <aside>
    <div class="sidebar-search">
      <input type="text" id="searchInput" class="search-input" placeholder="🔍 Filtrer les fichiers..." />
    </div>
    <div class="sidebar-header">
      <span id="fileCount">Chargement...</span>
      <span style="font-size:0.75rem; cursor:pointer;" id="toggleTreeBtn">Tout déplier</span>
    </div>
    <div class="tree-container" id="treeContainer"><div class="status-msg">Chargement de l'arborescence...</div></div>
  </aside>
  <main>
    <div class="file-toolbar" id="fileToolbar" style="display:none;">
      <div class="file-path" id="activeFilePath"></div>
      <div class="file-actions">
        <span id="activeFileSize" style="color:var(--text-muted);"></span>
        <button class="btn" id="copyBtn">📋 Copier</button>
        <a class="btn" id="rawLink" target="_blank">🔗 Fichier brut</a>
      </div>
    </div>
    <div class="editor-wrapper" id="editorWrapper" style="display:none;">
      <div class="code-viewer" id="codeViewer"></div>
    </div>
    <div class="empty-state" id="emptyState">
      <h2>${escapeHtml(meta.projectName)}</h2>
      <p>Sélectionnez un fichier dans l'arborescence à gauche pour afficher son contenu.</p>
      <div class="instruction-box">
        <strong>💡 Utilisation pour assistants IA (Claude, ChatGPT, Gemini, Grok) :</strong><br/>
        Cette URL publique donne un accès direct en lecture seule aux fichiers de ce projet, chargés en direct depuis GitHub à chaque ouverture — toujours à jour, même juste après une publication.<br/><br/>
        <em id="lastGen">Chargement...</em>
      </div>
    </div>
  </main>
</div>

<script>
(function() {
  var OWNER = ${JSON.stringify(owner)};
  var REPO = ${JSON.stringify(repo)};
  var BRANCH = ${JSON.stringify(meta.branch)};

  var treeContainer = document.getElementById('treeContainer');
  var activeFilePath = document.getElementById('activeFilePath');
  var activeFileSize = document.getElementById('activeFileSize');
  var fileToolbar = document.getElementById('fileToolbar');
  var editorWrapper = document.getElementById('editorWrapper');
  var emptyState = document.getElementById('emptyState');
  var codeViewer = document.getElementById('codeViewer');
  var rawLink = document.getElementById('rawLink');
  var copyBtn = document.getElementById('copyBtn');
  var searchInput = document.getElementById('searchInput');
  var toggleTreeBtn = document.getElementById('toggleTreeBtn');
  var fileCountEl = document.getElementById('fileCount');
  var branchBadge = document.getElementById('branchBadge');
  var lastGenEl = document.getElementById('lastGen');

  var currentActiveRow = null;
  var currentBranch = BRANCH || 'main';
  var currentFilePath = null;
  var currentFileContent = null;

  function formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' octets';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' Ko';
    return (bytes / 1048576).toFixed(1) + ' Mo';
  }

  function rawUrl(filePath) {
    return 'https://raw.githubusercontent.com/' + OWNER + '/' + REPO + '/' + currentBranch + '/' + filePath.split('/').map(encodeURIComponent).join('/');
  }

  function buildTree(files) {
    var root = { name: '', isDir: true, children: {}, path: '' };
    files.forEach(function(file) {
      var parts = file.p.split('/');
      var curr = root, accumulated = '';
      for (var i = 0; i < parts.length; i++) {
        var part = parts[i];
        accumulated = accumulated ? accumulated + '/' + part : part;
        var isLast = (i === parts.length - 1);
        if (!curr.children[part]) {
          curr.children[part] = { name: part, isDir: !isLast, path: accumulated, children: isLast ? null : {} };
        }
        curr = curr.children[part];
      }
    });
    return root;
  }

  function renderTree(node, container, depth) {
    var keys = Object.keys(node.children || {}).sort(function(a, b) {
      var na = node.children[a], nb = node.children[b];
      if (na.isDir !== nb.isDir) return na.isDir ? -1 : 1;
      return a.localeCompare(b);
    });
    keys.forEach(function(key) {
      var item = node.children[key];
      var nodeEl = document.createElement('div');
      nodeEl.className = 'tree-node';
      nodeEl.setAttribute('data-path', item.path);
      var rowEl = document.createElement('div');
      rowEl.className = 'tree-row';
      rowEl.style.paddingLeft = (depth * 14 + 8) + 'px';

      if (item.isDir) {
        var chevron = document.createElement('span'); chevron.className = 'chevron'; chevron.textContent = '▶';
        var icon = document.createElement('span'); icon.className = 'icon'; icon.textContent = '📁';
        var label = document.createElement('span'); label.className = 'label'; label.textContent = item.name;
        rowEl.appendChild(chevron); rowEl.appendChild(icon); rowEl.appendChild(label);
        nodeEl.appendChild(rowEl);
        var childrenEl = document.createElement('div'); childrenEl.className = 'tree-children';
        renderTree(item, childrenEl, depth + 1);
        nodeEl.appendChild(childrenEl);
        rowEl.addEventListener('click', function() {
          var isOpen = childrenEl.classList.toggle('open');
          chevron.classList.toggle('open', isOpen);
          icon.textContent = isOpen ? '📂' : '📁';
        });
      } else {
        var spacer = document.createElement('span'); spacer.className = 'chevron';
        var icon2 = document.createElement('span'); icon2.className = 'icon'; icon2.textContent = '📄';
        var label2 = document.createElement('span'); label2.className = 'label'; label2.textContent = item.name;
        rowEl.appendChild(spacer); rowEl.appendChild(icon2); rowEl.appendChild(label2);
        nodeEl.appendChild(rowEl);
        rowEl.addEventListener('click', function() { selectFile(item.path, item.size, rowEl); });
      }
      container.appendChild(nodeEl);
    });
  }

  function selectFile(filePath, size, rowEl) {
    if (currentActiveRow) currentActiveRow.classList.remove('active');
    currentActiveRow = rowEl;
    if (rowEl) rowEl.classList.add('active');
    currentFilePath = filePath;

    activeFilePath.textContent = filePath;
    activeFileSize.textContent = formatBytes(size || 0);
    rawLink.href = rawUrl(filePath);

    emptyState.style.display = 'none';
    fileToolbar.style.display = 'flex';
    editorWrapper.style.display = 'flex';
    codeViewer.innerHTML = '<div class="status-msg">Chargement du contenu depuis GitHub...</div>';

    fetch(rawUrl(filePath) + '?t=' + Date.now())
      .then(function(res) { if (!res.ok) throw new Error('HTTP ' + res.status); return res.text(); })
      .then(function(text) {
        currentFileContent = text;
        var lines = text.split('\\n');
        codeViewer.innerHTML = '';
        var frag = document.createDocumentFragment();
        for (var i = 0; i < lines.length; i++) {
          var lineDiv = document.createElement('div'); lineDiv.className = 'code-line';
          var textSpan = document.createElement('span'); textSpan.className = 'line-text';
          textSpan.textContent = lines[i] || ' ';
          lineDiv.appendChild(textSpan);
          frag.appendChild(lineDiv);
        }
        codeViewer.appendChild(frag);
      })
      .catch(function(err) {
        codeViewer.innerHTML = '<div class="status-msg">Impossible de charger ce fichier (' + err.message + '). Réessaie dans quelques instants.</div>';
      });
  }

  copyBtn.addEventListener('click', function() {
    if (!currentFileContent) return;
    navigator.clipboard.writeText(currentFileContent).then(function() {
      copyBtn.textContent = '✅ Copié !';
      setTimeout(function() { copyBtn.textContent = '📋 Copier'; }, 2000);
    });
  });

  searchInput.addEventListener('input', function() {
    var q = searchInput.value.toLowerCase().trim();
    var allNodes = treeContainer.querySelectorAll('.tree-node');
    if (!q) { allNodes.forEach(function(el) { el.style.display = ''; }); return; }
    allNodes.forEach(function(el) {
      var p = el.getAttribute('data-path') || '';
      var isMatch = p.toLowerCase().indexOf(q) !== -1;
      if (isMatch) {
        el.style.display = '';
        var parent = el.parentElement;
        while (parent && parent.classList.contains('tree-children')) {
          parent.classList.add('open');
          var prev = parent.previousElementSibling;
          if (prev) {
            var ch = prev.querySelector('.chevron'); if (ch) ch.classList.add('open');
            var ic = prev.querySelector('.icon'); if (ic) ic.textContent = '📂';
          }
          parent = parent.parentElement ? parent.parentElement.parentElement : null;
        }
      } else {
        var hasMatch = el.querySelector('.tree-node[data-path*="' + q + '"]');
        el.style.display = hasMatch ? '' : 'none';
      }
    });
  });

  var allExpanded = false;
  toggleTreeBtn.addEventListener('click', function() {
    allExpanded = !allExpanded;
    treeContainer.querySelectorAll('.tree-children').forEach(function(c) { c.classList.toggle('open', allExpanded); });
    treeContainer.querySelectorAll('.chevron').forEach(function(ch) { ch.classList.toggle('open', allExpanded); });
    treeContainer.querySelectorAll('.icon').forEach(function(ic) {
      if (ic.textContent === '📁' || ic.textContent === '📂') ic.textContent = allExpanded ? '📂' : '📁';
    });
    toggleTreeBtn.textContent = allExpanded ? 'Tout replier' : 'Tout déplier';
  });

  function loadManifest() {
    var url = 'https://raw.githubusercontent.com/' + OWNER + '/' + REPO + '/' + encodeURIComponent(currentBranch) + '/docs/manifest.json?t=' + Date.now();
    fetch(url)
      .then(function(res) { if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); })
      .then(function(manifest) {
        currentBranch = manifest.branch || BRANCH || 'main';
        branchBadge.textContent = currentBranch;
        fileCountEl.textContent = manifest.files.length + ' fichier(s)';
        lastGenEl.textContent = 'Dernière publication : ' + new Date(manifest.generatedAt).toLocaleString('fr-FR');

        var flatFiles = {};
        manifest.files.forEach(function(f) { flatFiles[f.p] = f.s; });
        var root = buildTree(manifest.files);

        (function annotate(node) {
          Object.keys(node.children || {}).forEach(function(k) {
            var item = node.children[k];
            if (!item.isDir) item.size = flatFiles[item.path];
            else annotate(item);
          });
        })(root);

        treeContainer.innerHTML = '';
        renderTree(root, treeContainer, 0);

        var firstLevel = treeContainer.querySelectorAll(':scope > .tree-node > .tree-children');
        firstLevel.forEach(function(fl) {
          fl.classList.add('open');
          var row = fl.previousElementSibling;
          if (row) {
            var ch = row.querySelector('.chevron'); if (ch) ch.classList.add('open');
            var ic = row.querySelector('.icon'); if (ic) ic.textContent = '📂';
          }
        });

        if (manifest.files.length > 0) {
          var firstPath = manifest.files[0].p;
          var firstRow = treeContainer.querySelector('.tree-node[data-path="' + firstPath + '"] > .tree-row');
          selectFile(firstPath, manifest.files[0].s, firstRow);
        }
      })
      .catch(function(err) {
        treeContainer.innerHTML = '<div class="status-msg">Impossible de charger la liste des fichiers (' + err.message + '). Réessaie dans quelques instants — le manifeste vient peut-être d\\'être publié.</div>';
      });
  }

  loadManifest();
})();
</script>
</body>
</html>
`;
}