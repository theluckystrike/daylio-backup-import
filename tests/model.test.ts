import { describe, expect, it } from 'vitest';
import { parseYaml } from 'obsidian';
import { parsePayload } from '../src/backup';
import { dailyLine, entryBody, markdown, mergeSection, noteName, safeFolder, validHeading, validateFilter, validateNameRule } from '../src/model';
import { payload } from './fixture';

const entries = () => parsePayload(JSON.stringify(payload())).entries;

describe('note conversion', () => {
	it('converts strong HTML to bold Markdown with htmlToMarkdown', () => {
		expect(entryBody('Hello <strong>world</strong>')).toContain('**world**');
	});
	it('keeps plain Unicode text unchanged', () => { expect(entryBody('第二条 😀')).toBe('第二条 😀'); });
	it('removes scripts, images and remote Markdown images', () => {
		const body = entryBody('<p>Walk<img src="https://example.invalid/a.png"><script>bad()</script></p>');
		expect(body).toBe('Walk');
		expect(entryBody('A ![x](https://example.invalid/a.png) B')).toBe('A  B');
	});
	it('keeps an escaped less-than sign in HTML note text', () => {
		const body = entryBody('<p>if a &lt;b then c</p>');
		expect(body).toBe('if a &lt;b then c');
		expect(body).not.toContain('<b');
	});
	it('writes parseable properties with mood, activities and local time', () => {
		const [first] = entries();
		const text = markdown(first!, ['Daylio/attachments/daylio-x.png']);
		const props = parseYaml(text.split('---')[1]!) as Record<string, unknown>;
		expect(props).toMatchObject({ daylio_id: 15024, date: '2023-11-19', time: '10:45', daylio_local_time: '2023-11-19 10:45:59.432', daylio_offset: '-05:00', mood: 'rad', activities: ['long walk'], title: 'Same title' });
		expect(text).toContain('**world**');
		expect(text).toContain('![[Daylio/attachments/daylio-x.png]]');
	});
	it('names notes by date and source ID', () => {
		const [a, b] = entries();
		expect(noteName(a!, '{date} Daylio {id}')).toBe('2023-11-19 Daylio 15024.md');
		expect(noteName(b!, '{date} {time} {title} {mood} {id}')).toBe('2023-11-19 10-45 Same title calm 15025.md');
	});
	it('rejects a name rule without {id} or with an unknown token', () => {
		expect(() => validateNameRule('{date}')).toThrow('{id}');
		expect(() => validateNameRule('{id} {weather}')).toThrow('Unknown');
	});
	it('keeps distinct IDs after a long Unicode title is cut', () => {
		const [a, b] = entries();
		const title = '日'.repeat(200);
		const first = noteName({ ...a!, title }, '{title} {id}');
		const second = noteName({ ...b!, title }, '{title} {id}');
		expect(first).toMatch(/ 15024\.md$/);
		expect(second).toMatch(/ 15025\.md$/);
		expect(new TextEncoder().encode(first).length).toBeLessThanOrEqual(183);
		expect(first).not.toBe(second);
	});
	it('rejects unsafe folders, filters and headings', () => {
		for (const value of ['', '../x', '/x', '.obsidian', 'a\\b']) expect(() => safeFolder(value)).toThrow();
		expect(() => validateFilter({ from: '2023-12-01', to: '2023-11-01' })).toThrow('after');
		expect(() => validateFilter({ from: '2023-13-45', to: '' })).toThrow('format');
		expect(() => validHeading('A # B')).toThrow();
		expect(validHeading(' Daylio ')).toBe('Daylio');
	});
	it('makes a daily line with a link and a block ID', () => {
		const [a] = entries();
		expect(dailyLine(a!, 'Daylio/2023-11-19 Daylio 15024.md')).toBe('- 10:45 · rad · long walk [[Daylio/2023-11-19 Daylio 15024|Daylio 15024]] ^daylio-15024');
	});
	it('keeps mood and activity line breaks inside one daily line', () => {
		const [a] = entries();
		const line = dailyLine({ ...a!, mood: 'calm\n## Other', activities: ['long\r\nwalk'] }, 'Daylio/entry.md');
		expect(line).not.toMatch(/[\r\n]/);
		expect(line).toContain('calm ## Other · long walk');
		expect(line).toMatch(/\^daylio-15024$/);
	});
	it('merges into a section at the end of a note and into an empty note', () => {
		expect(mergeSection('', 'Daylio', ['- a ^daylio-1'])).toEqual({ text: '## Daylio\n\n- a ^daylio-1\n', added: 1 });
		expect(mergeSection('## Daylio\n', 'Daylio', ['- a ^daylio-1']).text).toBe('## Daylio\n\n- a ^daylio-1\n');
		expect(mergeSection('## Daylio\n- a ^daylio-10\n', 'Daylio', ['- b ^daylio-1']).added).toBe(1);
	});
	it('ignores heading lines in frontmatter and code blocks', () => {
		const fenced = '---\ntags: x\n---\n```md\n## Daylio\n```\n';
		expect(mergeSection(fenced, 'Daylio', ['- a ^daylio-1']).text).toBe(`${fenced}\n## Daylio\n\n- a ^daylio-1\n`);
		const inside = '## Daylio\n\n- old\n\n```sh\n# comment\n```\n\n## Tasks\n';
		expect(mergeSection(inside, 'Daylio', ['- a ^daylio-1']).text).toBe('## Daylio\n\n- old\n\n```sh\n# comment\n```\n- a ^daylio-1\n\n## Tasks\n');
	});
});
