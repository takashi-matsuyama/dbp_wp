import { createInterface } from 'node:readline';
import {
  WpClient,
  renderMarkdown,
  type UpdatePostFields,
  type WpCredentials,
} from '@dbp-wp/core';
import type { CredentialsStore } from './credentials-store';

// A dependency-free Model Context Protocol (MCP) server over stdio.
//
// It speaks newline-delimited JSON-RPC 2.0 on stdin/stdout — the stdio MCP transport — and
// exposes a small, drafting-focused set of tools backed by @dbp-wp/core's WordPress client.
// The official MCP SDK is not used: it pulls in a full HTTP/SSE/OAuth stack (~90 transitive
// packages) that a stdio server never touches, which would erode this CLI's zero-runtime-
// dependency, audit-clean posture for no functional gain. The stdio surface implemented here
// (initialize / tools/list / tools/call / ping) is small and stable.
//
// Auth is the saved/seeded connection (env or OS secure storage) — credentials never reach the
// agent. Publishing is reserved for a human: status writes are limited to draft/pending, and
// the connected WordPress user is expected to be least-privilege.
//
// IMPORTANT: stdout carries ONLY protocol messages. All diagnostics go to stderr, or they would
// corrupt the JSON-RPC stream.

/** MCP protocol version to use when the client does not request a (known) one. */
const FALLBACK_PROTOCOL_VERSION = '2025-06-18';

/** Statuses an AI agent may set. Publishing (publish/future/private) is a human action. */
const ALLOWED_STATUSES = new Set(['draft', 'pending']);

/** A tool-level failure: reported to the client as an `isError` result, not a JSON-RPC error. */
class McpToolError extends Error {}

interface JsonRpcMessage {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;
}

/** Shared per-call helpers: a connected client and lazy connector gating. */
interface ToolContext {
  client: WpClient;
  /** Throw unless the companion plugin is active (required to write protected/custom meta). */
  ensureConnector: () => Promise<void>;
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function reqString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (v === undefined) {
    return undefined;
  }
  if (typeof v !== 'string') {
    throw new McpToolError(`"${key}" must be a string.`);
  }
  return v;
}

function reqInt(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  if (v === undefined) {
    return undefined;
  }
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) {
    throw new McpToolError(`"${key}" must be an integer.`);
  }
  return v;
}

export function validateStatus(status: string | undefined): string | undefined {
  if (status === undefined) {
    return undefined;
  }
  if (!ALLOWED_STATUSES.has(status)) {
    throw new McpToolError(
      `Publishing is reserved for a human in the DBP WP app. Set status to "draft" or "pending".`,
    );
  }
  return status;
}

/** Resolve the body to a `content`/`markdown` pair, rejecting an ambiguous both-given request. */
export function resolveBody(args: Record<string, unknown>): {
  content?: string;
  markdown?: string;
} {
  const markdown = reqString(args, 'markdown');
  const html = reqString(args, 'html');
  if (markdown !== undefined && html !== undefined) {
    throw new McpToolError('Provide either "markdown" or "html", not both.');
  }
  if (markdown !== undefined) {
    return { content: renderMarkdown(markdown), markdown };
  }
  if (html !== undefined) {
    return { content: html };
  }
  return {};
}

export function metaArg(args: Record<string, unknown>): Record<string, unknown> | undefined {
  if (args.meta === undefined) {
    return undefined;
  }
  const meta = args.meta;
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) {
    throw new McpToolError('"meta" must be an object of scalar custom fields.');
  }
  return meta as Record<string, unknown>;
}

const TOOLS: ToolDef[] = [
  {
    name: 'list_types',
    description: 'List the WordPress post types available over REST (slug, REST base, name).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (_args, ctx) => ctx.client.listPostTypes(),
  },
  {
    name: 'list_posts',
    description:
      'List posts of a type (titles/status/order only, no body). Use get_post to read a body.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'REST route base, e.g. "posts" (default) or "pages".' },
        page: { type: 'integer', minimum: 1 },
      },
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const type = reqString(args, 'type');
      const page = reqInt(args, 'page');
      const posts = await ctx.client.listPosts({
        ...(type !== undefined ? { type } : {}),
        ...(page !== undefined ? { page } : {}),
      });
      // Lean view: the agent reads bodies via get_post, not the listing.
      return posts.map((p) => ({
        id: p.id,
        title: p.title,
        status: p.status,
        menuOrder: p.menuOrder,
        type: p.type,
      }));
    },
  },
  {
    name: 'get_post',
    description:
      'Fetch one post for editing: its raw HTML body and, if present, its Markdown source.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        type: { type: 'string', description: 'REST route base (default "posts").' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const id = reqInt(args, 'id');
      if (id === undefined) {
        throw new McpToolError('"id" is required.');
      }
      return ctx.client.getPostForEdit(id, reqString(args, 'type') ?? 'posts');
    },
  },
  {
    name: 'create_post',
    description:
      'Create a DRAFT post with a Markdown or HTML body. Publishing is not allowed (human-only).',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'REST route base (default "posts").' },
        title: { type: 'string' },
        status: { type: 'string', enum: ['draft', 'pending'], description: 'Defaults to draft.' },
        markdown: { type: 'string', description: 'Markdown source (stored losslessly; needs the connector).' },
        html: { type: 'string', description: 'Raw HTML body (use instead of markdown).' },
        meta: { type: 'object', description: 'Scalar custom fields (needs the connector).' },
      },
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const type = reqString(args, 'type') ?? 'posts';
      const title = reqString(args, 'title');
      const status = validateStatus(reqString(args, 'status')) ?? 'draft';
      const body = resolveBody(args);
      const meta = metaArg(args);
      // The Markdown source and custom fields both need the companion plugin.
      if (body.markdown !== undefined || meta !== undefined) {
        await ctx.ensureConnector();
      }
      const fields: UpdatePostFields = { status };
      if (title !== undefined) {
        fields.title = title;
      }
      if (body.content !== undefined) {
        fields.content = body.content;
      }
      const created = await ctx.client.createPost(fields, type, meta);
      const base = {
        id: created.id,
        type: created.type,
        status: created.status,
        title: created.title,
      };
      // The Markdown source is a protected meta key, written via the dedicated body path. The
      // draft already has the rendered content (set above), so if this second step fails the post
      // is intact (HTML mode) — return its id with a warning rather than isError, so the agent
      // does not create a duplicate by retrying the whole create.
      if (body.markdown !== undefined) {
        try {
          return await ctx.client.updatePostBody(created.id, type, {
            content: body.content ?? '',
            markdown: body.markdown,
          });
        } catch (e) {
          return {
            ...base,
            warning: `Post created, but the Markdown source could not be stored (${
              e instanceof Error ? e.message : 'unknown error'
            }). The body was saved as rendered HTML; re-save from the DBP WP editor to restore Markdown mode.`,
          };
        }
      }
      return base;
    },
  },
  {
    name: 'update_post',
    description:
      'Update a post: title/menu order/status (draft or pending only), custom fields, and/or body.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        type: { type: 'string', description: 'REST route base (default "posts").' },
        title: { type: 'string' },
        menuOrder: { type: 'integer' },
        status: { type: 'string', enum: ['draft', 'pending'] },
        markdown: { type: 'string', description: 'Markdown source (needs the connector).' },
        html: { type: 'string', description: 'Raw HTML body (use instead of markdown).' },
        meta: { type: 'object', description: 'Scalar custom fields (needs the connector).' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const id = reqInt(args, 'id');
      if (id === undefined) {
        throw new McpToolError('"id" is required.');
      }
      const type = reqString(args, 'type') ?? 'posts';
      const title = reqString(args, 'title');
      const menuOrder = reqInt(args, 'menuOrder');
      const status = validateStatus(reqString(args, 'status'));
      const body = resolveBody(args);
      const meta = metaArg(args);
      if (body.markdown !== undefined || meta !== undefined) {
        await ctx.ensureConnector();
      }

      // Standard fields + custom (dbp_wp_meta) fields ride one request; the body (content +
      // protected _dbp_wp_markdown) rides another, since the two use different meta channels.
      const fields: UpdatePostFields = {};
      if (title !== undefined) fields.title = title;
      if (menuOrder !== undefined) fields.menuOrder = menuOrder;
      if (status !== undefined) fields.status = status;
      const wroteFields = Object.keys(fields).length > 0 || meta !== undefined;
      if (wroteFields) {
        await ctx.client.updatePost(id, fields, type, meta);
      }
      if (body.content !== undefined) {
        try {
          return await ctx.client.updatePostBody(id, type, {
            content: body.content,
            ...(body.markdown !== undefined ? { markdown: body.markdown } : {}),
          });
        } catch (e) {
          // If nothing was applied yet, this is a plain failure. But if fields/meta were already
          // committed, surface the partial apply (re-running update_post is safe — every field
          // write is idempotent) instead of a bare error that hides what changed.
          if (!wroteFields) {
            throw e;
          }
          const current = await ctx.client.getPostForEdit(id, type).catch(() => null);
          return {
            ...(current ?? { id, type }),
            warning: `Fields/meta were updated, but the body write failed (${
              e instanceof Error ? e.message : 'unknown error'
            }). Re-run update_post to retry the body (field writes are idempotent).`,
          };
        }
      }
      return ctx.client.getPostForEdit(id, type);
    },
  },
];

const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/** Serialize and write one JSON-RPC message as a single stdout line. */
function write(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function writeResult(id: unknown, result: unknown): void {
  write({ jsonrpc: '2.0', id, result });
}

function writeError(id: unknown, code: number, message: string): void {
  write({ jsonrpc: '2.0', id, error: { code, message } });
}

/**
 * Run the stdio MCP server until stdin closes. Credentials are fixed at launch (seeded from env
 * or restored from secure storage); tools fail cleanly when none are available.
 */
export async function runMcpServer(options: {
  credentials: WpCredentials | null;
  store: CredentialsStore;
}): Promise<void> {
  void options.store; // reserved for future re-auth; credentials are fixed for this process.
  const credentials = options.credentials;
  let connectorAvailable: boolean | null = null;

  async function makeContext(): Promise<ToolContext> {
    if (!credentials) {
      throw new McpToolError(
        'Not connected. Save a connection in the DBP WP app, or set DBP_WP_SITE_URL / DBP_WP_USERNAME / DBP_WP_APP_PASSWORD.',
      );
    }
    const client = new WpClient(credentials);
    return {
      client,
      ensureConnector: async () => {
        if (connectorAvailable === null) {
          try {
            connectorAvailable = await client.detectConnector();
          } catch {
            connectorAvailable = false;
          }
        }
        if (!connectorAvailable) {
          throw new McpToolError(
            'The companion plugin is required for Markdown bodies and custom fields, but it was not found on the site.',
          );
        }
      },
    };
  }

  async function handleToolCall(id: unknown, params: Record<string, unknown>): Promise<void> {
    const name = typeof params.name === 'string' ? params.name : '';
    const tool = TOOL_BY_NAME.get(name);
    if (!tool) {
      // An unknown tool is a tool-level error (isError), per MCP, not a JSON-RPC error.
      writeResult(id, { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true });
      return;
    }
    try {
      const ctx = await makeContext();
      const result = await tool.handler(asObject(params.arguments), ctx);
      writeResult(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Tool execution failed';
      writeResult(id, { content: [{ type: 'text', text: message }], isError: true });
    }
  }

  function handleMessage(msg: JsonRpcMessage): void {
    const { id, method } = msg;
    // A notification (no id) must never get a response. We have no actionable notifications
    // (e.g. notifications/initialized), so acknowledge nothing and do no work.
    if (id === undefined || id === null) {
      return;
    }

    if (method === 'initialize') {
      const params = asObject(msg.params);
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : null;
      writeResult(id, {
        // Echo the client's protocol version (our stdio tool surface is version-stable),
        // falling back to a known one when the client omits it.
        protocolVersion: requested ?? FALLBACK_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'dbp-wp', version: '0.2.13' },
      });
      return;
    }
    if (method === 'tools/list') {
      writeResult(id, {
        tools: TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });
      return;
    }
    if (method === 'tools/call') {
      void handleToolCall(id, asObject(msg.params));
      return;
    }
    if (method === 'ping') {
      writeResult(id, {});
      return;
    }
    writeError(id, -32601, `Method not found: ${String(method)}`);
  }

  process.stderr.write(
    credentials
      ? `dbp-wp MCP server ready (stdio) — connected to ${credentials.siteUrl}.\n`
      : 'dbp-wp MCP server ready (stdio) — no connection configured; tools will report an error.\n',
  );

  const rl = createInterface({ input: process.stdin });
  await new Promise<void>((resolve) => {
    rl.on('line', (line) => {
      const text = line.trim();
      if (text === '') {
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        writeError(null, -32700, 'Parse error');
        return;
      }
      // A valid JSON-RPC message is an object; reject primitives/arrays/null explicitly rather
      // than letting them fall through as malformed notifications.
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        writeError(null, -32600, 'Invalid Request');
        return;
      }
      try {
        handleMessage(parsed as JsonRpcMessage);
      } catch (e) {
        // A handler should not throw synchronously, but never let the loop die.
        process.stderr.write(`MCP handler error: ${e instanceof Error ? e.message : String(e)}\n`);
      }
    });
    rl.on('close', () => resolve());
  });
}
