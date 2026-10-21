import { inflate, unfilterRows } from './Compression';

/** A PDF that can't be read, or a page selection that leaves no pages. */
export class PdfError extends Error {}

type PdfValue =
	| { type: 'raw'; text: string } // a number, true, false or null
	| { type: 'name'; name: string } // without the slash, escaped as in the file
	| { type: 'string'; bytes: Buffer } // a literal or hex string with its delimiters
	| { type: 'ref'; num: number; gen: number }
	| { type: 'array'; items: PdfValue[] }
	| { type: 'dict'; entries: Dict };

type Dict = Map<string, PdfValue>;

interface PdfStream {
	type: 'stream';
	dict: Dict;
	data: Buffer;
}

type PdfObject = PdfValue | PdfStream;

type XrefEntry =
	| { kind: 'free' }
	| { kind: 'offset'; offset: number; gen: number }
	| { kind: 'compressed'; stream: number; index: number };

interface Page {
	num: number;
	gen: number;
	dict: Dict;
	inherited: Dict;
}

/** Page attributes a page takes from its parents in the page tree when it doesn't set them. */
const INHERITED_KEYS = ['Resources', 'MediaBox', 'CropBox', 'Rotate'];

const WHITESPACE = new Set([0, 9, 10, 12, 13, 32]);
const DELIMITERS = new Set([...'()<>[]{}/%'].map((char) => char.charCodeAt(0)));
const CHAR = { slash: 0x2f, lparen: 0x28, rparen: 0x29, backslash: 0x5c, lt: 0x3c, gt: 0x3e };
const LBRACKET = 0x5b;
const RBRACKET = 0x5d;
const PERCENT = 0x25;
const INTEGER = /^\d+$/;

/** Reads PDF objects from bytes, starting at `pos`. */
class Lexer {
	constructor(
		readonly bytes: Buffer,
		public pos = 0,
	) {}

	skipSpace(): void {
		const { bytes } = this;
		while (this.pos < bytes.length) {
			const char = bytes[this.pos];
			if (WHITESPACE.has(char)) {
				this.pos++;
			} else if (char === PERCENT) {
				while (this.pos < bytes.length && bytes[this.pos] !== 10 && bytes[this.pos] !== 13) {
					this.pos++;
				}
			} else {
				break;
			}
		}
	}

	private regular(): string {
		const start = this.pos;
		while (
			this.pos < this.bytes.length &&
			!WHITESPACE.has(this.bytes[this.pos]) &&
			!DELIMITERS.has(this.bytes[this.pos])
		) {
			this.pos++;
		}
		return this.bytes.toString('latin1', start, this.pos);
	}

	/** Reads a number or keyword such as obj, R or trailer. */
	word(): string {
		this.skipSpace();
		return this.regular();
	}

	value(): PdfValue {
		this.skipSpace();
		const { bytes } = this;
		if (this.pos >= bytes.length) throw new PdfError('The PDF ends unexpectedly');
		const char = bytes[this.pos];

		if (char === CHAR.slash) {
			this.pos++;
			return { type: 'name', name: this.regular() };
		}
		if (char === CHAR.lparen) return { type: 'string', bytes: this.literalString() };
		if (char === CHAR.lt) {
			if (bytes[this.pos + 1] === CHAR.lt) {
				this.pos += 2;
				return { type: 'dict', entries: this.dictEntries() };
			}
			const end = bytes.indexOf(CHAR.gt, this.pos);
			if (end < 0) throw new PdfError('Unterminated hex string');
			const start = this.pos;
			this.pos = end + 1;
			return { type: 'string', bytes: bytes.subarray(start, end + 1) };
		}
		if (char === LBRACKET) {
			this.pos++;
			const items: PdfValue[] = [];
			for (;;) {
				this.skipSpace();
				if (bytes[this.pos] === RBRACKET) {
					this.pos++;
					return { type: 'array', items };
				}
				items.push(this.value());
			}
		}

		const word = this.regular();
		if (!word) throw new PdfError(`Unexpected character at byte ${this.pos}`);
		if (INTEGER.test(word)) {
			// Two integers followed by R are a reference to an object.
			const save = this.pos;
			const gen = this.word();
			if (INTEGER.test(gen) && this.word() === 'R') {
				return { type: 'ref', num: Number(word), gen: Number(gen) };
			}
			this.pos = save;
		}
		return { type: 'raw', text: word };
	}

	private dictEntries(): Dict {
		const entries: Dict = new Map();
		for (;;) {
			this.skipSpace();
			const char = this.bytes[this.pos];
			if (char === CHAR.gt && this.bytes[this.pos + 1] === CHAR.gt) {
				this.pos += 2;
				return entries;
			}
			if (char !== CHAR.slash) throw new PdfError(`Expected a name at byte ${this.pos}`);
			this.pos++;
			const key = this.regular();
			entries.set(key, this.value());
		}
	}

	private literalString(): Buffer {
		const { bytes } = this;
		const start = this.pos;
		let depth = 0;
		while (this.pos < bytes.length) {
			const char = bytes[this.pos++];
			if (char === CHAR.backslash) this.pos++;
			else if (char === CHAR.lparen) depth++;
			else if (char === CHAR.rparen && --depth === 0) return bytes.subarray(start, this.pos);
		}
		throw new PdfError('Unterminated string');
	}
}

function dictOf(object: PdfObject | undefined): Dict | undefined {
	if (object?.type === 'dict') return object.entries;
	if (object?.type === 'stream') return object.dict;
	return undefined;
}

function numberOf(value: PdfValue | undefined): number | undefined {
	if (value?.type !== 'raw') return undefined;
	const number = Number(value.text);
	return Number.isFinite(number) ? number : undefined;
}

function nameOf(value: PdfValue | undefined): string | undefined {
	return value?.type === 'name' ? decodeName(value.name) : undefined;
}

/** Undoes #xx escapes in a name, so /Im#31 and /Im1 compare equal. */
function decodeName(name: string): string {
	return name.replace(/#([0-9a-fA-F]{2})/g, (_, hex: string) =>
		String.fromCharCode(parseInt(hex, 16)),
	);
}

function pngUnpredict(data: Uint8Array, params: Dict | undefined): Uint8Array {
	const predictor = numberOf(params?.get('Predictor')) ?? 1;
	if (predictor === 1) return data;
	if (predictor < 10) throw new PdfError(`PDF predictor ${predictor} is not supported`);
	const colors = numberOf(params?.get('Colors')) ?? 1;
	const bits = numberOf(params?.get('BitsPerComponent')) ?? 8;
	const columns = numberOf(params?.get('Columns')) ?? 1;
	const bytesPerPixel = Math.max(1, Math.ceil((colors * bits) / 8));
	return unfilterRows(data, Math.ceil((columns * colors * bits) / 8), bytesPerPixel);
}

/** Reads a PDF's cross-reference data and objects, falling back to scanning the file when it's damaged. */
class PdfReader {
	readonly entries = new Map<number, XrefEntry>();
	readonly trailer: Dict = new Map();
	private readonly cache = new Map<number, PdfObject | undefined>();
	private readonly objectStreams = new Map<
		number,
		{ data: Buffer; offsets: Map<number, number> }
	>();
	private readonly loading = new Set<number>();
	private scanned: Map<number, number> | undefined;

	constructor(readonly bytes: Buffer) {
		try {
			this.readXref();
			this.catalog();
		} catch {
			// A damaged or missing cross-reference table: find the objects by scanning the file.
			this.entries.clear();
			this.trailer.clear();
			this.cache.clear();
			this.rebuildXref();
		}
		// Objects in object streams are encrypted along with the stream, and this doesn't decrypt.
		if (this.encrypted && [...this.entries.values()].some((entry) => entry.kind === 'compressed')) {
			throw new PdfError('Page selection does not work on this PDF because it is encrypted');
		}
	}

	get encrypted(): boolean {
		return this.trailer.has('Encrypt');
	}

	catalog(): Dict {
		const catalog = dictOf(this.resolve(this.trailer.get('Root')));
		if (!catalog) throw new PdfError('The PDF has no document catalog');
		return catalog;
	}

	resolve(value: PdfValue | undefined): PdfObject | undefined {
		return value?.type === 'ref' ? this.object(value.num) : value;
	}

	object(num: number): PdfObject | undefined {
		if (this.cache.has(num)) return this.cache.get(num);
		if (this.loading.has(num)) throw new PdfError(`Object ${num} refers to itself`);
		this.loading.add(num);
		try {
			const object = this.load(num);
			this.cache.set(num, object);
			return object;
		} finally {
			this.loading.delete(num);
		}
	}

	gen(num: number): number {
		const entry = this.entries.get(num);
		return entry?.kind === 'offset' ? entry.gen : 0;
	}

	private load(num: number): PdfObject | undefined {
		const entry = this.entries.get(num);
		if (!entry || entry.kind === 'free') return undefined;
		if (entry.kind === 'compressed') return this.fromObjectStream(entry.stream, num);
		try {
			return this.parseObjectAt(entry.offset, num);
		} catch {
			// Wrong offsets are common in PDFs that were edited by hand or by careless tools.
			const offset = this.scan().get(num);
			return offset === undefined ? undefined : this.parseObjectAt(offset, num);
		}
	}

	private parseObjectAt(offset: number, expectedNum?: number): PdfObject {
		const lexer = new Lexer(this.bytes, offset);
		const num = lexer.word();
		const gen = lexer.word();
		if (!INTEGER.test(num) || !INTEGER.test(gen) || lexer.word() !== 'obj') {
			throw new PdfError(`No object at byte ${offset}`);
		}
		if (expectedNum !== undefined && Number(num) !== expectedNum) {
			throw new PdfError(`Expected object ${expectedNum} at byte ${offset}, found ${num}`);
		}
		const value = lexer.value();
		// An empty object, "1 0 obj endobj", is null.
		if (value.type === 'raw' && value.text === 'endobj') return { type: 'raw', text: 'null' };
		if (value.type !== 'dict') return value;

		const afterDict = lexer.pos;
		if (lexer.word() !== 'stream') {
			lexer.pos = afterDict;
			return value;
		}
		// The data starts after the end of line that follows the stream keyword.
		let start = lexer.pos;
		if (this.bytes[start] === 13) start++;
		if (this.bytes[start] === 10) start++;

		const length = numberOf(this.resolveValue(value.entries.get('Length')));
		if (length !== undefined && length >= 0) {
			const end = start + length;
			const check = new Lexer(this.bytes, end);
			if (check.word() === 'endstream') {
				return { type: 'stream', dict: value.entries, data: this.bytes.subarray(start, end) };
			}
		}
		// A wrong /Length: the data runs until endstream.
		let end = this.bytes.indexOf('endstream', start);
		if (end < 0) throw new PdfError(`Stream ${num} has no end`);
		if (this.bytes[end - 1] === 10) end--;
		if (this.bytes[end - 1] === 13) end--;
		return { type: 'stream', dict: value.entries, data: this.bytes.subarray(start, end) };
	}

	/** Resolves a reference to a value that can't be a stream, such as a /Length. */
	private resolveValue(value: PdfValue | undefined): PdfValue | undefined {
		const object = this.resolve(value);
		return object?.type === 'stream' ? undefined : object;
	}

	private fromObjectStream(streamNum: number, num: number): PdfObject | undefined {
		let objectStream = this.objectStreams.get(streamNum);
		if (!objectStream) {
			if (this.encrypted) {
				throw new PdfError('Page selection does not work on encrypted PDFs with object streams');
			}
			const stream = this.object(streamNum);
			if (stream?.type !== 'stream') throw new PdfError(`Object stream ${streamNum} is missing`);
			const data = Buffer.from(this.decode(stream));
			const count = numberOf(stream.dict.get('N')) ?? 0;
			const first = numberOf(stream.dict.get('First')) ?? 0;
			const lexer = new Lexer(data);
			const offsets = new Map<number, number>();
			for (let i = 0; i < count; i++) {
				const objectNum = Number(lexer.word());
				const offset = Number(lexer.word());
				if (!Number.isInteger(objectNum) || !Number.isInteger(offset)) break;
				if (!offsets.has(objectNum)) offsets.set(objectNum, first + offset);
			}
			objectStream = { data, offsets };
			this.objectStreams.set(streamNum, objectStream);
		}
		const offset = objectStream.offsets.get(num);
		return offset === undefined ? undefined : new Lexer(objectStream.data, offset).value();
	}

	/** Decodes a stream's data. Only Flate compression is supported, which covers object and xref streams. */
	decode(stream: PdfStream): Uint8Array {
		const filterValue = this.resolveValue(stream.dict.get('Filter'));
		const paramsValue = this.resolveValue(stream.dict.get('DecodeParms'));
		const filters =
			filterValue?.type === 'array' ? filterValue.items : filterValue ? [filterValue] : [];
		const params = paramsValue?.type === 'array' ? paramsValue.items : [paramsValue];

		let data: Uint8Array = stream.data;
		filters.forEach((filter, i) => {
			const name = nameOf(filter);
			if (name !== 'FlateDecode' && name !== 'Fl') {
				throw new PdfError(`PDF filter ${name ?? '?'} is not supported`);
			}
			const param = this.resolveValue(params[i]);
			data = pngUnpredict(inflate(data), param?.type === 'dict' ? param.entries : undefined);
		});
		return data;
	}

	private readXref(): void {
		const startxref = this.bytes.lastIndexOf('startxref');
		if (startxref < 0) throw new PdfError('No startxref');
		const offset = Number(new Lexer(this.bytes, startxref + 9).word());
		const seen = new Set<number>();
		let next: number | undefined = offset;
		// Newest section first; an object's first entry wins.
		while (next !== undefined) {
			if (seen.has(next) || !(next >= 0 && next < this.bytes.length)) {
				throw new PdfError('Broken cross-reference chain');
			}
			seen.add(next);
			next = this.readXrefSection(next);
		}
		if (!this.trailer.has('Root')) throw new PdfError('No /Root in the trailer');
	}

	/** Reads one cross-reference section and returns the offset of the previous one. */
	private readXrefSection(offset: number): number | undefined {
		const lexer = new Lexer(this.bytes, offset);
		lexer.skipSpace();
		let trailer: Dict;
		if (this.bytes.toString('latin1', lexer.pos, lexer.pos + 4) === 'xref') {
			lexer.pos += 4;
			for (;;) {
				const first = lexer.word();
				if (first === 'trailer') break;
				const count = lexer.word();
				if (!INTEGER.test(first) || !INTEGER.test(count)) throw new PdfError('Bad xref table');
				for (let i = 0; i < Number(count); i++) {
					const entryOffset = Number(lexer.word());
					const gen = Number(lexer.word());
					const kind = lexer.word();
					const num = Number(first) + i;
					if (this.entries.has(num)) continue;
					if (kind === 'n') this.entries.set(num, { kind: 'offset', offset: entryOffset, gen });
					else if (kind === 'f') this.entries.set(num, { kind: 'free' });
					else throw new PdfError('Bad xref entry');
				}
			}
			const value = lexer.value();
			if (value.type !== 'dict') throw new PdfError('Bad trailer');
			trailer = value.entries;
			// Hybrid files list their compressed objects in a separate xref stream.
			const xrefStream = numberOf(trailer.get('XRefStm'));
			if (xrefStream !== undefined) this.readXrefStream(xrefStream);
		} else {
			trailer = this.readXrefStream(offset);
		}
		for (const key of ['Root', 'Encrypt', 'ID']) {
			const value = trailer.get(key);
			if (value && !this.trailer.has(key)) this.trailer.set(key, value);
		}
		return numberOf(trailer.get('Prev'));
	}

	private readXrefStream(offset: number): Dict {
		const stream = this.parseObjectAt(offset);
		if (stream.type !== 'stream') throw new PdfError('Bad xref stream');
		const data = this.decode(stream);
		const widthsValue = stream.dict.get('W');
		const widths =
			widthsValue?.type === 'array' ? widthsValue.items.map((w) => numberOf(w) ?? 0) : [];
		if (widths.length < 3) throw new PdfError('Bad xref stream widths');
		const indexValue = stream.dict.get('Index');
		const index =
			indexValue?.type === 'array'
				? indexValue.items.map((n) => numberOf(n) ?? 0)
				: [0, numberOf(stream.dict.get('Size')) ?? 0];

		let pos = 0;
		const read = (width: number) => {
			let value = 0;
			for (let i = 0; i < width; i++) value = value * 256 + data[pos++];
			return value;
		};
		for (let k = 0; k + 1 < index.length; k += 2) {
			for (let i = 0; i < index[k + 1]; i++) {
				if (pos >= data.length) break;
				const kind = widths[0] ? read(widths[0]) : 1;
				const field2 = read(widths[1]);
				const field3 = read(widths[2]);
				const num = index[k] + i;
				if (this.entries.has(num)) continue;
				if (kind === 0) this.entries.set(num, { kind: 'free' });
				else if (kind === 1) this.entries.set(num, { kind: 'offset', offset: field2, gen: field3 });
				else if (kind === 2) {
					this.entries.set(num, { kind: 'compressed', stream: field2, index: field3 });
				}
			}
		}
		return stream.dict;
	}

	/** Finds every "n g obj" in the file. When an object appears more than once, the last one wins. */
	private scan(): Map<number, number> {
		if (this.scanned) return this.scanned;
		this.scanned = new Map();
		const text = this.bytes.toString('latin1');
		const pattern = /(\d+)[ \t\r\n\f\0]+\d+[ \t\r\n\f\0]+obj\b/g;
		for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
			const before = match.index > 0 ? this.bytes[match.index - 1] : 10;
			if (WHITESPACE.has(before) || DELIMITERS.has(before)) {
				this.scanned.set(Number(match[1]), match.index);
			}
		}
		return this.scanned;
	}

	private rebuildXref(): void {
		for (const [num, offset] of this.scan()) {
			this.entries.set(num, { kind: 'offset', offset, gen: 0 });
		}
		for (
			let at = this.bytes.lastIndexOf('trailer');
			at >= 0;
			at = at > 0 ? this.bytes.lastIndexOf('trailer', at - 1) : -1
		) {
			try {
				const value = new Lexer(this.bytes, at + 7).value();
				if (value.type === 'dict') this.mergeTrailer(value.entries);
			} catch {
				continue;
			}
		}
		const streams: Array<[number, PdfStream]> = [];
		for (const num of this.entries.keys()) {
			const object = this.tryObject(num);
			if (object?.type === 'stream') streams.push([num, object]);
		}
		for (const [, stream] of streams) {
			if (nameOf(stream.dict.get('Type')) === 'XRef') this.mergeTrailer(stream.dict);
		}
		// Register the objects inside object streams.
		for (const [num, stream] of streams) {
			if (nameOf(stream.dict.get('Type')) !== 'ObjStm' || this.encrypted) continue;
			try {
				const lexer = new Lexer(Buffer.from(this.decode(stream)));
				const count = numberOf(stream.dict.get('N')) ?? 0;
				for (let i = 0; i < count; i++) {
					const objectNum = Number(lexer.word());
					lexer.word();
					if (Number.isInteger(objectNum) && !this.entries.has(objectNum)) {
						this.entries.set(objectNum, { kind: 'compressed', stream: num, index: i });
					}
				}
			} catch {
				// A damaged object stream: its objects stay missing, which reads as null.
				continue;
			}
		}
		if (!dictOf(this.tryResolve(this.trailer.get('Root')))) {
			this.trailer.delete('Root');
			for (const num of this.entries.keys()) {
				if (nameOf(dictOf(this.tryObject(num))?.get('Type')) === 'Catalog') {
					this.trailer.set('Root', { type: 'ref', num, gen: this.gen(num) });
					break;
				}
			}
		}
		this.catalog();
	}

	private mergeTrailer(dict: Dict): void {
		for (const key of ['Root', 'Encrypt', 'ID']) {
			const value = dict.get(key);
			if (value && !this.trailer.has(key)) this.trailer.set(key, value);
		}
	}

	private tryObject(num: number): PdfObject | undefined {
		try {
			return this.object(num);
		} catch {
			return undefined;
		}
	}

	private tryResolve(value: PdfValue | undefined): PdfObject | undefined {
		try {
			return this.resolve(value);
		} catch {
			return undefined;
		}
	}

	/** Lists the pages in order, with the attributes each one inherits from the page tree. */
	pages(): { pages: Page[]; treeNodes: Set<number> } {
		const pages: Page[] = [];
		const treeNodes = new Set<number>();
		const seen = new Set<number>();

		const walk = (ref: PdfValue, inherited: Dict, depth: number) => {
			if (ref.type !== 'ref' || seen.has(ref.num) || depth > 64) return;
			seen.add(ref.num);
			const dict = dictOf(this.tryObject(ref.num));
			if (!dict) return;
			const type = nameOf(dict.get('Type'));
			if (type === 'Pages' || (type !== 'Page' && dict.has('Kids'))) {
				treeNodes.add(ref.num);
				const next = new Map(inherited);
				for (const key of INHERITED_KEYS) {
					const value = dict.get(key);
					if (value) next.set(key, value);
				}
				const kids = this.tryResolve(dict.get('Kids'));
				if (kids?.type === 'array') for (const kid of kids.items) walk(kid, next, depth + 1);
			} else {
				pages.push({ num: ref.num, gen: ref.gen, dict, inherited });
			}
		};

		const root = this.catalog().get('Pages');
		if (root) walk(root, new Map(), 0);
		if (pages.length === 0) throw new PdfError('The PDF has no pages');
		return { pages, treeNodes };
	}

	/** The page's content as text, or undefined when it can't be decoded. */
	contentText(page: Dict): string | undefined {
		if (this.encrypted) return undefined;
		try {
			const contents = this.resolve(page.get('Contents'));
			const parts: PdfObject[] =
				contents?.type === 'array' ? contents.items : contents ? [contents] : [];
			return parts
				.map((part) => {
					const stream = part.type === 'ref' ? this.object(part.num) : part;
					if (stream?.type !== 'stream') throw new PdfError('Bad page contents');
					return Buffer.from(this.decode(stream)).toString('latin1');
				})
				.join('\n');
		} catch {
			return undefined;
		}
	}
}

/**
 * Parses a page selection such as "1-3, 5", "2-" or "1, last" into 0-based page indexes, in
 * document order. Pages past the end of the document are skipped.
 */
export function parsePageRanges(spec: string, pageCount: number): number[] {
	const selected = new Set<number>();
	const pageNumber = (text: string, fallback: number) => {
		const trimmed = text.trim().toLowerCase();
		if (!trimmed) return fallback;
		if (trimmed === 'last') return pageCount;
		if (!INTEGER.test(trimmed) || Number(trimmed) < 1) {
			throw new PdfError(`"${text.trim()}" is not a page number`);
		}
		return Number(trimmed);
	};
	for (const part of spec.split(',')) {
		if (!part.trim()) continue;
		const [from, to, ...rest] = part.split('-');
		if (rest.length > 0) throw new PdfError(`"${part.trim()}" is not a page range`);
		const first = pageNumber(from, 1);
		const last = to === undefined ? first : pageNumber(to, pageCount);
		if (first > last)
			throw new PdfError(`"${part.trim()}" is not a page range: ${first} is after ${last}`);
		for (let page = first; page <= Math.min(last, pageCount); page++) selected.add(page - 1);
	}
	return [...selected].sort((a, b) => a - b);
}

/** Counts the pages in a PDF. */
export function countPdfPages(pdf: Buffer): number {
	return new PdfReader(pdf).pages().pages.length;
}

/**
 * Returns a PDF with only the selected pages, such as "1-3, 5". Images a page's content doesn't
 * draw are left out, so pages sharing one big set of resources don't carry every page's scan.
 * The PDF is returned unchanged when every page is selected.
 */
export function selectPdfPages(
	pdf: Buffer,
	spec: string,
): { pdf: Buffer; pageCount: number; selectedCount: number } {
	const reader = new PdfReader(pdf);
	const { pages, treeNodes } = reader.pages();
	const indexes = parsePageRanges(spec, pages.length);
	if (indexes.length === 0) {
		throw new PdfError(`None of the pages "${spec}" are in this PDF, which has ${pages.length}`);
	}
	if (indexes.length === pages.length) {
		return { pdf, pageCount: pages.length, selectedCount: pages.length };
	}

	const selected = indexes.map((index) => pages[index]);
	const keep = new Set(selected.map((page) => page.num));
	// References to these become null: other pages (from links and bookmarks), the old page tree
	// and the old catalog would otherwise pull the whole document back in.
	const dropped = new Set<number>(treeNodes);
	for (const page of pages) if (!keep.has(page.num)) dropped.add(page.num);
	const root = reader.trailer.get('Root');
	if (root?.type === 'ref') dropped.add(root.num);

	let maxNum = 0;
	for (const num of reader.entries.keys()) maxNum = Math.max(maxNum, num);
	const pagesNum = maxNum + 1;
	const catalogNum = maxNum + 2;

	const objects = new Map<number, PdfObject>();
	const queue: number[] = [];
	const queued = new Set<number>();
	const enqueue = (value: PdfValue) => {
		if (value.type === 'ref') {
			if (!dropped.has(value.num) && !queued.has(value.num)) {
				queued.add(value.num);
				queue.push(value.num);
			}
		} else if (value.type === 'array') {
			value.items.forEach(enqueue);
		} else if (value.type === 'dict') {
			value.entries.forEach(enqueue);
		}
	};

	for (const page of selected) queued.add(page.num);
	for (const page of selected) {
		const dict: Dict = new Map(page.dict);
		for (const key of INHERITED_KEYS) {
			const value = page.inherited.get(key);
			if (!dict.has(key) && value) dict.set(key, value);
		}
		dict.set('Parent', { type: 'ref', num: pagesNum, gen: 0 });
		pruneUnusedImages(reader, dict);
		objects.set(page.num, { type: 'dict', entries: dict });
		for (const [key, value] of dict) if (key !== 'Parent') enqueue(value);
	}

	const catalog: Dict = new Map([
		['Type', { type: 'name', name: 'Catalog' }],
		['Pages', { type: 'ref', num: pagesNum, gen: 0 }],
	]);
	const acroForm = reader.catalog().get('AcroForm');
	if (acroForm) {
		catalog.set('AcroForm', acroForm);
		enqueue(acroForm);
	}
	const encrypt = reader.trailer.get('Encrypt');
	if (encrypt) enqueue(encrypt);

	while (queue.length > 0) {
		const num = queue.shift() as number;
		const object = reader.object(num);
		if (!object) continue;
		objects.set(num, object);
		if (object.type === 'stream') {
			for (const [key, value] of object.dict) if (key !== 'Length') enqueue(value);
		} else {
			enqueue(object);
		}
	}

	objects.set(pagesNum, {
		type: 'dict',
		entries: new Map<string, PdfValue>([
			['Type', { type: 'name', name: 'Pages' }],
			[
				'Kids',
				{
					type: 'array',
					items: selected.map((page) => ({ type: 'ref', num: page.num, gen: page.gen })),
				},
			],
			['Count', { type: 'raw', text: String(selected.length) }],
		]),
	});
	objects.set(catalogNum, { type: 'dict', entries: catalog });

	const gen = (num: number) => (num > maxNum ? 0 : reader.gen(num));
	const writer = new PdfWriter((num) => objects.has(num) && !dropped.has(num), gen);
	const version = /^%PDF-(\d\.\d)/.exec(pdf.toString('latin1', 0, 16))?.[1] ?? '1.7';
	const output = writer.write(version, objects, {
		Root: { type: 'ref', num: catalogNum, gen: 0 },
		Encrypt: encrypt,
		ID: reader.trailer.get('ID'),
	});
	return { pdf: output, pageCount: pages.length, selectedCount: selected.length };
}

/** Leaves out the images in a page's resources that its content never draws. */
function pruneUnusedImages(reader: PdfReader, page: Dict): void {
	const resources = dictOf(reader.resolve(page.get('Resources')));
	const xobjects = dictOf(reader.resolve(resources?.get('XObject')));
	if (!resources || !xobjects || xobjects.size === 0) return;
	const content = reader.contentText(page);
	if (content === undefined) return;

	const used = new Set<string>();
	const pattern = /\/([^\s/[\]()<>{}%]+)\s*Do\b/g;
	for (let match = pattern.exec(content); match; match = pattern.exec(content)) {
		used.add(decodeName(match[1]));
	}
	const kept = new Map([...xobjects].filter(([name]) => used.has(decodeName(name))));
	if (kept.size === xobjects.size) return;
	const pruned = new Map(resources);
	pruned.set('XObject', { type: 'dict', entries: kept });
	page.set('Resources', { type: 'dict', entries: pruned });
}

/** Writes objects as a PDF with a classic cross-reference table. */
class PdfWriter {
	private readonly chunks: Buffer[] = [];
	private length = 0;

	constructor(
		private readonly exists: (num: number) => boolean,
		private readonly gen: (num: number) => number,
	) {}

	write(
		version: string,
		objects: Map<number, PdfObject>,
		trailer: Record<string, PdfValue | undefined>,
	): Buffer {
		this.text(`%PDF-${version}\n%\u00e2\u00e3\u00cf\u00d3\n`);
		const offsets = new Map<number, number>();
		const nums = [...objects.keys()].sort((a, b) => a - b);
		for (const num of nums) {
			offsets.set(num, this.length);
			this.text(`${num} ${this.gen(num)} obj\n`);
			const object = objects.get(num) as PdfObject;
			if (object.type === 'stream') {
				const dict = new Map(object.dict);
				dict.set('Length', { type: 'raw', text: String(object.data.length) });
				this.value({ type: 'dict', entries: dict });
				this.text('\nstream\n');
				this.bytes(object.data);
				this.text('\nendstream');
			} else {
				this.value(object);
			}
			this.text('\nendobj\n');
		}

		const xref = this.length;
		this.text('xref\n0 1\n0000000000 65535 f\r\n');
		for (let i = 0; i < nums.length; ) {
			let end = i;
			while (end + 1 < nums.length && nums[end + 1] === nums[end] + 1) end++;
			this.text(`${nums[i]} ${end - i + 1}\n`);
			for (let k = i; k <= end; k++) {
				const offset = String(offsets.get(nums[k])).padStart(10, '0');
				this.text(`${offset} ${String(this.gen(nums[k])).padStart(5, '0')} n\r\n`);
			}
			i = end + 1;
		}
		const trailerDict: Dict = new Map([
			['Size', { type: 'raw', text: String(nums[nums.length - 1] + 1) }],
		]);
		for (const [key, value] of Object.entries(trailer)) if (value) trailerDict.set(key, value);
		this.text('trailer\n');
		this.value({ type: 'dict', entries: trailerDict });
		this.text(`\nstartxref\n${xref}\n%%EOF\n`);
		return Buffer.concat(this.chunks);
	}

	private text(text: string): void {
		this.bytes(Buffer.from(text, 'latin1'));
	}

	private bytes(bytes: Buffer): void {
		this.chunks.push(bytes);
		this.length += bytes.length;
	}

	private value(value: PdfValue): void {
		switch (value.type) {
			case 'raw':
				this.text(value.text);
				break;
			case 'name':
				this.text(`/${value.name}`);
				break;
			case 'string':
				this.bytes(value.bytes);
				break;
			case 'ref':
				this.text(this.exists(value.num) ? `${value.num} ${this.gen(value.num)} R` : 'null');
				break;
			case 'array':
				this.text('[');
				value.items.forEach((item, i) => {
					if (i > 0) this.text(' ');
					this.value(item);
				});
				this.text(']');
				break;
			case 'dict':
				this.text('<<');
				for (const [key, item] of value.entries) {
					this.text(`/${key} `);
					this.value(item);
				}
				this.text('>>');
				break;
		}
	}
}
