import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	INode,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeOperationError, sleep } from 'n8n-workflow';

const DEFAULT_BASE_URL = 'https://api.refractr.io';
const MAX_RATE_LIMIT_RETRIES = 5;

/** About 7 MB: the API takes requests up to 10 MB, and base64 adds a third. */
export const MAX_FILE_BYTES = 7_500_000;

export type FieldType = 'str' | 'int' | 'float' | 'bool' | 'date';

export interface FieldDefinition {
	name: string;
	type: FieldType | `${FieldType}[]`;
}

export interface ExtractionResult extends IDataObject {
	job_id?: string;
	status?: string;
	extracted_data?: IDataObject;
	confidence?: Record<string, number | null>;
	validation?: { warnings?: string[] } & IDataObject;
	metadata?: { credits_charged?: number } & IDataObject;
}

export interface ReviewSummary {
	needsReview: boolean;
	reviewReasons: string[];
	lowConfidenceFields: string[];
}

interface ApiResponse {
	statusCode: number;
	headers: IDataObject;
	body: IDataObject | string;
}

/** An error response from the API, with Refractr's error code when it sent one. */
export class RefractrError extends Error {
	constructor(
		message: string,
		readonly statusCode: number,
		readonly code: string | undefined,
		readonly body: IDataObject | string,
	) {
		super(message);
	}
}

async function getBaseUrl(this: IExecuteFunctions): Promise<string> {
	const credentials = await this.getCredentials('refractrApi');
	const baseUrl = (credentials.baseUrl as string | undefined) || DEFAULT_BASE_URL;
	return baseUrl.replace(/\/+$/, '');
}

function retryAfterMs(headers: IDataObject): number {
	const seconds = Number(headers['retry-after']);
	return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 60) * 1000 : 2000;
}

/** Sends a request, waiting and retrying when rate limited (429). Never throws on an HTTP status. */
async function request(
	this: IExecuteFunctions,
	method: IHttpRequestMethods,
	endpoint: string,
	options: { body?: IDataObject; qs?: IDataObject; timeout?: number } = {},
): Promise<ApiResponse> {
	const requestOptions: IHttpRequestOptions = {
		method,
		url: `${await getBaseUrl.call(this)}${endpoint}`,
		json: true,
		returnFullResponse: true,
		ignoreHttpStatusErrors: true,
		timeout: options.timeout ?? 60_000,
	};
	if (options.body) requestOptions.body = options.body;
	if (options.qs) requestOptions.qs = options.qs;

	for (let attempt = 0; ; attempt++) {
		const response = (await this.helpers.httpRequestWithAuthentication.call(
			this,
			'refractrApi',
			requestOptions,
		)) as ApiResponse;
		if (response.statusCode !== 429 || attempt >= MAX_RATE_LIMIT_RETRIES) return response;
		await sleep(retryAfterMs(response.headers ?? {}));
	}
}

function toRefractrError(response: ApiResponse): RefractrError {
	const { statusCode, body } = response;
	let code: string | undefined;
	let message: string | undefined;
	if (typeof body === 'object' && body !== null) {
		const error = body.error;
		if (typeof error === 'object' && error !== null) {
			code = (error as IDataObject).code as string | undefined;
			message = (error as IDataObject).message as string | undefined;
		} else if (typeof error === 'string') {
			message = error;
		}
		message =
			message ?? (body.detail as string | undefined) ?? (body.message as string | undefined);
	}
	if (!message) {
		message =
			statusCode === 504
				? 'The extraction took longer than 30 seconds. Set Options > Mode to "Submit and Poll" for large files.'
				: `Refractr returned HTTP ${statusCode}`;
	}
	return new RefractrError(message, statusCode, code, body);
}

/** Wraps any error from this module as the n8n error type the UI shows best. */
export function toNodeError(
	this: IExecuteFunctions,
	error: unknown,
	itemIndex: number,
): NodeApiError | NodeOperationError {
	if (error instanceof NodeApiError || error instanceof NodeOperationError) return error;
	if (error instanceof RefractrError) {
		const body: JsonObject =
			typeof error.body === 'object' ? (error.body as JsonObject) : { response: error.body };
		return new NodeApiError(this.getNode(), body, {
			message: error.code ? `${error.code}: ${error.message}` : error.message,
			httpCode: String(error.statusCode),
			itemIndex,
		});
	}
	return new NodeOperationError(this.getNode(), error as Error, { itemIndex });
}

export async function apiGet(
	this: IExecuteFunctions,
	endpoint: string,
	qs?: IDataObject,
): Promise<IDataObject | IDataObject[]> {
	const response = await request.call(this, 'GET', endpoint, { qs });
	if (response.statusCode >= 400) throw toRefractrError(response);
	return response.body as IDataObject | IDataObject[];
}

function assertFinished(result: ExtractionResult, statusCode: number): ExtractionResult {
	if (result.status === 'success') return result;
	throw toRefractrError({ statusCode, headers: {}, body: result });
}

/** Polls a job until it has finished, backing off from 250 ms to 2 s between polls. */
export async function pollJob(
	this: IExecuteFunctions,
	jobId: string,
	timeoutSeconds: number,
	itemIndex: number,
): Promise<ExtractionResult> {
	const deadline = Date.now() + timeoutSeconds * 1000;
	let delay = 250;
	for (;;) {
		const response = await request.call(
			this,
			'GET',
			`/api/v1/extract/${encodeURIComponent(jobId)}/`,
		);
		if (response.statusCode >= 400) throw toRefractrError(response);
		const result = response.body as ExtractionResult;
		if (result.status !== 'queued' && result.status !== 'processing') {
			return assertFinished(result, response.statusCode);
		}
		if (Date.now() + delay > deadline) {
			throw new NodeOperationError(
				this.getNode(),
				`Job ${jobId} did not finish within ${timeoutSeconds} seconds (status: ${result.status})`,
				{
					itemIndex,
					description: 'Raise Options > Timeout, or get the result later with Get Job.',
				},
			);
		}
		await sleep(delay);
		delay = Math.min(delay * 2, 2000);
	}
}

/** Submits an extraction and returns the finished result, polling when `wait` is false. */
export async function runExtraction(
	this: IExecuteFunctions,
	body: IDataObject,
	timeoutSeconds: number,
	itemIndex: number,
): Promise<ExtractionResult> {
	const response = await request.call(this, 'POST', '/api/v1/extract/', {
		body,
		// The API waits up to 30 s in sync mode; leave room for the upload and the answer.
		timeout: body.wait === false ? 60_000 : 45_000,
	});
	if (response.statusCode >= 400) throw toRefractrError(response);
	const result = response.body as ExtractionResult;
	if (body.wait === false && result.job_id) {
		return await pollJob.call(this, result.job_id, timeoutSeconds, itemIndex);
	}
	return assertFinished(result, response.statusCode);
}

const PLACEHOLDERS: Record<FieldType, string> = {
	str: '__str__',
	int: '__int__',
	float: '__float__',
	bool: '__bool__',
	date: '__date__',
};

/** Builds a Refractr template from a field list. Dots in a name nest it: vendor.name. */
export function buildTemplate(
	node: INode,
	fields: FieldDefinition[],
	itemIndex: number,
): IDataObject {
	const fail = (message: string) => new NodeOperationError(node, message, { itemIndex });
	const template: IDataObject = {};
	for (const field of fields) {
		const path = field.name.trim();
		if (!path) throw fail('Every field needs a name');
		const isList = field.type.endsWith('[]');
		const placeholder = PLACEHOLDERS[field.type.replace('[]', '') as FieldType];
		const keys = path.split('.').map((key) => key.trim());
		if (keys.some((key) => !key)) throw fail(`Field name "${path}" has an empty part`);

		let parent = template;
		for (const key of keys.slice(0, -1)) {
			const existing = parent[key];
			if (existing === undefined) parent[key] = {};
			else if (typeof existing !== 'object' || Array.isArray(existing)) {
				throw fail(`Field "${key}" can't be both a value and a group of fields`);
			}
			parent = parent[key] as IDataObject;
		}
		const leaf = keys[keys.length - 1];
		if (parent[leaf] !== undefined) throw fail(`Field "${path}" is listed more than once`);
		parent[leaf] = isList ? [placeholder] : placeholder;
	}
	if (Object.keys(template).length === 0) throw fail('Add at least one field to extract');
	return template;
}

export function parseTemplate(node: INode, value: unknown, itemIndex: number): IDataObject {
	const fail = (message: string) => new NodeOperationError(node, message, { itemIndex });
	let template = value;
	if (typeof template === 'string') {
		try {
			template = JSON.parse(template);
		} catch {
			throw fail('Template is not valid JSON');
		}
	}
	if (typeof template !== 'object' || template === null || Array.isArray(template)) {
		throw fail('Template must be a JSON object, such as {"invoice_number": "__str__"}');
	}
	return template as IDataObject;
}

/** Reads a value by a path such as vendor.name or line_items[0].amount. */
function getPath(data: unknown, path: string): unknown {
	const keys = path.match(/[^.[\]]+/g) ?? [];
	let value = data;
	for (const key of keys) {
		if (value === null || typeof value !== 'object') return undefined;
		value = (value as Record<string, unknown>)[key];
	}
	return value;
}

function isEmpty(value: unknown): boolean {
	return (
		value === undefined ||
		value === null ||
		value === '' ||
		(Array.isArray(value) && value.length === 0)
	);
}

/**
 * Decides whether a person should check this result: when a scored field is below the
 * threshold, a required field is empty, or there are no scores to go by.
 * Unscored fields (null scores, for judgment fields and long text) don't count.
 */
export function reviewResult(
	result: ExtractionResult,
	threshold: number,
	requiredFields: string[],
): ReviewSummary {
	const reviewReasons: string[] = [];
	const lowConfidenceFields: string[] = [];

	if (!result.confidence) {
		reviewReasons.push('No confidence scores were returned for this extraction');
	} else {
		for (const [path, score] of Object.entries(result.confidence)) {
			if (typeof score === 'number' && score < threshold) {
				lowConfidenceFields.push(path);
				reviewReasons.push(`${path}: confidence ${score} is below ${threshold}`);
			}
		}
	}
	for (const field of requiredFields) {
		if (isEmpty(getPath(result.extracted_data, field))) {
			reviewReasons.push(`${field}: required but not found`);
		}
	}
	return { needsReview: reviewReasons.length > 0, reviewReasons, lowConfidenceFields };
}
