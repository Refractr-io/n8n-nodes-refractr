export type FileKind =
	| 'pdf'
	| 'docx'
	| 'odt'
	| 'jpeg'
	| 'png'
	| 'tiff'
	| 'webp'
	| 'bmp'
	| 'gif'
	| 'heic'
	| 'text'
	| 'html'
	| 'unknown';

export interface FileType {
	kind: FileKind;
	mimeType: string;
	extension: string;
	isImage: boolean;
}

const KINDS: Record<FileKind, [mimeType: string, extension: string]> = {
	pdf: ['application/pdf', 'pdf'],
	docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
	odt: ['application/vnd.oasis.opendocument.text', 'odt'],
	jpeg: ['image/jpeg', 'jpg'],
	png: ['image/png', 'png'],
	tiff: ['image/tiff', 'tif'],
	webp: ['image/webp', 'webp'],
	bmp: ['image/bmp', 'bmp'],
	gif: ['image/gif', 'gif'],
	heic: ['image/heic', 'heic'],
	text: ['text/plain', 'txt'],
	html: ['text/html', 'html'],
	unknown: ['application/octet-stream', 'bin'],
};

const IMAGE_KINDS = new Set<FileKind>(['jpeg', 'png', 'tiff', 'webp', 'bmp', 'gif', 'heic']);
const TEXT_EXTENSIONS = new Set(['txt', 'text', 'csv', 'tsv', 'md', 'json', 'xml', 'log']);
const TEXT_MIME_TYPES = new Set(['application/json', 'application/xml', 'application/csv']);
const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1']);

function sniff(data: Buffer): FileKind | undefined {
	const hex = data.toString('hex', 0, 12);
	const ascii = data.toString('latin1', 0, 12);
	// Some PDF writers put a few bytes before the header; readers accept up to 1 KB.
	if (data.subarray(0, 1024).includes('%PDF-')) return 'pdf';
	if (hex.startsWith('ffd8ff')) return 'jpeg';
	if (hex.startsWith('89504e470d0a1a0a')) return 'png';
	if (hex.startsWith('49492a00') || hex.startsWith('4d4d002a')) return 'tiff';
	if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') return 'webp';
	if (ascii.startsWith('GIF87a') || ascii.startsWith('GIF89a')) return 'gif';
	if (ascii.slice(4, 8) === 'ftyp' && HEIF_BRANDS.has(ascii.slice(8, 12))) return 'heic';
	// A BMP header holds the file's size, which tells it apart from text that starts with BM.
	if (ascii.startsWith('BM') && data.length >= 6 && data.readUInt32LE(2) === data.length)
		return 'bmp';
	if (hex.startsWith('504b0304')) {
		if (data.toString('latin1', 30, 77) === 'mimetypeapplication/vnd.oasis.opendocument.text') {
			return 'odt';
		}
		if (data.includes('word/document.xml')) return 'docx';
	}
	return undefined;
}

/** Whether the bytes look like UTF-8 or UTF-16 text rather than a binary file. */
function looksLikeText(data: Buffer): boolean {
	const head = data.subarray(0, 65536);
	if (head.length === 0) return false;
	if (head[0] === 0xff && head[1] === 0xfe) return true;
	if (head[0] === 0xfe && head[1] === 0xff) return true;
	if (head.includes(0)) return false;
	try {
		new TextDecoder('utf-8', { fatal: true }).decode(head, { stream: true });
		return true;
	} catch {
		return false;
	}
}

function isHtml(data: Buffer, mimeType: string, extension: string): boolean {
	if (mimeType === 'text/html' || extension === 'html' || extension === 'htm') return true;
	const start = data.toString('utf8', 0, 512).replace(/^\uFEFF/, '').trimStart().toLowerCase();
	return start.startsWith('<!doctype html') || start.startsWith('<html');
}

/**
 * Works out what a file is from its first bytes, and from its MIME type and name when the bytes
 * don't say. Text files are told apart so they can be sent as text.
 */
export function detectFileType(data: Buffer, mimeType = '', fileName = ''): FileType {
	const declared = mimeType.split(';')[0].trim().toLowerCase();
	const extension = /\.([a-z0-9]+)$/i.exec(fileName)?.[1].toLowerCase() ?? '';

	let kind = sniff(data);
	if (!kind) {
		const declaredText =
			declared.startsWith('text/') ||
			TEXT_MIME_TYPES.has(declared) ||
			TEXT_EXTENSIONS.has(extension) ||
			extension === 'html' ||
			extension === 'htm';
		const undeclared = !declared || declared === 'application/octet-stream';
		if ((declaredText || undeclared) && looksLikeText(data)) {
			kind = isHtml(data, declared, extension) ? 'html' : 'text';
		}
	}
	kind ??= 'unknown';

	const [knownMimeType, knownExtension] = KINDS[kind];
	return {
		kind,
		mimeType: kind === 'unknown' && declared ? declared : knownMimeType,
		extension: kind === 'unknown' && extension ? extension : knownExtension,
		isImage: IMAGE_KINDS.has(kind) || (kind === 'unknown' && declared.startsWith('image/')),
	};
}

/** Decodes a text file, honoring a UTF-16 byte order mark. */
export function decodeText(data: Buffer): string {
	if (data[0] === 0xff && data[1] === 0xfe) return data.toString('utf16le', 2);
	if (data[0] === 0xfe && data[1] === 0xff) {
		const swapped = Buffer.from(data.subarray(2));
		swapped.swap16();
		return swapped.toString('utf16le');
	}
	return data.toString('utf8').replace(/^\uFEFF/, '');
}

const ENTITIES: Record<string, string> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
	nbsp: ' ',
	euro: '€',
	pound: '£',
	yen: '¥',
	copy: '©',
	reg: '®',
	ndash: '–',
	mdash: '—',
	hellip: '…',
	lsquo: '‘',
	rsquo: '’',
	ldquo: '“',
	rdquo: '”',
};

/** Turns HTML, such as an email body, into plain text with one line per block. */
export function htmlToText(html: string): string {
	return html
		.replace(/<!--[\s\S]*?-->/g, ' ')
		.replace(/<(script|style|head)\b[\s\S]*?<\/\1\s*>/gi, ' ')
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(
			/<\/(p|div|tr|li|h[1-6]|table|thead|tbody|section|article|header|footer|blockquote)\s*>/gi,
			'\n',
		)
		.replace(/<\/t[dh]\s*>/gi, '\t')
		.replace(/<[^>]*>/g, '')
		.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code: string) => {
			if (code[0] !== '#') return ENTITIES[code.toLowerCase()] ?? entity;
			const point =
				code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
			return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : entity;
		})
		.split('\n')
		.map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
		.join('\n')
		.replace(/\n{2,}/g, '\n')
		.trim();
}
