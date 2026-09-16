### Connecter GitHub

Pour publier automatiquement votre code, créer vos dépôts distants et générer le site GitHub Pages, Auto Push a besoin d'un accès à votre compte GitHub.

- **Token classique** : Scope `repo` requis.
- **Token fine-grained** : Permissions `Contents: Read and write` et `Pages: Read and write` requises sur le(s) dépôt(s).
- Le token est stocké de façon chiffrée et sécurisée dans le `SecretStorage` de VS Code et n'est jamais écrit en clair sur votre disque.

[Connecter GitHub](command:autoPush.setToken)
