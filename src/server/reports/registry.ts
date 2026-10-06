import { PEOPLE_CUSTOMERS } from './defs/customers';
import { FINANCIAL } from './defs/financial';
import { INVENTORY } from './defs/inventory';
import { OPS } from './defs/ops';
import { PEOPLE } from './defs/people';
import { PROFIT } from './defs/profit';
import { PURCHASING } from './defs/purchasing';
import type { ReportDef } from './types';

/** Every standard report. A new report is one definition added to one of these lists; the framework does the rest. */
export const REPORTS: ReportDef[] = [...FINANCIAL, ...OPS, ...PEOPLE_CUSTOMERS, ...PEOPLE, ...INVENTORY, ...PURCHASING, ...PROFIT];

const BY_KEY = new Map(REPORTS.map((r) => [r.key, r]));
export const reportDef = (key: string): ReportDef | undefined => BY_KEY.get(key);
