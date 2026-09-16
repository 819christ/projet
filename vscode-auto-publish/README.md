# Auto Push (extension VS Code / Antigravity)

Active Auto Push sur un projet : il crée le dépôt GitHub, publie le code, et génère un site public en lecture seule (hébergé sur GitHub Pages) accessible par une simple URL, sans authentification. Colle cette URL dans n'importe quel chatbot — Claude, ChatGPT, Gemini, Grok — pour qu'il puisse lire le code du projet à tout moment, sans avoir besoin d'un IDE agentique : VS Code classique suffit.

---

## Installation

```bash
code --install-extension vscode-auto-publish-readonly-0.7.0.vsix
```

## Utiliser Auto Push sur un projet

1. **La première fois seulement** : `Auto Push: Définir le token GitHub` (ou suis le guide de prise en main dans l'onglet Extensions).
2. **Sur chaque nouveau projet** : clique sur l'icône de tableau de bord `$(dashboard)` dans la barre de statut (ou `Auto Push: Activer sur ce projet`). Choisis entre *"Tout le projet"* ou *"Personnaliser la sélection"*. C'est tout — le dépôt GitHub et le site public GitHub Pages sont configurés automatiquement, et le premier push est immédiatement déclenché.
3. **Récupère l'URL** : clique simplement sur le bouton **"Copier l'URL"** qui s'affiche dès que la publication est terminée, et colle-la dans ton chatbot favori. *(Note : GitHub Pages peut prendre 1 à 2 minutes après la première création pour finaliser le déploiement).*

---

## Nouveautés & Fonctionnalités (v0.7.0)

### 🎛️ Panneau interactif dans la barre de statut
- Deux icônes dans la barre de statut :
  - **Icône principale (`Auto Push: ON/OFF`)** : survol avec info-bulle détaillée Markdown (statut, dépôt, périmètre) et clic pour publier immédiatement.
  - **Icône secondaire `$(dashboard)`** : ouvre le panneau interactif complet.
- Dans le panneau :
  - Renommage en direct du dépôt GitHub distant (avec icône ✏️).
  - Gestion visuelle du contenu publié (style Blender avec boutons `+` et `−`).
  - Déclenchement de publication manuelle, lien direct vers le site public, réglages avancés et désactivation douce.

### 🏷️ Badges de décoration dans l'explorateur
- **Mode Tout le projet** : un badge orange unique `AP` apparaît sur le dossier racine du projet pour signaler d'un coup d'œil qu'Auto Push est actif, sans surcharger les fichiers.
- **Mode Sélection personnalisée** : un badge orange discret `●` identifie précisément chaque fichier ou dossier explicitement inclus dans la sélection.

### 🌐 Site public navigable & interactif (`docs/index.html`)
- Arborescence dépliable inspirée de l'explorateur VS Code (dossiers cliquables, icônes).
- Visionneuse de code intégrée avec numérotation de lignes et bouton *"Copier"* instantané.
- Barre de recherche en temps réel filtrant immédiatement les noms de fichiers.
- Fichier HTML 100% autonome (aucun CDN requis, compatible GitHub Pages direct).

### 🛡️ Dépublication & Nettoyage
- **Auto Push: Dépublier ce fichier/dossier** : retire l'élément du suivi git (`git rm -r --cached`) sans toucher au fichier local, l'ajoute à `.autopushignore`, et pousse la mise à jour.
- **Auto Push: Tout dépublier (irréversible)** : après une double confirmation par saisie exacte du nom du dépôt, supprime le dépôt distant GitHub (ce qui supprime également le site GitHub Pages). Les fichiers locaux sont conservés intacts.

### 🔑 Tokens & Permissions GitHub
- **Commande** : `Auto Push: Définir le token GitHub`
- **Token classique** : scope `repo` requis.
- **Token fine-grained** : permissions `Contents: Read and write` et `Pages: Read and write` requises.

Le token est stocké de façon chiffrée dans le `SecretStorage` de VS Code (`context.secrets`) et n'est jamais écrit en clair sur disque. Les fichiers sensibles (`.env`, clés, certificats) et répertoires de build (`out`, `docs`, `public`, `node_modules`) sont systématiquement protégés.
