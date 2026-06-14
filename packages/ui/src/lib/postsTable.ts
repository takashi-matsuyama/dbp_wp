import {
  createTable,
  getCoreRowModel,
  getSortedRowModel,
  type ColumnDef,
  type Header,
  type SortDirection,
  type SortingState,
  type Table,
  type Updater,
} from '@tanstack/table-core';
import type { WpPost } from '@dbp-wp/core';

// Framework-agnostic table definition. Built on @tanstack/table-core (not the Svelte
// adapter) so the grid logic stays decoupled from the UI framework and unit-testable.

export const postColumns: ColumnDef<WpPost>[] = [
  { accessorKey: 'id', header: 'ID' },
  { accessorKey: 'title', header: 'Title' },
  { accessorKey: 'status', header: 'Status' },
  { accessorKey: 'menuOrder', header: 'Menu order' },
];

export interface PostsTableArgs {
  data: WpPost[];
  sorting: SortingState;
  onSortingChange: (updater: Updater<SortingState>) => void;
}

/** Create a controlled posts table instance (sorting state is owned by the caller). */
export function createPostsTable(args: PostsTableArgs): Table<WpPost> {
  return createTable<WpPost>({
    data: args.data,
    columns: postColumns,
    state: { sorting: args.sorting },
    onSortingChange: args.onSortingChange,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    onStateChange() {},
    renderFallbackValue: null,
  });
}

/** Safe header text (our columns use string headers, never render functions). */
export function headerLabel(header: Header<WpPost, unknown>): string {
  const header_ = header.column.columnDef.header;
  return typeof header_ === 'string' ? header_ : '';
}

/** Arrow indicator for the current sort direction. */
export function sortIndicator(direction: SortDirection | false): string {
  if (direction === 'asc') {
    return ' ▲';
  }
  if (direction === 'desc') {
    return ' ▼';
  }
  return '';
}
