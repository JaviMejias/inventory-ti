export type AppRole = 'JEFE' | 'COORDINADOR' | 'SOPORTE';

export function canViewCatalog(_role: AppRole): boolean { return true; }
export function canViewInventory(_role: AppRole): boolean { return true; }
export function canViewAssets(_role: AppRole): boolean { return true; }
export function canViewCorrections(_role: AppRole): boolean { return true; }
export function canViewUsers(role: AppRole): boolean { return role === 'JEFE'; }
export function canManageCatalog(role: AppRole): boolean { return role === 'JEFE'; }
export function canManageAssets(role: AppRole): boolean { return role === 'JEFE' || role === 'COORDINADOR'; }
export function canDecommissionAssets(role: AppRole): boolean { return role === 'JEFE'; }
export function canReviewCorrections(role: AppRole): boolean { return role === 'JEFE'; }
