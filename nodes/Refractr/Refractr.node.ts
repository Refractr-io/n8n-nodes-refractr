import type {
	IBinaryData,
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import { accountFields, accountOperations } from './descriptions/AccountDescription';
import { extractionFields, extractionOperations } from './descriptions/ExtractionDescription';
import type { ExtractionResult, FieldDefinition } from './GenericFunctions';
import type { FileType } from './files/FileType';
import { decodeText, detectFileType, htmlToText } from './files/FileType';
import { downscaleImage, MAX_IMAGE_SIDE } from './files/Images';
import { selectPdfPages } from './files/PdfPages';
import {
	apiGet,
	buildTemplate,
	MAX_FILE_BYTES,
	parseTemplate,
	pollJob,
	RefractrError,
	reviewResult,
	runExtraction,
	toNodeError,
} from './GenericFunctions';

export class Refractr implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Refractr',
		name: 'refractr',
		icon: { light: 'file:refractr.svg', dark: 'file:refractr.dark.svg' },
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description:
			'Extract typed fields from invoices, delivery notes and other documents, with a confidence score per field',
		defaults: {
			name: 'Refractr',
		},
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		// Two outputs when routing by confidence, so only doubtful results go to a person.
		outputs: `={{ $parameter.resource !== "account" && $parameter.routeByConfidence !== false ? [{ "type": "main", "displayName": "Confident" }, { "type": "main", "displayName": "Needs Review" }] : [{ "type": "main" }] }}`,
		credentials: [
			{
				name: 'refractrApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'Extraction', value: 'extraction' },
					{ name: 'Account', value: 'account' },
				],
				default: 'extraction',
			},
			...extractionOperations,
			...extractionFields,
			...accountOperations,
			...accountFields,
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const confident: INodeExecutionData[] = [];
		const needsReview: INodeExecutionData[] = [];

		const resource = this.getNodeParameter('resource', 0) as string;
		const routeByConfidence =
			resource === 'extraction' && (this.getNodeParameter('routeByConfidence', 0, true) as boolean);

		for (let i = 0; i < items.length; i++) {
			try {
				const operation = this.getNodeParameter('operation', i) as string;

				if (resource === 'account') {
					const response =
						operation === 'getUsage'
							? await apiGet.call(this, '/api/v1/account/usage/', {
									days: this.getNodeParameter('days', i) as number,
								})
							: await apiGet.call(this, '/api/v1/billing/credits/');
					const results = Array.isArray(response) ? response : [response];
					confident.push(...results.map((json) => ({ json, pairedItem: { item: i } })));
					continue;
				}

				const options = this.getNodeParameter('options', i, {}) as IDataObject;
				const timeoutSeconds = (options.pollTimeout as number | undefined) ?? 120;
				let result: ExtractionResult;
				let file: IBinaryData | undefined;

				if (operation === 'getJob') {
					const jobId = (this.getNodeParameter('jobId', i) as string).trim();
					result = await pollJob.call(this, jobId, timeoutSeconds, i);
				} else {
					({ result, binary: file } = await extract.call(this, i, options, timeoutSeconds));
				}

				const threshold = this.getNodeParameter('confidenceThreshold', i, 0.9) as number;
				const requiredFields = ((options.requiredFields as string | undefined) ?? '')
					.split(',')
					.map((field) => field.trim())
					.filter(Boolean);
				const review = reviewResult(result, threshold, requiredFields);

				const simplify = this.getNodeParameter('simplify', i, true) as boolean;
				const json: IDataObject = simplify
					? {
							data: result.extracted_data ?? {},
							confidence: result.confidence ?? null,
							...review,
							jobId: result.job_id,
							creditsCharged: result.metadata?.credits_charged,
						}
					: { ...result, ...review };

				// Pass the file on, so whoever reviews the result can open the document.
				const output: INodeExecutionData = { json, pairedItem: { item: i } };
				if (items[i].binary) output.binary = items[i].binary;
				if (file) output.binary = { ...output.binary, data: file };

				if (routeByConfidence && review.needsReview) needsReview.push(output);
				else confident.push(output);
			} catch (error) {
				if (this.continueOnFail()) {
					// A failed extraction is never "confident": send it where a person will see it.
					const failed: INodeExecutionData = {
						json: { error: (error as Error).message },
						pairedItem: { item: i },
					};
					if (items[i].binary) failed.binary = items[i].binary;
					(routeByConfidence ? needsReview : confident).push(failed);
					continue;
				}
				throw toNodeError.call(this, error, i);
			}
		}

		return routeByConfidence ? [confident, needsReview] : [confident];
	}
}

interface Extraction {
	result: ExtractionResult;
	/** The file, when it came from a URL or base64 rather than a binary field. */
	binary?: IBinaryData;
}

async function extract(
	this: IExecuteFunctions,
	itemIndex: number,
	options: IDataObject,
	timeoutSeconds: number,
): Promise<Extraction> {
	const schemaMode = this.getNodeParameter('schemaMode', itemIndex) as string;
	const template =
		schemaMode === 'json'
			? parseTemplate(this.getNode(), this.getNodeParameter('template', itemIndex), itemIndex)
			: buildTemplate(
					this.getNode(),
					this.getNodeParameter('fields.field', itemIndex, []) as FieldDefinition[],
					itemIndex,
				);

	const body: IDataObject = {
		template,
		wait: (options.waitMode as string | undefined) !== 'async',
	};

	const inputType = this.getNodeParameter('inputType', itemIndex) as string;
	if (inputType === 'text') {
		const text = this.getNodeParameter('text', itemIndex) as string;
		if (!text.trim()) {
			throw new NodeOperationError(this.getNode(), 'The text to extract from is empty', {
				itemIndex,
			});
		}
		body.document_text = text;
		return { result: await runExtraction.call(this, body, timeoutSeconds, itemIndex) };
	}

	const file = await loadFile.call(this, inputType, itemIndex);
	const type = detectFileType(file.data, file.mimeType, file.fileName);
	// A downloaded or decoded file goes to the output, so whoever reviews the result can open it.
	const binary =
		inputType === 'binary'
			? undefined
			: await this.helpers.prepareBinaryData(
					file.data,
					file.fileName ?? `document.${type.extension}`,
					type.mimeType,
				);

	// Text files, such as a .txt or an HTML email, are sent as text.
	if (type.kind === 'text' || type.kind === 'html') {
		const decoded = decodeText(file.data);
		const text = type.kind === 'html' ? htmlToText(decoded) : decoded;
		if (!text.trim()) {
			throw new NodeOperationError(this.getNode(), 'The file has no text', { itemIndex });
		}
		body.document_text = text;
		return { result: await runExtraction.call(this, body, timeoutSeconds, itemIndex), binary };
	}

	body.document = prepareDocument
		.call(this, file.data, type, options, itemIndex)
		.toString('base64');
	const ocrMode = this.getNodeParameter('ocr', itemIndex, 'auto') as string;
	body.ocr = ocrMode === 'always' || (ocrMode === 'auto' && type.isImage);

	try {
		return { result: await runExtraction.call(this, body, timeoutSeconds, itemIndex), binary };
	} catch (error) {
		// Files without a text layer fail for free, so trying without OCR first costs nothing.
		if (
			ocrMode === 'auto' &&
			!body.ocr &&
			error instanceof RefractrError &&
			error.code === 'OCR_REQUIRED'
		) {
			body.ocr = true;
			return { result: await runExtraction.call(this, body, timeoutSeconds, itemIndex), binary };
		}
		throw toNodeError.call(this, error, itemIndex);
	}
}

interface LoadedFile {
	data: Buffer;
	mimeType?: string;
	fileName?: string;
}

/** Gets the file from a binary field, a URL or a base64 string. */
async function loadFile(
	this: IExecuteFunctions,
	inputType: string,
	itemIndex: number,
): Promise<LoadedFile> {
	const fail = (message: string, description?: string) =>
		new NodeOperationError(this.getNode(), message, { itemIndex, description });

	if (inputType === 'url') {
		const url = (this.getNodeParameter('url', itemIndex) as string).trim();
		if (!/^https?:\/\/\S+$/i.test(url)) throw fail(`"${url}" is not an http or https link`);
		let response: { body: Buffer; headers: IDataObject };
		try {
			response = (await this.helpers.httpRequest({
				method: 'GET',
				url,
				encoding: 'arraybuffer',
				returnFullResponse: true,
				timeout: 60_000,
			})) as { body: Buffer; headers: IDataObject };
		} catch (error) {
			throw new NodeOperationError(this.getNode(), error as Error, {
				itemIndex,
				message: `Could not download ${url}`,
			});
		}
		const data = Buffer.from(response.body);
		if (data.length === 0) throw fail(`${url} returned an empty file`);
		const disposition = String(response.headers['content-disposition'] ?? '');
		const fileName =
			/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition)?.[1] ||
			new URL(url).pathname.split('/').pop();
		return {
			data,
			mimeType: String(response.headers['content-type'] ?? '') || undefined,
			fileName: fileName ? safeDecode(fileName) : undefined,
		};
	}

	if (inputType === 'base64') {
		let text = (this.getNodeParameter('base64', itemIndex) as string).trim();
		let mimeType: string | undefined;
		const dataUrl = /^data:([^;,]*)((?:;[^;,]*)*),/i.exec(text);
		if (dataUrl) {
			mimeType = dataUrl[1] || undefined;
			text = text.slice(dataUrl[0].length);
			if (!/;base64/i.test(dataUrl[2])) {
				return { data: Buffer.from(safeDecode(text), 'utf8'), mimeType };
			}
		}
		text = text.replace(/\s+/g, '');
		if (!text) throw fail('The base64 string is empty');
		if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(text)) {
			throw fail('The base64 string has characters that are not base64');
		}
		return { data: Buffer.from(text, 'base64'), mimeType };
	}

	const binaryPropertyName = this.getNodeParameter('binaryPropertyName', itemIndex) as string;
	const binaryData = this.helpers.assertBinaryData(itemIndex, binaryPropertyName);
	return {
		data: await this.helpers.getBinaryDataBuffer(itemIndex, binaryPropertyName),
		mimeType: binaryData.mimeType,
		fileName: binaryData.fileName,
	};
}

function safeDecode(text: string): string {
	try {
		return decodeURIComponent(text);
	} catch {
		return text;
	}
}

/** Keeps only the selected PDF pages and shrinks big images, then checks the upload size. */
function prepareDocument(
	this: IExecuteFunctions,
	data: Buffer,
	type: FileType,
	options: IDataObject,
	itemIndex: number,
): Buffer {
	let document = data;
	const pages = ((options.pages as string | undefined) ?? '').trim();
	if (pages && type.kind === 'pdf') {
		try {
			document = selectPdfPages(document, pages).pdf;
		} catch (error) {
			throw new NodeOperationError(this.getNode(), error as Error, {
				itemIndex,
				message: `Could not select pages "${pages}": ${(error as Error).message}`,
				description: 'Remove Options > PDF Pages to send the whole PDF.',
			});
		}
	}

	if (options.shrinkImages && type.isImage) {
		document = downscaleImage(document, MAX_IMAGE_SIDE)?.data ?? document;
	}

	if (document.length > MAX_FILE_BYTES) {
		const hint =
			type.kind === 'pdf'
				? 'Set Options > PDF Pages to send only the pages you need.'
				: type.isImage
					? 'Add Options > Shrink Large Images to shrink it before upload.'
					: undefined;
		throw new NodeOperationError(
			this.getNode(),
			`The file is ${(document.length / 1_000_000).toFixed(1)} MB; Refractr accepts files up to about 7 MB`,
			{ itemIndex, description: hint },
		);
	}
	return document;
}
