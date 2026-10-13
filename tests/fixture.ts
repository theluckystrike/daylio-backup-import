// Synthetic Daylio version 15 backup. It copies the field names of the public format. It holds no private journal.
import { readFileSync } from 'node:fs';
import { strToU8, zipSync } from 'fflate';

export const PHOTO = new Uint8Array(readFileSync('tests/fixtures/photo.png'));
export const CHECKSUM = 'a3f1c0de5b7e4c2d9e8f';
export const PHOTO_MEMBER = `assets/photos/2023/11/${CHECKSUM}`;

export function payload(): Record<string, unknown> {
	return {
		version: 15,
		customMoods: [
			{ id: 1, custom_name: '', mood_group_id: 1, predefined_name_id: 1, state: 0 },
			{ id: 2, custom_name: '', mood_group_id: 2, predefined_name_id: 2, state: 0 },
			{ id: 3, custom_name: '', mood_group_id: 3, predefined_name_id: 3, state: 0 },
			{ id: 4, custom_name: '', mood_group_id: 4, predefined_name_id: 4, state: 0 },
			{ id: 5, custom_name: '', mood_group_id: 5, predefined_name_id: 5, state: 0 },
			{ id: 6, custom_name: 'calm', mood_group_id: 2, predefined_name_id: -1, state: 0 },
		],
		tags: [
			{ id: 179, name: 'long walk', order: 1, state: 0 },
			{ id: 180, name: 'reading', order: 2, state: 0 },
		],
		assets: [{ id: 1, checksum: CHECKSUM, type: 1, createdAt: 1700408759432 }],
		dayEntries: [
			{ id: 15024, minute: 45, hour: 10, day: 19, month: 10, year: 2023, datetime: 1700408759432, timeZoneOffset: -18000000, mood: 1, note: 'Hello <strong>world</strong>', note_title: 'Same title', tags: [179], assets: [1] },
			{ id: 15025, minute: 45, hour: 10, day: 19, month: 10, year: 2023, datetime: 1700408759432, timeZoneOffset: -18000000, mood: 6, note: '第二条 😀', note_title: 'Same title', tags: [180], assets: [] },
		],
		metadata: { number_of_entries: 2, number_of_photos: 1, platform: 'android' },
	};
}

export function encodePayload(value: unknown): Uint8Array {
	const bytes = new TextEncoder().encode(JSON.stringify(value));
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return strToU8(btoa(binary));
}

/** ZIP dates use local time. Fixed local fields give the same bytes in each time zone. */
export function buildBackup(data: unknown = payload(), extra: Record<string, Uint8Array> = {}, photo = true): Uint8Array {
	const files: Record<string, Uint8Array> = { 'backup.daylio': encodePayload(data) };
	if (photo) files[PHOTO_MEMBER] = PHOTO;
	return zipSync({ ...files, ...extra }, { mtime: new Date(2023, 10, 20, 0, 0, 0) });
}
