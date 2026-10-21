// Tests for the compiled node (run `npm run build` first). The Refractr API is mocked.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { Refractr } = require('../dist/nodes/Refractr/Refractr.node.js');
const { buildTemplate } = require('../dist/nodes/Refractr/GenericFunctions.js');
const { countPdfPages } = require('../dist/nodes/Refractr/files/PdfPages.js');

const NODE = {
	id: '1',
	name: 'Refractr',
	type: 'n8n-nodes-refractr.refractr',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};

const DEFAULTS = {
	resource: 'extraction',
	operation: 'extract',
	inputType: 'binary',
	binaryPropertyName: 'data',
	ocr: 'auto',
	schemaMode: 'fields',
	fields: {
		field: [
			{ name: 'invoice_number', type: 'str' },
			{ name: 'total_amount', type: 'float' },
		],
	},
	routeByConfidence: true,
	confidenceThreshold: 0.9,
	simplify: true,
	options: {},
};

function success(data, confidence, extra = {}) {
	return {
		statusCode: 200,
		headers: {},
		body: {
			job_id: 'job-1',
			status: 'success',
			extracted_data: data,
			confidence,
			validation: { warnings: [] },
			metadata: { model: 'refractr-v9', inference_ms: 300, credits_charged: 1 },
			...extra,
		},
	};
}

/** Runs the node with mocked n8n helpers. `responses` are returned in order, one per HTTP call. */
async function run({ params = {}, items, responses, continueOnFail = false, download }) {
	const parameters = { ...DEFAULTS, ...params };
	const calls = [];
	const downloads = [];
	const queue = [...responses];
	items ??= [
		{
			json: {},
			binary: {
				data: {
					data: Buffer.from('%PDF-1.4 test').toString('base64'),
					mimeType: 'application/pdf',
				},
			},
		},
	];

	const context = {
		getInputData: () => items,
		getNode: () => NODE,
		continueOnFail: () => continueOnFail,
		getCredentials: async () => ({ apiKey: 're_test', baseUrl: 'https://api.refractr.io/' }),
		getNodeParameter(name, i, fallback) {
			const value = name
				.split('.')
				.reduce((obj, key) => (obj == null ? undefined : obj[key]), parameters);
			return value === undefined ? fallback : value;
		},
		helpers: {
			async httpRequestWithAuthentication(credentialType, options) {
				assert.equal(credentialType, 'refractrApi');
				calls.push(structuredClone(options));
				const next = queue.shift();
				if (!next) throw new Error(`Unexpected request: ${options.method} ${options.url}`);
				return next;
			},
			async httpRequest(options) {
				downloads.push(options);
				if (!download) throw new Error(`Unexpected download: ${options.url}`);
				return download;
			},
			prepareBinaryData: async (data, fileName, mimeType) => ({
				data: data.toString('base64'),
				fileName,
				mimeType,
			}),
			assertBinaryData: (i, name) => items[i].binary[name],
			getBinaryDataBuffer: async (i, name) => Buffer.from(items[i].binary[name].data, 'base64'),
		},
	};
	const output = await new Refractr().execute.call(context);
	return { output, calls, downloads };
}

test('builds a nested template from fields', () => {
	assert.deepEqual(
		buildTemplate(
			NODE,
			[
				{ name: 'invoice_number', type: 'str' },
				{ name: 'vendor.name', type: 'str' },
				{ name: 'vendor.vat', type: 'str' },
				{ name: 'tags', type: 'str[]' },
				{ name: 'due', type: 'date' },
			],
			0,
		),
		{
			invoice_number: '__str__',
			vendor: { name: '__str__', vat: '__str__' },
			tags: ['__str__'],
			due: '__date__',
		},
	);
	assert.throws(
		() =>
			buildTemplate(
				NODE,
				[
					{ name: 'a', type: 'str' },
					{ name: 'a', type: 'int' },
				],
				0,
			),
		/more than once/,
	);
	assert.throws(
		() =>
			buildTemplate(
				NODE,
				[
					{ name: 'a', type: 'str' },
					{ name: 'a.b', type: 'int' },
				],
				0,
			),
		/both a value/,
	);
	assert.throws(() => buildTemplate(NODE, [], 0), /at least one field/);
});

test('sends the file as base64 with the template, and routes a confident result to output 1', async () => {
	const { output, calls } = await run({
		responses: [
			success(
				{ invoice_number: 'INV-1', total_amount: 10.5 },
				{ invoice_number: 0.99, total_amount: 0.95 },
			),
		],
	});
	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, 'https://api.refractr.io/api/v1/extract/');
	assert.equal(calls[0].method, 'POST');
	assert.deepEqual(calls[0].body.template, {
		invoice_number: '__str__',
		total_amount: '__float__',
	});
	assert.equal(Buffer.from(calls[0].body.document, 'base64').toString(), '%PDF-1.4 test');
	assert.equal(calls[0].body.ocr, false);
	assert.equal(calls[0].body.wait, true);

	assert.equal(output.length, 2);
	assert.equal(output[0].length, 1);
	assert.equal(output[1].length, 0);
	const json = output[0][0].json;
	assert.deepEqual(json.data, { invoice_number: 'INV-1', total_amount: 10.5 });
	assert.equal(json.needsReview, false);
	assert.equal(json.creditsCharged, 1);
	assert.ok(output[0][0].binary.data, 'the file is passed on');
});

test('routes low confidence and missing required fields to Needs Review; ignores unscored fields', async () => {
	const { output } = await run({
		params: { options: { requiredFields: 'invoice_number, po_number' } },
		responses: [
			success(
				{ invoice_number: 'INV-1', total_amount: 10.5, po_number: null, sentiment: 'ok' },
				{ invoice_number: 0.99, total_amount: 0.71, po_number: 0.98, sentiment: null },
			),
		],
	});
	assert.equal(output[0].length, 0);
	const json = output[1][0].json;
	assert.equal(json.needsReview, true);
	assert.deepEqual(json.lowConfidenceFields, ['total_amount']);
	assert.deepEqual(json.reviewReasons, [
		'total_amount: confidence 0.71 is below 0.9',
		'po_number: required but not found',
	]);
});

test('a result without confidence scores needs review', async () => {
	const response = success({ invoice_number: 'INV-1' }, undefined);
	delete response.body.confidence;
	const { output } = await run({ responses: [response] });
	assert.equal(output[1].length, 1);
	assert.match(output[1][0].json.reviewReasons[0], /No confidence scores/);
});

test('with routing off there is one output and review fields are still added', async () => {
	const { output } = await run({
		params: { routeByConfidence: false },
		responses: [success({ invoice_number: 'INV-1' }, { invoice_number: 0.5 })],
	});
	assert.equal(output.length, 1);
	assert.equal(output[0][0].json.needsReview, true);
});

test('OCR auto: a PDF without a text layer is retried with OCR', async () => {
	const { output, calls } = await run({
		responses: [
			{
				statusCode: 422,
				headers: {},
				body: { error: { code: 'OCR_REQUIRED', message: 'This PDF has no text layer.' } },
			},
			success(
				{ invoice_number: 'INV-1', total_amount: 1 },
				{ invoice_number: 0.99, total_amount: 0.99 },
			),
		],
	});
	assert.deepEqual(
		calls.map((call) => call.body.ocr),
		[false, true],
	);
	assert.equal(output[0].length, 1);
});

test('OCR auto: images go straight to OCR; OCR never does not retry', async () => {
	const image = [{ json: {}, binary: { data: { data: 'aGk=', mimeType: 'image/jpeg' } } }];
	const { calls } = await run({ items: image, responses: [success({}, {})] });
	assert.equal(calls[0].body.ocr, true);

	await assert.rejects(
		run({
			params: { ocr: 'never' },
			responses: [
				{
					statusCode: 422,
					headers: {},
					body: { error: { code: 'OCR_REQUIRED', message: 'No text layer.' } },
				},
			],
		}),
		(error) => error.message.includes('OCR_REQUIRED') && error.httpCode === '422',
	);
});

test('text input sends document_text', async () => {
	const { calls } = await run({
		params: { inputType: 'text', text: 'Invoice #2847, total EUR 1,249.00' },
		items: [{ json: {} }],
		responses: [
			success(
				{ invoice_number: '2847', total_amount: 1249 },
				{ invoice_number: 0.99, total_amount: 0.99 },
			),
		],
	});
	assert.equal(calls[0].body.document_text, 'Invoice #2847, total EUR 1,249.00');
	assert.equal(calls[0].body.document, undefined);
});

test('JSON template mode passes the template through', async () => {
	const template = '{"line_items": [{"sku": "__str__", "amount": "__float__"}]}';
	const { calls, output } = await run({
		params: { schemaMode: 'json', template },
		responses: [
			success(
				{ line_items: [{ sku: 'A', amount: 1 }] },
				{ 'line_items[0].sku': 0.95, 'line_items[0].amount': 0.42 },
			),
		],
	});
	assert.deepEqual(calls[0].body.template, JSON.parse(template));
	assert.deepEqual(output[1][0].json.lowConfidenceFields, ['line_items[0].amount']);

	await assert.rejects(
		run({ params: { schemaMode: 'json', template: '{oops' }, responses: [] }),
		/not valid JSON/,
	);
});

test('waits and retries after a 429', async () => {
	const { calls, output } = await run({
		responses: [
			{
				statusCode: 429,
				headers: { 'retry-after': '1' },
				body: { detail: 'Request was throttled.' },
			},
			success(
				{ invoice_number: 'INV-1', total_amount: 1 },
				{ invoice_number: 0.99, total_amount: 0.99 },
			),
		],
	});
	assert.equal(calls.length, 2);
	assert.equal(output[0].length, 1);
});

test('submit and poll: polls the job until it succeeds', async () => {
	const { calls, output } = await run({
		params: { options: { waitMode: 'async' } },
		responses: [
			{ statusCode: 202, headers: {}, body: { job_id: 'job-9', status: 'queued' } },
			{
				statusCode: 200,
				headers: {},
				body: { job_id: 'job-9', status: 'processing', queue_depth: 0 },
			},
			success(
				{ invoice_number: 'INV-1', total_amount: 1 },
				{ invoice_number: 0.99, total_amount: 0.99 },
				{ job_id: 'job-9' },
			),
		],
	});
	assert.equal(calls[0].body.wait, false);
	assert.deepEqual(
		calls.slice(1).map((call) => `${call.method} ${call.url}`),
		[
			'GET https://api.refractr.io/api/v1/extract/job-9/',
			'GET https://api.refractr.io/api/v1/extract/job-9/',
		],
	);
	assert.equal(output[0][0].json.jobId, 'job-9');
});

test('get job returns a finished job; a failed job is an error', async () => {
	const { output } = await run({
		params: { operation: 'getJob', jobId: ' job-5 ' },
		items: [{ json: {} }],
		responses: [
			success({ invoice_number: 'INV-1' }, { invoice_number: 0.99 }, { job_id: 'job-5' }),
		],
	});
	assert.equal(output[0][0].json.jobId, 'job-5');

	await assert.rejects(
		run({
			params: { operation: 'getJob', jobId: 'job-6' },
			items: [{ json: {} }],
			responses: [
				{
					statusCode: 200,
					headers: {},
					body: {
						job_id: 'job-6',
						status: 'error',
						error: { code: 'OCR_FAILED', message: 'The file could not be read.' },
					},
				},
			],
		}),
		/OCR_FAILED/,
	);
});

test('a 504 explains how to switch to Submit and Poll', async () => {
	await assert.rejects(
		run({
			responses: [{ statusCode: 504, headers: {}, body: '<html>504: Gateway time-out</html>' }],
		}),
		/Submit and Poll/,
	);
});

test('continue on fail sends failures to Needs Review, never to Confident', async () => {
	const items = [
		{ json: {}, binary: { data: { data: 'aGk=', mimeType: 'application/pdf' } } },
		{ json: {}, binary: { data: { data: 'aGk=', mimeType: 'application/pdf' } } },
	];
	const { output } = await run({
		continueOnFail: true,
		items,
		responses: [
			{
				statusCode: 415,
				headers: {},
				body: { error: { code: 'UNSUPPORTED_FILE', message: 'Not a supported file.' } },
			},
			success(
				{ invoice_number: 'INV-2', total_amount: 2 },
				{ invoice_number: 0.99, total_amount: 0.99 },
			),
		],
	});
	assert.equal(output[0].length, 1);
	assert.equal(output[0][0].pairedItem.item, 1);
	assert.equal(output[1].length, 1);
	assert.match(output[1][0].json.error, /UNSUPPORTED_FILE/);
	assert.equal(output[1][0].pairedItem.item, 0);
});

test('rejects files over the size limit before uploading', async () => {
	const big = Buffer.alloc(7_600_000).toString('base64');
	await assert.rejects(
		run({
			items: [{ json: {}, binary: { data: { data: big, mimeType: 'application/pdf' } } }],
			responses: [],
		}),
		/up to about 7 MB/,
	);
});

test('account: credit balance and usage', async () => {
	const { output, calls } = await run({
		params: { resource: 'account', operation: 'getUsage', days: 7 },
		items: [{ json: {} }],
		responses: [{ statusCode: 200, headers: {}, body: { days: [] } }],
	});
	assert.equal(output.length, 1);
	assert.equal(calls[0].url, 'https://api.refractr.io/api/v1/account/usage/');
	assert.deepEqual(calls[0].qs, { days: 7 });

	const credits = await run({
		params: { resource: 'account', operation: 'getCredits' },
		items: [{ json: {} }],
		responses: [{ statusCode: 200, headers: {}, body: { balance: 1234 } }],
	});
	assert.equal(credits.calls[0].url, 'https://api.refractr.io/api/v1/billing/credits/');
	assert.equal(credits.output[0][0].json.balance, 1234);
});

const CONFIDENT = success(
	{ invoice_number: 'INV-1', total_amount: 1 },
	{ invoice_number: 0.99, total_amount: 0.99 },
);

/** A PDF with `pages` empty pages. */
function pdfWithPages(pages) {
	const objects = [
		'<< /Type /Catalog /Pages 2 0 R >>',
		`<< /Type /Pages /Kids [${[...Array(pages).keys()].map((i) => `${i + 3} 0 R`).join(' ')}] /Count ${pages} >>`,
		...Array(pages).fill('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>'),
	];
	let body = '%PDF-1.4\n';
	const offsets = objects.map((object, i) => {
		const offset = body.length;
		body += `${i + 1} 0 obj\n${object}\nendobj\n`;
		return offset;
	});
	const xref = body.length;
	body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f\r\n`;
	for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n\r\n`;
	body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return Buffer.from(body, 'latin1');
}

test('URL input: downloads the file, sends it, and adds it to the output', async () => {
	const { calls, downloads, output } = await run({
		params: { inputType: 'url', url: ' https://example.com/files/invoice%201.pdf ' },
		items: [{ json: {} }],
		download: {
			body: Buffer.from('%PDF-1.4 test'),
			headers: { 'content-type': 'application/pdf' },
		},
		responses: [CONFIDENT],
	});
	assert.equal(downloads[0].url, 'https://example.com/files/invoice%201.pdf');
	assert.equal(downloads[0].encoding, 'arraybuffer');
	assert.equal(Buffer.from(calls[0].body.document, 'base64').toString(), '%PDF-1.4 test');
	assert.equal(calls[0].body.ocr, false);
	const file = output[0][0].binary.data;
	assert.equal(file.fileName, 'invoice 1.pdf');
	assert.equal(file.mimeType, 'application/pdf');

	await assert.rejects(
		run({
			params: { inputType: 'url', url: 'ftp://example.com/a.pdf' },
			items: [{ json: {} }],
			responses: [],
		}),
		/not an http or https link/,
	);
});

test('base64 input: accepts plain base64 and data URLs, and detects images', async () => {
	const pdf = await run({
		params: { inputType: 'base64', base64: Buffer.from('%PDF-1.4 test').toString('base64') },
		items: [{ json: {} }],
		responses: [CONFIDENT],
	});
	assert.equal(Buffer.from(pdf.calls[0].body.document, 'base64').toString(), '%PDF-1.4 test');
	assert.equal(pdf.output[0][0].binary.data.fileName, 'document.pdf');

	const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
	const image = await run({
		params: {
			inputType: 'base64',
			base64: `data:image/jpeg;base64,${jpegBytes.toString('base64')}`,
		},
		items: [{ json: {} }],
		responses: [CONFIDENT],
	});
	assert.equal(image.calls[0].body.ocr, true, 'images go to OCR, detected from their content');

	await assert.rejects(
		run({
			params: { inputType: 'base64', base64: 'not base64!' },
			items: [{ json: {} }],
			responses: [],
		}),
		/not base64/,
	);
});

test('text and HTML files are sent as text', async () => {
	const html = Buffer.from(
		'<html><body><p>Invoice #2847</p><p>Total &euro;10.00</p></body></html>',
	);
	const { calls } = await run({
		items: [
			{ json: {}, binary: { data: { data: html.toString('base64'), mimeType: 'text/html' } } },
		],
		responses: [CONFIDENT],
	});
	assert.equal(calls[0].body.document_text, 'Invoice #2847\nTotal €10.00');
	assert.equal(calls[0].body.document, undefined);
	assert.equal(calls[0].body.ocr, undefined);
});

test('PDF Pages: only the selected pages are uploaded', async () => {
	const pdf = pdfWithPages(6);
	const { calls } = await run({
		params: { options: { pages: '2-3' } },
		items: [
			{ json: {}, binary: { data: { data: pdf.toString('base64'), mimeType: 'application/pdf' } } },
		],
		responses: [CONFIDENT],
	});
	assert.equal(countPdfPages(Buffer.from(calls[0].body.document, 'base64')), 2);

	await assert.rejects(
		run({
			params: { options: { pages: '9' } },
			items: [
				{
					json: {},
					binary: { data: { data: pdf.toString('base64'), mimeType: 'application/pdf' } },
				},
			],
			responses: [],
		}),
		/Could not select pages "9": None of the pages/,
	);
});
