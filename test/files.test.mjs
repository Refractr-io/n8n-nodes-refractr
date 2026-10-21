// Tests for PDF page selection, image downscaling and file type detection (run `npm run build` first).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { deflateSync } from 'node:zlib';

const require = createRequire(import.meta.url);
const jpeg = require('jpeg-js');
const {
	countPdfPages,
	parsePageRanges,
	selectPdfPages,
} = require('../dist/nodes/Refractr/files/PdfPages.js');
const { downscaleImage, imageInfo } = require('../dist/nodes/Refractr/files/Images.js');
const { detectFileType, htmlToText } = require('../dist/nodes/Refractr/files/FileType.js');

/**
 * Builds a PDF with one line of text and one tiny image per page. `layout` is classic (an xref
 * table), compressed (an object stream and an xref stream) or incremental (a classic file with
 * an update that replaces page 1's text). With `sharedResources`, every image is in one
 * resource dictionary on the page tree, which all pages inherit.
 */
function buildPdf({ pages = 4, layout = 'classic', sharedResources = false } = {}) {
	const objects = new Map();
	const pageNums = [];
	const imageNums = [];
	let next = 4;
	for (let i = 1; i <= pages; i++) {
		imageNums.push(next++);
		pageNums.push(next++);
		next++; // contents
	}
	const xobjects = (indexes) =>
		`<< ${indexes.map((i) => `/Im${i + 1} ${imageNums[i]} 0 R`).join(' ')} >>`;
	const resources = (indexes) => `<< /Font << /F1 3 0 R >> /XObject ${xobjects(indexes)} >>`;
	const all = [...Array(pages).keys()];

	objects.set(1, '<< /Type /Catalog /Pages 2 0 R >>');
	objects.set(
		2,
		`<< /Type /Pages /Kids [${pageNums.map((n) => `${n} 0 R`).join(' ')}] /Count ${pages} /MediaBox [0 0 200 200]${sharedResources ? ` /Resources ${resources(all)}` : ''} >>`,
	);
	objects.set(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
	for (let i = 0; i < pages; i++) {
		const content = `BT /F1 12 Tf 20 100 Td (Page ${i + 1}) Tj ET q 10 0 0 10 0 0 cm /Im${i + 1} Do Q`;
		objects.set(imageNums[i], {
			dict: '/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 8',
			data: Buffer.from(`im${String(i + 1).padStart(2, '0')}`),
		});
		objects.set(
			pageNums[i],
			`<< /Type /Page /Parent 2 0 R /Contents ${pageNums[i] + 1} 0 R${sharedResources ? '' : ` /Resources ${resources([i])}`} >>`,
		);
		objects.set(pageNums[i] + 1, { dict: '', data: Buffer.from(content) });
	}
	const size = next;

	const chunks = [];
	let length = 0;
	const write = (part) => {
		const buffer = Buffer.isBuffer(part) ? part : Buffer.from(part, 'latin1');
		chunks.push(buffer);
		length += buffer.length;
	};
	const writeObject = (num, object) => {
		const offset = length;
		if (typeof object === 'string') {
			write(`${num} 0 obj\n${object}\nendobj\n`);
		} else {
			write(`${num} 0 obj\n<< ${object.dict} /Length ${object.data.length} >>\nstream\n`);
			write(object.data);
			write('\nendstream\nendobj\n');
		}
		return offset;
	};
	const xrefTable = (offsets, extraTrailer = '') => {
		const xref = length;
		const nums = [...offsets.keys()].sort((a, b) => a - b);
		write('xref\n0 1\n0000000000 65535 f\r\n');
		for (const num of nums) {
			write(`${num} 1\n${String(offsets.get(num)).padStart(10, '0')} 00000 n\r\n`);
		}
		write(`trailer\n<< /Size ${size} /Root 1 0 R${extraTrailer} >>\nstartxref\n${xref}\n%%EOF\n`);
		return xref;
	};

	write('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n');
	if (layout === 'compressed') {
		const inStream = [...objects].filter(([, object]) => typeof object === 'string');
		let header = '';
		let body = '';
		for (const [num, object] of inStream) {
			header += `${num} ${body.length} `;
			body += `${object}\n`;
		}
		const objStmNum = size;
		const offsets = new Map();
		for (const [num, object] of objects) {
			if (typeof object !== 'string') offsets.set(num, writeObject(num, object));
		}
		const packed = deflateSync(Buffer.from(header + body, 'latin1'));
		offsets.set(
			objStmNum,
			writeObject(objStmNum, {
				dict: `/Type /ObjStm /N ${inStream.length} /First ${header.length} /Filter /FlateDecode`,
				data: packed,
			}),
		);
		// An xref stream with PNG Up prediction, as most PDF writers make them.
		const xrefNum = size + 1;
		const xrefOffset = length;
		const rows = [];
		let previous = Buffer.alloc(7);
		for (let num = 0; num < size + 2; num++) {
			const row = Buffer.alloc(7);
			if (num === xrefNum) {
				row.writeUInt8(1, 0);
				row.writeUInt32BE(xrefOffset, 1);
			} else if (offsets.has(num)) {
				row.writeUInt8(1, 0);
				row.writeUInt32BE(offsets.get(num), 1);
			} else if (inStream.some(([n]) => n === num)) {
				row.writeUInt8(2, 0);
				row.writeUInt32BE(objStmNum, 1);
				row.writeUInt16BE(
					inStream.findIndex(([n]) => n === num),
					5,
				);
			}
			const up = Buffer.from(row.map((byte, i) => (byte - previous[i]) & 0xff));
			rows.push(Buffer.from([2]), up);
			previous = row;
		}
		writeObject(xrefNum, {
			dict: `/Type /XRef /Size ${size + 2} /W [1 4 2] /Root 1 0 R /Filter /FlateDecode /DecodeParms << /Predictor 12 /Columns 7 >>`,
			data: deflateSync(Buffer.concat(rows)),
		});
		write(`startxref\n${xrefOffset}\n%%EOF\n`);
	} else {
		const offsets = new Map();
		for (const [num, object] of objects) offsets.set(num, writeObject(num, object));
		const xref = xrefTable(offsets);
		if (layout === 'incremental') {
			const contentNum = pageNums[0] + 1;
			const content = 'BT /F1 12 Tf 20 100 Td (Page 1 edited) Tj ET q 10 0 0 10 0 0 cm /Im1 Do Q';
			const update = new Map([
				[contentNum, writeObject(contentNum, { dict: '', data: Buffer.from(content) })],
			]);
			xrefTable(update, ` /Prev ${xref}`);
		}
	}
	return Buffer.concat(chunks);
}

const text = (pdf) => pdf.toString('latin1');

for (const layout of ['classic', 'compressed', 'incremental']) {
	test(`selects pages from a ${layout} PDF`, () => {
		const pdf = buildPdf({ pages: 5, layout });
		assert.equal(countPdfPages(pdf), 5);
		const result = selectPdfPages(pdf, '2, 4-5');
		assert.equal(result.pageCount, 5);
		assert.equal(result.selectedCount, 3);
		assert.equal(countPdfPages(result.pdf), 3);
		const output = text(result.pdf);
		for (const page of [2, 4, 5]) assert.ok(output.includes(`(Page ${page})`), `has page ${page}`);
		for (const page of [1, 3]) assert.ok(!output.includes(`(Page ${page})`), `no page ${page}`);
		assert.ok(output.includes('/MediaBox'), 'inherited attributes are copied to the pages');
	});
}

test('an incremental update replaces the older version of an object', () => {
	const output = text(selectPdfPages(buildPdf({ layout: 'incremental' }), '1').pdf);
	assert.ok(output.includes('(Page 1 edited)'));
	assert.ok(!output.includes('(Page 1)'));
});

test('leaves out images that the selected pages do not draw', () => {
	const pdf = buildPdf({ pages: 4, sharedResources: true });
	const output = text(selectPdfPages(pdf, '3').pdf);
	assert.ok(output.includes('im03'));
	for (const image of ['im01', 'im02', 'im04']) assert.ok(!output.includes(image), image);
});

test('reads a PDF whose cross-reference offsets are wrong', () => {
	const pdf = Buffer.concat([Buffer.from('junk before the header\n'), buildPdf({ pages: 3 })]);
	const result = selectPdfPages(pdf, '2');
	assert.equal(countPdfPages(result.pdf), 1);
	assert.ok(text(result.pdf).includes('(Page 2)'));
});

test('returns the PDF unchanged when every page is selected', () => {
	const pdf = buildPdf({ pages: 3 });
	assert.equal(selectPdfPages(pdf, '1-').pdf, pdf);
});

test('parses page ranges', () => {
	assert.deepEqual(parsePageRanges('1-3, 5', 10), [0, 1, 2, 4]);
	assert.deepEqual(parsePageRanges('8-', 10), [7, 8, 9]);
	assert.deepEqual(parsePageRanges('-2', 10), [0, 1]);
	assert.deepEqual(parsePageRanges('1, last', 10), [0, 9]);
	assert.deepEqual(parsePageRanges('5, 1, 5', 10), [0, 4]);
	assert.deepEqual(parsePageRanges('2-4', 3), [1, 2], 'pages past the end are skipped');
	assert.deepEqual(parsePageRanges('7', 3), []);
	assert.throws(() => parsePageRanges('a', 3), /not a page number/);
	assert.throws(() => parsePageRanges('0', 3), /not a page number/);
	assert.throws(() => parsePageRanges('3-1', 3), /3 is after 1/);
	assert.throws(() => parsePageRanges('1-2-3', 3), /not a page range/);
	assert.throws(() => selectPdfPages(buildPdf({ pages: 3 }), '7'), /None of the pages/);
});

function gradient(width, height) {
	const data = Buffer.alloc(width * height * 4);
	for (let i = 0; i < width * height; i++) {
		data[i * 4] = (i % width) % 256;
		data[i * 4 + 1] = Math.floor(i / width) % 256;
		data[i * 4 + 2] = 128;
		data[i * 4 + 3] = 255;
	}
	return { width, height, data };
}

/** Adds an EXIF block with an orientation tag right after a JPEG's start marker. */
function withOrientation(jpegData, orientation) {
	const tiff = Buffer.from([
		0x4d,
		0x4d,
		0x00,
		0x2a,
		0x00,
		0x00,
		0x00,
		0x08, // big-endian header, IFD at 8
		0x00,
		0x01, // one entry
		0x01,
		0x12,
		0x00,
		0x03,
		0x00,
		0x00,
		0x00,
		0x01,
		0x00,
		orientation,
		0x00,
		0x00,
		0x00,
		0x00,
		0x00,
		0x00, // no next IFD
	]);
	const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
	const segment = Buffer.alloc(4);
	segment.writeUInt16BE(0xffe1, 0);
	segment.writeUInt16BE(body.length + 2, 2);
	return Buffer.concat([jpegData.subarray(0, 2), segment, body, jpegData.subarray(2)]);
}

function png(width, height, colorType, depth, rows, chunks = []) {
	const chunk = (type, data) => {
		const length = Buffer.alloc(4);
		length.writeUInt32BE(data.length);
		return Buffer.concat([length, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = depth;
	header[9] = colorType;
	const raw = Buffer.concat(rows.map((row) => Buffer.concat([Buffer.from([0]), row])));
	return Buffer.concat([
		Buffer.from('89504e470d0a1a0a', 'hex'),
		chunk('IHDR', header),
		...chunks.map(([type, data]) => chunk(type, data)),
		chunk('IDAT', deflateSync(raw)),
		chunk('IEND', Buffer.alloc(0)),
	]);
}

test('downscales a large JPEG and leaves a small one alone', () => {
	const big = jpeg.encode(gradient(3000, 1200), 90).data;
	assert.deepEqual(imageInfo(big), { width: 3000, height: 1200, orientation: 1 });
	const result = downscaleImage(big, 1000);
	assert.equal(result.width, 1000);
	assert.equal(result.height, 400);
	const decoded = jpeg.decode(result.data);
	assert.equal(decoded.width, 1000);
	assert.equal(decoded.height, 400);
	assert.equal(downscaleImage(big, 3000), undefined);
});

test('turns a JPEG the way its EXIF orientation says', () => {
	const rotated = withOrientation(jpeg.encode(gradient(1200, 600), 90).data, 6);
	assert.equal(imageInfo(rotated).orientation, 6);
	const result = downscaleImage(rotated, 600);
	assert.equal(result.width, 300);
	assert.equal(result.height, 600);
});

test('downscales PNGs onto white, including palette images', () => {
	const red = Buffer.alloc(1200 * 4);
	for (let x = 0; x < 1200; x++) red.set([255, 0, 0, 255], x * 4);
	const clear = Buffer.alloc(1200 * 4);
	const rgba = png(1200, 2, 6, 8, [red, clear]);
	const result = downscaleImage(rgba, 600);
	assert.equal(result.width, 600);
	const decoded = jpeg.decode(result.data);
	// One output row: half red and half transparent, so pink.
	assert.ok(decoded.data[0] > 240 && decoded.data[1] > 100 && decoded.data[1] < 155);

	const palette = Buffer.from([0, 0, 0, 255, 255, 255]);
	const stripes = Buffer.alloc(1000 / 8, 0x0f); // 1-bit: 4 black then 4 white pixels
	const indexed = png(1000, 1, 3, 1, [stripes], [['PLTE', palette]]);
	const gray = jpeg.decode(downscaleImage(indexed, 125).data); // 8 pixels each
	assert.ok(Math.abs(gray.data[0] - 128) < 20, `about half gray: ${gray.data[0]}`);
});

test('sends images it cannot decode as they are', () => {
	const broken = Buffer.from(jpeg.encode(gradient(3000, 100), 90).data.subarray(0, 600));
	assert.equal(downscaleImage(broken, 1000), undefined);
});

test('detects file types from content, then from the MIME type and name', () => {
	const kind = (data, mimeType, fileName) =>
		detectFileType(Buffer.from(data, 'latin1'), mimeType, fileName);
	assert.equal(kind('%PDF-1.7\n...').kind, 'pdf');
	assert.equal(kind('\xff\xd8\xff\xe0...').kind, 'jpeg');
	assert.equal(kind('\x89PNG\r\n\x1a\n....').kind, 'png');
	assert.equal(kind('\0\0\0\x18ftypheic....').kind, 'heic');
	assert.equal(kind('PK\x03\x04....word/document.xml').kind, 'docx');
	assert.equal(kind('Invoice 2847\nTotal 10.00', 'text/plain').kind, 'text');
	assert.equal(kind('Invoice 2847', '', 'invoice.txt').kind, 'text');
	assert.equal(kind('Invoice 2847', 'application/octet-stream').kind, 'text');
	assert.equal(kind('<!DOCTYPE html><p>Hi</p>').kind, 'html');
	assert.equal(kind('<p>Hi</p>', 'text/html').kind, 'html');
	const photo = kind('????', 'image/jpeg');
	assert.equal(photo.kind, 'unknown');
	assert.equal(photo.isImage, true);
	assert.equal(kind('\0\x01binary', 'application/x-thing').kind, 'unknown');
	assert.equal(kind('%PDF-1.7').mimeType, 'application/pdf');
});

test('turns HTML into text', () => {
	const html =
		'<html><head><title>x</title><style>p{}</style></head><body><p>Invoice&nbsp;#2847</p>' +
		'<table><tr><td>Total</td><td>&euro;1,249.00</td></tr></table><!-- note --><br>Thanks &amp; bye</body></html>';
	assert.equal(htmlToText(html), 'Invoice #2847\nTotal €1,249.00\nThanks & bye');
});
