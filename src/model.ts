import { htmlToMarkdown, normalizePath, stringifyYaml } from 'obsidian';
import type { Entry, Photo } from './backup';

export const DEFAULT_NAME_RULE = '{date} Daylio {id}';
export const NAME_TOKENS = ['{date}', '{time}', '{id}', '{title}', '{mood}'];

export function safeSegment(value: string, limit = 80): string {
	const normalized = Array.from(value.normalize('NFC')).map((c) => c.charCodeAt(0) < 32 ? '-' : c).join('').replace(/[\\/:*?"<>|[\]#^]/g, '-').replace(/\s+/g, ' ').replace(/^[. ]+|[. ]+$/g, '');
	// Count UTF-8 bytes so that a long title stays below a file name byte limit.
	let s = '';
	let length = 0;
	const encoder = new TextEncoder();
	for (const char of normalized) {
		const size = encoder.encode(char).length;
		if (length + size > limit) break;
		s += char; length += size;
	}
	s = s.replace(/[. ]+$/g, '');
	const clean = s || 'Untitled';
	return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(clean) ? `_${clean}` : clean;
}

export function safeFolder(value: string): string {
	if (!value.trim() || /[\\:*?"<>|]/.test(value) || Array.from(value).some((c) => c.charCodeAt(0) < 32)) throw new Error('Use a relative vault folder path.');
	const path = normalizePath(value.trim());
	if (!path || path === '/' || value.trim().startsWith('/') || path.split('/').some((part) => part === '.' || part === '..' || part.startsWith('.') || part !== safeSegment(part, 120))) throw new Error('Use a relative vault folder path without hidden folders or parent steps.');
	return path;
}

/** A file name rule must keep the source ID, so that two entries cannot share one name. */
export function validateNameRule(rule: string): void {
	if (!rule.includes('{id}')) throw new Error('The file name rule must contain {id}.');
	if (rule.length > 120) throw new Error('The file name rule is longer than 120 characters.');
	const unknown = (rule.match(/\{[^}]*\}/g) ?? []).filter((token) => !NAME_TOKENS.includes(token));
	if (unknown.length) throw new Error(`Unknown file name token: ${unknown[0] ?? ''}. Use ${NAME_TOKENS.join(', ')}.`);
}

export function noteName(entry: Entry, rule: string): string {
	validateNameRule(rule);
	const values: Record<string, string> = { '{date}': entry.date, '{time}': entry.time.replace(':', '-'), '{id}': String(entry.id), '{title}': entry.title.trim(), '{mood}': entry.mood };
	const name = rule.replace(/\{[a-z]+\}/g, (token) => values[token] ?? token);
	// Keep the ID when a long title puts it after the file name limit.
	const full = safeSegment(name, Number.MAX_SAFE_INTEGER);
	const clean = new TextEncoder().encode(full).length > 180 ? `${safeSegment(full, 160)} ${entry.id}` : full;
	return `${clean}.md`;
}

export function notePath(entry: Entry, folder: string, rule: string): string {
	return normalizePath(`${safeFolder(folder)}/${noteName(entry, rule)}`);
}

export function photoPath(photo: Photo, folder: string): string {
	return normalizePath(`${safeFolder(folder)}/attachments/daylio-${photo.checksum}.${photo.ext}`);
}

/** A date filter. Empty strings mean no bound. Both bounds are inclusive local dates. */
export interface DateFilter { from: string; to: string }
export function validateFilter(filter: DateFilter): void {
	for (const value of [filter.from, filter.to]) {
		if (value && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)))) throw new Error('Use dates in the format YYYY-MM-DD.');
	}
	if (filter.from && filter.to && filter.from > filter.to) throw new Error('The start date is after the end date.');
}
export function inFilter(date: string, filter: DateFilter): boolean {
	return (!filter.from || date >= filter.from) && (!filter.to || date <= filter.to);
}

export function cleanHtml(text: string): string {
	const allowed = new Set('p div span strong b em i u s del br hr h1 h2 h3 h4 h5 h6 ul ol li blockquote pre code a'.split(' '));
	const clean = text.replace(/<(script|style|iframe|object|video|audio)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
	return clean.replace(/<(\/?)([a-z][a-z0-9-]*)\b[^>]*>/gi, (tag: string, closing: string, raw: string) => {
		const name = raw.toLowerCase();
		if (!allowed.has(name)) return '';
		if (closing) return `</${name}>`;
		if (name !== 'a') return `<${name}>`;
		const match = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
		const href = match?.[1] ?? match?.[2] ?? match?.[3] ?? '';
		if (!/^https?:/i.test(href)) return '<a>';
		return `<a href="${href.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}">`;
	});
}

/** Convert the note HTML with htmlToMarkdown. Plain text stays unchanged. Resource tags are removed. */
export function entryBody(text: string): string {
	if (!/<\/?[a-z][a-z0-9-]*(?=[\s/>])[^>]*>/i.test(text)) return text.replace(/!\[[^\]]*\]\([^\n]*?\)/g, '').trim();
	const html = cleanHtml(text);
	const blocks = /<(?:p|div|br|hr|h[1-6]|ul|ol|li|blockquote|pre)>/i.test(html);
	const doc = new DOMParser().parseFromString(blocks ? html : html.replace(/\r?\n/g, '<br>'), 'text/html');
	for (const node of Array.from(doc.querySelectorAll('script, style, iframe, object, embed, img, link, meta, audio, video, source'))) node.remove();
	const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		if (!node.parentElement?.closest('pre,code')) node.nodeValue = (node.nodeValue ?? '').replace(//g, '').replace(/<(?=[a-z/!?])/gi, '');
	}
	return htmlToMarkdown(doc.body).replace(//g, '&lt;').trim();
}

export function markdown(entry: Entry, images: string[]): string {
	const props: Record<string, unknown> = {
		daylio_id: entry.id,
		date: entry.date,
		time: entry.time,
		daylio_local_time: entry.local,
		daylio_offset: entry.offset,
		mood: entry.mood,
		activities: entry.activities,
	};
	if (entry.title) props.title = entry.title;
	const body = entryBody(entry.note);
	const embeds = images.map((path) => `![[${path}]]`).join('\n');
	return `---\n${stringifyYaml(props).trimEnd()}\n---\n\n${[body, embeds].filter(Boolean).join('\n\n')}\n`;
}

/** One list line for a daily note section. The block ID marks the source ID. */
export function dailyLine(entry: Entry, notePath: string): string {
	const label = [entry.time, entry.mood, ...entry.activities].filter(Boolean).join(' · ').replace(/[[\]|^]/g, '-').replace(/[\r\n]+/g, ' ');
	const link = notePath.replace(/\.md$/, '');
	return `- ${label} [[${link}|Daylio ${entry.id}]] ^daylio-${entry.id}`;
}

/** Add lines under the named heading. Lines with a block ID that the text has already are skipped. */
export function mergeSection(text: string, heading: string, lines: string[]): { text: string; added: number } {
	const fresh = lines.filter((line) => {
		const id = /\^(daylio-\d+)$/.exec(line)?.[1];
		return !id || !new RegExp(`\\^${id}(?:\\s|$)`, 'm').test(text);
	});
	if (!fresh.length) return { text, added: 0 };
	const rows = text.split('\n');
	// A heading line in the frontmatter or in a code block is not a heading.
	const prose: boolean[] = [];
	let fence = '';
	let front = /^---\s*$/.test(rows[0] ?? '');
	rows.forEach((row, i) => {
		const marker = /^ {0,3}(`{3,}|~{3,})/.exec(row)?.[1] ?? '';
		if (front) { prose.push(false); if (i > 0 && /^(---|\.\.\.)\s*$/.test(row)) front = false; return; }
		if (fence) { prose.push(false); if (marker && marker[0] === fence[0] && marker.length >= fence.length && !row.trim().slice(marker.length).trim()) fence = ''; return; }
		if (marker) { fence = marker; prose.push(false); return; }
		prose.push(true);
	});
	const start = rows.findIndex((row, i) => prose[i] && /^#{1,6} /.test(row) && row.replace(/^#{1,6} /, '').trim() === heading);
	if (start < 0) {
		const base = text.replace(/\s+$/, '');
		return { text: `${base ? `${base}\n\n` : ''}## ${heading}\n\n${fresh.join('\n')}\n`, added: fresh.length };
	}
	const level = (/^#+/.exec(rows[start] ?? '')?.[0] ?? '#').length;
	let end = rows.length;
	for (let i = start + 1; i < rows.length; i++) {
		const match = prose[i] ? /^(#{1,6}) /.exec(rows[i] ?? '') : null;
		if (match && (match[1] ?? '').length <= level) { end = i; break; }
	}
	let insert = end;
	while (insert > start + 1 && (rows[insert - 1] ?? '').trim() === '') insert--;
	const head = rows.slice(0, insert);
	if (insert === start + 1) head.push('');
	// Keep one blank line before the next heading. At the end of the note, keep the trailing lines.
	const rest = end < rows.length ? ['', ...rows.slice(end)] : rows.slice(insert);
	return { text: [...head, ...fresh, ...rest].join('\n'), added: fresh.length };
}

export function validHeading(heading: string): string {
	const clean = heading.trim();
	if (!clean || clean.length > 80 || /[\r\n#[\]|^]/.test(clean)) throw new Error('Use a section name of 1 to 80 characters without # [ ] | ^ or line breaks.');
	return clean;
}
