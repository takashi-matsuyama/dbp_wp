import type { PrintRecord, WpPost, WpPostType } from '@dbp-wp/core';
import type {
  ConnectionStatus,
  ImportCreateInput,
  ImportResult,
  MetaDeletion,
  PostUpdate,
  PostsResponse,
  PrintRecordsResponse,
  UpdateResult,
} from './api.types';

// Browser-demo data layer: an in-memory, network-free store seeded with sample posts. It
// implements the same surface as `api.cli.ts` but never touches a real WordPress site or
// the CLI, so the demo holds no credentials and sends nothing anywhere. State resets on
// reload — a clean slate each visit, which is what a demo wants.

/** A sample post carrying everything both the spreadsheet and Print views need. */
interface DemoPost {
  id: number;
  title: string;
  status: string;
  menuOrder: number;
  content: string;
  excerpt: string;
  featuredImageUrl: string;
  meta: Record<string, string>;
  tax: Record<string, string[]>;
  /** Parent post id (relation MVP); the demo has one type, so parents are same-type. */
  parent?: number;
  parentType?: string;
}

// A tiny inline placeholder so `{{ featuredImageUrl }}` never makes a network request.
const PLACEHOLDER_IMAGE =
  'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22120%22%20height%3D%2280%22%3E%3Crect%20width%3D%22120%22%20height%3D%2280%22%20fill%3D%22%23e2e8f0%22%2F%3E%3C%2Fsvg%3E';

function seed(): DemoPost[] {
  return [
    {
      id: 1,
      title: 'Getting started with DBP WP',
      status: 'publish',
      menuOrder: 1,
      content: '<p>DBP WP edits your WordPress content in bulk, like a spreadsheet.</p>',
      excerpt: '<p>A local-first spreadsheet for your posts.</p>',
      featuredImageUrl: PLACEHOLDER_IMAGE,
      meta: { price: '1200', sku: 'DBP-001' },
      tax: { category: ['Guides'], post_tag: ['intro', 'setup'] },
    },
    {
      id: 2,
      title: 'Bulk editing with formulas',
      status: 'publish',
      menuOrder: 2,
      content: '<p>Apply a formula across a column and save every row at once.</p>',
      excerpt: '<p>Formulas across rows.</p>',
      featuredImageUrl: PLACEHOLDER_IMAGE,
      meta: { price: '980', sku: 'DBP-002' },
      tax: { category: ['Guides'], post_tag: ['formulas'] },
      // Seeded relation so the demo shows a parent and derived children out of the box.
      parent: 1,
      parentType: 'posts',
    },
    {
      id: 3,
      title: 'Importing from CSV and JSON',
      status: 'draft',
      menuOrder: 3,
      content: '<p>Map columns and create posts from a file.</p>',
      excerpt: '<p>CSV / JSON import.</p>',
      featuredImageUrl: PLACEHOLDER_IMAGE,
      meta: { price: '1500', sku: 'DBP-003' },
      tax: { category: ['Reference'], post_tag: ['import'] },
      parent: 1,
      parentType: 'posts',
    },
    {
      id: 4,
      title: 'Print Design with CSS typesetting',
      status: 'publish',
      menuOrder: 4,
      content: '<p>Lay out records with HTML + CSS and print to PDF from your browser.</p>',
      excerpt: '<p>HTML + CSS typesetting.</p>',
      featuredImageUrl: PLACEHOLDER_IMAGE,
      meta: { price: '2400', sku: 'DBP-004' },
      tax: { category: ['Reference'], post_tag: ['print', 'pdf'] },
    },
  ];
}

const store: DemoPost[] = seed();
let nextId = 5;

function toWpPost(d: DemoPost): WpPost {
  // The demo presents as a connector-active site, so meta lives under dbpWpMeta (the
  // spreadsheet's editable meta columns).
  const post: WpPost = {
    id: d.id,
    type: 'post',
    status: d.status,
    title: d.title,
    menuOrder: d.menuOrder,
    meta: {},
    dbpWpMeta: { ...d.meta },
  };
  if (d.parent !== undefined) {
    post.parent = d.parent;
  }
  if (d.parentType !== undefined) {
    post.parentType = d.parentType;
  }
  return post;
}

function toPrintRecord(d: DemoPost): PrintRecord {
  return {
    id: d.id,
    title: d.title,
    content: d.content,
    excerpt: d.excerpt,
    status: d.status,
    menuOrder: d.menuOrder,
    featuredImageUrl: d.featuredImageUrl,
    meta: { ...d.meta },
    tax: { category: [...(d.tax.category ?? [])], post_tag: [...(d.tax.post_tag ?? [])] },
  };
}

function find(id: number): DemoPost | undefined {
  return store.find((p) => p.id === id);
}

const CONNECTION: ConnectionStatus = {
  connected: true,
  siteUrl: 'demo://sample-data',
  connectorAvailable: true,
};

export function getConnection(): Promise<ConnectionStatus> {
  return Promise.resolve({ ...CONNECTION });
}

export function connect(): Promise<ConnectionStatus> {
  // The demo is always "connected" to its local store; credentials are ignored entirely.
  // (The CLI's `connect(input)` takes credentials; this fewer-arg form still satisfies ApiImpl.)
  return Promise.resolve({ ...CONNECTION });
}

export function disconnect(): Promise<void> {
  return Promise.resolve();
}

export function fetchTypes(): Promise<WpPostType[]> {
  return Promise.resolve([{ slug: 'post', restBase: 'posts', name: 'Posts' }]);
}

export function fetchPosts(): Promise<PostsResponse> {
  return Promise.resolve({ posts: store.map(toWpPost), unconfigured: false });
}

export function fetchPrintRecords(): Promise<PrintRecordsResponse> {
  return Promise.resolve({ records: store.map(toPrintRecord), unconfigured: false });
}

export function savePosts(updates: PostUpdate[]): Promise<UpdateResult[]> {
  const results: UpdateResult[] = [];
  for (const update of updates) {
    const post = find(update.id);
    if (!post) {
      results.push({ id: update.id, ok: false, error: 'Not found in demo data' });
      continue;
    }
    if (update.title !== undefined) post.title = update.title;
    if (update.menuOrder !== undefined) post.menuOrder = update.menuOrder;
    if (update.status !== undefined) post.status = update.status;
    if (update.meta) {
      for (const [key, value] of Object.entries(update.meta)) {
        post.meta[key] = value == null ? '' : String(value);
      }
    }
    results.push({ id: update.id, ok: true });
  }
  return Promise.resolve(results);
}

export function importPosts(creates: ImportCreateInput[]): Promise<ImportResult[]> {
  const results: ImportResult[] = [];
  for (const [index, create] of creates.entries()) {
    const meta: Record<string, string> = {};
    if (create.meta) {
      for (const [key, value] of Object.entries(create.meta)) {
        meta[key] = value == null ? '' : String(value);
      }
    }
    const id = nextId++;
    store.push({
      id,
      title: create.title ?? '(untitled)',
      status: create.status ?? 'draft',
      menuOrder: create.menuOrder ?? 0,
      content: '',
      excerpt: '',
      featuredImageUrl: PLACEHOLDER_IMAGE,
      meta,
      tax: { category: [], post_tag: [] },
    });
    results.push({ index, ok: true, id });
  }
  return Promise.resolve(results);
}

export function bulkDeleteMeta(deletes: MetaDeletion[]): Promise<UpdateResult[]> {
  const results: UpdateResult[] = [];
  for (const del of deletes) {
    const post = find(del.id);
    if (!post) {
      results.push({ id: del.id, ok: false, error: 'Not found in demo data' });
      continue;
    }
    for (const key of del.keys) {
      delete post.meta[key];
    }
    results.push({ id: del.id, ok: true });
  }
  return Promise.resolve(results);
}

export function setRelation(
  childId: number,
  _childType: string,
  parentId: number,
  parentType: string,
): Promise<WpPost> {
  const post = find(childId);
  if (!post) {
    return Promise.reject(new Error('Not found in demo data'));
  }
  if (parentId === childId) {
    return Promise.reject(new Error('A post cannot be its own parent.'));
  }
  post.parent = parentId;
  post.parentType = parentType;
  return Promise.resolve(toWpPost(post));
}

export function clearRelation(childId: number, _childType: string): Promise<WpPost> {
  const post = find(childId);
  if (!post) {
    return Promise.reject(new Error('Not found in demo data'));
  }
  delete post.parent;
  delete post.parentType;
  return Promise.resolve(toWpPost(post));
}
