import process from 'node:process';

import { assertTestDatabase } from './test-database.js';

assertTestDatabase(process.env);
