import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildBackup } from './fixture';

describe('committed fixtures', () => {
	it('match the generator', () => {
		const bytes = buildBackup();
		// Set FIXTURE_WRITE=1 to write the fixtures again after a generator change.
		if (process.env.FIXTURE_WRITE === '1') {
			writeFileSync('tests/fixtures/daylio-v15.daylio', bytes);
			writeFileSync('tests/fixtures/no-photo.daylio', buildBackup(undefined, {}, false));
			writeFileSync('tests/fixtures/version-16.daylio', buildBackup({ version: 16, dayEntries: [] }));
			writeFileSync('docs/sample-notes/Demo backup.zip', bytes);
		}
		expect(new Uint8Array(readFileSync('tests/fixtures/daylio-v15.daylio'))).toEqual(bytes);
		expect(new Uint8Array(readFileSync('docs/sample-notes/Demo backup.zip'))).toEqual(bytes);
		expect(new Uint8Array(readFileSync('tests/fixtures/no-photo.daylio'))).toEqual(buildBackup(undefined, {}, false));
		expect(new Uint8Array(readFileSync('tests/fixtures/version-16.daylio'))).toEqual(buildBackup({ version: 16, dayEntries: [] }));
	});
});
