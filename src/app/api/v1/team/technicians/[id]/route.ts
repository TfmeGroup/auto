import { ok, readBody, route } from '@/server/http/route';
import { getTechnician, setTechnician } from '@/server/team/technicians';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'employee.view' }, async ({ ctx, params }) => {
  return ok(await getTechnician(ctx, params.id ?? ''));
});

export const PATCH = route({ access: 'business', permission: 'employee.manage_technicians', write: true, feature: 'technician_management' }, async ({ req, ctx, params }) => {
  return ok(await setTechnician(ctx, params.id ?? '', await readBody(req)));
});
