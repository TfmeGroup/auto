import type { Db } from '@/server/db/client';
import { SYSTEM_ROLES } from './catalog';

/**
 * Idempotently make the database's system roles match the code catalog. Run by
 * scripts/migrate.ts after every migration and by the test harness. Owner
 * privileges (the migration role) are required: system roles are immutable to
 * the running app.
 */
export async function syncSystemRoles(db: Db): Promise<void> {
  for (const def of SYSTEM_ROLES) {
    let role = await db.role.findFirst({ where: { businessId: null, key: def.key } });
    if (!role) {
      role = await db.role.create({
        data: { key: def.key, name: def.name, description: def.description, isSystem: true },
      });
    } else {
      role = await db.role.update({
        where: { id: role.id },
        data: { name: def.name, description: def.description },
      });
    }
    await db.rolePermission.deleteMany({
      where: { roleId: role.id, permission: { notIn: def.permissions } },
    });
    await db.rolePermission.createMany({
      data: def.permissions.map((permission) => ({ roleId: role.id, permission })),
      skipDuplicates: true,
    });
  }
}
