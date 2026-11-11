import { URL } from 'node:url';

export function assertTestDatabase(environment) {
  const url = new URL(environment.DATABASE_URL);
  const name = url.pathname.slice(1);
  if (environment.NODE_ENV !== 'test' || !['postgres:', 'postgresql:'].includes(url.protocol) || !/^inventory_ti_test_[a-f0-9]{32}$/.test(name) || environment.INVENTORY_TEST_DATABASE !== name) {
    throw new Error('Integration tests require a disposable database created by pnpm --filter @inventory-ti/api test');
  }
}
