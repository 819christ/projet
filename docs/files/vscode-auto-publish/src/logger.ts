import * as vscode from "vscode";

class Logger {
  private channel: vscode.OutputChannel;

  constructor() {
    this.channel = vscode.window.createOutputChannel("Auto Push");
  }

  info(message: string) {
    this.channel.appendLine(`[INFO] ${new Date().toISOString()} ${message}`);
  }

  warn(message: string) {
    this.channel.appendLine(`[WARN] ${new Date().toISOString()} ${message}`);
  }

  error(message: string, err?: unknown) {
    const details = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err ?? "");
    this.channel.appendLine(`[ERROR] ${new Date().toISOString()} ${message} ${details}`);
  }

  show() {
    this.channel.show(true);
  }
}

export const logger = new Logger();
