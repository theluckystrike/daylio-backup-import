import data from './vectors/daylio-backup-import.json';
import { describe, it, expect } from 'vitest';
import { checkArchive, inspectPayload, localTime } from '../src/backup';
import { inFilter, mergeSection } from '../src/model';
const vectors = data as { cases: { name: string; function: string; args: unknown[]; expected: unknown }[] };
describe('golden acceptance vectors', () => {
	it('has 20 or more cases', () => { expect(vectors.cases.length).toBeGreaterThanOrEqual(20); });
	for (const c of vectors.cases) it(c.name, () => {
		const functions: Record<string, (...args: never[]) => unknown> = { inspectPayload, localTime, checkArchive, mergeSection, inFilter };
		expect(JSON.parse(JSON.stringify(functions[c.function]!(...c.args as never[])))).toEqual(c.expected);
	});
});
