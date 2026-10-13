import { strFromU8, unzipSync } from 'fflate';

/** Limits from the product spec. The plugin checks them before it expands the archive. */
export const MAX_COMPRESSED = 20 * 1024 * 1024;
export const MAX_EXPANDED = 100 * 1024 * 1024;
export const MAX_MEMBERS = 20000;
export const MAX_ENTRIES = 50000;
export const SCHEMA_VERSION = 15;
export const PAYLOAD = 'backup.daylio';

export interface Entry {
	id: number;
	title: string;
	note: string;
	datetime: number;
	offsetMs: number;
	date: string;
	time: string;
	local: string;
	offset: string;
	moodId: number;
	mood: string;
	activities: string[];
	assets: number[];
}
export interface Journal {
	version: number;
	entries: Entry[];
	/** Asset ID to checksum and type, from the payload. */
	assets: { id: number; checksum: string; type: number }[];
	warnings: string[];
}
export interface Photo { checksum: string; ext: string; bytes: Uint8Array }
export interface Backup extends Journal {
	/** Photo bytes by asset ID. */
	photos: Map<number, Photo>;
	/** Entry ID and asset reference of each photo that the archive does not contain. */
	missing: string[];
	/** Entry ID and asset reference of each asset that the plugin does not copy. */
	unsupported: string[];
}

const PREDEFINED_MOODS: Record<number, string> = { 1: 'rad', 2: 'good', 3: 'meh', 4: 'bad', 5: 'awful' };

/** Check one archive member name. Reject parent steps, absolute paths, drive letters and control characters. */
export function safeMemberName(name: string): boolean {
	return name.length > 0 && name.length <= 512 && !name.includes('\\') && !name.startsWith('/') && !/^[a-zA-Z]:/.test(name)
		&& !Array.from(name).some((c) => c.charCodeAt(0) < 32) && name.split('/').every((s) => s !== '..' && s !== '.');
}

/** Check the member list and the declared sizes. Returns an error text or an empty string. */
export function checkArchive(compressed: number, names: string[], sizes: number[]): string {
	if (compressed > MAX_COMPRESSED) return 'The backup exceeds the 20 MiB compressed size limit.';
	if (names.length > MAX_MEMBERS) return 'The backup has too many archive members.';
	const seen = new Set<string>();
	for (const name of names) {
		if (!safeMemberName(name)) return `The backup has an unsafe archive path: ${name.slice(0, 120)}`;
		if (seen.has(name)) return `The backup has a duplicate archive name: ${name.slice(0, 120)}`;
		seen.add(name);
	}
	const total = sizes.reduce((sum, size) => sum + size, 0);
	if (total > MAX_EXPANDED) return 'The backup declares more than the 100 MiB expanded size limit.';
	return '';
}

interface Member { name: string; size: number; crc: number }

/** Read the ZIP central directory without expanding a member. */
function members(bytes: Uint8Array): Member[] {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let end = -1;
	for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
		if (view.getUint32(i, true) === 0x06054b50 && i + 22 + view.getUint16(i + 20, true) === bytes.length) { end = i; break; }
	}
	if (end < 0) throw new Error('The file is not a ZIP archive. Select a .daylio backup.');
	if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true)) throw new Error('Split archives are not supported.');
	const count = view.getUint16(end + 10, true);
	let cursor = view.getUint32(end + 16, true);
	const directoryEnd = cursor + view.getUint32(end + 12, true);
	if (count !== view.getUint16(end + 8, true) || directoryEnd > end) throw new Error('The ZIP directory is not valid.');
	const result: Member[] = [];
	for (let i = 0; i < count; i++) {
		if (cursor + 46 > directoryEnd || view.getUint32(cursor, true) !== 0x02014b50) throw new Error('The ZIP directory is not valid.');
		if (view.getUint16(cursor + 8, true) & 1) throw new Error('Encrypted archives are not supported.');
		const length = view.getUint16(cursor + 28, true);
		const next = cursor + 46 + length + view.getUint16(cursor + 30, true) + view.getUint16(cursor + 32, true);
		if (next > directoryEnd) throw new Error('The ZIP directory is not valid.');
		const size = view.getUint32(cursor + 24, true);
		if (size === 0xffffffff) throw new Error('ZIP64 archives are not supported.');
		result.push({ name: strFromU8(bytes.subarray(cursor + 46, cursor + 46 + length)), size, crc: view.getUint32(cursor + 16, true) });
		cursor = next;
	}
	if (cursor !== directoryEnd) throw new Error('The ZIP directory is not valid.');
	return result;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, i) => {
	let value = i;
	for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
	return value >>> 0;
});
function crc32(bytes: Uint8Array): number {
	let crc = 0xffffffff;
	for (const byte of bytes) crc = (crc >>> 8) ^ (CRC_TABLE[(crc ^ byte) & 255] ?? 0);
	return (crc ^ 0xffffffff) >>> 0;
}

/** Local wall time from the UTC milliseconds and the offset in milliseconds. */
export function localTime(datetime: number, offsetMs: number): { date: string; time: string; local: string; offset: string } {
	const shifted = new Date(datetime + offsetMs);
	if (!Number.isFinite(shifted.getTime())) throw new Error('The date is not valid.');
	const iso = shifted.toISOString();
	if (!/^\d{4}-/.test(iso)) throw new Error('The date is outside years 0000 to 9999.');
	const minutes = Math.round(offsetMs / 60000);
	const abs = Math.abs(minutes);
	const offset = `${minutes < 0 ? '-' : '+'}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
	return { date: iso.slice(0, 10), time: iso.slice(11, 16), local: `${iso.slice(0, 10)} ${iso.slice(11, 23)}`, offset };
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} is not an object.`);
	return value as Record<string, unknown>;
}
function list(value: unknown, label: string): unknown[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new Error(`${label} is not a list.`);
	return value;
}
function integer(value: unknown, label: string): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error(`${label} is not an integer.`);
	return value;
}
function text(value: unknown): string {
	return typeof value === 'string' ? value : '';
}

/** Read the decoded version 15 JSON payload. No payload field is used as code or as a DOM element. */
export function parsePayload(json: string): Journal {
	let raw: unknown;
	try { raw = JSON.parse(json); } catch { throw new Error('The backup payload is not valid JSON.'); }
	const root = record(raw, 'The backup payload');
	if (root.version !== SCHEMA_VERSION) throw new Error(`Unsupported Daylio schema version ${root.version === undefined ? '(missing)' : JSON.stringify(root.version).slice(0, 20)}. This plugin reads version 15 only.`);
	const warnings: string[] = [];
	const moods = new Map<number, string>();
	for (const item of list(root.customMoods, 'customMoods')) {
		const row = record(item, 'A mood');
		const id = integer(row.id, 'A mood ID');
		if (moods.has(id)) throw new Error(`Duplicate mood ID ${id}.`);
		const name = text(row.custom_name).trim() || PREDEFINED_MOODS[typeof row.predefined_name_id === 'number' ? row.predefined_name_id : 0] || '';
		moods.set(id, name);
	}
	const tags = new Map<number, string>();
	for (const item of list(root.tags, 'tags')) {
		const row = record(item, 'An activity');
		const id = integer(row.id, 'An activity ID');
		if (tags.has(id)) throw new Error(`Duplicate activity ID ${id}.`);
		tags.set(id, text(row.name));
	}
	const assets: Journal['assets'] = [];
	const assetIds = new Set<number>();
	for (const item of list(root.assets, 'assets')) {
		const row = record(item, 'An asset');
		const id = integer(row.id, 'An asset ID');
		if (assetIds.has(id)) throw new Error(`Duplicate asset ID ${id}.`);
		assetIds.add(id);
		const checksum = text(row.checksum);
		if (!/^[A-Za-z0-9_-]{1,128}$/.test(checksum)) throw new Error(`Asset ${id} has an unsafe checksum.`);
		assets.push({ id, checksum, type: typeof row.type === 'number' ? row.type : 0 });
	}
	const rows = list(root.dayEntries, 'dayEntries');
	if (!Array.isArray(root.dayEntries)) throw new Error('The backup has no dayEntries list.');
	if (rows.length > MAX_ENTRIES) throw new Error('The backup exceeds 50000 entries.');
	const ids = new Set<number>();
	const entries = rows.map((item): Entry => {
		const row = record(item, 'An entry');
		const id = integer(row.id, 'An entry ID');
		if (id < 0) throw new Error(`Entry ${id} has a negative ID.`);
		if (ids.has(id)) throw new Error(`Duplicate entry ID ${id}.`);
		ids.add(id);
		const datetime = integer(row.datetime, `Entry ${id} datetime`);
		const offsetMs = row.timeZoneOffset === undefined ? 0 : integer(row.timeZoneOffset, `Entry ${id} timeZoneOffset`);
		if (Math.abs(offsetMs) > 18 * 3600000) throw new Error(`Entry ${id} has an offset outside 18 hours.`);
		const moodId = row.mood === undefined ? 0 : integer(row.mood, `Entry ${id} mood`);
		const mood = moods.get(moodId) ?? PREDEFINED_MOODS[moodId] ?? '';
		if (moodId && !mood) warnings.push(`Entry ${id}: unknown mood ID ${moodId}.`);
		const activities: string[] = [];
		for (const tag of list(row.tags, `Entry ${id} tags`)) {
			const tagId = integer(tag, `Entry ${id} tag`);
			const name = tags.get(tagId);
			if (name === undefined) warnings.push(`Entry ${id}: unknown activity ID ${tagId}.`);
			else if (name && !activities.includes(name)) activities.push(name);
		}
		const refs = [...new Set(list(row.assets, `Entry ${id} assets`).map((a) => integer(a, `Entry ${id} asset`)))];
		for (const ref of refs) if (!assetIds.has(ref)) warnings.push(`Entry ${id}: unknown asset ID ${ref}.`);
		return { id, title: text(row.note_title), note: text(row.note), datetime, offsetMs, ...localTime(datetime, offsetMs), moodId, mood, activities, assets: refs.filter((r) => assetIds.has(r)) };
	});
	return { version: SCHEMA_VERSION, entries, assets, warnings };
}

/** A stable public result for golden vectors, including rejection cases. */
export function inspectPayload(json: string): Journal | { error: string } {
	try { return parsePayload(json); } catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
}

/** Decode the base64 payload with atob and TextDecoder. Node Buffer is not used. */
export function decodePayload(data: Uint8Array): string {
	let binary: string;
	try { binary = atob(strFromU8(data, true).replace(/\s+/g, '')); } catch { throw new Error('The backup payload is not valid base64.'); }
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new Error('The backup payload is not valid UTF-8.'); }
}

/** File type from the first bytes. Returns an empty string for a type the plugin does not copy. */
export function imageExtension(bytes: Uint8Array): string {
	const b = (i: number) => bytes[i] ?? -1;
	if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return 'jpg';
	if (b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4e && b(3) === 0x47) return 'png';
	if (b(0) === 0x47 && b(1) === 0x49 && b(2) === 0x46) return 'gif';
	if (b(0) === 0x52 && b(1) === 0x49 && b(2) === 0x46 && b(3) === 0x46 && b(8) === 0x57 && b(9) === 0x45 && b(10) === 0x42 && b(11) === 0x50) return 'webp';
	const brand = String.fromCharCode(b(8), b(9), b(10), b(11));
	if (b(4) === 0x66 && b(5) === 0x74 && b(6) === 0x79 && b(7) === 0x70 && /^(heic|heix|mif1|msf1)$/.test(brand)) return 'heic';
	return '';
}

/** Validate the complete archive, then read the payload and the referenced photos. The vault is not touched. */
export function readBackup(bytes: Uint8Array): Backup {
	if (bytes.length > MAX_COMPRESSED) throw new Error('The backup exceeds the 20 MiB compressed size limit.');
	const index = members(bytes);
	const problem = checkArchive(bytes.length, index.map((m) => m.name), index.map((m) => m.size));
	if (problem) throw new Error(problem);
	const payloadMember = index.find((m) => m.name === PAYLOAD);
	if (!payloadMember) throw new Error('The archive root has no backup.daylio payload.');
	const expand = (include: (name: string) => boolean): Record<string, Uint8Array> => {
		let files: Record<string, Uint8Array>;
		try { files = unzipSync(bytes, { filter: (file) => include(file.name) }); }
		catch (e) { throw new Error(`Cannot expand the archive. ${e instanceof Error ? e.message : String(e)}`); }
		for (const member of index) {
			const data = files[member.name];
			if (data && (data.length !== member.size || crc32(data) !== member.crc)) throw new Error(`Archive checksum failed: ${member.name.slice(0, 120)}`);
		}
		return files;
	};
	// Check the schema before expansion of the assets.
	const payload = expand((name) => name === PAYLOAD);
	const journal = parsePayload(decodePayload(payload[PAYLOAD] ?? new Uint8Array()));
	const files = expand((name) => name.startsWith('assets/'));
	const byChecksum = new Map<string, Uint8Array>();
	for (const [name, data] of Object.entries(files)) {
		if (!name.startsWith('assets/') || name.endsWith('/')) continue;
		const base = name.slice(name.lastIndexOf('/') + 1);
		const key = base.includes('.') ? base.slice(0, base.lastIndexOf('.')) : base;
		if (!byChecksum.has(key)) byChecksum.set(key, data);
	}
	const assets = new Map(journal.assets.map((a) => [a.id, a]));
	const photos = new Map<number, Photo>();
	const missing: string[] = [];
	const unsupported: string[] = [];
	for (const entry of journal.entries) {
		for (const ref of entry.assets) {
			const asset = assets.get(ref);
			if (!asset) continue;
			const label = `Entry ${entry.id}: asset ${ref} (${asset.checksum})`;
			if (asset.type !== 1) { unsupported.push(`${label}, type ${asset.type}`); continue; }
			const data = byChecksum.get(asset.checksum);
			if (!data) { missing.push(label); continue; }
			const ext = imageExtension(data);
			if (!ext) { unsupported.push(`${label}, unknown image format`); continue; }
			photos.set(ref, { checksum: asset.checksum, ext, bytes: data });
		}
	}
	return { ...journal, photos, missing, unsupported };
}
