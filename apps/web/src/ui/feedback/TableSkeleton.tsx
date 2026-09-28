type TableSkeletonProps = {
  columns: number;
  rows?: number;
  label?: string;
};

export function TableSkeleton({ columns, rows = 5, label = 'Cargando tabla' }: TableSkeletonProps) {
  return (
    <div className="ui-table-skeleton" aria-busy="true" aria-label={label} role="status">
      <table>
        <thead><tr>{Array.from({ length: columns }, (_, index) => <th key={index}><span /></th>)}</tr></thead>
        <tbody>{Array.from({ length: rows }, (_, row) => <tr key={row}>{Array.from({ length: columns }, (_, column) => <td key={column}><span className={column === 0 ? 'ui-skeleton-wide' : ''} /></td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}
