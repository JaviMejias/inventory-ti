import { Button } from '../primitives/Button';
import { cx } from '../utils';

type ListFooterProps = {
  loaded: number;
  total?: number;
  hasMore?: boolean;
  loading?: boolean;
  onLoadMore?: () => void;
  className?: string;
};

export function ListFooter({ loaded, total, hasMore = false, loading = false, onLoadMore, className }: ListFooterProps) {
  return (
    <footer className={cx('ui-list-footer', className)}>
      <span role="status" aria-live="polite">Mostrando {loaded}{total === undefined ? '' : ` de ${total}`}</span>
      {hasMore && onLoadMore ? <Button variant="secondary" size="sm" loading={loading} onClick={onLoadMore}>{loading ? 'Cargando más…' : 'Cargar más'}</Button> : <span className="ui-list-footer-end">Fin de la lista</span>}
    </footer>
  );
}
