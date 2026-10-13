import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { MAX_COMPRESSED, decodePayload, imageExtension, readBackup } from '../src/backup';
import { CHECKSUM, PHOTO, PHOTO_MEMBER, buildBackup, encodePayload, payload } from './fixture';

const fixture = () => new Uint8Array(readFileSync('tests/fixtures/daylio-v15.daylio'));
function patchDirectory(bytes: Uint8Array, offset: number, value: number): Uint8Array {
	const copy = new Uint8Array(bytes);
	const v = new DataView(copy.buffer);
	for (let i = 0; i < copy.length - 46; i++) if (v.getUint32(i, true) === 0x02014b50) { v.setUint32(i + offset, value, true); break; }
	return copy;
}

describe('Daylio archive reader', () => {
	it('reads two entries and one photo from the fixture', () => {
		const b = readBackup(fixture());
		expect(b.entries.map((e) => e.id)).toEqual([15024, 15025]);
		expect(b.photos.size).toBe(1);
		expect(b.photos.get(1)).toMatchObject({ checksum: CHECKSUM, ext: 'png' });
		expect(b.photos.get(1)?.bytes).toEqual(PHOTO);
		expect(b.missing).toEqual([]);
		expect(b.unsupported).toEqual([]);
	});
	it('reports a missing photo and keeps both entries', () => {
		const b = readBackup(new Uint8Array(readFileSync('tests/fixtures/no-photo.daylio')));
		expect(b.entries).toHaveLength(2);
		expect(b.photos.size).toBe(0);
		expect(b.missing).toEqual([`Entry 15024: asset 1 (${CHECKSUM})`]);
	});
	it('reports audio and unknown image bytes as unsupported', () => {
		const data = payload();
		data.assets = [{ id: 1, checksum: CHECKSUM, type: 1 }, { id: 2, checksum: 'voice01', type: 2 }];
		(data.dayEntries as { assets: number[] }[])[1]!.assets = [2];
		const b = readBackup(buildBackup(data, { 'assets/audio/voice01': new Uint8Array([1, 2, 3]) }));
		expect(b.unsupported).toEqual(['Entry 15025: asset 2 (voice01), type 2']);
		const odd = readBackup(zipSync({ 'backup.daylio': encodePayload(payload()), [PHOTO_MEMBER]: strToU8('not an image') }));
		expect(odd.unsupported[0]).toContain('unknown image format');
		expect(odd.photos.size).toBe(0);
	});
	it('rejects version 16 before any write', () => {
		expect(() => readBackup(new Uint8Array(readFileSync('tests/fixtures/version-16.daylio')))).toThrow('schema version 16');
	});
	it('checks the schema before expansion of a damaged photo', () => {
		const bytes = buildBackup({ ...payload(), version: 16 });
		const view = new DataView(bytes.buffer);
		let members = 0;
		for (let i = 0; i < bytes.length - 46; i++) {
			if (view.getUint32(i, true) === 0x02014b50 && ++members === 2) { view.setUint32(i + 16, 0, true); break; }
		}
		expect(() => readBackup(bytes)).toThrow('schema version 16');
	});
	it('rejects parent, absolute and backslash member paths', () => {
		for (const name of ['../outside.md', '/outside.md', 'assets/../../outside.md', 'assets\\outside.md']) {
			expect(() => readBackup(buildBackup(payload(), { [name]: new Uint8Array([1]) }))).toThrow('unsafe archive path');
		}
	});
	it('rejects a file above 20 MiB before it reads the directory', () => {
		expect(() => readBackup(new Uint8Array(MAX_COMPRESSED + 1))).toThrow('20 MiB');
	});
	it('rejects a declared expanded size above 100 MiB before expansion', () => {
		expect(() => readBackup(patchDirectory(fixture(), 24, 101 * 1024 * 1024))).toThrow('100 MiB');
	});
	it('rejects a checksum mismatch and an encrypted flag', () => {
		expect(() => readBackup(patchDirectory(fixture(), 16, 0))).toThrow('checksum');
		const bytes = fixture();
		const v = new DataView(bytes.buffer);
		for (let i = 0; i < bytes.length - 46; i++) if (v.getUint32(i, true) === 0x02014b50) { v.setUint16(i + 8, 1, true); break; }
		expect(() => readBackup(bytes)).toThrow('Encrypted');
	});
	it('rejects random bytes and an archive without the payload', () => {
		expect(() => readBackup(new Uint8Array([1, 2, 3]))).toThrow('not a ZIP');
		expect(() => readBackup(zipSync({ 'other.txt': strToU8('x') }))).toThrow('backup.daylio');
	});
	it('rejects ZIP64 sizes and split archives', () => {
		expect(() => readBackup(patchDirectory(fixture(), 24, 0xffffffff))).toThrow('ZIP64');
		const bytes = fixture();
		const view = new DataView(bytes.buffer);
		view.setUint16(bytes.length - 22 + 4, 1, true);
		expect(() => readBackup(bytes)).toThrow('Split');
	});
	it('decodes base64 UTF-8 and rejects bad base64', () => {
		expect(decodePayload(strToU8(btoa('{"a":1}')))).toBe('{"a":1}');
		expect(() => decodePayload(strToU8('***'))).toThrow('base64');
		expect(() => decodePayload(strToU8(btoa('\xff\xfe')))).toThrow('UTF-8');
	});
	it('detects image types from bytes', () => {
		expect(imageExtension(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpg');
		expect(imageExtension(PHOTO)).toBe('png');
		expect(imageExtension(strToU8('RIFF\0\0\0\0WEBP'))).toBe('webp');
		expect(imageExtension(strToU8('\0\0\0\x18ftypheic'))).toBe('heic');
		expect(imageExtension(strToU8('text'))).toBe('');
	});
});
