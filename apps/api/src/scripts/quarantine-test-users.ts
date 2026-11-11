import console from 'node:console';

import { prisma } from '../config/database.js';
import { findTestUsers, quarantineTestUsers } from '../lib/test-user-quarantine.js';

try {
  const arguments_ = process.argv.slice(2);
  if (arguments_.some((argument) => argument !== '--apply')) throw new Error('Only --apply is supported; omit it for a read-only preview');
  if (arguments_.includes('--apply')) {
    console.log('Test accounts quarantined:', await quarantineTestUsers(prisma));
  } else {
    const candidates = await findTestUsers(prisma);
    const administrators = await prisma.user.count({ where: { role: 'JEFE', isActive: true, passwordHash: { not: null }, id: { notIn: candidates.map((user) => user.id) } } });
    console.log({ confirmedTestAccounts: candidates.length, administratorsRemaining: administrators, mode: 'preview' });
    if (administrators === 0) console.log('Activate a real JEFE before applying quarantine. No data was changed.');
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Test account quarantine failed');
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
