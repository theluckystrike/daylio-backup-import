import { TFile, TFolder, normalizePath, parseYaml, type Vault } from 'obsidian';
import type { Backup, Entry } from './backup';
import { dailyLine, inFilter, markdown, mergeSection, notePath, photoPath, safeFolder, validHeading, validateFilter, validateNameRule, type DateFilter } from './model';

export const BATCH = 10;

export interface DailyOptions { folder: string; heading: string }
export interface ImportOptions {
	folder: string;
	nameRule: string;
	/** Pro only. Null means no filter. */
	filter: DateFilter | null;
	/** Pro only. Null means no daily note merge. */
	daily: DailyOptions | null;
}
export interface PlannedEntry {
	entry: Entry;
	path: string;
	/** Path of the note with this source ID in the target folder, or null. */
	existing: string | null;
	/** A reason to skip this entry, or an empty string. */
	conflict: string;
	photos: { asset: number; path: string }[];
}
export interface ImportPlan {
	backup: Backup;
	options: ImportOptions;
	entries: PlannedEntry[];
	filtered: number;
}
export interface ImportResult {
	created: number;
	skipped: number;
	photos: number;
	merged: number;
	errors: string[];
	cancelled: boolean;
}
export interface CancelToken { cancelled: boolean }

export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
	return a.length === b.length && a.every((value, i) => value === b[i]);
}

async function ensureFolder(vault: Vault, folder: string): Promise<void> {
	let current = '';
	for (const part of folder.split('/')) {
		current = normalizePath(current ? `${current}/${part}` : part);
		const found = vault.getAbstractFileByPath(current);
		if (found && !(found instanceof TFolder)) throw new Error(`A file blocks folder ${current}.`);
		if (!found) await vault.createFolder(current);
	}
}

function blockedParent(vault: Vault, path: string): string {
	const parts = path.split('/');
	for (let i = 1; i < parts.length; i++) {
		const parent = parts.slice(0, i).join('/');
		const found = vault.getAbstractFileByPath(parent);
		if (found && !(found instanceof TFolder)) return parent;
	}
	return '';
}

/** Source IDs of notes in the target folder, from the daylio_id property. */
export async function findExisting(vault: Vault, folder: string): Promise<Map<number, string>> {
	const result = new Map<number, string>();
	for (const file of vault.getMarkdownFiles()) {
		if (!file.path.startsWith(`${folder}/`)) continue;
		const text = await vault.cachedRead(file);
		const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
		if (!match) continue;
		let props: unknown;
		try { props = parseYaml(match[1] ?? ''); } catch { continue; }
		if (typeof props !== 'object' || props === null) continue;
		const id = (props as Record<string, unknown>).daylio_id;
		if (typeof id === 'number' && Number.isSafeInteger(id) && !result.has(id)) result.set(id, file.path);
	}
	return result;
}

export function validateOptions(options: ImportOptions): ImportOptions {
	validateNameRule(options.nameRule);
	if (options.filter) validateFilter(options.filter);
	return {
		folder: safeFolder(options.folder),
		nameRule: options.nameRule,
		filter: options.filter ? { ...options.filter } : null,
		daily: options.daily ? { folder: safeFolder(options.daily.folder), heading: validHeading(options.daily.heading) } : null,
	};
}

/** Make the plan without a vault write. Reject two entries with one output path. */
export async function prepareImport(vault: Vault, backup: Backup, input: ImportOptions): Promise<ImportPlan> {
	const options = validateOptions(input);
	const existing = await findExisting(vault, options.folder);
	const paths = new Set<string>();
	const entries: PlannedEntry[] = [];
	let filtered = 0;
	for (const entry of backup.entries) {
		if (options.filter && !inFilter(entry.date, options.filter)) { filtered++; continue; }
		const path = notePath(entry, options.folder, options.nameRule);
		const key = path.toLowerCase();
		if (paths.has(key)) throw new Error(`Two entries have the same output path: ${path}.`);
		paths.add(key);
		const photos: PlannedEntry['photos'] = [];
		for (const asset of entry.assets) {
			const photo = backup.photos.get(asset);
			if (photo) photos.push({ asset, path: photoPath(photo, options.folder) });
		}
		const old = existing.get(entry.id) ?? null;
		let conflict = '';
		if (!old) {
			const parent = blockedParent(vault, path) || photos.map((p) => blockedParent(vault, p.path)).find(Boolean) || '';
			if (parent) conflict = `A file blocks folder ${parent}.`;
			else if (vault.getAbstractFileByPath(path)) conflict = `A different note exists at ${path}.`;
			else for (const p of photos) {
				const file = vault.getAbstractFileByPath(p.path);
				const bytes = backup.photos.get(p.asset)?.bytes ?? new Uint8Array();
				if (file && (!(file instanceof TFile) || !sameBytes(new Uint8Array(await vault.readBinary(file)), bytes))) { conflict = `A different file exists at ${p.path}.`; break; }
			}
		}
		entries.push({ entry, path, existing: old, conflict, photos });
	}
	return { backup, options, entries, filtered };
}

async function writeEntry(vault: Vault, plan: ImportPlan, item: PlannedEntry, result: ImportResult): Promise<void> {
	const images: string[] = [];
	for (const p of item.photos) {
		const bytes = plan.backup.photos.get(p.asset)?.bytes;
		if (!bytes) continue;
		const file = vault.getAbstractFileByPath(p.path);
		if (file) {
			if (!(file instanceof TFile) || !sameBytes(new Uint8Array(await vault.readBinary(file)), bytes)) throw new Error(`A different file exists at ${p.path}.`);
		} else {
			await ensureFolder(vault, p.path.slice(0, p.path.lastIndexOf('/')));
			await vault.createBinary(p.path, new Uint8Array(bytes).buffer);
			result.photos++;
		}
		if (!images.includes(p.path)) images.push(p.path);
	}
	await ensureFolder(vault, plan.options.folder);
	await vault.create(item.path, markdown(item.entry, images));
}

async function mergeDaily(vault: Vault, daily: DailyOptions, date: string, lines: string[]): Promise<number> {
	const path = normalizePath(`${daily.folder}/${date}.md`);
	const file = vault.getAbstractFileByPath(path);
	if (file && !(file instanceof TFile)) throw new Error(`A folder blocks daily note ${path}.`);
	if (!file) {
		await ensureFolder(vault, daily.folder);
		const merged = mergeSection('', daily.heading, lines);
		await vault.create(path, merged.text);
		return merged.added;
	}
	let added = 0;
	await vault.process(file, (text) => { const merged = mergeSection(text, daily.heading, lines); added = merged.added; return merged.text; });
	return added;
}

/**
 * Create new files only. Recheck source IDs and paths at write time.
 * Stop between batches when the token is cancelled. The result reports partial writes.
 */
export async function writeImport(vault: Vault, plan: ImportPlan, token: CancelToken = { cancelled: false }): Promise<ImportResult> {
	const result: ImportResult = { created: 0, skipped: 0, photos: 0, merged: 0, errors: [], cancelled: false };
	const ids = await findExisting(vault, plan.options.folder);
	const written = new Map<number, string>();
	for (let start = 0; start < plan.entries.length; start += BATCH) {
		if (token.cancelled) { result.cancelled = true; break; }
		for (const item of plan.entries.slice(start, start + BATCH)) {
			const old = ids.get(item.entry.id);
			if (old) { written.set(item.entry.id, old); result.skipped++; continue; }
			if (item.conflict || vault.getAbstractFileByPath(item.path)) { result.skipped++; continue; }
			try {
				await writeEntry(vault, plan, item, result);
				ids.set(item.entry.id, item.path);
				written.set(item.entry.id, item.path);
				result.created++;
			} catch (e) { result.errors.push(`Entry ${item.entry.id}: ${e instanceof Error ? e.message : String(e)}`); }
		}
	}
	const daily = plan.options.daily;
	if (daily && !result.cancelled) {
		const days = new Map<string, string[]>();
		for (const item of plan.entries) {
			const path = written.get(item.entry.id);
			if (path) days.set(item.entry.date, [...(days.get(item.entry.date) ?? []), dailyLine(item.entry, path)]);
		}
		let count = 0;
		for (const [date, lines] of [...days].sort((a, b) => a[0].localeCompare(b[0]))) {
			if (count++ % BATCH === 0 && token.cancelled) { result.cancelled = true; break; }
			try { result.merged += await mergeDaily(vault, daily, date, lines); } catch (e) { result.errors.push(`Daily note ${date}: ${e instanceof Error ? e.message : String(e)}`); }
		}
	}
	return result;
}
