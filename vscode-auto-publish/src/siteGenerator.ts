import * as fs from "fs";
import * as path from "path";
import ignoreFactory from "ignore";
import { logger } from "./logger";
import { normalizePath } from "./config";

// Exclusion stricte : docs (nouveau dossier) ET public (ancien dossier résiduel) ne doivent jamais être scannés
const HARD_EXCLUDED_DIRS = new Set([".git", "node_modules", "out", "docs", "public", ".vscode-test"]);
const MAX_FILE_BYTES = 2 * 1024 * 1024; // 2 Mo : au-delà on ignore le fichier du site public

export function loadIgnore(workspaceRoot: string, extraPatterns: string[]) {
  const ig = ignoreFactory();
  ig.add([".git", "node_modules", "docs", "public", ...extraPatterns]);

  const gitignorePath = path.join(workspaceRoot, ".gitignore");
  if (fs.existsSync(gitignorePath)) {
    ig.add(fs.readFileSync(gitignorePath, "utf8"));
  }

  const autoPushIgnorePath = path.join(workspaceRoot, ".autopushignore");
  if (fs.existsSync(autoPushIgnorePath)) {
    ig.add(fs.readFileSync(autoPushIgnorePath, "utf8"));
  }

  return ig;
}

export function addToAutoPushIgnore(workspaceRoot: string, relPath: string): void {
  const norm = normalizePath(relPath);
  if (!norm) return;
  const autoPushIgnorePath = path.join(workspaceRoot, ".autopushignore");
  let content = "";
  if (fs.existsSync(autoPushIgnorePath)) {
    content = fs.readFileSync(autoPushIgnorePath, "utf8");
    const lines = content.split(/\r?\n/).map((l) => l.trim());
    if (lines.includes(norm)) {
      return; // déjà présent
    }
  }
  const prefix = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
  fs.appendFileSync(autoPushIgnorePath, `${prefix}${norm}\n`, "utf8");
  logger.info(`Chemin ajouté à .autopushignore : ${norm}`);
}

export function isLikelyBinary(filePath: string): boolean {
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(8000);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    for (let i = 0; i < bytesRead; i++) {
      if (buffer[i] === 0) return true; // octet nul -> quasi certainement binaire
    }
    return false;
  } finally {
    fs.closeSync(fd);
  }
}

function walk(dir: string, workspaceRoot: string, ig: ReturnType<typeof ignoreFactory>, out: string[]) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (HARD_EXCLUDED_DIRS.has(entry.name)) continue;

    if (entry.name.startsWith(".") && entry.name !== ".gitignore" && entry.name !== ".autopushignore") {
      if (HARD_EXCLUDED_DIRS.has(entry.name)) continue;
    }

    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(workspaceRoot, fullPath).split(path.sep).join("/");

    if (ig.ignores(relPath)) continue;

    if (entry.isDirectory()) {
      walk(fullPath, workspaceRoot, ig, out);
    } else if (entry.isFile()) {
      out.push(relPath);
    }
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface SiteMeta {
  repoHtmlUrl: string;
  publicSiteUrl: string;
  projectName: string;
  branch: string;
}

interface StoredFile {
  path: string;
  size: number;
  content: string;
}

/**
 * Régénère entièrement workspaceRoot/docs :
 * 1. Copie les fichiers bruts dans docs/files/<chemin relatif>
 * 2. Génère docs/index.html comme SPA navigable avec arborescence dépliable, visionneuse et recherche.
 */
export function generateSite(
  workspaceRoot: string,
  extraIgnorePatterns: string[],
  includedPaths: string[],
  meta: SiteMeta
): number {
  const docsDir = path.join(workspaceRoot, "docs");
  const filesDir = path.join(docsDir, "files");

  // Repartir d'un dossier propre à chaque publication pour refléter les suppressions.
  if (fs.existsSync(docsDir)) {
    fs.rmSync(docsDir, { recursive: true, force: true });
  }
  fs.mkdirSync(filesDir, { recursive: true });

  const ig = loadIgnore(workspaceRoot, extraIgnorePatterns);
  const relPaths: string[] = [];

  if (!includedPaths || includedPaths.length === 0) {
    // Tout le projet
    walk(workspaceRoot, workspaceRoot, ig, relPaths);
  } else {
    // Publication sélective : uniquement les chemins inclus
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
        if (!ig.ignores(rel)) {
          relPaths.push(rel);
        }
      }
    }
  }

  // Dédupliquer et trier
  const uniqueRelPaths = Array.from(new Set(relPaths)).sort((a, b) => a.localeCompare(b));
  const storedFiles: StoredFile[] = [];

  export function collectRelPaths(workspaceRoot: string, extraIgnorePatterns: string[], includedPaths: string[]): string[] {
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

    // Copie brute pour accès direct
    const destPath = path.join(filesDir, relPath);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.copyFileSync(srcPath, destPath);

    let text = "";
    try {
      text = fs.readFileSync(srcPath, "utf8");
    } catch {
      text = "(Erreur lors de la lecture du fichier)";
    }

    storedFiles.push({
      path: relPath,
      size: stat.size,
      content: text,
    });
  }

  const generatedAt = new Date().toISOString();
  const html = buildNavigableSiteHtml(meta, generatedAt, storedFiles);

  fs.writeFileSync(path.join(docsDir, "index.html"), html, "utf8");
  logger.info(`Site public régénéré dans docs/ : ${storedFiles.length} fichier(s) inclus.`);
  return storedFiles.length;
}

function buildNavigableSiteHtml(meta: SiteMeta, generatedAt: string, files: StoredFile[]): string {
  // Encodage JSON sûr pour injection script
  const filesJson = JSON.stringify(
    files.map((f) => ({
      p: f.path,
      s: f.size,
      c: f.content,
    }))
  ).replace(/</g, "\\u003c");

  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escapeHtml(meta.projectName)} — code source (lecture seule)</title>
<meta name="robots" content="index,follow" />
<style>
  :root {
    --bg-main: #1e1e1e;
    --bg-sidebar: #252526;
    --bg-header: #333333;
    --bg-hover: #2a2d2e;
    --bg-selected: #37373d;
    --text-main: #cccccc;
    --text-bright: #ffffff;
    --text-muted: #888888;
    --accent: #007acc;
    --accent-orange: #ff8c00;
    --border: #3c3c3c;
    --code-bg: #1e1e1e;
    --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: var(--bg-main);
    color: var(--text-main);
    display: flex;
    flex-direction: column;
    height: 100vh;
    overflow: hidden;
  }
  header {
    background: var(--bg-header);
    border-bottom: 1px solid var(--border);
    padding: 0.6rem 1rem;
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-shrink: 0;
    gap: 1rem;
  }
  .header-left {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    min-width: 0;
  }
  .project-title {
    font-size: 1.05rem;
    font-weight: 600;
    color: var(--text-bright);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .badge-branch {
    background: #0e639c;
    color: #fff;
    padding: 0.15rem 0.45rem;
    border-radius: 3px;
    font-size: 0.75rem;
    font-family: var(--font-mono);
  }
  .header-links a {
    color: var(--text-muted);
    text-decoration: none;
    font-size: 0.85rem;
  }
  .header-links a:hover { color: var(--text-bright); text-decoration: underline; }
  .layout {
    display: flex;
    flex: 1;
    min-height: 0;
  }
  /* Sidebar */
  aside {
    width: 320px;
    background: var(--bg-sidebar);
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
  }
  .sidebar-search {
    padding: 0.5rem;
    border-bottom: 1px solid var(--border);
  }
  .search-input {
    width: 100%;
    background: #3c3c3c;
    border: 1px solid transparent;
    color: var(--text-bright);
    padding: 0.4rem 0.6rem;
    border-radius: 3px;
    font-size: 0.85rem;
    outline: none;
  }
  .search-input:focus { border-color: var(--accent); }
  .sidebar-header {
    padding: 0.4rem 0.8rem;
    font-size: 0.75rem;
    font-weight: 700;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .tree-container {
    flex: 1;
    overflow-y: auto;
    padding: 0.25rem 0;
    font-family: var(--font-mono);
    font-size: 0.85rem;
  }
  .tree-node {
    user-select: none;
  }
  .tree-row {
    display: flex;
    align-items: center;
    padding: 0.22rem 0.5rem;
    cursor: pointer;
    border-radius: 2px;
    white-space: nowrap;
  }
  .tree-row:hover { background: var(--bg-hover); }
  .tree-row.active { background: var(--bg-selected); color: var(--text-bright); font-weight: 600; }
  .chevron {
    width: 16px;
    text-align: center;
    display: inline-block;
    color: var(--text-muted);
    font-size: 0.7rem;
    transition: transform 0.12s;
  }
  .chevron.open { transform: rotate(90deg); }
  .icon { margin-right: 0.35rem; font-size: 0.9rem; }
  .label { overflow: hidden; text-overflow: ellipsis; }
  .tree-children { display: none; }
  .tree-children.open { display: block; }
  /* Main Viewer */
  main {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    background: var(--bg-main);
  }
  .file-toolbar {
    background: var(--bg-sidebar);
    border-bottom: 1px solid var(--border);
    padding: 0.4rem 1rem;
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 0.85rem;
    flex-shrink: 0;
  }
  .file-path {
    font-family: var(--font-mono);
    color: var(--text-bright);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .file-actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-shrink: 0;
  }
  .btn {
    background: #3a3d41;
    border: 1px solid #454545;
    color: var(--text-bright);
    padding: 0.25rem 0.6rem;
    border-radius: 3px;
    cursor: pointer;
    font-size: 0.8rem;
    text-decoration: none;
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
  }
  .btn:hover { background: #45494e; }
  .editor-wrapper {
    flex: 1;
    overflow: auto;
    display: flex;
    background: var(--code-bg);
  }
  .code-viewer {
    counter-reset: line;
    font-family: var(--font-mono);
    font-size: 0.85rem;
    line-height: 1.45;
    padding: 1rem 0;
    width: 100%;
    overflow-x: auto;
  }
  .code-line {
    counter-increment: line;
    display: flex;
    min-height: 1.45em;
    padding: 0 1rem 0 0;
  }
  .code-line:hover {
    background: rgba(255, 255, 255, 0.03);
  }
  .code-line::before {
    content: counter(line);
    display: inline-block;
    width: 3.5em;
    padding-right: 1.2em;
    text-align: right;
    color: #6e7681;
    user-select: none;
    flex-shrink: 0;
    border-right: 1px solid var(--border);
    margin-right: 1em;
  }
  .line-text {
    white-space: pre;
    color: #e6edf3;
    tab-size: 2;
  }
  .empty-state {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 2rem;
    text-align: center;
    color: var(--text-muted);
  }
  .empty-state h2 { color: var(--text-bright); margin-bottom: 0.75rem; font-size: 1.3rem; }
  .empty-state p { max-width: 520px; line-height: 1.5; font-size: 0.95rem; margin-bottom: 1rem; }
  .instruction-box {
    background: #252526;
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 1rem 1.5rem;
    max-width: 600px;
    text-align: left;
    color: var(--text-main);
    font-size: 0.88rem;
    line-height: 1.6;
  }
  .instruction-box strong { color: var(--accent-orange); }
  @media (max-width: 768px) {
    aside { width: 220px; }
  }
</style>
</head>
<body>

<header>
  <div class="header-left">
    <span class="project-title">${escapeHtml(meta.projectName)}</span>
    <span class="badge-branch">${escapeHtml(meta.branch)}</span>
    <span style="color:var(--text-muted); font-size:0.8rem;">(Lecture seule)</span>
  </div>
  <div class="header-links">
    <a href="${escapeHtml(meta.repoHtmlUrl)}" target="_blank" rel="noopener">Dépôt GitHub ↗</a>
  </div>
</header>

<div class="layout">
  <aside>
    <div class="sidebar-search">
      <input type="text" id="searchInput" class="search-input" placeholder="🔍 Filtrer les fichiers..." />
    </div>
    <div class="sidebar-header">
      <span id="fileCount">${files.length} fichier(s)</span>
      <span style="font-size:0.75rem; cursor:pointer;" id="toggleTreeBtn">Tout déplier</span>
    </div>
    <div class="tree-container" id="treeContainer"></div>
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
        Cette URL publique donne un accès direct en lecture seule aux fichiers de ce projet. Vous pouvez donner cette URL à votre chatbot pour qu'il consulte votre code source sans configuration ni clé API requise.<br/><br/>
        <em>Dernière publication : ${new Date(generatedAt).toLocaleString("fr-FR")}</em>
      </div>
    </div>
  </main>
</div>

<script id="filesData" type="application/json">${filesJson}</script>

<script>
(function() {
  var filesRaw = JSON.parse(document.getElementById('filesData').textContent);
  var filesMap = {};
  filesRaw.forEach(function(f) { filesMap[f.p] = f; });

  var treeRoot = { name: '', isDir: true, children: {}, path: '' };
  filesRaw.forEach(function(file) {
    var parts = file.p.split('/');
    var curr = treeRoot;
    var accumulated = '';
    for (var i = 0; i < parts.length; i++) {
      var part = parts[i];
      accumulated = accumulated ? accumulated + '/' + part : part;
      var isLast = (i === parts.length - 1);
      if (!curr.children[part]) {
        curr.children[part] = {
          name: part,
          isDir: !isLast,
          path: accumulated,
          children: isLast ? null : {}
        };
      }
      curr = curr.children[part];
    }
  });

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

  var currentActiveRow = null;
  var currentActiveFile = null;

  function formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' octets';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' Ko';
    return (bytes / 1048576).toFixed(1) + ' Mo';
  }

  function renderTree(node, container, depth) {
    var keys = Object.keys(node.children || {}).sort(function(a, b) {
      var nodeA = node.children[a];
      var nodeB = node.children[b];
      if (nodeA.isDir !== nodeB.isDir) return nodeA.isDir ? -1 : 1;
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
        var chevron = document.createElement('span');
        chevron.className = 'chevron';
        chevron.textContent = '▶';
        rowEl.appendChild(chevron);

        var icon = document.createElement('span');
        icon.className = 'icon';
        icon.textContent = '📁';
        rowEl.appendChild(icon);

        var label = document.createElement('span');
        label.className = 'label';
        label.textContent = item.name;
        rowEl.appendChild(label);

        nodeEl.appendChild(rowEl);

        var childrenEl = document.createElement('div');
        childrenEl.className = 'tree-children';
        renderTree(item, childrenEl, depth + 1);
        nodeEl.appendChild(childrenEl);

        rowEl.addEventListener('click', function(e) {
          var isOpen = childrenEl.classList.toggle('open');
          chevron.classList.toggle('open', isOpen);
          icon.textContent = isOpen ? '📂' : '📁';
        });
      } else {
        var spacer = document.createElement('span');
        spacer.className = 'chevron';
        rowEl.appendChild(spacer);

        var icon = document.createElement('span');
        icon.className = 'icon';
        icon.textContent = '📄';
        rowEl.appendChild(icon);

        var label = document.createElement('span');
        label.className = 'label';
        label.textContent = item.name;
        rowEl.appendChild(label);

        nodeEl.appendChild(rowEl);

        rowEl.addEventListener('click', function() {
          selectFile(item.path, rowEl);
        });
      }

      container.appendChild(nodeEl);
    });
  }

  function selectFile(filePath, rowEl) {
    if (currentActiveRow) currentActiveRow.classList.remove('active');
    currentActiveRow = rowEl;
    if (rowEl) rowEl.classList.add('active');

    var file = filesMap[filePath];
    if (!file) return;
    currentActiveFile = file;

    activeFilePath.textContent = file.p;
    activeFileSize.textContent = formatBytes(file.s);
    rawLink.href = './files/' + file.p.split('/').map(encodeURIComponent).join('/');

    var text = file.c;
    var lines = text.split('\\n');
    codeViewer.innerHTML = '';
    var frag = document.createDocumentFragment();
    for (var i = 0; i < lines.length; i++) {
      var lineDiv = document.createElement('div');
      lineDiv.className = 'code-line';
      var textSpan = document.createElement('span');
      textSpan.className = 'line-text';
      textSpan.textContent = lines[i] || ' ';
      lineDiv.appendChild(textSpan);
      frag.appendChild(lineDiv);
    }
    codeViewer.appendChild(frag);

    emptyState.style.display = 'none';
    fileToolbar.style.display = 'flex';
    editorWrapper.style.display = 'flex';
  }

  copyBtn.addEventListener('click', function() {
    if (!currentActiveFile) return;
    navigator.clipboard.writeText(currentActiveFile.c).then(function() {
      copyBtn.textContent = '✅ Copié !';
      setTimeout(function() { copyBtn.textContent = '📋 Copier'; }, 2000);
    });
  });

  searchInput.addEventListener('input', function() {
    var q = searchInput.value.toLowerCase().trim();
    var allNodes = treeContainer.querySelectorAll('.tree-node');
    if (!q) {
      allNodes.forEach(function(el) { el.style.display = ''; });
      return;
    }

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
            var ch = prev.querySelector('.chevron');
            if (ch) ch.classList.add('open');
            var ic = prev.querySelector('.icon');
            if (ic) ic.textContent = '📂';
          }
          parent = parent.parentElement ? parent.parentElement.parentElement : null;
        }
      } else {
        var hasMatchInChildren = el.querySelector('.tree-node[data-path*="' + q + '"]');
        el.style.display = hasMatchInChildren ? '' : 'none';
      }
    });
  });

  var allExpanded = false;
  toggleTreeBtn.addEventListener('click', function() {
    allExpanded = !allExpanded;
    var children = treeContainer.querySelectorAll('.tree-children');
    var chevrons = treeContainer.querySelectorAll('.chevron');
    var icons = treeContainer.querySelectorAll('.icon');
    children.forEach(function(c) { c.classList.toggle('open', allExpanded); });
    chevrons.forEach(function(ch) { ch.classList.toggle('open', allExpanded); });
    icons.forEach(function(ic) {
      if (ic.textContent === '📁' || ic.textContent === '📂') {
        ic.textContent = allExpanded ? '📂' : '📁';
      }
    });
    toggleTreeBtn.textContent = allExpanded ? 'Tout replier' : 'Tout déplier';
  });

  renderTree(treeRoot, treeContainer, 0);

  // Déplier automatiquement le 1er niveau
  var firstLevel = treeContainer.querySelectorAll(':scope > .tree-node > .tree-children');
  firstLevel.forEach(function(fl) {
    fl.classList.add('open');
    var row = fl.previousElementSibling;
    if (row) {
      var ch = row.querySelector('.chevron');
      if (ch) ch.classList.add('open');
      var ic = row.querySelector('.icon');
      if (ic) ic.textContent = '📂';
    }
  });

  // Sélectionner le 1er fichier s'il y en a un
  if (filesRaw.length > 0) {
    var firstPath = filesRaw[0].p;
    var firstRow = treeContainer.querySelector('.tree-node[data-path="' + firstPath + '"] > .tree-row');
    selectFile(firstPath, firstRow);
  }
})();
</script>
</body>
</html>
`;
}
