import { readFileSync } from 'node:fs';
import { URL } from 'node:url';

// Generated offline with the backend's pure V18 projector; no database, live workbook or API is used by tests.
export function identityGroupProjectionFixture(name='split') {
  if(!['split','merge','repartition','numeric','scale'].includes(name))throw Error('Unknown projection fixture');
  return JSON.parse(readFileSync(new URL('./identity-group-projection-'+name+'.json',import.meta.url),'utf8'));
}
