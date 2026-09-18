import { loadConfig, saveConfigFile } from "../config/loader.js";
import { hashPassword } from "../auth/password.js";
import { generateSessionSecret } from "../auth/session.js";

export const MIN_PASSWORD_LENGTH = 8;

export function getResolvedConfigPath(): string {
  return process.env.SHRINKARR_CONFIG ?? "config/config.yaml";
}

export interface AuthStatusResult {
  configured: boolean;
  username?: string;
  configPath: string;
}

export async function runAuthStatus(): Promise<AuthStatusResult> {
  const configPath = getResolvedConfigPath();
  const config = loadConfig(configPath);

  if (config.auth?.username) {
    console.log(`[shrinkarr] Admin account is configured for user: "${config.auth.username}" (Config: ${configPath})`);
    return { configured: true, username: config.auth.username, configPath };
  }

  console.log(`[shrinkarr] No admin account configured. Shrinkarr requires initial setup. (Config: ${configPath})`);
  return { configured: false, configPath };
}

export interface AuthCreateOptions {
  username: string;
  password: string;
  force?: boolean;
}

export async function runAuthCreate(opts: AuthCreateOptions): Promise<void> {
  const trimmedUsername = opts.username?.trim();
  if (!trimmedUsername) {
    throw new Error("Username cannot be empty.");
  }

  if (!opts.password) {
    throw new Error("Password cannot be empty.");
  }

  if (opts.password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters long.`);
  }

  const configPath = getResolvedConfigPath();
  const config = loadConfig(configPath);

  if (config.auth && !opts.force) {
    throw new Error(
      `An admin account already exists for user "${config.auth.username}". Use --force to overwrite it, or run 'shrinkarr auth reset' first.`,
    );
  }

  const auth = {
    username: trimmedUsername,
    passwordHash: hashPassword(opts.password),
    sessionSecret: generateSessionSecret(),
  };

  const updatedConfig = { ...config, auth };
  saveConfigFile(configPath, updatedConfig);

  console.log(`[shrinkarr] Admin account successfully created for user "${trimmedUsername}".`);
}

export async function runAuthReset(): Promise<void> {
  const configPath = getResolvedConfigPath();
  const config = loadConfig(configPath);

  if (!config.auth) {
    console.log(`[shrinkarr] No admin account is currently configured in "${configPath}".`);
    return;
  }

  const previousUser = config.auth.username;
  const { auth: _removedAuth, ...configWithoutAuth } = config;
  saveConfigFile(configPath, configWithoutAuth);

  console.log(
    `[shrinkarr] Admin account "${previousUser}" has been removed. Shrinkarr is now back in initial setup mode.`,
  );
}
