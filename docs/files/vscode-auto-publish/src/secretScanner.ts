const SECRET_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: "Clé AWS", pattern: /AKIA[0-9A-Z]{16}/ },
  { name: "Clé privée", pattern: /-----BEGIN (RSA |EC |)PRIVATE KEY-----/ },
  { name: "Clé de type OpenAI/Stripe", pattern: /\bsk-[a-zA-Z0-9]{20,}\b/ },
  { name: "Variable d'environnement suspecte", pattern: /\b(API_KEY|SECRET|TOKEN|PASSWORD)\s*=\s*["']?[A-Za-z0-9_\-/+=]{8,}["']?/i },
];

export function scanForSecrets(content: string): string[] {
  const found: string[] = [];
  for (const { name, pattern } of SECRET_PATTERNS) {
    if (pattern.test(content)) found.push(name);
  }
  return found;
}