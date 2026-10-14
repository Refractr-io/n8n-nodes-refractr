import type {
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

				if (operation === 'getJob') {
					const jobId = (this.getNodeParameter('jobId', i) as string).trim();
					result = await pollJob.call(this, jobId, timeoutSeconds, i);
				} else {
					result = await extract.call(this, i, options, timeoutSeconds);
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

async function extract(
	this: IExecuteFunctions,
	itemIndex: number,
	options: IDataObject,
	timeoutSeconds: number,
): Promise<ExtractionResult> {
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
		return await runExtraction.call(this, body, timeoutSeconds, itemIndex);
	}

	const binaryPropertyName = this.getNodeParameter('binaryPropertyName', itemIndex) as string;
	const binaryData = this.helpers.assertBinaryData(itemIndex, binaryPropertyName);
	const buffer = await this.helpers.getBinaryDataBuffer(itemIndex, binaryPropertyName);
	if (buffer.length > MAX_FILE_BYTES) {
		throw new NodeOperationError(
			this.getNode(),
			`The file is ${(buffer.length / 1_000_000).toFixed(1)} MB; Refractr accepts files up to about 7 MB`,
			{ itemIndex },
		);
	}
	body.document = buffer.toString('base64');

	const ocrMode = this.getNodeParameter('ocr', itemIndex, 'auto') as string;
	const isImage = (binaryData.mimeType ?? '').startsWith('image/');
	body.ocr = ocrMode === 'always' || (ocrMode === 'auto' && isImage);

	try {
		return await runExtraction.call(this, body, timeoutSeconds, itemIndex);
	} catch (error) {
		// Files without a text layer fail for free, so trying without OCR first costs nothing.
		if (
			ocrMode === 'auto' &&
			!body.ocr &&
			error instanceof RefractrError &&
			error.code === 'OCR_REQUIRED'
		) {
			body.ocr = true;
			return await runExtraction.call(this, body, timeoutSeconds, itemIndex);
		}
		throw toNodeError.call(this, error, itemIndex);
	}
}
