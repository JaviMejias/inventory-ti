import type { ReactNode } from 'react';

import { Alert } from '../feedback/Alert';
import { EmptyState } from '../feedback/EmptyState';
import { TableSkeleton } from '../feedback/TableSkeleton';
import { cx } from '../utils';

export type SortDirection = 'ascending' | 'descending' | 'none';

export type DataTableColumn<Row> = {
  key: string;
  header: ReactNode;
  render: (row: Row, index: number) => ReactNode;
  className?: string;
  mobileLabel?: string;
  mobileRole?: 'identity' | 'field' | 'full' | 'actions' | 'context';
  sortable?: boolean;
  sortDirection?: SortDirection;
  onSort?: () => void;
};

type DataTableProps<Row> = {
  rows: Row[];
  columns: Array<DataTableColumn<Row>>;
  getRowKey: (row: Row) => string;
  caption: string;
  loading?: boolean;
  getRowClassName?: (row: Row, index: number) => string | undefined;
  loadingRows?: number;
  empty?: ReactNode;
  error?: ReactNode;
  density?: 'comfortable' | 'compact';
  selectable?: boolean;
  selectedKeys?: ReadonlySet<string>;
  onToggleRow?: (row: Row) => void;
  className?: string;
};

export function DataTable<Row>({ rows, columns, getRowKey, caption, loading = false, loadingRows = 5, empty = <EmptyState title="No hay registros" description="No existen elementos para mostrar." />, error, density = 'comfortable', selectable = false, selectedKeys, onToggleRow, getRowClassName, className }: DataTableProps<Row>) {
  if (loading) return <TableSkeleton columns={columns.length + (selectable ? 1 : 0)} rows={loadingRows} label={caption} />;
  if (error) return <Alert variant="danger">{error}</Alert>;
  if (rows.length === 0) return <>{empty}</>;

  return (
    <div className={cx('ui-data-table-shell', 'ui-data-table-responsive', 'ui-record-table-shell', className)}>
      <table className={cx('ui-data-table', 'ui-record-table', density === 'compact' && 'ui-data-table-compact')}>
        <caption className="sr-only">{caption}</caption>
        <thead><tr>
          {selectable && <th scope="col" className="ui-data-table-selection"><span className="sr-only">Seleccionar</span></th>}
          {columns.map((column) => <th className={column.className} scope="col" key={column.key} aria-sort={column.sortable ? column.sortDirection ?? 'none' : undefined}>{column.sortable && column.onSort ? <button className="ui-data-table-sort" type="button" onClick={column.onSort}>{column.header}<span aria-hidden="true">{column.sortDirection === 'ascending' ? ' ↑' : column.sortDirection === 'descending' ? ' ↓' : ' ↕'}</span></button> : column.header}</th>)}
        </tr></thead>
        <tbody>{rows.map((row, index) => {
          const key = getRowKey(row);
          return <tr key={key} className={cx(selectedKeys?.has(key) && 'ui-data-table-row-selected', getRowClassName?.(row, index))}>
            {selectable && <td className="ui-data-table-selection" data-card-role="full"><input type="checkbox" checked={selectedKeys?.has(key) ?? false} onChange={() => onToggleRow?.(row)} aria-label={`Seleccionar fila ${index + 1}`} /></td>}
            {columns.map((column) => <td className={column.className} data-card-role={column.mobileRole ?? 'field'} data-label={column.mobileLabel ?? (typeof column.header === 'string' ? column.header : undefined)} key={column.key}>{column.render(row, index)}</td>)}
          </tr>;
        })}</tbody>
      </table>
    </div>
  );
}
