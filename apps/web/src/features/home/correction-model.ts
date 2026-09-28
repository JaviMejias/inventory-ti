export type CorrectionMovementType = 'INITIAL' | 'ENTRY' | 'EXIT' | 'RETURN' | 'ADJUSTMENT';
export type CorrectionStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

export function getCorrectedQuantity(movementType: CorrectionMovementType, quantity: number, direction: 'add' | 'subtract') {
  if (movementType === 'EXIT') return -quantity;
  if (movementType === 'ADJUSTMENT' && direction === 'subtract') return -quantity;
  return quantity;
}

export function getCorrectionFeedback(status: CorrectionStatus) {
  if (status === 'REJECTED') return { tone: 'warning' as const, title: 'Corrección rechazada', description: 'La solicitud no se aplicó al stock.' };
  return status === 'APPROVED'
    ? { tone: 'success' as const, title: 'Corrección aplicada', description: 'El stock y los saldos del historial se actualizaron.' }
    : { tone: 'info' as const, title: 'Corrección solicitada', description: 'La solicitud quedó pendiente de revisión por un JEFE.' };
}
