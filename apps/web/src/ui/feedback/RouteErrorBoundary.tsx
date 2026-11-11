import { Component, type ReactNode } from 'react';

import { Button } from '../primitives/Button';
import { Alert } from './Alert';

export class RouteErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;

    return (
      <Alert variant="danger" title="No se pudo abrir esta vista" action={<Button onClick={() => globalThis.location.reload()}>Recargar aplicación</Button>}>
        Intenta recargar la aplicación o accede a otra sección desde el menú.
      </Alert>
    );
  }
}
