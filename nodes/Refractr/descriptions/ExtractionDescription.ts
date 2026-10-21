import type { INodeProperties } from 'n8n-workflow';

const showForExtract = { resource: ['extraction'], operation: ['extract'] };
const showForResults = { resource: ['extraction'], operation: ['extract', 'getJob'] };
const showForFiles = { ...showForExtract, inputType: ['binary', 'url', 'base64'] };
const showForFileOptions = { '/operation': ['extract'], '/inputType': ['binary', 'url', 'base64'] };

export const extractionOperations: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['extraction'] } },
		options: [
			{
				name: 'Extract',
				value: 'extract',
				description: 'Extract typed fields from a document or text',
				action: 'Extract fields from a document',
			},
			{
				name: 'Get Job',
				value: 'getJob',
				description: 'Get the result of an extraction by its job ID',
				action: 'Get an extraction job',
			},
		],
		default: 'extract',
	},
];

export const extractionFields: INodeProperties[] = [
	// ----------------------------------------------------------------
	//                       extraction: extract
	// ----------------------------------------------------------------
	{
		displayName: 'Input',
		name: 'inputType',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: showForExtract },
		options: [
			{
				name: 'Base64 String',
				value: 'base64',
				description: 'A file encoded as base64, or a data URL',
			},
			{
				name: 'File',
				value: 'binary',
				description:
					'A file from an earlier node: a PDF, Word or OpenDocument file, a scan or photo, or a text or HTML file',
			},
			{
				name: 'Text',
				value: 'text',
				description: 'Plain text, such as an email body',
			},
			{
				name: 'URL',
				value: 'url',
				description: 'A link to a file, which n8n downloads',
			},
		],
		default: 'binary',
	},
	{
		displayName: 'Input Binary Field',
		name: 'binaryPropertyName',
		type: 'string',
		required: true,
		default: 'data',
		displayOptions: { show: { ...showForExtract, inputType: ['binary'] } },
		hint: 'The name of the input binary field containing the file',
	},
	{
		displayName: 'URL',
		name: 'url',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'e.g. https://example.com/invoice.pdf',
		displayOptions: { show: { ...showForExtract, inputType: ['url'] } },
		description:
			'The link to download the file from. The file is added to the output as binary field data, so a reviewer can open it.',
	},
	{
		displayName: 'Base64 String',
		name: 'base64',
		type: 'string',
		typeOptions: { rows: 3 },
		required: true,
		default: '',
		placeholder: 'e.g. JVBERi0xLjcK...',
		displayOptions: { show: { ...showForExtract, inputType: ['base64'] } },
		description:
			'The file as base64, or as a data URL such as data:application/pdf;base64,JVBERi0... The file type is detected from its content, and the file is added to the output as binary field data.',
	},
	{
		displayName: 'Text',
		name: 'text',
		type: 'string',
		typeOptions: { rows: 5 },
		required: true,
		default: '',
		displayOptions: { show: { ...showForExtract, inputType: ['text'] } },
		description: 'The text to extract from, up to 50,000 characters',
	},
	{
		displayName: 'OCR',
		name: 'ocr',
		type: 'options',
		displayOptions: { show: showForFiles },
		options: [
			{
				name: 'Auto',
				value: 'auto',
				description:
					'Images are read with OCR. Other files are read from their text layer first and retried with OCR only when they have none, such as scanned PDFs.',
			},
			{
				name: 'Always',
				value: 'always',
				description: 'Read every page with OCR. Use this for PDFs that mix text and scanned pages.',
			},
			{
				name: 'Never',
				value: 'never',
				description: 'Only read the text layer. Scans and photos fail without being charged.',
			},
		],
		default: 'auto',
		description:
			'Whether to read the file with OCR. An extraction with OCR costs 2 credits instead of 1.',
	},
	{
		displayName: 'Schema Definition',
		name: 'schemaMode',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: showForExtract },
		options: [
			{
				name: 'Using Fields Below',
				value: 'fields',
				description: 'List the fields you want and their types',
			},
			{
				name: 'Using JSON Template',
				value: 'json',
				description: 'Write a Refractr template, for nested objects or lists of objects',
			},
		],
		default: 'fields',
	},
	{
		displayName: 'Fields',
		name: 'fields',
		placeholder: 'Add Field',
		type: 'fixedCollection',
		typeOptions: { multipleValues: true, sortable: true },
		displayOptions: { show: { ...showForExtract, schemaMode: ['fields'] } },
		default: {
			field: [
				{ name: 'invoice_number', type: 'str' },
				{ name: 'invoice_date', type: 'date' },
				{ name: 'total_amount', type: 'float' },
				{ name: 'currency', type: 'str' },
			],
		},
		description:
			'The fields to extract. A field that is not in the document comes back as null, never made up.',
		options: [
			{
				displayName: 'Field',
				name: 'field',
				values: [
					{
						displayName: 'Name',
						name: 'name',
						type: 'string',
						default: '',
						placeholder: 'e.g. invoice_number',
						description:
							'A descriptive name works best: invoice_date beats d1. Use dots to nest, such as vendor.name.',
					},
					{
						displayName: 'Type',
						name: 'type',
						type: 'options',
						options: [
							{ name: 'Boolean', value: 'bool', description: 'True or false' },
							{
								name: 'Date',
								value: 'date',
								description: 'YYYY-MM-DD, whatever the format in the document',
							},
							{ name: 'Integer', value: 'int', description: 'A whole number, such as a quantity' },
							{ name: 'List of Dates', value: 'date[]' },
							{ name: 'List of Integers', value: 'int[]' },
							{ name: 'List of Numbers', value: 'float[]' },
							{ name: 'List of Strings', value: 'str[]' },
							{
								name: 'Number',
								value: 'float',
								description: 'A bare number, such as an amount: 4779.5',
							},
							{
								name: 'String',
								value: 'str',
								description: 'Text exactly as it appears in the document',
							},
						],
						default: 'str',
					},
				],
			},
		],
	},
	{
		displayName: 'Template',
		name: 'template',
		type: 'json',
		required: true,
		displayOptions: { show: { ...showForExtract, schemaMode: ['json'] } },
		default:
			'{\n  "invoice_number": "__str__",\n  "invoice_date": "__date__",\n  "vendor": {\n    "name": "__str__",\n    "vat_number": "__str__"\n  },\n  "total_amount": "__float__",\n  "currency": "__str__",\n  "line_items": [{ "description": "__str__", "amount": "__float__" }]\n}',
		description:
			'A JSON object shaped like the answer you want, with __str__, __int__, __float__, __bool__ or __date__ as leaf values',
		hint: 'See <a href="https://refractr.io/docs/#templates">Templates & Types</a>',
	},

	// ----------------------------------------------------------------
	//                       extraction: getJob
	// ----------------------------------------------------------------
	{
		displayName: 'Job ID',
		name: 'jobId',
		type: 'string',
		required: true,
		default: '',
		displayOptions: { show: { resource: ['extraction'], operation: ['getJob'] } },
		description: 'The job_id returned by an extraction',
	},

	// ----------------------------------------------------------------
	//                  extraction: extract and getJob
	// ----------------------------------------------------------------
	{
		displayName: 'Route by Confidence',
		name: 'routeByConfidence',
		type: 'boolean',
		noDataExpression: true,
		displayOptions: { show: showForResults },
		default: true,
		description:
			'Whether to send results with a doubtful field to a separate Needs Review output, so only those go to a person',
	},
	{
		displayName: 'Confidence Threshold',
		name: 'confidenceThreshold',
		type: 'number',
		typeOptions: { minValue: 0, maxValue: 1, numberPrecision: 2 },
		displayOptions: { show: showForResults },
		default: 0.9,
		description:
			'A result needs review when any field scores below this. Each field gets the estimated probability, from 0 to 1, that its value is correct.',
	},
	{
		displayName: 'Simplify',
		name: 'simplify',
		type: 'boolean',
		displayOptions: { show: showForResults },
		default: true,
		description:
			'Whether to return the extracted fields and review details only, instead of the full API response',
	},
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add Option',
		displayOptions: { show: showForResults },
		default: {},
		options: [
			{
				displayName: 'Fields That Must Have a Value',
				name: 'requiredFields',
				type: 'string',
				default: '',
				placeholder: 'e.g. invoice_number, total_amount',
				description:
					'Comma-separated field names. A result where one of these is null or empty needs review, whatever its confidence.',
			},
			{
				displayName: 'Mode',
				name: 'waitMode',
				type: 'options',
				displayOptions: { show: { '/operation': ['extract'] } },
				options: [
					{
						name: 'Wait for Result',
						value: 'sync',
						description: 'Fastest. The request waits up to 30 seconds.',
					},
					{
						name: 'Submit and Poll',
						value: 'async',
						description: 'For large scans or many pages that may take longer than 30 seconds',
					},
				],
				default: 'sync',
			},
			{
				displayName: 'PDF Pages',
				name: 'pages',
				type: 'string',
				displayOptions: { show: showForFileOptions },
				default: '',
				placeholder: 'e.g. 1-3, 5',
				description:
					'Which pages of a PDF to send, such as 1-3, 5 or 2- (page 2 to the end) or last. The other pages are removed before upload, so they take no upload time and do not count toward the page limit. Pages a PDF does not have are skipped.',
			},
			{
				displayName: 'Shrink Large Images',
				name: 'shrinkImages',
				type: 'boolean',
				displayOptions: { show: showForFileOptions },
				default: true,
				description:
					'Whether to shrink JPEG and PNG images over 2000 pixels on their longest side, such as phone photos and 300 DPI scans, to 2000 pixels before upload. Refractr reads images at that size anyway, so this saves upload time without changing the result.',
			},
			{
				displayName: 'Timeout (Seconds)',
				name: 'pollTimeout',
				type: 'number',
				typeOptions: { minValue: 5 },
				default: 120,
				description: 'How long to keep polling for a result before failing',
			},
		],
	},
];
