import { z } from 'zod';
import type { Db, Paths } from './db.js';

export interface Ctx {
  db: Db;
  paths: Paths;
}

export interface ImageOut {
  name: string;
  mimeType: string;
  base64: string;
}

export interface CommandResult {
  /** Structured result; the CLI prints it with --json, the MCP server returns it as JSON text. */
  data: unknown;
  /** Human rendering for the CLI and the MCP text block. */
  text: string;
  /** Optional images (intake_open) returned to the host model. */
  images?: ImageOut[];
}

export interface Command<S extends z.ZodRawShape = z.ZodRawShape> {
  /** MCP tool name, e.g. donation_create. Null for CLI-only commands. */
  tool: string | null;
  noun: string;
  verb: string;
  description: string;
  input: S;
  /** Positional CLI argument mapped to this input field, e.g. donation update <id>. */
  positional?: keyof S & string;
  run: (ctx: Ctx, input: z.infer<z.ZodObject<S>>) => Promise<CommandResult>;
}

export class UserError extends Error {
  constructor(public code: string, message: string) {
    super(`${code}: ${message}`);
  }
}

export function defineCommand<S extends z.ZodRawShape>(c: Command<S>): Command<S> {
  return c;
}
