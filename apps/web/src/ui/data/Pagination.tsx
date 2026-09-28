import { Button } from '../primitives/Button';

type PaginationProps = {
  page: number;
  pageCount: number;
  onPageChange: (page: number) => void;
  loading?: boolean;
};

export function Pagination({ page, pageCount, onPageChange, loading = false }: PaginationProps) {
  const canGoPrevious = page > 1;
  const canGoNext = page < pageCount;
  return <nav className="ui-pagination" aria-label="Paginación"><Button variant="secondary" size="sm" disabled={!canGoPrevious || loading} onClick={() => onPageChange(page - 1)}>Anterior</Button><span aria-live="polite">Página {page} de {pageCount}</span><Button variant="secondary" size="sm" disabled={!canGoNext || loading} onClick={() => onPageChange(page + 1)}>Siguiente</Button></nav>;
}
